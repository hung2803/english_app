import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { buildSearchPrompt, findMaterials, normalizeOptions, urlKey } from './materials'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

const A = { type: 'article', title: 'Ordering food in English', url: 'https://example.com/food', why_vi: 'Dễ, đúng chủ đề.', excerpt: 'Can I have a coffee, please?' }
const Y = { type: 'youtube', title: 'At the restaurant', url: 'https://www.youtube.com/watch?v=abc12345678', why_vi: 'Có phụ đề.', excerpt: 'Hello, a table for two.' }
const P = { type: 'podcast', title: 'Slow English: Food', url: 'https://pod.example.org/ep/5', why_vi: 'Có transcript.', excerpt: 'Today we talk about food.' }

/** Gemini trả văn bản (có công cụ google_search nên không phải JSON thuần) */
const aiText = (text: string) => vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text }] } }] }))
const GOOD_HTML = '<html><head><title>Lesson</title></head><body>' + '<p>Can I have a coffee please? Yes of course. </p>'.repeat(60) + '<p>Transcript</p></body></html>'
/** Gemini trả các lựa chọn; mọi link kiểm tra đều sống (YouTube oEmbed 200, trang web HTML đủ dài có transcript). */
const aiOptions = (options: unknown[]) =>
  vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('generativelanguage')) {
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Đây là kết quả:\n```json\n' + JSON.stringify({ options }) + '\n```' }] } }] })
    }
    if (url.includes('youtube.com/oembed')) return Response.json({ title: 'ok' })
    return new Response(GOOD_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
const geminiCalls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => String(c[0]).includes('generativelanguage')).length

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
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const start = async (seq = 1) => call(`/api/sessions/${await sid(seq)}/materials`, {})
const requestBody = (fn: ReturnType<typeof vi.fn>, i = 0) => JSON.parse((fn.mock.calls[i] as unknown as [string, RequestInit])[1].body as string)

describe('normalizeOptions', () => {
  it('giữ mục hợp lệ, đúng loại', () => {
    expect(normalizeOptions({ options: [A, Y, P] }).map((o) => o.type)).toEqual(['article', 'youtube', 'podcast'])
  })
  it('chấp nhận cách gọi khác của loại: web/video/audio', () => {
    const r = normalizeOptions({ options: [{ ...A, type: 'Web' }, { ...Y, type: 'VIDEO', url: 'https://y.com/2' }, { ...P, type: 'audio' }] })
    expect(r.map((o) => o.type)).toEqual(['article', 'youtube', 'podcast'])
  })
  it('bỏ mục thiếu tiêu đề, URL sai/không phải http(s), loại lạ', () => {
    const r = normalizeOptions({
      options: [
        { ...A, title: '' },
        { ...A, url: 'ftp://x.com/a' },
        { ...A, url: 'javascript:alert(1)' },
        { ...A, url: 'không phải url' },
        { ...A, type: 'book' },
        null,
        'x',
        Y,
      ],
    })
    expect(r).toEqual([Y])
  })
  it('tối đa 3 lựa chọn', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...A, url: `https://example.com/${i}` }))
    expect(normalizeOptions({ options: many })).toHaveLength(3)
  })
  it('bỏ trùng URL (kể cả khác #fragment, utm, www, dấu / cuối)', () => {
    const r = normalizeOptions({
      options: [
        { ...A, url: 'https://example.com/food' },
        { ...A, url: 'https://www.example.com/food/?utm_source=x#top' },
        { ...A, url: 'https://example.com/other' },
      ],
    })
    expect(r.map((o) => o.url)).toEqual(['https://example.com/food', 'https://example.com/other'])
  })
  it('bỏ nguồn đã dùng ở buổi trước', () => {
    expect(normalizeOptions({ options: [A, Y] }, ['https://example.com/food/']).map((o) => o.type)).toEqual(['youtube'])
  })
  it('cắt độ dài quá mức; thiếu why/excerpt thì để rỗng', () => {
    const r = normalizeOptions({ options: [{ type: 'article', title: 'T'.repeat(500), url: 'https://a.com/1', excerpt: 'x'.repeat(2000) }] })
    expect(r[0].title).toHaveLength(160)
    expect(r[0].excerpt).toHaveLength(400)
    expect(r[0].why_vi).toBe('')
  })
  it('không phải object / không có options → rỗng', () => {
    for (const bad of [null, 'x', {}, { options: 'x' }, { options: {} }]) expect(normalizeOptions(bad)).toEqual([])
  })
  it('urlKey', () => {
    expect(urlKey('https://WWW.Example.com/A/?utm_medium=z&id=2#x')).toBe('example.com/a?id=2')
  })
})

