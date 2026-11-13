import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox, Speak, Spinner } from '../ui'
import { KIND_LABEL, OrderInput, Underlined, type QuizKind } from './Quiz'

interface Question {
  index: number
  type: QuizKind
  words?: string[]
  question: string
  options?: string[]
}
interface Status {
  prev_seq: number | null
  remaining: number
  round: number
}
interface Material {
  seq: number
  title: string
  reading: string
  summary_vi: string
  vocab: { word: string; pos?: string; meaning_vi: string; example?: string }[]
  grammar: { point: string; explanation_vi: string; example?: string }[]
}
interface RoundResult {
  passed: boolean
  round: number
  remaining: number
  results: { index: number; question: string; correct: boolean; answer_text: string; explanation_vi: string }[]
}

/** Đầu bài: nội dung bài của buổi trước (bài đọc, từ vựng, ngữ pháp) để xem lại trước khi trả lời. Mở sẵn, có thể thu gọn. */
function LessonMaterial({ m }: { m: Material }) {
  return (
    <details open className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-sm" data-testid="exercise-material">
      <summary className="cursor-pointer font-semibold text-indigo-900">Đầu bài: xem lại bài buổi {m.seq}{m.title ? ` — ${m.title}` : ''}</summary>
      <div className="mt-3 space-y-3 text-slate-800">
        {m.reading && (
          <section>
            <h3 className="mb-1 flex items-center gap-2 font-semibold">Bài đọc <Speak text={m.reading} label="Nghe cả bài" /></h3>
            <p className="whitespace-pre-line leading-relaxed" data-testid="exercise-reading">{m.reading}</p>
          </section>
        )}
        {m.summary_vi && (
          <section>
            <h3 className="mb-1 font-semibold">Tóm tắt</h3>
            <p>{m.summary_vi}</p>
          </section>
        )}
        {m.vocab.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold">Từ vựng</h3>
            <ul className="space-y-1">
              {m.vocab.map((v) => (
                <li key={v.word}>
                  <span className="font-semibold text-indigo-700">{v.word}</span>
                  {v.pos && <span className="text-slate-500"> ({v.pos})</span>} — {v.meaning_vi}
                  {v.example && <span className="block italic text-slate-500">{v.example}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {m.grammar.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold">Ngữ pháp</h3>
            <ul className="space-y-1">
              {m.grammar.map((g) => (
                <li key={g.point}>
                  <span className="font-semibold">{g.point}</span>: {g.explanation_vi}
                  {g.example && <span className="block italic text-slate-500">{g.example}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  )
}
/**
 * Làm lại các câu SAI trong bài tập của buổi trước. Mỗi lượt chỉ hỏi các câu còn sai (lựa chọn được xáo lại);
 * đúng hết (100%) mới mở buổi này.
 */
export default function ExerciseReview({ sessionId, onPassed }: { sessionId: number; onPassed: () => void }) {
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [material, setMaterial] = useState<Material | null>(null)
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
    api<{ status: Status; questions: Question[]; material?: Material }>(`/sessions/${sessionId}/exercise-review`)
      .then((r) => {
        setQuestions(r.questions)
        setStatus(r.status)
        setMaterial(r.material ?? null)
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
        <h2 className="text-lg font-semibold">Đã ôn bài tập: đúng {result.results.length - wrong.length}/{result.results.length}</h2>
        <p className="text-sm text-slate-600">
          {wrong.length ? `Còn ${wrong.length} câu cần luyện thêm. Hãy xem giải thích; bạn có thể tiếp tục bài mới.` : 'Bạn đã sửa đúng hết các câu sai của buổi trước.'}
        </p>
        <ul className="space-y-2">
          {result.results.map((r) => (
            <li key={r.index} className={`rounded-xl border p-3 text-sm ${r.correct ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
              <p className="font-medium text-slate-800"><span aria-hidden>{r.correct ? '✅' : '❌'} </span><Underlined text={r.question} /></p>
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
          Ôn lại {status.remaining} câu sai của buổi trước một lần rồi tiếp tục bài mới.
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Tiến độ lượt làm lại" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-slate-500">Câu {idx + 1}/{questions.length}</p>
      </div>

      {material && <LessonMaterial m={material} />}
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500" data-testid="exercise-kind">
        {q.type === 'mcq'
          ? 'Chọn một đáp án đúng'
          : q.type === 'fill'
            ? 'Gõ từ còn thiếu vào chỗ ___'
            : q.type === 'order'
              ? `${KIND_LABEL.order}: bấm các từ theo thứ tự`
              : q.type === 'error'
                ? `${KIND_LABEL.error}: gõ phần sửa lại (phần gạch chân)`
                : `${KIND_LABEL.rewrite}: viết lại cả câu`}
      </p>
      <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-base font-medium text-slate-800" data-testid="exercise-question" aria-live="polite"><Underlined text={q.question} /></p>

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
          {q.type === 'order' ? (
            <div className="min-w-0 flex-1"><OrderInput key={idx} words={q.words ?? []} label="Sắp xếp câu" onChange={setText} /></div>
          ) : (
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
            maxLength={200}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />)}
          <Btn type="submit" disabled={busy}>{idx + 1 < questions.length ? 'Tiếp' : 'Nộp'}</Btn>
        </form>
      )}
      {error != null && <ErrorBox error={error} onRetry={() => void submit(answers)} />}
    </Card>
  )
}
