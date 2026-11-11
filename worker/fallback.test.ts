import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { createTestDb } from './test-db'
import type { Env } from './env'
import { QUIZ8 } from './test-fixtures'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

const LESSON = {
  title: 'My daily routine',
  excerpt: 'I get up at six. I drink tea and go to work by bus. In the evening I read a book.',
  summary_vi: 'Bài nói về thói quen hằng ngày.',
  explanation_vi: 'Người viết kể các việc làm trong ngày bằng thì hiện tại đơn.',
  vocab: ['routine', 'breakfast', 'commute', 'evening', 'habit'].map((w) => ({ word: w, pos: 'noun', meaning_vi: 'nghĩa ' + w, example: `A ${w}.` })),
  grammar: [{ point: 'Present simple', explanation_vi: 'Dùng cho thói quen.', example: 'I get up at six.' }],
  quiz: QUIZ8,
}
const A = { type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }
const B = { type: 'article', title: 'B', url: 'https://example.com/b', why_vi: 'b', excerpt: 'b' }
const PAGE = '<html><head><title>L</title></head><body>' + '<p>Can I have a coffee please? Yes of course. </p>'.repeat(40) + '</body></html>'

type Search = (n: number) => Response | Promise<Response>
/** Gemini: lời gọi tìm kiếm (có google_search) và lời gọi soạn bài (JSON) được tách riêng. */
function net(search: Search, compose: Search = () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(LESSON) }] } }] })) {
  const n = { search: 0, compose: 0 }
  const f = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('generativelanguage')) {
      const isSearch = Boolean(JSON.parse(init?.body as string).tools)
      return isSearch ? search(++n.search) : compose(++n.compose)
    }
    if (url.includes('oembed')) return Response.json({ title: 'ok' })
    return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
  })
  vi.stubGlobal('fetch', f)
  return { f, n }
}
const searchReply = (options: unknown[]) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ options }) }] } }] })

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  expect((await call('/api/plan', {})).status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown) {
  return app.request(
    path,
    { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  )
}
const json = async (r: Response) => (await r.json()) as any
const sid = async () => (await db.prepare('SELECT id FROM sessions WHERE seq = 1').first<{ id: number }>())!.id
const begin = async () => call(`/api/sessions/${await sid()}/materials`, {})
const compose = async () => call(`/api/sessions/${await sid()}/compose`, {})
const stored = async () => JSON.parse((await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string }>())!.material_json)

describe('không tìm được tài liệu → fallback', () => {
  it('AI trả không có nguồn nào → fallback no_results', async () => {
    net(() => searchReply([]))
    expect((await json(await begin())).material).toEqual({ options: [], chosen: -1, fallback: true, fallback_reason: 'no_results' })
  })
  it('AI trả lời văn xuôi không có JSON → fallback no_results', async () => {
    net(() => Response.json({ candidates: [{ content: { parts: [{ text: 'Xin lỗi, tôi không tìm được.' }] } }] }))
    expect((await json(await begin())).material).toMatchObject({ fallback: true, fallback_reason: 'no_results' })
  })
  it('chỉ 1 nguồn dùng được (ngưỡng tối thiểu 2) → fallback', async () => {
    net(() => searchReply([A]))
    expect((await json(await begin())).material).toMatchObject({ fallback: true, fallback_reason: 'no_results' })
  })
  it('mọi link đều hỏng (kiểm tra link loại hết) → fallback', async () => {
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('generativelanguage')) return searchReply([A, B])
      return new Response('gone', { status: 404 })
    })
    vi.stubGlobal('fetch', f)
    expect((await json(await begin())).material).toMatchObject({ fallback: true, fallback_reason: 'no_results' })
  })
  it('đủ 2 nguồn dùng được → KHÔNG fallback', async () => {
    net(() => searchReply([A, B]))
    expect((await json(await begin())).material).toMatchObject({ fallback: false, chosen: null })
  })
})