describe('buildSearchPrompt', () => {
  it('nêu mức, chủ đề, 3 loại nguồn, yêu cầu URL thật', () => {
    const p = buildSearchPrompt({ level: 'A2', topic: 'Travel & accommodation', seq: 17, excludeUrls: [] })
    expect(p).toContain('CEFR level A2')
    expect(p).toContain('Travel & accommodation')
    expect(p).toContain('session 17')
    for (const w of ['article', 'youtube', 'podcast', 'captions', 'transcript', 'never invent']) expect(p).toContain(w)
  })
  it('liệt kê nguồn đã dùng để không đưa lại', () => {
    expect(buildSearchPrompt({ level: 'A1', topic: 't', seq: 1, excludeUrls: ['https://old.com/a'] })).toContain('- https://old.com/a')
    expect(buildSearchPrompt({ level: 'A1', topic: 't', seq: 1, excludeUrls: [] })).not.toContain('Do NOT use')
  })
})

describe('findMaterials', () => {
  const ctx = { level: 'A1', topic: 'Food', seq: 1, excludeUrls: [] }
  it('gọi Gemini với công cụ google_search (không ép JSON) và trả các lựa chọn', async () => {
    const fn = aiOptions([A, Y, P])
    vi.stubGlobal('fetch', fn)
    const r = await findMaterials(env, ctx)
    expect(r).toHaveLength(3)
    const body = requestBody(fn)
    expect(body.tools).toEqual([{ google_search: {} }])
    expect(body.generationConfig.responseMimeType).toBeUndefined() // google_search không dùng chung JSON mode
  })
  it('AI trả văn xuôi không có JSON → rỗng (không báo lỗi)', async () => {
    vi.stubGlobal('fetch', aiText('Xin lỗi, tôi không tìm được.'))
    expect(await findMaterials(env, ctx)).toEqual([])
  })
  it('API từ chối → ném lỗi AI để thử lại', async () => {
    await expect(findMaterials(env, ctx)).rejects.toMatchObject({ kind: 'rate' })
  })
})

