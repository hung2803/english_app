import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { isValidTime, toMinutes, DEFAULT_REMINDER_TIME } from './settings'
import { isPushEndpoint, parseSubscription, pushToAll, sendPush, vapidJwt } from './webpush'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

/** Cặp khóa VAPID thật để kiểm chứng chữ ký */
let vapid: { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string }
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))

beforeEach(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
  const raw = new Uint8Array([4, ...fromB64url(jwk.x!), ...fromB64url(jwk.y!)])
  vapid = { VAPID_PUBLIC_KEY: b64url(raw), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: 'mailto:me@example.com' }
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db, ...vapid } as Env
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, init: { method?: string; body?: unknown } = {}, authed = true, e: Env = env) {
  return app.request(
    path,
    {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    e,
  )
}
const json = async (r: Response) => (await r.json()) as any

/* ================= Cài đặt giờ nhắc ================= */
describe('giờ hợp lệ', () => {
  it('HH:MM 24 giờ', () => {
    for (const t of ['00:00', '08:30', '20:00', '23:59', '07:05']) expect(isValidTime(t), t).toBe(true)
    for (const t of ['24:00', '8:30', '20:60', '20:0', '2000', '20-00', '', ' 20:00', '20:00 ', 'ab:cd', 2000, null, undefined, {}]) expect(isValidTime(t), String(t)).toBe(false)
  })
  it('toMinutes', () => {
    expect(toMinutes('00:00')).toBe(0)
    expect(toMinutes('20:00')).toBe(1200)
    expect(toMinutes('23:59')).toBe(1439)
  })
})

describe('GET/PUT /api/settings', () => {
  it('cần đăng nhập', async () => {
    expect((await call('/api/settings', {}, false)).status).toBe(401)
    expect((await call('/api/settings', { method: 'PUT', body: { reminder_time: '09:00' } }, false)).status).toBe(401)
  })
  it('mặc định: nhắc BẬT, 20:00', async () => {
    const r = await json(await call('/api/settings'))
    expect(r.settings).toEqual({ reminder_enabled: true, reminder_time: '20:00' })
    expect(DEFAULT_REMINDER_TIME).toBe('20:00')
  })
  it('đổi giờ nhắc → lưu và đọc lại đúng', async () => {
    const r = await call('/api/settings', { method: 'PUT', body: { reminder_time: '07:30' } })
    expect(r.status).toBe(200)
    expect((await json(r)).settings).toEqual({ reminder_enabled: true, reminder_time: '07:30' })
    expect((await json(await call('/api/settings'))).settings.reminder_time).toBe('07:30')
  })
  it('tắt / bật nhắc', async () => {
    expect((await json(await call('/api/settings', { method: 'PUT', body: { reminder_enabled: false } }))).settings.reminder_enabled).toBe(false)
    expect((await json(await call('/api/settings'))).settings.reminder_enabled).toBe(false)
    expect((await json(await call('/api/settings', { method: 'PUT', body: { reminder_enabled: true } }))).settings.reminder_enabled).toBe(true)
  })
  it('đổi cả hai cùng lúc; đổi một mục không làm mất mục kia', async () => {
    await call('/api/settings', { method: 'PUT', body: { reminder_time: '06:15', reminder_enabled: false } })
    await call('/api/settings', { method: 'PUT', body: { reminder_time: '18:45' } })
    expect((await json(await call('/api/settings'))).settings).toEqual({ reminder_enabled: false, reminder_time: '18:45' })
  })
  it('giá trị không hợp lệ → 400, không đổi gì (kể cả mục hợp lệ đi kèm)', async () => {
    for (const body of [{ reminder_time: '25:00' }, { reminder_time: '9:00' }, { reminder_time: 900 }, { reminder_time: null }, { reminder_enabled: 'yes' }, { reminder_enabled: 1 }, { reminder_enabled: null }]) {
      const r = await call('/api/settings', { method: 'PUT', body })
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect((await json(r)).error).toBe('bad_request')
    }
    const mixed = await call('/api/settings', { method: 'PUT', body: { reminder_enabled: false, reminder_time: 'xx' } })
    expect(mixed.status).toBe(400)
    expect((await json(await call('/api/settings'))).settings).toEqual({ reminder_enabled: true, reminder_time: '20:00' }) // enabled không bị đổi
  })
  it('không có trường nào / body hỏng → 400', async () => {
    expect((await call('/api/settings', { method: 'PUT', body: {} })).status).toBe(400)
    expect((await call('/api/settings', { method: 'PUT', body: { other: 1 } })).status).toBe(400)
    expect((await call('/api/settings', { method: 'PUT', body: [] })).status).toBe(400)
    const raw = await app.request('/api/settings', { method: 'PUT', headers: { cookie: `ea_session=${await makeToken(SECRET)}` }, body: '{bad' }, env)
    expect(raw.status).toBe(400)
  })
  it('giá trị hỏng trong CSDL → dùng mặc định thay vì lỗi', async () => {
    await db.prepare("UPDATE settings SET value = 'garbage' WHERE key = 'reminder_time'").run()
    expect((await json(await call('/api/settings'))).settings.reminder_time).toBe('20:00')
  })
  it('trạng thái thông báo: đẩy / email đã cấu hình chưa, số thiết bị', async () => {
    const r = await json(await call('/api/settings'))
    expect(r.notifications).toEqual({ push_configured: true, push_devices: 0, email_configured: false })
    const e2 = { ...env, RESEND_API_KEY: 'r', EMAIL_FROM: 'a@b.c', EMAIL_TO: 'd@e.f', APP_URL: 'https://x.dev', VAPID_PUBLIC_KEY: '' } as Env
    expect((await json(await call('/api/settings', {}, true, e2))).notifications).toMatchObject({ push_configured: false, email_configured: true })
  })
})

/* ================= Thông báo đẩy ================= */
const EP = 'https://fcm.googleapis.com/fcm/send/abc123'
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
const sub = (over: Record<string, unknown> = {}) => ({ endpoint: EP, keys: KEYS, ...over })
const devices = async () => (await db.prepare('SELECT * FROM push_subscriptions ORDER BY id').all<any>()).results

describe('isPushEndpoint — chỉ dịch vụ đẩy của trình duyệt', () => {
  it('nhận Chrome/Edge/Firefox/Safari/Windows', () => {
    for (const u of [
      'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://push.services.mozilla.com/x', 'https://x.mozaws.net/y',
    ]) expect(isPushEndpoint(u), u).toBe(true)
  })
  it('từ chối: http, host lạ, nội bộ, giả mạo miền, quá dài, sai kiểu', () => {
    for (const u of [
      'http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://localhost/x', 'https://169.254.169.254/x', 'https://10.0.0.1/x',
      'https://googleapis.com.evil.com/x', 'https://notgoogleapis.com/x', 'ftp://fcm.googleapis.com/x', 'https://u:p@fcm.googleapis.com/x',
      'https://fcm.googleapis.com/' + 'a'.repeat(1000), 'rác', '', null, undefined, 5, {},
    ]) expect(isPushEndpoint(u as any), String(u)).toBe(false)
  })
})

describe('parseSubscription', () => {
  it('hợp lệ', () => expect(parseSubscription(sub())).toEqual({ endpoint: EP, keys: KEYS }))
  it('thiếu/sai khóa hoặc endpoint → null', () => {
    for (const bad of [null, 'x', {}, sub({ endpoint: 'https://evil.com/x' }), sub({ keys: undefined }), sub({ keys: { p256dh: KEYS.p256dh } }), sub({ keys: { p256dh: 'a b', auth: KEYS.auth } }), sub({ keys: { p256dh: KEYS.p256dh, auth: 5 } }), sub({ keys: { p256dh: 'x', auth: 'y' } })]) {
      expect(parseSubscription(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('VAPID JWT', () => {
  const parts = (jwt: string) => jwt.split('.')
  const dec = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)))

  it('header ES256, claims aud/exp/sub đúng', async () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0)
    const [h, c] = parts(await vapidJwt(vapid, 'https://fcm.googleapis.com', now))
    expect(dec(h)).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = dec(c)
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:me@example.com' })
    expect(claims.exp - Math.floor(now / 1000)).toBe(12 * 3600) // ≤ 24 giờ theo RFC 8292
  })

  it('chữ ký kiểm chứng được bằng khóa CÔNG KHAI (r||s 64 byte)', async () => {
    const jwt = await vapidJwt(vapid, 'https://fcm.googleapis.com')
    const [h, c, sig] = parts(jwt)
    const raw = fromB64url(vapid.VAPID_PUBLIC_KEY)
    const pub = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const signature = fromB64url(sig)
    expect(signature).toHaveLength(64)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, signature, new TextEncoder().encode(`${h}.${c}`))).toBe(true)
    // sửa claims thì chữ ký không còn khớp
    const forged = new TextEncoder().encode(`${h}.${btoa('{"aud":"https://evil.com"}')}`)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, signature, forged)).toBe(false)
  })

  it('khóa công khai sai độ dài → lỗi rõ ràng', async () => {
    await expect(vapidJwt({ ...vapid, VAPID_PUBLIC_KEY: 'abc' }, 'https://x.com')).rejects.toThrow(/VAPID_PUBLIC_KEY/)
  })
})

