import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, todayVN } from './dates'
import { wrongWords, type GradedItem, type QuizItem } from './quiz'
import { submitQuiz } from './session-store'
import { lessonJson } from './test-fixtures'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database
const LESSON = lessonJson()
const QUIZ = LESSON.quiz as QuizItem[]
// câu → từ liên quan: 0 bill, 1 waiter, 2 menu, 3 order, 4 tip, 5 menu, 6 order, 7 waiter
const wrongOf = (q: QuizItem) => (q.type === 'mcq' ? ((q.answer as number) + 1) % 4 : 'definitely wrong')
/** Làm đúng các câu có chỉ số trong `right`, sai các câu còn lại. */
const answers = (right: number[]) => QUIZ.map((q, i) => (right.includes(i) ? (q.answer as number | string) : wrongOf(q)))
const ALL = [0, 1, 2, 3, 4, 5, 6, 7]

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
  await db.prepare('UPDATE sessions SET lesson_json = ? WHERE seq IN (1, 2)').bind(JSON.stringify(LESSON)).run()
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown) {
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq = 1) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const submit = async (a: unknown, seq = 1) => call(`/api/sessions/${await sid(seq)}/quiz`, { answers: a })
const vocab = async () => (await db.prepare('SELECT * FROM vocab ORDER BY lower(word)').all<any>()).results
const word = async (w: string) => (await db.prepare('SELECT * FROM vocab WHERE lower(word) = lower(?)').bind(w).first<any>())
const TODAY = todayVN()
/** Từ đang "đã thuộc", hẹn ôn 30 ngày nữa */
const seedMastered = (w: string, extra: Record<string, unknown> = {}) =>
  db.prepare("INSERT INTO vocab (word, meaning, due_date, interval_days, ease, reps, learned, wrong_count, created_at) VALUES (?, 'nghĩa', ?, 30, 2.5, 5, 1, 0, '2026-01-01')").bind(w, addDays(TODAY, 30)).run().then(() => extra)

describe('wrongWords', () => {
  const it_ = (index: number, correct: boolean, word?: string) => ({ index, correct, ...(word ? { word } : {}) }) as GradedItem
  it('chỉ lấy từ của câu sai, không trùng (không phân biệt hoa thường), đúng thứ tự', () => {
    const r = wrongWords({ items: [it_(0, false, 'bill'), it_(1, true, 'menu'), it_(2, false, 'Bill'), it_(3, false, 'order'), it_(4, false)] })
    expect(r).toEqual(['bill', 'order'])
  })
  it('đúng hết hoặc không có từ → rỗng', () => {
    expect(wrongWords({ items: [it_(0, true, 'bill')] })).toEqual([])
    expect(wrongWords({ items: [] })).toEqual([])
  })
})

