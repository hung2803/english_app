export type DisplayStatus = 'pending' | 'done' | 'missed'

export interface SessionRow {
  id: number
  week_no: number
  seq: number
  scheduled_date: string
  status: 'pending' | 'done' | 'missed'
  score: number | null
}

/**
 * Trạng thái hiển thị: xong / bị lỡ / chưa học.
 * Buổi chưa xong mà ngày đã qua cũng là "bị lỡ" (trước khi hệ thống kịp dời lịch).
 */
export function displayStatus(s: Pick<SessionRow, 'status' | 'scheduled_date'>, today: string): DisplayStatus {
  if (s.status === 'done') return 'done'
  if (s.status === 'missed' || s.scheduled_date < today) return 'missed'
  return 'pending'
}

export interface WeekView {
  week_no: number
  topic: string
  goal_vi: string
  done: number
  total: number
  sessions: { id: number; seq: number; scheduled_date: string; status: DisplayStatus; score: number | null }[]
}

export function buildWeeks(
  weeks: { week_no: number; topic: string; goal_vi: string }[],
  sessions: SessionRow[],
  today: string,
): WeekView[] {
  return weeks.map((w) => {
    const list = sessions
      .filter((s) => s.week_no === w.week_no)
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ id: s.id, seq: s.seq, scheduled_date: s.scheduled_date, status: displayStatus(s, today), score: s.score }))
    return { ...w, done: list.filter((s) => s.status === 'done').length, total: list.length, sessions: list }
  })
}
