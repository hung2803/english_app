import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, todayVN } from './dates'
import { DAILY_CAP, STREAK_TO_LEARN } from './flashcards'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret-xx'
let env: Env
let db: D1Database
const TODAY = todayVN()

async function call(path: string, body?: unknown) {
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const json = async (r: Response) => (await r.json()) as any
const add = (word: string, o: { due?: string; wrong?: number; lapses?: number; reviewedOn?: string | null; streak?: number; learned?: number; interval?: number; reps?: number } = {}) =>
  db
    .prepare("INSERT INTO vocab (word, meaning, due_date, wrong_count, lapses, reviewed_on, typed_streak, learned, interval_days, reps, created_at) VALUES (?, 'nghĩa', ?, ?, ?, ?, ?, ?, ?, ?, 'x')")
    .bind(word, o.due ?? TODAY, o.wrong ?? 0, o.lapses ?? 0, o.reviewedOn ?? null, o.streak ?? 0, o.learned ?? 0, o.interval ?? 0, o.reps ?? 0)
    .run()
const row = async (word: string) => (await db.prepare('SELECT * FROM vocab WHERE word = ?').bind(word).first<any>())!
const review = async (word: string, body: Record<string, unknown>) => call(`/api/flashcards/${(await row(word)).id}/review`, body)
const dueWords = async (q = '') => (await json(await call('/api/flashcards/due' + q))).cards.map((c: any) => c.word)

beforeEach(() => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('trần số thẻ ôn mỗi ngày', () => {
  it(`${DAILY_CAP} thẻ/ngày: 50 thẻ đến hạn → chỉ ${DAILY_CAP} thẻ cần ôn hôm nay, phần còn lại chờ ngày sau`, async () => {
    for (let i = 0; i < 50; i++) await add('w' + String(i).padStart(2, '0'))
    const r = await json(await call('/api/flashcards/due?limit=50'))
    expect(r.cards).toHaveLength(DAILY_CAP)
    expect(r).toMatchObject({ total_due: DAILY_CAP, backlog: 30, daily_cap: DAILY_CAP, done_today: 0 })
  })

  it('đã ôn xong một số thẻ hôm nay thì phần còn lại trong trần giảm đi; ôn đủ trần → không còn thẻ', async () => {
    for (let i = 0; i < 30; i++) await add('d' + i) // đến hạn
    for (let i = 0; i < 15; i++) await add('done' + i, { due: addDays(TODAY, 3), reviewedOn: TODAY }) // đã ôn xong hôm nay
    let r = await json(await call('/api/flashcards/due?limit=50'))
    expect(r).toMatchObject({ done_today: 15, total_due: 5, backlog: 25 })
    expect(r.cards).toHaveLength(5)
    for (let i = 15; i < 20; i++) await add('done' + i, { due: addDays(TODAY, 3), reviewedOn: TODAY })
    r = await json(await call('/api/flashcards/due?limit=50'))
    expect(r).toMatchObject({ done_today: 20, total_due: 0, backlog: 30, cards: [] })
  })

  it('chấm thẻ: remaining_due đã tính trần; thẻ ôn hôm qua không tính vào hôm nay', async () => {
    for (let i = 0; i < 25; i++) await add('w' + i)
    await add('yesterday', { due: addDays(TODAY, 5), reviewedOn: addDays(TODAY, -1) })
    const r = await json(await review('w0', { grade: 'good' }))
    expect(r.remaining_due).toBe(19) // trần 20, vừa ôn xong 1 thẻ
  })

  it('ôn tự do không tính vào trần và không bị trần chặn', async () => {
    for (let i = 0; i < 40; i++) await add('w' + i, { due: addDays(TODAY, 9) })
    const r = await json(await call('/api/flashcards/practice?scope=all&limit=10'))
    expect(r.cards).toHaveLength(10)
  })

  it('thống kê kho từ vựng có hạn mức hôm nay', async () => {
    for (let i = 0; i < 26; i++) await add('w' + i)
    const { stats } = await json(await call('/api/vocab'))
    expect(stats).toMatchObject({ due: 26, quota: { cap: DAILY_CAP, done: 0, due: 26, shown: DAILY_CAP, backlog: 6 } })
  })
})

describe('ưu tiên thẻ khi ôn', () => {
  it('thứ tự: thẻ vừa bấm Quên hôm nay → thẻ hay sai nhất (sai quiz + quên) → quá hạn lâu nhất', async () => {
    await add('overdue-old', { due: addDays(TODAY, -9) })
    await add('overdue-new', { due: addDays(TODAY, -1) })
    await add('weak', { due: TODAY, wrong: 2, lapses: 1 }) // hay sai: 3
    await add('weaker', { due: TODAY, wrong: 4 }) // hay sai: 4
    await add('retry', { due: TODAY, reviewedOn: TODAY }) // vừa bấm Quên hôm nay
    expect(await dueWords()).toEqual(['retry', 'weaker', 'weak', 'overdue-old', 'overdue-new'])
  })

  it('khi vượt trần, các thẻ ưu tiên được ôn trước, thẻ dễ nhất bị đẩy sang ngày sau', async () => {
    for (let i = 0; i < 25; i++) await add('easy' + String(i).padStart(2, '0'))
    await add('hard1', { wrong: 3 })
    await add('hard2', { lapses: 5 })
    const words = await dueWords('?limit=50')
    expect(words).toHaveLength(DAILY_CAP)
    expect(words.slice(0, 2)).toEqual(['hard2', 'hard1'])
  })

  it('bấm Quên làm tăng độ "hay sai" (lapses) và thẻ ghi nhận đã ôn hôm nay', async () => {
    await add('a', { reps: 3, interval: 8 })
    await review('a', { grade: 'again' })
    expect(await row('a')).toMatchObject({ lapses: 1, reviewed_on: TODAY, due_date: TODAY, interval_days: 0 })
  })
})

describe(`"đã thuộc" khi viết đúng liên tiếp ${STREAK_TO_LEARN} lần`, () => {
  it(`viết đúng + Tốt ${STREAK_TO_LEARN} lần liên tiếp → đã thuộc (dù khoảng cách ôn mới vài ngày)`, async () => {
    await add('menu')
    for (let i = 1; i <= STREAK_TO_LEARN; i++) {
      const r = await json(await review('menu', { grade: 'good', typed: 'menu' }))
      expect(r.next.typed_streak).toBe(i)
      expect(r.next.learned).toBe(i === STREAK_TO_LEARN ? 1 : 0)
    }
    expect(await row('menu')).toMatchObject({ learned: 1, typed_streak: STREAK_TO_LEARN })
    expect((await row('menu')).interval_days).toBeLessThan(21) // khoảng cách ôn vẫn ngắn: nhãn "thuộc" không cần chờ 21 ngày
  })

  it('không phân biệt hoa thường và khoảng trắng thừa khi viết', async () => {
    await add('Menu')
    const r = await json(await review('Menu', { grade: 'easy', typed: '  mENU ' }))
    expect(r.next.typed_streak).toBe(1)
    expect(r.forced_again).toBe(false)
  })

  it('viết SAI: máy chủ ép thành Quên dù gửi mức Dễ; chuỗi về 0, mất nhãn đã thuộc', async () => {
    await add('menu', { streak: 2, learned: 1, interval: 5, reps: 4 })
    const r = await json(await review('menu', { grade: 'easy', typed: 'mnu' }))
    expect(r.forced_again).toBe(true)
    expect(await row('menu')).toMatchObject({ typed_streak: 0, learned: 0, interval_days: 0, reps: 0, lapses: 1, due_date: TODAY })
  })

  it('Khó giữ nguyên chuỗi (không cộng, không xóa); Quên xóa chuỗi', async () => {
    await add('a', { streak: 2 })
    await review('a', { grade: 'hard', typed: 'a' })
    expect((await row('a')).typed_streak).toBe(2)
    await review('a', { grade: 'again', typed: 'a' })
    expect((await row('a')).typed_streak).toBe(0)
  })

  it('không gửi chữ viết (khách cũ): chuỗi không đổi dù chọn Tốt', async () => {
    await add('a', { streak: 1 })
    await review('a', { grade: 'good' })
    expect((await row('a')).typed_streak).toBe(1)
  })

  it('cách cũ vẫn đúng: khoảng cách ôn ≥ 21 ngày thì đã thuộc', async () => {
    await add('a', { interval: 20, reps: 4 })
    const r = await json(await review('a', { grade: 'good', typed: 'a' })) // 20 × 2,5 = 50 ngày
    expect(r.next.learned).toBe(1)
  })

  it('ôn tự do: Khó/Tốt/Dễ không tăng chuỗi; viết sai thì vẫn ép thành Quên', async () => {
    await add('a', { streak: 1, due: addDays(TODAY, 9), interval: 9, reps: 3, learned: 0 })
    await review('a', { grade: 'easy', typed: 'a', practice: true })
    expect((await row('a')).typed_streak).toBe(1)
    const r = await json(await review('a', { grade: 'easy', typed: 'zzz', practice: true }))
    expect(r.forced_again).toBe(true)
    expect(await row('a')).toMatchObject({ typed_streak: 0, due_date: TODAY })
  })

  it('làm sai câu quiz có từ đó: về hàng ôn, chuỗi về 0', async () => {
    // mô phỏng đúng câu UPDATE của submitQuiz
    await add('a', { streak: 2, learned: 1, interval: 30, reps: 5 })
    await db.prepare('UPDATE vocab SET due_date = ?, interval_days = 0, reps = 0, learned = 0, typed_streak = 0 WHERE lower(word) = lower(?)').bind(TODAY, 'a').run()
    expect(await row('a')).toMatchObject({ typed_streak: 0, learned: 0 })
  })
})
