import { BANK, type Level, type QuestionKind } from './placement-bank'

export interface PublicQuestion {
  kind: QuestionKind
  passage?: string
  question: string
  options: string[]
}

/** Câu hỏi gửi cho client: chỉ chọn lọc các trường an toàn, KHÔNG có đáp án đúng và mức. */
export function publicQuestions(): PublicQuestion[] {
  return BANK.map((q) => ({
    kind: q.kind,
    ...(q.passage ? { passage: q.passage } : {}),
    question: q.question,
    options: [...q.options],
  }))
}

/** Đáp án hợp lệ: đủ số câu, mỗi câu là chỉ số 0–3. */
export function validAnswers(answers: unknown): answers is number[] {
  return (
    Array.isArray(answers) &&
    answers.length === BANK.length &&
    answers.every((a, i) => Number.isInteger(a) && a >= 0 && a < BANK[i].options.length)
  )
}

export type LevelTally = Record<Level, { right: number; total: number }>

const LEVEL_ORDER: Level[] = ['A0', 'A1', 'A2', 'B1']

/** Mức cần đạt trọn vẹn: từ A0 tới mức kế tiếp của lộ trình (B1 thì tới hết B1). */
export function levelsRequired(planLevel: Level): Level[] {
  return LEVEL_ORDER.slice(0, Math.min(LEVEL_ORDER.indexOf(planLevel) + 2, LEVEL_ORDER.length))
}

export interface NextPlanCheck {
  passed: boolean
  required: Level[]
  /** các mức chưa đúng 100% */
  weak: Level[]
}

/**
 * Điều kiện sang lộ trình mới: bài test lại phải đúng 100% số câu ở MỌI mức từ A0 tới mức kế tiếp
 * của lộ trình vừa học (vd lộ trình A1 → phải đúng hết A0, A1, A2). Thiếu dữ liệu từng mức → chưa đạt.
 */
export function checkNextPlan(perLevel: LevelTally | null, planLevel: Level): NextPlanCheck {
  const required = levelsRequired(planLevel)
  const weak = required.filter((l) => !perLevel || perLevel[l].total === 0 || perLevel[l].right < perLevel[l].total)
  return { passed: weak.length === 0, required, weak }
}

/** Một mức "đạt" khi đúng ≥ 60% số câu của mức đó (A0: 3/4, A1–A2: 3/5, B1: 3/4). */
export const PASS_RATIO = 0.6

/**
 * Xếp mức CEFR theo thứ tự từ thấp lên cao: phải đạt mức dưới thì mới xét mức trên.
 * - Không đạt A0 hoặc A1  → A0 (mới bắt đầu)
 * - Đạt A0, A1            → A1
 * - đạt thêm A2           → A2
 * - đạt thêm B1           → B1
 * Đạt mức trên mà trượt mức dưới (đoán mò) thì không được tính.
 */
export function placeLevel(perLevel: LevelTally): Level {
  const passed = (l: Level) => perLevel[l].total > 0 && perLevel[l].right / perLevel[l].total >= PASS_RATIO
  if (!passed('A0') || !passed('A1')) return 'A0'
  if (!passed('A2')) return 'A1'
  if (!passed('B1')) return 'A2'
  return 'B1'
}

/** Chấm bài. `perLevel` chỉ dùng nội bộ để xếp mức CEFR, không gửi cho client. */
export function gradeAnswers(answers: number[]): { score: number; total: number; perLevel: LevelTally; level: Level } {
  const perLevel: LevelTally = {
    A0: { right: 0, total: 0 },
    A1: { right: 0, total: 0 },
    A2: { right: 0, total: 0 },
    B1: { right: 0, total: 0 },
  }
  let score = 0
  BANK.forEach((q, i) => {
    perLevel[q.level].total++
    if (answers[i] === q.answer) {
      perLevel[q.level].right++
      score++
    }
  })
  return { score, total: BANK.length, perLevel, level: placeLevel(perLevel) }
}