describe('sendPush', () => {
  const stub = (status: number | Error) => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => {
      if (status instanceof Error) throw status
      return new Response(null, { status })
    })
    vi.stubGlobal('fetch', f)
    return f
  }

  it('gửi POST rỗng tới endpoint với Authorization vapid t=…, k=…; TTL', async () => {
    const f = stub(201)
    expect(await sendPush(vapid, EP)).toBe('sent')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(EP)
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined() // không có nội dung → không cần mã hóa
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/)
    expect(h.Authorization.endsWith(`k=${vapid.VAPID_PUBLIC_KEY}`)).toBe(true)
    expect(h.TTL).toBe('3600')
    // aud = nguồn của endpoint
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(h.Authorization.split('t=')[1].split('.')[1])))
    expect(claims.aud).toBe('https://fcm.googleapis.com')
  })
  it('201/200/202 = sent', async () => {
    for (const s of [200, 201, 202]) {
      stub(s)
      expect(await sendPush(vapid, EP), String(s)).toBe('sent')
    }
  })
  it('404 / 410 = gone (đăng ký hết hiệu lực)', async () => {
    for (const s of [404, 410]) {
      stub(s)
      expect(await sendPush(vapid, EP), String(s)).toBe('gone')
    }
  })
  it('429 / 500 / 401 / lỗi mạng = failed (giữ lại, thử sau)', async () => {
    for (const s of [429, 500, 503, 401, 403]) {
      stub(s)
      expect(await sendPush(vapid, EP), String(s)).toBe('failed')
    }
    stub(new TypeError('network'))
    expect(await sendPush(vapid, EP)).toBe('failed')
  })
  it('endpoint không hợp lệ: không gọi mạng', async () => {
    const f = stub(201)
    expect(await sendPush(vapid, 'https://evil.example.com/x')).toBe('failed')
    expect(await sendPush(vapid, 'http://169.254.169.254/latest')).toBe('failed')
    expect(f).not.toHaveBeenCalled()
  })
  it('khóa VAPID hỏng: failed, không ném lỗi', async () => {
    stub(201)
    expect(await sendPush({ ...vapid, VAPID_PRIVATE_KEY: 'bad' }, EP)).toBe('failed')
  })
})

