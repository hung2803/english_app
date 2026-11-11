import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { AiError } from './errors'
import { buildLessonPrompt, normalizeLesson } from './lesson'
import { MIN_QUIZ, normalizeQuiz, publicQuiz, QUIZ_SIZE, shuffle } from './quiz'
import { lessonJson, QUIZ8 } from './test-fixtures'
import { createTestDb } from './test-db'
import type { Env } from './env'

const VOCAB = ['order', 'menu', 'bill', 'waiter', 'tip']
const noShuffle = () => 0.999999 // Fisher–Yates với giá trị này giữ nguyên thứ tự
const mcq = (i: number, over: Record<string, unknown> = {}) => ({ type: 'mcq', question: `Question ${i}?`, options: [`a${i}`, `b${i}`, `c${i}`, `d${i}`], answer: 0, explanation_vi: `Vì ${i}.`, ...over })
const fill = (i: number, over: Record<string, unknown> = {}) => ({ type: 'fill', question: `Sentence ${i} with a ___ here.`, answer: `word${i}`, explanation_vi: `Vì ${i}.`, ...over })
const set = (nm: number, nf: number) => [...Array.from({ length: nm }, (_, i) => mcq(i)), ...Array.from({ length: nf }, (_, i) => fill(100 + i))]

describe('shuffle', () => {
  it('giữ đủ phần tử, không đổi mảng gốc', () => {
    const a = [1, 2, 3, 4]
    const b = shuffle(a)
    expect([...b].sort()).toEqual([1, 2, 3, 4])
    expect(a).toEqual([1, 2, 3, 4])
  })
  it('xáo trộn thật (qua nhiều lần có đủ các hoán vị khác nhau)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) seen.add(shuffle([0, 1, 2, 3]).join(''))
    expect(seen.size).toBeGreaterThan(15) // 24 hoán vị
  })
})

describe('normalizeQuiz — bộ 8 câu hợp lệ', () => {
  it('5 trắc nghiệm + 3 điền từ hợp lệ → đủ 8 câu', () => {
    const q = normalizeQuiz(QUIZ8, VOCAB)!
    expect(q).toHaveLength(QUIZ_SIZE)
    expect(q.filter((x) => x.type === 'mcq')).toHaveLength(5)
    expect(q.filter((x) => x.type === 'fill')).toHaveLength(3)
  })
  it('mỗi câu có đủ câu hỏi, đáp án, giải thích tiếng Việt', () => {
    for (const q of normalizeQuiz(QUIZ8, VOCAB)!) {
      expect(q.question).not.toBe('')
      expect(q.explanation_vi).not.toBe('')
      expect(q.answer === 0 || Boolean(q.answer)).toBe(true)
    }
  })
  it('trắc nghiệm: đúng 4 lựa chọn, chỉ số đáp án 0–3', () => {
    for (const q of normalizeQuiz(QUIZ8, VOCAB)!.filter((x) => x.type === 'mcq')) {
      expect(q.options).toHaveLength(4)
      expect(q.answer).toBeGreaterThanOrEqual(0)
      expect(q.answer).toBeLessThanOrEqual(3)
    }
  })
  it('nhiều hơn 8 câu → cắt còn 8 (giữ thứ tự AI đưa)', () => {
    const q = normalizeQuiz(set(7, 5), VOCAB, noShuffle)!
    expect(q).toHaveLength(8)
    expect(q.map((x) => x.question).slice(0, 2)).toEqual(['Question 0?', 'Question 1?'])
  })
})

describe('normalizeQuiz — xáo trộn vị trí đáp án đúng', () => {
  it('đáp án đúng vẫn trỏ đúng nội dung sau khi xáo trộn', () => {
    for (let k = 0; k < 50; k++) {
      const [q] = normalizeQuiz([mcq(1, { answer: 2 }), ...set(4, 3).slice(1)], VOCAB)!
      expect(q.options![q.answer as number]).toBe('c1') // lựa chọn đúng ban đầu (chỉ số 2)
      expect([...q.options!].sort()).toEqual(['a1', 'b1', 'c1', 'd1'])
    }
  })
  it('AI luôn để đáp án ở vị trí 0 → sau xáo trộn rải đều cả 4 vị trí', () => {
    const counts = [0, 0, 0, 0]
    for (let k = 0; k < 400; k++) counts[normalizeQuiz(set(5, 3), VOCAB)![0].answer as number]++
    for (const c of counts) expect(c).toBeGreaterThan(50) // kỳ vọng ~100 mỗi vị trí
  })
  it('rng cố định cho kết quả lặp lại được', () => {
    const rng = () => 0.3
    expect(normalizeQuiz(set(5, 3), VOCAB, rng)).toEqual(normalizeQuiz(set(5, 3), VOCAB, rng))
  })
})

