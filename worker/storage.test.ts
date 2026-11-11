import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { normalizeLesson } from './lesson'
import { MATERIAL_EXCERPT_WORDS, normalizeOptions } from './materials'
import { clipWords, countWords } from './text'
import { createTestDb } from './test-db'
import type { Env } from './env'
import { QUIZ8 } from './test-fixtures'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

/** Trang nguồn dài ~400 câu, mỗi câu có dấu riêng SENT_n để dò xem nội dung nào bị lưu. */
const SENTENCES = Array.from({ length: 400 }, (_, i) => `SENT_${i} is a long sentence from the original article about food.`)
const PAGE = `<html><head><title>Food</title></head><body><p>${SENTENCES.join(' ')}</p></body></html>`
const OPTIONS = [
  { type: 'article', title: 'Food article', url: 'https://example.com/a', why_vi: 'Dễ đọc.', excerpt: SENTENCES.slice(0, 300).join(' ') }, // AI "trích" cả 300 câu
  { type: 'article', title: 'Other article', url: 'https://example.com/b', why_vi: 'Cũng ổn.', excerpt: 'Short quote.' },
]
const LESSON = {
  title: 'Food',
  excerpt: SENTENCES.slice(0, 300).join(' '), // AI cũng "trích" cả 300 câu vào bài
  summary_vi: 'Tóm tắt.',
  explanation_vi: 'Giải thích.',
  vocab: ['menu', 'bill', 'order', 'waiter', 'tip'].map((w) => ({ word: w, meaning_vi: 'nghĩa', example: `A ${w}.` })),
  grammar: [{ point: 'Can I have', explanation_vi: 'Xin phép.' }],
  quiz: QUIZ8,
}

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('generativelanguage')) {
        const isSearch = Boolean(JSON.parse(init?.body as string).tools)
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(isSearch ? { options: OPTIONS } : LESSON) }] } }] })
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    }),
  )
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
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
const sid = async () => (await db.prepare('SELECT id FROM sessions WHERE seq = 1').first<{ id: number }>())!.id

/** Toàn bộ dữ liệu đang lưu trong CSDL, dạng chuỗi. */
async function dumpDb(): Promise<string> {
  const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()
  let out = ''
  for (const t of tables) out += JSON.stringify((await db.prepare(`SELECT * FROM ${t.name}`).all()).results)
  return out
}
const keysDeep = (v: unknown, acc = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc) }
  return acc
}
const sentenceMarks = (s: string) => (s.match(/SENT_\d+/g) ?? []).length

describe('helper', () => {
  it('clipWords / countWords', () => {
    expect(clipWords('  a   b c d ', 2)).toBe('a b')
    expect(clipWords('a b', 5)).toBe('a b')
    expect(clipWords('', 3)).toBe('')
    expect(countWords(' a  b\nc ')).toBe(3)
    expect(countWords('')).toBe(0)
  })
})

describe('đoạn trích: giới hạn theo SỐ TỪ', () => {
  it('normalizeOptions: tối đa 40 từ dù AI trả dài hơn nhiều', () => {
    const r = normalizeOptions({ options: [{ ...OPTIONS[0] }] })
    expect(countWords(r[0].excerpt)).toBeLessThanOrEqual(MATERIAL_EXCERPT_WORDS)
    expect(r[0].excerpt.length).toBeLessThanOrEqual(400)
  })
  it('normalizeLesson (nguồn thật): tối đa 80 từ', () => {
    const l = normalizeLesson(LESSON, { type: 'article', url: 'https://example.com/a', title: 'A', ai_written: false })
    expect(countWords(l.excerpt)).toBeLessThanOrEqual(80)
    expect(l.excerpt.length).toBeLessThanOrEqual(600)
  })
  it('bài AI tự viết: là nội dung của chính AI nên được dài hơn 80 từ (vẫn có trần)', () => {
    const own = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')
    const l = normalizeLesson({ ...LESSON, excerpt: own }, { type: 'ai', title: 'AI', ai_written: true })
    expect(countWords(l.excerpt)).toBe(150)
    expect(normalizeLesson({ ...LESSON, excerpt: 'x '.repeat(5000) }, { type: 'ai', title: 'AI', ai_written: true }).excerpt.length).toBeLessThanOrEqual(1500)
  })
})

