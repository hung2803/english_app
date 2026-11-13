import { fixedSentence, isCorrect, shuffle, type GivenAnswer, type QuizItem, type QuizResult, type QuizType } from './quiz'
import type { SessionLite } from './vocab-review'

/**
 * Trước bài mới, sửa các câu sai của quiz trước một lần. Giữ riêng việc hoàn thành lượt
 * và đạt 100%: câu vẫn sai được lưu lại, điểm chỉ thành 100 khi thực sự sửa đúng hết.
 */

interface Prev {
  id: number
  seq: number
  lesson_json: string | null
  result_json: string | null
  quiz_mastered: number | null
  quiz_retry_json: string | null
}

interface Retry {
  remaining: number[]
  round: number
}

export interface ExerciseStatus {
  /** true = buổi này phải làm lại bài tập của buổi trước mới bắt đầu được */
  required: boolean
  /** số thứ tự buổi có bài tập đang phải làm lại */
  prev_seq: number | null
  remaining: number
  round: number
}

export interface ExerciseQuestion {
  index: number
  type: QuizType
  question: string
  options?: string[]
  /** order: các từ cho sẵn (xáo lại mỗi lần) */
  words?: string[]
}

const NONE: ExerciseStatus = { required: false, prev_seq: null, remaining: 0, round: 0 }

async function prevDone(db: D1Database, info: { row: SessionLite }): Promise<Prev | null> {
  return db
    .prepare("SELECT id, seq, lesson_json, result_json, quiz_mastered, quiz_retry_json FROM sessions WHERE plan_id = ? AND seq < ? AND status = 'done' ORDER BY seq DESC LIMIT 1")
    .bind(info.row.plan_id, info.row.seq)
    .first<Prev>()
}

function quizOf(p: Prev): QuizItem[] | null {
  try {
    const q = (JSON.parse(p.lesson_json ?? 'null') as { quiz?: QuizItem[] } | null)?.quiz
    return Array.isArray(q) && q.length ? q : null
  } catch {
    return null
  }
}

/** Các câu còn sai: theo trạng thái làm lại, hoặc (chưa làm lại lần nào) các câu sai của lần nộp đầu. */
function remainingOf(p: Prev, quiz: QuizItem[]): { remaining: number[]; round: number } {
  const ok = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < quiz.length
  try {
    const r = p.quiz_retry_json ? (JSON.parse(p.quiz_retry_json) as Retry) : null
    if (r && Array.isArray(r.remaining)) return { remaining: r.remaining.filter(ok), round: r.round ?? 0 }
  } catch {
    // dùng kết quả lần nộp đầu
  }
  try {
    const res = JSON.parse(p.result_json ?? 'null') as QuizResult | null
    return { remaining: (res?.items ?? []).filter((x) => !x.correct).map((x) => x.index).filter(ok), round: 0 }
  } catch {
    return { remaining: [], round: 0 }
  }
}

export async function exerciseStatus(db: D1Database, info: { row: SessionLite }): Promise<ExerciseStatus> {
  // buổi đã bắt đầu (có tài liệu) hoặc đã xong: không chặn nữa
  if (info.row.status === 'done' || info.row.material_json) return NONE
  const p = await prevDone(db, info)
  // chỉ chặn khi buổi trước ghi rõ "chưa đạt 100%" (NULL = buổi cũ / không yêu cầu; 1 = đã đạt)
  if (!p || p.quiz_mastered !== 0) return NONE
  const quiz = quizOf(p)
  if (!quiz) return NONE
  const { remaining, round } = remainingOf(p, quiz)
  if (round >= 1) return NONE
  return { required: true, prev_seq: p.seq, remaining: remaining.length, round }
}

/** Buổi này đang bị chặn vì bài tập buổi trước chưa đạt 100%? */
export async function exerciseBlocks(db: D1Database, info: { row: SessionLite }): Promise<boolean> {
  return (await exerciseStatus(db, info)).required
}

async function liteOf(db: D1Database, id: number): Promise<{ row: SessionLite } | null> {
  const row = await db.prepare('SELECT id, plan_id, seq, status, material_json FROM sessions WHERE id = ?').bind(id).first<SessionLite>()
  return row ? { row } : null
}

/** Đầu bài: nội dung bài của buổi trước để người học xem lại khi làm lại câu sai (không chứa quiz hay đáp án). */
export interface ExerciseMaterial {
  seq: number
  title: string
  /** bài đọc người học đã thấy (bài viết lại + đoạn trích, hoặc bài AI viết) */
  reading: string
  summary_vi: string
  vocab: { word: string; pos?: string; meaning_vi: string; example?: string }[]
  grammar: { point: string; explanation_vi: string; example?: string }[]
}

