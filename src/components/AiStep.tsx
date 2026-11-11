import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AiProgress, Btn, ErrorBox } from '../ui'

/** Một bước gọi AI: thanh tiến trình khi đang chạy, thông báo lỗi + nút "Thử lại" khi thất bại. */
export default function AiStep({
  run,
  stages,
  seconds = 60,
  autoStart = false,
  startLabel,
  intro,
}: {
  run: () => Promise<unknown>
  stages: string[]
  seconds?: number
  /** true: chạy ngay khi hiện; false: chờ người học bấm nút */
  autoStart?: boolean
  startLabel?: string
  intro?: ReactNode
}) {
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const [error, setError] = useState<unknown>(null)
  const started = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const start = useCallback(async () => {
    setStatus('running')
    setError(null)
    try {
      await run() // thành công: cha tải lại dữ liệu và thay bước này
    } catch (e) {
      if (mounted.current) {
        setError(e)
        setStatus('error')
      }
    }
  }, [run])

  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true // chống chạy hai lần (StrictMode)
      void start()
    }
  }, [autoStart, start])

  if (status === 'running') return <AiProgress stages={stages} seconds={seconds} />
  return (
    <div className="space-y-3">
      {intro}
      {status === 'error' && <ErrorBox error={error} onRetry={start} />}
      {status === 'idle' && !autoStart && startLabel && <Btn onClick={start}>{startLabel}</Btn>}
    </div>
  )
}
