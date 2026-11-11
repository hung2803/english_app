import { addDays, daysBetween } from './dates'
import type { Level } from './placement-bank'

export const LEVELS: Level[] = ['A0', 'A1', 'A2', 'B1']
/** Lộ trình 12 tuần = 84 ngày; sau chừng đó nên làm lại test. */
export const RETAKE_AFTER_DAYS = 84
/** Tiêu chí thành công: lên ít nhất 1 bậc so với lần đầu. */
export const SUCCESS_BANDS = 1

export interface PlacementEntry {
  level: Level
  taken_at: string
}

export interface PlacementProgress {
  baseline: PlacementEntry
  latest: PlacementEntry
  /** số bậc tăng so với lần đầu (có thể âm); null nếu chưa làm lại lần nào */
  bands_gained: number | null
  /** đạt tiêu chí (≥ 1 bậc); null nếu chưa có lần làm lại để so */
  success: boolean | null
  /** đã ở B1 từ đầu — không còn bậc nào để lên trong phạm vi A0–B1 */
  at_ceiling: boolean
  /** ngày nên làm lại test (lần gần nhất + 84 ngày) */
  retake_date: string
  retake_due: boolean
  days_until_retake: number
}

/** `results`: các lần làm bài, thứ tự bất kỳ. Trả null nếu chưa làm lần nào. */
export function compareLevels(results: PlacementEntry[], today: string): PlacementProgress | null {
  if (!results.length) return null
  const byDate = [...results].sort((a, b) => a.taken_at.localeCompare(b.taken_at))
  const baseline = byDate[0]
  const latest = byDate[byDate.length - 1]
  const retake_date = addDays(latest.taken_at, RETAKE_AFTER_DAYS)
  const days_until_retake = daysBetween(today, retake_date)
  const retook = byDate.length > 1
  const bands_gained = retook ? LEVELS.indexOf(latest.level) - LEVELS.indexOf(baseline.level) : null
  return {
    baseline,
    latest,
    bands_gained,
    success: bands_gained === null ? null : bands_gained >= SUCCESS_BANDS,
    at_ceiling: baseline.level === 'B1',
    retake_date,
    retake_due: days_until_retake <= 0,
    days_until_retake,
  }
}
