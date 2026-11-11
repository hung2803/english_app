import { compareLevels, type PlacementEntry, type PlacementProgress } from './placement-progress'
import { fold } from './flashcards'
import { bestStreak, currentStreak } from './streak'
import { PASS_PERCENT } from './quiz'

/** Mục tiêu hoàn thành: ≥ 80% số buổi của lộ trình. */
export const TARGET_PERCENT = 80

export interface Progress {
  plan: { id: number; level: string; start_date: string } | null
  streak: { current: number; best: number; studied_today: boolean; last_study_date: string | null }
  completion: {
    done: number
    total: number
    percent: number
    target_percent: number
    /** số buổi tối thiểu cần xong để đạt mục tiêu */
    target_sessions: number
    on_target: boolean
    weeks: { week_no: number; topic: string; done: number; total: number }[]
  } | null
  vocab: { total: number; learned: number; due: number; learned_percent: number }
  scores: { id: number; seq: number; week_no: number; title: string; topic: string; score: number; date: string }[]
  quiz: { count: number; average: number | null; pass_rate: number | null; pass_percent: number }
  level: PlacementProgress | null
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)

/** Tiến độ học tổng hợp: chuỗi ngày, hoàn thành, từ vựng, điểm quiz theo thời gian, so sánh mức CEFR. */
export async function buildProgress(db: D1Database, today: string): Promise<Progress> {
  const plan = await db.prepare("SELECT id, level, start_date FROM plans WHERE status = 'active'").first<{ id: number; level: string; start_date: string }>()

  // chuỗi ngày học: mọi buổi đã xong (kể cả lộ trình cũ)
  const { results: doneRows } = await db.prepare("SELECT DISTINCT completed_date AS d FROM sessions WHERE status = 'done' AND completed_date IS NOT NULL ORDER BY d").all<{ d: string }>()
  const dates = doneRows.map((r) => r.d)

  let completion: Progress['completion'] = null
  if (plan) {
    const { results: weeks } = await db
      .prepare(
        `SELECT w.week_no, w.topic, COUNT(s.id) AS total, COALESCE(SUM(s.status = 'done'), 0) AS done
         FROM plan_weeks w LEFT JOIN sessions s ON s.plan_id = w.plan_id AND s.week_no = w.week_no
         WHERE w.plan_id = ? GROUP BY w.week_no, w.topic ORDER BY w.week_no`,
      )
      .bind(plan.id)
      .all<{ week_no: number; topic: string; total: number; done: number }>()
    const done = weeks.reduce((a, w) => a + w.done, 0)
    const total = weeks.reduce((a, w) => a + w.total, 0)
    const percent = pct(done, total)
    completion = {
      done,
      total,
      percent,
      target_percent: TARGET_PERCENT,
      target_sessions: Math.ceil((total * TARGET_PERCENT) / 100),
      on_target: percent >= TARGET_PERCENT,
      weeks,
    }
  }

  const v = await db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(learned), 0) AS learned, COALESCE(SUM(due_date <= ?), 0) AS due FROM vocab')
    .bind(today)
    .first<{ total: number; learned: number; due: number }>()
  const vocab = { total: v?.total ?? 0, learned: v?.learned ?? 0, due: v?.due ?? 0, learned_percent: pct(v?.learned ?? 0, v?.total ?? 0) }

  // điểm quiz theo thời gian (mọi lộ trình), cũ → mới
  const { results: sc } = await db
    .prepare(
      `SELECT s.id, s.seq, s.week_no, s.score, s.completed_date AS date, s.lesson_json, w.topic
       FROM sessions s JOIN plan_weeks w ON w.plan_id = s.plan_id AND w.week_no = s.week_no
       WHERE s.status = 'done' AND s.score IS NOT NULL AND s.completed_date IS NOT NULL
       ORDER BY s.completed_date, s.id`,
    )
    .all<{ id: number; seq: number; week_no: number; score: number; date: string; lesson_json: string | null; topic: string }>()
  const scores = sc.map((r) => ({
    id: r.id,
    seq: r.seq,
    week_no: r.week_no,
    topic: r.topic,
    title: (r.lesson_json ? (JSON.parse(r.lesson_json) as { title?: string }).title : '') || r.topic,
    score: r.score,
    date: r.date,
  }))
  const average = scores.length ? Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length) : null

  const { results: placements } = await db.prepare('SELECT level, taken_at FROM placement_results ORDER BY id').all<PlacementEntry>()

  return {
    plan,
    streak: {
      current: currentStreak(dates, today),
      best: bestStreak(dates),
      studied_today: dates.includes(today),
      last_study_date: dates.at(-1) ?? null,
    },
    completion,
    vocab,
    scores,
    quiz: { count: scores.length, average, pass_rate: scores.length ? pct(scores.filter((s) => s.score >= PASS_PERCENT).length, scores.length) : null, pass_percent: PASS_PERCENT },
    level: compareLevels(placements, today),
  }
}

// ---------- Lịch sử buổi học ----------

export const HISTORY_PAGE_SIZE = 20

export interface HistoryItem {
  id: number
  seq: number
  week_no: number
  topic: string
  title: string
  source: { type: string; title: string; url?: string; ai_written: boolean } | null
  score: number | null
  passed: boolean | null
  completed_date: string
  vocab_count: number
}

export interface HistoryPage {
  items: HistoryItem[]
  matched: number
  total: number
  page: number
  page_size: number
}

/**
 * Các buổi đã học (mới nhất trước). Tìm theo chủ đề tuần, tiêu đề bài, nguồn hoặc từ vựng của bài,
 * không phân biệt hoa thường và dấu tiếng Việt. Mở một buổi để xem lại tài liệu, từ vựng, quiz.
 */
export async function listHistory(db: D1Database, opts: { q?: string; page?: number } = {}): Promise<HistoryPage> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.seq, s.week_no, s.score, s.completed_date, s.lesson_json, w.topic
       FROM sessions s JOIN plan_weeks w ON w.plan_id = s.plan_id AND w.week_no = s.week_no
       WHERE s.status = 'done' ORDER BY s.completed_date DESC, s.id DESC`,
    )
    .all<{ id: number; seq: number; week_no: number; score: number | null; completed_date: string; lesson_json: string | null; topic: string }>()

  const q = fold(opts.q ?? '')
  const all = results.map((r) => {
    const l = r.lesson_json ? (JSON.parse(r.lesson_json) as { title?: string; source?: HistoryItem['source']; vocab?: { word: string; meaning_vi?: string }[] }) : null
    const item: HistoryItem = {
      id: r.id,
      seq: r.seq,
      week_no: r.week_no,
      topic: r.topic,
      title: l?.title ?? '',
      source: l?.source ? { type: l.source.type, title: l.source.title, ...(l.source.url ? { url: l.source.url } : {}), ai_written: l.source.ai_written } : null,
      score: r.score,
      passed: r.score === null ? null : r.score >= PASS_PERCENT,
      completed_date: r.completed_date,
      vocab_count: l?.vocab?.length ?? 0,
    }
    const hay = fold([item.topic, item.title, item.source?.title ?? '', ...(l?.vocab ?? []).map((v) => v.word)].join(' '))
    return { item, hay }
  })
  const matches = all.filter((x) => !q || x.hay.includes(q)).map((x) => x.item)
  const page = Math.max(1, Math.floor(opts.page ?? 1) || 1)
  return {
    items: matches.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE),
    matched: matches.length,
    total: all.length,
    page,
    page_size: HISTORY_PAGE_SIZE,
  }
}
