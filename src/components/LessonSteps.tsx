import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Btn, Card, Speak } from '../ui'
import Recorder from './Recorder'
import LessonVocabulary from './LessonVocabulary'

export interface LessonData {
  title: string
  source: { type: string; url?: string; upload_id?: number; title: string; ai_written: boolean }
  excerpt: string
  reading?: string
  goals_vi?: string[]
  sentences?: { en: string; vi: string }[]
  grammar_practice?: { question: string; answer: string; explanation_vi?: string }[]
  task?: { en: string; vi: string }
  summary_vi: string
  explanation_vi: string
  vocab: { word: string; pos?: string; meaning_vi: string; example?: string }[]
  grammar: { point: string; explanation_vi: string; example?: string; examples?: string[] }[]
  notice_vi?: string
}

/** Thời lượng từng bước (phút): 50 phút học + 10 phút quiz = 60 phút. */
export const STEP_MINUTES = { review: 10, grammar: 12, listening: 13, speaking: 15 } as const
export const TOTAL_STUDY_MINUTES = Object.values(STEP_MINUTES).reduce((a, b) => a + b, 0)

function StepCard({ n, title, minutes, hint, children }: { n: number; title: string; minutes: number; hint: string; children: ReactNode }) {
  return (
    <Card className="space-y-3" >
      <div>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold" data-testid={`step-${n}`}>
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-sm text-white" aria-hidden>{n}</span>
          {title}
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{minutes} phút</span>
        </h2>
        <p className="mt-1 text-sm text-slate-600">{hint}</p>
      </div>
      {children}
    </Card>
  )
}

/** Giải thích nội dung bài bằng tiếng Việt: thu gọn mặc định (người mới bấm xem khi cần). */
function Explain({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 text-sm text-slate-700">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="min-h-11 font-medium text-indigo-700 underline">
        {open ? 'Ẩn giải thích' : 'Xem giải thích nội dung bài (tiếng Việt)'}
      </button>
      <p className="whitespace-pre-line" hidden={!open}>{text}</p>
    </div>
  )
}

