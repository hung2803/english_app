import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { isWeekday, nextWeekdayOnOrAfter, todayVN } from './dates'
import { buildSchedule, SESSIONS_PER_WEEK, TOTAL_SESSIONS, weekOfSeq } from './schedule'
import { createTestDb } from './test-db'
import type { Env } from './env'

const MON = '2026-11-16'
const dow = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay() // 1=T2 … 5=T6

describe('buildSchedule — 60 buổi, 5 buổi/tuần, T2–T6', () => {
  it('hằng số: 5 buổi × 12 tuần = 60', () => {
    expect(SESSIONS_PER_WEEK).toBe(5)
    expect(TOTAL_SESSIONS).toBe(60)
  })
  it('đủ 60 buổi, seq 1..60, tuần 1..12 mỗi tuần đúng 5 buổi', () => {
    const s = buildSchedule(MON)
    expect(s).toHaveLength(60)
    expect(s.map((x) => x.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    for (let w = 1; w <= 12; w++) expect(s.filter((x) => x.week_no === w)).toHaveLength(5)
  })
  it('chỉ có ngày thứ 2–thứ 6, tuyệt đối không rơi vào thứ 7/CN', () => {
    for (const start of ['2026-11-16', '2026-11-18', '2026-11-20', '2026-11-21', '2026-11-22']) {
      for (const x of buildSchedule(start)) expect(isWeekday(x.scheduled_date)).toBe(true)
    }
  })
  it('mỗi ngày một buổi, ngày tăng dần, không trùng', () => {
    const dates = buildSchedule(MON).map((x) => x.scheduled_date)
    expect(new Set(dates).size).toBe(60)
    expect([...dates].sort()).toEqual(dates)
  })
  it('bắt đầu thứ 2: mỗi tuần lịch là một tuần học (T2→T6), tuần sau bắt đầu thứ 2', () => {
    const s = buildSchedule(MON)
    for (let w = 0; w < 12; w++) {
      const days = s.slice(w * 5, w * 5 + 5).map((x) => dow(x.scheduled_date))
      expect(days).toEqual([1, 2, 3, 4, 5])
    }
    expect(s[0].scheduled_date).toBe('2026-11-16')
    expect(s[59].scheduled_date).toBe('2027-02-05') // 12 tuần sau, thứ 6
  })
  it('bắt đầu giữa tuần: tiếp tục ngay, bỏ qua cuối tuần', () => {
    const s = buildSchedule('2026-11-18') // thứ 4
    expect(s.slice(0, 4).map((x) => x.scheduled_date)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'])
  })
  it('bắt đầu vào thứ 7 hoặc CN: lùi sang thứ 2 kế tiếp', () => {
    expect(buildSchedule('2026-11-21')[0].scheduled_date).toBe('2026-11-23')
    expect(buildSchedule('2026-11-22')[0].scheduled_date).toBe('2026-11-23')
  })
  it('qua năm mới vẫn đúng', () => {
    const s = buildSchedule('2026-12-28')
    expect(s.map((x) => x.scheduled_date)).toContain('2027-01-01')
    for (const x of s) expect(isWeekday(x.scheduled_date)).toBe(true)
  })
  it('weekOfSeq', () => {
    expect([1, 5, 6, 10, 56, 60].map(weekOfSeq)).toEqual([1, 1, 2, 2, 12, 12])
  })
})

describe('POST /api/plan', () => {
  const SECRET = 'test-secret-test-secret-test-secret'
  let env: Env
  beforeEach(() => {
    env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: createTestDb() } as Env
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 }))) // AI từ chối → bộ mặc định
  })
  afterEach(() => vi.unstubAllGlobals())

  const post = async (body?: unknown, authed = true) =>
    app.request(
      '/api/plan',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    )
  const q = async <T>(sql: string) => (await env.DB.prepare(sql).all<T>()).results
  const seedPlacement = (level = 'A1') => env.DB.prepare('INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,?,?)').bind(level, todayVN()).run()

  it('chưa làm test trình độ → 400, không tạo gì', async () => {
    const r = await post({})
    expect(r.status).toBe(400)
    expect(await q('SELECT * FROM plans')).toEqual([])
  })
  it('chưa đăng nhập → 401', async () => {
    await seedPlacement()
    expect((await post({}, false)).status).toBe(401)
    expect(await q('SELECT * FROM plans')).toEqual([])
  })
  it('tạo plan + 12 tuần + 60 buổi, gắn đúng mức và kết quả test', async () => {
    await seedPlacement('A2')
    const r = await post({})
    expect(r.status).toBe(200)
    const body = (await r.json()) as Record<string, unknown>
    expect(body).toMatchObject({ level: 'A2', sessions: 60, source: 'default', fallback_reason: 'rate' })

    const plans = await q<{ id: number; level: string; status: string; placement_id: number; start_date: string }>('SELECT * FROM plans')
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ level: 'A2', status: 'active', placement_id: 1 })
    expect(await q('SELECT * FROM plan_weeks')).toHaveLength(12)
    const sessions = await q<{ seq: number; week_no: number; scheduled_date: string; status: string; plan_id: number }>('SELECT * FROM sessions ORDER BY seq')
    expect(sessions).toHaveLength(60)
    expect(sessions.every((s) => s.plan_id === plans[0].id)).toBe(true)
    expect(sessions.every((s) => s.status === 'pending')).toBe(true)
    expect(sessions.every((s) => isWeekday(s.scheduled_date))).toBe(true)
    expect(sessions[0].scheduled_date).toBe(plans[0].start_date)
    expect(body.start_date).toBe(sessions[0].scheduled_date)
    expect(body.end_date).toBe(sessions[59].scheduled_date)
    for (let w = 1; w <= 12; w++) expect(sessions.filter((s) => s.week_no === w)).toHaveLength(5)
  })
  it('lộ trình bắt đầu từ hôm nay (hoặc thứ 2 nếu hôm nay là cuối tuần)', async () => {
    await seedPlacement()
    const body = (await (await post({})).json()) as { start_date: string }
    const today = todayVN()
    const expected = nextWeekdayOnOrAfter(today)
    expect(body.start_date).toBe(expected)
  })
  it('đang có lộ trình: không ghi đè khi thiếu replace → 409, dữ liệu giữ nguyên', async () => {
    await seedPlacement()
    await post({})
    const r = await post({})
    expect(r.status).toBe(409)
    expect(await q('SELECT * FROM plans')).toHaveLength(1)
    expect(await q('SELECT * FROM sessions')).toHaveLength(60)
  })
  it('replace:true → lưu trữ lộ trình cũ, tạo mới; chỉ một plan active', async () => {
    await seedPlacement('A0')
    await post({})
    await seedPlacement('A1')
    const r = await post({ replace: true })
    expect(r.status).toBe(200)
    const plans = await q<{ status: string; level: string }>('SELECT status, level FROM plans ORDER BY id')
    expect(plans).toEqual([{ status: 'archived', level: 'A0' }, { status: 'active', level: 'A1' }])
    expect(await q('SELECT * FROM sessions')).toHaveLength(120) // 60 cũ (lưu trữ) + 60 mới
    expect(await q("SELECT * FROM sessions WHERE plan_id = 2")).toHaveLength(60)
    expect(await q("SELECT * FROM plan_weeks WHERE plan_id = 2")).toHaveLength(12)
  })
  it('dùng kết quả test GẦN NHẤT', async () => {
    await seedPlacement('A0')
    await seedPlacement('B1')
    expect(((await (await post({})).json()) as { level: string }).level).toBe('B1')
  })
  it('lỗi giữa chừng khi lưu → không để lại dữ liệu dở dang', async () => {
    await seedPlacement()
    const real = env.DB
    // ép lệnh chèn buổi học cuối cùng lỗi: trùng seq
    env = { ...env, DB: Object.assign(Object.create(real), {
      batch: async (stmts: unknown[]) => real.batch([...stmts as D1PreparedStatement[], real.prepare('INSERT INTO sessions (seq, week_no, scheduled_date, plan_id) VALUES (1, 1, \'2026-01-01\', (SELECT id FROM plans WHERE status = \'active\'))')]),
    }) } as Env
    const r = await post({})
    expect(r.status).toBe(500)
    expect(await q('SELECT * FROM plans')).toEqual([])
    expect(await q('SELECT * FROM sessions')).toEqual([])
    expect(await q('SELECT * FROM plan_weeks')).toEqual([])
  })
})
