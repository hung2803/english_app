import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { decideAdjustment, getAdjustment, listAdjustments, runWeeklyReview, saveProposal } from './adjustment-store'
import type { Proposal } from './adjustment'
import { createTestDb } from './test-db'
import { dispatchWeeklyReview, findWeeksNeedingReview } from './weekly'
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

const CHANGES = [
  { week_no: 3, topic: 'Review: connectors', goal_vi: 'Ôn từ nối' },
  { week_no: 4, topic: 'Past tense practice', goal_vi: 'Luyện thì quá khứ' },
]
const proposal = (week_no = 1, changes = CHANGES): Proposal => ({ week_no, summary_vi: 'Tuần này còn yếu từ nối.', changes })
const aiReply = (obj: unknown) =>
  vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }))
const finishWeek = (week: number) =>
  db.prepare("UPDATE sessions SET status='done', score=60, completed_date=? WHERE week_no=?").bind(todayVN(), week).run()

describe('lưu đề xuất', () => {
  it('có thay đổi → pending, chưa có ngày quyết định, lưu đúng nội dung', async () => {
    const { created, adjustment } = await saveProposal(db, 1, proposal())
    expect(created).toBe(true)
    expect(adjustment).toMatchObject({
      plan_id: 1, week_no: 1, status: 'pending', summary_vi: 'Tuần này còn yếu từ nối.',
      created_at: todayVN(), decided_at: null, emailed_at: null,
    })
    expect(adjustment.changes).toEqual(CHANGES) // JSON khứ hồi nguyên vẹn, kể cả tiếng Việt
  })
  it('không có thay đổi → no_change, đã chốt ngay, không cần duyệt', async () => {
    const { adjustment } = await saveProposal(db, 1, proposal(1, []))
    expect(adjustment).toMatchObject({ status: 'no_change', changes: [], decided_at: todayVN() })
  })
  it('mỗi tuần chỉ một đề xuất: lưu lần 2 KHÔNG ghi đè, created=false', async () => {
    const first = await saveProposal(db, 1, proposal())
    const second = await saveProposal(db, 1, { ...proposal(), summary_vi: 'Nội dung khác', changes: [] })
    expect(second.created).toBe(false)
    expect(second.adjustment.id).toBe(first.adjustment.id)
    expect(second.adjustment.summary_vi).toBe('Tuần này còn yếu từ nối.')
    expect(second.adjustment.status).toBe('pending')
    expect((await db.prepare('SELECT COUNT(*) n FROM plan_adjustments').first<{ n: number }>())!.n).toBe(1)
  })
  it('các tuần khác nhau lưu riêng', async () => {
    await saveProposal(db, 1, proposal(1))
    await saveProposal(db, 1, proposal(2))
    expect((await db.prepare('SELECT COUNT(*) n FROM plan_adjustments').first<{ n: number }>())!.n).toBe(2)
  })
  it('CSDL chỉ chấp nhận 4 trạng thái hợp lệ', async () => {
    for (const ok of ['pending', 'approved', 'rejected', 'no_change']) {
      await db.prepare("INSERT INTO plan_adjustments (plan_id, week_no, summary_vi, changes_json, status, created_at) VALUES (1, ?, 's', '[]', ?, ?)")
        .bind(100 + ['pending', 'approved', 'rejected', 'no_change'].indexOf(ok), ok, todayVN()).run()
    }
    await expect(
      db.prepare("INSERT INTO plan_adjustments (plan_id, week_no, summary_vi, changes_json, status, created_at) VALUES (1, 200, 's', '[]', 'weird', ?)").bind(todayVN()).run(),
    ).rejects.toThrow()
  })
  it('xóa lộ trình thì đề xuất đi theo (ON DELETE CASCADE)', async () => {
    await saveProposal(db, 1, proposal())
    await db.prepare('DELETE FROM plans WHERE id = 1').run()
    expect((await db.prepare('SELECT COUNT(*) n FROM plan_adjustments').first<{ n: number }>())!.n).toBe(0)
  })
})

describe('trạng thái: chờ duyệt → đã duyệt / bỏ qua', () => {
  it('duyệt: pending → approved, ghi ngày quyết định', async () => {
    const { adjustment } = await saveProposal(db, 1, proposal())
    const r = await decideAdjustment(db, adjustment.id, 'approved', '2026-11-20')
    expect(r).toMatchObject({ ok: true, adjustment: { status: 'approved', decided_at: '2026-11-20' } })
    expect((await getAdjustment(db, adjustment.id))!.status).toBe('approved')
  })
  it('bỏ qua: pending → rejected', async () => {
    const { adjustment } = await saveProposal(db, 1, proposal())
    expect(await decideAdjustment(db, adjustment.id, 'rejected')).toMatchObject({ ok: true, adjustment: { status: 'rejected' } })
  })
  it('quyết định là cuối cùng: không đổi từ approved/rejected sang cái khác', async () => {
    const a = (await saveProposal(db, 1, proposal(1))).adjustment
    await decideAdjustment(db, a.id, 'approved')
    expect(await decideAdjustment(db, a.id, 'rejected')).toEqual({ ok: false, reason: 'already_decided' })
    expect(await decideAdjustment(db, a.id, 'approved')).toEqual({ ok: false, reason: 'already_decided' })
    expect((await getAdjustment(db, a.id))!.status).toBe('approved')

    const b = (await saveProposal(db, 1, proposal(2))).adjustment
    await decideAdjustment(db, b.id, 'rejected')
    expect(await decideAdjustment(db, b.id, 'approved')).toEqual({ ok: false, reason: 'already_decided' })
    expect((await getAdjustment(db, b.id))!.status).toBe('rejected')
  })
  it('no_change không quyết định được; id không tồn tại → not_found', async () => {
    const a = (await saveProposal(db, 1, proposal(1, []))).adjustment
    expect(await decideAdjustment(db, a.id, 'approved')).toEqual({ ok: false, reason: 'already_decided' })
    expect(await decideAdjustment(db, 99999, 'approved')).toEqual({ ok: false, reason: 'not_found' })
  })
  it('lưu rồi chờ duyệt thì ngày quyết định để trống cho tới khi quyết định', async () => {
    const a = (await saveProposal(db, 1, proposal())).adjustment
    expect(a.decided_at).toBeNull()
  })
})

