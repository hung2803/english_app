// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disablePush, enablePush, getPushState, isPushSupported, PushError, urlBase64ToUint8Array } from './push'
import Settings from './pages/Settings'

type Resp = { status?: number; body: unknown } | (() => { status?: number; body: unknown })
function server(routes: Record<string, Resp | Resp[]>) {
  const calls: { key: string; body?: any }[] = []
  const counts: Record<string, number> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
      calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined })
      const h = routes[key]
      if (!h) return Response.json({ message: 'không có route ' + key }, { status: 404 })
      const list = Array.isArray(h) ? h : [h]
      const one = list[Math.min(counts[key] ?? 0, list.length - 1)]
      counts[key] = (counts[key] ?? 0) + 1
      const r = typeof one === 'function' ? one() : one
      return Response.json(r.body, { status: r.status ?? 200 })
    }),
  )
  return { calls, count: (k: string) => calls.filter((c) => c.key === k).length, last: (k: string) => calls.filter((c) => c.key === k).at(-1)?.body }
}

/* ---- Trình duyệt giả: service worker + PushManager + Notification ---- */
interface FakeSub { endpoint: string; toJSON(): unknown; unsubscribe: ReturnType<typeof vi.fn> }
function installPush(opts: { permission?: NotificationPermission; request?: NotificationPermission; subscribed?: boolean; ua?: string; standalone?: boolean } = {}) {
  const sub: FakeSub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BKey1234567890', auth: 'authkey12345' } }),
    unsubscribe: vi.fn(async () => true),
  }
  let current: FakeSub | null = opts.subscribed ? sub : null
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (_o: unknown) => (current = sub)),
  }
  const reg = { pushManager }
  const sw = {
    register: vi.fn(async () => reg),
    getRegistration: vi.fn(async () => reg),
    ready: Promise.resolve(reg),
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true })
  ;(window as any).PushManager = class {}
  const N: any = class {}
  N.permission = opts.permission ?? 'default'
  N.requestPermission = vi.fn(async () => {
    N.permission = opts.request ?? 'granted'
    return N.permission
  })
  ;(window as any).Notification = N
  if (opts.ua) Object.defineProperty(navigator, 'userAgent', { value: opts.ua, configurable: true })
  if (opts.standalone !== undefined) Object.defineProperty(navigator, 'standalone', { value: opts.standalone, configurable: true })
  return { sub, pushManager, sw, N, setCurrent: (s: FakeSub | null) => (current = s) }
}
const removePush = () => {
  delete (navigator as any).serviceWorker
  delete (window as any).PushManager
  delete (window as any).Notification
}

const KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
const DATA = (over: Record<string, unknown> = {}, notif: Record<string, unknown> = {}) => ({
  body: {
    settings: { reminder_enabled: true, reminder_time: '20:00', ...over },
    notifications: { push_configured: true, push_devices: 0, email_configured: false, ...notif },
  },
})
const mount = () => render(<MemoryRouter><Settings /></MemoryRouter>)

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  removePush()
  delete (navigator as any).standalone
  delete (navigator as any).userAgent
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/* ================================================================== */
describe('push.ts — đăng ký thông báo đẩy trên trình duyệt', () => {
  it('urlBase64ToUint8Array: giải mã khóa VAPID (65 byte, bắt đầu bằng 0x04)', () => {
    const b = urlBase64ToUint8Array(KEY)
    expect(b).toHaveLength(65)
    expect(b[0]).toBe(4)
  })

  it('không hỗ trợ → isPushSupported false, trạng thái unsupported', async () => {
    expect(isPushSupported()).toBe(false)
    expect(await getPushState()).toMatchObject({ supported: false, permission: 'unsupported', subscribed: false })
  })

  it('trạng thái: chưa đăng ký / đã đăng ký; quyền thông báo hiện tại', async () => {
    installPush({ permission: 'default' })
    expect(await getPushState()).toMatchObject({ supported: true, permission: 'default', subscribed: false })
    removePush()
    installPush({ permission: 'granted', subscribed: true })
    expect(await getPushState()).toMatchObject({ permission: 'granted', subscribed: true })
  })

  it('bật: xin quyền → đăng ký service worker /sw.js → lấy khóa VAPID → subscribe(userVisibleOnly) → gửi cho máy chủ', async () => {
    const f = installPush()
    const s = server({ 'GET /push/key': { body: { public_key: KEY } }, 'POST /push/subscribe': { body: { ok: true } } })
    await enablePush()
    expect(f.N.requestPermission).toHaveBeenCalledTimes(1)
    expect(f.sw.register).toHaveBeenCalledWith('/sw.js')
    const opts = f.pushManager.subscribe.mock.calls[0][0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array }
    expect(opts.userVisibleOnly).toBe(true)
    expect(opts.applicationServerKey).toEqual(urlBase64ToUint8Array(KEY))
    expect(s.last('POST /push/subscribe')).toEqual({ endpoint: f.sub.endpoint, keys: { p256dh: 'BKey1234567890', auth: 'authkey12345' } })
  })

  it('đã có đăng ký sẵn trong trình duyệt: dùng lại, không subscribe lần nữa, vẫn báo máy chủ', async () => {
    const f = installPush({ subscribed: true })
    const s = server({ 'GET /push/key': { body: { public_key: KEY } }, 'POST /push/subscribe': { body: { ok: true } } })
    await enablePush()
    expect(f.pushManager.subscribe).not.toHaveBeenCalled()
    expect(s.count('POST /push/subscribe')).toBe(1)
  })

  it('người dùng từ chối quyền → PushError permission_denied, KHÔNG đăng ký gì', async () => {
    const f = installPush({ request: 'denied' })
    const s = server({})
    const err = await enablePush().catch((e) => e)
    expect(err).toBeInstanceOf(PushError)
    expect(err.code).toBe('permission_denied')
    expect(err.message).toContain('đã chặn thông báo')
    expect(f.sw.register).not.toHaveBeenCalled()
    expect(s.calls).toEqual([])
  })

  it('bỏ qua hộp xin quyền (default) → thông báo chưa cho phép', async () => {
    installPush({ request: 'default' })
    expect((await enablePush().catch((e) => e)).message).toContain('chưa cho phép')
  })

  it('máy chủ chưa cấu hình VAPID (503) → PushError failed kèm thông báo của máy chủ', async () => {
    installPush()
    server({ 'GET /push/key': { status: 503, body: { error: 'not_configured', message: 'Chưa cấu hình thông báo đẩy trên máy chủ.' } } })
    const err = await enablePush().catch((e) => e)
    expect(err).toBeInstanceOf(PushError)
    expect(err.code).toBe('failed')
    expect(err.message).toBe('Chưa cấu hình thông báo đẩy trên máy chủ.')
  })

  it('trình duyệt không hỗ trợ → PushError unsupported', async () => {
    const err = await enablePush().catch((e) => e)
    expect(err.code).toBe('unsupported')
  })

  it('iPhone chưa thêm vào Màn hình chính → hướng dẫn cài app', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', configurable: true })
    expect((await getPushState()).needsInstall).toBe(true)
    const err = await enablePush().catch((e) => e)
    expect(err.code).toBe('ios_install')
    expect(err.message).toContain('Màn hình chính')
  })

  it('iPhone đã mở từ Màn hình chính (standalone) thì không cần cài thêm', async () => {
    installPush({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', standalone: true })
    expect((await getPushState()).needsInstall).toBe(false)
  })

  it('tắt: báo máy chủ hủy thiết bị rồi hủy đăng ký ở trình duyệt', async () => {
    const f = installPush({ subscribed: true })
    const s = server({ 'POST /push/unsubscribe': { body: { ok: true, removed: true } } })
    await disablePush()
    expect(s.last('POST /push/unsubscribe')).toEqual({ endpoint: f.sub.endpoint })
    expect(f.sub.unsubscribe).toHaveBeenCalled()
  })

  it('tắt khi chưa đăng ký: không làm gì, không lỗi', async () => {
    installPush({ subscribed: false })
    const s = server({})
    await expect(disablePush()).resolves.toBeUndefined()
    expect(s.calls).toEqual([])
  })

  it('tắt: máy chủ lỗi → PushError, KHÔNG hủy ở trình duyệt (tránh lệch trạng thái)', async () => {
    const f = installPush({ subscribed: true })
    server({ 'POST /push/unsubscribe': { status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } } })
    await expect(disablePush()).rejects.toBeInstanceOf(PushError)
    expect(f.sub.unsubscribe).not.toHaveBeenCalled()
  })
})

