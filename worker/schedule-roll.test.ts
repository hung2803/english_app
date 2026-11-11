import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, daysBetween, isWeekday, nextWeekday, nextWeekdayOnOrAfter, todayVN } from './dates'
import { buildSchedule, rollForward, type PendingSession } from './schedule'
import { syncSchedule } from './plan-store'
import { createTestDb } from './test-db'
import type { Env } from './env'

// 2026-11-16 = thứ 2
const pend = (...dates: string[]): PendingSession[] => dates.map((d, i) => ({ id: i + 1, scheduled_date: d }))
const apply = (p: PendingSession[], today: string) => {
  const ch = new Map(rollForward(p, today).map((c) => [c.id, c.scheduled_date]))
  return p.map((s) => ch.get(s.id) ?? s.scheduled_date)
}

describe('rollForward — dời buổi bị lỡ', () => {
  it('không lỡ buổi nào → không đổi gì', () => {
    expect(rollForward(pend('2026-11-18', '2026-11-19', '2026-11-20'), '2026-11-18')).toEqual([])
  })
  it('buổi hôm nay chưa học KHÔNG bị tính là lỡ', () => {
    expect(rollForward(pend('2026-11-18'), '2026-11-18')).toEqual([])
  })
  it('lỡ hôm qua → dời sang hôm nay, các buổi sau lùi một ngày', () => {
    const p = pend('2026-11-17', '2026-11-18', '2026-11-19') // hôm nay T4 18/11; T3 lỡ
    expect(apply(p, '2026-11-18')).toEqual(['2026-11-18', '2026-11-19', '2026-11-20'])
    expect(rollForward(p, '2026-11-18')[0]).toMatchObject({ id: 1, missed: true })
    expect(rollForward(p, '2026-11-18').slice(1).every((c) => c.missed === false)).toBe(true)
  })
  it('lỡ nhiều ngày liên tiếp → xếp lần lượt từ hôm nay, đánh dấu missed cho từng buổi lỡ', () => {
    const p = pend('2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19') // hôm nay T5 19/11
    expect(apply(p, '2026-11-19')).toEqual(['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24'])
    expect(rollForward(p, '2026-11-19').map((c) => c.missed)).toEqual([true, true, true, false])
  })
  it('buổi sau không bị chiếm ngày thì giữ nguyên (không dồn thừa)', () => {
    const p = pend('2026-11-17', '2026-11-25') // buổi 2 cách xa
    expect(apply(p, '2026-11-18')).toEqual(['2026-11-18', '2026-11-25'])
  })
  it('hôm nay là thứ 7/CN → buổi lỡ dời sang thứ 2', () => {
    expect(apply(pend('2026-11-20'), '2026-11-21')).toEqual(['2026-11-23'])
    expect(apply(pend('2026-11-20'), '2026-11-22')).toEqual(['2026-11-23'])
  })
  it('lỡ thứ 6, hôm nay thứ 2 → dời sang thứ 2, các buổi sau lùi, không rơi vào cuối tuần', () => {
    expect(apply(pend('2026-11-20', '2026-11-23'), '2026-11-23')).toEqual(['2026-11-23', '2026-11-24'])
  })
  it('chạy lại ngay sau khi dời → không đổi gì thêm (idempotent)', () => {
    const p = pend('2026-11-16', '2026-11-17', '2026-11-18')
    const once = apply(p, '2026-11-19')
    expect(rollForward(once.map((d, i) => ({ id: i + 1, scheduled_date: d })), '2026-11-19')).toEqual([])
  })
  it('danh sách rỗng → không đổi', () => {
    expect(rollForward([], '2026-11-18')).toEqual([])
  })
  it('lộ trình đầy đủ 60 buổi: lỡ 3 ngày làm việc → ngày kết thúc muộn đúng 3 ngày làm việc', () => {
    const sched = buildSchedule('2026-11-16').map((s) => ({ id: s.seq, scheduled_date: s.scheduled_date }))
    const today = '2026-11-19' // T5: buổi 1,2,3 (T2,T3,T4) đã lỡ, chưa học buổi nào
    const after = apply(sched, today)
    const origEnd = sched[59].scheduled_date
    expect(after[59] > origEnd).toBe(true)
    // đúng 3 ngày làm việc muộn hơn
    expect(after[59]).toBe(nextWeekday(nextWeekday(nextWeekday(origEnd))))
  })

  it('tính chất: luôn T2–T6, mỗi ngày một buổi, tăng dần, không sớm hơn hôm nay và không sớm hơn lịch gốc', () => {
    const today = '2026-12-02'
    for (const startOffset of [-20, -9, -4, -1, 0, 3, 10]) {
      const base = buildSchedule(addDays(today, startOffset)).map((s) => ({ id: s.seq, scheduled_date: s.scheduled_date }))
      // giả lập một nửa đã học xong
      const pending = base.slice(Math.min(25, Math.max(0, -startOffset)))
      const out = apply(pending, today)
      out.forEach((d, i) => {
        expect(isWeekday(d)).toBe(true)
        expect(d >= today).toBe(true)
        expect(d >= pending[i].scheduled_date).toBe(true)
        if (i > 0) expect(d > out[i - 1]).toBe(true)
      })
      expect(new Set(out).size).toBe(out.length)
      expect(rollForward(out.map((d, i) => ({ id: i, scheduled_date: d })), today)).toEqual([])
    }
  })
})

