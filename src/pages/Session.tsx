import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import AiStep from '../components/AiStep'
import Chat from '../components/Chat'
import LessonSteps, { type LessonData } from '../components/LessonSteps'
import Quiz, { QuizResultView, type QuizQuestion, type QuizResult } from '../components/Quiz'
import Flashcards from '../components/Flashcards'
import ExerciseReview from '../components/ExerciseReview'
import VocabReview from '../components/VocabReview'
import { Btn, Card, ErrorBox, PageTitle, Speak, Spinner, fmtDate } from '../ui'

interface Option { type: 'article' | 'youtube' | 'podcast' | 'upload'; upload_id?: number; title: string; url: string; why_vi: string; excerpt: string }
interface Material { options: Option[]; chosen: number | null; fallback: boolean; fallback_reason?: 'no_results' | 'search_error' }
type Lesson = LessonData & { quiz?: QuizQuestion[] }
interface SessionData {
  id: number
  seq: number
  week_no: number
  topic: string
  scheduled_date: string
  status: 'pending' | 'done' | 'missed'
  score?: number | null
  material: Material | null
  lesson: Lesson | null
  result?: QuizResult | null
  /** Hoàn thành lượt hỗn hợp và một lượt thử lại từ sai trước khi bắt đầu. */
  review?: { required: boolean; passed: boolean; total: number; stage: number; stages: number; round: number }
  /** bài tập buổi trước chưa đạt 100%: required → phải làm lại các câu sai trước (rồi mới tới phần ôn từ vựng) */
  exercise?: { required: boolean; prev_seq: number | null; remaining: number; round: number }
  /** 0 = quiz của buổi này chưa đạt 100% (phải làm lại câu sai ở buổi kế tiếp) */
  quiz_mastered?: number | null
  /** điểm lần nộp đầu khi đã làm lại quiz tới 100% (score lúc đó = 100) */
  first_score?: number | null
}

const AI_MS = 70_000 // chờ phản hồi tối đa (máy chủ giới hạn ~60 giây)
const TYPE_LABEL = { article: 'Bài viết', youtube: 'Video YouTube', podcast: 'Podcast', upload: '📎 Tài liệu của bạn' }

function OptionCard({ o, onChoose, busy }: { o: Option; onChoose: () => void; busy: boolean }) {
  return (
    <Card className="space-y-2">
      <p className="text-xs font-semibold text-indigo-700">{TYPE_LABEL[o.type]}</p>
      <h3 className="font-semibold">{o.title}</h3>
      {o.why_vi && <p className="text-sm text-slate-600">{o.why_vi}</p>}
      {o.excerpt && <p className="rounded-lg bg-slate-100 p-2 text-sm italic text-slate-700">“{o.excerpt}”</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={onChoose} disabled={busy}>Chọn tài liệu này</Btn>
        {o.url && <a href={o.url} target="_blank" rel="noreferrer noopener" className="text-sm text-indigo-700 underline">Xem trước ↗</a>}
      </div>
    </Card>
  )
}

function ChooseStep({ material, sessionId, onDone }: { material: Material; sessionId: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const choose = async (index: number) => {
    setBusy(true)
    setError(null)
    try {
      await api(`/sessions/${sessionId}/choose`, { index })
      onDone()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">AI đã tìm {material.options.length} tài liệu. Hãy chọn 1 để học. <strong>Sau khi chọn sẽ không đổi được giữa buổi.</strong></p>
      {material.options.map((o, i) => (
        <OptionCard key={`${o.type}-${o.upload_id ?? o.url}`} o={o} busy={busy} onChoose={() => choose(i)} />
      ))}
      {error != null && <ErrorBox error={error} />}
    </div>
  )
}

/**
 * Bước 1 của buổi học: ôn flashcard đến hạn (~5 phút) trước khi bắt đầu.
 * Không có thẻ đến hạn thì không hiện gì; có thể bỏ qua và bắt đầu buổi học ngay.
 */
function StartReview() {
  const [due, setDue] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    api<{ total_due: number }>('/flashcards/due?limit=1')
      .then((r) => setDue(r.total_due))
      .catch(() => setDue(0)) // lỗi tải thẻ không được chặn việc bắt đầu buổi học
  }, [])

  if (hidden || !due) return null
  if (open) return <Flashcards onFinish={() => setHidden(true)} />
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold">Ôn từ vựng trước khi học</h2>
      <p className="text-sm text-slate-600">Có <strong>{due}</strong> thẻ đến hạn ôn. Ôn khoảng 5 phút giúp bạn nhớ lâu hơn.</p>
      <div className="flex flex-wrap gap-2">
        <Btn onClick={() => setOpen(true)}>Ôn ngay</Btn>
        <Btn variant="ghost" onClick={() => setHidden(true)}>Bỏ qua</Btn>
      </div>
    </Card>
  )
}

