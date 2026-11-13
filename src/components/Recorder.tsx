import { useEffect, useRef, useState } from 'react'
import { Btn } from '../ui'

type State = 'idle' | 'recording' | 'ready'

/** Trình duyệt có ghi âm được không (cần HTTPS và quyền micro). */
export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

/**
 * Ghi âm giọng bạn rồi nghe lại để so với giọng mẫu (nhại theo / shadowing).
 * Bản ghi chỉ nằm trong bộ nhớ trình duyệt, không gửi đi đâu và mất khi tải lại trang.
 */
export default function Recorder({ label = 'Ghi âm' }: { label?: string }) {
  const [state, setState] = useState<State>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const stream = useRef<MediaStream | null>(null)

  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((t) => t.stop())
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )

  if (!canRecord()) return <span className="text-xs text-slate-400">Trình duyệt này chưa hỗ trợ ghi âm.</span>

  const start = async () => {
    setError('')
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks.current = []
      const r = new MediaRecorder(stream.current)
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = () => {
        stream.current?.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old)
          return URL.createObjectURL(blob)
        })
        setState('ready')
      }
      rec.current = r
      r.start()
      setState('recording')
    } catch {
      setError('Không mở được micro. Hãy cho phép dùng micro cho trang này.')
      setState('idle')
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {state !== 'recording' ? (
        <Btn variant="ghost" onClick={() => void start()}>{state === 'ready' ? 'Ghi lại' : `🎙️ ${label}`}</Btn>
      ) : (
        <Btn variant="danger" onClick={() => rec.current?.stop()}>⏹ Dừng</Btn>
      )}
      {state === 'recording' && <span className="text-xs text-rose-700" role="status">Đang ghi âm…</span>}
      {state === 'ready' && url && <audio controls src={url} className="h-9" aria-label="Nghe lại bản ghi của bạn" />}
      {error && <span role="alert" className="text-xs text-rose-700">{error}</span>}
    </span>
  )
}
