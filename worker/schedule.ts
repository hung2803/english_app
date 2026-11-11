import { nextWeekday, nextWeekdayOnOrAfter } from './dates'

export const SESSIONS_PER_WEEK = 5
export const WEEKS = 12
export const TOTAL_SESSIONS = SESSIONS_PER_WEEK * WEEKS // 60

export interface PlannedSession {
  seq: number // 1..60
  week_no: number // 1..12
  scheduled_date: string
}

/** Tuần của buổi `seq`: mỗi 5 buổi liên tiếp là một tuần. */
export const weekOfSeq = (seq: number) => Math.ceil(seq / SESSIONS_PER_WEEK)

export interface PendingSession {
  id: number
  scheduled_date: string
}

export interface ScheduleChange {
  id: number
  scheduled_date: string
  /** true = buổi bị lỡ (ngày cũ < hôm nay); false = chỉ bị đẩy lùi vì buổi trước dời tới */
  missed: boolean
}

/**
 * Dời lịch các buổi CHƯA XONG (đã sắp theo seq). Quy tắc:
 * - Buổi có ngày < hôm nay là bị lỡ → dời sang ngày làm việc gần nhất còn trống từ hôm nay.
 * - Các buổi sau đó nếu bị chiếm ngày thì lùi sang ngày làm việc kế tiếp, lần lượt.
 * - Buổi không bị chiếm ngày thì giữ nguyên lịch; luôn chỉ thứ 2–thứ 6, mỗi ngày một buổi.
 * Chạy lại cùng ngày không đổi gì thêm. Ngày kết thúc vì vậy chỉ có thể muộn hơn, không bao giờ sớm hơn.
 */
export function rollForward(pending: PendingSession[], today: string): ScheduleChange[] {
  const changes: ScheduleChange[] = []
  let cursor = nextWeekdayOnOrAfter(today) // ngày trống sớm nhất có thể dùng
  for (const s of pending) {
    let date = s.scheduled_date
    if (date < today) {
      date = cursor
      changes.push({ id: s.id, scheduled_date: date, missed: true })
    } else if (date < cursor) {
      date = cursor
      changes.push({ id: s.id, scheduled_date: date, missed: false })
    }
    cursor = nextWeekday(date)
  }
  return changes
}

/**
 * Xếp 60 buổi: mỗi ngày làm việc (thứ 2–thứ 6) một buổi, bắt đầu từ `start`
 * (nếu `start` rơi vào cuối tuần thì bắt đầu từ thứ 2 kế tiếp). Cuối tuần không có buổi.
 */
export function buildSchedule(start: string): PlannedSession[] {
  return buildScheduleRange(start, 1, TOTAL_SESSIONS)
}

/** Xếp `count` buổi liên tiếp, bắt đầu từ số thứ tự `fromSeq`, từ ngày `start` (chỉ T2–T6). Dùng khi thêm tuần ôn tập. */
export function buildScheduleRange(start: string, fromSeq: number, count: number): PlannedSession[] {
  const out: PlannedSession[] = []
  let d = nextWeekdayOnOrAfter(start)
  for (let seq = fromSeq; seq < fromSeq + count; seq++) {
    out.push({ seq, week_no: weekOfSeq(seq), scheduled_date: d })
    d = nextWeekday(d)
  }
  return out
}
