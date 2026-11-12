import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, todayVN } from './dates'
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
const card = async (word: string) => (await db.prepare('SELECT * FROM vocab WHERE word = ?').bind(word).first<any>())!

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  const ins = (w: string, learned: number, due: string, iv: number, reps: number) =>
    db.prepare("INSERT INTO vocab (word, meaning, due_date, interval_days, reps, learned, created_at) VALUES (?, 'nghĩa', ?, ?, ?, ?, 'x')").bind(w, due, iv, reps, learned).run()
  await ins('due1', 0, TODAY, 1, 1) // đến hạn hôm nay
  await ins('later1', 0, addDays(TODAY, 5), 3, 2) // đang học, chưa đến hạn
  await ins('later2', 0, addDays(TODAY, 9), 6, 3)
  await ins('known1', 1, addDays(TODAY, 40), 30, 6) // đã thuộc, chưa đến hạn
})
afterEach(() => vi.unstubAllGlobals())

describe('ôn tự do — GET /api/flashcards/practice', () => {
  it('lấy được các thẻ CHƯA đến hạn (ôn thường chỉ có 1 thẻ đến hạn)', async () => {
    expect((await json(await call('/api/flashcards/due'))).cards.map((c: any) => c.word)).toEqual(['due1'])
    const r = await json(await call('/api/flashcards/practice?scope=all'))
    expect(r.total_due).toBe(4) // tổng số thẻ trong phạm vi
    expect(r.cards.map((c: any) => c.word).sort()).toEqual(['due1', 'known1', 'later1', 'later2'])
  })

  it('phạm vi: learning = chưa thuộc, learned = đã thuộc; limit giới hạn số thẻ', async () => {
    expect((await json(await call('/api/flashcards/practice?scope=learning'))).cards.map((c: any) => c.word).sort()).toEqual(['due1', 'later1', 'later2'])
    expect((await json(await call('/api/flashcards/practice?scope=learned'))).cards.map((c: any) => c.word)).toEqual(['known1'])
    expect((await json(await call('/api/flashcards/practice?scope=all&limit=2'))).cards).toHaveLength(2)
  })

  it('phạm vi lạ → 400; mặc định là all', async () => {
    expect((await call('/api/flashcards/practice?scope=xyz')).status).toBe(400)
    expect((await json(await call('/api/flashcards/practice'))).total_due).toBe(4)
  })
})

describe('ôn tự do — chấm điểm không phá lịch ôn', () => {
  const review = async (word: string, grade: string, practice?: boolean) =>
    call(`/api/flashcards/${(await card(word)).id}/review`, practice === undefined ? { grade } : { grade, practice })

  it.each(['hard', 'good', 'easy'])('"%s" khi ôn tự do: giữ nguyên lịch ôn', async (grade) => {
    const before = await card('later1')
    const r = await review('later1', grade, true)
    expect(r.status).toBe(200)
    expect(await card('later1')).toEqual(before)
  })

  it('"Quên" khi ôn tự do: thẻ quay lại ôn hôm nay (học lại từ đầu)', async () => {
    expect((await review('known1', 'again', true)).status).toBe(200)
    expect(await card('known1')).toMatchObject({ due_date: TODAY, interval_days: 0, reps: 0, learned: 0 })
    expect((await json(await call('/api/flashcards/due'))).cards.map((c: any) => c.word)).toContain('known1')
  })

  it('ôn thường (không practice): vẫn chấm SRS như cũ', async () => {
    await review('due1', 'good')
    expect((await card('due1')).due_date).not.toBe(TODAY) // đã dời lịch
  })

  it('thẻ không tồn tại → 404', async () => {
    expect((await call('/api/flashcards/99999/review', { grade: 'good', practice: true })).status).toBe(404)
  })
})
