import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

const LESSON = {
  title: 'Ordering food', source: { type: 'article', url: 'https://example.com/a', title: 'A', ai_written: false }, excerpt: 'Can I have a coffee?',
  summary_vi: 'Tóm tắt.', explanation_vi: 'Giải thích.',
  vocab: ['menu', 'bill', 'waiter', 'order', 'tip'].map((w) => ({ word: w, meaning_vi: 'nghĩa ' + w })),
  grammar: [{ point: 'Can I have', explanation_vi: 'Xin phép.' }],
}
const MATERIAL = { options: [{ type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }], chosen: 0, fallback: false }

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Nice!', correction: { corrected: 'I went.', issues: [{ original: 'I go', fixed: 'I went', explanation_vi: 'Quá khứ.' }] } }) }] } }] })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
  await db.prepare('UPDATE sessions SET material_json = ?, lesson_json = ? WHERE seq IN (1, 2)').bind(JSON.stringify(MATERIAL), JSON.stringify(LESSON)).run()
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
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const say = async (msg: string, seq = 1) => call(`/api/sessions/${await sid(seq)}/chat`, { message: msg })
const finish = (seq: number, score = 85) => db.prepare("UPDATE sessions SET status='done', score=?, completed_date=? WHERE seq=?").bind(score, todayVN(), seq).run()

describe('mở lại buổi đã xong', () => {
  it('trả đầy đủ: trạng thái, điểm, ngày xong, tài liệu đã chọn, bài đã soạn', async () => {
    await finish(1, 85)
    const { session } = await json(await call(`/api/sessions/${await sid(1)}`))
    expect(session).toMatchObject({ seq: 1, status: 'done', score: 85, completed_date: todayVN() })
    expect(session.material).toEqual(MATERIAL)
    expect(session.lesson).toEqual(LESSON)
  })

  it('hội thoại cũ (kèm phần sửa lỗi) vẫn đọc được sau khi buổi xong', async () => {
    await say('I go to market yesterday')
    await say('and I buy fish')
    await finish(1)
    const { messages } = await json(await call(`/api/sessions/${await sid(1)}/chat`))
    expect(messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[0]).toMatchObject({ content: 'I go to market yesterday', correction: { has_errors: true, corrected: 'I went.' } })
  })

  it('đọc lại nhiều lần cho cùng kết quả, không gọi AI', async () => {
    await say('hello')
    await finish(1)
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchSpy.mockClear()
    const a = await json(await call(`/api/sessions/${await sid(1)}/chat`))
    const b = await json(await call(`/api/sessions/${await sid(1)}/chat`))
    await call(`/api/sessions/${await sid(1)}`)
    expect(b).toEqual(a)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('mở lại KHÔNG kích hoạt lại gì: tìm tài liệu / chọn / soạn bài / chat đều bị từ chối (409)', async () => {
    await finish(1)
    const id = await sid(1)
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchSpy.mockClear()
    for (const [path, body] of [[`/api/sessions/${id}/materials`, {}], [`/api/sessions/${id}/choose`, { index: 0 }], [`/api/sessions/${id}/compose`, {}], [`/api/sessions/${id}/chat`, { message: 'hi' }]] as const) {
      const r = await call(path, body)
      expect(r.status, path).toBe(409)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    // bài đã soạn không bị ghi đè
    expect((await json(await call(`/api/sessions/${id}`))).session.lesson).toEqual(LESSON)
  })

  it('các buổi cũ độc lập: mở buổi 1 không lẫn nội dung/hội thoại buổi 2', async () => {
    await say('only in one', 1)
    await say('only in two', 2)
    await finish(1)
    await finish(2)
    const m1 = (await json(await call(`/api/sessions/${await sid(1)}/chat`))).messages.map((m: any) => m.content)
    const m2 = (await json(await call(`/api/sessions/${await sid(2)}/chat`))).messages.map((m: any) => m.content)
    expect(m1).toContain('only in one')
    expect(m1).not.toContain('only in two')
    expect(m2).toContain('only in two')
  })

  it('lộ trình đã lưu trữ (đã tạo lộ trình mới): buổi cũ vẫn mở lại được kèm hội thoại', async () => {
    await say('old plan chat')
    await finish(1)
    const id = await sid(1)
    await db.prepare("UPDATE plans SET status = 'archived'").run()
    expect((await call(`/api/sessions/${id}`)).status).toBe(200)
    expect((await json(await call(`/api/sessions/${id}/chat`))).messages.length).toBe(2)
  })

  it('cần đăng nhập để mở lại', async () => {
    await finish(1)
    const id = await sid(1)
    for (const p of [`/api/sessions/${id}`, `/api/sessions/${id}/chat`]) {
      const r = await app.request(p, {}, env)
      expect(r.status, p).toBe(401)
    }
  })

  it('buổi đang học (chưa xong): vẫn chat được; đánh dấu xong thì chuyển sang chỉ xem', async () => {
    expect((await say('during')).status).toBe(200)
    await finish(1)
    expect((await say('after')).status).toBe(409)
    expect((await json(await call(`/api/sessions/${await sid(1)}/chat`))).messages).toHaveLength(2)
  })
})
