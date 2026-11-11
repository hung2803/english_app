import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox } from '../ui'

export const MAX_MESSAGE_CHARS = 500

interface Issue {
  original: string
  fixed: string
  explanation_vi: string
}

interface Correction {
  has_errors: boolean
  corrected: string
  issues: Issue[]
}

interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
  /** chỉ có ở tin của người học; null = chưa chấm được */
  correction?: Correction | null
}

/** Phần AI sửa lỗi dưới tin nhắn của người học: câu đúng, hoặc câu đã sửa + từng lỗi kèm giải thích tiếng Việt. */
function CorrectionView({ c }: { c: Correction }) {
  if (!c.has_errors) {
    return <p className="mt-1 text-xs text-emerald-700">✅ Câu của bạn đúng, tốt lắm!</p>
  }
  return (
    <div className="mt-1 w-full max-w-[85%] space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-slate-800" aria-label="Sửa lỗi">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Sửa lỗi</p>
      <p>
        <span className="text-slate-500">Câu đúng: </span>
        <strong className="text-emerald-800">{c.corrected}</strong>
      </p>
      <ul className="space-y-2">
        {c.issues.map((i, k) => (
          <li key={k}>
            <span className="text-rose-700 line-through">{i.original}</span> → <span className="font-medium text-emerald-800">{i.fixed}</span>
            <p className="text-slate-600">{i.explanation_vi}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Khung chat chữ với AI trong buổi học. `readOnly`: buổi đã xong → chỉ xem lại lịch sử. */
export default function Chat({ sessionId, readOnly = false }: { sessionId: number; readOnly?: boolean }) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    setLoadError(null)
    api<{ messages: Message[] }>(`/sessions/${sessionId}/chat`)
      .then((r) => setMessages(r.messages))
      .catch(setLoadError)
  }, [sessionId])
  useEffect(load, [load])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [messages, sending])

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const message = text.trim()
    if (!message || sending || [...message].length > MAX_MESSAGE_CHARS) return
    setSending(true)
    setError(null)
    try {
      const r = await api<{ user: Message; assistant: Message }>(`/sessions/${sessionId}/chat`, { message }, { timeoutMs: 40_000 })
      setMessages((m) => [...(m ?? []), r.user, r.assistant])
      setText('') // chỉ xóa khi thành công: lỗi thì giữ nguyên để gửi lại
    } catch (err) {
      setError(err)
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const length = [...text].length
  const tooLong = length > MAX_MESSAGE_CHARS

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold">Luyện hội thoại với AI</h3>
        <p className="text-xs text-slate-500">
          {readOnly ? 'Buổi học đã xong. Đây là lịch sử hội thoại.' : 'Viết tiếng Anh theo chủ đề bài học. AI sẽ trả lời bằng tiếng Anh đơn giản.'}
        </p>
      </div>

      <div className="max-h-96 min-h-24 space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-3" role="log" aria-label="Hội thoại" aria-live="polite">
        {messages === null && loadError == null && <p className="text-sm text-slate-500">Đang tải hội thoại…</p>}
        {loadError != null && <ErrorBox error={loadError} onRetry={load} />}
        {messages?.length === 0 && (
          <p className="text-sm text-slate-500">
            {readOnly ? 'Không có hội thoại nào trong buổi này.' : 'Hãy viết một câu tiếng Anh để bắt đầu, ví dụ: “Hello!”'}
          </p>
        )}
        {messages?.map((m) => (
          <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <p
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-800'}`}
              data-role={m.role}
            >
              {m.content}
            </p>
            {m.role === 'user' && m.correction && <CorrectionView c={m.correction} />}
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <p className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500" role="status">AI đang trả lời…</p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {!readOnly && (
        <form onSubmit={send} className="space-y-2" aria-label="Gửi tin nhắn">
          {error != null && <ErrorBox error={error} onRetry={() => void send()} />}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder="Nhập tin nhắn bằng tiếng Anh…"
            aria-label="Tin nhắn"
            disabled={sending}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs ${tooLong ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>
              {length}/{MAX_MESSAGE_CHARS}
            </span>
            <Btn type="submit" disabled={sending || !text.trim() || tooLong}>{sending ? 'Đang gửi…' : 'Gửi'}</Btn>
          </div>
        </form>
      )}
    </Card>
  )
}