/* ================================================================== */
describe('Cài đặt — giờ nhắc', () => {
  const timeInput = () => screen.getByLabelText(/Giờ nhắc/) as HTMLInputElement
  const saveBtn = () => screen.getByRole('button', { name: /^(Lưu|Đang lưu…)$/ }) as HTMLButtonElement
  const enabledBox = () => screen.getByLabelText('Bật nhắc học') as HTMLInputElement

  it('hiện cài đặt hiện tại: mặc định bật, 20:00; nút Lưu khóa khi chưa đổi gì', async () => {
    server({ 'GET /settings': DATA() })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    expect(enabledBox().checked).toBe(true)
    expect(timeInput().value).toBe('20:00')
    expect(saveBtn().disabled).toBe(true)
  })

  it('giải thích quy tắc: thứ 2–thứ 6, một lần mỗi ngày, không nhắc nếu đã học', async () => {
    server({ 'GET /settings': DATA() })
    mount()
    expect(await screen.findByText(/thứ 2–thứ 6, đúng một lần mỗi ngày, và không nhắc nếu hôm đó bạn đã học xong/)).toBeTruthy()
  })

  it('đổi giờ → Lưu gửi PUT đúng cả giờ lẫn trạng thái bật, báo đã lưu, khóa nút lại', async () => {
    const s = server({ 'GET /settings': DATA(), 'PUT /settings': DATA({ reminder_time: '07:30' }) })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    fireEvent.change(timeInput(), { target: { value: '07:30' } })
    expect(saveBtn().disabled).toBe(false)
    fireEvent.click(saveBtn())
    expect(await screen.findByText('✅ Đã lưu cài đặt nhắc học.')).toBeTruthy()
    expect(s.last('PUT /settings')).toEqual({ reminder_enabled: true, reminder_time: '07:30' })
    expect(saveBtn().disabled).toBe(true)
  })

  it('tắt nhắc: gửi reminder_enabled=false, ô giờ bị khóa', async () => {
    const s = server({ 'GET /settings': DATA(), 'PUT /settings': DATA({ reminder_enabled: false }) })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    fireEvent.click(enabledBox())
    expect(timeInput().disabled).toBe(true)
    fireEvent.click(saveBtn())
    await screen.findByText('✅ Đã lưu cài đặt nhắc học.')
    expect(s.last('PUT /settings')).toEqual({ reminder_enabled: false, reminder_time: '20:00' })
  })

  it('đang tắt sẵn: ô giờ khóa; bật lại thì mở', async () => {
    server({ 'GET /settings': DATA({ reminder_enabled: false }) })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    expect(enabledBox().checked).toBe(false)
    expect(timeInput().disabled).toBe(true)
    fireEvent.click(enabledBox())
    expect(timeInput().disabled).toBe(false)
  })

  it('đổi rồi đổi lại về giá trị cũ → nút Lưu khóa lại (không có gì để lưu)', async () => {
    server({ 'GET /settings': DATA() })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    fireEvent.change(timeInput(), { target: { value: '09:00' } })
    expect(saveBtn().disabled).toBe(false)
    fireEvent.change(timeInput(), { target: { value: '20:00' } })
    expect(saveBtn().disabled).toBe(true)
  })

  it('giờ trống/không hợp lệ: báo lỗi và khóa nút Lưu', async () => {
    const s = server({ 'GET /settings': DATA(), 'PUT /settings': DATA() })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    fireEvent.change(timeInput(), { target: { value: '' } })
    expect(screen.getByRole('alert').textContent).toBe('Hãy nhập giờ hợp lệ.')
    expect(saveBtn().disabled).toBe(true)
    expect(s.count('PUT /settings')).toBe(0)
  })

  it('lưu lỗi: thông báo + thử lại, giữ nguyên giá trị đang nhập', async () => {
    const s = server({ 'GET /settings': DATA(), 'PUT /settings': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, DATA({ reminder_time: '06:00' })] })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    fireEvent.change(timeInput(), { target: { value: '06:00' } })
    fireEvent.click(saveBtn())
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    expect(timeInput().value).toBe('06:00')
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('✅ Đã lưu cài đặt nhắc học.')).toBeTruthy()
    expect(s.count('PUT /settings')).toBe(2)
  })

  it('máy chủ từ chối giờ (400): hiện thông báo của máy chủ', async () => {
    server({ 'GET /settings': DATA(), 'PUT /settings': { status: 400, body: { error: 'bad_request', message: 'Giờ nhắc không hợp lệ (dạng HH:MM, từ 00:00 đến 23:59).' } } })
    mount()
    await screen.findByText('Nhắc học mỗi ngày')
    fireEvent.change(timeInput(), { target: { value: '09:00' } })
    fireEvent.click(saveBtn())
    expect(await screen.findByText(/Giờ nhắc không hợp lệ/)).toBeTruthy()
  })

  it('tải cài đặt lỗi → thông báo + thử lại', async () => {
    server({ 'GET /settings': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, DATA()] })
    mount()
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Nhắc học mỗi ngày')).toBeTruthy()
  })
})

