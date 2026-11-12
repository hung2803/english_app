import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import AiStep from '../components/AiStep'
import Chat from '../components/Chat'
import Quiz, { QuizResultView, type QuizQuestion, type QuizResult } from '../components/Quiz'
import Flashcards from '../components/Flashcards'
import ExerciseReview from '../components/ExerciseReview'
import VocabReview from '../components/VocabReview'
import { Btn, Card, ErrorBox, PageTitle, Speak, Spinner, fmtDate } from '../ui'

interface Option { type: 'article' | 'youtube' | 'podcast' | 'upload'; upload_id?: number; title: string; url: string; why_vi: string; excerpt: string }
interface Material { options: Option[]; chosen: number | null; fallback: boolean; fallback_reason?: 'no_results' | 'search_error' }
interface Lesson {
  title: string
  source: { type: string; url?: string; upload_id?: number; title: string; ai_written: boolean }
  excerpt: string
  reading?: string
  goals_vi?: string[]
  task?: { en: string; vi: string }
  summary_vi: string
  explanation_vi: string
  vocab: { word: string; pos?: string; meaning_vi: string; example?: string }[]
  grammar: { point: string; explanation_vi: string; example?: string }[]
  quiz?: QuizQuestion[]
  notice_vi?: string
}
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
  /** ôn từ vựng bài trước: required && !passed → phải ôn xong (đúng 100%) mới bắt đầu buổi này */
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

function LessonView({ l }: { l: Lesson }) {
  return (
    <div className="space-y-3">
      {l.source.ai_written && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          ✍️ <strong>Bài đọc do AI viết.</strong> {l.notice_vi}
        </div>
      )}
      <Card>
        <h2 className="text-lg font-semibold">{l.title}</h2>
        {l.source.url ? (
          <a href={l.source.url} target="_blank" rel="noreferrer noopener" className="text-sm text-indigo-700 underline">Nguồn: {l.source.title} ↗</a>
        ) : (
          <p className="text-sm text-slate-500">{l.source.title}</p>
        )}
        {l.goals_vi && l.goals_vi.length > 0 && (
          <div className="mt-3 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">
            <p className="font-semibold">Mục tiêu buổi học (~30 phút)</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{l.goals_vi.map((g) => <li key={g}>{g}</li>)}</ul>
            <p className="mt-2 text-xs text-indigo-800">Các bước: 1) Đọc bài ~8 phút · 2) Từ vựng và ngữ pháp ~8 phút · 3) Viết/nói ~6 phút · 4) Quiz ~8 phút</p>
          </div>
        )}
        <h3 className="mb-1 mt-4 flex items-center gap-2 font-semibold">1. Đọc bài <Speak text={l.reading ?? l.excerpt} label="Nghe cả bài" /></h3>
        {l.reading ? (
          <>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-800">{l.reading}</p>
            <p className="mt-3 rounded-lg bg-slate-100 p-3 text-sm italic text-slate-700">Trích từ nguồn: “{l.excerpt}”</p>
          </>
        ) : (
          <p className="whitespace-pre-line rounded-lg bg-slate-100 p-3 text-sm leading-relaxed text-slate-800">{l.excerpt}</p>
        )}
      </Card>
      <Card>
        <h3 className="mb-1 font-semibold">Tóm tắt</h3>
        <p className="text-sm text-slate-700">{l.summary_vi}</p>
        <h3 className="mb-1 mt-3 font-semibold">Giải thích</h3>
        <p className="text-sm text-slate-700">{l.explanation_vi}</p>
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">2. Từ vựng</h3>
        <ul className="space-y-2">
          {l.vocab.map((v) => (
            <li key={v.word} className="text-sm">
              <span className="font-semibold text-indigo-700">{v.word}</span> <Speak text={v.word} />
              {v.pos && <span className="text-slate-500"> ({v.pos})</span>} — {v.meaning_vi}
              {v.example && (
                <p className="flex items-center gap-2 text-slate-500">
                  <span>{v.example}</span>
                  <Speak text={v.example} label="Nghe câu ví dụ" />
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">Ngữ pháp</h3>
        <ul className="space-y-2">
          {l.grammar.map((g) => (
            <li key={g.point} className="text-sm">
              <span className="font-semibold">{g.point}</span>: {g.explanation_vi}
              {g.example && (
                <p className="flex items-center gap-2 text-slate-500">
                  <span>{g.example}</span>
                  <Speak text={g.example} label="Nghe câu ví dụ" />
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {l.task && (
        <Card className="space-y-1">
          <h3 className="font-semibold">3. Viết / nói</h3>
          <p className="text-sm text-slate-700">{l.task.vi}</p>
          <p className="text-sm italic text-slate-600">{l.task.en}</p>
          <p className="text-xs text-slate-500">Trả lời trong khung chat bên dưới để được sửa lỗi. Sau đó làm quiz ở bước 4.</p>
        </Card>
      )}
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
        <LessonView l={s.lesson} />
        <Chat sessionId={s.id} readOnly={s.status === 'done'} />
        {s.status === 'done' ? (
          s.result && (
            <>
              {s.quiz_mastered === 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  Bài tập chưa đạt 100%. Khi mở buổi kế tiếp, bạn cần làm lại các câu sai (và ôn từ vựng) rồi mới học tiếp được.
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
