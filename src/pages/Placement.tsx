import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Btn, Card, ErrorBox, PageTitle, Spinner, fmtDate } from '../ui'

interface Question { kind: 'vocab' | 'grammar' | 'reading'; passage?: string; question: string; options: string[] }
interface GradeResult { score: number; total: number; level: string; taken_at: string }
interface Progress {
  baseline: { level: string; taken_at: string }
  latest: { level: string; taken_at: string }
  bands_gained: number | null
  success: boolean | null
}

const KIND_LABEL = { vocab: 'Từ vựng', grammar: 'Ngữ pháp', reading: 'Đọc hiểu' }
const LEVEL_NOTE: Record<string, string> = {
  A0: 'Mới bắt đầu',
  A1: 'Sơ cấp',
  A2: 'Cơ bản',
  B1: 'Trung cấp',
}

interface Review { state: 'need_retest' | 'passed' | 'failed'; required: string[]; weak: string[] }

function Result({ r, progress, review }: { r: GradeResult; progress: Progress | null; review: Review | null }) {
  return (
    <>
      <PageTitle title="Kết quả kiểm tra" hint={`Ngày làm: ${fmtDate(r.taken_at)}`} />
      <Card className="space-y-3 text-center">
        <p className="text-sm text-slate-500">Trình độ của bạn</p>
        <p className="text-5xl font-bold text-indigo-700">{r.level}</p>
        <p className="text-slate-600">{LEVEL_NOTE[r.level]} · đúng {r.score}/{r.total} câu</p>
      </Card>

      {review && review.state === 'passed' && (
        <Card className="mt-3 border-emerald-300 bg-emerald-50">
          <p className="font-semibold">✅ Đạt yêu cầu sang lộ trình mới</p>
          <p className="mt-1 text-sm">Đúng 100% các mức {review.required.join(', ')}.</p>
        </Card>
      )}
      {review && review.state === 'failed' && (
        <Card className="mt-3 border-amber-300 bg-amber-50">
          <p className="font-semibold">Chưa đạt yêu cầu sang lộ trình mới</p>
          <p className="mt-1 text-sm">Cần đúng 100% các mức {review.required.join(', ')}. Mức chưa đạt: <strong>{review.weak.join(', ')}</strong>. Bạn sẽ học thêm 2 tuần ôn tập.</p>
        </Card>
      )}
      {progress && progress.bands_gained !== null && (
        <Card className={`mt-3 ${progress.success ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
          <p className="font-semibold">
            {progress.success ? '🎉 Đạt mục tiêu: lên ít nhất 1 bậc!' : 'Chưa lên bậc so với lần đầu'}
          </p>
          <p className="mt-1 text-sm text-slate-700">
            Lần đầu ({fmtDate(progress.baseline.taken_at)}): <strong>{progress.baseline.level}</strong> → Hiện tại: <strong>{progress.latest.level}</strong>
            {progress.bands_gained > 0 && ` (+${progress.bands_gained} bậc)`}
            {progress.bands_gained < 0 && ` (${progress.bands_gained} bậc)`}
          </p>
        </Card>
      )}

      <div className="mt-4">
        <Link to="/roadmap"><Btn>{review?.state === 'failed' ? 'Tiếp tục: thêm tuần ôn tập' : 'Tiếp tục: lộ trình học'}</Btn></Link>
      </div>
    </>
  )
}

export default function Placement() {
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [answers, setAnswers] = useState<number[]>([])
  const [result, setResult] = useState<GradeResult | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const load = () => {
    setError(null)
    api<{ questions: Question[] }>('/placement/questions')
      .then((r) => {
        setQuestions(r.questions)
        setAnswers(Array(r.questions.length).fill(-1))
      })
      .catch(setError)
  }
  useEffect(load, [])

  if (result) return <Result r={result} progress={progress} review={review} />
  if (error && !questions) return <ErrorBox error={error} onRetry={load} />
  if (!questions) return <Spinner />

  const answered = answers.filter((a) => a >= 0).length
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<GradeResult>('/placement/grade', { answers })
      const p = await api<{ progress: Progress | null }>('/placement/progress').catch(() => ({ progress: null }))
      setProgress(p.progress)
      const pl = await api<{ plan: { review: Review | null } | null }>('/plan').catch(() => ({ plan: null }))
      setReview(pl.plan?.review ?? null)
      setResult(r)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageTitle title="Kiểm tra trình độ" hint={`${questions.length} câu trắc nghiệm, khoảng 10 phút. Đã trả lời ${answered}/${questions.length}.`} />
      <div className="space-y-3">
        {questions.map((q, i) => (
          <Card key={i}>
            <p className="mb-1 text-xs font-medium text-slate-500">Câu {i + 1} · {KIND_LABEL[q.kind]}</p>
            {q.passage && <p className="mb-2 rounded-lg bg-slate-100 p-3 text-sm italic text-slate-700">{q.passage}</p>}
            <p className="mb-3 font-medium">{q.question}</p>
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Chọn đáp án cho câu {i + 1}</legend>
              {q.options.map((o, j) => (
                <label
                  key={j}
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${answers[i] === j ? 'border-indigo-500 bg-indigo-50 font-medium' : 'border-slate-200 hover:bg-slate-50'}`}
                >
                  <input type="radio" name={`q${i}`} checked={answers[i] === j} onChange={() => setAnswers((a) => a.map((x, k) => (k === i ? j : x)))} />
                  {o}
                </label>
              ))}
            </fieldset>
          </Card>
        ))}
      </div>
      {error != null && <div className="mt-3"><ErrorBox error={error} /></div>}
      <div className="sticky bottom-16 mt-4 md:bottom-4">
        <Btn onClick={submit} disabled={busy || answered < questions.length} className="w-full shadow-lg">
          {busy ? 'Đang chấm…' : answered < questions.length ? `Còn ${questions.length - answered} câu chưa trả lời` : 'Nộp bài'}
        </Btn>
      </div>
    </>
  )
}
