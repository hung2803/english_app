import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Env } from './env'

export const COOKIE_NAME = 'ea_session'
export const SESSION_DAYS = 30
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000

const enc = new TextEncoder()

function b64url(buf: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

/** So sánh chuỗi không dừng sớm, tránh lộ thông tin qua thời gian phản hồi. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Token = "<hạn dùng (ms)>.<HMAC-SHA256 của hạn dùng>" */
export async function makeToken(secret: string, now = Date.now()): Promise<string> {
  const exp = String(now + SESSION_MS)
  return `${exp}.${await hmac(secret, 'session:' + exp)}`
}

export async function verifyToken(secret: string, token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!secret || !token) return false
  const dot = token.indexOf('.')
  if (dot < 1) return false
  const exp = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!/^\d+$/.test(exp) || Number(exp) <= now) return false
  return safeEqual(sig, await hmac(secret, 'session:' + exp))
}

/** So mật khẩu qua HMAC để độ dài mật khẩu không bị lộ và so sánh thời gian cố định. */
export async function checkPassword(env: Pick<Env, 'APP_PASSWORD' | 'SESSION_SECRET'>, given: string): Promise<boolean> {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) return false
  const [a, b] = await Promise.all([hmac(env.SESSION_SECRET, 'pw:' + given), hmac(env.SESSION_SECRET, 'pw:' + env.APP_PASSWORD)])
  return safeEqual(a, b)
}

type Ctx = Context<{ Bindings: Env }>

export async function startSession(c: Ctx) {
  const https = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
  setCookie(c, COOKIE_NAME, await makeToken(c.env.SESSION_SECRET), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: https,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  })
}

export async function isLoggedIn(c: Ctx): Promise<boolean> {
  return verifyToken(c.env.SESSION_SECRET, getCookie(c, COOKIE_NAME))
}

export function endSession(c: Ctx) {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}

/** Chặn mọi route đăng ký sau nó nếu chưa đăng nhập. */
export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await isLoggedIn(c))) return c.json({ error: 'unauthorized', message: 'Hãy đăng nhập để tiếp tục.' }, 401)
  await next()
}
