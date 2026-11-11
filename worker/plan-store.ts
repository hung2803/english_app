import type { Level } from './placement-bank'
import type { WeekPlan } from './planning'
import { checkNextPlan, levelsRequired, type LevelTally } from './placement'
import { buildSchedule, buildScheduleRange, rollForward, SESSIONS_PER_WEEK } from './schedule'

export interface PlanProgress {
  done: number
  total: number
  /** đã học xong toàn bộ buổi của lộ trình (hết 12 tuần) */
  finished: boolean
}

export async function planProgress(db: D1Database, planId: number): Promise<PlanProgress> {
  const r = await db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done FROM sessions WHERE plan_id = ?")
    .bind(planId)
    .first<{ total: number; done: number }>()
  const total = r?.total ?? 0
  const done = r?.done ?? 0
  return { done, total, finished: total > 0 && done === total }
}

export type ReviewState = 'need_retest' | 'passed' | 'failed'

export interface ReviewStatus {
  state: ReviewState
  /** các mức cần đúng 100% */
  required: Level[]
  /** các mức chưa đúng 100% ở bài test lại (khi failed) */
  weak: Level[]
  /** id kết quả test lại đang được xét */
  placementId: number | null
}

export interface PlanRef {
  id: number
  level: Level
  placement_id: number | null
  checked_placement_id: number | null
}

/**
 * Lộ trình đã học xong: đã test lại chưa, và đạt chưa?
 * - need_retest: chưa có kết quả test nào mới hơn lần test đầu lộ trình / lần đã xét.
 * - passed: test lại đúng 100% mọi mức từ A0 tới mức kế tiếp → được sang lộ trình mới.
 * - failed: chưa đạt → phải thêm tuần ôn tập, chưa được tạo lộ trình mới.
 */
export async function reviewStatus(db: D1Database, plan: PlanRef): Promise<ReviewStatus> {
  const since = Math.max(plan.placement_id ?? 0, plan.checked_placement_id ?? 0)
  const latest = await db
    .prepare('SELECT id, per_level_json FROM placement_results WHERE id > ? ORDER BY id DESC LIMIT 1')
    .bind(since)
    .first<{ id: number; per_level_json: string | null }>()
  const required = levelsRequired(plan.level)
  if (!latest) return { state: 'need_retest', required, weak: [], placementId: null }
  const check = checkNextPlan(latest.per_level_json ? (JSON.parse(latest.per_level_json) as LevelTally) : null, plan.level)
  return { state: check.passed ? 'passed' : 'failed', required, weak: check.weak, placementId: latest.id }
}

/**
 * Thêm tuần ôn tập vào cuối lộ trình đang chạy (mỗi tuần 5 buổi, bắt đầu từ `start`),
 * và ghi nhận lần test đã xét (`checkedPlacementId`) để lần sau phải test lại mới.
 */
export async function extendPlan(
  db: D1Database,
  p: { planId: number; weeks: { topic: string; goal_vi: string }[]; start: string; checkedPlacementId: number },
) {
  const last = await db
    .prepare('SELECT MAX(seq) AS seq, MAX(week_no) AS week FROM sessions WHERE plan_id = ?')
    .bind(p.planId)
    .first<{ seq: number; week: number }>()
  const firstWeek = (last?.week ?? 0) + 1
  const sessions = buildScheduleRange(p.start, (last?.seq ?? 0) + 1, p.weeks.length * SESSIONS_PER_WEEK)
  await db.batch([
    db
      .prepare(`INSERT INTO plan_weeks (plan_id, week_no, topic, goal_vi) VALUES ${p.weeks.map(() => '(?, ?, ?, ?)').join(', ')}`)
      .bind(...p.weeks.flatMap((w, k) => [p.planId, firstWeek + k, w.topic, w.goal_vi])),
    db
      .prepare(`INSERT INTO sessions (plan_id, seq, week_no, scheduled_date) VALUES ${sessions.map(() => '(?, ?, ?, ?)').join(', ')}`)
      .bind(...sessions.flatMap((s) => [p.planId, s.seq, s.week_no, s.scheduled_date])),
    db.prepare('UPDATE plans SET checked_placement_id = ? WHERE id = ?').bind(p.checkedPlacementId, p.planId),
  ])
  return { firstWeek, weeks: p.weeks.length, sessions: sessions.length, endDate: sessions[sessions.length - 1].scheduled_date }
}

/**
 * Dời các buổi bị lỡ của một lộ trình tới hôm nay trở đi, đánh dấu 'missed'. Trả số buổi đã đổi.
 * Gọi mỗi khi đọc lộ trình; idempotent trong cùng một ngày.
 */
export async function syncSchedule(db: D1Database, planId: number, today: string): Promise<number> {
  const { results } = await db
    .prepare("SELECT id, scheduled_date FROM sessions WHERE plan_id = ? AND status != 'done' ORDER BY seq")
    .bind(planId)
    .all<{ id: number; scheduled_date: string }>()
  const changes = rollForward(results, today)
  if (!changes.length) return 0
  await db.batch(
    changes.map((c) =>
      db
        .prepare("UPDATE sessions SET scheduled_date = ?, status = CASE WHEN ? = 1 THEN 'missed' ELSE status END WHERE id = ?")
        .bind(c.scheduled_date, c.missed ? 1 : 0, c.id),
    ),
  )
  return changes.length
}

const ACTIVE_PLAN_ID = "(SELECT id FROM plans WHERE status = 'active')"
// D1 giới hạn 100 tham số mỗi câu lệnh → chia nhỏ khi chèn nhiều dòng.
const SESSION_CHUNK = 30 // 3 tham số × 30 = 90

/**
 * Lưu lộ trình mới trong MỘT giao dịch (db.batch): lưu trữ lộ trình đang chạy,
 * rồi tạo plan + 12 tuần + 60 buổi. Lỗi giữa chừng thì không thay đổi gì.
 */
export async function savePlan(
  db: D1Database,
  p: { level: Level; placementId: number | null; weeks: WeekPlan[]; startDate: string; today: string },
) {
  const sessions = buildSchedule(p.startDate)
  const stmts = [
    db.prepare("UPDATE plans SET status = 'archived' WHERE status = 'active'"),
    db
      .prepare("INSERT INTO plans (level, placement_id, start_date, status, created_at) VALUES (?, ?, ?, 'active', ?)")
      .bind(p.level, p.placementId, sessions[0].scheduled_date, p.today),
    db
      .prepare(
        `INSERT INTO plan_weeks (week_no, topic, goal_vi, plan_id) VALUES ${p.weeks.map(() => `(?, ?, ?, ${ACTIVE_PLAN_ID})`).join(', ')}`,
      )
      .bind(...p.weeks.flatMap((w) => [w.week, w.topic, w.goal_vi])),
  ]
  for (let i = 0; i < sessions.length; i += SESSION_CHUNK) {
    const chunk = sessions.slice(i, i + SESSION_CHUNK)
    stmts.push(
      db
        .prepare(
          `INSERT INTO sessions (seq, week_no, scheduled_date, plan_id) VALUES ${chunk.map(() => `(?, ?, ?, ${ACTIVE_PLAN_ID})`).join(', ')}`,
        )
        .bind(...chunk.flatMap((s) => [s.seq, s.week_no, s.scheduled_date])),
    )
  }
  await db.batch(stmts)
  const plan = await db.prepare("SELECT id FROM plans WHERE status = 'active'").first<{ id: number }>()
  return { planId: plan!.id, startDate: sessions[0].scheduled_date, endDate: sessions[sessions.length - 1].scheduled_date }
}
