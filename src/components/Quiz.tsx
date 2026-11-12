import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox } from '../ui'

export interface QuizQuestion {
  type: 'mcq' | 'fill'
  question: string
  options?: string[]
}

export interface QuizResultItem {
  index: number
  type: 'mcq' | 'fill'
  question: string
  options?: string[]
  given: number | string | null
  correct: boolean
  answer: number | string
  answer_text: string
  explanation_vi: string
}

export interface QuizResult {
  score: number
  right: number
  total: number
  passed: boolean
  items: QuizResultItem[]
  review_words?: string[]
}

type Given = number | string | null

const givenText = (it: QuizResultItem) => {
  if (it.given === null || it.given === '') return null
  return it.type === 'mcq' ? (it.options?.[it.given as number] ?? '') : String(it.given)
}

/** Kết quả quiz: điểm, đạt/chưa đạt, từng câu kèm đáp án đúng và giải thích tiếng Việt. */
export function QuizResultView({ result, retried }: { result: QuizResult; retried?: { finalScore: number; firstScore: number | null } }) {
  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold">Kết quả quiz</h3>
        <p className="text-3xl font-bold text-indigo-700" aria-label="Điểm">{retried ? retried.finalScore : result.score}%</p>
        <p className="text-sm text-slate-600">
          {retried
            ? `Lần làm đầu: ${retried.firstScore ?? result.score}% (đúng ${result.right}/${result.total} câu)`
            : `Đúng ${result.right}/${result.total} câu`}
        </p>
      </div>
      {retried ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">✅ Đã làm lại các câu sai và đạt 100%. Danh sách bên dưới là kết quả lần làm đầu.</p>
      ) : result.passed ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">✅ Đạt! Bạn đã hoàn thành buổi học này.</p>
      ) : (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Chưa đạt (cần từ 70%), nhưng buổi học này vẫn được tính là đã xong. Xem lại đáp án bên dưới nhé.
        </p>
      )}
      {result.review_words && result.review_words.length > 0 && (
        <p className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900" aria-label="Từ cần ôn">
          🔁 Các từ bạn làm sai đã được đưa vào hàng ôn: <strong>{result.review_words.join(', ')}</strong>
        </p>
      )}
      <ol className="space-y-3">
        {result.items.map((it) => {
          const mine = givenText(it)
          return (
            <li key={it.index} className={`rounded-xl border p-3 text-sm ${it.correct ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`} data-correct={it.correct}>
              <p className="font-medium">
                <span aria-hidden>{it.correct ? '✅' : '❌'} </span>
                <span className="sr-only">{it.correct ? 'Đúng. ' : 'Sai. '}</span>
                {it.index + 1}. {it.question}
              </p>
              <p className="mt-1 text-slate-700">
                Bạn chọn: <strong>{mine ?? '(bỏ trống)'}</strong>
              </p>
              {!it.correct && (
                <p className="text-emerald-800">
                  Đáp án đúng: <strong>{it.answer_text}</strong>
                </p>
              )}
              <p className="mt-1 text-slate-600">{it.explanation_vi}</p>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

/** Làm quiz cuối buổi. Nộp xong là chốt (không làm lại); đáp án chỉ hiện sau khi nộp. */
export default function Quiz({ sessionId, quiz, onSubmitted }: { sessionId: number; quiz: QuizQuestion[]; onSubmitted: () => void }) {
  const [answers, setAnswers] = useState<Given[]>(() => quiz.map(() => null))
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const set = (i: number, v: Given) => {
    setConfirming(false)
    setAnswers((a) => a.map((x, k) => (k === i ? v : x)))
  }
  const blank = answers.filter((a) => a === null || (typeof a === 'string' && !a.trim())).length

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = answers.map((a, i) => (quiz[i].type === 'fill' ? (typeof a === 'string' && a.trim() ? a.trim() : null) : a))
      await api(`/sessions/${sessionId}/quiz`, { answers: payload }, { timeoutMs: 20_000 })
      onSubmitted() // tải lại buổi học: hiện kết quả
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (blank > 0 && !confirming) return setConfirming(true)
    void submit()
  }

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-4" aria-label="Quiz cuối buổi">
        <div>
          <h3 className="font-semibold">Quiz cuối buổi</h3>
          <p className="text-xs text-slate-500">{quiz.length} câu. Nộp xong sẽ có điểm và đáp án, và không làm lại được.</p>
        </div>
        {quiz.map((q, i) => (
          <fieldset key={i} className="space-y-2" disabled={busy}>
            <legend className="text-sm font-medium">{i + 1}. {q.question}</legend>
            {q.type === 'mcq' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {q.options?.map((o, j) => (
                  <label key={j} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${answers[i] === j ? 'border-indigo-500 bg-indigo-50 font-medium' : 'border-slate-200 hover:bg-slate-50'}`}>
                    <input type="radio" name={`quiz-${i}`} checked={answers[i] === j} onChange={() => set(i, j)} />
                    {o}
                  </label>
                ))}
              </div>
            ) : (
              <input
                type="text"
                value={typeof answers[i] === 'string' ? (answers[i] as string) : ''}
                onChange={(e) => set(i, e.target.value)}
                maxLength={60}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={`Đáp án câu ${i + 1}`}
                className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
              />
            )}
          </fieldset>
        ))}

        {error != null && <ErrorBox error={error} onRetry={() => void submit()} />}
        {confirming && (
          <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Bạn còn {blank} câu chưa trả lời, các câu này tính là sai. Nộp bài luôn?
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Btn type="submit" disabled={busy}>{busy ? 'Đang chấm…' : confirming ? 'Nộp bài luôn' : 'Nộp bài'}</Btn>
          {confirming && !busy && <Btn variant="ghost" onClick={() => setConfirming(false)}>Làm tiếp</Btn>}
          {!confirming && blank > 0 && <span className="text-xs text-slate-500">Còn {blank} câu chưa trả lời</span>}
        </div>
      </form>
    </Card>
  )
}
