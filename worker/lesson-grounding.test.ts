import { afterEach, describe, expect, it, vi } from 'vitest'
import { groundQuiz, MIN_READING_WORDS, readingWords } from './lesson-grounding'
import { buildLessonPrompt, composeLesson, LessonQualityError } from './lesson'
import { createTestDb } from './test-db'
import { lessonJson, READING } from './test-fixtures'
import type { Env } from './env'

// Bài thật AI từng soạn: bài đọc chỉ 3 câu nhưng quiz hỏi cả chuyện đi học bằng xe gì, ăn trưa ở đâu, mấy giờ đi ngủ…
const LINH_READING =
  "Hello! My name is Linh. I am a student. Every day, I wake up at six o'clock in the morning. I brush my teeth and wash my face. Then, I eat breakfast with my family at half past six."
const mcq = (question: string, right: string, ...wrong: string[]) => ({ type: 'mcq', question, options: [right, ...wrong], answer: 0, explanation_vi: 'x' })
const fill = (question: string, answer: string) => ({ type: 'fill', question, answer, explanation_vi: 'x' })
const LINH = {
  excerpt: LINH_READING,
  vocab: [
    { word: 'wake up', meaning_vi: 'thức dậy', example: 'I wake up early.' },
    { word: 'brush my teeth', meaning_vi: 'đánh răng' },
    { word: 'eat breakfast', meaning_vi: 'ăn sáng' },
    { word: 'do my homework', meaning_vi: 'làm bài tập' },
    { word: 'go to sleep', meaning_vi: 'đi ngủ' },
  ],
  grammar: [{ point: 'Present simple', explanation_vi: 'g', example: 'I wake up at six.' }],
  quiz: [
    mcq('What time does Linh wake up in the morning?', "At six o'clock", 'At seven', 'At eight', 'At nine'), // có trong bài
    mcq('Where does Linh eat lunch?', 'At the school canteen', 'At home', 'In a park', 'At a cafe'), // KHÔNG có
    mcq('Which phrase means "đánh răng" in English?', 'brush my teeth', 'wash my face', 'eat breakfast', 'go out'), // từ vựng
    mcq('What does Linh do in the afternoon?', 'Does her homework', 'Plays games', 'Sleeps', 'Cooks'), // KHÔNG có
    mcq('What time does Linh go to sleep?', 'At half past nine', 'At six', 'At ten', 'At eleven'), // "nine" KHÔNG có
    fill("Every day, I wake up at six o'clock in the ___.", 'morning'), // có
    fill('In the afternoon, I go home and do my ___.', 'homework'), // từ vựng
    fill('I eat breakfast with my ___.', 'family'), // có
  ],
} as any

describe('groundQuiz — quiz phải bám sát bài đọc người học thấy', () => {
  it('bỏ câu hỏi chi tiết không có trong bài (ăn trưa ở đâu, buổi chiều làm gì, mấy giờ đi ngủ); giữ câu có trong bài và câu từ vựng', () => {
    const kept = groundQuiz(LINH).map((q) => q.question)
    expect(kept).toEqual([
      'What time does Linh wake up in the morning?',
      'Which phrase means "đánh răng" in English?',
      "Every day, I wake up at six o'clock in the ___.",
      'In the afternoon, I go home and do my ___.',
      'I eat breakfast with my ___.',
    ])
  })

  it('bài đọc đủ dài chứa nội dung quiz hỏi → giữ nguyên toàn bộ', () => {
    const l = lessonJson() as any
    expect(groundQuiz(l)).toHaveLength(l.quiz.length)
  })

  it('khớp dạng biến đổi (goes/go, brushed/brush) và bỏ qua mạo từ/giới từ', () => {
    const l = { excerpt: 'Linh goes to school and brushed her teeth.', vocab: [], grammar: [], quiz: [mcq('What does Linh do?', 'She goes to school', 'x', 'y', 'z'), mcq('What did Linh brush?', 'Her teeth', 'x', 'y', 'z')] } as any
    expect(groundQuiz(l)).toHaveLength(2)
  })

  it('đáp án tiếng Việt (nghĩa của từ) không kiểm tra được bằng chữ nên được giữ', () => {
    const l = { excerpt: 'Hello.', vocab: [], grammar: [], quiz: [mcq('What does "menu" mean?', 'Thực đơn', 'a', 'b', 'c')] } as any
    expect(groundQuiz(l)).toHaveLength(1)
  })

  it('câu hỏi ngôn ngữ ("câu nào đúng") chỉ cần một nửa từ khóa có trong bài vì đáp án có thể dùng từ mới', () => {
    const l = { excerpt: 'I order tea every day at the cafe near my school.', vocab: [], grammar: [], quiz: [mcq('Choose the correct sentence.', 'I order coffee.', 'a', 'b', 'c')] } as any
    expect(groundQuiz(l)).toHaveLength(1) // "order" có, "coffee" không → 1/2
  })

  it('đo số từ của bài đọc', () => {
    expect(readingWords({ excerpt: READING })).toBeGreaterThanOrEqual(MIN_READING_WORDS)
    expect(readingWords({ excerpt: LINH_READING })).toBeLessThan(MIN_READING_WORDS)
    expect(readingWords({ excerpt: 'a b', reading: 'c d e' })).toBe(5) // gồm cả bài viết lại (reading) và đoạn trích
  })
})

