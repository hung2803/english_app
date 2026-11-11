import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { ADJUST_TIMEOUT_MS } from './adjustment'
import type { QuizItem } from './quiz'
import { lessonJson } from './test-fixtures'
import { createTestDb } from './test-db'
import { findWeeksNeedingReview } from './weekly'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database
const LESSON = lessonJson()
const QUIZ = LESSON.quiz as QuizItem[]
const ALL = QUIZ.map((q) => q.answer as number | string)
const WRONG = QUIZ.map((q) => (q.type === 'mcq' ? ((q.answer as number) + 1) % 4 : 'wrong'))

/** ExecutionContext giả: ghi lại các việc nền để test chờ xong. */
let background: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughException: () => {} } as unknown as ExecutionContext

let adjustCalls: number
let adjustGate: Promise<void> | null
let adjustStatus: number
const REPLY = { summary_vi: 'Tuần này ổn.', changes: [{ week_no: 3, topic: 'Review: x', goal_vi: 'Ôn x' }] }

beforeEach(async () => {
  background = []
  adjustCalls = 0
  adjustGate = null
  adjustStatus = 200
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: unknown, init?: RequestInit) => {
      const text = JSON.parse(init?.body as string).contents[0].parts[0].text as string
      if (text.includes('curriculum designer')) return new Response('', { status: 429 })
      adjustCalls++
      if (adjustGate) await adjustGate
      if (adjustStatus !== 200) return new Response('', { status: adjustStatus })
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(REPLY) }] } }] })
    }),
  )
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await post('/api/plan', {})).status).toBe(200)
  await db.prepare('UPDATE sessions SET lesson_json = ?').bind(JSON.stringify(LESSON)).run()
})
afterEach(() => vi.unstubAllGlobals())

/** `withCtx`: true = như production (có ExecutionContext); false = như test thông thường (không có) */
async function post(path: string, body: unknown, withCtx = false) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: JSON.stringify(body) }, env, withCtx ? ctx : undefined)
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const submit = async (seq: number, answers: unknown = ALL, withCtx = true) => post(`/api/sessions/${await sid(seq)}/quiz`, { answers }, withCtx)
const settle = () => Promise.all(background)
const proposals = async () => (await db.prepare('SELECT week_no, status FROM plan_adjustments ORDER BY week_no').all<any>()).results
const week1 = async () => { for (let s = 1; s <= 5; s++) await submit(s) }

describe('nộp quiz kích hoạt điều chỉnh cuối tuần', () => {
  it('4 buổi đầu của tuần: không gọi AI điều chỉnh', async () => {
    for (let s = 1; s <= 4; s++) await submit(s)
    await settle()
    expect(adjustCalls).toBe(0)
    expect(await proposals()).toEqual([])
  })

  it('buổi thứ 5 của tuần: AI được kích hoạt đúng 1 lần, đề xuất được lưu (chờ duyệt)', async () => {
    await week1()
    await settle()
    expect(adjustCalls).toBe(1)
    expect(await proposals()).toEqual([{ week_no: 1, status: 'pending' }])
  })

  it('tuần có đề xuất rồi thì các buổi sau (tuần 2) không kích hoạt lại tuần 1', async () => {
    await week1()
    await settle()
    for (let s = 6; s <= 8; s++) await submit(s)
    await settle()
    expect(adjustCalls).toBe(1)
    expect(await proposals()).toEqual([{ week_no: 1, status: 'pending' }])
  })

  it('tuần 2 xong cũng được kích hoạt riêng', async () => {
    await week1()
    await settle()
    for (let s = 6; s <= 10; s++) await submit(s)
    await settle()
    expect(adjustCalls).toBe(2)
    expect((await proposals()).map((p) => p.week_no)).toEqual([1, 2])
  })

  it('điểm thấp vẫn kích hoạt (buổi vẫn xong dù chưa đạt)', async () => {
    for (let s = 1; s <= 5; s++) await submit(s, WRONG)
    await settle()
    expect(adjustCalls).toBe(1)
    expect((await proposals())[0].week_no).toBe(1)
  })

  it('tuần cuối của lộ trình: không còn tuần sau để điều chỉnh → không gọi AI', async () => {
    await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE week_no <= 11").bind(todayVN()).run()
    await db.prepare('INSERT INTO plan_adjustments (plan_id, week_no, summary_vi, changes_json, created_at) SELECT 1, week_no, \'s\', \'[]\', ? FROM plan_weeks WHERE week_no <= 11').bind(todayVN()).run()
    for (let s = 56; s <= 60; s++) await submit(s)
    await settle()
    expect(adjustCalls).toBe(0)
  })
})

