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
  title: 'Ordering food', source: { type: 'ai', title: 'AI', ai_written: true }, excerpt: 'Can I have a coffee?',
  summary_vi: 's', explanation_vi: 'e',
  vocab: ['menu', 'bill', 'waiter', 'order', 'tip'].map((w) => ({ word: w, meaning_vi: 'm' })),
  grammar: [{ point: 'p', explanation_vi: 'e' }],
}
let n: number
let fail: boolean
function stubAi() {
  n = 0
  fail = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (fail) return new Response('', { status: 429 })
      n++
      const correction = n % 2 === 1 ? { corrected: `fixed ${n}`, issues: [{ original: `bad ${n}`, fixed: `good ${n}`, explanation_vi: `vì ${n}` }] } : { corrected: '', issues: [] }
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: `reply ${n}`, correction }) }] } }] })
    }),
  )
}

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
  for (const seq of [1, 2, 3]) await db.prepare('UPDATE sessions SET lesson_json = ? WHERE seq = ?').bind(JSON.stringify(LESSON), seq).run()
  stubAi()
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
const say = async (message: string, seq = 1) => call(`/api/sessions/${await sid(seq)}/chat`, { message })
const history = async (seq = 1) => (await json(await call(`/api/sessions/${await sid(seq)}/chat`))).messages as any[]
const count = async (sql = 'SELECT COUNT(*) n FROM chat_messages') => (await db.prepare(sql).first<{ n: number }>())!.n

describe('lịch sử chat được lưu theo buổi', () => {
  it('mỗi lượt lưu đúng một cặp (người học → AI) gắn với đúng buổi', async () => {
    await say('hello')
    const rows = (await db.prepare('SELECT session_id, role, content FROM chat_messages ORDER BY id').all<any>()).results
    expect(rows).toEqual([
      { session_id: await sid(1), role: 'user', content: 'hello' },
      { session_id: await sid(1), role: 'assistant', content: 'reply 1' },
    ])
  })

  it('nhiều lượt: lưu đủ, đúng thứ tự cũ → mới, vai luân phiên user/assistant', async () => {
    for (let i = 1; i <= 10; i++) await say(`message ${i}`)
    const h = await history()
    expect(h).toHaveLength(20)
    expect(h.map((m) => m.role)).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'user' : 'assistant')))
    expect(h.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `message ${i + 1}`))
    const ids = h.map((m) => m.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(20)
  })

  it('tách riêng theo buổi: buổi nào chỉ thấy hội thoại của buổi đó', async () => {
    await say('one-a', 1)
    await say('two-a', 2)
    await say('one-b', 1)
    await say('three-a', 3)
    expect((await history(1)).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['one-a', 'one-b'])
    expect((await history(2)).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['two-a'])
    expect((await history(3)).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['three-a'])
    const per = (await db.prepare('SELECT session_id, COUNT(*) n FROM chat_messages GROUP BY session_id ORDER BY session_id').all<any>()).results
    expect(per.map((r) => r.n)).toEqual([4, 2, 2])
  })

  it('buổi chưa chat → lịch sử rỗng', async () => {
    await say('hello', 1)
    expect(await history(2)).toEqual([])
  })

  it('còn nguyên qua các yêu cầu khác nhau (đọc lại nhiều lần cho cùng kết quả)', async () => {
    await say('hello')
    const a = await history()
    const b = await history()
    expect(b).toEqual(a)
    expect(await count()).toBe(2)
  })

  it('lưu cả phần AI sửa lỗi của từng câu; AI trả lời không có phần sửa', async () => {
    await say('first')
    await say('second')
    const users = (await history()).filter((m) => m.role === 'user')
    expect(users[0].correction).toEqual({ has_errors: true, corrected: 'fixed 1', issues: [{ original: 'bad 1', fixed: 'good 1', explanation_vi: 'vì 1' }] })
    expect(users[1].correction).toEqual({ has_errors: false, corrected: '', issues: [] })
    expect((await history()).filter((m) => m.role === 'assistant').every((m) => m.correction === undefined)).toBe(true)
  })

  it('lưu nguyên văn: xuống dòng, tiếng Việt có dấu, emoji, ký tự đặc biệt', async () => {
    const text = 'Xin chào 😀\nLine two — "quoted" <b>x</b> & more\tTab'
    await say(text)
    expect((await history())[0].content).toBe(text)
  })

  it('có dấu thời gian ISO của từng tin, tăng dần', async () => {
    await say('a')
    await say('b')
    const times = (await history()).map((m) => m.created_at as string)
    for (const t of times) expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect([...times].sort()).toEqual(times)
  })

  it('AI lỗi: lịch sử không đổi (không có tin lẻ), lượt sau lưu bình thường', async () => {
    await say('before')
    fail = true
    expect((await say('lost')).status).toBe(503)
    expect(await history()).toHaveLength(2)
    fail = false
    await say('after')
    expect((await history()).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['before', 'after'])
  })

  it('hai tin gửi cùng lúc: cả hai cặp đều được lưu, mỗi cặp liền nhau (không xen kẽ)', async () => {
    await Promise.all([say('alpha'), say('beta')])
    const h = await history()
    expect(h).toHaveLength(4)
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(h.filter((m) => m.role === 'user').map((m) => m.content).sort()).toEqual(['alpha', 'beta'])
  })
})

describe('lịch sử còn lại sau khi buổi xong / lộ trình đổi', () => {
  it('buổi xong: không chat thêm được nhưng lịch sử còn nguyên', async () => {
    await say('hello')
    await say('world')
    const before = await history()
    await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=1").bind(todayVN()).run()
    expect((await say('late')).status).toBe(409)
    expect(await history()).toEqual(before)
  })

  it('lộ trình bị lưu trữ (tạo lộ trình mới): lịch sử buổi cũ vẫn đọc được', async () => {
    await say('hello')
    const before = await history()
    await db.prepare("UPDATE plans SET status = 'archived'").run()
    expect(await history()).toEqual(before)
  })

  it('xóa buổi học (hoặc lộ trình) thì hội thoại đi theo, không để dòng mồ côi', async () => {
    await say('one', 1)
    await say('two', 2)
    await db.prepare('DELETE FROM sessions WHERE seq = 1').run()
    expect(await count("SELECT COUNT(*) n FROM chat_messages WHERE session_id NOT IN (SELECT id FROM sessions)")).toBe(0)
    expect(await count()).toBe(2) // chỉ còn hội thoại buổi 2
    await db.prepare('DELETE FROM plans').run()
    expect(await count()).toBe(0)
  })
})

describe('ràng buộc CSDL của chat_messages', () => {
  const ins = (session: number, role: string) =>
    db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').bind(session, role, 'x', 'now').run()

  it('không lưu được tin cho buổi không tồn tại (khóa ngoại)', async () => {
    await expect(ins(99999, 'user')).rejects.toThrow()
  })
  it('role chỉ được là user hoặc assistant', async () => {
    await expect(ins(await sid(1), 'system')).rejects.toThrow()
    await ins(await sid(1), 'user')
    await ins(await sid(1), 'assistant')
  })
  it('content không được rỗng/NULL', async () => {
    await expect(db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, NULL, ?)').bind(await sid(1), 'user', 'now').run()).rejects.toThrow()
  })
})
