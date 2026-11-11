import { addDays, isWeekday, nextWeekday, prevWeekday } from './dates'

/**
 * Chuỗi ngày học: số ngày làm việc (T2–T6) liên tiếp có buổi xong, tính ngược từ hôm nay.
 * - Hôm nay chưa học thì chưa làm đứt chuỗi (tính từ ngày làm việc trước đó).
 * - Cuối tuần không có buổi nên không làm đứt chuỗi; học vào cuối tuần cũng không cộng thêm.
 */
export function currentStreak(doneDates: Iterable<string>, today: string): number {
  const set = new Set(doneDates)
  let cursor = today
  while (!isWeekday(cursor)) cursor = addDays(cursor, -1)
  if (!set.has(cursor)) cursor = prevWeekday(cursor)
  let n = 0
  while (set.has(cursor)) {
    n++
    cursor = prevWeekday(cursor)
  }
  return n
}

/** Chuỗi dài nhất từng đạt (cùng quy tắc: chỉ đếm ngày làm việc liên tiếp). */
export function bestStreak(doneDates: Iterable<string>): number {
  const days = [...new Set(doneDates)].filter(isWeekday).sort()
  let best = 0
  let run = 0
  let prev: string | null = null
  for (const d of days) {
    run = prev !== null && nextWeekday(prev) === d ? run + 1 : 1
    best = Math.max(best, run)
    prev = d
  }
  return best
}
