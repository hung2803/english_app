import type { Env } from './env'
import { isSafeUrl } from './link-check'

/** Dịch vụ đẩy tin của các trình duyệt (Chrome/Edge/Firefox/Safari). Chỉ nhận endpoint thuộc các miền này. */
const PUSH_HOST_SUFFIXES = ['googleapis.com', 'mozilla.com', 'mozaws.net', 'push.apple.com', 'windows.com']

export function isPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 1000 || !raw.startsWith('https://') || !isSafeUrl(raw)) return false
  const host = new URL(raw).hostname.toLowerCase()
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))
}

const b64urlToBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
const bytesToB64url = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const enc = new TextEncoder()
const jsonB64 = (o: unknown) => bytesToB64url(enc.encode(JSON.stringify(o)))

async function signingKey(env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'>): Promise<CryptoKey> {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY) // 0x04 | X(32) | Y(32)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY không hợp lệ')
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

/** JWT ES256 cho VAPID (RFC 8292): aud = nguồn của endpoint, hết hạn sau 12 giờ. */
export async function vapidJwt(env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>, audience: string, now = Date.now()): Promise<string> {
  const data = `${jsonB64({ typ: 'JWT', alg: 'ES256' })}.${jsonB64({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })}`
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(env), enc.encode(data)))
  return `${data}.${bytesToB64url(sig)}` // ECDSA của WebCrypto đã là dạng r||s 64 byte như JWS yêu cầu
}

export type PushOutcome = 'sent' | 'gone' | 'failed'

/**
 * Gửi MỘT thông báo đẩy không kèm nội dung (không cần mã hóa); service worker tự hiện lời nhắc cố định.
 * - 'sent': dịch vụ đẩy đã nhận;
 * - 'gone': đăng ký không còn hiệu lực (404/410) → bên gọi nên xóa;
 * - 'failed': lỗi tạm thời hoặc cấu hình sai → giữ lại, thử lần sau.
 */
export async function sendPush(env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>, endpoint: string, opts: { ttl?: number; now?: number } = {}): Promise<PushOutcome> {
  if (!isPushEndpoint(endpoint)) return 'failed'
  try {
    const jwt = await vapidJwt(env, new URL(endpoint).origin, opts.now)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { TTL: String(opts.ttl ?? 3600), Urgency: 'normal', Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, 'Content-Length': '0' },
      signal: AbortSignal.timeout(10_000),
    })
    await res.body?.cancel().catch(() => {})
    if (res.status === 404 || res.status === 410) return 'gone'
    return res.status >= 200 && res.status < 300 ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}

// ---------- Đăng ký thiết bị ----------

export interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

const KEY = /^[A-Za-z0-9_-]{8,200}$/

export function parseSubscription(raw: unknown): Subscription | null {
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
  if (!r || !isPushEndpoint(r.endpoint)) return null
  const { p256dh, auth } = r.keys ?? {}
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !KEY.test(p256dh) || !KEY.test(auth)) return null
  return { endpoint: r.endpoint, keys: { p256dh, auth } }
}

/** Lưu (hoặc cập nhật khóa của) một thiết bị; cùng endpoint thì không tạo dòng mới. */
export async function saveSubscription(db: D1Database, s: Subscription, today: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .bind(s.endpoint, s.keys.p256dh, s.keys.auth, today)
    .run()
}

export async function removeSubscription(db: D1Database, endpoint: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
  return ((r.meta as { changes?: number }).changes ?? 0) > 0
}

export interface PushSummary {
  devices: number
  sent: number
  removed: number
  failed: number
}

/** Gửi tới mọi thiết bị đã đăng ký; thiết bị hết hiệu lực (404/410) bị xóa khỏi danh sách. */
export async function pushToAll(env: Env): Promise<PushSummary> {
  const { results } = await env.DB.prepare('SELECT endpoint FROM push_subscriptions ORDER BY id').all<{ endpoint: string }>()
  const out: PushSummary = { devices: results.length, sent: 0, removed: 0, failed: 0 }
  const outcomes = await Promise.all(results.map((r) => sendPush(env, r.endpoint)))
  for (const [i, o] of outcomes.entries()) {
    if (o === 'sent') out.sent++
    else if (o === 'gone') {
      await removeSubscription(env.DB, results[i].endpoint)
      out.removed++
    } else out.failed++
  }
  return out
}
