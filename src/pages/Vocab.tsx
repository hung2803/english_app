import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Btn, Card, ErrorBox, PageTitle, Speak, Spinner, fmtDate } from '../ui'
import { MASTERY_LABELS, MASTERY_LEVELS, vocabMastery, type MasteryLevel } from '../../shared/vocab-mastery'

interface Item {
  recognized_on?: string | null
  learning_state?: 'available' | 'queued' | 'active'
  typed_streak?: number
  mastery_started_on?: string | null
  lapses?: number
  session_id?: number | null
  id: number
  word: string
  pos: string | null
  meaning: string
  example: string | null
  due_date: string
  learned: 0 | 1
  wrong_count: number
}
interface VocabPage {
  items: Item[]
  matched: number
  page: number
  page_size: number
  stats: { total: number; learned: number; due: number; queued?: number; quota?: { cap: number; done: number; due: number; shown: number; backlog: number } }
}

type Filter = 'all' | 'due' | 'learning' | 'learned' | 'queued'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'due', label: 'Đến hạn ôn' },
  { key: 'learning', label: 'Đang học' },
  { key: 'learned', label: 'Đã thuộc' },
  { key: 'queued', label: 'Đã chọn, chờ học' },
]

const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10) // giờ Việt Nam

function Row({ v }: { v: Item }) {
  const memory = vocabMastery(v, today())
  const queued = v.learning_state === 'queued'
  const due = !queued && v.due_date <= today()
  const color = memory.level === 'learned' ? 'bg-emerald-100 text-emerald-800'
    : memory.level === 'relearn' ? 'bg-rose-100 text-rose-800'
      : memory.level === 'almost' ? 'bg-sky-100 text-sky-800' : 'bg-indigo-50 text-indigo-700'
  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold text-indigo-700">{v.word}</span>
        {v.pos && <span className="text-xs text-slate-500">({v.pos})</span>}
        <Speak text={v.word} />
        <span className="ml-auto flex flex-wrap gap-1 text-xs">
          <span className={`rounded-full px-2 py-0.5 font-medium ${color}`}>{memory.label}</span>
          {due && v.learned !== 1 && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">Đến hạn</span>}
          {v.wrong_count > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-800">sai {v.wrong_count} lần</span>}
        </span>
      </div>
      <p className="text-sm text-slate-800">{v.meaning}</p>
      {v.example && (
        <p className="mt-1 flex items-center gap-2 text-sm italic text-slate-500">
          <span>{v.example}</span>
          <Speak text={v.example} label="Nghe câu ví dụ" />
        </p>
      )}
      <p className="mt-1 text-xs text-slate-400">{queued ? 'Chờ đến lượt · tối đa 5 từ mới mỗi ngày' : due ? 'Ôn hôm nay' : `Ôn lại: ${fmtDate(v.due_date)}`}</p>
      {!queued && <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-slate-600">Tiến độ đến “Đã thuộc”</span>
          <span className="font-semibold text-indigo-700">{memory.progress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label={`Tiến độ ghi nhớ: ${v.word}`} aria-valuenow={memory.progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${memory.level === 'learned' ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${memory.progress}%` }} />
        </div>
        <p className="text-xs text-slate-500">{memory.level === 'learned' ? 'Đã thuộc · tiếp tục ôn theo lịch để giữ trí nhớ.' : `Nhớ đúng ${memory.days}/3 ngày khác nhau · Đã theo dõi ${memory.span}/7 ngày`}</p>
        {memory.level === 'recognized' && <p className="text-xs text-indigo-700">Đã chọn đúng nghĩa · bước tiếp theo là tự gõ để kiểm tra trí nhớ.</p>}
        {memory.days === 3 && memory.span === 7 && !v.learned && <p className="text-xs text-indigo-700">Cần một lần tự nhớ đúng tiếp theo để xác nhận đã thuộc.</p>}
      </div>}
      {v.session_id && <Link to={`/session/${v.session_id}`} className="mt-2 inline-block text-xs text-indigo-700 underline">Về bài học để đổi lựa chọn</Link>}
    </li>
  )
}

export default function Vocab() {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [level, setLevel] = useState<MasteryLevel | 'all'>('all')
  const [priority, setPriority] = useState(true)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<VocabPage | null>(null)
  const [error, setError] = useState<unknown>(null)

  // chờ người dùng ngừng gõ rồi mới tìm
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => setPage(1), [debounced, filter, level, priority])

  const load = useCallback(() => {
    setError(null)
    const qs = new URLSearchParams({ q: debounced, filter, page: String(page) })
    if (level !== 'all') qs.set('level', level)
    if (priority) qs.set('order', 'priority')
    api<VocabPage>(`/vocab?${qs}`).then(setData).catch(setError)
  }, [debounced, filter, page, level, priority])
  useEffect(load, [load])

  if (error != null && !data) return <ErrorBox error={error} onRetry={load} />
  if (!data) return <Spinner />

  const { stats } = data
  const pages = Math.max(1, Math.ceil(data.matched / data.page_size))
  const searching = debounced.trim() !== '' || filter !== 'all' || level !== 'all'

  return (
    <>
      <PageTitle title="Từ vựng" hint="Từ bạn chọn từ các bài học. Mỗi ngày ôn tối đa 15 từ, trong đó tối đa 5 từ mới; ưu tiên từ cũ đến hạn." />

      <div className="mb-3 grid grid-cols-3 gap-3 text-center">
        <Card><p className="text-2xl font-bold text-indigo-700">{stats.total}</p><p className="text-xs text-slate-500">Tổng số từ</p></Card>
        <Card><p className="text-2xl font-bold text-emerald-700">{stats.learned}</p><p className="text-xs text-slate-500">Đã thuộc</p></Card>
        <Card><p className="text-2xl font-bold text-amber-700">{stats.due}</p><p className="text-xs text-slate-500">Đến hạn ôn</p></Card>
      </div>

      {(stats.queued ?? 0) > 0 && <Card className="mb-3 space-y-2">
        <p className="text-sm text-slate-700">Có <strong>{stats.queued}</strong> từ đã chọn đang chờ học. App đưa từ vào lịch theo thứ tự bạn chọn, sau khi dành chỗ cho từ cũ đến hạn.</p>
        <Btn variant="ghost" onClick={() => setFilter('queued')}>Xem danh sách chờ học</Btn>
      </Card>}

      <Card className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-700">
          {stats.due === 0 ? 'Hôm nay không có từ nào đến hạn ôn.' : (stats.quota?.shown ?? stats.due) === 0 ? <>Bạn đã ôn đủ <strong>{stats.quota?.cap}</strong> thẻ hôm nay. Còn <strong>{stats.quota?.backlog}</strong> thẻ chờ ngày mai.</> : <>Có <strong>{stats.quota?.shown ?? stats.due}</strong> từ cần ôn hôm nay.{(stats.quota?.backlog ?? 0) > 0 && <span className="text-slate-500"> Mỗi ngày tối đa {stats.quota?.cap} thẻ; {stats.quota?.backlog} thẻ chờ ngày sau.</span>}</>}
        </p>
        {(stats.quota?.shown ?? stats.due) > 0 ? <Link to="/review"><Btn>Ôn ngay</Btn></Link> : <Btn disabled>Ôn ngay</Btn>}
      </Card>

      <Card className="mb-3 space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Ôn tự do</h2>
          <p className="text-xs text-slate-500">Ôn thêm bất kỳ từ nào, kể cả chưa đến hạn. Lịch ôn chỉ đổi với từ bạn bấm Quên.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {([
            ['all', 'Tất cả', stats.total],
            ['learning', 'Đang học', stats.total - stats.learned - (stats.queued ?? 0)],
            ['learned', 'Đã thuộc', stats.learned],
          ] as const).map(([scope, label, n]) =>
            n > 0 ? (
              <Link key={scope} to={`/review?mode=practice&scope=${scope}`}><Btn variant="ghost">{label} ({n})</Btn></Link>
            ) : (
              <Btn key={scope} variant="ghost" disabled>{label} (0)</Btn>
            ),
          )}
        </div>
      </Card>

      <div className="mb-3 space-y-2">
        <p className="text-xs leading-relaxed text-slate-500">Mức độ phản ánh khả năng tự nhớ từ. Đạt “Đã thuộc” khi nhớ đúng ít nhất 3 ngày khác nhau, trải qua tối thiểu 7 ngày; ngày ôn lại là lịch kiểm tra tiếp theo.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-slate-600">Mức độ ghi nhớ
            <select aria-label="Lọc theo mức độ ghi nhớ" value={level} onChange={e => setLevel(e.target.value as MasteryLevel | 'all')} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm">
              <option value="all">Tất cả mức độ</option>
              {MASTERY_LEVELS.map(key => <option key={key} value={key}>{MASTERY_LABELS[key]}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600">Sắp xếp
            <select aria-label="Sắp xếp từ vựng" value={priority ? 'priority' : 'recent'} onChange={e => setPriority(e.target.value === 'priority')} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm">
              <option value="priority">Ưu tiên từ cần ôn</option><option value="recent">Thứ tự danh sách</option>
            </select>
          </label>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm từ hoặc nghĩa (không cần gõ dấu)…"
          aria-label="Tìm từ vựng"
          className="min-h-11 w-full rounded-xl border border-slate-300 px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Lọc từ vựng">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1.5 text-sm ${filter === f.key ? 'border-indigo-500 bg-indigo-100 font-semibold text-indigo-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error != null && <div className="mb-3"><ErrorBox error={error} onRetry={load} /></div>}

      {data.items.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">
            {stats.total === 0
              ? 'Chưa chọn từ nào. Mở bài học và bấm “Thêm vào ôn tập” với từ bạn muốn nhớ.'
              : searching
                ? 'Không có từ nào khớp với tìm kiếm hoặc bộ lọc.'
                : 'Chưa có từ nào.'}
          </p>
        </Card>
      ) : (
        <>
          <p className="mb-2 text-xs text-slate-500" aria-live="polite">
            {searching ? `${data.matched} từ khớp` : `${data.matched} từ`}
          </p>
          <ul className="space-y-2">{data.items.map((v) => <Row key={v.id} v={v} />)}</ul>
          {pages > 1 && (
            <nav className="mt-4 flex items-center justify-between" aria-label="Phân trang">
              <Btn variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Trước</Btn>
              <span className="text-sm text-slate-600">Trang {data.page}/{pages}</span>
              <Btn variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Sau →</Btn>
            </nav>
          )}
        </>
      )}
    </>
  )
}
