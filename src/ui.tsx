import { useEffect, useState, type ReactNode } from 'react'
import { errorMessage, isRetryable } from './api'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>{children}</div>
}

type BtnProps = {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost' | 'danger'
  className?: string
  type?: 'button' | 'submit'
}

export function Btn({ children, onClick, disabled, variant = 'primary', className = '', type = 'button' }: BtnProps) {
  const styles = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
    ghost: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  }[variant]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

/** Hiện lỗi (kể cả lỗi AI). Nút "Thử lại" chỉ hiện khi có onRetry và lỗi có thể thử lại. */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
      <p>{errorMessage(error)}</p>
      {onRetry && isRetryable(error) && (
        <Btn variant="danger" className="mt-2" onClick={onRetry}>
          Thử lại
        </Btn>
      )}
    </div>
  )
}

export function Spinner({ text = 'Đang tải…' }: { text?: string }) {
  return (
    <p role="status" className="py-8 text-center text-sm text-slate-500">
      {text}
    </p>
  )
}

export function PageTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-bold text-slate-900 md:text-2xl">{title}</h1>
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
    </div>
  )
}

/** Ngày YYYY-MM-DD → DD/MM/YYYY */
export const fmtDate = (d: string) => (d ? d.split('-').reverse().join('/') : '')

/**
 * Thanh tiến trình cho lệnh gọi AI. Không biết chính xác tiến độ thật nên chạy theo thời gian dự kiến,
 * dừng ở 95% cho tới khi xong; quá thời gian dự kiến thì báo "lâu hơn dự kiến".
 */
export function AiProgress({ stages, seconds = 60 }: { stages: string[]; seconds?: number }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 250)
    return () => clearInterval(id)
  }, [])
  const pct = Math.min(95, Math.round((elapsed / seconds) * 95))
  const stage = stages[Math.min(stages.length - 1, Math.floor((pct / 95) * stages.length))]
  const slow = elapsed > seconds
  return (
    <Card>
      <p className="mb-2 text-sm font-medium" aria-live="polite">
        {slow ? 'Đang mất nhiều thời gian hơn dự kiến, vui lòng chờ thêm…' : stage}
      </p>
      <div
        className="h-3 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%`}
      >
        <div className="h-full rounded-full bg-indigo-600 transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Tối đa khoảng {seconds} giây · đã chờ {Math.floor(elapsed)} giây
      </p>
    </Card>
  )
}

/** Chọn giọng tiếng Anh nếu trình duyệt có; không có thì để trình duyệt tự chọn theo `lang`. */
function englishVoice(): SpeechSynthesisVoice | undefined {
  try {
    const voices = speechSynthesis.getVoices()
    return voices.find((v) => v.lang === 'en-US') ?? voices.find((v) => v.lang.toLowerCase().startsWith('en'))
  } catch {
    return undefined
  }
}

/** Nút nghe phát âm tiếng Anh (Web Speech API). Trình duyệt không hỗ trợ thì không hiện. */
export function Speak({ text, label }: { text: string; label?: string }) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return null
  return (
    <button
      type="button"
      title="Nghe phát âm"
      aria-label={label ?? `Nghe phát âm: ${text}`}
      className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full border border-slate-300 px-2 text-sm hover:bg-slate-100"
      onClick={(e) => {
        e.stopPropagation()
        try {
          speechSynthesis.cancel() // dừng câu đang đọc dở
          const u = new SpeechSynthesisUtterance(text)
          u.lang = 'en-US'
          u.rate = 0.9
          const v = englishVoice()
          if (v) u.voice = v
          speechSynthesis.speak(u)
        } catch {
          // trình duyệt từ chối đọc: bỏ qua, không làm hỏng trang
        }
      }}
    >
      <span aria-hidden>🔊</span>
    </button>
  )
}
