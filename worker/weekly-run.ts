import { runWeeklyReview, type Adjustment } from './adjustment-store'
import { sendWeeklyEmail } from './email'
import type { Env } from './env'
import type { WeekRef } from './weekly'

/**
 * Việc chạy khi hoàn thành một tuần: AI tạo đề xuất điều chỉnh, lưu, rồi gửi email tổng kết.
 * Lỗi AI được ném ra (để tuần đó thử lại sau). Lỗi email KHÔNG làm hỏng đề xuất: email chưa gửi được sẽ được cron gửi lại.
 */
export async function reviewAndNotify(env: Env, week: WeekRef): Promise<Adjustment> {
  const adjustment = await runWeeklyReview(env, week)
  await sendWeeklyEmail(env, adjustment.id).catch((e) => console.error('weekly email crashed', e))
  return adjustment
}