describe('normalizeQuiz — ngưỡng tối thiểu', () => {
  it(`ít nhất ${MIN_QUIZ} câu hợp lệ: 6 được, 5 thì không`, () => {
    expect(normalizeQuiz(set(4, 2), VOCAB)).toHaveLength(6)
    expect(normalizeQuiz(set(3, 2), VOCAB)).toBeNull()
  })
  it('cần cả trắc nghiệm (≥ 2) lẫn điền từ (≥ 1)', () => {
    expect(normalizeQuiz(set(8, 0), VOCAB)).toBeNull()
    expect(normalizeQuiz(set(0, 8), VOCAB)).toBeNull()
    expect(normalizeQuiz(set(7, 1), VOCAB)).toHaveLength(8)
    expect(normalizeQuiz(set(1, 7), VOCAB)).toBeNull() // chỉ 1 trắc nghiệm
  })
  it('bỏ câu hỏng nhưng vẫn đủ ngưỡng → dùng phần còn lại', () => {
    const items = [...set(5, 3), { type: 'mcq', question: '' }, null, 'x', 5]
    expect(normalizeQuiz(items, VOCAB)).toHaveLength(8)
  })
  it('không phải mảng → null', () => {
    for (const bad of [null, undefined, 'x', 5, {}, { quiz: [] }]) expect(normalizeQuiz(bad, VOCAB)).toBeNull()
  })
})

describe('normalizeQuiz — loại câu hỏng', () => {
  const only = (item: unknown) => normalizeQuiz([item, ...set(5, 3)], VOCAB, noShuffle)!.some((q) => q.question.includes('BAD'))

  it('trắc nghiệm hỏng bị bỏ', () => {
    const bad: Record<string, unknown>[] = [
      { options: ['a', 'b', 'c'] }, // thiếu lựa chọn
      { options: ['a', 'b', 'c', 'd', 'e'] }, // thừa
      { options: ['a', 'b', 'c', ''] }, // rỗng
      { options: ['a', 'A', 'c', 'd'] }, // trùng (không phân biệt hoa thường)
      { options: 'abcd' },
      { answer: 4 }, { answer: -1 }, { answer: 1.5 }, { answer: '1' }, { answer: null },
      { explanation_vi: '' }, { explanation_vi: '   ' },
    ]
    for (const o of bad) expect(only(mcq(0, { question: 'BAD mcq?', ...o })), JSON.stringify(o)).toBe(false)
  })
  it('điền từ hỏng bị bỏ', () => {
    const bad: Record<string, unknown>[] = [
      { question: 'BAD no blank' }, // không có chỗ trống
      { question: 'BAD two ___ blanks ___ here' }, // hai chỗ trống
      { answer: '' }, { answer: '   ' }, { answer: 5 }, { answer: null },
      { answer: 'one two three four' }, // quá 3 từ
      { explanation_vi: '' },
    ]
    for (const o of bad) expect(only(fill(0, { question: 'BAD fill ___ here', ...o })), JSON.stringify(o)).toBe(false)
  })
  it('loại lạ / thiếu loại / câu hỏi rỗng bị bỏ', () => {
    for (const o of [{ type: 'essay' }, { type: undefined }, { question: '' }, { question: '   ' }]) {
      expect(only({ ...mcq(0), question: 'BAD', ...o, ...(o.question === undefined ? { question: 'BAD' } : {}) })).toBe(false)
    }
  })
  it('câu trùng (không phân biệt hoa thường) chỉ giữ một', () => {
    const q = normalizeQuiz([mcq(1, { question: 'Same question?' }), mcq(2, { question: 'SAME QUESTION?' }), ...set(5, 3).slice(2)], VOCAB, noShuffle)!
    expect(q.filter((x) => x.question.toLowerCase() === 'same question?')).toHaveLength(1)
  })
  it('chỉ giữ các trường cần thiết, bỏ trường lạ (không lọt nội dung thừa vào CSDL)', () => {
    const q = normalizeQuiz([{ ...mcq(1), html: '<b>x</b>', hint: 'secret' }, ...set(5, 3).slice(1)], VOCAB)!
    expect(Object.keys(q[0]).sort()).toEqual(['answer', 'explanation_vi', 'options', 'question', 'type'])
  })
  it('cắt độ dài; chuẩn hóa khoảng trắng', () => {
    const [q] = normalizeQuiz([mcq(1, { question: '  Long   question  ' + 'x'.repeat(900) + '?', options: ['o'.repeat(500), 'b', 'c', 'd'], explanation_vi: 'e'.repeat(900) }), ...set(5, 3).slice(1)], VOCAB, noShuffle)!
    expect(q.question.length).toBeLessThanOrEqual(300)
    expect(q.question.startsWith('Long question')).toBe(true)
    expect(q.options![0].length).toBeLessThanOrEqual(120)
    expect(q.explanation_vi.length).toBeLessThanOrEqual(400)
  })
})