describe('tìm kiếm lỗi → fallback', () => {
  it.each([
    ['quá thời gian', () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))],
    ['lỗi máy chủ AI (500)', () => new Response('', { status: 500 })],
    ['lỗi mạng', () => Promise.reject(new TypeError('network'))],
    ['phản hồi rỗng', () => Response.json({ candidates: [] })],
    ['bị chặn', () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } })],
  ] as [string, Search][])('%s → fallback search_error, vẫn trả 200', async (_n, search) => {
    net(search)
    const r = await begin()
    expect(r.status).toBe(200)
    expect((await json(r)).material).toEqual({ options: [], chosen: -1, fallback: true, fallback_reason: 'search_error' })
    expect(await stored()).toMatchObject({ fallback: true, chosen: -1 })
  })
  it('tìm kiếm hết hạn mức (429) → vẫn fallback search_error (gói không có hạn mức tìm kiếm Google sẽ luôn 429)', async () => {
    net(() => new Response('', { status: 429 }))
    const r = await begin()
    expect(r.status).toBe(200)
    expect((await json(r)).material).toMatchObject({ fallback: true, fallback_reason: 'search_error' })
  })
  it('429 cả lúc soạn bài → 503 để thử lại (xem bên dưới)', async () => {
    net(() => new Response('', { status: 429 }), () => new Response('', { status: 429 }))
    await begin()
    const r = await compose()
    expect(r.status).toBe(503)
    expect(await json(r)).toMatchObject({ kind: 'rate', retryable: true })
  })
  it('sai khóa API (403) → KHÔNG fallback (AI tự viết cũng không chạy được)', async () => {
    net(() => new Response('', { status: 403 }))
    const r = await begin()
    expect(r.status).toBe(503)
    expect((await json(r)).retryable).toBe(false)
    expect((await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string | null }>())!.material_json).toBeNull()
  })
})

describe('AI tự viết bài và ghi rõ "do AI viết"', () => {
  it('fallback no_results: bài có source ai, ai_written, kèm lý do tiếng Việt', async () => {
    net(() => searchReply([]))
    await begin()
    const { lesson } = await json(await compose())
    expect(lesson.source).toEqual({ type: 'ai', title: 'Bài đọc do AI viết', ai_written: true })
    expect(lesson.notice_vi).toBe('Không tìm được tài liệu phù hợp nên AI tự viết bài đọc.')
    expect(lesson.source.url).toBeUndefined() // không có link nguồn giả
  })
  it('fallback search_error: lý do khác', async () => {
    net(() => new Response('', { status: 500 }))
    await begin()
    expect((await json(await compose())).lesson.notice_vi).toBe('Bước tìm tài liệu gặp lỗi nên AI tự viết bài đọc.')
  })
  it('bài vẫn đủ nội dung như bài thường: tóm tắt, giải thích, từ vựng, ngữ pháp', async () => {
    net(() => searchReply([]))
    await begin()
    const { lesson } = await json(await compose())
    expect(lesson.summary_vi).not.toBe('')
    expect(lesson.explanation_vi).not.toBe('')
    expect(lesson.vocab.length).toBeGreaterThanOrEqual(4)
    expect(lesson.grammar.length).toBeGreaterThanOrEqual(1)
  })
  it('prompt yêu cầu AI viết bài gốc theo mức và chủ đề, không tải trang nào', async () => {
    const { f } = net(() => searchReply([]))
    await begin()
    f.mockClear()
    await compose()
    const calls = f.mock.calls
    expect(calls).toHaveLength(1) // chỉ một lời gọi AI, không tải trang web nào
    const prompt = JSON.parse((calls[0][1] as RequestInit).body as string).contents[0].parts[0].text as string
    expect(prompt).toContain('OWN original English reading')
    expect(prompt).toContain('CEFR A1')
  })
  it('GET buổi học cho thấy cờ ai_written để giao diện hiển thị nhãn', async () => {
    net(() => searchReply([]))
    await begin()
    await compose()
    const { session } = await json(await call(`/api/sessions/${await sid()}`))
    expect(session.material).toMatchObject({ fallback: true, fallback_reason: 'no_results' })
    expect(session.lesson.source.ai_written).toBe(true)
  })
  it('bài thường (có tài liệu) KHÔNG bị gắn nhãn AI viết', async () => {
    net(() => searchReply([A, B]))
    await begin()
    await call(`/api/sessions/${await sid()}/choose`, { index: 0 })
    const { lesson } = await json(await compose())
    expect(lesson.source).toMatchObject({ type: 'article', url: A.url, ai_written: false })
    expect(lesson.notice_vi).toBeUndefined()
  })
  it('fallback không chọn được tài liệu (khóa ở chế độ AI viết)', async () => {
    net(() => searchReply([]))
    await begin()
    const r = await call(`/api/sessions/${await sid()}/choose`, { index: 0 })
    expect(r.status).toBe(409)
  })
  it('AI từ chối khi viết bài (429) → 503 + thử lại; không lưu bài dở; vẫn ở chế độ fallback', async () => {
    net(() => searchReply([]), () => new Response('', { status: 429 }))
    await begin()
    const r = await compose()
    expect(r.status).toBe(503)
    expect((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<{ lesson_json: string | null }>())!.lesson_json).toBeNull()
    expect((await stored()).fallback).toBe(true)
  })
  it('toàn bộ luồng: tìm lỗi → fallback → AI viết → nhận bài đánh dấu AI viết', async () => {
    const { n } = net(() => Promise.reject(new TypeError('network')))
    expect((await begin()).status).toBe(200)
    const { lesson } = await json(await compose())
    expect(lesson.source.ai_written).toBe(true)
    expect(n).toEqual({ search: 1, compose: 1 })
  })
})
