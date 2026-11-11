import { api } from './api'

export type PushCode = 'unsupported' | 'ios_install' | 'permission_denied' | 'failed'

/** Lỗi bật/tắt thông báo đẩy, có thông báo tiếng Việt sẵn để hiển thị. */
export class PushError extends Error {
  constructor(
    public code: PushCode,
    message: string,
  ) {
    super(message)
  }
}

export interface PushState {
  supported: boolean
  permission: NotificationPermission | 'unsupported'
  /** thiết bị này đang đăng ký nhận nhắc */
  subscribed: boolean
  /** iPhone/iPad chỉ nhận được thông báo đẩy khi app đã được thêm vào Màn hình chính */
  needsInstall: boolean
}

export const isPushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
const isStandalone = () => (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true

export async function getPushState(): Promise<PushState> {
  const needsInstall = typeof navigator !== 'undefined' && isIos() && !isStandalone()
  if (!isPushSupported()) return { supported: false, permission: 'unsupported', subscribed: false, needsInstall }
  let subscribed = false
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    subscribed = (await reg?.pushManager.getSubscription()) != null
  } catch {
    subscribed = false
  }
  return { supported: true, permission: Notification.permission, subscribed, needsInstall }
}

/** Khóa VAPID (base64url) → Uint8Array cho applicationServerKey. */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '='))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/** Xin quyền, đăng ký service worker + PushManager bằng khóa VAPID của máy chủ, rồi báo máy chủ thiết bị này. */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) {
    if (isIos() && !isStandalone()) throw new PushError('ios_install', 'Trên iPhone/iPad, hãy thêm ứng dụng vào Màn hình chính (Chia sẻ → Thêm vào MH chính) rồi mở từ đó để bật thông báo.')
    throw new PushError('unsupported', 'Trình duyệt này không hỗ trợ thông báo đẩy.')
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new PushError('permission_denied', permission === 'denied' ? 'Bạn đã chặn thông báo. Hãy cho phép thông báo cho trang này trong cài đặt trình duyệt rồi thử lại.' : 'Bạn chưa cho phép thông báo.')
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    const { public_key } = await api<{ public_key: string }>('/push/key')
    const key = urlBase64ToUint8Array(public_key)
    let sub = await reg.pushManager.getSubscription()
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })
    await api('/push/subscribe', sub.toJSON())
  } catch (e) {
    if (e instanceof PushError) throw e
    throw new PushError('failed', e instanceof Error && e.message ? e.message : 'Không bật được thông báo. Hãy thử lại.')
  }
}

/** Hủy đăng ký thiết bị này (cả ở máy chủ lẫn trình duyệt). */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return
    await api('/push/unsubscribe', { endpoint: sub.endpoint })
    await sub.unsubscribe()
  } catch (e) {
    throw new PushError('failed', e instanceof Error && e.message ? e.message : 'Không tắt được thông báo. Hãy thử lại.')
  }
}
