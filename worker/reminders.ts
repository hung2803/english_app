import { isWeekday, todayVN } from './dates'
import type { Env } from './env'
import { missingSecrets } from './env'
import { getSettings, toMinutes } from './settings'
import { pushToAll, type PushSummary } from './webpush'

/**
 * Cron chạy mỗi vài phút nên chỉ nhắc trong khoảng này sau giờ đã đặt.
 * Nhờ vậy nếu người học đổi giờ nhắc về một giờ đã qua từ lâu thì không bị nhắc ngay lập tức.
 */
export const REMINDER_WINDOW_MIN = 90

export type SkipReason =
  | 'not_configured' // chưa cấu hình VAPID
  | 'disabled' // người học tắt nhắc
  | 'weekend' // chỉ nhắc thứ 2–thứ 6
  | 'too_early' // chưa tới giờ nhắc
  | 'too_late' // quá cửa sổ nhắc
  | 'nothing_to_study' // không có lộ trình / đã học hết
  | 'already_studied' // hôm nay đã học xong một buổi
  | 'already_sent' // hôm nay đã nhắc rồi
  | 'no_devices' // chưa có thiết bị nào đăng ký

export type ReminderOutcome = { status: 'sent'; summary: PushSummary } | { status: 'failed'; summary: PushSummary } | { status: 'skipped'; reason: SkipReason }

/** Ngày + số phút trong ngày theo giờ Việt Nam (UTC+7). */
export function vnClock(now: number): { date: string; minutes: number } {
  const d = new Date(now + 7 * 3600e3)
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
}

/**
 * Nhắc học bằng thông báo đẩy. Gửi tối đa MỘT lần mỗi ngày, khi:
 * thứ 2–thứ 6, nhắc đang bật, đã tới giờ đặt (trong cửa sổ 90 phút), còn buổi để học, hôm nay CHƯA học xong buổi nào,
 * và có thiết bị đăng ký. Gửi hỏng cho mọi thiết bị thì không ghi nhận để lần cron sau thử lại.
 */
export async function runReminder(env: Env, now = Date.now()): Promise<ReminderOutcome> {
  const skip = (reason: SkipReason): ReminderOutcome => ({ status: 'skipped', reason })
  if (missingSecrets(env, 'push').length) return skip('not_configured')
  const settings = await getSettings(env.DB)
  if (!settings.reminder_enabled) return skip('disabled')

  const { date, minutes } = vnClock(now)
  if (!isWeekday(date)) return skip('weekend')
  const at = toMinutes(settings.reminder_time)
  if (minutes < at) return skip('too_early')
  if (minutes >= at + REMINDER_WINDOW_MIN) return skip('too_late')

  const sent = await env.DB.prepare("SELECT 1 AS x FROM notification_log WHERE kind = 'push_reminder' AND day = ?").bind(date).first()
  if (sent) return skip('already_sent')

  const open = await env.DB.prepare("SELECT 1 AS x FROM sessions s JOIN plans p ON p.id = s.plan_id AND p.status = 'active' WHERE s.status != 'done' LIMIT 1").first()
  if (!open) return skip('nothing_to_study')
  const studied = await env.DB.prepare("SELECT 1 AS x FROM sessions WHERE status = 'done' AND completed_date = ? LIMIT 1").bind(date).first()
  if (studied) return skip('already_studied')

  const devices = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>()
  if (!devices?.n) return skip('no_devices')

  const summary = await pushToAll(env)
  if (summary.sent === 0) return { status: 'failed', summary } // không ghi nhận: cron sau thử lại trong cửa sổ
  await env.DB.prepare("INSERT OR IGNORE INTO notification_log (kind, day, sent_at) VALUES ('push_reminder', ?, ?)").bind(date, new Date(now).toISOString()).run()
  return { status: 'sent', summary }
}

export { todayVN }
