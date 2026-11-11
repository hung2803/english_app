import { generateAdjustment, type FutureWeek, type Proposal } from './adjustment'
import { todayVN } from './dates'
import type { Env } from './env'
import type { WeekRef } from './weekly'

/**
 * - pending:   chờ người học duyệt (có thay đổi đề xuất)
 * - approved:  đã duyệt
 * - rejected:  bỏ qua (không duyệt) → giữ lộ trình cũ
 * - no_change: AI thấy không cần đổi gì → chỉ lưu tóm tắt, không cần duyệt
 */
export type AdjustmentStatus = 'pending' | 'approved' | 'rejected' | 'no_change'

export interface Adjustment {
  id: number
  plan_id: number
  week_no: number
  summary_vi: string
  changes: FutureWeek[]
  status: AdjustmentStatus
  created_at: string
  decided_at: string | null
  emailed_at: string | null
}

interface Row extends Omit<Adjustment, 'changes'> {
  changes_json: string
}

const toAdjustment = (r: Row): Adjustment => {
  const { changes_json, ...rest } = r
  return { ...rest, changes: JSON.parse(changes_json) as FutureWeek[] }
}

/**
 * Lưu đề xuất của một tuần. Mỗi (lộ trình, tuần) chỉ có một đề xuất: gọi lại KHÔNG ghi đè.
 * Có thay đổi → 'pending'; không có → 'no_change' (đã chốt, không cần duyệt).
 */
export async function saveProposal(
  db: D1Database,
  planId: number,
  p: Proposal,
  today: string = todayVN(),
): Promise<{ created: boolean; adjustment: Adjustment }> {
  const noChange = p.changes.length === 0
  const res = await db
    .prepare(
      `INSERT INTO plan_adjustments (plan_id, week_no, summary_vi, changes_json, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (plan_id, week_no) DO NOTHING`,
    )
    .bind(planId, p.week_no, p.summary_vi, JSON.stringify(p.changes), noChange ? 'no_change' : 'pending', today, noChange ? today : null)
    .run()
  const created = ((res.meta as { changes?: number }).changes ?? 0) === 1
  const row = await db.prepare('SELECT * FROM plan_adjustments WHERE plan_id = ? AND week_no = ?').bind(planId, p.week_no).first<Row>()
  return { created, adjustment: toAdjustment(row!) }
}

export async function getAdjustment(db: D1Database, id: number): Promise<Adjustment | null> {
  const row = await db.prepare('SELECT * FROM plan_adjustments WHERE id = ?').bind(id).first<Row>()
  return row ? toAdjustment(row) : null
}

/** Danh sách đề xuất của lộ trình đang chạy, mới nhất trước; lọc theo trạng thái nếu có. */
export async function listAdjustments(db: D1Database, status?: AdjustmentStatus): Promise<Adjustment[]> {
  const { results } = await db
    .prepare(
      `SELECT a.* FROM plan_adjustments a JOIN plans p ON p.id = a.plan_id AND p.status = 'active'
       WHERE (?1 IS NULL OR a.status = ?1) ORDER BY a.week_no DESC`,
    )
    .bind(status ?? null)
    .all<Row>()
  return results.map(toAdjustment)
}

export type DecideResult = { ok: true; adjustment: Adjustment } | { ok: false; reason: 'not_found' | 'already_decided' }

/**
 * Người học quyết định: duyệt hoặc bỏ qua. Chỉ đề xuất đang 'pending' mới quyết định được, và quyết định là cuối cùng.
 * (Việc áp dụng thay đổi vào lộ trình khi duyệt làm ở bước riêng.)
 */
