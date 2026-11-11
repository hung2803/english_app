import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Btn, Card, ErrorBox, PageTitle, Spinner, fmtDate } from '../ui'

type Status = 'pending' | 'approved' | 'rejected' | 'no_change'
interface Change { week_no: number; topic: string; goal_vi: string; current_topic: string; current_goal_vi: string; can_apply: boolean }
interface Adjustment { id: number; week_no: number; summary_vi: string; status: Status; changes: Change[]; created_at: string; decided_at: string | null }
interface Decision { applied?: number[]; skipped?: number[] }

const BADGE: Record<Status, { label: string; cls: string }> = {
  pending: { label: 'Chờ duyệt', cls: 'bg-amber-100 text-amber-800' },
  approved: { label: 'Đã duyệt', cls: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Đã bỏ qua', cls: 'bg-slate-200 text-slate-700' },
  no_change: { label: 'Không cần đổi', cls: 'bg-sky-100 text-sky-800' },
}

function ChangeRow({ c, decided }: { c: Change; decided: boolean }) {
  return (
    <li className="rounded-xl border border-slate-200 p-3 text-sm">
      <p className="mb-1 text-xs font-semibold text-slate-500">Tuần {c.week_no}</p>
      <p className="text-slate-500 line-through decoration-slate-300">{c.current_topic}</p>
      <p className="font-semibold text-indigo-700">→ {c.topic}</p>
      <p className="mt-1 text-slate-600">{c.goal_vi}</p>
      {!decided && !c.can_apply && (
        <p className="mt-1 text-xs text-amber-700">Tuần này đã bắt đầu học nên sẽ không được đổi.</p>
      )}
    </li>
  )
}

function Item({ a, onChanged }: { a: Adjustment; onChanged: (msg: string) => void }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const pending = a.status === 'pending'
  const decided = !pending

  const decide = async (kind: 'approve' | 'reject') => {
    setBusy(kind)
    setError(null)
    try {
      const r = await api<Decision>(`/adjustments/${a.id}/${kind}`, {})
      if (kind === 'reject') onChanged('Đã giữ nguyên lộ trình cũ.')
      else {
        const n = r.applied?.length ?? 0
        const k = r.skipped?.length ?? 0
        onChanged(`Đã áp dụng thay đổi cho ${n} tuần${k ? ` (bỏ qua ${k} tuần đã bắt đầu học)` : ''}.`)
      }
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className={pending ? 'border-amber-300' : ''}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Tổng kết tuần {a.week_no}</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE[a.status].cls}`}>{BADGE[a.status].label}</span>
      </div>
      <p className="text-sm text-slate-700">{a.summary_vi}</p>

      {a.changes.length > 0 && (
        <>
          <p className="mb-2 mt-3 text-sm font-medium">{pending ? 'AI đề xuất đổi chủ đề:' : 'Các thay đổi đã đề xuất:'}</p>
          <ul className="space-y-2">
            {a.changes.map((c) => (
              <ChangeRow key={c.week_no} c={c} decided={decided} />
            ))}
          </ul>
        </>
      )}
      {a.status === 'no_change' && <p className="mt-2 text-sm text-slate-500">Kết quả tốt, AI không đề xuất thay đổi nào.</p>}

      {pending && (
        <>
          <p className="mt-3 text-xs text-slate-500">Nếu bạn không duyệt, lộ trình cũ được giữ nguyên.</p>
          {error != null && <div className="mt-2"><ErrorBox error={error} /></div>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Btn onClick={() => decide('approve')} disabled={busy !== null}>{busy === 'approve' ? 'Đang áp dụng…' : 'Duyệt & áp dụng'}</Btn>
            <Btn variant="ghost" onClick={() => decide('reject')} disabled={busy !== null}>{busy === 'reject' ? 'Đang lưu…' : 'Giữ lộ trình cũ'}</Btn>
          </div>
        </>
      )}
      {decided && a.decided_at && a.status !== 'no_change' && (
        <p className="mt-3 text-xs text-slate-500">Quyết định ngày {fmtDate(a.decided_at)}</p>
      )}
    </Card>
  )
}

export default function Adjustments() {
  const [list, setList] = useState<Adjustment[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    setError(null)
    api<{ adjustments: Adjustment[] }>('/adjustments').then((r) => setList(r.adjustments)).catch(setError)
  }, [])
  useEffect(load, [load])

  if (error && !list) return <ErrorBox error={error} onRetry={load} />
  if (!list) return <Spinner />

  const pending = list.filter((a) => a.status === 'pending')
  const history = list.filter((a) => a.status !== 'pending')

  return (
    <>
      <PageTitle title="Điều chỉnh lộ trình" hint="Cuối mỗi tuần AI xem điểm quiz và từ hay sai rồi đề xuất thay đổi chủ đề các tuần sau." />
      {notice && <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      {list.length === 0 && (
        <Card>
          <p className="text-sm text-slate-600">Chưa có đề xuất nào. Đề xuất đầu tiên sẽ xuất hiện sau khi bạn học xong buổi thứ 5 của tuần.</p>
          <div className="mt-3"><Link to="/roadmap"><Btn variant="ghost">Về lộ trình</Btn></Link></div>
        </Card>
      )}

      {pending.length > 0 && (
        <section className="mb-4 space-y-3" aria-label="Chờ duyệt">
          {pending.map((a) => (
            <Item key={a.id} a={a} onChanged={(m) => { setNotice(m); load() }} />
          ))}
        </section>
      )}

      {history.length > 0 && (
        <section className="space-y-3" aria-label="Lịch sử">
          <h2 className="text-sm font-semibold text-slate-500">Đã xử lý</h2>
          {history.map((a) => (
            <Item key={a.id} a={a} onChanged={() => load()} />
          ))}
        </section>
      )}
    </>
  )
}
