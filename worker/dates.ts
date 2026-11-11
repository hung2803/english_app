// Mọi ngày trong app là chuỗi YYYY-MM-DD theo giờ Việt Nam (UTC+7), không phụ thuộc múi giờ máy chủ.
export function addDays(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

/** Thứ 2–thứ 6. */
export function isWeekday(d: string): boolean {
  const day = new Date(d + 'T00:00:00Z').getUTCDay()
  return day >= 1 && day <= 5
}

/** Chính ngày d nếu là ngày làm việc, không thì ngày làm việc kế tiếp (thứ 2). */
export function nextWeekdayOnOrAfter(d: string): string {
  let x = d
  while (!isWeekday(x)) x = addDays(x, 1)
  return x
}

/** Ngày làm việc kế tiếp sau d. */
export function nextWeekday(d: string): string {
  return nextWeekdayOnOrAfter(addDays(d, 1))
}

/** Ngày làm việc liền trước d. */
export function prevWeekday(d: string): string {
  let x = addDays(d, -1)
  while (!isWeekday(x)) x = addDays(x, -1)
  return x
}

/** Số ngày từ a đến b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000)
}

export function todayVN(now: number = Date.now()): string {
  return new Date(now + 7 * 3600e3).toISOString().slice(0, 10)
}