describe('đồng bộ lịch qua API', () => {
  const SECRET = 'test-secret-test-secret-test-secret'
  let env: Env
  beforeEach(() => {
    env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: createTestDb() } as Env
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  })
  afterEach(() => vi.unstubAllGlobals())

  const req = async (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` } }, env)
  const plan = async () => (await req('/api/plan')).json() as Promise<any>
  const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run()
  const sessions = async () => (await env.DB.prepare('SELECT * FROM sessions ORDER BY seq').all<any>()).results
  const seed = async () => {
    await run("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)", todayVN())
    await req('/api/plan', { method: 'POST', body: '{}' })
  }
  /** Lùi toàn bộ lịch về quá khứ n ngày LỊCH (giữ nguyên thứ tự) để giả lập "đã lâu không học". */
  const backdate = async (days: number) => {
    await run("UPDATE sessions SET scheduled_date = date(scheduled_date, ?)", `-${days} days`)
    await run("UPDATE plans SET start_date = date(start_date, ?)", `-${days} days`)
  }

  it('không lỡ gì → không đổi lịch, ngày kết thúc = ngày gốc', async () => {
    await seed()
    const before = await sessions()
    const p = await plan()
    expect(await sessions()).toEqual(before)
    expect(p.plan.end_date).toBe(p.plan.original_end_date)
  })
  it('lỡ buổi → đọc lộ trình tự dời sang hôm nay, đánh dấu bị lỡ, ngày kết thúc muộn hơn', async () => {
    await seed()
    await run("UPDATE sessions SET status='done', completed_date=? WHERE seq=1", todayVN()) // buổi 1 đã học
    await backdate(14) // 14 ngày không học
    const p = await plan()

    const s = await sessions()
    expect(s[0].status).toBe('done') // buổi đã xong không bị đụng
    expect(s[1].scheduled_date >= todayVN()).toBe(true) // buổi 2 (lỡ) giờ ở hôm nay trở đi
    expect(s[1].scheduled_date).toBe(nextWeekdayOnOrAfter(todayVN())) // sớm nhất có thể: hôm nay (hoặc thứ 2 nếu cuối tuần)
    expect(s[1].status).toBe('missed')
    expect(p.plan.end_date > p.plan.original_end_date).toBe(true)
    const pendingDates = s.filter((x: any) => x.status !== 'done').map((x: any) => x.scheduled_date)
    expect(new Set(pendingDates).size).toBe(pendingDates.length)
    expect(pendingDates.every(isWeekday)).toBe(true)
    // trạng thái hiển thị: buổi lỡ đã được dời nhưng vẫn hiện "bị lỡ"
    expect(p.weeks[0].sessions.find((x: any) => x.seq === 2).status).toBe('missed')
  })
  it('gọi lần 2 trong cùng ngày không dời thêm', async () => {
    await seed()
    await backdate(10)
    await plan()
    const first = await sessions()
    await plan()
    expect(await sessions()).toEqual(first)
  })
  it('lỡ nhiều hơn → ngày kết thúc muộn hơn nhiều hơn', async () => {
    await seed()
    await backdate(7)
    const shortDelay = daysBetween((await plan()).plan.original_end_date, (await plan()).plan.end_date)
    await backdate(14)
    const p = await plan()
    const longDelay = daysBetween(p.plan.original_end_date, p.plan.end_date)
    expect(shortDelay).toBeGreaterThan(0)
    expect(longDelay).toBeGreaterThan(shortDelay)
  })
  it('chỉ động tới lộ trình đang chạy; lộ trình đã lưu trữ giữ nguyên lịch', async () => {
    await seed()
    await backdate(10)
    await run("INSERT INTO placement_results (score,total,level,taken_at) VALUES (12,18,'A2',?)", todayVN())
    // tạo plan mới, lưu trữ plan cũ (lịch cũ nằm trong quá khứ)
    await req('/api/plan', { method: 'POST', body: JSON.stringify({ replace: true }) })
    const archived = (await env.DB.prepare('SELECT scheduled_date FROM sessions WHERE plan_id = 1 ORDER BY seq').all<any>()).results
    await plan()
    const after = (await env.DB.prepare('SELECT scheduled_date FROM sessions WHERE plan_id = 1 ORDER BY seq').all<any>()).results
    expect(after).toEqual(archived)
  })
  it('syncSchedule trả số buổi đã đổi và 0 khi không có gì để đổi', async () => {
    await seed()
    const planId = (await env.DB.prepare("SELECT id FROM plans WHERE status='active'").first<{ id: number }>())!.id
    expect(await syncSchedule(env.DB, planId, todayVN())).toBe(0)
    await backdate(3)
    expect(await syncSchedule(env.DB, planId, todayVN())).toBeGreaterThan(0)
    expect(await syncSchedule(env.DB, planId, todayVN())).toBe(0)
  })
})