/** Tách bài đọc thành câu khi bài cũ chưa có `sentences` (không có bản dịch). */
export function splitSentences(text: string): { en: string; vi: string }[] {
  return (text.match(/[^.!?]+[.!?]+["')]*|[^.!?]+$/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((en) => ({ en, vi: '' }))
}

/** Always show the lesson text independently of listening's hidden-subtitle mode. */
export function lessonReading(l: LessonData): string {
  return l.reading?.trim()
    || l.sentences?.map(s => s.en.trim()).filter(Boolean).join(' ')
    || l.excerpt?.trim()
    || ''
}

function Reading({ l }: { l: LessonData }) {
  const text = lessonReading(l)
  if (!text) return null
  return (
    <section aria-label="Bài đọc tiếng Anh" className="mt-4 space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-indigo-900">Bài đọc tiếng Anh</h3>
        <Speak text={text} label="Nghe bài đọc tiếng Anh" />
      </div>
      <p className="whitespace-pre-line text-base leading-8 text-slate-800" lang="en" data-testid="lesson-reading">{text}</p>
    </section>
  )
}

/** Bước 1: ôn cũ + học từ mới. */
function WordsStep({ l, sessionId }: { l: LessonData; sessionId?: number }) {
  return (
    <StepCard n={1} title="Ôn cũ và học từ mới" minutes={STEP_MINUTES.review} hint="Ôn một lượt ngắn rồi chọn từ mới muốn học. Nghe từng từ và câu ví dụ, đọc to theo.">
      <p className="text-sm">
        <Link to="/review" className="font-medium text-indigo-700 underline">Ôn các thẻ đến hạn</Link>
        <span className="text-slate-500"> (mỗi ngày tối đa 15 từ). Quay lại đây khi xong.</span>
      </p>
      <h3 className="font-semibold">Từ mới ({l.vocab.length} từ)</h3>
      <LessonVocabulary sessionId={sessionId} words={l.vocab} />
    </StepCard>
  )
}

/** Bước 2: một điểm ngữ pháp mới, chép ví dụ, làm bài tập và tự chấm bằng đáp án. */
function GrammarStep({ l }: { l: LessonData }) {
  const g = l.grammar[0]
  const [mine, setMine] = useState<Record<number, string>>({})
  const [shown, setShown] = useState<Record<number, boolean>>({})
  if (!g) return null
  const examples = g.examples?.length ? g.examples : g.example ? [g.example] : []
  return (
    <StepCard n={2} title="Học một điểm ngữ pháp mới" minutes={STEP_MINUTES.grammar} hint="Đọc phần giải thích, chép ví dụ vào vở, rồi làm bài tập và tự chấm bằng đáp án.">
      <div>
        <h3 className="font-semibold">{g.point}</h3>
        <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{g.explanation_vi}</p>
      </div>
      {examples.length > 0 && (
        <div className="rounded-xl bg-slate-100 p-3">
          <p className="mb-1 text-sm font-semibold">Chép các ví dụ này vào vở</p>
          <ul className="space-y-1">
            {examples.map((ex) => (
              <li key={ex} className="flex items-center gap-2 text-sm">
                <span>{ex}</span>
                <Speak text={ex} label="Nghe câu ví dụ" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {l.grammar_practice && l.grammar_practice.length > 0 && (
        <div>
          <h3 className="mb-2 font-semibold">Bài tập ({l.grammar_practice.length} câu, tự chấm)</h3>
          <ol className="space-y-3">
            {l.grammar_practice.map((p, i) => {
              const done = shown[i]
              const ok = done && mine[i]?.trim().toLowerCase().replace(/[.,!?]+$/, '') === p.answer.trim().toLowerCase()
              return (
                <li key={i} className="space-y-1 text-sm">
                  <p className="font-medium">{i + 1}. {p.question}</p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={mine[i] ?? ''}
                      onChange={(e) => setMine((m) => ({ ...m, [i]: e.target.value }))}
                      aria-label={`Bài tập ngữ pháp ${i + 1}`}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      maxLength={60}
                      className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                    />
                    <Btn variant="ghost" onClick={() => setShown((s) => ({ ...s, [i]: true }))}>Xem đáp án</Btn>
                  </div>
                  {done && (
                    <p className={`rounded-lg p-2 ${ok ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`} data-testid={`practice-answer-${i}`}>
                      {mine[i]?.trim() ? (ok ? '✅ Đúng. ' : '❌ Chưa khớp. ') : ''}Đáp án: <strong>{p.answer}</strong>
                      {p.explanation_vi && <span className="block text-slate-600">{p.explanation_vi}</span>}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </StepCard>
  )
}

/** Bước 3: nghe bài 3 lượt — không phụ đề, có phụ đề tiếng Anh, từng câu kèm dịch và nhại theo. */
function ListeningStep({ l }: { l: LessonData }) {
  const sentences = l.sentences?.length ? l.sentences : splitSentences(l.reading || l.excerpt)
  const full = sentences.map((s) => s.en).join(' ')
  const [pass, setPass] = useState<1 | 2 | 3>(1)
  const [vi, setVi] = useState(false)
  const PASSES = [
    { n: 1 as const, label: 'Lượt 1: nghe, không phụ đề', tip: 'Chỉ nghe, đừng nhìn chữ. Cố bắt ý chính và vài từ quen.' },
    { n: 2 as const, label: 'Lượt 2: nghe kèm phụ đề tiếng Anh', tip: 'Vừa nghe vừa đọc theo chữ, đối chiếu chỗ bạn nghe sót.' },
    { n: 3 as const, label: 'Lượt 3: từng câu, nhại theo', tip: 'Nghe từng câu rồi nhại lại, bắt chước cả ngữ điệu. Có thể ghi âm để nghe lại giọng mình.' },
  ]
  return (
    <StepCard n={3} title="Nghe" minutes={STEP_MINUTES.listening} hint="Nghe bài ngắn 3 lượt theo thứ tự dưới đây. Mỗi lượt dễ hơn lượt trước.">
      <div role="tablist" aria-label="Các lượt nghe" className="flex flex-wrap gap-2">
        {PASSES.map((p) => (
          <button
            key={p.n}
            type="button"
            role="tab"
            aria-selected={pass === p.n}
            onClick={() => setPass(p.n)}
            className={`min-h-11 rounded-xl border px-3 text-sm font-medium ${pass === p.n ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-slate-600">{PASSES[pass - 1].tip}</p>

      {pass === 1 && (
        <div className="flex items-center gap-3 rounded-xl bg-slate-100 p-4" data-testid="listen-pass-1">
          <span className="text-sm font-medium">Nghe cả bài (nên nghe 2 đến 3 lần)</span>
          <Speak text={full} label="Nghe cả bài" />
        </div>
      )}

      {pass === 2 && (
        <div className="space-y-2" data-testid="listen-pass-2">
          <p className="flex items-center gap-2 text-sm font-medium">Nghe cả bài <Speak text={full} label="Nghe cả bài" /></p>
          <ol className="space-y-1 text-sm">
            {sentences.map((s, i) => (
              <li key={i} className="flex items-center gap-2"><span>{s.en}</span> <Speak text={s.en} label="Nghe câu này" /></li>
            ))}
          </ol>
        </div>
      )}

      {pass === 3 && (
        <div className="space-y-3" data-testid="listen-pass-3">
          {sentences.some((s) => s.vi) && (
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={vi} onChange={(e) => setVi(e.target.checked)} className="h-5 w-5" />
              Hiện bản dịch tiếng Việt
            </label>
          )}
          <ol className="space-y-3">
            {sentences.map((s, i) => (
              <li key={i} className="space-y-1 rounded-xl border border-slate-200 p-3 text-sm">
                <p className="flex items-center gap-2 font-medium"><span>{s.en}</span> <Speak text={s.en} label="Nghe câu này" /></p>
                {vi && s.vi && <p className="text-slate-600" data-testid={`vi-${i}`}>{s.vi}</p>}
                <Recorder label="Nhại theo" />
              </li>
            ))}
          </ol>
        </div>
      )}
    </StepCard>
  )
}

/** Bước 4: viết 5 câu về bản thân (AI sửa lỗi trong khung chat) và nhại theo giọng mẫu. */
function SpeakingStep({ l, chat }: { l: LessonData; chat: ReactNode }) {
  return (
    <StepCard n={4} title="Nói và viết" minutes={STEP_MINUTES.speaking} hint="Đặt 5 câu về chính bạn bằng cấu trúc vừa học, viết ra, đọc to và tốt nhất là ghi âm lại. AI sẽ sửa lỗi cho bạn.">
      {l.task && (
        <div className="rounded-xl bg-indigo-50 p-3 text-sm">
          <p className="font-semibold text-indigo-900">Đề bài</p>
          <p className="text-slate-800">{l.task.vi}</p>
          <p className="italic text-slate-600">{l.task.en}</p>
        </div>
      )}
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>Viết 5 câu về bản thân vào khung chat bên dưới. AI trả lời và chỉ ra lỗi sai kèm giải thích.</li>
        <li>Sửa lại các câu sai rồi đọc to từng câu.</li>
        <li>Ghi âm lại và nghe giọng mình: <Recorder label="Ghi âm 5 câu" /></li>
        <li>Nhại theo giọng mẫu 10 phút ở bước Nghe (lượt 3), bắt chước cả ngữ điệu, không chỉ từ.</li>
      </ol>
      {chat}
    </StepCard>
  )
}

/**
 * Buổi học 50 phút gồm 4 bước, sau đó là quiz 10 phút (nằm ngoài component này):
 * 1) ôn cũ + từ mới, 2) một điểm ngữ pháp, 3) nghe 3 lượt, 4) nói và viết.
 */
export default function LessonSteps({ l, chat, sessionId }: { l: LessonData; chat: ReactNode; sessionId?: number }) {
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
        <p className="mt-2 text-sm text-slate-600" data-testid="session-plan">
          Buổi học {TOTAL_STUDY_MINUTES + 10} phút: {TOTAL_STUDY_MINUTES} phút học (ôn cũ và từ mới {STEP_MINUTES.review}, ngữ pháp {STEP_MINUTES.grammar}, nghe {STEP_MINUTES.listening}, nói và viết {STEP_MINUTES.speaking}) và 10 phút quiz.
        </p>
        {l.goals_vi && l.goals_vi.length > 0 && (
          <div className="mt-3 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">
            <p className="font-semibold">Mục tiêu buổi học</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{l.goals_vi.map((g) => <li key={g}>{g}</li>)}</ul>
          </div>
        )}
        {l.summary_vi && <p className="mt-3 text-sm text-slate-700"><strong>Nội dung bài:</strong> {l.summary_vi}</p>}
        <Reading l={l} />
        {l.explanation_vi && <Explain text={l.explanation_vi} />}
      </Card>
      <WordsStep l={l} sessionId={sessionId} />
      <GrammarStep l={l} />
      <ListeningStep l={l} />
      <SpeakingStep l={l} chat={chat} />
    </div>
  )
}
