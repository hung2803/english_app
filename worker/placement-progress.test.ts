import { beforeEach, describe, expect, it } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, daysBetween, todayVN } from './dates'
import { compareLevels, RETAKE_AFTER_DAYS, type PlacementEntry } from './placement-progress'
import { createTestDb } from './test-db'
import type { Env } from './env'

const e = (level: PlacementEntry['level'], taken_at: string): PlacementEntry => ({ level, taken_at })
const TODAY = '2027-02-10'

describe('ngày', () => {
  it('addDays / daysBetween qua tháng, năm, năm nhuận', () => {
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(daysBetween('2026-11-11', '2027-02-03')).toBe(84)
    expect(daysBetween('2027-02-03', '2026-11-11')).toBe(-84)
    expect(daysBetween('2026-11-11', '2026-11-11')).toBe(0)
  })
})

describe('so sánh mức đầu và hiện tại', () => {
  it('chưa làm bài nào → null', () => {
    expect(compareLevels([], TODAY)).toBeNull()
  })
  it('mới làm 1 lần → chưa so được (success = null), nhưng đã có ngày hẹn làm lại', () => {
    const p = compareLevels([e('A0', '2026-11-11')], '2026-11-20')!
    expect(p.bands_gained).toBeNull()
    expect(p.success).toBeNull()
    expect(p.retake_date).toBe('2027-02-03')
    expect(p.retake_due).toBe(false)
    expect(p.days_until_retake).toBe(75)
  })
  it('lên 1 bậc → đạt tiêu chí', () => {
    const p = compareLevels([e('A0', '2026-11-11'), e('A1', '2027-02-03')], TODAY)!
    expect(p.bands_gained).toBe(1)
    expect(p.success).toBe(true)
  })
  it('lên 2 bậc cũng đạt', () => {
    expect(compareLevels([e('A0', '2026-11-11'), e('A2', '2027-02-03')], TODAY)!.success).toBe(true)
  })
  it('giữ nguyên mức → chưa đạt', () => {
    const p = compareLevels([e('A1', '2026-11-11'), e('A1', '2027-02-03')], TODAY)!
    expect(p.bands_gained).toBe(0)
    expect(p.success).toBe(false)
  })
  it('tụt mức → bands_gained âm, chưa đạt', () => {
    const p = compareLevels([e('A2', '2026-11-11'), e('A1', '2027-02-03')], TODAY)!
    expect(p.bands_gained).toBe(-1)
    expect(p.success).toBe(false)
  })
  it('lần đầu là mốc so sánh, không phải lần liền trước (3 lần: A0 → A1 → A2)', () => {
    const p = compareLevels([e('A0', '2026-11-11'), e('A1', '2027-02-03'), e('A2', '2027-05-01')], '2027-05-02')!
    expect(p.baseline.level).toBe('A0')
    expect(p.latest.level).toBe('A2')
    expect(p.bands_gained).toBe(2)
  })
  it('không phụ thuộc thứ tự mảng đầu vào', () => {
    const a = compareLevels([e('A1', '2027-02-03'), e('A0', '2026-11-11')], TODAY)!
    expect(a.baseline.level).toBe('A0')
    expect(a.latest.level).toBe('A1')
  })
  it('baseline B1 → đánh dấu at_ceiling (không còn bậc để lên)', () => {
    expect(compareLevels([e('B1', '2026-11-11'), e('B1', '2027-02-03')], TODAY)!.at_ceiling).toBe(true)
    expect(compareLevels([e('A0', '2026-11-11')], TODAY)!.at_ceiling).toBe(false)
  })
})

describe('khi nào nên làm lại (84 ngày = 12 tuần)', () => {
  const taken = '2026-11-11'
  const due = addDays(taken, RETAKE_AFTER_DAYS)
  it('RETAKE_AFTER_DAYS = 12 tuần', () => expect(RETAKE_AFTER_DAYS).toBe(12 * 7))
  it('trước hạn 1 ngày: chưa đến', () => {
    const p = compareLevels([e('A0', taken)], addDays(due, -1))!
    expect(p.retake_due).toBe(false)
    expect(p.days_until_retake).toBe(1)
  })
  it('đúng ngày hạn: đến hạn', () => {
    const p = compareLevels([e('A0', taken)], due)!
    expect(p.retake_due).toBe(true)
    expect(p.days_until_retake).toBe(0)
  })
  it('quá hạn: vẫn đến hạn, số ngày âm', () => {
    const p = compareLevels([e('A0', taken)], addDays(due, 10))!
    expect(p.retake_due).toBe(true)
    expect(p.days_until_retake).toBe(-10)
  })
  it('hạn mới tính từ lần làm gần nhất', () => {
    const p = compareLevels([e('A0', '2026-11-11'), e('A1', '2027-02-03')], TODAY)!
    expect(p.retake_date).toBe(addDays('2027-02-03', 84))
    expect(p.retake_due).toBe(false)
  })
})

describe('GET /api/placement/progress', () => {
  const SECRET = 'test-secret-test-secret-test-secret'
  let env: Env
  beforeEach(() => {
    env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, DB: createTestDb() } as Env
  })
  const get = async (authed = true) =>
    app.request('/api/placement/progress', { headers: authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {} }, env)
  const seed = (level: string, date: string) =>
    env.DB.prepare('INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,?,?)').bind(level, date).run()

  it('chưa có kết quả → progress null', async () => {
    expect(await (await get()).json()).toEqual({ progress: null })
  })
  it('làm lại sau 12 tuần lên 1 bậc → success', async () => {
    await seed('A0', addDays(todayVN(), -84))
    await seed('A1', todayVN())
    const { progress } = (await (await get()).json()) as { progress: { success: boolean; bands_gained: number; baseline: PlacementEntry; latest: PlacementEntry } }
    expect(progress.success).toBe(true)
    expect(progress.bands_gained).toBe(1)
    expect(progress.baseline.level).toBe('A0')
    expect(progress.latest.level).toBe('A1')
  })
  it('lần đầu đủ 84 ngày trước → retake_due = true', async () => {
    await seed('A1', addDays(todayVN(), -84))
    const { progress } = (await (await get()).json()) as { progress: { retake_due: boolean } }
    expect(progress.retake_due).toBe(true)
  })
  it('cần đăng nhập', async () => {
    expect((await get(false)).status).toBe(401)
  })
})
