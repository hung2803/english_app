import type { QuizItem } from './quiz'
import type { Lesson } from './lesson'

/**
 * Quiz phải bám sát bài người học THẤY. AI hay viết bài đọc rất ngắn rồi soạn quiz như thể đã viết bài dài
 * (hỏi đi học bằng xe gì, ăn trưa ở đâu…) nên có câu không thể trả lời từ bài. Module này kiểm tra:
 * - câu hỏi về nội dung bài: đáp án đúng phải có trong bài đọc;
 * - câu hỏi từ vựng/ngữ pháp/điền từ: đáp án phải có trong bài đọc, từ vựng hoặc ngữ pháp của bài.
 */

/** Bài đọc do AI viết ngắn hơn mức này là quá ít để hỏi nội dung. */
export const MIN_READING_WORDS = 100

const STOP = new Set(
  'a an the to of in on at by for with and or but is are was were am be been it its he she they we i you my your his her their our this that these those there here from as do does did has have had not no yes so if then than too very can could will would should may might what who when where which how why'.split(' '),
)

const toks = (s: string): string[] => (s.toLowerCase().normalize('NFC').match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []).map((t) => t.replace(/'s$/, ''))

/** Các dạng gốc có thể của một từ (số nhiều, quá khứ, -ing) để "goes" khớp với "go", "brushed" khớp "brush"… */
function forms(t: string): string[] {
  const out = new Set([t])
  if (t.endsWith('ies')) out.add(t.slice(0, -3) + 'y')
  if (t.endsWith('es')) out.add(t.slice(0, -2))
  if (t.endsWith('s')) out.add(t.slice(0, -1))
  if (t.endsWith('ed')) {
    out.add(t.slice(0, -2))
    out.add(t.slice(0, -1))
  }
  if (t.endsWith('ing')) {
    out.add(t.slice(0, -3))
    out.add(t.slice(0, -3) + 'e')
  }
  return [...out].filter((x) => x.length > 1)
}

function corpus(texts: string[]): Set<string> {
  const set = new Set<string>()
  for (const t of texts) for (const w of toks(t)) for (const f of forms(w)) set.add(f)
  return set
}

const contentTokens = (s: string) => toks(s).filter((t) => !STOP.has(t))

/** Câu hỏi về ngôn ngữ (nghĩa từ, câu đúng, điền từ, có tiếng Việt) chứ không phải về nội dung bài đọc. */
const LANGUAGE_Q = /___|\bmeans?\b|\bmeaning\b|\bcorrect\b|\bsentence\b|\bgrammar\b|\btranslat|\bsynonym|\bopposite\b|[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i

/** Bài đọc người học thấy: bài AI tự viết nằm ở `excerpt`; bài từ nguồn thật có `reading` + đoạn trích. */
export const readingText = (l: Pick<Lesson, 'excerpt' | 'reading'>) => [l.reading, l.excerpt].filter(Boolean).join(' ')

export const readingWords = (l: Pick<Lesson, 'excerpt' | 'reading'>) => (readingText(l).match(/\S+/g) ?? []).length

export function isGrounded(q: QuizItem, reading: Set<string>, all: Set<string>): boolean {
  // viết lại câu / sắp xếp từ / tìm lỗi sai kiểm tra ngữ pháp bằng câu mới, không hỏi nội dung bài: không đối chiếu với bài đọc
  if (q.type === 'rewrite' || q.type === 'order' || q.type === 'error') return true
  const answer = q.type === 'mcq' ? (q.options?.[q.answer as number] ?? '') : String(q.answer)
  if (/[^\x00-\x7F]/.test(answer)) return true // đáp án tiếng Việt (nghĩa của từ…): không kiểm tra được bằng chữ, giữ lại
  const need = contentTokens(answer)
  if (!need.length) return true
  const language = LANGUAGE_Q.test(q.question)
  const pool = language ? all : reading
  const hit = need.filter((t) => forms(t).some((f) => pool.has(f))).length
  // nội dung bài: MỌI từ khóa của đáp án phải có trong bài đọc; ngôn ngữ (vd "câu nào đúng"): ít nhất một nửa, vì đáp án có thể dùng từ mới
  return language ? hit >= Math.ceil(need.length / 2) : hit === need.length
}

/** Giữ lại các câu quiz bám sát bài. */
export function groundQuiz(l: Pick<Lesson, 'excerpt' | 'reading' | 'vocab' | 'grammar' | 'quiz'>): QuizItem[] {
  const reading = corpus([readingText(l)])
  const all = corpus([
    readingText(l),
    ...l.vocab.flatMap((v) => [v.word, v.example ?? '']),
    ...l.grammar.flatMap((g) => [g.point, g.example ?? '']),
  ])
  return l.quiz.filter((q) => isGrounded(q, reading, all))
}