function materialOf(p: Prev): ExerciseMaterial {
  let l: Record<string, unknown> = {}
  try {
    l = JSON.parse(p.lesson_json ?? '{}') as Record<string, unknown>
  } catch {
    // bài hỏng: trả đầu bài rỗng, vẫn làm lại được
  }
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    seq: p.seq,
    title: s(l.title),
    reading: [s(l.reading), s(l.excerpt)].filter(Boolean).join('\n\n'),
    summary_vi: s(l.summary_vi),
    vocab: arr<ExerciseMaterial['vocab'][number]>(l.vocab),
    grammar: arr<ExerciseMaterial['grammar'][number]>(l.grammar),
  }
}

export type ExerciseQuestionsResult =
  | { ok: true; status: ExerciseStatus; questions: ExerciseQuestion[]; material: ExerciseMaterial }
  | { ok: false; reason: 'not_found' | 'not_required' }

export async function exerciseQuestions(db: D1Database, sessionId: number): Promise<ExerciseQuestionsResult> {
  const info = await liteOf(db, sessionId)
  if (!info) return { ok: false, reason: 'not_found' }
  const status = await exerciseStatus(db, info)
  if (!status.required) return { ok: false, reason: 'not_required' }
  const p = (await prevDone(db, info))!
  const quiz = quizOf(p)!
  const { remaining } = remainingOf(p, quiz)
  const questions: ExerciseQuestion[] = remaining.map((i) => {
    const q = quiz[i]
    // xáo lại lựa chọn mỗi lần để người học phải nhớ nội dung, không nhớ vị trí
    return { index: i, type: q.type, question: q.question, ...(q.type === 'mcq' && q.options ? { options: shuffle(q.options) } : {}), ...(q.words ? { words: shuffle(q.words) } : {}) }
  })
  return { ok: true, status, questions, material: materialOf(p) }
}

export interface ExerciseAnswer {
  index: number
  choice: string
}

export interface ExerciseItemResult {
  index: number
  question: string
  correct: boolean
  /** đáp án đúng (chữ) */
  answer_text: string
  explanation_vi: string
}

export type SubmitExerciseResult =
  | { ok: true; passed: boolean; round: number; remaining: number; results: ExerciseItemResult[] }
  | { ok: false; reason: 'not_found' | 'not_required' | 'invalid' }

function validAnswers(a: unknown): a is ExerciseAnswer[] {
  return Array.isArray(a) && a.length <= 100 && a.every((x) => x && Number.isInteger(x.index) && typeof x.choice === 'string' && x.choice.length <= 300)
}

/** Chấm một lượt làm lại. Câu sai (hoặc bỏ trống) ở lại lượt sau; hết câu sai = đạt 100%. */
export async function submitExercise(db: D1Database, sessionId: number, answers: unknown): Promise<SubmitExerciseResult> {
  const info = await liteOf(db, sessionId)
  if (!info) return { ok: false, reason: 'not_found' }
  const status = await exerciseStatus(db, info)
  if (!status.required) return { ok: false, reason: 'not_required' }
  if (!validAnswers(answers)) return { ok: false, reason: 'invalid' }

  const p = (await prevDone(db, info))!
  const quiz = quizOf(p)!
  const { remaining, round } = remainingOf(p, quiz)
  const results: ExerciseItemResult[] = remaining.map((i) => {
    const q = quiz[i]
    const a = answers.find((x) => x.index === i)
    let correct = false
    if (a) {
      // mcq: đổi chữ đã chọn về chỉ số trong đề gốc (lựa chọn lạ → -1 → sai); fill: so chữ
      const given: GivenAnswer = q.type === 'mcq' ? (q.options ?? []).indexOf(a.choice) : a.choice
      correct = given !== -1 && isCorrect(q, given)
    }
    return { index: i, question: q.question, correct, answer_text: q.type === 'mcq' ? (q.options?.[q.answer as number] ?? '') : q.type === 'error' ? fixedSentence(q) : String(q.answer), explanation_vi: q.explanation_vi }
  })
  const wrong = results.filter((r) => !r.correct).map((r) => r.index)
  const passed = wrong.length === 0
  const next: Retry = { remaining: wrong, round: round + 1 }
  // đạt 100%: điểm hiển thị thành 100, điểm lần nộp đầu giữ ở first_score (không ghi đè nếu đã có)
  await db
    .prepare(
      `UPDATE sessions SET quiz_retry_json = ?, quiz_mastered = ?,
         first_score = CASE WHEN ? = 1 THEN COALESCE(first_score, score) ELSE first_score END,
         score = CASE WHEN ? = 1 THEN 100 ELSE score END
       WHERE id = ?`,
    )
    .bind(JSON.stringify(next), passed ? 1 : 0, passed ? 1 : 0, passed ? 1 : 0, p.id)
    .run()
  // Hoàn thành lượt sửa là đủ mở bài mới; quiz_mastered chỉ ghi 1 khi thực sự đúng hết.
  return { ok: true, passed: true, round: next.round, remaining: wrong.length, results }
}
