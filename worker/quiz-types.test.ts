import { describe, expect, it } from 'vitest'
import { fixedSentence, gradeQuiz, isCorrect, normalizeQuiz, publicQuiz, validateAnswers, type QuizItem } from './quiz'
import { normalizeLesson } from './lesson'
import { groundQuiz } from './lesson-grounding'
import { lessonJson } from './test-fixtures'

const noShuffle = () => 0.999999
const base = { explanation_vi: 'Giải thích.' }
const mcq = (i: number) => ({ type: 'mcq', question: `Q${i}?`, options: [`a${i}`, `b${i}`, `c${i}`, `d${i}`], answer: 0, ...base })
const fill = (i: number) => ({ type: 'fill', question: `Sentence ${i} with a ___ here (go).`, answer: `w${i}`, ...base })
const rewrite = { type: 'rewrite', question: 'Rewrite as a question: "He likes coffee."', answer: 'Does he like coffee?', accept: ['Does he like coffee', 'does he like coffee ?'], ...base }
const order = { type: 'order', question: 'Put the words in order.', words: ['every', 'I', 'day', 'up', 'get', 'early'], answer: 'I get up early every day.', ...base }
const error = { type: 'error', question: 'She [[go]] to school every day.', answer: 'goes', ...base }
const PAD = [mcq(1), mcq(2), fill(3), fill(4), fill(5), fill(6)] // đủ MIN_QUIZ để bộ quiz hợp lệ
const norm = (x: unknown) => normalizeQuiz([...PAD, x], [], noShuffle)!.find((i) => i.question === (x as { question: string }).question && i.type === (x as { type: string }).type)

describe('normalizeQuiz — 5 dạng câu hỏi', () => {
  it('nhận đủ: trắc nghiệm, điền từ (chia động từ trong ngoặc), viết lại câu, sắp xếp từ, tìm lỗi sai', () => {
    const q = normalizeQuiz([mcq(1), mcq(2), fill(3), fill(4), rewrite, order, { ...order, question: 'Put these words in order.', words: ['is', 'cat', 'The', 'black'], answer: 'The cat is black.' }, error], [], noShuffle)!
    expect(q.map((x) => x.type)).toEqual(['mcq', 'mcq', 'fill', 'fill', 'rewrite', 'order', 'order', 'error'])
  })

  it('rewrite: giữ đáp án chính + các đáp án khác (không trùng, tối đa 3)', () => {
    const q = norm({ ...rewrite, accept: ['Does he like coffee', 'does he like coffee?', 'Does he like coffee', 'A', 'B', 'C', 'D'] })!
    expect(q.type).toBe('rewrite')
    expect(q.accept).toEqual(['A', 'B', 'C']) // bỏ các bản trùng đáp án chính hoặc trùng nhau sau chuẩn hóa (chỉ khác dấu câu), cắt còn 3
  })

  it('rewrite: bỏ câu không có đáp án hoặc đáp án y hệt đề', () => {
    expect(norm({ ...rewrite, answer: '' })).toBeUndefined()
    expect(normalizeQuiz([...PAD, { ...rewrite, question: 'He likes coffee.', answer: 'He likes coffee.' }], [], noShuffle)!).toHaveLength(PAD.length)
  })

  it('order: xáo trộn các từ cho sẵn và KHÔNG để lộ thứ tự đúng; đáp án phải dùng đúng các từ đó', () => {
    const q = norm(order)!
    expect(q.type).toBe('order')
    expect([...q.words!].sort()).toEqual([...order.words].sort())
    expect(q.words!.join(' ')).not.toBe('I get up early every day.')
    expect(norm({ ...order, answer: 'I go to school every day.' })).toBeUndefined() // từ không khớp
    expect(norm({ ...order, words: ['I', 'get'] })).toBeUndefined() // quá ít từ
  })

  it('error: cần đúng một phần [[…]]; đáp án phải khác phần bị gạch chân', () => {
    expect(norm(error)!.type).toBe('error')
    expect(norm({ ...error, question: 'She go to school.' })).toBeUndefined() // thiếu [[ ]]
    expect(norm({ ...error, question: 'She [[go]] to [[school]].' })).toBeUndefined() // hai chỗ
    expect(norm({ ...error, answer: 'go' })).toBeUndefined() // "sửa" mà không đổi gì
  })

  it('loại không nằm trong 5 dạng → bỏ câu đó', () => {
    expect(normalizeQuiz([...PAD, { ...rewrite, type: 'essay' }], [], noShuffle)!).toHaveLength(PAD.length)
  })
})