describe('câu sai → từ liên quan vào hàng ôn ngay', () => {
  it('từ chưa có trong kho: được thêm, đến hạn HÔM NAY, gắn với buổi học, ghi nhận 1 lần sai', async () => {
    await submit(answers(ALL.filter((i) => i !== 0))) // sai câu 0 → "bill"
    const rows = await vocab()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ word: 'bill', meaning: 'hóa đơn', pos: 'noun', example: 'The bill, please.', due_date: TODAY, interval_days: 0, reps: 0, learned: 0, wrong_count: 1, session_id: await sid(1), created_at: TODAY })
  })

  it('từ đã có và đang "đã thuộc": bị đặt lại như bấm Quên — đến hạn hôm nay, học lại từ đầu, giảm độ dễ, +1 lần sai', async () => {
    await seedMastered('bill')
    await submit(answers(ALL.filter((i) => i !== 0)))
    expect(await word('bill')).toMatchObject({ due_date: TODAY, interval_days: 0, reps: 0, learned: 0, ease: 2.3, wrong_count: 1 })
    expect(await vocab()).toHaveLength(1) // không tạo bản trùng
  })

  it('độ dễ không giảm dưới 1.3', async () => {
    await db.prepare("INSERT INTO vocab (word, meaning, due_date, ease, created_at) VALUES ('bill', 'x', ?, 1.35, '2026-01-01')").bind(addDays(TODAY, 5)).run()
    await submit(answers(ALL.filter((i) => i !== 0)))
    expect((await word('bill')).ease).toBe(1.3)
  })

  it('so khớp không phân biệt hoa thường với từ đã có', async () => {
    await seedMastered('Bill')
    await submit(answers(ALL.filter((i) => i !== 0)))
    expect(await vocab()).toHaveLength(1)
    expect((await word('bill')).due_date).toBe(TODAY)
  })

  it('câu ĐÚNG không đụng tới từ vựng, kể cả từ đã có', async () => {
    await seedMastered('menu')
    await submit(answers(ALL.filter((i) => i !== 0))) // chỉ sai "bill"
    expect(await word('menu')).toMatchObject({ due_date: addDays(TODAY, 30), interval_days: 30, learned: 1, wrong_count: 0 })
    expect((await vocab()).map((v) => v.word)).toEqual(['bill', 'menu']) // menu chỉ có vì đã được tạo sẵn ở trên
  })

  it('đúng hết: không thêm, không đổi gì trong kho từ vựng', async () => {
    await seedMastered('bill')
    const before = await vocab()
    const { result } = await json(await submit(answers(ALL)))
    expect(await vocab()).toEqual(before)
    expect(result.review_words).toEqual([])
  })

  it('nhiều câu sai: mỗi từ liên quan một dòng; trả danh sách từ cần ôn', async () => {
    const { result } = await json(await submit(answers([2, 4, 5]))) // sai câu 0,1,3,6,7 → bill, waiter, order (order 2 câu, waiter 2 câu)
    expect(result.review_words).toEqual(['bill', 'waiter', 'order'])
    expect((await vocab()).map((v) => v.word)).toEqual(['bill', 'order', 'waiter'])
  })

  it('hai câu sai cùng một từ: một dòng, wrong_count chỉ +1 cho mỗi lần nộp (đếm số buổi làm sai từ đó)', async () => {
    await submit(answers(ALL.filter((i) => i !== 3 && i !== 6))) // sai 2 câu về "order"
    expect(await vocab()).toHaveLength(1)
    expect(await word('order')).toMatchObject({ wrong_count: 1 })
  })

  it('bỏ trống (null) tính là sai nên từ liên quan cũng vào hàng ôn', async () => {
    const a = QUIZ.map((q, i) => (i === 0 ? null : (q.answer as number | string)))
    await submit(a)
    expect((await vocab()).map((v) => v.word)).toEqual(['bill'])
  })

  it('câu sai không có từ liên quan: bỏ qua, không lỗi', async () => {
    const noWord = { ...LESSON, quiz: QUIZ.map((q, i) => (i === 0 ? { ...q, word: undefined } : q)) }
    await db.prepare('UPDATE sessions SET lesson_json = ? WHERE seq = 1').bind(JSON.stringify(noWord)).run()
    const r = await submit(answers(ALL.filter((i) => i !== 0)))
    expect(r.status).toBe(200)
    expect(await vocab()).toEqual([])
  })

  it('từ liên quan không có trong từ vựng của bài: bỏ qua (không bịa dòng)', async () => {
    const odd = { ...LESSON, quiz: QUIZ.map((q, i) => (i === 0 ? { ...q, word: 'notinlesson' } : q)) }
    await db.prepare('UPDATE sessions SET lesson_json = ? WHERE seq = 1').bind(JSON.stringify(odd)).run()
    await submit(answers(ALL.filter((i) => i !== 0)))
    expect(await vocab()).toEqual([])
  })

  it('kết quả trả về và lưu trong buổi học có danh sách từ cần ôn (xem lại được)', async () => {
    await submit(answers(ALL.filter((i) => i !== 0)))
    const { session } = await json(await call(`/api/sessions/${await sid(1)}`))
    expect(session.result.review_words).toEqual(['bill'])
  })

  it('điểm thấp (< 70%) vẫn xong buổi VÀ vào hàng ôn tất cả từ làm sai', async () => {
    const { result } = await json(await submit(answers([0])))
    expect(result.passed).toBe(false)
    expect((await db.prepare("SELECT status FROM sessions WHERE seq = 1").first<any>()).status).toBe('done')
    expect((await vocab()).map((v) => v.word)).toEqual(['menu', 'order', 'tip', 'waiter']) // sai các câu về menu, order, tip, waiter; câu về bill đúng
  })
})

