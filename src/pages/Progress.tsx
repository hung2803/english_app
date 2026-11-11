import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import ScoreChart, { type ScorePoint } from '../components/ScoreChart'
import { Btn, Card, ErrorBox, PageTitle, Spinner, fmtDate } from '../ui'

interface ProgressData {
  plan: { id: number; level: string; start_date: string } | null
  streak: { current: number; best: number; studied_today: boolean; last_study_date: string | null }
  completion: {
    done: number
    total: number
    percent: number
    target_percent: number
    target_sessions: number
    on_target: boolean
    weeks: { week_no: number; topic: string; done: number; total: number }[]
  } | null
  vocab: { total: number; learned: number; due: number; learned_percent: number }
  scores: ScorePoint[]
  quiz: { count: number; average: number | null; pass_rate: number | null; pass_percent: number }
  level: {
    baseline: { level: string; taken_at: string }
    latest: { level: string; taken_at: string }
    bands_gained: number | null
    success: boolean | null
    retake_date: string
    retake_due: boolean
    days_until_retake: number
  } | null
}

function Bar({ value, marker, label }: { value: number; marker?: number; label: string }) {
  return (
    <div className="relative h-3 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-indigo-600" style={{ width: `${Math.min(100, value)}%` }} />
      {marker !== undefined && <div className="absolute inset-y-0 w-0.5 bg-emerald-600" style={{ left: `${marker}%` }} title={`Mục tiêu ${marker}%`} />}
    </div>
  )
}

function Streak({ s }: { s: ProgressData['streak'] }) {
  return (
    <Card className="flex items-center gap-4">
      <p className="text-4xl font-bold text-orange-600" aria-label="Chuỗi ngày học">🔥 {s.current}</p>
      <div className="text-sm">
        <p className="font-semibold">{s.current > 0 ? `${s.current} ngày học liên tiếp` : 'Chưa có chuỗi ngày học'}</p>
        <p className="text-slate-500">Dài nhất: {s.best} ngày{s.last_study_date ? ` · học gần nhất ${fmtDate(s.last_study_date)}` : ''}</p>
        <p className={s.studied_today ? 'text-emerald-700' : 'text-amber-700'}>
          {s.studied_today ? '✅ Hôm nay bạn đã học' : 'Hôm nay chưa học: học một buổi để giữ chuỗi'}
        </p>
        <p className="text-xs text-slate-400">Chỉ tính thứ 2–thứ 6; cuối tuần không làm đứt chuỗi.</p>
      </div>
    </Card>
  )
}

