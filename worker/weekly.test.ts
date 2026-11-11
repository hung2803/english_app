import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { createTestDb } from './test-db'
import { detectWeekCompleted, dispatchWeeklyReview, findWeeksNeedingReview } from './weekly'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  const r = await app.request('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: '{}' }, env)
  expect(r.status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

const done = (...seqs: number[]) =>
  db.batch(seqs.map((n) => db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=?").bind(todayVN(), n)))
const idOf = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq=?').bind(seq).first<{ id: number }>())!.id
const addAdjustment = (week: number) =>
  db.prepare("INSERT INTO plan_adjustments (plan_id, week_no, summary_vi, changes_json, created_at) VALUES (1, ?, 's', '[]', ?)").bind(week, todayVN()).run()

describe('phát hiện buổi thứ 5 của tuần vừa xong', () => {
  it('buổi 1–4 xong: chưa kích hoạt', async () => {
    for (let seq = 1; seq <= 4; seq++) {
      await done(seq)
      expect(await detectWeekCompleted(db, await idOf(seq))).toBeNull()
    }
  })
  it('buổi thứ 5 của tuần 1 xong → kích hoạt đúng tuần 1', async () => {
    await done(1, 2, 3, 4)
    await done(5)
    expect(await detectWeekCompleted(db, await idOf(5))).toEqual({ planId: 1, weekNo: 1 })
  })
  it('đúng cho các tuần khác: buổi 10 → tuần 2, buổi 35 → tuần 7', async () => {
    await done(...Array.from({ length: 10 }, (_, i) => i + 1))
    await addAdjustment(1) // tuần 1 đã có đề xuất
    expect(await detectWeekCompleted(db, await idOf(10))).toEqual({ planId: 1, weekNo: 2 })
    await done(...Array.from({ length: 25 }, (_, i) => i + 11))
    await addAdjustment(2)
    for (let w = 3; w <= 6; w++) await addAdjustment(w)
    expect(await detectWeekCompleted(db, await idOf(35))).toEqual({ planId: 1, weekNo: 7 })
  })
  it('buổi giữa tuần (2,3,4) xong thì không kích hoạt, kể cả khi buổi 5 chưa xong', async () => {
    await done(1, 2, 3)
    expect(await detectWeekCompleted(db, await idOf(3))).toBeNull()
  })
  it('tuần còn buổi bị lỡ / chưa học thì chưa kích hoạt', async () => {
    await done(1, 2, 3, 5) // thiếu buổi 4 (chưa học)
    expect(await detectWeekCompleted(db, await idOf(5))).toBeNull()
    await db.prepare("UPDATE sessions SET status='missed' WHERE seq=4").run()
    expect(await detectWeekCompleted(db, await idOf(5))).toBeNull()
    await done(4)
    expect(await detectWeekCompleted(db, await idOf(4))).toEqual({ planId: 1, weekNo: 1 })
  })
  it('buổi chưa đánh dấu xong hoặc không tồn tại → null', async () => {
    await done(1, 2, 3, 4)
    expect(await detectWeekCompleted(db, await idOf(5))).toBeNull()
    expect(await detectWeekCompleted(db, 99999)).toBeNull()
  })
  it('đã có đề xuất cho tuần đó → không kích hoạt lần nữa', async () => {
    await done(1, 2, 3, 4, 5)
    expect(await detectWeekCompleted(db, await idOf(5))).not.toBeNull()
    await addAdjustment(1)
    expect(await detectWeekCompleted(db, await idOf(5))).toBeNull()
  })
  it('tuần cuối của lộ trình (không còn tuần sau để điều chỉnh) → không kích hoạt', async () => {
    await db.prepare("UPDATE sessions SET status='done' WHERE week_no <= 11").run()
    await done(56, 57, 58, 59, 60)
    expect(await detectWeekCompleted(db, await idOf(60))).toBeNull()
  })
  it('tuần 11 xong, tuần 12 còn buổi → vẫn kích hoạt (còn tuần để điều chỉnh)', async () => {
    await db.prepare("UPDATE sessions SET status='done' WHERE week_no <= 11").run()
    for (let w = 1; w <= 10; w++) await addAdjustment(w)
    expect(await detectWeekCompleted(db, await idOf(55))).toEqual({ planId: 1, weekNo: 11 })
  })
  it('lộ trình đã lưu trữ thì không kích hoạt', async () => {
    await done(1, 2, 3, 4, 5)
    await db.prepare("UPDATE plans SET status='archived'").run()
    expect(await detectWeekCompleted(db, await idOf(5))).toBeNull()
  })
})

describe('findWeeksNeedingReview (thử lại khi AI lỗi)', () => {
  it('chưa xong tuần nào → rỗng', async () => {
    expect(await findWeeksNeedingReview(db)).toEqual([])
  })
  it('chỉ trả tuần xong MỚI NHẤT chưa có đề xuất', async () => {
    await done(...Array.from({ length: 15 }, (_, i) => i + 1)) // tuần 1, 2, 3 xong
    expect(await findWeeksNeedingReview(db)).toEqual([{ planId: 1, weekNo: 3 }])
  })
  it('tuần mới nhất đã có đề xuất → rỗng (không quay lại tuần cũ)', async () => {
    await done(...Array.from({ length: 10 }, (_, i) => i + 1))
    await addAdjustment(2)
    expect(await findWeeksNeedingReview(db)).toEqual([])
  })
})

describe('dispatchWeeklyReview', () => {
  it('buổi thứ 5 xong → gọi AI đúng một lần với đúng tuần', async () => {
    const run = vi.fn(async () => {})
    await done(1, 2, 3, 4)
    expect(await dispatchWeeklyReview(db, await idOf(4), run)).toBeNull()
    expect(run).not.toHaveBeenCalled()
    await done(5)
    expect(await dispatchWeeklyReview(db, await idOf(5), run)).toEqual({ planId: 1, weekNo: 1 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ planId: 1, weekNo: 1 })
  })
  it('AI lỗi không làm hỏng việc nộp bài; tuần vẫn còn trong danh sách thử lại', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await done(1, 2, 3, 4, 5)
    const run = vi.fn(async () => {
      throw new Error('AI từ chối')
    })
    await expect(dispatchWeeklyReview(db, await idOf(5), run)).resolves.toEqual({ planId: 1, weekNo: 1 })
    expect(spy).toHaveBeenCalled()
    expect(await findWeeksNeedingReview(db)).toEqual([{ planId: 1, weekNo: 1 }])
    spy.mockRestore()
  })
  it('buổi không hoàn tất tuần → không gọi AI', async () => {
    const run = vi.fn(async () => {})
    await done(1, 2)
    await dispatchWeeklyReview(db, await idOf(2), run)
    expect(run).not.toHaveBeenCalled()
  })
})