export default function SessionPage() {
  const { id } = useParams()
  const [s, setS] = useState<SessionData | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      setS((await api<{ session: SessionData }>(`/sessions/${id}`)).session)
    } catch (e) {
      setError(e)
    }
  }, [id])
  useEffect(() => {
    void load()
  }, [load])

  // các lệnh gọi AI: thành công thì tải lại buổi học để chuyển sang bước tiếp theo
  const search = useCallback(async () => {
    await api(`/sessions/${id}/materials`, {}, { timeoutMs: AI_MS })
    await load()
  }, [id, load])
  const compose = useCallback(async () => {
    await api(`/sessions/${id}/compose`, {}, { timeoutMs: AI_MS })
    await load()
  }, [id, load])

  if (error && !s) return <ErrorBox error={error} onRetry={load} />
  if (!s) return <Spinner />

  const m = s.material
  let body
  if (s.lesson) {
    body = (
      <div className="space-y-3">
        <LessonSteps l={s.lesson} sessionId={s.id} chat={<Chat sessionId={s.id} readOnly={s.status === 'done'} />} />
        {s.status === 'done' ? (
          s.result && (
            <>
              {s.quiz_mastered === 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  Buổi kế tiếp sẽ có một lượt sửa các câu sai và ôn từ vựng. Các mục chưa nhớ được giữ lại để luyện thêm.
                </div>
              )}
              <QuizResultView result={s.result} retried={s.first_score != null && s.score === 100 ? { finalScore: 100, firstScore: s.first_score } : undefined} />
            </>
          )
        ) : (
          s.lesson.quiz && s.lesson.quiz.length > 0 && <Quiz sessionId={s.id} quiz={s.lesson.quiz} onSubmitted={load} />
        )}
      </div>
    )
  }
  else if (s.status === 'done') body = <Card><p className="text-sm text-slate-600">Buổi học này đã xong.</p></Card>
  else if (!m && s.exercise?.required) {
    body = <ExerciseReview sessionId={s.id} onPassed={load} />
  } else if (!m && s.review?.required && !s.review.passed) {
    body = <VocabReview sessionId={s.id} onPassed={load} />
  } else if (!m) {
    body = (
      <div className="space-y-3">
        <StartReview />
        <AiStep
          run={search}
          startLabel="Bắt đầu buổi học"
          stages={['AI đang tìm tài liệu phù hợp…', 'Đang kiểm tra các đường dẫn…', 'Sắp xong…']}
          intro={<p className="text-sm text-slate-600">Khi bắt đầu, AI sẽ tìm 2–3 tài liệu để bạn chọn 1. Việc này mất khoảng nửa phút.</p>}
        />
      </div>
    )
  } else if (m.fallback) {
    body = (
      <AiStep
        run={compose}
        autoStart
        stages={['AI đang viết bài đọc…', 'Đang soạn từ vựng và ngữ pháp…', 'Sắp xong…']}
        intro={
          <p className="text-sm text-slate-600">
            {m.fallback_reason === 'search_error' ? 'Bước tìm tài liệu gặp lỗi' : 'Không tìm được tài liệu phù hợp'}, AI sẽ tự viết bài đọc cho buổi này.
          </p>
        }
      />
    )
  } else if (m.chosen === null) {
    body = <ChooseStep material={m} sessionId={s.id} onDone={load} />
  } else {
    body = (
      <AiStep
        run={compose}
        autoStart
        stages={['Đang đọc tài liệu…', 'AI đang soạn bài…', 'Đang tạo từ vựng và ngữ pháp…']}
        intro={<p className="text-sm text-slate-600">AI đang soạn bài từ tài liệu bạn đã chọn.</p>}
      />
    )
  }

  return (
    <>
      <PageTitle title={`Buổi ${s.seq}: ${s.topic}`} hint={`Tuần ${s.week_no} · ${fmtDate(s.scheduled_date)}`} />
      {body}
      <div className="mt-4"><Link to="/roadmap" className="text-sm text-indigo-700 underline">← Về lộ trình</Link></div>
    </>
  )
}