describe('chấm điểm các dạng mới', () => {
  const items = normalizeQuiz([mcq(1), mcq(2), fill(3), rewrite, order, error], [], noShuffle) as QuizItem[]
  const O = items.find((x) => x.type === 'order')!

  it('rewrite: không phân biệt hoa thường, bỏ qua dấu câu; chấp nhận đáp án phụ', () => {
    const q = items.find((x) => x.type === 'rewrite')!
    for (const ok of ['Does he like coffee?', 'does he like coffee', '  DOES HE LIKE   COFFEE ?', 'Does he like coffee']) expect(isCorrect(q, ok)).toBe(true)
    expect(isCorrect(q, 'Do he like coffee?')).toBe(false)
    expect(isCorrect(q, null)).toBe(false)
    expect(isCorrect(q, '')).toBe(false)
  })

  it('order: đúng khi ghép đúng câu (không phụ thuộc dấu chấm); sai thứ tự thì sai', () => {
    expect(isCorrect(O, 'I get up early every day.')).toBe(true)
    expect(isCorrect(O, 'i get up early every day')).toBe(true)
    expect(isCorrect(O, 'Every day I get up early.')).toBe(false)
  })

  it('error: gõ phần sửa lại HOẶC viết lại cả câu đã sửa đều đúng', () => {
    const q = items.find((x) => x.type === 'error')!
    expect(isCorrect(q, 'goes')).toBe(true)
    expect(isCorrect(q, 'She goes to school every day.')).toBe(true)
    expect(isCorrect(q, 'go')).toBe(false)
    expect(fixedSentence(q)).toBe('She goes to school every day.')
  })

  it('gradeQuiz: đáp án hiển thị của câu "tìm lỗi" là câu đã sửa; câu order kèm các từ cho sẵn', () => {
    const r = gradeQuiz(items, items.map(() => null))
    expect(r.items.find((x) => x.type === 'error')!.answer_text).toBe('She goes to school every day.')
    expect(r.items.find((x) => x.type === 'order')!.words).toHaveLength(6)
    expect(r.score).toBe(0)
  })

  it('điểm tính chung cho mọi dạng', () => {
    const answers = items.map((q) => (q.type === 'mcq' ? q.answer : q.type === 'error' ? 'goes' : String(q.answer))) as (string | number)[]
    expect(gradeQuiz(items, answers).score).toBe(100)
  })

  it('validateAnswers: dạng chữ nhận chuỗi ≤ 200 ký tự, trắc nghiệm nhận chỉ số', () => {
    expect(validateAnswers(items, items.map((q) => (q.type === 'mcq' ? 0 : 'abc')))).toBe(true)
    expect(validateAnswers(items, items.map((q) => (q.type === 'mcq' ? 0 : 'x'.repeat(201))))).toBe(false)
    expect(validateAnswers(items, items.map((q) => (q.type === 'mcq' ? 'a' : 'abc')))).toBe(false)
  })

  it('publicQuiz: gửi các từ cho sẵn của câu order nhưng không lộ đáp án', () => {
    const pub = publicQuiz(items)
    expect(pub.find((x) => x.type === 'order')!.words).toEqual(O.words)
    expect(JSON.stringify(pub)).not.toMatch(/"answer"|"accept"|goes/)
  })
})

describe('bài học có các phần mới', () => {
  const SRC = { type: 'ai', title: 'AI', ai_written: true } as const
  it('giữ câu của bài đọc kèm bản dịch (bỏ câu thiếu bản dịch), tối đa 12 câu', () => {
    const l = normalizeLesson(lessonJson({ sentences: [{ en: 'I get up.', vi: 'Tôi thức dậy.' }, { en: 'No translation', vi: '' }, ...Array.from({ length: 20 }, (_, i) => ({ en: `S${i}`, vi: `D${i}` }))] }), SRC)
    expect(l.sentences![0]).toEqual({ en: 'I get up.', vi: 'Tôi thức dậy.' })
    expect(l.sentences!.length).toBe(12)
    expect(l.sentences!.every((s) => s.vi)).toBe(true)
  })

  it('bài tập ngữ pháp: mỗi câu đúng một chỗ trống, có đáp án; tối đa 5; bài cũ không có thì không sao', () => {
    const l = normalizeLesson(
      lessonJson({
        grammar_practice: [
          { question: 'I ___ up at six.', answer: 'get', explanation_vi: 'Hiện tại đơn.' },
          { question: 'No blank here.', answer: 'x' },
          { question: 'Two ___ blanks ___.', answer: 'x' },
          { question: 'She ___ tea.', answer: '' },
          ...Array.from({ length: 8 }, (_, i) => ({ question: `Item ${i} ___.`, answer: 'a' })),
        ],
      }),
      SRC,
    )
    expect(l.grammar_practice![0]).toEqual({ question: 'I ___ up at six.', answer: 'get', explanation_vi: 'Hiện tại đơn.' })
    expect(l.grammar_practice).toHaveLength(5)
    expect(normalizeLesson(lessonJson(), SRC).grammar_practice).toBeUndefined()
  })

  it('điểm ngữ pháp có tối đa 3 câu ví dụ để chép', () => {
    const l = normalizeLesson(lessonJson({ grammar: [{ point: 'Present simple', explanation_vi: 'g', example: 'I get up.', examples: ['a', 'b', 'c', 'd', ''] }] }), SRC)
    expect(l.grammar[0].examples).toEqual(['a', 'b', 'c'])
  })

  it('câu viết lại / sắp xếp / tìm lỗi không bị lọc "bám bài" (kiểm tra ngữ pháp bằng câu mới)', () => {
    const l = lessonJson() as any
    const extra = normalizeQuiz([...l.quiz.slice(0, 5), rewrite, order, error], [], noShuffle)!
    expect(groundQuiz({ ...l, quiz: extra }).filter((q) => ['rewrite', 'order', 'error'].includes(q.type))).toHaveLength(3)
  })
})
