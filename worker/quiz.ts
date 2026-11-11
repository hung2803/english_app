export type QuizType = 'mcq' | 'fill'

/** Một câu quiz như lưu trong CSDL (có đáp án). */
export interface QuizItem {
  type: QuizType
  question: string
  /** mcq: đúng 4 lựa chọn */
  options?: string[]
  /** mcq: chỉ số (0–3) của lựa chọn đúng; fill: từ/cụm từ đúng */
  answer: number | string
  explanation_vi: string
  /** từ vựng của bài liên quan tới câu này (để đưa vào ôn lại khi làm sai) */
  word?: string
}

/** Dạng gửi cho người học TRƯỚC khi nộp: không có đáp án, giải thích hay từ liên quan. */
export interface PublicQuizItem {
  type: QuizType
  question: string
  options?: string[]
}

export const QUIZ_SIZE = 8
/** Chấp nhận ít hơn 8 câu hợp lệ (AI thỉnh thoảng sinh lỗi 1–2 câu), nhưng không dưới mức này. */
export const MIN_QUIZ = 6
const MIN_MCQ = 2
const MIN_FILL = 1
const MAX_Q = 300
const MAX_OPT = 120
const MAX_ANSWER = 40
const MAX_EXPLAIN = 400

const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, n) : '')
const BLANK = /_{2,}/g

export type Rng = () => number

/** Fisher–Yates; `rng` trả số trong [0, 1). Mặc định dùng crypto. */
export function shuffle<T>(arr: T[], rng: Rng = cryptoRandom): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function cryptoRandom(): number {
  const b = new Uint32Array(1)
  crypto.getRandomValues(b)
  return b[0] / 2 ** 32
}

/** Chuẩn hóa một câu. Không hợp lệ → null. */
function normalizeItem(raw: unknown, vocab: Set<string>, rng: Rng): QuizItem | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const type = r.type === 'mcq' || r.type === 'fill' ? r.type : null
  const question = cut(r.question, MAX_Q)
  const explanation_vi = cut(r.explanation_vi, MAX_EXPLAIN)
  if (!type || !question || !explanation_vi) return null
  const w = cut(r.word, 60)
  const word = w && vocab.has(w.toLowerCase()) ? w : undefined

  if (type === 'mcq') {
    const options = Array.isArray(r.options) ? (r.options as unknown[]).map((o) => cut(o, MAX_OPT)) : []
    const idx = r.answer
    if (options.length !== 4 || options.some((o) => !o) || new Set(options.map((o) => o.toLowerCase())).size !== 4) return null
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 3) return null
    // xáo trộn vị trí để đáp án đúng không dồn ở cùng một chỗ
    const order = shuffle([0, 1, 2, 3], rng)
    return { type, question, options: order.map((i) => options[i]), answer: order.indexOf(idx), explanation_vi, ...(word ? { word } : {}) }
  }

  const answer = cut(r.answer, MAX_ANSWER)
  const blanks = question.match(BLANK)?.length ?? 0
  if (!answer || blanks !== 1 || answer.split(' ').length > 3) return null
  return { type, question, answer, explanation_vi, ...(word ? { word } : {}) }
}

/**
 * Làm sạch bộ quiz AI soạn: bỏ câu hỏng/trùng, cắt còn tối đa 8, yêu cầu đủ số câu tối thiểu và có cả trắc nghiệm lẫn điền từ.
 * Trả null nếu không đủ dùng (bên gọi báo lỗi AI để thử lại).
 */
export function normalizeQuiz(raw: unknown, vocabWords: string[], rng: Rng = cryptoRandom): QuizItem[] | null {
  if (!Array.isArray(raw)) return null
  const vocab = new Set(vocabWords.map((w) => w.toLowerCase()))
  const seen = new Set<string>()
  const items: QuizItem[] = []
  for (const x of raw) {
    const item = normalizeItem(x, vocab, rng)
    if (!item) continue
    const key = item.question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
    if (items.length === QUIZ_SIZE) break
  }
  const mcq = items.filter((i) => i.type === 'mcq').length
  if (items.length < MIN_QUIZ || mcq < MIN_MCQ || items.length - mcq < MIN_FILL) return null
  return items
}