describe('POST /api/sessions/:id/materials — bắt đầu buổi', () => {
  it('cần đăng nhập', async () => {
    expect((await call(`/api/sessions/${await sid(1)}/materials`, {}, false)).status).toBe(401)
  })
  it('AI tìm được 3 → trả 3 lựa chọn chưa chọn, lưu vào buổi học', async () => {
    vi.stubGlobal('fetch', aiOptions([A, Y, P]))
    const r = await start()
    expect(r.status).toBe(200)
    const { material } = await json(r)
    expect(material).toMatchObject({ chosen: null, fallback: false })
    expect(material.options.map((o: any) => o.type)).toEqual(['article', 'youtube', 'podcast'])
    const stored = JSON.parse((await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string }>())!.material_json)
    expect(stored).toEqual(material)
  })
  it('2 lựa chọn cũng đủ', async () => {
    vi.stubGlobal('fetch', aiOptions([A, Y]))
    expect((await json(await start())).material).toMatchObject({ fallback: false, options: [{ type: 'article' }, { type: 'youtube' }] })
  })
  it('chỉ lưu link + đoạn trích ngắn, không lưu nội dung gốc', async () => {
    vi.stubGlobal('fetch', aiOptions([{ ...A, excerpt: 'x'.repeat(5000), body: 'TOÀN BỘ BÀI VIẾT', html: '<html>' }, Y]))
    const raw = (await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string }>())
    expect(raw!.material_json).toBeNull()
    await start()
    const text = (await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string }>())!.material_json
    expect(text).not.toContain('TOÀN BỘ BÀI VIẾT')
    expect(text).not.toContain('<html>')
    expect(JSON.parse(text).options[0].excerpt).toHaveLength(400)
  })
  it('gọi lại: trả đúng danh sách cũ, KHÔNG gọi AI lần nữa', async () => {
    const fn = aiOptions([A, Y, P])
    vi.stubGlobal('fetch', fn)
    const first = await json(await start())
    const second = await json(await start())
    expect(second).toEqual(first)
    expect(geminiCalls(fn)).toBe(1)
  })
  it('chỉ buổi chưa xong đầu tiên mới bắt đầu được (409 not_next)', async () => {
    const fn = aiOptions([A, Y, P])
    vi.stubGlobal('fetch', fn)
    const r = await start(2)
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('not_next')
    expect(fn).not.toHaveBeenCalled()
  })
  it('xong buổi 1 thì buổi 2 bắt đầu được; buổi 1 đã xong → 409 done', async () => {
    vi.stubGlobal('fetch', aiOptions([A, Y, P]))
    await db.prepare("UPDATE sessions SET status='done', score=90, completed_date=? WHERE seq=1").bind(todayVN()).run()
    expect((await start(2)).status).toBe(200)
    const r = await start(1)
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('done')
  })
  it('buổi bị lỡ vẫn là buổi tiếp theo và bắt đầu được', async () => {
    vi.stubGlobal('fetch', aiOptions([A, Y]))
    await db.prepare("UPDATE sessions SET status='missed' WHERE seq=1").run()
    expect((await start(1)).status).toBe(200)
  })
  it('id không tồn tại → 404', async () => {
    expect((await call('/api/sessions/99999/materials', {})).status).toBe(404)
  })
  it('tìm kiếm hết hạn mức (429) → fallback: AI tự viết bài, lý do search_error', async () => {
    const r = await start() // fetch mặc định 429
    expect(r.status).toBe(200)
    expect((await json(r)).material).toEqual({ options: [], chosen: -1, fallback: true, fallback_reason: 'search_error' })
  })
  it('sai khóa/model (403) → 503 thông báo tiếng Việt, KHÔNG lưu gì, thử lại được', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    const r = await start()
    expect(r.status).toBe(503)
    expect(await json(r)).toMatchObject({ error: 'ai_unavailable', kind: 'config', retryable: false })
    expect((await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string | null }>())!.material_json).toBeNull()
    vi.stubGlobal('fetch', aiOptions([A, Y, P])) // đã sửa cấu hình
    expect((await start()).status).toBe(200)
  })
  it('chỉ tìm được 1 nguồn dùng được → fallback (AI sẽ tự viết bài), chưa có lựa chọn', async () => {
    vi.stubGlobal('fetch', aiOptions([A, { ...Y, url: 'sai' }]))
    expect((await json(await start())).material).toEqual({ options: [], chosen: -1, fallback: true, fallback_reason: 'no_results' })
  })
  it('không tìm được gì / AI trả văn xuôi → fallback', async () => {
    vi.stubGlobal('fetch', aiText('Không có kết quả.'))
    expect((await json(await start())).material).toMatchObject({ fallback: true, options: [] })
  })
  it('không đưa lại nguồn đã chọn ở buổi trước', async () => {
    const f1 = aiOptions([A, Y, P])
    vi.stubGlobal('fetch', f1)
    await start(1)
    // giả lập đã chọn nguồn A ở buổi 1 và học xong
    const m = JSON.parse((await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string }>())!.material_json)
    m.chosen = 0
    await db.prepare("UPDATE sessions SET material_json = ?, status='done' WHERE seq = 1").bind(JSON.stringify(m)).run()

    const f2 = aiOptions([A, Y, P]) // AI vẫn trả A
    vi.stubGlobal('fetch', f2)
    const { material } = await json(await start(2))
    expect(material.options.map((o: any) => o.url)).not.toContain(A.url)
    expect(requestBody(f2).contents[0].parts[0].text).toContain(A.url) // và đã dặn AI tránh
  })
  it('prompt gửi AI có chủ đề của tuần và mức của lộ trình', async () => {
    const fn = aiOptions([A, Y])
    vi.stubGlobal('fetch', fn)
    const topic = (await db.prepare('SELECT topic FROM plan_weeks WHERE week_no = 1').first<{ topic: string }>())!.topic
    await start()
    const prompt = requestBody(fn).contents[0].parts[0].text as string
    expect(prompt).toContain('CEFR level A1')
    expect(prompt).toContain(topic)
  })
})

describe('GET /api/sessions/:id', () => {
  it('trả thông tin buổi + danh sách tài liệu đã tìm', async () => {
    vi.stubGlobal('fetch', aiOptions([A, Y, P]))
    await start()
    const { session } = await json(await call(`/api/sessions/${await sid(1)}`))
    expect(session).toMatchObject({ seq: 1, week_no: 1, status: 'pending', score: null })
    expect(session.topic).not.toBe('')
    expect(session.material.options).toHaveLength(3)
  })
  it('chưa bắt đầu → material null; id lạ → 404; chưa đăng nhập → 401', async () => {
    expect((await json(await call(`/api/sessions/${await sid(1)}`))).session.material).toBeNull()
    expect((await call('/api/sessions/99999')).status).toBe(404)
    expect((await call(`/api/sessions/${await sid(1)}`, undefined, false)).status).toBe(401)
  })
})
