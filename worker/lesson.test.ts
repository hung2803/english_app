import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { AiError } from './errors'
import { buildLessonPrompt, composeLesson, normalizeLesson, type LessonSource } from './lesson'
import type { MaterialOption } from './materials'
import { createTestDb } from './test-db'
import type { Env } from './env'
import { QUIZ8, READING } from './test-fixtures'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

const ART: MaterialOption = { type: 'article', title: 'Ordering food', url: 'https://example.com/food', why_vi: 'a', excerpt: 'a' }
const YT: MaterialOption = { type: 'youtube', title: 'At the restaurant', url: 'https://www.youtube.com/watch?v=abc12345678', why_vi: 'b', excerpt: 'b' }
const POD: MaterialOption = { type: 'podcast', title: 'Slow English', url: 'https://pod.example.org/ep1', why_vi: 'c', excerpt: 'c' }
const OPTS = [ART, YT, POD]

const SENTENCES = 'Can I have a coffee please? Yes of course, here you are. '
const PAGE = `<html><head><title>Food</title></head><body><nav>MENU LINK</nav><p>${SENTENCES.repeat(40)}</p><p>UNIQUE_SOURCE_MARKER Transcript</p><script>var secret=1</script></body></html>`

const good = (over: Record<string, unknown> = {}) => ({
  title: 'Ordering food and drinks',
  excerpt: READING,
  summary_vi: 'Bài nói về cách gọi đồ ăn thức uống.',
  explanation_vi: 'Người nói gọi cà phê một cách lịch sự. Cấu trúc "Can I have ...?" rất hữu ích.',
  vocab: [
    { word: 'order', pos: 'verb', meaning_vi: 'gọi món', example: 'I want to order a pizza.' },
    { word: 'menu', pos: 'noun', meaning_vi: 'thực đơn', example: 'Can I see the menu?' },
    { word: 'bill', pos: 'noun', meaning_vi: 'hóa đơn', example: 'The bill, please.' },
    { word: 'waiter', pos: 'noun', meaning_vi: 'bồi bàn', example: 'The waiter is friendly.' },
    { word: 'tip', pos: 'noun', meaning_vi: 'tiền boa', example: 'Leave a tip.' },
  ],
  grammar: [{ point: 'Can I have ...?', explanation_vi: 'Câu xin phép lịch sự.', example: 'Can I have some water?' }],
  quiz: QUIZ8,
  ...over,
})

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
/** Gemini → bài `lesson`; trang web → PAGE; oEmbed → 200. Ghi lại các lời gọi. */
function net(lessons: unknown[] | ((n: number) => Response), page: Handler = () => new Response(PAGE, { headers: { 'content-type': 'text/html' } })) {
  let n = 0
  const f = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('generativelanguage')) {
      n++
      if (typeof lessons === 'function') return lessons(n)
      const l = lessons[Math.min(n - 1, lessons.length - 1)]
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(l) }] } }] })
    }
    if (url.includes('oembed')) return Response.json({ title: 'ok' })
    return page(url, init)
  })
  vi.stubGlobal('fetch', f)
  return f
}
const geminiBodies = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter((c) => String(c[0]).includes('generativelanguage')).map((c) => JSON.parse((c[1] as RequestInit).body as string))
const promptOf = (body: any) => body.contents[0].parts.map((p: any) => p.text ?? '').join('\n') as string

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown, authed = true) {
  return app.request(
    path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq = 1) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const compose = async (seq = 1) => call(`/api/sessions/${await sid(seq)}/compose`, {})
/** Đặt sẵn danh sách tài liệu cho buổi 1, đã chọn `chosen` (null = chưa chọn, -1 = fallback) */
const prepare = (chosen: number | null, options: MaterialOption[] = OPTS) =>
  db.prepare('UPDATE sessions SET material_json = ? WHERE seq = 1').bind(JSON.stringify({ options: chosen === -1 ? [] : options, chosen, fallback: chosen === -1 })).run()
const lessonRow = async () => (await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<{ lesson_json: string | null }>())!.lesson_json

describe('normalizeLesson', () => {
  const SRC: LessonSource = { type: 'article', url: 'https://example.com/food', title: 'Food', ai_written: false }
  it('bài hợp lệ → đủ link nguồn, đoạn trích, tóm tắt, giải thích, từ vựng, ngữ pháp', () => {
    const l = normalizeLesson(good(), SRC)
    expect(l).toMatchObject({ title: 'Ordering food and drinks', source: SRC })
    expect(READING.startsWith(l.excerpt.slice(0, 80))).toBe(true) // nguồn thật: đoạn trích chỉ là phần đầu, đã cắt ngắn
    expect(l.summary_vi).toContain('Bài nói')
    expect(l.explanation_vi).not.toBe('')
    expect(l.vocab).toHaveLength(5)
    expect(l.vocab[0]).toEqual({ word: 'order', pos: 'verb', meaning_vi: 'gọi món', example: 'I want to order a pizza.' })
    expect(l.grammar).toHaveLength(1)
  })
  it('đoạn trích từ nguồn bị cắt ngắn (không chép lại nội dung gốc); bài AI tự viết được dài hơn', () => {
    expect(normalizeLesson(good({ excerpt: 'x'.repeat(5000) }), SRC).excerpt).toHaveLength(600)
    expect(normalizeLesson(good({ excerpt: 'x'.repeat(5000) }), { type: 'ai', title: 'AI', ai_written: true }).excerpt).toHaveLength(3000)
  })
  it('bỏ từ vựng trùng (không phân biệt hoa thường), thiếu nghĩa; tối đa 12 từ và 3 điểm ngữ pháp', () => {
    const vocab = [
      { word: 'Order', meaning_vi: 'a' }, { word: 'order', meaning_vi: 'b' }, { word: 'x', meaning_vi: '' }, { word: '', meaning_vi: 'c' },
      ...Array.from({ length: 12 }, (_, i) => ({ word: 'w' + i, meaning_vi: 'm' })),
    ]
    const grammar = Array.from({ length: 5 }, (_, i) => ({ point: 'p' + i, explanation_vi: 'e' }))
    const l = normalizeLesson(good({ vocab, grammar }), SRC)
    expect(l.vocab).toHaveLength(12)
    expect(l.vocab.filter((v) => v.word.toLowerCase() === 'order')).toHaveLength(1)
    expect(l.vocab[0].meaning_vi).toBe('a')
    expect(l.grammar).toHaveLength(3)
  })
  it('thiếu phần cốt lõi → AiError (để thử lại)', () => {
    const bad = [
      good({ title: '' }), good({ excerpt: '' }), good({ summary_vi: '' }), good({ explanation_vi: ' ' }),
      good({ vocab: good().vocab.slice(0, 3) }), good({ vocab: 'x' }), good({ grammar: [] }), good({ grammar: [{ point: 'p' }] }),
      null, 'x', {}, [],
    ]
    for (const b of bad) expect(() => normalizeLesson(b, SRC)).toThrow(AiError)
  })
  it('ghi chú lý do fallback nếu có', () => {
    expect(normalizeLesson(good(), { type: 'ai', title: 'AI', ai_written: true }, 'Không đọc được tài liệu.').notice_vi).toBe('Không đọc được tài liệu.')
    expect(normalizeLesson(good(), SRC).notice_vi).toBeUndefined()
  })
})

describe('buildLessonPrompt', () => {
  const ctx = { level: 'A2', topic: 'Travel', chosen: ART }
  it('bài viết: có nội dung nguồn, mức, chủ đề, yêu cầu đủ phần, dặn không chép lại', () => {
    const p = buildLessonPrompt(ctx, { kind: 'text', text: 'SOURCE BODY HERE' })
    for (const w of ['SOURCE BODY HERE', 'CEFR A2', 'Travel', 'Ordering food', 'summary_vi', 'explanation_vi', 'vocab', 'grammar', 'Vietnamese', 'Do not reproduce']) expect(p).toContain(w)
  })
  it('podcast gọi là transcript; video nói rõ dùng phụ đề', () => {
    expect(buildLessonPrompt({ ...ctx, chosen: POD }, { kind: 'text', text: 't' })).toContain('podcast transcript')
    expect(buildLessonPrompt({ ...ctx, chosen: YT }, { kind: 'video' })).toContain('YouTube video')
  })
  it('AI tự viết: yêu cầu bài đọc gốc 120–180 từ theo mức', () => {
    const p = buildLessonPrompt({ ...ctx, chosen: null }, { kind: 'ai' })
    expect(p).toContain('OWN original English reading')
    expect(p).toContain('250-350 words')
    expect(p).toContain('CEFR A2')
  })
})

describe('composeLesson', () => {
  const base = { level: 'A1', topic: 'Food' }
  it('bài viết web: đọc trang, gửi nội dung cho AI, trả bài có link nguồn', async () => {
    const f = net([good()])
    const l = await composeLesson(env, { ...base, chosen: ART })
    expect(l.source).toEqual({ type: 'article', url: ART.url, title: ART.title, ai_written: false })
    expect(l.vocab.length).toBeGreaterThanOrEqual(4)
    const [body] = geminiBodies(f)
    expect(promptOf(body)).toContain('UNIQUE_SOURCE_MARKER')
    expect(promptOf(body)).not.toContain('MENU LINK') // bỏ menu
    expect(promptOf(body)).not.toContain('var secret') // bỏ script
    expect(body.generationConfig.responseMimeType).toBe('application/json')
  })
  it('podcast: nguồn loại podcast', async () => {
    net([good()])
    expect((await composeLesson(env, { ...base, chosen: POD })).source.type).toBe('podcast')
  })
  it('YouTube: gửi URL video cho Gemini, nguồn youtube', async () => {
    const f = net([good()])
    const l = await composeLesson(env, { ...base, chosen: YT })
    expect(l.source).toMatchObject({ type: 'youtube', url: YT.url, ai_written: false })
    expect(geminiBodies(f)[0].contents[0].parts[0]).toEqual({ fileData: { fileUri: YT.url } })
  })
  it('không có tài liệu (fallback): AI tự viết, ghi rõ ai_written, không tải trang nào', async () => {
    const f = net([good()])
    const l = await composeLesson(env, { ...base, chosen: null })
    expect(l.source).toEqual({ type: 'ai', title: 'Bài đọc do AI viết', ai_written: true })
    expect(f.mock.calls.filter((c) => !String(c[0]).includes('generativelanguage'))).toHaveLength(0)
  })
  it('trang đã chọn không đọc được (404) → AI tự viết + ghi chú lý do', async () => {
    const f = net([good()], () => new Response('gone', { status: 404 }))
    const l = await composeLesson(env, { ...base, chosen: ART })
    expect(l.source.ai_written).toBe(true)
    expect(l.notice_vi).toMatch(/Không đọc được tài liệu/)
    expect(promptOf(geminiBodies(f)[0])).toContain('OWN original English reading')
  })
  it('trang quá ngắn → AI tự viết', async () => {
    net([good()], () => new Response('<html><body><p>Hi</p></body></html>', { headers: { 'content-type': 'text/html' } }))
    expect((await composeLesson(env, { ...base, chosen: ART })).source.ai_written).toBe(true)
  })
  it('URL đã lưu trỏ vào địa chỉ nội bộ → không tải, AI tự viết', async () => {
    const f = net([good()])
    const l = await composeLesson(env, { ...base, chosen: { ...ART, url: 'http://169.254.169.254/latest' } })
    expect(l.source.ai_written).toBe(true)
    expect(f.mock.calls.some((c) => String(c[0]).includes('169.254'))).toBe(false)
  })
  it('YouTube: AI không đọc được video (lỗi khác) → tự viết bài, gọi AI 2 lần', async () => {
    const f = net((n) => (n === 1 ? new Response('', { status: 500 }) : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(good()) }] } }] })))
    const l = await composeLesson(env, { ...base, chosen: YT })
    expect(l.source.ai_written).toBe(true)
    expect(l.notice_vi).toMatch(/video/)
    expect(geminiBodies(f)).toHaveLength(2)
  })
  it('API từ chối (429) → ném lỗi, KHÔNG chuyển sang fallback (cũng sẽ bị từ chối)', async () => {
    const f = net(() => new Response('', { status: 429 }))
    await expect(composeLesson(env, { ...base, chosen: YT })).rejects.toMatchObject({ kind: 'rate' })
    expect(geminiBodies(f)).toHaveLength(1)
    await expect(composeLesson(env, { ...base, chosen: ART })).rejects.toMatchObject({ kind: 'rate' })
  })
  it('AI trả bài thiếu nội dung → AiError', async () => {
    net([good({ vocab: [] })])
    await expect(composeLesson(env, { ...base, chosen: ART })).rejects.toBeInstanceOf(AiError)
  })
  it('chỉ lưu đoạn trích ngắn, không có nội dung gốc của trang', async () => {
    net([good({ excerpt: READING.slice(0, 500) + ' ' + 'y'.repeat(4000) })])
    const l = await composeLesson(env, { ...base, chosen: ART })
    expect(JSON.stringify(l)).not.toContain('UNIQUE_SOURCE_MARKER')
    expect(l.excerpt.length).toBeLessThanOrEqual(600)
  })
  it('giới hạn thời gian: AI treo thì dừng đúng hạn (không chờ vô hạn)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('generativelanguage')) {
          return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))))
        }
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
      }),
    )
    const t0 = Date.now()
    await expect(composeLesson(env, { ...base, chosen: ART }, { budgetMs: 1500 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(4000)
  })
  it('ngân sách mặc định nằm trong 60 giây', async () => {
    const { COMPOSE_BUDGET_MS } = await import('./lesson')
    expect(COMPOSE_BUDGET_MS).toBeLessThanOrEqual(58_000)
    expect(COMPOSE_BUDGET_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('POST /api/sessions/:id/compose', () => {
  it('cần đăng nhập', async () => {
    await prepare(0)
    expect((await call(`/api/sessions/${await sid()}/compose`, {}, false)).status).toBe(401)
  })
  it('chưa bắt đầu buổi → 400 no_material; chưa chọn → 400 not_chosen; id lạ → 404', async () => {
    expect((await json(await compose())).error).toBe('no_material')
    await prepare(null)
    expect((await json(await compose())).error).toBe('not_chosen')
    expect((await call('/api/sessions/99999/compose', {})).status).toBe(404)
  })
  it('đã chọn → soạn bài, lưu vào buổi học, trả bài', async () => {
    net([good()])
    await prepare(0)
    const r = await compose()
    expect(r.status).toBe(200)
    const { lesson } = await json(r)
    expect(lesson.source).toMatchObject({ type: 'article', url: ART.url, ai_written: false })
    const stored = JSON.parse((await lessonRow())!)
    expect({ ...stored, quiz: undefined }).toEqual({ ...lesson, quiz: undefined })
    expect(stored.quiz).toHaveLength(8) // bản lưu có đủ đáp án
    expect(JSON.stringify(lesson.quiz)).not.toMatch(/"answer"|explanation_vi/) // bản gửi đi thì không
  })
  it('GET buổi học trả kèm bài đã soạn', async () => {
    net([good()])
    await prepare(1)
    await compose()
    const { session } = await json(await call(`/api/sessions/${await sid()}`))
    expect(session.lesson.source.type).toBe('youtube')
    expect(session.lesson.vocab.length).toBeGreaterThanOrEqual(4)
  })
  it('gọi lại: trả đúng bài cũ, KHÔNG gọi AI lần nữa', async () => {
    const f = net([good(), good({ title: 'Một bài khác' })])
    await prepare(0)
    const a = await json(await compose())
    const b = await json(await compose())
    expect(b).toEqual(a)
    expect(geminiBodies(f)).toHaveLength(1)
  })
  it('hai yêu cầu đồng thời: chỉ một bài được lưu, hai bên nhận cùng một bài', async () => {
    net([good({ title: 'Bài thứ nhất' }), good({ title: 'Bài thứ hai' })])
    await prepare(0)
    const [a, b] = await Promise.all([compose(), compose()])
    const [la, lb] = [await json(a), await json(b)]
    expect(la.lesson.title).toBe(lb.lesson.title)
    expect(JSON.parse((await lessonRow())!).title).toBe(la.lesson.title)
  })
  it('chế độ fallback (chosen = -1): AI tự viết, đánh dấu ai_written', async () => {
    net([good()])
    await prepare(-1)
    expect((await json(await compose())).lesson.source).toMatchObject({ type: 'ai', ai_written: true })
  })
  it('API từ chối → 503 tiếng Việt, KHÔNG lưu gì, thử lại được', async () => {
    net(() => new Response('', { status: 429 }))
    await prepare(0)
    const r = await compose()
    expect(r.status).toBe(503)
    expect(await json(r)).toMatchObject({ error: 'ai_unavailable', kind: 'rate', retryable: true })
    expect(await lessonRow()).toBeNull()
    net([good()])
    expect((await compose()).status).toBe(200)
  })
  it('bài AI trả không hợp lệ → 503, không lưu', async () => {
    net([{ title: 'x' }])
    await prepare(0)
    expect((await compose()).status).toBe(503)
    expect(await lessonRow()).toBeNull()
  })
  it('buổi đã xong → 409', async () => {
    net([good()])
    await prepare(0)
    await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=1").bind(todayVN()).run()
    expect((await json(await compose())).error).toBe('done')
  })
  it('tài liệu đã chọn khóa không đổi: soạn bài dùng đúng tài liệu đã chọn (không phải cái đầu)', async () => {
    const f = net([good()])
    await prepare(2)
    await compose()
    expect(promptOf(geminiBodies(f)[0])).toContain('Slow English')
    expect(promptOf(geminiBodies(f)[0])).toContain('podcast transcript')
  })
})
