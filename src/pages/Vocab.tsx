import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Btn, Card, ErrorBox, PageTitle, Speak, Spinner, fmtDate } from '../ui'

interface Item {
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
  stats: { total: number; learned: number; due: number; quota?: { cap: number; done: number; due: number; shown: number; backlog: number } }
}

type Filter = 'all' | 'due' | 'learning' | 'learned'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'due', label: 'Đến hạn ôn' },
  { key: 'learning', label: 'Đang học' },
  { key: 'learned', label: 'Đã thuộc' },
]

const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10) // giờ Việt Nam

function Row({ v }: { v: Item }) {
  const due = v.due_date <= today()
  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold text-indigo-700">{v.word}</span>
        {v.pos && <span className="text-xs text-slate-500">({v.pos})</span>}
        <Speak text={v.word} />
        <span className="ml-auto flex flex-wrap gap-1 text-xs">
          {v.learned === 1 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">Đã thuộc</span>}
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
      <p className="mt-1 text-xs text-slate-400">{due ? 'Ôn hôm nay' : `Ôn lại: ${fmtDate(v.due_date)}`}</p>
    </li>
  )
}

export default function Vocab() {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<VocabPage | null>(null)
  const [error, setError] = useState<unknown>(null)

  // chờ người dùng ngừng gõ rồi mới tìm
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => setPage(1), [debounced, filter])

  const load = useCallback(() => {
    setError(null)
    const qs = new URLSearchParams({ q: debounced, filter, page: String(page) })
    api<VocabPage>(`/vocab?${qs}`).then(setData).catch(setError)
  }, [debounced, filter, page])
  useEffect(load, [load])

  if (error != null && !data) return <ErrorBox error={error} onRetry={load} />
  if (!data) return <Spinner />

  const { stats } = data
  const pages = Math.max(1, Math.ceil(data.matched / data.page_size))
  const searching = debounced.trim() !== '' || filter !== 'all'

  return (
    <>
      <PageTitle title="Từ vựng" hint="Kho từ vựng từ các buổi học. Từ mới được ôn lại theo lịch lặp lại ngắt quãng." />

      <div className="mb-3 grid grid-cols-3 gap-3 text-center">
        <Card><p className="text-2xl font-bold text-indigo-700">{stats.total}</p><p className="text-xs text-slate-500">Tổng số từ</p></Card>
        <Card><p className="text-2xl font-bold text-emerald-700">{stats.learned}</p><p className="text-xs text-slate-500">Đã thuộc</p></Card>
        <Card><p className="text-2xl font-bold text-amber-700">{stats.due}</p><p className="text-xs text-slate-500">Đến hạn ôn</p></Card>
      </div>

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
            ['learning', 'Đang học', stats.total - stats.learned],
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
              ? 'Chưa có từ vựng nào. Từ vựng sẽ tự được thêm vào đây sau mỗi buổi học.'
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
