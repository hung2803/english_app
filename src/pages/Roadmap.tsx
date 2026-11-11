import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../api'
import { Btn, Card, ErrorBox, PageTitle, Spinner, fmtDate } from '../ui'

type Status = 'pending' | 'done' | 'missed'
interface SessionView { id: number; seq: number; scheduled_date: string; status: Status; score: number | null }
interface WeekView { week_no: number; topic: string; goal_vi: string; done: number; total: number; sessions: SessionView[] }
interface PlanData {
  plan: { level: string; start_date: string; end_date: string; original_end_date: string; done: number; total: number; current_week: number | null; finished: boolean; extension_weeks: number; pending_adjustments: number; review: { state: 'need_retest' | 'passed' | 'failed'; required: string[]; weak: string[] } | null; today: string } | null
  has_placement?: boolean
  placement_level?: string | null
  weeks?: WeekView[]
}

const STATUS: Record<Status, { label: string; icon: string; cls: string }> = {
  done: { label: 'Đã xong', icon: '✅', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  missed: { label: 'Bị lỡ', icon: '⚠️', cls: 'border-amber-300 bg-amber-50 text-amber-800' },
  pending: { label: 'Chưa học', icon: '⚪', cls: 'border-slate-200 bg-white text-slate-600' },
}

const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const shortDate = (d: string) => `${WEEKDAY[new Date(d + 'T00:00:00Z').getUTCDay()]} ${d.slice(8, 10)}/${d.slice(5, 7)}`

const FALLBACK_NOTE: Record<string, string> = {
  rate: 'AI đang bận hoặc hết hạn mức',
  timeout: 'AI phản hồi quá lâu',
  config: 'chưa cấu hình khóa Gemini',
  other: 'AI gặp lỗi',
  invalid: 'AI trả nội dung chưa dùng được',
}

function SessionCell({ s, isToday, startable }: { s: SessionView; isToday: boolean; startable: boolean }) {
  const st = STATUS[s.status]
  const cell = (
    <>
      <p className="font-semibold">Buổi {s.seq}</p>
      <p className="text-[11px] opacity-80">{shortDate(s.scheduled_date)}</p>
      <p className="mt-1 text-base leading-none" aria-hidden>{st.icon}</p>
      <p className="mt-1">{s.status === 'done' ? (s.score !== null ? `${s.score}% · Xem lại` : 'Xem lại') : startable ? 'Học ngay' : st.label}</p>
    </>
  )
  return (
    <li className={`rounded-xl border p-2 text-center text-xs ${st.cls} ${isToday ? 'ring-2 ring-indigo-400' : ''}`} aria-label={`Buổi ${s.seq}: ${st.label}`}>
      {/* buổi tiếp theo: học ngay; buổi đã xong: mở lại xem bài, hội thoại, điểm */}
      {startable || s.status === 'done' ? <Link to={`/session/${s.id}`} className="block">{cell}</Link> : cell}
    </li>
  )
}

function Week({ w, current, today, nextId }: { w: WeekView; current: boolean; today: string; nextId: number | null }) {
  return (
    <details open={current} className={`rounded-2xl border bg-white shadow-sm ${current ? 'border-indigo-300' : 'border-slate-200'}`}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">
            Tuần {w.week_no}
            {current && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-700">Tuần này</span>}
          </p>
          <h2 className="font-semibold text-slate-900">{w.topic}</h2>
          <p className="text-sm text-slate-500">{w.goal_vi}</p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
          {w.done}/{w.total}
        </span>
      </summary>
      <ul className="grid grid-cols-5 gap-2 px-4 pb-4">
        {w.sessions.map((s) => (
          <SessionCell key={s.id} s={s} isToday={s.scheduled_date === today} startable={s.id === nextId} />
        ))}
      </ul>
    </details>
  )
}

const MAX_CUSTOM_CHARS = 20000 // trùng với giới hạn của máy chủ

const START_LEVELS = [
  { v: 'A0', label: 'Mới bắt đầu (A0)' },
  { v: 'A1', label: 'Cơ bản (A1)' },
  { v: 'A2', label: 'Sơ trung cấp (A2)' },
  { v: 'B1', label: 'Trung cấp (B1)' },
]

/** Tạo lộ trình đầu tiên: chọn mức bắt đầu (hoặc theo bài kiểm tra) và có thể nhập lộ trình riêng, mỗi dòng một tuần. */
function CreatePlan({ placementLevel, onDone, replace = false, defaultLevel = 'A0' }: { placementLevel: string | null; onDone: (note: string) => void; replace?: boolean; defaultLevel?: string }) {
  const [level, setLevel] = useState(placementLevel ? '' : defaultLevel) // '' = theo kết quả kiểm tra
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [open, setOpen] = useState(false)
  // xem trước: máy chủ đọc văn bản/Markdown thành các tuần để người học kiểm tra trước khi tạo
  const [preview, setPreview] = useState<{ weeks: { topic: string; goal_vi: string }[]; to_fill: number } | { error: string } | null>(null)

  useEffect(() => {
    if (!custom.trim()) {
      setPreview(null)
      return
    }
    let stale = false
    const t = setTimeout(() => {
      api<{ weeks: { topic: string; goal_vi: string }[]; to_fill: number }>('/plan/preview', { custom })
        .then((r) => !stale && setPreview(r))
        .catch((e) => !stale && setPreview(e instanceof ApiError && e.status === 400 ? { error: e.message } : null))
    }, 400)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [custom])

  const invalid = preview !== null && 'error' in preview

  const loadFile = (file: File | undefined) => {
    setFileError('')
    if (!file) return
    if (file.size > 100_000) {
      setFileError('File quá lớn cho một lộ trình (tối đa khoảng 100 KB văn bản).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      if (text.length > MAX_CUSTOM_CHARS) {
        setFileError(`File quá dài (tối đa ${MAX_CUSTOM_CHARS} ký tự).`)
        return
      }
      setCustom(text)
      setFileName(file.name)
      setOpen(true)
    }
    reader.onerror = () => setFileError('Không đọc được file này.')
    reader.readAsText(file)
  }
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ source: 'ai' | 'default' | 'custom'; filled_weeks?: number; fallback_reason?: string }>('/plan', {
        ...(level ? { level } : {}),
        ...(custom.trim() ? { custom } : {}),
        ...(replace ? { replace: true } : {}),
      })
      const filler = r.fallback_reason ? ` (phần nối thêm dùng bộ chủ đề mặc định: ${FALLBACK_NOTE[r.fallback_reason] ?? 'AI gặp lỗi'})` : ''
      onDone(
        r.source === 'custom'
          ? r.filled_weeks
            ? `Đã tạo lộ trình theo chủ đề của bạn; ${r.filled_weeks} tuần cuối được nối thêm cho đủ 12 tuần${filler}.`
            : 'Đã tạo lộ trình theo đúng 12 chủ đề của bạn.'
          : r.source === 'default'
            ? `Đã tạo lộ trình bằng bộ chủ đề mặc định (${FALLBACK_NOTE[r.fallback_reason ?? 'other']}).`
            : '',
      )
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Lộ trình gồm 12 tuần (60 buổi, thứ 2–thứ 6). AI soạn bài và tài liệu cho từng buổi theo chủ đề của tuần đó.</p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Mức bắt đầu</span>
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">
          {placementLevel && <option value="">Theo bài kiểm tra của tôi ({placementLevel})</option>}
          {START_LEVELS.map((l) => (
            <option key={l.v} value={l.v}>{l.label}</option>
          ))}
        </select>
      </label>
      <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-xl border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Tôi đã có lộ trình riêng (không bắt buộc)</summary>
        <div className="mt-3 space-y-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Nạp từ file Markdown (.md) hoặc văn bản (.txt)</span>
            <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = '' }} className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-11 file:rounded-xl file:border-0 file:bg-indigo-50 file:px-4 file:font-medium file:text-indigo-700" />
          </label>
          {fileName && !fileError && <p className="text-xs text-slate-500">Đã nạp file <strong>{fileName}</strong>. Bạn có thể sửa nội dung bên dưới.</p>}
          {fileError && <p role="alert" className="text-sm text-rose-700">{fileError}</p>}
          <label className="block text-sm">
            <span className="mb-1 block text-slate-600">Hoặc gõ trực tiếp: mỗi dòng một tuần, tối đa 12 tuần, có thể ghi <code>Chủ đề | Mục tiêu</code>. File Markdown được đọc theo "Tuần N", bảng hoặc tiêu đề. Thiếu tuần nào AI nối thêm cho đủ 12.</span>
            <textarea
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              rows={7}
              maxLength={MAX_CUSTOM_CHARS}
              placeholder={'Greetings | Chào hỏi\nNumbers & time\nFood & drinks'}
              className="w-full rounded-xl border border-slate-300 p-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </label>
          {preview && 'error' in preview && <p role="alert" className="text-sm text-rose-700">{preview.error}</p>}
          {preview && 'weeks' in preview && (
            <div className="rounded-xl bg-slate-50 p-3 text-sm" aria-label="Các tuần đọc được">
              <p className="mb-1 font-medium text-slate-700">Đọc được {preview.weeks.length} tuần{preview.to_fill > 0 ? ` — AI sẽ nối thêm ${preview.to_fill} tuần` : ''}:</p>
              <ol className="list-decimal space-y-0.5 pl-5 text-slate-700">
                {preview.weeks.map((w, i) => (
                  <li key={i}>{w.topic}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </details>
      <Btn onClick={submit} disabled={busy || invalid || (!level && !placementLevel)}>{busy ? 'Đang tạo lộ trình…' : 'Tạo lộ trình'}</Btn>
      {error != null && <ErrorBox error={error} onRetry={submit} />}
      {!placementLevel && !replace && (
        <p className="text-sm text-slate-500">
          Chưa biết mình ở mức nào? <Link to="/placement" className="font-medium text-indigo-700 underline">Làm bài kiểm tra trình độ</Link>
        </p>
      )}
    </div>
  )
}

export default function Roadmap() {
  const [data, setData] = useState<PlanData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    setError(null)
    api<PlanData>('/plan').then(setData).catch(setError)
  }, [])
  useEffect(load, [load])

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      const r = await api<{ source: 'ai' | 'default'; fallback_reason?: string }>('/plan', {})
      setNote(r.source === 'default' ? `Đã tạo lộ trình bằng bộ chủ đề mặc định (${FALLBACK_NOTE[r.fallback_reason ?? 'other']}).` : '')
      load()
    } catch (e) {
      setError(e)
    } finally {
      setCreating(false)
    }
  }

  const extend = async () => {
    setCreating(true)
    setError(null)
    try {
      const r = await api<{ added_weeks: number; source: 'ai' | 'default'; fallback_reason?: string }>('/plan/extend', {})
      setNote(r.source === 'default' ? `Đã thêm ${r.added_weeks} tuần ôn bằng chủ đề mặc định (${FALLBACK_NOTE[r.fallback_reason ?? 'other']}).` : '')
      load()
    } catch (e) {
      setError(e)
    } finally {
      setCreating(false)
    }
  }

  if (error && !data) return <ErrorBox error={error} onRetry={load} />
  if (!data) return <Spinner />

  if (!data.plan) {
    return (
      <>
        <PageTitle title="Lộ trình" hint="Chủ đề 12 tuần và trạng thái từng buổi" />
        <Card className="space-y-3">
          <CreatePlan placementLevel={data.placement_level ?? null} onDone={(n) => { setNote(n); load() }} />
        </Card>
      </>
    )
  }

  const { plan, weeks = [] } = data
  const nextId = weeks.flatMap((w) => w.sessions).find((x) => x.status !== 'done')?.id ?? null // chỉ buổi tiếp theo mới học được
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0

  return (
    <>
      <PageTitle title="Lộ trình" hint={`Trình độ ${plan.level} · ${fmtDate(plan.start_date)} → ${fmtDate(plan.end_date)}${plan.extension_weeks ? ` · gồm ${plan.extension_weeks} tuần ôn tập thêm` : ''}`} />
      {plan.pending_adjustments > 0 && (
        <Card className="mb-3 flex items-center justify-between gap-3 border-amber-300 bg-amber-50">
          <p className="text-sm text-amber-900">
            📝 Có <strong>{plan.pending_adjustments}</strong> đề xuất điều chỉnh lộ trình đang chờ bạn duyệt.
          </p>
          <Link to="/adjustments"><Btn>Xem và duyệt</Btn></Link>
        </Card>
      )}
      {plan.finished && plan.review && (
        <Card className={`mb-3 space-y-3 ${plan.review.state === 'failed' ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`}>
          {plan.review.state === 'need_retest' && (
            <>
              <h2 className="font-semibold text-emerald-900">🎉 Bạn đã học xong lộ trình!</h2>
              <p className="text-sm text-emerald-900">
                Hãy làm lại bài kiểm tra trình độ. Để sang lộ trình mới, bạn cần đúng <strong>100%</strong> số câu ở các mức <strong>{plan.review.required.join(', ')}</strong>.
                Nếu chưa đạt, bạn sẽ học thêm 2 tuần ôn tập.
              </p>
              <Link to="/placement"><Btn>Làm lại bài kiểm tra</Btn></Link>
            </>
          )}
          {plan.review.state === 'passed' && (
            <>
              <h2 className="font-semibold text-emerald-900">✅ Bạn đã đạt yêu cầu!</h2>
              <p className="text-sm text-emerald-900">Bài kiểm tra lại đúng 100% các mức {plan.review.required.join(', ')}. AI sẽ lập lộ trình mới theo kết quả mới nhất.</p>
              <Btn onClick={create} disabled={creating}>{creating ? 'Đang tạo lộ trình mới…' : 'Tạo lộ trình mới'}</Btn>
            </>
          )}
          {plan.review.state === 'failed' && (
            <>
              <h2 className="font-semibold text-amber-900">Chưa đạt yêu cầu, cần ôn tập thêm</h2>
              <p className="text-sm text-amber-900">
                Cần đúng 100% câu ở các mức {plan.review.required.join(', ')}. Mức chưa đạt: <strong>{plan.review.weak.join(', ')}</strong>.
                AI sẽ thêm 2 tuần ôn tập vào cuối lộ trình, học xong bạn làm lại bài kiểm tra.
              </p>
              <Btn onClick={extend} disabled={creating}>{creating ? 'Đang soạn tuần ôn tập…' : 'Thêm 2 tuần ôn tập'}</Btn>
            </>
          )}
          {error != null && <ErrorBox error={error} onRetry={plan.review.state === 'failed' ? extend : create} />}
        </Card>
      )}
      {!plan.finished && plan.extension_weeks === 0 && plan.end_date > plan.original_end_date && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Bạn có buổi bị lỡ nên lịch đã tự dời. Ngày kết thúc mới: <strong>{fmtDate(plan.end_date)}</strong> (lịch ban đầu: {fmtDate(plan.original_end_date)}).
        </div>
      )}
      {note && <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{note}</div>}

      <Card className="mb-3">
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <span className="font-medium">Đã xong {plan.done}/{plan.total} buổi</span>
          <span className="text-slate-500">{pct}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-indigo-600" style={{ width: `${pct}%` }} />
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Chú thích trạng thái">
          {(Object.keys(STATUS) as Status[]).map((k) => (
            <li key={k}><span aria-hidden>{STATUS[k].icon}</span> {STATUS[k].label}</li>
          ))}
        </ul>
      </Card>

      <div className="space-y-3">
        {weeks.map((w) => (
          <Week key={w.week_no} w={w} current={w.week_no === plan.current_week} today={plan.today} nextId={nextId} />
        ))}
      </div>

      {!plan.finished && (
        <details className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">Tạo lại lộ trình (đổi mức bắt đầu hoặc dùng lộ trình riêng)</summary>
          <div className="mt-3 space-y-3">
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Lộ trình mới sẽ <strong>thay thế</strong> lộ trình hiện tại và bắt đầu lại từ buổi 1. Các buổi bạn đã học xong vẫn xem lại được trong Lịch sử.
            </p>
            <CreatePlan placementLevel={null} defaultLevel={plan.level} replace onDone={(n) => { setNote(n); load() }} />
          </div>
        </details>
      )}
    </>
  )
}