describe('chỉ khi nộp THÀNH CÔNG mới đụng tới từ vựng', () => {
  it('nộp lại lần hai (409): không thêm/không đổi từ nào', async () => {
    await submit(answers(ALL.filter((i) => i !== 0)))
    const after1 = await vocab()
    await submit(QUIZ.map(wrongOf)) // lần hai bị từ chối
    expect(await vocab()).toEqual(after1)
  })

  it('câu trả lời không hợp lệ (400): không đụng tới từ vựng', async () => {
    await seedMastered('bill')
    const before = await vocab()
    expect((await submit([1, 2, 3])).status).toBe(400)
    expect(await vocab()).toEqual(before)
  })

  it('buổi chưa có bài / không tồn tại: không đụng tới từ vựng', async () => {
    expect((await submit([], 3)).status).toBe(409)
    expect((await call('/api/sessions/99999/quiz', { answers: [] })).status).toBe(404)
    expect(await vocab()).toEqual([])
  })

  it('hai lần nộp đồng thời: từ vựng chỉ bị đặt lại MỘT lần (wrong_count = 1)', async () => {
    const [a, b] = await Promise.all([submit(answers(ALL.filter((i) => i !== 0))), submit(answers(ALL.filter((i) => i !== 0)))])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(await word('bill')).toMatchObject({ wrong_count: 1 })
    expect(await vocab()).toHaveLength(1)
  })

  it('lỗi giữa chừng khi ghi → không có gì được lưu (buổi vẫn chưa xong, từ vựng nguyên vẹn)', async () => {
    await seedMastered('bill')
    const before = await vocab()
    const real = db
    const broken = Object.assign(Object.create(real), {
      batch: async (stmts: D1PreparedStatement[]) => real.batch([...stmts, real.prepare("INSERT INTO vocab (word, meaning, due_date, created_at) VALUES ('bill', 'dup', 'x', 'x')")]), // trùng từ → lỗi
    }) as D1Database
    await expect(submitQuiz(broken, await sid(1), answers(ALL.filter((i) => i !== 0)), TODAY)).rejects.toThrow()
    expect(await vocab()).toEqual(before)
    expect((await db.prepare('SELECT status, score, result_json FROM sessions WHERE seq = 1').first<any>())).toEqual({ status: 'pending', score: null, result_json: null })
  })
})

describe('ôn lại các từ qua nhiều buổi', () => {
  it('từ sai ở buổi 1 rồi sai tiếp ở buổi 2 → wrong_count cộng dồn; từ làm đúng giữ nguyên', async () => {
    await submit(answers(ALL.filter((i) => i !== 0)), 1)
    await submit(answers(ALL.filter((i) => i !== 0)), 2)
    expect(await word('bill')).toMatchObject({ wrong_count: 2, due_date: TODAY, session_id: await sid(1) }) // giữ buổi đầu tiên đã thêm từ
  })

  it('từ sai vào hàng ôn nhưng đã ôn tốt (lịch hẹn xa) rồi làm sai lần nữa → lại đến hạn hôm nay', async () => {
    await submit(answers(ALL.filter((i) => i !== 0)), 1)
    await db.prepare("UPDATE vocab SET due_date = ?, interval_days = 8, reps = 3, learned = 0 WHERE word = 'bill'").bind(addDays(TODAY, 8)).run()
    await submit(answers(ALL.filter((i) => i !== 0)), 2)
    expect(await word('bill')).toMatchObject({ due_date: TODAY, interval_days: 0, reps: 0 })
  })

  it('các từ chỉ đến hạn khi sai: từ làm đúng không bị kéo vào hàng ôn hôm nay', async () => {
    await submit(answers(ALL.filter((i) => i !== 0)))
    const due = (await db.prepare('SELECT word FROM vocab WHERE due_date <= ?').bind(TODAY).all<any>()).results.map((r) => r.word)
    expect(due).toEqual(['bill'])
  })
})
