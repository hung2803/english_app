import { describe, expect, it } from 'vitest'
import app from './index'
import { makeToken, verifyToken, SESSION_DAYS } from './auth'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
const env = { APP_PASSWORD: 'mat-khau', SESSION_SECRET: SECRET } as Env
const DAY = 24 * 3600 * 1000

const login = (password: string, e: Env = env, headers: Record<string, string> = {}) =>
  app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ password }) }, e)

const cookieOf = (r: Response) => r.headers.get('set-cookie') ?? ''
const tokenOf = (r: Response) => cookieOf(r).match(/ea_session=([^;]+)/)?.[1]

describe('bảo vệ API + đăng xuất', () => {
  const get = (path: string, token?: string) =>
    app.request(path, { headers: token ? { cookie: `ea_session=${token}` } : {} }, { ...env, DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) } } as unknown as Env)

  it('chưa đăng nhập: API thường và đường dẫn lạ đều 401', async () => {
    for (const p of ['/api/health', '/api/plan', '/api/khong-ton-tai']) {
      const r = await get(p)
      expect(r.status).toBe(401)
      expect(await r.json()).toMatchObject({ error: 'unauthorized' })
    }
  })
  it('cookie giả bị 401', async () => {
    expect((await get('/api/health', '999999999999999.fake')).status).toBe(401)
  })
  it('đã đăng nhập: API thường chạy được, đường dẫn lạ → 404', async () => {
    const token = tokenOf(await login('mat-khau'))
    expect((await get('/api/health', token)).status).toBe(200)
    expect((await get('/api/khong-ton-tai', token)).status).toBe(404)
  })
  it('login / me / logout luôn công khai', async () => {
    expect((await login('sai')).status).toBe(401) // 401 do sai mật khẩu, không phải do middleware
    expect((await get('/api/me')).status).toBe(200)
    expect((await app.request('/api/logout', { method: 'POST' }, env)).status).toBe(200)
  })
  it('logout xóa cookie (Max-Age=0)', async () => {
    const r = await app.request('/api/logout', { method: 'POST' }, env)
    const c = cookieOf(r)
    expect(c).toContain('ea_session=')
    expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })
})

describe('token HMAC', () => {
  it('token hợp lệ được chấp nhận', async () => {
    expect(await verifyToken(SECRET, await makeToken(SECRET))).toBe(true)
  })
  it('hạn 30 ngày: còn hiệu lực ở ngày 29, hết hiệu lực sau ngày 30', async () => {
    const t0 = 1_700_000_000_000
    const token = await makeToken(SECRET, t0)
    expect(await verifyToken(SECRET, token, t0 + 29 * DAY)).toBe(true)
    expect(await verifyToken(SECRET, token, t0 + 30 * DAY + 1)).toBe(false)
  })
  it('sửa hạn dùng thì chữ ký không còn khớp', async () => {
    const [exp, sig] = (await makeToken(SECRET)).split('.')
    expect(await verifyToken(SECRET, `${Number(exp) + 10 * DAY}.${sig}`)).toBe(false)
  })
  it('sai khóa bí mật bị từ chối', async () => {
    expect(await verifyToken('khac-secret', await makeToken(SECRET))).toBe(false)
  })
  it('token rác / rỗng / thiếu secret bị từ chối', async () => {
    for (const t of [undefined, '', 'abc', '.', 'x.y', '123.', '.sig']) expect(await verifyToken(SECRET, t)).toBe(false)
    expect(await verifyToken('', await makeToken(SECRET))).toBe(false)
  })
})

describe('POST /api/login + GET /api/me', () => {
  it('đúng mật khẩu → cookie HttpOnly, SameSite=Lax, Max-Age 30 ngày', async () => {
    const r = await login('mat-khau')
    expect(r.status).toBe(200)
    const c = cookieOf(r)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/')
    expect(c).toContain(`Max-Age=${SESSION_DAYS * 24 * 3600}`)
  })
  it('cookie nhận được dùng để /api/me trả authed=true', async () => {
    const token = tokenOf(await login('mat-khau'))
    const me = await app.request('/api/me', { headers: { cookie: `ea_session=${token}` } }, env)
    expect(await me.json()).toEqual({ authed: true })
  })
  it('không cookie hoặc cookie giả → authed=false', async () => {
    expect(await (await app.request('/api/me', {}, env)).json()).toEqual({ authed: false })
    const fake = await app.request('/api/me', { headers: { cookie: 'ea_session=999999999999999.abc' } }, env)
    expect(await fake.json()).toEqual({ authed: false })
  })
  it('sai mật khẩu → 401, không cấp cookie', async () => {
    const r = await login('sai')
    expect(r.status).toBe(401)
    expect(cookieOf(r)).toBe('')
  })
  it('không khóa: sai nhiều lần vẫn đăng nhập đúng được', async () => {
    for (let i = 0; i < 12; i++) expect((await login('sai-' + i)).status).toBe(401)
    expect((await login('mat-khau')).status).toBe(200)
  })
  it('thiếu cấu hình (APP_PASSWORD rỗng) → không ai vào được, kể cả mật khẩu rỗng', async () => {
    const bad = { ...env, APP_PASSWORD: '' } as Env
    expect((await login('', bad)).status).toBe(401)
    expect((await login('bat-ky', bad)).status).toBe(401)
  })
  it('body hỏng → 401, không lỗi 500', async () => {
    const r = await app.request('/api/login', { method: 'POST', body: 'not json' }, env)
    expect(r.status).toBe(401)
  })
  it('qua HTTPS (proxy/tunnel) cookie có Secure', async () => {
    const r = await login('mat-khau', env, { 'x-forwarded-proto': 'https' })
    expect(cookieOf(r)).toContain('Secure')
  })
})