function Completion({ c }: { c: NonNullable<ProgressData['completion']> }) {
  const missing = Math.max(0, c.target_sessions - c.done)
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Hoàn thành lộ trình</h2>
        <p className="text-sm text-slate-600"><strong className="text-indigo-700">{c.done}/{c.total}</strong> buổi · {c.percent}%</p>
      </div>
      <Bar value={c.percent} marker={c.target_percent} label="Tỉ lệ hoàn thành lộ trình" />
      <p className={`text-sm ${c.on_target ? 'text-emerald-700' : 'text-slate-600'}`}>
        {c.on_target
          ? `✅ Đã đạt mục tiêu hoàn thành ≥ ${c.target_percent}%.`
          : `Mục tiêu ≥ ${c.target_percent}%: cần ít nhất ${c.target_sessions} buổi, còn thiếu ${missing} buổi.`}
      </p>
      <ul className="space-y-1.5" aria-label="Tiến độ từng tuần">
        {c.weeks.map((w) => (
          <li key={w.week_no} className="flex items-center gap-2 text-xs">
            <span className="w-12 shrink-0 text-slate-500">Tuần {w.week_no}</span>
            <span className="flex flex-1 gap-0.5" aria-hidden>
              {Array.from({ length: w.total }, (_, i) => (
                <span key={i} className={`h-2 flex-1 rounded-sm ${i < w.done ? 'bg-indigo-600' : 'bg-slate-200'}`} />
              ))}
            </span>
            <span className="w-8 shrink-0 text-right font-medium text-slate-700" aria-label={`Tuần ${w.week_no}: ${w.done} trên ${w.total} buổi`}>{w.done}/{w.total}</span>
            <span className="hidden w-40 shrink-0 truncate text-slate-400 sm:inline">{w.topic}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Vocab({ v }: { v: ProgressData['vocab'] }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Từ vựng</h2>
        <Link to="/vocab" className="text-sm text-indigo-700 underline">Xem kho từ vựng</Link>
      </div>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div><p className="text-2xl font-bold text-indigo-700">{v.total}</p><p className="text-xs text-slate-500">Đã học</p></div>
        <div><p className="text-2xl font-bold text-emerald-700">{v.learned}</p><p className="text-xs text-slate-500">Đã thuộc</p></div>
        <div><p className="text-2xl font-bold text-amber-700">{v.due}</p><p className="text-xs text-slate-500">Đến hạn ôn</p></div>
      </div>
      <Bar value={v.learned_percent} label="Tỉ lệ từ đã thuộc" />
      <p className="text-xs text-slate-500">{v.total === 0 ? 'Từ vựng sẽ được thêm sau mỗi buổi học.' : `${v.learned_percent}% số từ đã thuộc (khoảng cách ôn từ 21 ngày).`}</p>
    </Card>
  )
}

function Quiz({ scores, quiz }: { scores: ScorePoint[]; quiz: ProgressData['quiz'] }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Điểm quiz theo thời gian</h2>
        {quiz.average !== null && <p className="text-sm text-slate-600">Trung bình <strong className="text-indigo-700">{quiz.average}%</strong> · đạt {quiz.pass_rate}% số bài</p>}
      </div>
      {scores.length === 0 ? <p className="text-sm text-slate-600">Chưa có điểm quiz nào. Biểu đồ sẽ hiện sau buổi học đầu tiên.</p> : <ScoreChart scores={scores} />}
    </Card>
  )
}

function Level({ l }: { l: NonNullable<ProgressData['level']> }) {
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold">Trình độ CEFR</h2>
      <p className="text-sm">
        Lần đầu <strong>{l.baseline.level}</strong> ({fmtDate(l.baseline.taken_at)}) → hiện tại <strong>{l.latest.level}</strong> ({fmtDate(l.latest.taken_at)})
        {l.bands_gained !== null && l.bands_gained !== 0 && <span className="text-slate-500"> ({l.bands_gained > 0 ? '+' : ''}{l.bands_gained} bậc)</span>}
      </p>
      {l.success === true && <p className="text-sm text-emerald-700">🎉 Đạt mục tiêu: đã lên ít nhất 1 bậc so với lần đầu.</p>}
      {l.success === false && <p className="text-sm text-amber-700">Chưa lên bậc so với lần đầu. Tiếp tục học và làm lại bài kiểm tra.</p>}
      {l.success === null && <p className="text-sm text-slate-600">Chưa có lần làm lại để so sánh.</p>}
      <p className="text-xs text-slate-500">
        {l.retake_due ? 'Đã đến lúc làm lại bài kiểm tra trình độ.' : `Nên làm lại bài kiểm tra vào ${fmtDate(l.retake_date)} (còn ${l.days_until_retake} ngày).`}
      </p>
      {l.retake_due && <Link to="/placement"><Btn>Làm lại bài kiểm tra</Btn></Link>}
    </Card>
  )
}

export default function Progress() {
  const [d, setD] = useState<ProgressData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(() => {
    setError(null)
    api<ProgressData>('/progress').then(setD).catch(setError)
  }, [])
  useEffect(load, [load])

  if (error != null && !d) return <ErrorBox error={error} onRetry={load} />
  if (!d) return <Spinner />

  return (
    <>
      <PageTitle title="Tiến độ" hint="Chuỗi ngày học, số buổi đã xong, từ vựng và điểm quiz." />
      <div className="space-y-3">
        <Streak s={d.streak} />
        {d.completion ? (
          <Completion c={d.completion} />
        ) : (
          <Card className="space-y-2">
            <h2 className="font-semibold">Hoàn thành lộ trình</h2>
            <p className="text-sm text-slate-600">Bạn chưa có lộ trình đang học.</p>
            <Link to="/roadmap"><Btn variant="ghost">Về lộ trình</Btn></Link>
          </Card>
        )}
        <Vocab v={d.vocab} />
        <Quiz scores={d.scores} quiz={d.quiz} />
        {d.level && <Level l={d.level} />}
      </div>
    </>
  )
}
