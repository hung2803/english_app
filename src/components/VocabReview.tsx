import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox, Speak, Spinner } from '../ui'

interface Question {
  word: string
  kind: 'mcq' | 'type' | 'cloze'
  dir?: 'en_vi' | 'vi_en'
  prompt: string
  options?: string[]
  hint?: string
}
interface Status {
  total: number
  stage: number
  stages: number
  round: number
}
interface StudyWord {
  word: string
  meaning: string
  pos?: string
  example?: string
}
interface RoundResult {
  passed: boolean
  stage: number
  cleared: boolean
  next_stage: number
  round: number
  results: (StudyWord & { correct: boolean })[]
}

/** Một từ đầy đủ để xem lại: từ + phát âm, loại từ, nghĩa, câu ví dụ (có nghe). */
function WordRow({ w, mark }: { w: StudyWord; mark?: boolean }) {
  return (
    <li className="space-y-0.5 p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        {mark !== undefined && <span aria-hidden>{mark ? '✅' : '❌'}</span>}
        <span className="text-base font-semibold text-indigo-700">{w.word}</span>
        <Speak text={w.word} />
        {w.pos && <span className="text-xs text-slate-500">({w.pos})</span>}
        <span className="text-slate-700">— {w.meaning}</span>
        {mark !== undefined && <span className="sr-only">{mark ? 'đúng' : 'sai'}</span>}
      </p>
      {w.example && (
        <p className="flex items-center gap-2 pl-1 text-slate-500">
          <span className="italic">{w.example}</span>
          <Speak text={w.example} label="Nghe câu ví dụ" />
        </p>
      )}
    </li>
  )
}

/**
 * Một lượt hỗn hợp; phản hồi từng câu từ máy chủ, chỉ thử lại các từ sai một lần.
 */
export default function VocabReview({ sessionId, onPassed }: { sessionId: number; onPassed: () => void }) {
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [idx, setIdx] = useState(0)
  const [answers, setAnswers] = useState<{ word: string; dir?: string; choice: string }[]>([])
  const [text, setText] = useState('')
  const [result, setResult] = useState<RoundResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [feedback, setFeedback] = useState<(StudyWord & { correct: boolean }) | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setError(null)
    setQuestions(null)
    setResult(null)
    setIdx(0)
    setAnswers([])
    setText('')
    setFeedback(null)
    api<{ status: Status; questions: Question[]; study: StudyWord[] }>(`/sessions/${sessionId}/vocab-review`)
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
      setResult(await api<RoundResult>(`/sessions/${sessionId}/vocab-review`, { answers: all }))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const answer = async (choice: string) => {
    if (!questions || busy) return
    const q = questions[idx]
    setText(choice)
    const all = [...answers, { word: q.word, ...(q.dir ? { dir: q.dir } : {}), choice }]
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ results: (StudyWord & { correct: boolean })[] }>(`/sessions/${sessionId}/vocab-review/check`, { answers: [all[all.length - 1]] })
      setFeedback(r.results[0])
      setAnswers(all)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }

  const next = () => {
    if (!questions) return
    if (idx + 1 < questions.length) { setIdx(idx + 1); setText(''); setFeedback(null) }
    else void submit(answers)
  }

  if (error != null && !questions) return <ErrorBox error={error} onRetry={load} />
  if (!questions || !status) return <Spinner text="Đang tải câu hỏi…" />

  if (result) {
    const wrong = result.results.filter((r) => !r.correct)
    const title = result.passed
      ? '✅ Hoàn thành lượt ôn!'
      : `Đúng ${result.results.length - wrong.length}/${result.results.length}`
    return (
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-slate-600">
          {result.passed
            ? (wrong.length ? 'Đã hoàn thành lượt ôn. Từ chưa nhớ được giữ lại trong lịch ôn, bạn có thể học bài mới.' : 'Đã hoàn thành lượt ôn. Bạn có thể bắt đầu bài học mới.')
            : `Còn ${wrong.length} từ cần ôn thêm. Chỉ thử lại các từ này một lần, các từ đúng được giữ nguyên.`}
        </p>
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {result.results.map((r) => <WordRow key={r.word} w={r} mark={r.correct} />)}
        </ul>
        {result.passed ? (
          <Btn onClick={onPassed}>Bắt đầu bài học</Btn>
        ) : (
          <Btn onClick={load}>Ôn lại {wrong.length} từ sai</Btn>
        )}
      </Card>
    )
  }

  const q = questions[idx]
  const pct = Math.round((idx / questions.length) * 100)
  const instruction =
    q.kind === 'mcq'
      ? q.dir === 'en_vi'
        ? 'Chọn nghĩa tiếng Việt của từ'
        : 'Chọn từ tiếng Anh có nghĩa'
      : q.kind === 'type'
        ? 'Gõ từ tiếng Anh có nghĩa'
        : 'Gõ từ còn thiếu trong câu'
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-semibold">Ôn tập trước bài mới</h2>
        <p className="text-xs text-slate-500">
          Ôn tối đa 10 từ đã chọn và đến hạn, trong hạn mức 15 từ mỗi ngày. Chỉ thử lại từ sai một lần.
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Tiến độ lượt ôn" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-slate-500">Câu {idx + 1}/{questions.length}</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center" aria-live="polite">
        <p className="text-xs text-slate-500">{instruction}</p>
        <div className="mt-1 flex items-center justify-center gap-2">
          <p className={`font-bold text-indigo-700 ${q.kind === 'cloze' ? 'text-lg' : 'text-2xl'}`} data-testid="review-prompt">{q.prompt}</p>
          {q.kind === 'mcq' && q.dir === 'en_vi' && <Speak text={q.prompt} />}
        </div>
        {q.hint && <p className="mt-2 text-sm text-slate-500">Gợi ý: {q.hint}</p>}
      </div>

      {feedback ? (
        <div className="space-y-3" role="status">
          <p className={feedback.correct ? 'text-emerald-700' : 'text-rose-700'}>{feedback.correct ? 'Đúng rồi!' : 'Cần ôn thêm'}</p>
          <ul><WordRow w={feedback} /></ul>
          <Btn onClick={next} disabled={busy}>{idx + 1 < questions.length ? 'Câu tiếp theo' : 'Hoàn thành lượt'}</Btn>
        </div>
      ) : q.kind === 'mcq' ? (
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
      {error != null && <ErrorBox error={error} onRetry={feedback ? () => void submit(answers) : () => void answer(text)} />}
    </Card>
  )
}