describe('prompt: mẫu JSON không mâu thuẫn với yêu cầu viết bài dài', () => {
  const ctx = { level: 'A1', topic: 'Daily routines', chosen: null } as any
  it('AI tự viết: excerpt là TOÀN BỘ bài đọc (không còn dòng \"max 80 words\" làm AI viết ngắn), không có trường reading', () => {
    const p = buildLessonPrompt(ctx, { kind: 'ai' })
    expect(p).toContain('the FULL reading text you wrote (')
    expect(p).not.toMatch(/ONE short quote/)
    expect(p).not.toMatch(/\"reading\":/)
    expect(p).toContain('Questions about the text must be answerable ONLY from the reading text the learner sees')
  })
  it('bài từ nguồn thật: giữ mẫu cũ (trích ngắn ≤ 80 từ + reading do AI viết lại)', () => {
    const p = buildLessonPrompt({ ...ctx, chosen: { type: 'article', title: 'T', url: 'https://example.com', why_vi: 'x', excerpt: 'x' } }, { kind: 'text', text: 'abc' })
    expect(p).toContain('ONE short quote (max 80 words)')
    expect(p).toMatch(/\"reading\":/)
  })
})

describe('composeLesson — tự thử lại khi bài kém chất lượng', () => {
  afterEach(() => vi.unstubAllGlobals())
  const env = () => ({ DB: createTestDb(), GEMINI_API_KEY: 'k' }) as Env
  const reply = (lesson: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(lesson) }] } }] })
  const stub = (lessons: unknown[]) => {
    let n = 0
    const f = vi.fn(async () => reply(lessons[Math.min(n++, lessons.length - 1)]))
    vi.stubGlobal('fetch', f)
    return f
  }
  const base = { level: 'A1', topic: 'Daily routines', chosen: null, fallbackNotice: 'x' }

  it('lần 1 bài đọc quá ngắn / quiz lệch bài → gọi AI lần 2 và dùng bài tốt', async () => {
    const f = stub([{ ...lessonJson(), ...LINH }, lessonJson()])
    const l = await composeLesson(env(), base)
    expect(f).toHaveBeenCalledTimes(2)
    expect(l.excerpt).toBe(READING)
    expect(l.quiz).toHaveLength(8)
  })

  it('bài tốt ngay lần đầu → chỉ gọi AI một lần', async () => {
    const f = stub([lessonJson()])
    await composeLesson(env(), base)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('lượt thử lại: bài đọc vẫn ngắn nhưng quiz bám bài (đủ ≥ 6 câu) thì chấp nhận; quiz vẫn lệch thì báo lỗi', async () => {
    const shortButGrounded = { ...lessonJson(), excerpt: 'Linh eats breakfast with her family at six. She likes tea, a pizza and the menu. The waiter is friendly and fast. Linh asks for the bill and leaves a tip.' }
    const f = stub([{ ...lessonJson(), ...LINH }, shortButGrounded])
    const l = await composeLesson(env(), base)
    expect(f).toHaveBeenCalledTimes(2)
    expect(l.quiz.length).toBeGreaterThanOrEqual(6)

    stub([{ ...lessonJson(), ...LINH }, { ...lessonJson(), ...LINH }])
    await expect(composeLesson(env(), base)).rejects.toBeInstanceOf(LessonQualityError)
  })

  it('AI trả JSON hỏng (lỗi thoáng qua) → thử lại một lần và dùng bài tốt', async () => {
    let n = 0
    const f = vi.fn(async () => (n++ === 0 ? Response.json({ candidates: [{ content: { parts: [{ text: 'không phải JSON' }] } }] }) : reply(lessonJson())))
    vi.stubGlobal('fetch', f)
    const l = await composeLesson(env(), base)
    expect(f).toHaveBeenCalledTimes(2)
    expect(l.title).toBe('Ordering food and drinks')
  })

  it('lỗi API (429/503) KHÔNG bị thử lại ở tầng này', async () => {
    const f = vi.fn(async () => new Response('', { status: 429 }))
    vi.stubGlobal('fetch', f)
    await expect(composeLesson(env(), base)).rejects.toMatchObject({ kind: 'rate' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('không đủ thời gian cho lần thử lại thì báo lỗi ngay (không vượt giới hạn 60 giây)', async () => {
    const f = stub([{ ...lessonJson(), ...LINH }, lessonJson()])
    await expect(composeLesson(env(), base, { budgetMs: 20_000 })).rejects.toBeInstanceOf(LessonQualityError)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
