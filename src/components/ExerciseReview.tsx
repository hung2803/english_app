import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox, Spinner } from '../ui'

interface Question {
  index: number
  type: 'mcq' | 'fill'
  question: string
  options?: string[]
}
interface Status {
  prev_seq: number | null
  remaining: number
  round: number
}
interface RoundResult {
  passed: boolean
  round: number
  remaining: number
  results: { index: number; question: string; correct: boolean; answer_text: string; explanation_vi: string }[]
}

/**
 * Làm lại các câu SAI trong bài tập của buổi trước. Mỗi lượt chỉ hỏi các câu còn sai (lựa chọn được xáo lại);
 * đúng hết (100%) mới mở buổi này.
 */
export default function ExerciseReview({ sessionId, onPassed }: { sessionId: number; onPassed: () => void }) {
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [idx, setIdx] = useState(0)
  const [answers, setAnswers] = useState<{ index: number; choice: string }[]>([])
  const [text, setText] = useState('')
  const [result, setResult] = useState<RoundResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setError(null)
    setQuestions(null)
    setResult(null)
    setIdx(0)
    setAnswers([])
    setText('')
    api<{ status: Status; questions: Question[] }>(`/sessions/${sessionId}/exercise-review`)
      .then((r) => {
        setQuestions(r.questions)
        setStatus(r.status)
      })
      .catch(setError)
  }, [sessionId])
  useEffect(load, [load])
  useEffect(() => input.current?.focus(), [idx, questions])

  const submit = async (all: typeof answers) => {
    setBusy(true)
    setError(null)
    try {
      setResult(await api<RoundResult>(`/sessions/${sessionId}/exercise-review`, { answers: all }))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const answer = (choice: string) => {
    if (!questions || busy) return
    const all = [...answers, { index: questions[idx].index, choice }]
    setAnswers(all)
    setText('')
    if (idx + 1 < questions.length) setIdx(idx + 1)
    else void submit(all)
  }

  if (error != null && !questions) return <ErrorBox error={error} onRetry={load} />
  if (!questions || !status) return <Spinner text="Đang tải câu hỏi…" />

  if (result) {
    const wrong = result.results.filter((r) => !r.correct)
    return (
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{result.passed ? '✅ Đã đúng hết bài tập!' : `Đúng ${result.results.length - wrong.length}/${result.results.length}`}</h2>
        <p className="text-sm text-slate-600">
          {result.passed ? 'Bạn đã hoàn thành bài tập buổi trước (100%).' : `Còn ${wrong.length} câu sai. Cần đúng 100% mới mở bài mới; xem đáp án bên dưới rồi làm lại.`}
        </p>
        <ul className="space-y-2">
          {result.results.map((r) => (
            <li key={r.index} className={`rounded-xl border p-3 text-sm ${r.correct ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
              <p className="font-medium text-slate-800"><span aria-hidden>{r.correct ? '✅' : '❌'} </span>{r.question}</p>
              <p className="mt-1 text-slate-700">Đáp án đúng: <strong>{r.answer_text}</strong></p>
              {!r.correct && <p className="mt-1 text-slate-600">{r.explanation_vi}</p>}
              <span className="sr-only">{r.correct ? 'đúng' : 'sai'}</span>
            </li>
          ))}
        </ul>
        {result.passed ? <Btn onClick={onPassed}>Tiếp tục</Btn> : <Btn onClick={load}>Làm lại {wrong.length} câu sai</Btn>}
      </Card>
    )
  }

  const q = questions[idx]
  const pct = Math.round((idx / questions.length) * 100)
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-semibold">Làm lại bài tập buổi {status.prev_seq ?? 'trước'}</h2>
        <p className="text-xs text-slate-500">
          Bài tập chưa đạt 100% nên cần làm lại {status.remaining} câu sai{status.round > 0 ? ` · lượt ${status.round + 1}` : ''}. Đúng hết mới mở bài mới.
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Tiến độ lượt làm lại" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-slate-500">Câu {idx + 1}/{questions.length}</p>
      </div>

      <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-base font-medium text-slate-800" data-testid="exercise-question" aria-live="polite">{q.question}</p>

      {q.type === 'mcq' ? (
        <div className="grid gap-2">
          {q.options?.map((o) => (
            <button
              key={o}
              type="button"
              disabled={busy}
              onClick={() => answer(o)}
              className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-left text-sm font-medium text-slate-800 hover:bg-indigo-50 disabled:opacity-50"
            >
              {o}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            answer(text)
          }}
        >
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Đáp án"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            maxLength={100}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />
          <Btn type="submit" disabled={busy}>{idx + 1 < questions.length ? 'Tiếp' : 'Nộp'}</Btn>
        </form>
      )}
      {error != null && <ErrorBox error={error} onRetry={() => void submit(answers)} />}
    </Card>
  )
}
