import type { Env } from './env'
import { AiError } from './errors'
import { geminiJson } from './gemini'
import type { WeekRef } from './weekly'

export const PASS_SCORE = 70
const MAX_TOPIC = 80
const MAX_GOAL = 200
const MAX_SUMMARY = 800
/** Chạy nền sau khi trả lời người học: Cloudflare chỉ cho `waitUntil` tối đa ~30 giây, nên chờ AI tối đa 25 giây. */
export const ADJUST_TIMEOUT_MS = 25_000

export interface FutureWeek {
  week_no: number
  topic: string
  goal_vi: string
}

export interface WeekData {
  weekNo: number
  level: string
  topic: string
  /** điểm quiz các buổi đã xong của tuần (theo thứ tự buổi) */
  scores: number[]
  average: number | null
  /** số buổi dưới ngưỡng đạt (70%) */
  lowCount: number
  /** từ hay sai nhất (wrong_count giảm dần) */
  hardWords: { word: string; wrong: number }[]
  /** từ làm sai ngay trong quiz của TUẦN NÀY (số buổi làm sai giảm dần) */
  weekWords: { word: string; sessions: number }[]
  /** các tuần phía sau CHƯA bắt đầu → có thể đổi chủ đề */
  futureWeeks: FutureWeek[]
}

export interface Proposal {
  week_no: number
  summary_vi: string
  /** chỉ gồm các tuần thật sự đổi chủ đề */
  changes: FutureWeek[]
}

/** Gom dữ liệu cho AI: điểm quiz của tuần vừa xong, từ hay sai, các tuần sau có thể đổi. */
export async function collectWeekData(db: D1Database, week: WeekRef): Promise<WeekData> {
  const plan = await db.prepare('SELECT level FROM plans WHERE id = ?').bind(week.planId).first<{ level: string }>()
  const thisWeek = await db
    .prepare('SELECT topic FROM plan_weeks WHERE plan_id = ? AND week_no = ?')
    .bind(week.planId, week.weekNo)
    .first<{ topic: string }>()
  const sessions = await db
    // điểm lần nộp ĐẦU (làm lại tới 100% không che mất chỗ người học còn yếu)
    .prepare("SELECT COALESCE(first_score, score) AS score, result_json FROM sessions WHERE plan_id = ? AND week_no = ? AND status = 'done' ORDER BY seq")
    .bind(week.planId, week.weekNo)
    .all<{ score: number | null; result_json: string | null }>()
  const scores = sessions.results.map((s) => s.score).filter((s): s is number => s !== null)
  // từ làm sai trong quiz của tuần: đếm theo số buổi làm sai từ đó
  const missed = new Map<string, { word: string; sessions: number }>()
  for (const r of sessions.results) {
    if (!r.result_json) continue
    for (const w of (JSON.parse(r.result_json) as { review_words?: string[] }).review_words ?? []) {
      const e = missed.get(w.toLowerCase()) ?? { word: w, sessions: 0 }
      e.sessions++
      missed.set(w.toLowerCase(), e)
    }
  }
  const weekWords = [...missed.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 15)
  const hard = await db
    .prepare('SELECT word, wrong_count AS wrong FROM vocab WHERE wrong_count > 0 ORDER BY wrong_count DESC, id LIMIT 15')
    .all<{ word: string; wrong: number }>()
  // tuần sau mà chưa buổi nào xong mới được đổi chủ đề
  const future = await db
    .prepare(
      `SELECT w.week_no, w.topic, w.goal_vi
       FROM plan_weeks w
       WHERE w.plan_id = ? AND w.week_no > ?
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.plan_id = w.plan_id AND s.week_no = w.week_no AND s.status = 'done')
       ORDER BY w.week_no`,
    )
    .bind(week.planId, week.weekNo)
    .all<FutureWeek>()
  return {
    weekNo: week.weekNo,
    level: plan?.level ?? '?',
    topic: thisWeek?.topic ?? '',
    scores,
    average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    lowCount: scores.filter((s) => s < PASS_SCORE).length,
    hardWords: hard.results,
    weekWords,
    futureWeeks: future.results,
  }
}

