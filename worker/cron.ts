import type { Env } from './env'
import { retryPendingEmails } from './email'
import { runReminder, type ReminderOutcome } from './reminders'
import { reviewAndNotify } from './weekly-run'
import { findWeeksNeedingReview } from './weekly'

export interface CronReport {
  reminder: ReminderOutcome | { status: 'error' }
  /** tuần được thử tạo lại đề xuất (AI lỗi ở lần trước) */
  review_retried: { planId: number; weekNo: number }[]
  emails: { sent: number; failed: number }
}

/**
 * Việc định kỳ (Cron Trigger, mỗi 10 phút), mỗi việc độc lập — một việc lỗi không làm hỏng việc khác:
 * 1. nhắc học bằng thông báo đẩy (nếu đúng giờ);
 * 2. tạo lại đề xuất điều chỉnh cho tuần vừa xong mà lần trước AI bị lỗi;
 * 3. gửi lại các email tổng kết tuần chưa gửi được.
 */
export async function runScheduled(env: Env, now = Date.now()): Promise<CronReport> {
  const report: CronReport = { reminder: { status: 'error' }, review_retried: [], emails: { sent: 0, failed: 0 } }

  try {
    report.reminder = await runReminder(env, now)
  } catch (e) {
    console.error('reminder failed', e)
  }

  try {
    for (const week of await findWeeksNeedingReview(env.DB)) {
      report.review_retried.push(week)
      try {
        await reviewAndNotify(env, week)
      } catch (e) {
        console.error('weekly review retry failed', week, e instanceof Error ? e.message : e) // AI vẫn lỗi: lần cron sau thử tiếp
      }
    }
  } catch (e) {
    console.error('review retry failed', e)
  }

  try {
    report.emails = await retryPendingEmails(env, now)
  } catch (e) {
    console.error('email retry failed', e)
  }
  return report
}
