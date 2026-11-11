import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { approveAdjustment, saveProposal } from './adjustment-store'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown, authed = true) {
  return app.request(
    path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}
const json = async (r: Response) => (await r.json()) as any
const topicOf = async (week: number) => (await db.prepare('SELECT topic, goal_vi FROM plan_weeks WHERE plan_id = 1 AND week_no = ?').bind(week).first<{ topic: string; goal_vi: string }>())!
const CHANGES = [
  { week_no: 3, topic: 'Review: connectors', goal_vi: 'Ôn từ nối' },
  { week_no: 4, topic: 'Past tense practice', goal_vi: 'Luyện thì quá khứ' },
]
const seed = (week = 1, changes = CHANGES) => saveProposal(db, 1, { week_no: week, summary_vi: 'Cần ôn từ nối.', changes })
const startWeek = (week: number) => db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE week_no=? AND seq = (SELECT MIN(seq) FROM sessions WHERE week_no=?)").bind(todayVN(), week, week).run()

describe('xem đề xuất', () => {
  it('cần đăng nhập', async () => {
    for (const p of ['/api/adjustments', '/api/adjustments/1']) expect((await call(p, undefined, false)).status).toBe(401)
    expect((await call('/api/adjustments/1/approve', {}, false)).status).toBe(401)
    expect((await call('/api/adjustments/1/reject', {}, false)).status).toBe(401)
  })
  it('chưa có đề xuất → rỗng', async () => {
    expect(await json(await call('/api/adjustments'))).toEqual({ adjustments: [] })
  })
  it('danh sách kèm chủ đề hiện tại để so sánh cũ → mới', async () => {
    await seed()
    const oldTopic3 = (await topicOf(3)).topic
    const { adjustments } = await json(await call('/api/adjustments'))
    expect(adjustments).toHaveLength(1)
    expect(adjustments[0]).toMatchObject({ week_no: 1, status: 'pending', summary_vi: 'Cần ôn từ nối.' })
    expect(adjustments[0].changes[0]).toMatchObject({ week_no: 3, topic: 'Review: connectors', current_topic: oldTopic3, can_apply: true })
  })
  it('lọc theo trạng thái; trạng thái lạ → 400', async () => {
    await seed(1)
    await seed(2, [])
    expect((await json(await call('/api/adjustments?status=pending'))).adjustments.map((a: any) => a.week_no)).toEqual([1])
    expect((await json(await call('/api/adjustments?status=no_change'))).adjustments.map((a: any) => a.week_no)).toEqual([2])
    expect((await call('/api/adjustments?status=weird')).status).toBe(400)
  })
  it('xem một đề xuất; id không có → 404', async () => {
    const { adjustment } = await seed()
    expect((await json(await call(`/api/adjustments/${adjustment.id}`))).adjustment.id).toBe(adjustment.id)
    expect((await call('/api/adjustments/9999')).status).toBe(404)
  })
  it('GET /api/plan báo số đề xuất đang chờ duyệt', async () => {
    expect((await json(await call('/api/plan'))).plan.pending_adjustments).toBe(0)
    await seed(1)
    await seed(2, [])
    expect((await json(await call('/api/plan'))).plan.pending_adjustments).toBe(1)
  })
})

describe('duyệt = áp dụng vào lộ trình', () => {
  it('duyệt → đổi chủ đề đúng các tuần, trạng thái approved', async () => {
    const { adjustment } = await seed()
    const before = [await topicOf(2), await topicOf(3), await topicOf(4), await topicOf(5)]
    const r = await call(`/api/adjustments/${adjustment.id}/approve`, {})
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(body).toMatchObject({ applied: [3, 4], skipped: [], adjustment: { status: 'approved', decided_at: todayVN() } })
    expect(await topicOf(3)).toEqual({ topic: 'Review: connectors', goal_vi: 'Ôn từ nối' })
    expect(await topicOf(4)).toEqual({ topic: 'Past tense practice', goal_vi: 'Luyện thì quá khứ' })
    // các tuần khác không đụng tới
    expect(await topicOf(2)).toEqual(before[0])
    expect(await topicOf(5)).toEqual(before[3])
    expect(before[1].topic).not.toBe('Review: connectors')
  })
  it('chỉ đổi chủ đề, KHÔNG đụng tới các buổi học/lịch', async () => {
    const { adjustment } = await seed()
    const sessions = async () => (await db.prepare('SELECT id, seq, week_no, scheduled_date, status FROM sessions ORDER BY seq').all()).results
    const before = await sessions()
    await call(`/api/adjustments/${adjustment.id}/approve`, {})
    expect(await sessions()).toEqual(before)
  })
  it('tuần đã bắt đầu học (có buổi xong) thì bỏ qua, báo trong skipped', async () => {
    const { adjustment } = await seed()
    await startWeek(3)
    const old3 = await topicOf(3)
    const body = await json(await call(`/api/adjustments/${adjustment.id}/approve`, {}))
    expect(body).toMatchObject({ applied: [4], skipped: [3] })
    expect(await topicOf(3)).toEqual(old3) // giữ nguyên
    expect((await topicOf(4)).topic).toBe('Past tense practice')
  })
  it('không duyệt lại được: 409, không áp dụng lần hai', async () => {
    const { adjustment } = await seed()
    await call(`/api/adjustments/${adjustment.id}/approve`, {})
    await db.prepare("UPDATE plan_weeks SET topic = 'Người học tự sửa' WHERE week_no = 3").run()
    const r = await call(`/api/adjustments/${adjustment.id}/approve`, {})
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('already_decided')
    expect((await topicOf(3)).topic).toBe('Người học tự sửa')
  })
  it('đã bỏ qua thì không duyệt được nữa', async () => {
    const { adjustment } = await seed()
    await call(`/api/adjustments/${adjustment.id}/reject`, {})
    expect((await call(`/api/adjustments/${adjustment.id}/approve`, {})).status).toBe(409)
  })
  it('đề xuất no_change và id lạ không duyệt được', async () => {
    const { adjustment } = await seed(1, [])
    expect((await call(`/api/adjustments/${adjustment.id}/approve`, {})).status).toBe(409)
    expect((await call('/api/adjustments/9999/approve', {})).status).toBe(404)
  })
  it('lộ trình đã lưu trữ → 409 plan_inactive, không đổi gì', async () => {
    const { adjustment } = await seed()
    await db.prepare("UPDATE plans SET status = 'archived'").run()
    const old3 = await topicOf(3)
    const r = await call(`/api/adjustments/${adjustment.id}/approve`, {})
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('plan_inactive')
    expect(await topicOf(3)).toEqual(old3)
    expect((await db.prepare('SELECT status FROM plan_adjustments').first<{ status: string }>())!.status).toBe('pending')
  })
  it('lỗi giữa chừng → không áp dụng một nửa (giao dịch)', async () => {
    const { adjustment } = await seed()
    const old3 = await topicOf(3)
    const real = db
    const broken = Object.assign(Object.create(real), {
      batch: async (stmts: D1PreparedStatement[]) => real.batch([...stmts, real.prepare('INSERT INTO plan_weeks (plan_id, week_no, topic, goal_vi) VALUES (1, 3, "x", "y")')]), // trùng khóa → lỗi
    }) as D1Database
    await expect(approveAdjustment(broken, adjustment.id)).rejects.toThrow()
    expect(await topicOf(3)).toEqual(old3)
    expect((await db.prepare('SELECT status FROM plan_adjustments').first<{ status: string }>())!.status).toBe('pending')
  })
})

describe('từ chối = giữ lộ trình cũ', () => {
  it('từ chối → rejected, lộ trình KHÔNG đổi', async () => {
    const { adjustment } = await seed()
    const before = [await topicOf(3), await topicOf(4)]
    const r = await call(`/api/adjustments/${adjustment.id}/reject`, {})
    expect(r.status).toBe(200)
    expect((await json(r)).adjustment).toMatchObject({ status: 'rejected', decided_at: todayVN() })
    expect([await topicOf(3), await topicOf(4)]).toEqual(before)
  })
  it('từ chối rồi không từ chối/duyệt lại được; id lạ → 404', async () => {
    const { adjustment } = await seed()
    await call(`/api/adjustments/${adjustment.id}/reject`, {})
    expect((await call(`/api/adjustments/${adjustment.id}/reject`, {})).status).toBe(409)
    expect((await call('/api/adjustments/9999/reject', {})).status).toBe(404)
  })
  it('không duyệt (để pending) thì lộ trình cũ giữ nguyên', async () => {
    await seed()
    expect((await topicOf(3)).topic).not.toBe('Review: connectors')
  })
})
