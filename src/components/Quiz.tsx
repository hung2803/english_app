import { Fragment, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox } from '../ui'

export type QuizKind = 'mcq' | 'fill' | 'rewrite' | 'order' | 'error'

export interface QuizQuestion {
  type: QuizKind
  question: string
  options?: string[]
  /** order: các từ cho sẵn (đã xáo trộn) */
  words?: string[]
}

export interface QuizResultItem {
  index: number
  type: QuizKind
  question: string
  options?: string[]
  words?: string[]
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

/** Thời gian làm quiz gợi ý (phút). Chỉ hiển thị đồng hồ, không tự nộp bài. */
export const QUIZ_MINUTES = 10

export const KIND_LABEL: Record<QuizKind, string> = {
  mcq: 'Trắc nghiệm',
  fill: 'Điền vào chỗ trống',
  rewrite: 'Viết lại câu',
  order: 'Sắp xếp từ thành câu',
  error: 'Tìm và sửa lỗi sai',
}

const KIND_HINT: Record<QuizKind, string> = {
  mcq: 'Chọn một đáp án đúng.',
  fill: 'Điền từ còn thiếu (chia động từ trong ngoặc, hoặc điền giới từ, mạo từ, từ loại phù hợp).',
  rewrite: 'Viết lại cả câu theo yêu cầu của đề.',
  order: 'Bấm các từ theo thứ tự để ghép thành câu hoàn chỉnh đúng ngữ pháp.',
  error: 'Phần gạch chân có lỗi sai (thì, từ loại hoặc ngữ pháp). Gõ phần sửa lại.',
}

/** Hiện phần [[…]] trong câu hỏi dạng "tìm lỗi sai" dưới dạng chữ gạch chân. */
export function Underlined({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('[[') && p.endsWith(']]') ? (
          <u key={i} className="decoration-2 underline-offset-4">{p.slice(2, -2)}</u>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

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
              <p className="text-xs text-slate-500">{KIND_LABEL[it.type] ?? ''}</p>
              <p className="font-medium">
                <span aria-hidden>{it.correct ? '✅' : '❌'} </span>
                <span className="sr-only">{it.correct ? 'Đúng. ' : 'Sai. '}</span>
                {it.index + 1}. <Underlined text={it.question} />
              </p>
              {it.type === 'order' && it.words && <p className="mt-1 text-slate-500">Các từ cho sẵn: {it.words.join(' / ')}</p>}
              <p className="mt-1 text-slate-700">
                {it.type === 'mcq' ? 'Bạn chọn' : 'Bạn viết'}: <strong>{mine ?? '(bỏ trống)'}</strong>
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

/** Câu "sắp xếp từ": bấm từ để thêm vào câu, bấm từ đã chọn để bỏ ra. Câu trả lời là các từ nối bằng dấu cách. */
export function OrderInput({ words, label, onChange }: { words: string[]; label: string; onChange: (sentence: string) => void }) {
  const [picked, setPicked] = useState<number[]>([])
  const update = (next: number[]) => {
    setPicked(next)
    onChange(next.map((i) => words[i]).join(' '))
  }
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <p
        className={`min-h-11 rounded-xl border border-dashed px-3 py-2 text-sm ${picked.length ? 'border-indigo-300 bg-indigo-50 font-medium text-slate-900' : 'border-slate-300 text-slate-400'}`}
        aria-live="polite"
        data-testid="order-sentence"
      >
        {picked.length ? picked.map((i) => words[i]).join(' ') : 'Bấm các từ bên dưới để ghép câu…'}
      </p>
      <div className="flex flex-wrap gap-2">
        {words.map((w, i) => {
          const used = picked.includes(i)
          return (
            <button
              key={i}
              type="button"
              disabled={used}
              onClick={() => update([...picked, i])}
              className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-indigo-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {w}
            </button>
          )
        })}
      </div>
      {picked.length > 0 && (
        <div className="flex gap-2">
          <Btn variant="ghost" onClick={() => update(picked.slice(0, -1))}>Bỏ từ cuối</Btn>
          <Btn variant="ghost" onClick={() => update([])}>Xóa hết</Btn>
        </div>
      )}
    </div>
  )
}

/** Đồng hồ đếm ngược gợi ý (không tự nộp bài). */
function Countdown({ minutes }: { minutes: number }) {
  const [left, setLeft] = useState(minutes * 60)
  useEffect(() => {
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [])
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  return (
    <span className={`tabular-nums text-sm font-semibold ${left === 0 ? 'text-rose-700' : 'text-indigo-700'}`} role="timer" aria-label="Thời gian còn lại gợi ý">
      {mm}:{ss}
    </span>
  )
}

/** Làm quiz cuối buổi (10 phút). Nộp xong là chốt (không làm lại); đáp án chỉ hiện sau khi nộp. */
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
      const payload = answers.map((a, i) => (quiz[i].type === 'mcq' ? a : typeof a === 'string' && a.trim() ? a.trim() : null))
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

  const text = (i: number, max: number, placeholder?: string) => (
    <input
      type="text"
      value={typeof answers[i] === 'string' ? (answers[i] as string) : ''}
      onChange={(e) => set(i, e.target.value)}
      maxLength={max}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      placeholder={placeholder}
      aria-label={`Đáp án câu ${i + 1}`}
      className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
    />
  )

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-5" aria-label="Quiz cuối buổi">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">Quiz cuối buổi ({QUIZ_MINUTES} phút)</h3>
            <p className="text-xs text-slate-500">{quiz.length} câu. Nộp xong sẽ có điểm và đáp án, và không làm lại được.</p>
          </div>
          <Countdown minutes={QUIZ_MINUTES} />
        </div>
        {quiz.map((q, i) => (
          <fieldset key={i} className="space-y-2" disabled={busy}>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500" data-testid={`quiz-kind-${i}`}>{KIND_LABEL[q.type]}</p>
            <legend className="text-sm font-medium">{i + 1}. <Underlined text={q.question} /></legend>
            <p className="text-xs text-slate-500">{KIND_HINT[q.type]}</p>
            {q.type === 'mcq' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {q.options?.map((o, j) => (
                  <label key={j} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${answers[i] === j ? 'border-indigo-500 bg-indigo-50 font-medium' : 'border-slate-200 hover:bg-slate-50'}`}>
                    <input type="radio" name={`quiz-${i}`} checked={answers[i] === j} onChange={() => set(i, j)} />
                    {o}
                  </label>
                ))}
              </div>
            ) : q.type === 'order' ? (
              <OrderInput words={q.words ?? []} label={`Sắp xếp câu ${i + 1}`} onChange={(s) => set(i, s)} />
            ) : q.type === 'rewrite' ? (
              text(i, 200)
            ) : q.type === 'error' ? (
              text(i, 200, 'Phần sửa lại…')
            ) : (
              text(i, 60)
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
