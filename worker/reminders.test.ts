import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMINDER_WINDOW_MIN, runReminder, vnClock } from './reminders'
import { runScheduled } from './cron'
import { createTestDb } from './test-db'
import type { Env } from './env'

let env: Env
let db: D1Database
let pushCalls: string[]
let pushStatus: number | ((url: string) => number)

const EP1 = 'https://fcm.googleapis.com/fcm/send/one'
const EP2 = 'https://updates.push.services.mozilla.com/wpush/v2/two'

/** Mốc thời gian theo giờ VN: 2026-11-16 là thứ 2. `hhmm` = giờ VN. */
const vn = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+07:00`)
const MON = '2026-11-16'
const FRI = '2026-11-20'
const SAT = '2026-11-21'

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))

beforeEach(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
  db = createTestDb()
  env = {
    DB: db, GEMINI_API_KEY: 'k', APP_PASSWORD: 'x', SESSION_SECRET: 's'.repeat(32),
    VAPID_PUBLIC_KEY: b64url(new Uint8Array([4, ...fromB64url(jwk.x!), ...fromB64url(jwk.y!)])), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: 'mailto:me@example.com',
  } as Env
  pushCalls = []
  pushStatus = 201
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      pushCalls.push(String(url))
      return new Response(null, { status: typeof pushStatus === 'function' ? pushStatus(String(url)) : pushStatus })
    }),
  )
  await db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, 'p', 'a', '2026-01-01')").bind(EP1).run()
  // có lộ trình đang học với các buổi chưa xong
  await db.prepare("INSERT INTO plans (level, start_date, status, created_at) VALUES ('A1', ?, 'active', ?)").bind(MON, MON).run()
  await db.prepare("INSERT INTO plan_weeks (plan_id, week_no, topic, goal_vi) VALUES (1, 1, 'Food', 'Đồ ăn')").run()
  for (let i = 1; i <= 5; i++) await db.prepare("INSERT INTO sessions (plan_id, seq, week_no, scheduled_date) VALUES (1, ?, 1, ?)").bind(i, MON).run()
})
afterEach(() => vi.unstubAllGlobals())

const logged = async () => (await db.prepare("SELECT kind, day FROM notification_log WHERE kind = 'push_reminder'").all<any>()).results
const doneToday = (date: string) => db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq = 1").bind(date).run()

describe('vnClock', () => {
  it('đổi sang giờ Việt Nam (UTC+7), qua nửa đêm UTC thì sang ngày mới ở VN', () => {
    expect(vnClock(Date.UTC(2026, 10, 16, 13, 0))).toEqual({ date: '2026-11-16', minutes: 20 * 60 })
    expect(vnClock(Date.UTC(2026, 10, 16, 17, 30))).toEqual({ date: '2026-11-17', minutes: 30 }) // 00:30 ngày 17 ở VN
  })
})

describe('nhắc học — điều kiện gửi', () => {
  it('đúng giờ mặc định 20:00 ngày thường: gửi tới thiết bị và ghi nhận đã nhắc hôm nay', async () => {
    const r = await runReminder(env, vn(MON, '20:00'))
    expect(r).toEqual({ status: 'sent', summary: { devices: 1, sent: 1, removed: 0, failed: 0 } })
    expect(pushCalls).toEqual([EP1])
    expect(await logged()).toEqual([{ kind: 'push_reminder', day: MON }])
  })

  it('thứ 2 đến thứ 6 đều nhắc', async () => {
    for (const d of ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', FRI]) {
      expect((await runReminder(env, vn(d, '20:10'))).status, d).toBe('sent')
    }
  })

  it('thứ 7 và chủ nhật KHÔNG nhắc', async () => {
    expect(await runReminder(env, vn(SAT, '20:00'))).toEqual({ status: 'skipped', reason: 'weekend' })
    expect(await runReminder(env, vn('2026-11-22', '20:00'))).toEqual({ status: 'skipped', reason: 'weekend' })
    expect(pushCalls).toEqual([])
  })

  it('theo giờ VN: 19:30 UTC thứ 6 đã là 02:30 thứ 7 ở VN → không nhắc', async () => {
    expect(await runReminder(env, Date.UTC(2026, 10, 20, 19, 30))).toEqual({ status: 'skipped', reason: 'weekend' })
  })

  it('chưa tới giờ → không gửi; quá cửa sổ → không gửi', async () => {
    expect(await runReminder(env, vn(MON, '19:59'))).toEqual({ status: 'skipped', reason: 'too_early' })
    expect(await runReminder(env, vn(MON, '08:00'))).toEqual({ status: 'skipped', reason: 'too_early' })
    expect((await runReminder(env, vn(MON, '21:29'))).status).toBe('sent') // 89 phút sau, vẫn trong cửa sổ
    await db.prepare('DELETE FROM notification_log').run()
    expect(await runReminder(env, vn(MON, '21:30'))).toEqual({ status: 'skipped', reason: 'too_late' }) // đúng 90 phút
    expect(REMINDER_WINDOW_MIN).toBe(90)
  })

  it('theo giờ người học đặt (vd 07:30)', async () => {
    await db.prepare("UPDATE settings SET value = '07:30' WHERE key = 'reminder_time'").run()
    expect(await runReminder(env, vn(MON, '20:00'))).toEqual({ status: 'skipped', reason: 'too_late' })
    expect((await runReminder(env, vn(MON, '07:30'))).status).toBe('sent')
  })

  it('đổi giờ về một giờ đã qua từ lâu thì KHÔNG nhắc ngay (tránh nhắc bất ngờ)', async () => {
    await db.prepare("UPDATE settings SET value = '06:00' WHERE key = 'reminder_time'").run()
    expect(await runReminder(env, vn(MON, '15:00'))).toEqual({ status: 'skipped', reason: 'too_late' })
  })

  it('đặt giờ sát nửa đêm (23:30): cửa sổ không tràn sang hôm sau', async () => {
    await db.prepare("UPDATE settings SET value = '23:30' WHERE key = 'reminder_time'").run()
    expect((await runReminder(env, vn(MON, '23:40'))).status).toBe('sent')
    expect(await runReminder(env, vn('2026-11-17', '00:10'))).toEqual({ status: 'skipped', reason: 'too_early' })
  })

  it('người học tắt nhắc → không gửi', async () => {
    await db.prepare("UPDATE settings SET value = '0' WHERE key = 'reminder_enabled'").run()
    expect(await runReminder(env, vn(MON, '20:00'))).toEqual({ status: 'skipped', reason: 'disabled' })
    expect(pushCalls).toEqual([])
  })

  it('hôm nay ĐÃ học xong một buổi → bỏ qua, không gửi', async () => {
    await doneToday(MON)
    expect(await runReminder(env, vn(MON, '20:00'))).toEqual({ status: 'skipped', reason: 'already_studied' })
    expect(pushCalls).toEqual([])
    expect(await logged()).toEqual([])
  })

  it('đã học hôm KHÁC thì hôm nay vẫn nhắc', async () => {
    await doneToday('2026-11-13')
    expect((await runReminder(env, vn(MON, '20:00'))).status).toBe('sent')
  })

  it('học vào buổi tối trước giờ nhắc (vd 19:00) → không nhắc lúc 20:00', async () => {
    await doneToday(MON)
    expect((await runReminder(env, vn(MON, '20:00'))).status).toBe('skipped')
  })

  it('chỉ nhắc MỘT lần mỗi ngày dù cron chạy nhiều lần', async () => {
    expect((await runReminder(env, vn(MON, '20:00'))).status).toBe('sent')
    for (const t of ['20:10', '20:20', '21:00']) expect(await runReminder(env, vn(MON, t))).toEqual({ status: 'skipped', reason: 'already_sent' })
    expect(pushCalls).toHaveLength(1)
  })

  it('ngày hôm sau nhắc lại bình thường', async () => {
    await runReminder(env, vn(MON, '20:00'))
    expect((await runReminder(env, vn('2026-11-17', '20:00'))).status).toBe('sent')
    expect(pushCalls).toHaveLength(2)
  })

  it('không có lộ trình / đã học hết mọi buổi → không nhắc', async () => {
    await db.prepare("UPDATE sessions SET status = 'done', completed_date = '2026-11-13'").run()
    expect(await runReminder(env, vn(MON, '20:00'))).toEqual({ status: 'skipped', reason: 'nothing_to_study' })
    await db.prepare("UPDATE sessions SET status = 'pending'").run()
    await db.prepare("UPDATE plans SET status = 'archived'").run()
    expect(await runReminder(env, vn(MON, '20:00'))).toEqual({ status: 'skipped', reason: 'nothing_to_study' })
  })

  it('chưa có thiết bị nào đăng ký → không gửi', async () => {
    await db.prepare('DELETE FROM push_subscriptions').run()
    expect(await runReminder(env, vn(MON, '20:00'))).toEqual({ status: 'skipped', reason: 'no_devices' })
  })

  it('chưa cấu hình VAPID → bỏ qua, không lỗi', async () => {
    expect(await runReminder({ ...env, VAPID_PRIVATE_KEY: '' } as Env, vn(MON, '20:00'))).toEqual({ status: 'skipped', reason: 'not_configured' })
    expect(pushCalls).toEqual([])
  })

  it('buổi bị lỡ (missed) vẫn là buổi cần học → vẫn nhắc', async () => {
    await db.prepare("UPDATE sessions SET status = 'missed'").run()
    expect((await runReminder(env, vn(MON, '20:00'))).status).toBe('sent')
  })
})

describe('nhắc học — kết quả gửi', () => {
  it('gửi hỏng cho mọi thiết bị: KHÔNG ghi nhận → lần cron sau thử lại, tới khi thành công', async () => {
    pushStatus = 500
    expect(await runReminder(env, vn(MON, '20:00'))).toMatchObject({ status: 'failed', summary: { sent: 0, failed: 1 } })
    expect(await logged()).toEqual([])
    pushStatus = 201
    expect((await runReminder(env, vn(MON, '20:10'))).status).toBe('sent')
    expect(await logged()).toEqual([{ kind: 'push_reminder', day: MON }])
  })

  it('nhiều thiết bị: thiết bị hết hiệu lực (410) bị xóa, thiết bị còn lại vẫn nhận', async () => {
    await db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, 'p', 'a', '2026-01-01')").bind(EP2).run()
    pushStatus = (url) => (url === EP1 ? 410 : 201)
    expect(await runReminder(env, vn(MON, '20:00'))).toEqual({ status: 'sent', summary: { devices: 2, sent: 1, removed: 1, failed: 0 } })
    expect((await db.prepare('SELECT endpoint FROM push_subscriptions').all<any>()).results.map((r) => r.endpoint)).toEqual([EP2])
  })

  it('chỉ một số thiết bị thành công vẫn tính là đã nhắc', async () => {
    await db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, 'p', 'a', '2026-01-01')").bind(EP2).run()
    pushStatus = (url) => (url === EP1 ? 500 : 201)
    expect((await runReminder(env, vn(MON, '20:00'))).status).toBe('sent')
    expect(await logged()).toHaveLength(1)
  })
})

describe('runScheduled — việc định kỳ', () => {
  it('chạy nhắc học và trả báo cáo', async () => {
    const r = await runScheduled(env, vn(MON, '20:00'))
    expect(r.reminder).toMatchObject({ status: 'sent' })
    expect(r.review_retried).toEqual([])
    expect(r.emails).toEqual({ sent: 0, failed: 0 })
  })
  it('ngoài giờ: không gửi gì, không lỗi', async () => {
    const r = await runScheduled(env, vn(MON, '10:00'))
    expect(r.reminder).toEqual({ status: 'skipped', reason: 'too_early' })
    expect(pushCalls).toEqual([])
  })
  it('một việc lỗi không làm hỏng việc khác (CSDL nhắc học lỗi vẫn chạy các việc còn lại)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = Object.assign(Object.create(db), { prepare: (sql: string) => (/settings/.test(sql) ? { bind: () => ({ all: async () => { throw new Error('db') } }), all: async () => { throw new Error('db') } } : db.prepare(sql)) }) as D1Database
    const r = await runScheduled({ ...env, DB: broken } as Env, vn(MON, '20:00'))
    expect(r.reminder).toEqual({ status: 'error' })
    expect(r.emails).toEqual({ sent: 0, failed: 0 })
  })
})