/** Bỏ đáp án, giải thích và từ liên quan — dùng cho mọi dữ liệu gửi cho người học khi chưa nộp quiz. */
export function publicQuiz(quiz: QuizItem[]): PublicQuizItem[] {
  return quiz.map((q) => ({ type: q.type, question: q.question, ...(q.options ? { options: q.options } : {}) }))
}

// ---------- Chấm điểm ----------

/** Dưới ngưỡng này là "chưa đạt" (buổi học vẫn tính là xong). */
export const PASS_PERCENT = 70

/** Chuẩn hóa câu trả lời điền từ để so khớp: bỏ khoảng trắng thừa, hoa/thường, dấu nháy cong, dấu câu ở cuối. */
export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?"')\]]+$/g, '')
    .replace(/^["'(\[]+/g, '')
    .trim()
}

/** Câu trả lời của người học: mcq = chỉ số lựa chọn, fill = chữ; null = bỏ trống. */
export type GivenAnswer = number | string | null

export function validateAnswers(quiz: QuizItem[], answers: unknown): answers is GivenAnswer[] {
  if (!Array.isArray(answers) || answers.length !== quiz.length) return false
  return answers.every((a, i) => {
    if (a === null) return true
    if (quiz[i].type === 'mcq') return typeof a === 'number' && Number.isInteger(a) && a >= 0 && a < (quiz[i].options?.length ?? 0)
    return typeof a === 'string' && a.length <= 200
  })
}

export interface GradedItem {
  index: number
  type: QuizType
  question: string
  options?: string[]
  /** câu trả lời của người học (null = bỏ trống) */
  given: GivenAnswer
  correct: boolean
  /** mcq: chỉ số đúng; fill: từ đúng */
  answer: number | string
  /** mcq: nội dung lựa chọn đúng */
  answer_text: string
  explanation_vi: string
  word?: string
}

export interface QuizResult {
  score: number // 0–100
  right: number
  total: number
  passed: boolean
  items: GradedItem[]
  /** thời điểm nộp (ISO) */
  submitted_at: string
  /** từ vựng của các câu làm sai, đã được đưa vào hàng ôn ngay */
  review_words?: string[]
}

/** Từ vựng của các câu SAI (hoặc bỏ trống), không trùng nhau (không phân biệt hoa thường), giữ thứ tự xuất hiện. */
export function wrongWords(result: Pick<QuizResult, 'items'>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of result.items) {
    if (it.correct || !it.word) continue
    const k = it.word.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(it.word)
  }
  return out
}

export function isCorrect(q: QuizItem, given: GivenAnswer): boolean {
  if (given === null) return false
  if (q.type === 'mcq') return given === q.answer
  return typeof given === 'string' && normalizeAnswer(given) === normalizeAnswer(String(q.answer))
}

/** Chấm bài: điểm = đúng / tổng làm tròn thành %. */
export function gradeQuiz(quiz: QuizItem[], answers: GivenAnswer[], submittedAt = new Date().toISOString()): QuizResult {
  const items: GradedItem[] = quiz.map((q, i) => ({
    index: i,
    type: q.type,
    question: q.question,
    ...(q.options ? { options: q.options } : {}),
    given: answers[i],
    correct: isCorrect(q, answers[i]),
    answer: q.answer,
    answer_text: q.type === 'mcq' ? (q.options?.[q.answer as number] ?? '') : String(q.answer),
    explanation_vi: q.explanation_vi,
    ...(q.word ? { word: q.word } : {}),
  }))
  const right = items.filter((x) => x.correct).length
  const score = quiz.length ? Math.round((right / quiz.length) * 100) : 0
  return { score, right, total: quiz.length, passed: score >= PASS_PERCENT, items, submitted_at: submittedAt }
}