describe('chạy nền: người học không phải chờ AI', () => {
  it('có ExecutionContext: trả kết quả quiz NGAY trong khi AI điều chỉnh còn đang chạy; xong nền mới lưu đề xuất', async () => {
    let release!: () => void
    adjustGate = new Promise<void>((r) => (release = r))
    for (let s = 1; s <= 4; s++) await submit(s)
    const r = await submit(5) // AI bị giữ lại — nếu đường này chờ AI thì sẽ treo ở đây
    expect(r.status).toBe(200)
    expect((await json(r)).result.score).toBe(100)
    expect(await proposals()).toEqual([]) // AI chưa trả lời, chưa có đề xuất
    expect(background).toHaveLength(5) // mỗi lần nộp thành công đăng ký một việc nền
    release()
    await settle()
    expect(await proposals()).toEqual([{ week_no: 1, status: 'pending' }])
  })

  it('kết quả quiz và trạng thái buổi đã được chốt TRƯỚC khi việc nền chạy xong', async () => {
    adjustGate = new Promise<void>(() => {}) // AI treo mãi
    for (let s = 1; s <= 5; s++) await submit(s)
    expect((await db.prepare("SELECT COUNT(*) n FROM sessions WHERE status = 'done'").first<any>()).n).toBe(5)
    expect((await db.prepare('SELECT score FROM sessions WHERE seq = 5').first<any>()).score).toBe(100)
  })

  it('không có ExecutionContext (như test): việc nền được chờ xong tại chỗ', async () => {
    for (let s = 1; s <= 5; s++) await submit(s, ALL, false)
    expect(await proposals()).toEqual([{ week_no: 1, status: 'pending' }])
  })

  it('thời gian chờ AI nền ngắn hơn giới hạn ~30 giây của waitUntil', () => {
    expect(ADJUST_TIMEOUT_MS).toBeLessThanOrEqual(28_000)
    expect(ADJUST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
  })
})

describe('AI điều chỉnh lỗi không ảnh hưởng người học', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('AI từ chối (429): nộp quiz vẫn thành công, điểm đã lưu, chưa có đề xuất', async () => {
    adjustStatus = 429
    for (let s = 1; s <= 4; s++) await submit(s)
    const r = await submit(5)
    await settle()
    expect(r.status).toBe(200)
    expect((await json(r)).result.score).toBe(100)
    expect((await db.prepare('SELECT status, score FROM sessions WHERE seq = 5').first<any>())).toEqual({ status: 'done', score: 100 })
    expect(await proposals()).toEqual([])
  })

  it('sau khi AI lỗi, tuần vẫn nằm trong danh sách cần thử lại', async () => {
    adjustStatus = 429
    await week1()
    await settle()
    expect(await findWeeksNeedingReview(db)).toEqual([{ planId: 1, weekNo: 1 }])
  })

  it('AI lỗi nền không làm treo/ném lỗi ở lệnh chờ việc nền', async () => {
    adjustStatus = 500
    await week1()
    await expect(settle()).resolves.toBeDefined()
  })

  it('AI lỗi trong chế độ không có ExecutionContext: vẫn trả 200', async () => {
    adjustStatus = 429
    for (let s = 1; s <= 4; s++) await submit(s, ALL, false)
    expect((await submit(5, ALL, false)).status).toBe(200)
  })

  it('AI trả nội dung hỏng → không lưu đề xuất, nộp quiz vẫn 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      const text = JSON.parse(init?.body as string).contents[0].parts[0].text as string
      if (text.includes('curriculum designer')) return new Response('', { status: 429 })
      return Response.json({ candidates: [{ content: { parts: [{ text: 'không phải json' }] } }] })
    }))
    await week1()
    await settle()
    expect(await proposals()).toEqual([])
  })
})

describe('nộp quiz không thành công thì không kích hoạt gì', () => {
  it('câu trả lời không hợp lệ (400): không đăng ký việc nền, không gọi AI', async () => {
    const r = await submit(1, [1, 2])
    expect(r.status).toBe(400)
    expect(background).toHaveLength(0)
    expect(adjustCalls).toBe(0)
  })
  it('nộp lần hai (409): không đăng ký việc nền', async () => {
    await submit(1)
    background.length = 0
    expect((await submit(1)).status).toBe(409)
    expect(background).toHaveLength(0)
  })
  it('buổi không tồn tại / chưa có bài: không đăng ký việc nền', async () => {
    expect((await post('/api/sessions/99999/quiz', { answers: [] }, true)).status).toBe(404)
    await db.prepare('UPDATE sessions SET lesson_json = NULL WHERE seq = 1').run()
    expect((await submit(1)).status).toBe(409)
    expect(background).toHaveLength(0)
  })
  it('chưa đăng nhập (401): không đăng ký việc nền', async () => {
    const r = await app.request(`/api/sessions/${await sid(1)}/quiz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: ALL }) }, env, ctx)
    expect(r.status).toBe(401)
    expect(background).toHaveLength(0)
  })
})

describe('đề xuất tạo nền dùng được ngay', () => {
  it('đề xuất tạo sau buổi thứ 5 hiện trong danh sách chờ duyệt và trên trang lộ trình', async () => {
    await week1()
    await settle()
    const cookie = { headers: { cookie: `ea_session=${await makeToken(SECRET)}` } }
    const list = await json(await app.request('/api/adjustments?status=pending', cookie, env))
    expect(list.adjustments).toHaveLength(1)
    expect(list.adjustments[0]).toMatchObject({ week_no: 1, summary_vi: 'Tuần này ổn.', changes: [{ week_no: 3, topic: 'Review: x' }] })
    expect((await json(await app.request('/api/plan', cookie, env))).plan.pending_adjustments).toBe(1)
  })
})
