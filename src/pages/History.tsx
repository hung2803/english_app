import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Btn, Card, ErrorBox, PageTitle, Spinner, fmtDate } from '../ui'

interface Item {
  id: number
  seq: number
  week_no: number
  topic: string
  title: string
  source: { type: string; title: string; url?: string; ai_written: boolean } | null
  score: number | null
  passed: boolean | null
  completed_date: string
  vocab_count: number
}
interface HistoryData {
  items: Item[]
  matched: number
  total: number
  page: number
  page_size: number
}

const sourceLabel = (s: Item['source']) => {
  if (!s) return ''
  if (s.ai_written) return '✍️ Bài đọc do AI viết'
  const icon = { youtube: '▶️', podcast: '🎧', upload: '📎', article: '🌐' }[s.type] ?? '🌐'
  return `${icon} ${s.title}`
}

function Row({ it }: { it: Item }) {
  return (
    <li>
      <Link to={`/session/${it.id}`} className="block rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50/40">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{it.title || it.topic}</p>
            <p className="truncate text-xs text-slate-500">Buổi {it.seq} · Tuần {it.week_no}: {it.topic}</p>
          </div>
          {it.score !== null && (
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${it.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}
              aria-label={`Điểm ${it.score}%, ${it.passed ? 'đạt' : 'chưa đạt'}`}
            >
              {it.passed ? '✓' : '!'} {it.score}%
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-xs text-slate-500">{sourceLabel(it.source)}</p>
        <p className="mt-1 text-xs text-slate-400">
          {fmtDate(it.completed_date)} · {it.vocab_count} từ vựng · <span className="text-indigo-700">Xem lại bài, từ vựng, quiz →</span>
        </p>
      </Link>
    </li>
  )
}

export default function History() {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<HistoryData | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => setPage(1), [debounced])

  const load = useCallback(() => {
    setError(null)
    api<HistoryData>(`/history?${new URLSearchParams({ q: debounced, page: String(page) })}`).then(setData).catch(setError)
  }, [debounced, page])
  useEffect(load, [load])

  if (error != null && !data) return <ErrorBox error={error} onRetry={load} />
  if (!data) return <Spinner />

  const pages = Math.max(1, Math.ceil(data.matched / data.page_size))
  const searching = debounced.trim() !== ''

  return (
    <>
      <PageTitle title="Lịch sử" hint="Các buổi đã học. Mở lại để xem tài liệu, từ vựng, quiz và hội thoại." />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Tìm theo chủ đề, tên bài, nguồn hoặc từ vựng…"
        aria-label="Tìm buổi học"
        className="mb-3 min-h-11 w-full rounded-xl border border-slate-300 px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
      />
      {error != null && <div className="mb-3"><ErrorBox error={error} onRetry={load} /></div>}

      {data.items.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">
            {data.total === 0 ? 'Chưa có buổi học nào hoàn thành. Các buổi đã xong sẽ hiện ở đây.' : 'Không có buổi nào khớp với tìm kiếm.'}
          </p>
          {data.total === 0 && <div className="mt-3"><Link to="/roadmap"><Btn variant="ghost">Về lộ trình</Btn></Link></div>}
        </Card>
      ) : (
        <>
          <p className="mb-2 text-xs text-slate-500" aria-live="polite">{searching ? `${data.matched} buổi khớp` : `${data.matched} buổi đã học`}</p>
          <ul className="space-y-2">{data.items.map((it) => <Row key={it.id} it={it} />)}</ul>
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
