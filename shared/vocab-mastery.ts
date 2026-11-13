export const MASTERY_LEVELS = ['relearn', 'new', 'recognized', 'learning', 'almost', 'learned', 'queued'] as const
export type MasteryLevel = typeof MASTERY_LEVELS[number]
export const MASTERY_LABELS: Record<MasteryLevel, string> = {
  relearn: 'Cần ôn lại', new: 'Mới bắt đầu', learning: 'Đang củng cố',
  almost: 'Gần thuộc', learned: 'Đã thuộc', queued: 'Chờ học',
  recognized: 'Nhận biết được',
}

interface Memory {
  learned: number
  learning_state?: string
  typed_streak?: number
  mastery_started_on?: string | null
  wrong_count?: number
  lapses?: number
  recognized_on?: string | null
}

/** Progress describes evidence of recall, not a probability of remembering the word. */
export function vocabMastery(v: Memory, today: string) {
  const days = Math.max(0, v.typed_streak ?? 0)
  const elapsed = v.mastery_started_on ? Math.floor((Date.parse(today) - Date.parse(v.mastery_started_on)) / 86_400_000) : 0
  const span = days > 0 && Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  const level: MasteryLevel = v.learning_state === 'queued' ? 'queued'
    : v.learned === 1 ? 'learned'
      : days >= 2 ? 'almost'
        : days === 1 ? 'learning'
          : v.recognized_on ? 'recognized' : (v.wrong_count ?? 0) + (v.lapses ?? 0) > 0 ? 'relearn' : 'new'
  const progress = level === 'queued' ? 0 : level === 'learned' ? 100
    : Math.min(75, (Math.min(days, 3) + (span >= 7 ? 1 : 0)) * 25)
  return { level, label: MASTERY_LABELS[level], days: Math.min(days, 3), span: Math.min(span, 7), progress }
}