export async function decideAdjustment(
  db: D1Database,
  id: number,
  decision: 'approved' | 'rejected',
  today: string = todayVN(),
): Promise<DecideResult> {
  const res = await db
    .prepare("UPDATE plan_adjustments SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(decision, today, id)
    .run()
  const adj = await getAdjustment(db, id)
  if (!adj) return { ok: false, reason: 'not_found' }
  if (((res.meta as { changes?: number }).changes ?? 0) !== 1) return { ok: false, reason: 'already_decided' }
  return { ok: true, adjustment: adj }
}

/**
 * Việc chạy khi hoàn thành tuần (hàm `run` của dispatchWeeklyReview): AI tạo đề xuất rồi lưu.
 * Lỗi AI được ném ra, không lưu gì → tuần vẫn nằm trong findWeeksNeedingReview để thử lại.
 */
export async function runWeeklyReview(env: Env, week: WeekRef): Promise<Adjustment> {
  const proposal = await generateAdjustment(env, env.DB, week)
  return (await saveProposal(env.DB, week.planId, proposal)).adjustment
}

// ---------- Hiển thị + áp dụng khi duyệt ----------

export interface AdjustmentView extends Omit<Adjustment, 'changes'> {
  changes: (FutureWeek & { current_topic: string; current_goal_vi: string; can_apply: boolean })[]
}

/** Thêm chủ đề hiện tại của từng tuần để màn hình so sánh "cũ → mới", và cho biết tuần còn đổi được không. */
export async function toView(db: D1Database, adj: Adjustment): Promise<AdjustmentView> {
  const { results } = await db
    .prepare(
      `SELECT w.week_no, w.topic, w.goal_vi,
              NOT EXISTS (SELECT 1 FROM sessions s WHERE s.plan_id = w.plan_id AND s.week_no = w.week_no AND s.status = 'done') AS editable
       FROM plan_weeks w WHERE w.plan_id = ?`,
    )
    .bind(adj.plan_id)
    .all<{ week_no: number; topic: string; goal_vi: string; editable: number }>()
  const byWeek = new Map(results.map((w) => [w.week_no, w]))
  return {
    ...adj,
    changes: adj.changes.map((c) => ({
      ...c,
      current_topic: byWeek.get(c.week_no)?.topic ?? '',
      current_goal_vi: byWeek.get(c.week_no)?.goal_vi ?? '',
      can_apply: !!byWeek.get(c.week_no)?.editable,
    })),
  }
}

export type ApproveResult =
  | { ok: true; adjustment: Adjustment; applied: number[]; skipped: number[] }
  | { ok: false; reason: 'not_found' | 'already_decided' | 'plan_inactive' }

/**
 * Duyệt = áp dụng các thay đổi vào lộ trình, trong MỘT giao dịch cùng với việc đổi trạng thái sang 'approved'.
 * Chỉ đổi tuần chưa có buổi nào xong (tuần đã bắt đầu thì bỏ qua, báo trong `skipped`).
 * Đề xuất không còn 'pending' thì không làm gì cả.
 */
export async function approveAdjustment(db: D1Database, id: number, today: string = todayVN()): Promise<ApproveResult> {
  const adj = await getAdjustment(db, id)
  if (!adj) return { ok: false, reason: 'not_found' }
  if (adj.status !== 'pending') return { ok: false, reason: 'already_decided' }
  const plan = await db.prepare('SELECT status FROM plans WHERE id = ?').bind(adj.plan_id).first<{ status: string }>()
  if (plan?.status !== 'active') return { ok: false, reason: 'plan_inactive' }

  const view = await toView(db, adj)
  const applied = view.changes.filter((c) => c.can_apply).map((c) => c.week_no)
  const skipped = view.changes.filter((c) => !c.can_apply).map((c) => c.week_no)
  await db.batch([
    // các câu lệnh đổi chủ đề chạy TRƯỚC câu lệnh đổi trạng thái và chỉ có tác dụng khi đề xuất còn 'pending'
    ...view.changes.map((c) =>
      db
        .prepare(
          `UPDATE plan_weeks SET topic = ?, goal_vi = ?
           WHERE plan_id = ? AND week_no = ?
             AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.plan_id = plan_weeks.plan_id AND s.week_no = plan_weeks.week_no AND s.status = 'done')
             AND EXISTS (SELECT 1 FROM plan_adjustments WHERE id = ? AND status = 'pending')`,
        )
        .bind(c.topic, c.goal_vi, adj.plan_id, c.week_no, id),
    ),
    db.prepare("UPDATE plan_adjustments SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'").bind(today, id),
  ])
  const after = await getAdjustment(db, id)
  return { ok: true, adjustment: after!, applied, skipped }
}
