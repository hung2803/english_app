import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, todayVN } from './dates'
import { buildWeeks, displayStatus } from './plan-view'
import { createTestDb } from './test-db'
import type { Env } from './env'

const TODAY = '2026-11-18'

describe('displayStatus', () => {
  it('đã xong → done, kể cả khi ngày đã qua', () => {
    expect(displayStatus({ status: 'done', scheduled_date: '2026-11-01' }, TODAY)).toBe('done')
  })
  it('chưa học, ngày hôm nay hoặc tương lai → pending', () => {
    expect(displayStatus({ status: 'pending', scheduled_date: TODAY }, TODAY)).toBe('pending')
    expect(displayStatus({ status: 'pending', scheduled_date: '2026-11-20' }, TODAY)).toBe('pending')
  })
  it('chưa học mà ngày đã qua → missed', () => {
    expect(displayStatus({ status: 'pending', scheduled_date: '2026-11-17' }, TODAY)).toBe('missed')
  })
  it('đánh dấu missed trong DB → missed (kể cả khi ngày đã dời tới hôm nay/tương lai)', () => {
    expect(displayStatus({ status: 'missed', scheduled_date: '2026-11-25' }, TODAY)).toBe('missed')
  })
})

describe('buildWeeks', () => {
  const weeks = [
    { week_no: 1, topic: 'A', goal_vi: 'a' },
    { week_no: 2, topic: 'B', goal_vi: 'b' },
  ]
  const s = (id: number, week_no: number, seq: number, status: 'pending' | 'done' | 'missed', score: number | null = null) =>
    ({ id, week_no, seq, scheduled_date: '2026-11-20', status, score })
  it('gom buổi theo tuần, sắp theo seq, đếm đúng số buổi xong', () => {
    const v = buildWeeks(weeks, [s(3, 1, 3, 'pending'), s(1, 1, 1, 'done', 80), s(2, 1, 2, 'done', 60), s(6, 2, 6, 'pending')], TODAY)
    expect(v[0].sessions.map((x) => x.seq)).toEqual([1, 2, 3])
    expect(v[0]).toMatchObject({ done: 2, total: 3 })
    expect(v[1]).toMatchObject({ done: 0, total: 1, topic: 'B' })
  })
  it('tuần chưa có buổi nào → total 0', () => {
    expect(buildWeeks(weeks, [], TODAY)[0]).toMatchObject({ done: 0, total: 0, sessions: [] })
  })
})

describe('GET /api/plan', () => {
  const SECRET = 'test-secret-test-secret-test-secret'
  let env: Env
  beforeEach(() => {
    env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: createTestDb() } as Env
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  })
  afterEach(() => vi.unstubAllGlobals())

  const req = async (path: string, init: RequestInit = {}, authed = true) =>
    app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) } }, env)
  const get = async () => (await req('/api/plan')).json() as Promise<any>
  const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run()
  const seedPlan = async () => {
    await run("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)", todayVN())
    await req('/api/plan', { method: 'POST', body: '{}' })
  }

  it('cần đăng nhập', async () => {
    expect((await req('/api/plan', {}, false)).status).toBe(401)
  })
  it('chưa có lộ trình, chưa test → plan null, has_placement false', async () => {
    expect(await get()).toEqual({ plan: null, has_placement: false, placement_level: null })
  })
  it('chưa có lộ trình nhưng đã test → has_placement true', async () => {
    await run("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)", todayVN())
    expect(await get()).toEqual({ plan: null, has_placement: true, placement_level: 'A1' })
  })
  it('có lộ trình: 12 tuần × 5 buổi, tất cả chưa học, buổi đầu là tuần hiện tại', async () => {
    await seedPlan()
    const r = await get()
    expect(r.plan).toMatchObject({ level: 'A1', done: 0, total: 60, current_week: 1, today: todayVN() })
    expect(r.weeks).toHaveLength(12)
    for (const w of r.weeks) {
      expect(w.sessions).toHaveLength(5)
      expect(w.topic).not.toBe('')
      expect(w.goal_vi).not.toBe('')
    }
    expect(r.weeks.flatMap((w: any) => w.sessions).every((s: any) => s.status === 'pending')).toBe(true)
  })
  it('đủ 3 trạng thái: xong / bị lỡ (ngày đã qua) / bị lỡ (đánh dấu) / chưa học', async () => {
    await seedPlan()
    await run("UPDATE sessions SET status='done', score=85 WHERE seq=1")
    await run('UPDATE sessions SET scheduled_date=? WHERE seq=2', addDays(todayVN(), -3)) // ngày qua, chưa học
    await run("UPDATE sessions SET status='missed' WHERE seq=3")
    const r = await get()
    const by = (seq: number) => r.weeks[0].sessions.find((s: any) => s.seq === seq)
    expect(by(1)).toMatchObject({ status: 'done', score: 85 })
    expect(by(2).status).toBe('missed')
    expect(by(3).status).toBe('missed')
    expect(by(4).status).toBe('pending')
    expect(r.weeks[0]).toMatchObject({ done: 1, total: 5 })
    expect(r.plan.done).toBe(1)
  })
  it('current_week chuyển sang tuần của buổi chưa xong đầu tiên', async () => {
    await seedPlan()
    await run("UPDATE sessions SET status='done' WHERE seq <= 7")
    expect((await get()).plan.current_week).toBe(2)
  })
  it('xong cả 60 buổi → current_week null', async () => {
    await seedPlan()
    await run("UPDATE sessions SET status='done'")
    const r = await get()
    expect(r.plan).toMatchObject({ done: 60, current_week: null })
  })
  it('chỉ trả lộ trình đang chạy, không lẫn lộ trình đã lưu trữ', async () => {
    await seedPlan()
    await run("INSERT INTO placement_results (score,total,level,taken_at) VALUES (15,18,'A2',?)", todayVN())
    await req('/api/plan', { method: 'POST', body: JSON.stringify({ replace: true }) })
    const r = await get()
    expect(r.plan.level).toBe('A2')
    expect(r.weeks.flatMap((w: any) => w.sessions)).toHaveLength(60)
  })
})