describe('normalizeQuiz — từ liên quan (word)', () => {
  it('giữ nếu là từ vựng của bài (không phân biệt hoa thường), bỏ nếu không phải', () => {
    const items = [mcq(1, { word: 'ORDER' }), mcq(2, { word: 'random' }), mcq(3), fill(4, { word: 'menu' }), fill(5), fill(6), mcq(7), mcq(8)]
    const q = normalizeQuiz(items, VOCAB, noShuffle)!
    expect(q[0].word).toBe('ORDER')
    expect(q[1].word).toBeUndefined()
    expect(q[3].word).toBe('menu')
  })
})

describe('publicQuiz — không lộ đáp án', () => {
  const full = normalizeQuiz(QUIZ8, VOCAB)!
  it('chỉ còn loại, câu hỏi, lựa chọn', () => {
    const p = publicQuiz(full)
    expect(p).toHaveLength(8)
    for (const q of p) expect(Object.keys(q).every((k) => ['type', 'question', 'options'].includes(k))).toBe(true)
    expect(p.filter((q) => q.type === 'fill').every((q) => !('options' in q))).toBe(true)
  })
  it('chuỗi JSON gửi đi không chứa đáp án, giải thích hay từ liên quan', () => {
    const text = JSON.stringify(publicQuiz(full))
    expect(text).not.toMatch(/"answer"|"explanation_vi"|"word"/)
    expect(text).not.toContain('Hóa đơn là') // nội dung giải thích
  })
})

describe('normalizeLesson có quiz', () => {
  const SRC = { type: 'article' as const, url: 'https://example.com/a', title: 'A', ai_written: false }
  it('bài hợp lệ có quiz 8 câu', () => {
    expect(normalizeLesson(lessonJson(), SRC).quiz).toHaveLength(8)
  })
  it('thiếu quiz / quiz không đủ câu hợp lệ → AiError (để thử lại)', () => {
    for (const quiz of [undefined, [], 'x', set(3, 1), set(8, 0)]) expect(() => normalizeLesson(lessonJson({ quiz }), SRC)).toThrow(AiError)
  })
  it('chỉ nhận từ liên quan nằm trong từ vựng của chính bài', () => {
    const q = normalizeLesson(lessonJson({ quiz: set(5, 3).map((x, i) => ({ ...x, word: i === 0 ? 'bill' : 'zzz' })) }), SRC).quiz
    expect(q[0].word).toBe('bill')
    expect(q[1].word).toBeUndefined()
  })
})

describe('đề bài gửi AI yêu cầu quiz', () => {
  it('nêu đủ: 8 câu, 5 trắc nghiệm, 3 điền từ, đáp án là chỉ số, đúng một chỗ trống, giải thích tiếng Việt, theo nội dung bài', () => {
    const p = buildLessonPrompt({ level: 'A2', topic: 'Travel', chosen: null }, { kind: 'ai' })
    for (const w of ['exactly 8 items', '5 "mcq" and 3 "fill"', 'zero-based index', 'exactly one "___" blank', 'max 3 words', 'answerable from this lesson', 'explanation_vi', 'Vietnamese', '"quiz"']) expect(p).toContain(w)
    expect(p).toContain('suited to A2')
  })
})