describe('liệt kê đề xuất', () => {
  it('lọc theo trạng thái, mới nhất (tuần lớn nhất) trước', async () => {
    const a = (await saveProposal(db, 1, proposal(1))).adjustment
    await saveProposal(db, 1, proposal(2))
    await saveProposal(db, 1, proposal(3, []))
    await decideAdjustment(db, a.id, 'approved')
    expect((await listAdjustments(db)).map((x) => x.week_no)).toEqual([3, 2, 1])
    expect((await listAdjustments(db, 'pending')).map((x) => x.week_no)).toEqual([2])
    expect((await listAdjustments(db, 'approved')).map((x) => x.week_no)).toEqual([1])
    expect((await listAdjustments(db, 'rejected'))).toEqual([])
    expect((await listAdjustments(db, 'no_change')).map((x) => x.week_no)).toEqual([3])
  })
  it('không lẫn đề xuất của lộ trình đã lưu trữ', async () => {
    await saveProposal(db, 1, proposal(1))
    await db.prepare("UPDATE plans SET status = 'archived'").run()
    expect(await listAdjustments(db)).toEqual([])
  })
})

describe('runWeeklyReview: AI → lưu', () => {
  it('AI đề xuất thay đổi → lưu pending', async () => {
    await finishWeek(1)
    vi.stubGlobal('fetch', aiReply({ summary_vi: 'Cần ôn từ nối.', changes: [{ week_no: 3, topic: 'Review: connectors', goal_vi: 'Ôn từ nối' }] }))
    const adj = await runWeeklyReview(env, { planId: 1, weekNo: 1 })
    expect(adj).toMatchObject({ status: 'pending', week_no: 1, changes: [{ week_no: 3, topic: 'Review: connectors', goal_vi: 'Ôn từ nối' }] })
  })
  it('AI thấy không cần đổi → lưu no_change (vẫn có tóm tắt tuần)', async () => {
    await finishWeek(1)
    vi.stubGlobal('fetch', aiReply({ summary_vi: 'Tuần rất tốt.', changes: [] }))
    expect(await runWeeklyReview(env, { planId: 1, weekNo: 1 })).toMatchObject({ status: 'no_change', summary_vi: 'Tuần rất tốt.' })
  })
  it('AI lỗi → ném lỗi, KHÔNG lưu gì', async () => {
    await finishWeek(1)
    await expect(runWeeklyReview(env, { planId: 1, weekNo: 1 })).rejects.toMatchObject({ kind: 'rate' })
    expect((await db.prepare('SELECT COUNT(*) n FROM plan_adjustments').first<{ n: number }>())!.n).toBe(0)
  })
  it('lưu xong thì tuần không còn trong danh sách cần xem lại (không kích hoạt lại)', async () => {
    await finishWeek(1)
    expect(await findWeeksNeedingReview(db)).toEqual([{ planId: 1, weekNo: 1 }])
    vi.stubGlobal('fetch', aiReply({ summary_vi: 'ok', changes: [] }))
    await runWeeklyReview(env, { planId: 1, weekNo: 1 })
    expect(await findWeeksNeedingReview(db)).toEqual([])
  })
  it('nối với dispatchWeeklyReview: buổi thứ 5 xong → AI chạy → lưu; lần gọi lại không tạo thêm', async () => {
    await finishWeek(1)
    const sessionId = (await db.prepare('SELECT id FROM sessions WHERE seq = 5').first<{ id: number }>())!.id
    const fn = aiReply({ summary_vi: 'Cần ôn.', changes: [{ week_no: 2, topic: 'Review week', goal_vi: 'Ôn lại' }] })
    vi.stubGlobal('fetch', fn)
    const run = (w: { planId: number; weekNo: number }) => runWeeklyReview(env, w).then(() => {})
    expect(await dispatchWeeklyReview(db, sessionId, run)).toEqual({ planId: 1, weekNo: 1 })
    expect(await dispatchWeeklyReview(db, sessionId, run)).toBeNull() // đã có đề xuất
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await listAdjustments(db, 'pending')).map((a) => a.week_no)).toEqual([1])
  })
  it('AI lỗi qua dispatch: bài nộp không hỏng, lần sau còn thử lại được', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await finishWeek(1)
    const sessionId = (await db.prepare('SELECT id FROM sessions WHERE seq = 5').first<{ id: number }>())!.id
    const run = (w: { planId: number; weekNo: number }) => runWeeklyReview(env, w).then(() => {})
    await expect(dispatchWeeklyReview(db, sessionId, run)).resolves.toEqual({ planId: 1, weekNo: 1 })
    expect(await listAdjustments(db)).toEqual([])
    vi.stubGlobal('fetch', aiReply({ summary_vi: 'ok', changes: [] })) // AI hồi phục
    await dispatchWeeklyReview(db, sessionId, run)
    expect((await listAdjustments(db)).map((a) => a.status)).toEqual(['no_change'])
    spy.mockRestore()
  })
})
