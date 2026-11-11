import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { buildPrompt, collectWeekData, generateAdjustment, PASS_SCORE } from './adjustment'
import { runWeeklyReview } from './adjustment-store'
import type { QuizItem } from './quiz'
import { lessonJson } from './test-fixtures'
import { createTestDb } from './test-db'
import { dispatchWeeklyReview, findWeeksNeedingReview } from './weekly'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database
const LESSON = lessonJson()
const QUIZ = LESSON.quiz as QuizItem[]
const wrongOf = (q: QuizItem) => (q.type === 'mcq' ? ((q.answer as number) + 1) % 4 : 'definitely wrong')
const ALL = [0, 1, 2, 3, 4, 5, 6, 7]
/** Bài làm đúng các câu trong `right`, sai các câu còn lại. */
const answers = (right: number[]) => QUIZ.map((q, i) => (right.includes(i) ? (q.answer as number | string) : wrongOf(q)))

let prompts: string[]
let adjustReply: unknown

beforeEach(async () => {
  prompts = []
  adjustReply = { summary_vi: 'Tuần này còn yếu vài từ.', changes: [] }
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: unknown, init?: RequestInit) => {
      const text = JSON.parse(init?.body as string).contents[0].parts[0].text as string
      if (text.includes('curriculum designer')) return new Response('', { status: 429 }) // lập khung: dùng bộ mặc định
      prompts.push(text)
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(adjustReply) }] } }] })
    }),
  )
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
  await db.prepare('UPDATE sessions SET lesson_json = ?').bind(JSON.stringify(LESSON)).run() // mọi buổi đã có bài (làm quiz trực tiếp)
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown) {
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const submit = async (seq: number, right: number[]) => {
  const r = await call(`/api/sessions/${await sid(seq)}/quiz`, { answers: answers(right) })
  expect(r.status).toBe(200)
  return (await json(r)).result
}
const WEEK1 = { planId: 1, weekNo: 1 }
/** Điểm các buổi tuần 1 (8 câu): 8→100, 7→88, 5→63, 3→38, 0→0 */
const doWeek1 = async (rights: number[][]) => {
  for (let i = 0; i < rights.length; i++) await submit(i + 1, rights[i])
}

describe('điểm quiz được lưu cho từng buổi', () => {
  it('nộp quiz lưu điểm vào buổi học, kể cả điểm thấp và 0', async () => {
    await submit(1, ALL) // 100
    await submit(2, [0, 1, 2]) // 3/8 = 38
    await submit(3, []) // 0
    const rows = (await db.prepare('SELECT seq, status, score FROM sessions WHERE seq <= 3 ORDER BY seq').all<any>()).results
    expect(rows).toEqual([
      { seq: 1, status: 'done', score: 100 },
      { seq: 2, status: 'done', score: 38 },
      { seq: 3, status: 'done', score: 0 },
    ])
  })
  it('điểm thấp (<70%) vẫn được lưu và buổi vẫn xong', async () => {
    const r = await submit(1, [0, 1])
    expect(r.passed).toBe(false)
    expect((await db.prepare('SELECT status, score FROM sessions WHERE seq = 1').first<any>())).toEqual({ status: 'done', score: 25 })
  })
})

describe('AI đọc điểm quiz thật của tuần khi điều chỉnh', () => {
  it('collectWeekData lấy đúng điểm các buổi đã xong theo thứ tự, trung bình, số buổi dưới 70%', async () => {
    await doWeek1([ALL, [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4], [0, 1, 2], []]) // 100, 88, 63, 38, 0
    const d = await collectWeekData(db, WEEK1)
    expect(d.scores).toEqual([100, 88, 63, 38, 0])
    expect(d.average).toBe(58)
    expect(d.lowCount).toBe(3)
    expect(PASS_SCORE).toBe(70)
  })

  it('ranh giới 70%: điểm đúng 70 không phải điểm thấp, 63 thì có', async () => {
    // quiz 8 câu không cho đúng 70 → dùng điểm lưu trực tiếp để kiểm tra ranh giới
    for (const [seq, score] of [[1, 70], [2, 69], [3, 71]] as const) {
      await db.prepare("UPDATE sessions SET status='done', score=?, completed_date=? WHERE seq=?").bind(score, todayVN(), seq).run()
    }
    expect((await collectWeekData(db, WEEK1)).lowCount).toBe(1)
  })

  it('chỉ lấy điểm của tuần đang xét', async () => {
    await doWeek1([ALL, ALL, ALL, ALL, ALL])
    await submit(6, []) // buổi 6 thuộc tuần 2
    expect((await collectWeekData(db, WEEK1)).scores).toEqual([100, 100, 100, 100, 100])
    expect((await collectWeekData(db, { planId: 1, weekNo: 2 })).scores).toEqual([0])
  })

  it('từ làm sai trong quiz của tuần: gộp theo số buổi làm sai, nhiều nhất trước', async () => {
    // câu → từ: 0 bill, 1 waiter, 2 menu, 3 order, 4 tip, 5 menu, 6 order, 7 waiter
    await submit(1, ALL.filter((i) => i !== 0)) // sai bill
    await submit(2, ALL.filter((i) => ![0, 1].includes(i))) // sai bill, waiter
    await submit(3, ALL.filter((i) => ![0, 1, 4].includes(i))) // sai bill, waiter, tip
    const d = await collectWeekData(db, WEEK1)
    expect(d.weekWords).toEqual([
      { word: 'bill', sessions: 3 },
      { word: 'waiter', sessions: 2 },
      { word: 'tip', sessions: 1 },
    ])
  })

  it('từ sai của tuần khác không lẫn vào', async () => {
    await submit(1, ALL.filter((i) => i !== 0)) // tuần 1: bill
    await submit(6, ALL.filter((i) => i !== 4)) // tuần 2: tip
    expect((await collectWeekData(db, WEEK1)).weekWords.map((w) => w.word)).toEqual(['bill'])
  })

  it('từ hay sai tổng thể (wrong_count) cũng được gửi', async () => {
    await submit(1, ALL.filter((i) => i !== 0))
    await submit(2, ALL.filter((i) => i !== 0))
    expect((await collectWeekData(db, WEEK1)).hardWords).toEqual([{ word: 'bill', wrong: 2 }])
  })

  it('đề bài gửi AI có đủ điểm thấp, từ làm sai trong tuần và từ hay sai', async () => {
    await doWeek1([ALL, [0, 1, 2, 3, 4], [0, 1, 2], [0], []])
    const p = buildPrompt(await collectWeekData(db, WEEK1))
    expect(p).toContain('100%, 63%, 38%, 13%, 0%')
    expect(p).toContain('average 43%')
    expect(p).toContain('4 below 70%')
    expect(p).toMatch(/Words missed in this week's quizzes: .*missed in/)
    expect(p).toContain('Words the learner often gets wrong overall')
    expect(p).toContain('waiter')
  })

  it('không có buổi sai từ nào → ghi rõ "none"', async () => {
    await doWeek1([ALL, ALL])
    expect(buildPrompt(await collectWeekData(db, WEEK1))).toContain("Words missed in this week's quizzes: none.")
  })
})

describe('chuỗi đầy đủ: nộp quiz → hoàn tất tuần → AI nhận điểm thấp → lưu đề xuất', () => {
  it('buổi thứ 5 xong: phát hiện tuần, AI nhận đúng điểm và từ sai thật, đề xuất được lưu', async () => {
    const rights = [ALL, [0, 1, 2, 3, 4], [0, 1, 2], [0, 1], ALL.filter((i) => i !== 1 && i !== 7)] // 100, 63, 38, 25, 75
    for (let i = 0; i < 4; i++) await submit(i + 1, rights[i])
    expect(await findWeeksNeedingReview(db)).toEqual([]) // mới 4 buổi
    expect(prompts).toHaveLength(0) // 4 buổi đầu chưa kích hoạt AI
    adjustReply = { summary_vi: 'Bạn còn yếu từ vựng về nhà hàng.', changes: [{ week_no: 3, topic: 'Review: restaurant words', goal_vi: 'Ôn từ vựng nhà hàng' }] }
    await submit(5, rights[4]) // buổi thứ 5: nộp quiz tự kích hoạt AI (chạy nền)
    expect(await findWeeksNeedingReview(db)).toEqual([]) // đã có đề xuất nên không còn cần xem lại
    expect(await dispatchWeeklyReview(db, await sid(5), async () => {})).toBeNull() // và không kích hoạt lần hai

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('100%, 63%, 38%, 25%, 75%') // điểm thật đã lưu
    expect(prompts[0]).toContain('average 60%')
    expect(prompts[0]).toContain('3 below 70%')
    for (const w of ['waiter', 'menu', 'order', 'tip']) expect(prompts[0]).toContain(w) // câu 0 (bill) luôn đúng nên không có

    const saved = (await db.prepare('SELECT status, summary_vi, changes_json FROM plan_adjustments').first<any>())!
    expect(saved.status).toBe('pending')
    expect(JSON.parse(saved.changes_json)).toEqual([{ week_no: 3, topic: 'Review: restaurant words', goal_vi: 'Ôn từ vựng nhà hàng' }])
  })

  it('điểm cao cả tuần: AI vẫn nhận dữ liệu và có thể không đề xuất đổi gì (no_change)', async () => {
    await doWeek1([ALL, ALL, ALL, ALL, ALL])
    adjustReply = { summary_vi: 'Tuần rất tốt.', changes: [] }
    const adj = await runWeeklyReview(env, WEEK1)
    expect(adj.status).toBe('no_change')
    expect(prompts[0]).toContain('100%, 100%, 100%, 100%, 100%')
    expect(prompts[0]).toContain('0 below 70%')
  })

  it('generateAdjustment dùng dữ liệu hiện có trong CSDL tại thời điểm gọi', async () => {
    await doWeek1([[], [], [], [], []]) // cả tuần 0 điểm
    adjustReply = { summary_vi: 'Cần ôn lại toàn bộ.', changes: [] }
    await generateAdjustment(env, db, WEEK1)
    expect(prompts[0]).toContain('0%, 0%, 0%, 0%, 0%')
    expect(prompts[0]).toContain('5 below 70%')
  })

  it('buổi bị lỡ (không nộp quiz) không có điểm nên không lẫn vào dữ liệu', async () => {
    await doWeek1([ALL, ALL])
    await db.prepare("UPDATE sessions SET status='missed' WHERE seq = 3").run()
    expect((await collectWeekData(db, WEEK1)).scores).toEqual([100, 100])
  })
})
