import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, apiForm } from '../api'
import { Btn, Card, ErrorBox, PageTitle, Spinner, fmtDate } from '../ui'

interface Upload {
  id: number
  kind: 'file' | 'link'
  title: string
  url: string | null
  mime: string | null
  size_bytes: number | null
  excerpt: string | null
  created_at: string
  times_used: number
  in_use: boolean
}

export const MAX_FILE_MB = 10

const fmtSize = (n: number | null) => (n === null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const icon = (u: Upload) => (u.kind === 'link' ? '🔗' : u.mime === 'application/pdf' ? '📄' : '📝')

function UploadItem({ u, onDeleted }: { u: Upload; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(`/uploads/${u.id}`, undefined, { method: 'DELETE' })
      onDeleted()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">
            <span aria-hidden>{icon(u)} </span>
            {u.title}
          </p>
          <p className="text-xs text-slate-500">
            {u.kind === 'link' ? 'Link' : fmtSize(u.size_bytes)} · tải lên {fmtDate(u.created_at)} ·{' '}
            {u.times_used > 0 ? `đã dùng ${u.times_used} buổi` : 'chưa dùng'}
          </p>
          {u.url && <p className="truncate text-xs text-slate-400">{u.url}</p>}
        </div>
        {!confirming && (
          <Btn variant="ghost" onClick={() => setConfirming(true)} className="shrink-0">Xóa</Btn>
        )}
      </div>
      {u.excerpt && <p className="rounded-lg bg-slate-100 p-2 text-sm italic text-slate-700">“{u.excerpt}”</p>}

      {confirming && (
        <div role="alertdialog" aria-label={`Xóa ${u.title}`} className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          <p>
            Xóa tài liệu này? <strong>Không thể hoàn tác.</strong> Các bài đã học từ tài liệu này vẫn được giữ.
          </p>
          {u.in_use && <p className="font-medium">⚠️ Tài liệu đang được chọn cho một buổi chưa xong; buổi đó sẽ để AI tự viết bài.</p>}
          <div className="flex gap-2">
            <Btn variant="danger" onClick={remove} disabled={busy}>{busy ? 'Đang xóa…' : 'Xóa'}</Btn>
            <Btn variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Hủy</Btn>
          </div>
        </div>
      )}
      {error != null && <ErrorBox error={error} />}
    </Card>
  )
}

export default function Uploads() {
  const [list, setList] = useState<{ uploads: Upload[]; total_bytes: number } | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)

  const load = useCallback(() => {
    setLoadError(null)
    api<{ uploads: Upload[]; total_bytes: number }>('/uploads').then(setList).catch(setLoadError)
  }, [])
  useEffect(load, [load])

  // --- tải file ---
  const fileRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [fileError, setFileError] = useState<unknown>(null)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState('')

  const submitFile = async (e: FormEvent) => {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    setNotice('')
    if (!file) return setFileError(new Error('Hãy chọn một file để tải lên.'))
    if (file.size > MAX_FILE_MB * 1024 * 1024) return setFileError(new Error(`File quá lớn (tối đa ${MAX_FILE_MB} MB).`))
    setUploading(true)
    setFileError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (title.trim()) fd.append('title', title.trim())
      await apiForm('/uploads', fd)
      setNotice(`Đã tải lên “${file.name}”.`)
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      load()
    } catch (err) {
      setFileError(err)
    } finally {
      setUploading(false)
    }
  }

  // --- thêm link ---
  const [url, setUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [linkError, setLinkError] = useState<unknown>(null)
  const [adding, setAdding] = useState(false)

  const submitLink = async (e: FormEvent) => {
    e.preventDefault()
    setNotice('')
    setAdding(true)
    setLinkError(null)
    try {
      await api('/uploads/link', { url: url.trim(), title: linkTitle.trim() || undefined }, { timeoutMs: 30_000 })
      setNotice('Đã thêm link.')
      setUrl('')
      setLinkTitle('')
      load()
    } catch (err) {
      setLinkError(err)
    } finally {
      setAdding(false)
    }
  }

  const input = 'min-h-11 w-full rounded-xl border border-slate-300 px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200'

  return (
    <>
      <PageTitle title="Tài liệu của bạn" hint="Tải PDF, văn bản hoặc link. AI sẽ đưa tài liệu này vào danh sách lựa chọn của các buổi học." />
      {notice && <div role="status" className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <form onSubmit={submitFile} className="space-y-3" aria-label="Tải file lên">
            <h2 className="font-semibold">Tải file lên</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">File (PDF, TXT, MD · tối đa {MAX_FILE_MB} MB)</span>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" className="block w-full text-sm" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Tên hiển thị (không bắt buộc)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={input} />
            </label>
            {fileError != null && <ErrorBox error={fileError} />}
            <Btn type="submit" disabled={uploading}>{uploading ? 'Đang tải lên…' : 'Tải lên'}</Btn>
          </form>
        </Card>

        <Card>
          <form onSubmit={submitLink} className="space-y-3" aria-label="Thêm link">
            <h2 className="font-semibold">Thêm link</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Đường dẫn trang web</span>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={input} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Tên hiển thị (không bắt buộc)</span>
              <input value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} maxLength={120} className={input} />
            </label>
            {linkError != null && <ErrorBox error={linkError} />}
            <Btn type="submit" disabled={adding || !url.trim()}>{adding ? 'Đang kiểm tra link…' : 'Thêm link'}</Btn>
          </form>
        </Card>
      </div>

      <h2 className="mb-2 mt-5 font-semibold">Đã tải lên {list ? `(${list.uploads.length})` : ''}</h2>
      {loadError != null && !list && <ErrorBox error={loadError} onRetry={load} />}
      {!list && loadError == null && <Spinner />}
      {list && list.uploads.length === 0 && (
        <Card><p className="text-sm text-slate-600">Chưa có tài liệu nào. Tải một file hoặc thêm link ở trên.</p></Card>
      )}
      {list && list.uploads.length > 0 && (
        <>
          <p className="mb-2 text-xs text-slate-500">Tổng dung lượng file: {fmtSize(list.total_bytes) || '0 KB'}</p>
          <div className="space-y-3">
            {list.uploads.map((u) => (
              <UploadItem key={u.id} u={u} onDeleted={load} />
            ))}
          </div>
        </>
      )}
    </>
  )
}