describe('Cài đặt — thông báo đẩy trên thiết bị', () => {
  it('trình duyệt không hỗ trợ: nói rõ, không có nút bật', async () => {
    server({ 'GET /settings': DATA() })
    mount()
    expect(await screen.findByText('Trình duyệt này không hỗ trợ thông báo đẩy.')).toBeTruthy()
    expect(screen.queryByText('Bật thông báo')).toBeNull()
  })

  it('iPhone chưa cài app: hướng dẫn thêm vào Màn hình chính', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', configurable: true })
    server({ 'GET /settings': DATA() })
    mount()
    expect(await screen.findByText(/thêm ứng dụng vào Màn hình chính/)).toBeTruthy()
  })

  it('chưa đăng ký: nút "Bật thông báo"; bấm → đăng ký thiết bị và cập nhật trạng thái', async () => {
    installPush()
    const s = server({
      'GET /settings': [DATA(), DATA({}, { push_devices: 1 })],
      'GET /push/key': { body: { public_key: KEY } },
      'POST /push/subscribe': { body: { ok: true } },
    })
    mount()
    expect(await screen.findByText('Thiết bị này chưa nhận nhắc học.', { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByText('Bật thông báo'))
    expect(await screen.findByText('✅ Thiết bị này đang nhận nhắc học.', { exact: false })).toBeTruthy()
    expect(s.count('POST /push/subscribe')).toBe(1)
    expect(await screen.findByText(/Tổng số thiết bị đã đăng ký: 1/)).toBeTruthy()
    expect(screen.getByText('Tắt thông báo')).toBeTruthy()
    expect(screen.getByText('Gửi thử')).toBeTruthy()
  })

  it('bị chặn quyền: cảnh báo, nút Bật bị khóa', async () => {
    installPush({ permission: 'denied' })
    server({ 'GET /settings': DATA() })
    mount()
    expect(await screen.findByText(/Bạn đã chặn thông báo cho trang này/)).toBeTruthy()
    expect((screen.getByText('Bật thông báo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('máy chủ chưa cấu hình VAPID: cảnh báo, nút Bật bị khóa', async () => {
    installPush()
    server({ 'GET /settings': DATA({}, { push_configured: false }) })
    mount()
    expect(await screen.findByText(/Máy chủ chưa cấu hình thông báo đẩy/)).toBeTruthy()
    expect((screen.getByText('Bật thông báo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('người dùng từ chối ở hộp xin quyền: hiện thông báo lỗi tiếng Việt', async () => {
    installPush({ request: 'denied' })
    server({ 'GET /settings': DATA() })
    mount()
    fireEvent.click(await screen.findByText('Bật thông báo'))
    expect(await screen.findByText(/Bạn đã chặn thông báo/)).toBeTruthy()
  })

  it('đã đăng ký: "Tắt thông báo" hủy đăng ký', async () => {
    installPush({ subscribed: true, permission: 'granted' })
    const s = server({ 'GET /settings': [DATA({}, { push_devices: 1 }), DATA()], 'POST /push/unsubscribe': { body: { ok: true, removed: true } } })
    mount()
    fireEvent.click(await screen.findByText('Tắt thông báo'))
    await waitFor(() => expect(s.count('POST /push/unsubscribe')).toBe(1))
  })

  it('"Gửi thử": báo số thiết bị đã nhận', async () => {
    installPush({ subscribed: true, permission: 'granted' })
    server({ 'GET /settings': DATA({}, { push_devices: 2 }), 'POST /push/test': { body: { devices: 2, sent: 2, removed: 0, failed: 0 } } })
    mount()
    fireEvent.click(await screen.findByText('Gửi thử'))
    expect(await screen.findByText(/Đã gửi thử tới 2 thiết bị/)).toBeTruthy()
  })

  it('"Gửi thử" không thiết bị nào nhận được: báo không gửi được', async () => {
    installPush({ subscribed: true, permission: 'granted' })
    server({ 'GET /settings': DATA(), 'POST /push/test': { body: { devices: 1, sent: 0, removed: 0, failed: 1 } } })
    mount()
    fireEvent.click(await screen.findByText('Gửi thử'))
    expect(await screen.findByText('Không gửi được. Hãy thử lại sau.')).toBeTruthy()
  })
})

describe('Cài đặt — email tổng kết tuần', () => {
  it('chưa cấu hình: liệt kê các biến cần có, nói rõ vẫn xem được đề xuất trong app', async () => {
    server({ 'GET /settings': DATA() })
    mount()
    expect(await screen.findByText(/Chưa cấu hình email trên máy chủ/)).toBeTruthy()
    for (const k of ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO', 'APP_URL']) expect(screen.getByText(k)).toBeTruthy()
  })
  it('đã cấu hình: báo sẽ nhận email sau buổi thứ 5', async () => {
    server({ 'GET /settings': DATA({}, { email_configured: true }) })
    mount()
    expect(await screen.findByText(/Đã cấu hình\. Sau buổi thứ 5 của mỗi tuần/)).toBeTruthy()
  })
})

describe('service worker (public/sw.js)', () => {
  /** Chạy sw.js trong một "self" giả để kiểm tra các xử lý sự kiện. */
  async function loadSw() {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('public/sw.js', 'utf8')
    const listeners: Record<string, (e: any) => void> = {}
    const shown: { title: string; opts: any }[] = []
    const opened: string[] = []
    const focused: string[] = []
    const clientsList: any[] = []
    const self: any = {
      addEventListener: (t: string, fn: (e: any) => void) => (listeners[t] = fn),
      skipWaiting: vi.fn(),
      clients: {
        claim: vi.fn(),
        matchAll: vi.fn(async () => clientsList),
        openWindow: vi.fn(async (u: string) => void opened.push(u)),
      },
      registration: { showNotification: vi.fn(async (title: string, opts: any) => void shown.push({ title, opts })) },
    }
    new Function('self', src)(self)
    const waited: Promise<unknown>[] = []
    const ev = (extra: object = {}) => ({ waitUntil: (p: Promise<unknown>) => void waited.push(p), ...extra })
    return { listeners, shown, opened, focused, clientsList, self, ev, waited }
  }

  it('nhận push không kèm nội dung → hiện lời nhắc mặc định tiếng Việt', async () => {
    const sw = await loadSw()
    sw.listeners.push(sw.ev({ data: null }))
    await Promise.all(sw.waited)
    expect(sw.shown).toHaveLength(1)
    expect(sw.shown[0].title).toBe('English Coach')
    expect(sw.shown[0].opts.body).toContain('Đến giờ học tiếng Anh')
    expect(sw.shown[0].opts.tag).toBe('daily-reminder') // nhắc mới thay nhắc cũ, không chất đống
    expect(sw.shown[0].opts.icon).toBe('/icon.svg')
  })
  it('push có nội dung JSON {body} → dùng nội dung đó (cắt tối đa 200 ký tự); nội dung hỏng → dùng mặc định', async () => {
    const a = await loadSw()
    a.listeners.push(a.ev({ data: { json: () => ({ body: 'x'.repeat(500) }) } }))
    expect(a.shown[0]?.opts.body ?? (await Promise.all(a.waited), a.shown[0].opts.body)).toHaveLength(200)
    const b = await loadSw()
    b.listeners.push(b.ev({ data: { json: () => { throw new Error('not json') } } }))
    await Promise.all(b.waited)
    expect(b.shown[0].opts.body).toContain('Đến giờ học tiếng Anh')
  })
  it('bấm vào thông báo: mở app nếu chưa mở; đã mở thì đưa lên trước', async () => {
    const sw = await loadSw()
    const close = vi.fn()
    sw.listeners.notificationclick(sw.ev({ notification: { close, data: { url: '/' } } }))
    await Promise.all(sw.waited)
    expect(close).toHaveBeenCalled()
    expect(sw.opened).toEqual(['/'])

    const sw2 = await loadSw()
    const focus = vi.fn(async () => undefined)
    sw2.clientsList.push({ focus, navigate: vi.fn() })
    sw2.listeners.notificationclick(sw2.ev({ notification: { close: vi.fn(), data: { url: '/' } } }))
    await Promise.all(sw2.waited)
    expect(focus).toHaveBeenCalled()
    expect(sw2.opened).toEqual([])
  })
  it('cài đặt: kích hoạt ngay, chiếm quyền kiểm soát các tab', async () => {
    const sw = await loadSw()
    sw.listeners.install(sw.ev())
    expect(sw.self.skipWaiting).toHaveBeenCalled()
    sw.listeners.activate(sw.ev())
    expect(sw.self.clients.claim).toHaveBeenCalled()
  })
})
