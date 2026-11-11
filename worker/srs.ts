export type Grade = 'again' | 'hard' | 'good' | 'easy'
export const GRADES: Grade[] = ['again', 'hard', 'good', 'easy']

export interface CardState {
  interval_days: number
  ease: number
  reps: number
}

export interface CardNext extends CardState {
  /** đã thuộc: khoảng cách ôn từ 21 ngày trở lên */
  learned: 0 | 1
  /** số ngày tới lần ôn kế tiếp (0 = vẫn trong hôm nay) */
  due_in: number
}

/** Khoảng cách ôn từ ngưỡng này trở lên thì coi là "đã thuộc". */
export const LEARNED_INTERVAL = 21
export const MIN_EASE = 1.3
export const MAX_INTERVAL = 365

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Lặp lại ngắt quãng (kiểu SM-2 rút gọn), 4 mức đánh giá:
 * - again (Quên): học lại từ đầu, ôn lại ngay trong hôm nay, độ dễ −0,2;
 * - hard  (Khó):  khoảng cách × 1,2 (ít nhất 1 ngày), độ dễ −0,15;
 * - good  (Tốt):  1 ngày → 3 ngày → khoảng cách × độ dễ;
 * - easy  (Dễ):   nhảy xa hơn (3 ngày ở lần đầu, sau đó × độ dễ × 1,3), độ dễ +0,15.
 */
export function review(c: CardState, grade: Grade): CardNext {
  let { interval_days: iv, ease, reps } = c
  if (grade === 'again') {
    reps = 0
    iv = 0
    ease = Math.max(MIN_EASE, ease - 0.2)
  } else if (grade === 'hard') {
    iv = Math.max(1, Math.round(iv * 1.2))
    ease = Math.max(MIN_EASE, ease - 0.15)
    reps += 1
  } else if (grade === 'good') {
    iv = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(iv * ease)
    reps += 1
  } else {
    iv = reps === 0 ? 3 : Math.max(4, Math.round(iv * ease * 1.3))
    ease += 0.15
    reps += 1
  }
  iv = Math.min(MAX_INTERVAL, iv)
  return { interval_days: iv, ease: round2(ease), reps, learned: iv >= LEARNED_INTERVAL ? 1 : 0, due_in: iv }
}