describe('đăng ký thiết bị qua API', () => {
  const subscribe = (body: unknown, authed = true) => call('/api/push/subscribe', { body }, authed)

  it('cần đăng nhập', async () => {
    expect((await subscribe(sub(), false)).status).toBe(401)
    expect((await call('/api/push/key', {}, false)).status).toBe(401)
    expect((await call('/api/push/test', { body: {} }, false)).status).toBe(401)
    expect(await devices()).toEqual([])
  })
  it('lấy khóa công khai VAPID; chưa cấu hình → 503', async () => {
    expect(await json(await call('/api/push/key'))).toEqual({ public_key: vapid.VAPID_PUBLIC_KEY })
    const r = await call('/api/push/key', {}, true, { ...env, VAPID_PUBLIC_KEY: '' } as Env)
    expect(r.status).toBe(503)
    expect((await json(r)).error).toBe('not_configured')
  })
  it('khóa riêng KHÔNG bao giờ lộ ra API', async () => {
    const text = await (await call('/api/push/key')).text()
    expect(text).not.toContain(vapid.VAPID_PRIVATE_KEY)
    expect(JSON.stringify(await json(await call('/api/settings')))).not.toContain(vapid.VAPID_PRIVATE_KEY)
  })
  it('đăng ký thiết bị → lưu', async () => {
    expect((await subscribe(sub())).status).toBe(200)
    const [d] = await devices()
    expect(d).toMatchObject({ endpoint: EP, p256dh: KEYS.p256dh, auth: KEYS.auth })
    expect((await json(await call('/api/settings'))).notifications.push_devices).toBe(1)
  })
  it('đăng ký lại cùng thiết bị: không tạo dòng trùng, cập nhật khóa', async () => {
    await subscribe(sub())
    await subscribe(sub({ keys: { p256dh: 'N'.repeat(40), auth: 'newauthkey123' } }))
    const rows = await devices()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ p256dh: 'N'.repeat(40), auth: 'newauthkey123' })
  })
  it('nhiều thiết bị khác nhau (điện thoại + máy tính)', async () => {
    await subscribe(sub())
    await subscribe(sub({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/zzz' }))
    expect(await devices()).toHaveLength(2)
  })
  it('đăng ký không hợp lệ → 400, không lưu', async () => {
    for (const bad of [sub({ endpoint: 'https://evil.com/x' }), sub({ keys: {} }), {}, null, 'x']) {
      expect((await subscribe(bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(await devices()).toEqual([])
  })
  it('hủy đăng ký', async () => {
    await subscribe(sub())
    const r = await call('/api/push/unsubscribe', { body: { endpoint: EP } })
    expect(await json(r)).toEqual({ ok: true, removed: true })
    expect(await devices()).toEqual([])
    expect(await json(await call('/api/push/unsubscribe', { body: { endpoint: EP } }))).toEqual({ ok: true, removed: false }) // lần hai: không có gì để xóa
    expect((await call('/api/push/unsubscribe', { body: {} })).status).toBe(400)
  })
})

describe('gửi tới mọi thiết bị', () => {
  const add = (endpoint: string) => db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, 'p', 'a', '2026-01-01')").bind(endpoint).run()
  const E1 = 'https://fcm.googleapis.com/fcm/send/one'
  const E2 = 'https://updates.push.services.mozilla.com/wpush/v2/two'
  const E3 = 'https://web.push.apple.com/three'

  it('không có thiết bị nào → không gọi mạng', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await pushToAll(env)).toEqual({ devices: 0, sent: 0, removed: 0, failed: 0 })
    expect(f).not.toHaveBeenCalled()
  })
  it('gửi hết các thiết bị; đếm kết quả', async () => {
    await add(E1)
    await add(E2)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })))
    expect(await pushToAll(env)).toEqual({ devices: 2, sent: 2, removed: 0, failed: 0 })
  })
  it('thiết bị hết hiệu lực (410) bị XÓA khỏi danh sách; lỗi tạm thời thì giữ lại', async () => {
    await add(E1)
    await add(E2)
    await add(E3)
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(null, { status: String(url).includes('one') ? 410 : String(url).includes('two') ? 500 : 201 })))
    expect(await pushToAll(env)).toEqual({ devices: 3, sent: 1, removed: 1, failed: 1 })
    expect((await devices()).map((d) => d.endpoint)).toEqual([E2, E3])
  })
  it('POST /api/push/test trả số liệu; chưa cấu hình → 503', async () => {
    await add(E1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })))
    expect(await json(await call('/api/push/test', { body: {} }))).toEqual({ devices: 1, sent: 1, removed: 0, failed: 0 })
    expect((await call('/api/push/test', { body: {} }, true, { ...env, VAPID_PRIVATE_KEY: '' } as Env)).status).toBe(503)
  })
})