export function buildPrompt(d: WeekData): string {
  const scores = d.scores.length ? d.scores.map((s) => `${s}%`).join(', ') : 'no quiz scores'
  const weekWords = d.weekWords.length ? d.weekWords.map((w) => `${w.word} (missed in ${w.sessions} session${w.sessions > 1 ? 's' : ''})`).join(', ') : 'none'
  const words = d.hardWords.length ? d.hardWords.map((w) => `${w.word} (wrong ${w.wrong}x)`).join(', ') : 'none recorded'
  const future = d.futureWeeks.map((w) => `- week ${w.week_no}: "${w.topic}" — ${w.goal_vi}`).join('\n')
  return `You are an English tutor reviewing one finished study week of a Vietnamese learner (CEFR ${d.level}).
Week ${d.weekNo} topic: "${d.topic}".
Quiz scores of the 5 sessions: ${scores}${d.average !== null ? ` (average ${d.average}%, ${d.lowCount} below ${PASS_SCORE}%)` : ''}.
Words missed in this week's quizzes: ${weekWords}.
Words the learner often gets wrong overall: ${words}.

Upcoming weeks that have NOT started and may be changed:
${future || '(none)'}

Task:
1. Write a short weekly summary in Vietnamese (2-4 sentences): what went well, what was weak.
2. Propose changes ONLY where the results justify it. Change the topic and goal of an upcoming week only to fix real weaknesses (e.g. revisit a weak area, add vocabulary the learner keeps missing). Strong results (average >= 85% and few wrong words) usually need NO change.
   - Only use week numbers from the list above; change at most ${Math.min(3, d.futureWeeks.length)} weeks.
   - Keep the topic at the learner's CEFR level and different from the other weeks.
Return ONLY JSON:
{"summary_vi":"...","changes":[{"week_no":${d.futureWeeks[0]?.week_no ?? d.weekNo + 1},"topic":"English title, max 8 words","goal_vi":"Mục tiêu bằng tiếng Việt, tối đa 15 từ"}]}
Use "changes":[] if no change is needed.`
}

/**
 * Kiểm tra và làm sạch kết quả AI. Ném lỗi nếu không có tóm tắt hợp lệ.
 * Bỏ các thay đổi không hợp lệ: sai số tuần (không phải tuần sau chưa bắt đầu), trùng tuần, rỗng, quá dài, hoặc không đổi gì.
 */
export function normalizeProposal(raw: unknown, d: WeekData): Proposal {
  const r = raw as { summary_vi?: unknown; changes?: unknown }
  const summary = typeof r?.summary_vi === 'string' ? r.summary_vi.trim() : ''
  if (!summary || summary.length > MAX_SUMMARY) throw new AiError('other', 'Đề xuất thiếu tóm tắt')
  const byWeek = new Map(d.futureWeeks.map((w) => [w.week_no, w]))
  const changes: FutureWeek[] = []
  const seen = new Set<number>()
  for (const c of Array.isArray(r.changes) ? (r.changes as Record<string, unknown>[]) : []) {
    const week_no = c?.week_no
    const topic = typeof c?.topic === 'string' ? c.topic.trim() : ''
    const goal_vi = typeof c?.goal_vi === 'string' ? c.goal_vi.trim() : ''
    if (typeof week_no !== 'number' || !byWeek.has(week_no) || seen.has(week_no)) continue
    if (!topic || !goal_vi || topic.length > MAX_TOPIC || goal_vi.length > MAX_GOAL) continue
    const cur = byWeek.get(week_no)!
    if (topic.toLowerCase() === cur.topic.toLowerCase() && goal_vi === cur.goal_vi) continue // không đổi gì
    seen.add(week_no)
    changes.push({ week_no, topic, goal_vi })
  }
  changes.sort((a, b) => a.week_no - b.week_no)
  return { week_no: d.weekNo, summary_vi: summary, changes }
}

/**
 * AI đọc điểm quiz + từ hay sai của tuần vừa xong rồi đề xuất đổi chủ đề các tuần sau.
 * Không lưu gì; lỗi AI được ném ra (AiError) để bên gọi thử lại sau.
 */
export async function generateAdjustment(env: Env, db: D1Database, week: WeekRef): Promise<Proposal> {
  const data = await collectWeekData(db, week)
  const raw = await geminiJson<unknown>(env, [{ text: buildPrompt(data) }], { timeoutMs: ADJUST_TIMEOUT_MS })
  return normalizeProposal(raw, data)
}
