import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { disablePush, enablePush, getPushState, type PushState } from '../push'
import { Btn, Card, ErrorBox, PageTitle, Spinner } from '../ui'

interface Data {
  settings: { reminder_enabled: boolean; reminder_time: string }
  notifications: { push_configured: boolean; push_devices: number; email_configured: boolean }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function Reminder({ initial, onSaved }: { initial: Data['settings']; onSaved: (s: Data['settings']) => void }) {
  const [enabled, setEnabled] = useState(initial.reminder_enabled)
  const [time, setTime] = useState(initial.reminder_time)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)

  const dirty = enabled !== initial.reminder_enabled || time !== initial.reminder_time
  const valid = TIME.test(time)

  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const r = await api<Data>('/settings', { reminder_enabled: enabled, reminder_time: time }, { method: 'PUT' })
      onSaved(r.settings)
      setSaved(true)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Nhắc học mỗi ngày</h2>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false) }} className="h-5 w-5" />
        <span className="text-sm">Bật nhắc học</span>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Giờ nhắc (giờ Việt Nam)</span>
        <input
          type="time"
          value={time}
          disabled={!enabled}
          onChange={(e) => { setTime(e.target.value); setSaved(false) }}
          className="min-h-11 rounded-xl border border-slate-300 px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100 disabled:text-slate-400"
        />
      </label>
      <p className="text-xs text-slate-500">Nhắc vào thứ 2–thứ 6, đúng một lần mỗi ngày, và không nhắc nếu hôm đó bạn đã học xong một buổi.</p>
      {!valid && enabled && <p role="alert" className="text-sm text-rose-700">Hãy nhập giờ hợp lệ.</p>}
      {error != null && <ErrorBox error={error} onRetry={() => void save()} />}
      {saved && !dirty && <p role="status" className="text-sm text-emerald-700">✅ Đã lưu cài đặt nhắc học.</p>}
      <Btn onClick={() => void save()} disabled={busy || !dirty || !valid}>{busy ? 'Đang lưu…' : 'Lưu'}</Btn>
    </Card>
  )
}

function Push({ configured, devices, onChanged }: { configured: boolean; devices: number; onChanged: () => void }) {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(() => void getPushState().then(setState), [])
  useEffect(refresh, [refresh])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      await fn()
      refresh()
      onChanged()
    } catch (e) {
      setError(e)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const test = () =>
    run(async () => {
      const r = await api<{ devices: number; sent: number; removed: number; failed: number }>('/push/test', {})
      setNotice(r.sent > 0 ? `Đã gửi thử tới ${r.sent} thiết bị. Nếu chưa thấy thông báo, hãy kiểm tra cài đặt thông báo của trình duyệt.` : r.devices === 0 ? 'Chưa có thiết bị nào đăng ký.' : 'Không gửi được. Hãy thử lại sau.')
    })

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Thông báo trên thiết bị này</h2>
      {!state ? (
        <Spinner />
      ) : (
        <>
          {!configured && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Máy chủ chưa cấu hình thông báo đẩy (thiếu khóa VAPID), nên chưa bật được.</p>}
          {!state.supported && <p className="text-sm text-slate-600">{state.needsInstall ? 'Trên iPhone/iPad, hãy thêm ứng dụng vào Màn hình chính (Chia sẻ → Thêm vào MH chính) rồi mở từ đó để bật thông báo.' : 'Trình duyệt này không hỗ trợ thông báo đẩy.'}</p>}
          {state.supported && state.permission === 'denied' && <p className="text-sm text-rose-700">Bạn đã chặn thông báo cho trang này. Hãy cho phép trong cài đặt trình duyệt rồi tải lại trang.</p>}
          {state.supported && (
            <p className="text-sm text-slate-700">
              {state.subscribed ? '✅ Thiết bị này đang nhận nhắc học.' : 'Thiết bị này chưa nhận nhắc học.'} <span className="text-slate-500">(Tổng số thiết bị đã đăng ký: {devices})</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {state.supported && !state.subscribed && (
              <Btn onClick={() => run(enablePush)} disabled={busy || !configured || state.permission === 'denied'}>{busy ? 'Đang bật…' : 'Bật thông báo'}</Btn>
            )}
            {state.supported && state.subscribed && (
              <>
                <Btn variant="ghost" onClick={() => run(disablePush)} disabled={busy}>Tắt thông báo</Btn>
                <Btn variant="ghost" onClick={test} disabled={busy}>Gửi thử</Btn>
              </>
            )}
          </div>
          {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
          {error != null && <ErrorBox error={error} />}
        </>
      )}
    </Card>
  )
}

export default function Settings() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(() => {
    setError(null)
    api<Data>('/settings').then(setData).catch(setError)
  }, [])
  useEffect(load, [load])

  if (error != null && !data) return <ErrorBox error={error} onRetry={load} />
  if (!data) return <Spinner />

  return (
    <>
      <PageTitle title="Cài đặt" hint="Nhắc học và thông báo." />
      <div className="space-y-3">
        <Reminder initial={data.settings} onSaved={(s) => setData((d) => (d ? { ...d, settings: s } : d))} />
        <Push configured={data.notifications.push_configured} devices={data.notifications.push_devices} onChanged={load} />
        <Card className="space-y-2">
          <h2 className="font-semibold">Email tổng kết tuần</h2>
          {data.notifications.email_configured ? (
            <p className="text-sm text-emerald-700">✅ Đã cấu hình. Sau buổi thứ 5 của mỗi tuần, bạn sẽ nhận email tổng kết kèm đề xuất điều chỉnh lộ trình.</p>
          ) : (
            <p className="text-sm text-slate-600">Chưa cấu hình email trên máy chủ (cần <code>RESEND_API_KEY</code>, <code>EMAIL_FROM</code>, <code>EMAIL_TO</code>, <code>APP_URL</code>). Đề xuất điều chỉnh vẫn xem được trong ứng dụng.</p>
          )}
        </Card>
      </div>
    </>
  )
}
