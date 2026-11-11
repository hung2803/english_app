export interface WeekRef {
  planId: number
  weekNo: number
}

/**
 * Các tuần "vừa xong" cần AI xem lại để đề xuất điều chỉnh lộ trình (chỉ lộ trình đang chạy):
 * - cả 5 buổi của tuần đã xong (không còn buổi chưa học hay bị lỡ);
 * - chưa có đề xuất cho tuần đó;
 * - còn ít nhất một buổi chưa xong ở các tuần sau (nếu không thì không còn gì để điều chỉnh).
 * Chỉ lấy tuần xong MỚI NHẤT: đề xuất cho tuần đã cũ không còn ý nghĩa.
 */
export async function findWeeksNeedingReview(db: D1Database): Promise<WeekRef[]> {
  // Tuần xong mới nhất của lộ trình đang chạy, kèm: đã có đề xuất chưa, còn tuần sau chưa xong không.
  const latest = await db
    .prepare(
      `SELECT s.plan_id AS planId, s.week_no AS weekNo,
              EXISTS (SELECT 1 FROM plan_adjustments a WHERE a.plan_id = s.plan_id AND a.week_no = s.week_no) AS hasProposal,
              EXISTS (SELECT 1 FROM sessions f WHERE f.plan_id = s.plan_id AND f.week_no > s.week_no AND f.status != 'done') AS hasLater
       FROM sessions s
       JOIN plans p ON p.id = s.plan_id AND p.status = 'active'
       GROUP BY s.plan_id, s.week_no
       HAVING COUNT(*) = SUM(s.status = 'done')
       ORDER BY s.week_no DESC
       LIMIT 1`,
    )
    .first<WeekRef & { hasProposal: number; hasLater: number }>()
  if (!latest || latest.hasProposal || !latest.hasLater) return []
  return [{ planId: latest.planId, weekNo: latest.weekNo }]
}

/**
 * Gọi ngay sau khi một buổi học được đánh dấu xong.
 * Trả về tuần vừa hoàn thành nếu buổi này là buổi hoàn tất tuần đó (thường là buổi thứ 5), ngược lại null.
 */
export async function detectWeekCompleted(db: D1Database, sessionId: number): Promise<WeekRef | null> {
  const s = await db
    .prepare('SELECT plan_id AS planId, week_no AS weekNo, status FROM sessions WHERE id = ?')
    .bind(sessionId)
    .first<WeekRef & { status: string }>()
  if (!s || s.status !== 'done') return null
  const due = await findWeeksNeedingReview(db)
  return due.find((w) => w.planId === s.planId && w.weekNo === s.weekNo) ?? null
}

export type WeeklyReviewJob = (week: WeekRef) => Promise<void>

/**
 * Phát hiện tuần vừa xong và kích hoạt AI (`run`). Lỗi của AI không làm hỏng việc nộp bài:
 * chỉ ghi log, và tuần đó vẫn nằm trong findWeeksNeedingReview để thử lại sau.
 */
export async function dispatchWeeklyReview(db: D1Database, sessionId: number, run: WeeklyReviewJob): Promise<WeekRef | null> {
  const week = await detectWeekCompleted(db, sessionId)
  if (!week) return null
  try {
    await run(week)
  } catch (e) {
    console.error('weekly review failed', week, e)
  }
  return week
}