describe('luồng đầy đủ: không có nội dung gốc nào nằm trong CSDL', () => {
  async function runFlow() {
    expect((await call(`/api/sessions/${await sid()}/materials`, {})).status).toBe(200)
    expect((await call(`/api/sessions/${await sid()}/choose`, { index: 0 })).status).toBe(200)
    expect((await call(`/api/sessions/${await sid()}/compose`, {})).status).toBe(200)
  }

  it('sau khi tìm + chọn + soạn bài, chỉ còn vài câu đầu của nguồn (đoạn trích), không phải cả bài', async () => {
    await runFlow()
    const dump = await dumpDb()
    // nguồn có 400 câu, AI trả "trích" 300 câu ở hai nơi: mỗi nơi chỉ giữ được vài câu đầu
    expect(sentenceMarks(dump)).toBeLessThan(20)
    for (const late of ['SENT_50', 'SENT_100', 'SENT_200', 'SENT_399']) expect(dump).not.toContain(late + ' ')
  })

  it('tổng dung lượng lưu cho một buổi nhỏ', async () => {
    await runFlow()
    const row = (await db.prepare('SELECT material_json, lesson_json FROM sessions WHERE seq = 1').first<{ material_json: string; lesson_json: string }>())!
    expect(row.material_json.length).toBeLessThan(3000)
    expect(row.lesson_json.length).toBeLessThan(5000)
    expect(PAGE.length).toBeGreaterThan(20000) // trang gốc lớn hơn rất nhiều
  })

  it('đoạn trích đã lưu: danh sách ≤ 40 từ, bài học ≤ 80 từ', async () => {
    await runFlow()
    const row = (await db.prepare('SELECT material_json, lesson_json FROM sessions WHERE seq = 1').first<{ material_json: string; lesson_json: string }>())!
    for (const o of JSON.parse(row.material_json).options) expect(countWords(o.excerpt)).toBeLessThanOrEqual(40)
    expect(countWords(JSON.parse(row.lesson_json).excerpt)).toBeLessThanOrEqual(80)
  })

  it('chỉ có các trường được phép: link + đoạn trích + phần AI soạn; không có html/body/text/content', async () => {
    await runFlow()
    const row = (await db.prepare('SELECT material_json, lesson_json FROM sessions WHERE seq = 1').first<{ material_json: string; lesson_json: string }>())!
    const matKeys = keysDeep(JSON.parse(row.material_json))
    expect([...matKeys].sort()).toEqual(['chosen', 'excerpt', 'fallback', 'options', 'title', 'type', 'url', 'why_vi'].sort())
    const lessonKeys = keysDeep(JSON.parse(row.lesson_json))
    const allowed = new Set(['title', 'source', 'type', 'url', 'ai_written', 'excerpt', 'summary_vi', 'explanation_vi', 'vocab', 'word', 'pos', 'meaning_vi', 'example', 'grammar', 'point', 'notice_vi', 'quiz', 'question', 'options', 'answer'])
    for (const k of lessonKeys) expect(allowed.has(k), `trường lạ: ${k}`).toBe(true)
    for (const bad of ['html', 'body', 'text', 'content', 'raw', 'source_text', 'transcript']) {
      expect(matKeys.has(bad)).toBe(false)
      expect(lessonKeys.has(bad)).toBe(false)
    }
  })

  it('AI trả thêm trường lạ (html/body…) thì bị loại, không lưu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('generativelanguage')) {
          const isSearch = Boolean(JSON.parse(init?.body as string).tools)
          const extra = { html: PAGE, body: 'TOÀN BỘ BÀI VIẾT GỐC', content: PAGE, transcript: PAGE }
          const payload = isSearch ? { options: OPTIONS.map((o) => ({ ...o, ...extra })), html: PAGE } : { ...LESSON, ...extra, source_text: PAGE, source: { type: 'x', html: PAGE } }
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] })
        }
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
      }),
    )
    await runFlow()
    const dump = await dumpDb()
    expect(dump).not.toContain('TOÀN BỘ BÀI VIẾT GỐC')
    expect(dump).not.toContain('<html>')
    expect(dump).not.toContain('<p>')
    expect(sentenceMarks(dump)).toBeLessThan(20)
  })

  it('YouTube: chỉ lưu link, không lưu phụ đề/transcript', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('generativelanguage')) {
          const body = JSON.parse(init?.body as string)
          const isSearch = Boolean(body.tools)
          const yt = { type: 'youtube', title: 'Video', url: 'https://www.youtube.com/watch?v=abc12345678', why_vi: 'ok', excerpt: 'Hello' }
          const payload = isSearch ? { options: [yt, OPTIONS[1]] } : { ...LESSON, excerpt: 'Hello there.' }
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] })
        }
        if (url.includes('oembed')) return Response.json({ title: 'ok' })
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
      }),
    )
    await runFlow()
    const lesson = JSON.parse((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<{ lesson_json: string }>())!.lesson_json)
    expect(lesson.source).toEqual({ type: 'youtube', url: 'https://www.youtube.com/watch?v=abc12345678', title: 'Video', ai_written: false })
    expect(lesson.excerpt).toBe('Hello there.')
  })

  it('GET buổi học cũng chỉ trả những gì đã lưu (không lộ nội dung gốc)', async () => {
    await runFlow()
    const text = await (await call(`/api/sessions/${await sid()}`)).text()
    expect(sentenceMarks(text)).toBeLessThan(20)
    expect(text).not.toContain('<html>')
  })

  it('nội dung trang chỉ đi qua bộ nhớ khi soạn bài: không được ghi vào bảng nào khác', async () => {
    await runFlow()
    const dump = await dumpDb()
    expect(dump).not.toContain('SENT_399')
    expect(dump).not.toContain('SENT_250')
    // các bảng không liên quan tới buổi học vẫn rỗng
    for (const t of ['uploads', 'chat_messages', 'push_subscriptions']) {
      expect((await db.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n).toBe(0)
    }
  })
})