/* ---------------- qua API ---------------- */
const SECRET = 'test-secret-test-secret-test-secret'
describe('quiz qua API: người học không thấy đáp án trước khi nộp', () => {
  let env: Env
  let db: D1Database
  const A = { type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }
  const B = { type: 'article', title: 'B', url: 'https://example.com/b', why_vi: 'b', excerpt: 'b' }
  const PAGE = '<html><head><title>L</title></head><body>' + '<p>Can I have a coffee please? Yes of course. </p>'.repeat(40) + '</body></html>'

  const stub = (lesson: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('generativelanguage')) {
          const isSearch = Boolean(JSON.parse(init?.body as string).tools)
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(isSearch ? { options: [A, B] } : lesson) }] } }] })
        }
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
      }),
    )
  async function call(path: string, body?: unknown) {
    return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
  }
  const json = async (r: Response) => (await r.json()) as any
  const sid = async () => (await db.prepare('SELECT id FROM sessions WHERE seq = 1').first<{ id: number }>())!.id
  const flow = async () => {
    await call(`/api/sessions/${await sid()}/materials`, {})
    await call(`/api/sessions/${await sid()}/choose`, { index: 0 })
    return call(`/api/sessions/${await sid()}/compose`, {})
  }
  const storedQuiz = async () => JSON.parse((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<{ lesson_json: string }>())!.lesson_json).quiz

  beforeEach(async () => {
    db = createTestDb()
    env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
    expect((await call('/api/plan', {})).status).toBe(200)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('compose: lưu quiz đầy đủ ở máy chủ, nhưng trả cho client bản KHÔNG có đáp án', async () => {
    stub(lessonJson())
    const r = await flow()
    expect(r.status).toBe(200)
    const { lesson } = await json(r)
    expect(lesson.quiz).toHaveLength(8)
    expect(JSON.stringify(lesson.quiz)).not.toMatch(/"answer"|"explanation_vi"|"word"/)
    const stored = await storedQuiz()
    expect(stored).toHaveLength(8)
    expect(stored.every((q: any) => 'answer' in q && q.explanation_vi)).toBe(true)
  })

  it('GET buổi học (chưa xong): quiz không có đáp án; câu hỏi và lựa chọn thì có', async () => {
    stub(lessonJson())
    await flow()
    const { session } = await json(await call(`/api/sessions/${await sid()}`))
    expect(session.lesson.quiz).toHaveLength(8)
    expect(session.lesson.quiz[0]).toEqual({ type: 'mcq', question: expect.any(String), options: expect.any(Array) })
    expect(JSON.stringify(session.lesson.quiz)).not.toMatch(/"answer"|"explanation_vi"|"word"/)
    expect(JSON.stringify(session)).not.toContain("Hóa đơn.") // nội dung giải thích đáp án
  })

  it('đáp án đúng trong CSDL khớp nội dung lựa chọn gửi cho client (xáo trộn không làm lệch)', async () => {
    stub(lessonJson())
    await flow()
    const { session } = await json(await call(`/api/sessions/${await sid()}`))
    const stored = await storedQuiz()
    stored.forEach((q: any, i: number) => {
      const shown = session.lesson.quiz[i]
      expect(shown.question).toBe(q.question)
      if (q.type === 'mcq') expect(shown.options).toEqual(q.options)
    })
    const bill = stored.find((q: any) => q.question.startsWith('What do you ask for'))
    expect(bill.options[bill.answer]).toBe('The bill')
  })

  it('buổi đã xong: GET trả quiz kèm đáp án và giải thích để xem lại', async () => {
    stub(lessonJson())
    await flow()
    await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=1").bind(todayVN()).run()
    const { session } = await json(await call(`/api/sessions/${await sid()}`))
    expect(session.lesson.quiz[0]).toMatchObject({ answer: expect.anything(), explanation_vi: expect.any(String) })
  })

  it('AI trả quiz thiếu/không đủ → 503, không lưu bài dở, thử lại được', async () => {
    stub(lessonJson({ quiz: set(2, 1) }))
    const r = await flow()
    expect(r.status).toBe(503)
    expect((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<{ lesson_json: string | null }>())!.lesson_json).toBeNull()
    stub(lessonJson())
    expect((await call(`/api/sessions/${await sid()}/compose`, {})).status).toBe(200)
  })

  it('quiz sinh cùng MỘT lần gọi AI với bài học (không tốn thêm lượt trong giới hạn 60 giây)', async () => {
    stub(lessonJson())
    await call(`/api/sessions/${await sid()}/materials`, {})
    await call(`/api/sessions/${await sid()}/choose`, { index: 0 })
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    f.mockClear()
    await call(`/api/sessions/${await sid()}/compose`, {})
    const geminiCalls = f.mock.calls.filter((c) => String(c[0]).includes('generativelanguage'))
    expect(geminiCalls).toHaveLength(1)
  })

  it('bài AI tự viết (fallback) cũng có quiz', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('generativelanguage')) {
          const isSearch = Boolean(JSON.parse(init?.body as string).tools)
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(isSearch ? { options: [] } : lessonJson()) }] } }] })
        }
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
      }),
    )
    await call(`/api/sessions/${await sid()}/materials`, {})
    const { lesson } = await json(await call(`/api/sessions/${await sid()}/compose`, {}))
    expect(lesson.source.ai_written).toBe(true)
    expect(lesson.quiz).toHaveLength(8)
  })
})
