import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { gradeQuiz, isCorrect, normalizeAnswer, PASS_PERCENT, validateAnswers, type QuizItem } from './quiz'
import { lessonJson, QUIZ8 } from './test-fixtures'
import { createTestDb } from './test-db'
import type { Env } from './env'

const QUIZ = QUIZ8 as QuizItem[] // answer mcq = chỉ số đúng; fill = chữ
const correctAnswers = () => QUIZ.map((q) => q.answer as number | string)
const wrongOf = (q: QuizItem) => (q.type === 'mcq' ? ((q.answer as number) + 1) % 4 : 'definitely wrong')
/** Bài làm đúng `n` câu đầu, sai các câu còn lại. */
const rightFirst = (n: number) => QUIZ.map((q, i) => (i < n ? (q.answer as number | string) : wrongOf(q)))

describe('normalizeAnswer', () => {
  it('bỏ khoảng trắng thừa, không phân biệt hoa thường, bỏ dấu câu cuối', () => {
    expect(normalizeAnswer('  The   Menu. ')).toBe('the menu')
    expect(normalizeAnswer('MENU!')).toBe('menu')
    expect(normalizeAnswer('"menu"')).toBe('menu')
    expect(normalizeAnswer('menu?!')).toBe('menu')
  })
  it('dấu nháy cong = dấu nháy thẳng', () => {
    expect(normalizeAnswer('don’t')).toBe("don't")
    expect(normalizeAnswer("don't")).toBe(normalizeAnswer('don’t'))
  })
  it('giữ nguyên nội dung bên trong và ký tự có dấu (NFC)', () => {
    expect(normalizeAnswer('ice-cream')).toBe('ice-cream')
    expect(normalizeAnswer('café')).toBe(normalizeAnswer('café'))
  })
  it('chuỗi rỗng / chỉ dấu câu → rỗng', () => {
    expect(normalizeAnswer('   ')).toBe('')
    expect(normalizeAnswer('...')).toBe('')
  })
})

describe('isCorrect', () => {
  const mcq = QUIZ[0]
  const fill = QUIZ[5]
  it('trắc nghiệm: đúng khi chỉ số trùng, sai khi khác hoặc bỏ trống', () => {
    expect(isCorrect(mcq, mcq.answer as number)).toBe(true)
    expect(isCorrect(mcq, ((mcq.answer as number) + 1) % 4)).toBe(false)
    expect(isCorrect(mcq, null)).toBe(false)
  })
  it('trắc nghiệm: gửi chuỗi "0" thay vì số 0 thì không đúng (chống gian lận kiểu)', () => {
    expect(isCorrect(mcq, String(mcq.answer))).toBe(false)
  })
  it('điền từ: so khớp sau chuẩn hóa', () => {
    for (const ok of ['menu', 'MENU', '  Menu  ', 'menu.', 'Menu!']) expect(isCorrect(fill, ok), ok).toBe(true)
    for (const bad of ['menus', 'men', 'the menu', '', 'bill']) expect(isCorrect(fill, bad), bad).toBe(false)
    expect(isCorrect(fill, null)).toBe(false)
  })
  it('điền từ: gửi số thì sai', () => {
    expect(isCorrect(fill, 0)).toBe(false)
  })
})

describe('validateAnswers', () => {
  it('đủ số câu, đúng kiểu từng câu', () => {
    expect(validateAnswers(QUIZ, correctAnswers())).toBe(true)
    expect(validateAnswers(QUIZ, QUIZ.map(() => null))).toBe(true) // bỏ trống hết vẫn hợp lệ
  })
  it('sai số lượng, sai kiểu, ngoài khoảng, quá dài, không phải mảng', () => {
    const ok = correctAnswers()
    const bad: unknown[] = [
      ok.slice(1), [...ok, 'x'], [],
      ok.map((a, i) => (i === 0 ? 4 : a)), ok.map((a, i) => (i === 0 ? -1 : a)), ok.map((a, i) => (i === 0 ? 1.5 : a)),
      ok.map((a, i) => (i === 0 ? '1' : a)), // mcq nhận chuỗi
      ok.map((a, i) => (i === 5 ? 3 : a)), // fill nhận số
      ok.map((a, i) => (i === 5 ? 'x'.repeat(201) : a)),
      ok.map((a, i) => (i === 0 ? {} : a)), ok.map((a, i) => (i === 0 ? [0] : a)), ok.map((a, i) => (i === 0 ? undefined : a)),
      'abc', null, undefined, {}, 8,
    ]
    for (const b of bad) expect(validateAnswers(QUIZ, b), JSON.stringify(b)).toBe(false)
  })
})

describe('gradeQuiz', () => {
  it('đúng hết → 100, đạt', () => {
    expect(gradeQuiz(QUIZ, correctAnswers())).toMatchObject({ score: 100, right: 8, total: 8, passed: true })
  })
  it('sai hết / bỏ trống hết → 0, chưa đạt', () => {
    expect(gradeQuiz(QUIZ, QUIZ.map(wrongOf))).toMatchObject({ score: 0, right: 0, passed: false })
    expect(gradeQuiz(QUIZ, QUIZ.map(() => null))).toMatchObject({ score: 0, right: 0, passed: false })
  })
  it(`ngưỡng đạt ${PASS_PERCENT}%: 5/8 = 63% chưa đạt, 6/8 = 75% đạt`, () => {
    expect(gradeQuiz(QUIZ, rightFirst(5))).toMatchObject({ score: 63, passed: false })
    expect(gradeQuiz(QUIZ, rightFirst(6))).toMatchObject({ score: 75, passed: true })
  })
  it('làm tròn: 7 câu đúng 5 → 71% đạt; 6 câu đúng 4 → 67% chưa đạt', () => {
    const q7 = QUIZ.slice(0, 7)
    expect(gradeQuiz(q7, q7.map((q, i) => (i < 5 ? (q.answer as number | string) : wrongOf(q)))).score).toBe(71)
    expect(gradeQuiz(q7, q7.map((q, i) => (i < 5 ? (q.answer as number | string) : wrongOf(q)))).passed).toBe(true)
    const q6 = QUIZ.slice(0, 6)
    const r = gradeQuiz(q6, q6.map((q, i) => (i < 4 ? (q.answer as number | string) : wrongOf(q))))
    expect(r.score).toBe(67)
    expect(r.passed).toBe(false)
  })
  it('chi tiết từng câu: đúng/sai, câu trả lời, đáp án đúng, nội dung đáp án, giải thích, từ liên quan', () => {
    const answers = rightFirst(6) // sai câu 7, 8 (điền từ)
    const r = gradeQuiz(QUIZ, answers, '2026-11-11T08:00:00.000Z')
    expect(r.items).toHaveLength(8)
    expect(r.items[0]).toMatchObject({ index: 0, type: 'mcq', correct: true, given: 0, answer: 0, answer_text: 'The bill', explanation_vi: 'The bill là hóa đơn.', word: 'bill' })
    expect(r.items[0].options).toHaveLength(4)
    expect(r.items[6]).toMatchObject({ type: 'fill', correct: false, given: 'definitely wrong', answer: 'order', answer_text: 'order', explanation_vi: 'Gọi món: order.' })
    expect(r.items[6].options).toBeUndefined()
    expect(r.submitted_at).toBe('2026-11-11T08:00:00.000Z')
  })
  it('đáp án đúng của câu sai trắc nghiệm hiện đúng nội dung lựa chọn', () => {
    const r = gradeQuiz(QUIZ, QUIZ.map(wrongOf))
    expect(r.items[1].answer_text).toBe('The waiter')
    expect(r.items[1].given).toBe(2)
  })
  it('quiz rỗng → 0 điểm, không chia cho 0', () => {
    expect(gradeQuiz([], [])).toMatchObject({ score: 0, total: 0, passed: false })
  })
})

/* ---------------- qua API ---------------- */
const SECRET = 'test-secret-test-secret-test-secret'
describe('POST /api/sessions/:id/quiz', () => {
  let env: Env
  let db: D1Database
  const LESSON = lessonJson()

  beforeEach(async () => {
    db = createTestDb()
    env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
    expect((await call('/api/plan', {})).status).toBe(200)
    await db.prepare('UPDATE sessions SET lesson_json = ? WHERE seq IN (1, 2)').bind(JSON.stringify(LESSON)).run()
  })
  afterEach(() => vi.unstubAllGlobals())

  async function call(path: string, body?: unknown, authed = true) {
    return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
  }
  const json = async (r: Response) => (await r.json()) as any
  const sid = async (seq = 1) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
  const submit = async (answers: unknown, seq = 1) => call(`/api/sessions/${await sid(seq)}/quiz`, { answers })
  const row = async (seq = 1) => (await db.prepare('SELECT status, score, result_json, completed_date FROM sessions WHERE seq = ?').bind(seq).first<any>())!
  /** Quiz đã xáo trộn như lưu trong CSDL */
  const stored = async (seq = 1) => JSON.parse((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = ?').bind(seq).first<{ lesson_json: string }>())!.lesson_json).quiz as QuizItem[]
  const allRight = async () => (await stored()).map((q) => q.answer as number | string)

  it('cần đăng nhập, không chấm/lưu gì khi chưa đăng nhập', async () => {
    expect((await call(`/api/sessions/${await sid()}/quiz`, { answers: await allRight() }, false)).status).toBe(401)
    expect((await row()).status).toBe('pending')
  })

  it('đúng hết → 100 điểm, đạt; trả đủ đáp án + giải thích từng câu', async () => {
    const r = await submit(await allRight())
    expect(r.status).toBe(200)
    const { result } = await json(r)
    expect(result).toMatchObject({ score: 100, right: 8, total: 8, passed: true })
    expect(result.items).toHaveLength(8)
    for (const it of result.items) {
      expect(it.correct).toBe(true)
      expect(it.explanation_vi).not.toBe('')
      expect(it.answer_text).not.toBe('')
    }
  })

  it('chấm ở máy chủ: kết quả dựa trên đáp án trong CSDL, không tin gì từ client ngoài câu trả lời', async () => {
    const quiz = await stored()
    const answers = quiz.map((q, i) => (i < 3 ? (q.answer as number | string) : q.type === 'mcq' ? ((q.answer as number) + 1) % 4 : 'wrong'))
    const { result } = await json(await submit(answers))
    expect(result.right).toBe(3)
    expect(result.score).toBe(38)
    expect(result.passed).toBe(false)
    expect(result.items.map((x: any) => x.correct)).toEqual([true, true, true, false, false, false, false, false])
  })

  it('client gửi thêm trường "score"/"correct" giả cũng bị bỏ qua', async () => {
    const r = await call(`/api/sessions/${await sid()}/quiz`, { answers: (await stored()).map(() => null), score: 100, passed: true, correct: [true] })
    expect((await json(r)).result).toMatchObject({ score: 0, passed: false })
    expect((await row()).score).toBe(0)
  })

  it('bỏ trống (null) tính là sai; điền từ không phân biệt hoa thường/dấu câu cuối', async () => {
    const quiz = await stored()
    const answers = quiz.map((q) => (q.type === 'fill' ? ` ${String(q.answer).toUpperCase()}. ` : null))
    const { result } = await json(await submit(answers))
    expect(result.right).toBe(3) // chỉ 3 câu điền từ đúng
    expect(result.items.filter((x: any) => x.type === 'mcq').every((x: any) => x.given === null && !x.correct)).toBe(true)
  })

  it('điểm dưới 70% vẫn là kết quả hợp lệ: chưa đạt nhưng buổi vẫn XONG', async () => {
    const quiz = await stored()
    const { result } = await json(await submit(quiz.map(() => null)))
    expect(result).toMatchObject({ score: 0, passed: false })
    expect(await row()).toMatchObject({ status: 'done', score: 0, completed_date: todayVN() })
  })

  it('lưu kết quả: điểm, ngày xong, trạng thái done, result_json đầy đủ', async () => {
    await submit(await allRight())
    const r = await row()
    expect(r).toMatchObject({ status: 'done', score: 100, completed_date: todayVN() })
    const saved = JSON.parse(r.result_json)
    expect(saved.items).toHaveLength(8)
    expect(saved.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('chỉ nộp được MỘT lần: lần hai → 409, điểm và kết quả giữ nguyên', async () => {
    await submit(await allRight())
    const before = await row()
    const r = await submit((await stored()).map(() => null))
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('done')
    expect(await row()).toEqual(before)
  })

  it('hai lần nộp đồng thời: chỉ một bên được chấm, bên kia nhận 409', async () => {
    const [a, b] = await Promise.all([submit(await allRight()), submit((await stored()).map(() => null))])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const winner = a.status === 200 ? 100 : 0
    expect((await row()).score).toBe(winner)
  })

  describe('câu trả lời không hợp lệ → 400, không chấm, không khóa buổi', () => {
    it.each([
      ['thiếu câu', (a: any[]) => a.slice(1)],
      ['thừa câu', (a: any[]) => [...a, 0]],
      ['rỗng', () => []],
      ['trắc nghiệm ngoài khoảng', (a: any[]) => a.map((x, i) => (i === 0 ? 9 : x))],
      ['trắc nghiệm là chuỗi', (a: any[]) => a.map((x, i) => (i === 0 ? '0' : x))],
      ['điền từ là số', (a: any[]) => a.map((x, i) => (i === 5 ? 0 : x))],
      ['không phải mảng', () => 'abc'],
    ])('%s', async (_n, mutate) => {
      const r = await submit(mutate(await allRight()))
      expect(r.status).toBe(400)
      expect((await json(r)).error).toBe('invalid_answers')
      expect((await row()).status).toBe('pending')
      expect((await submit(await allRight())).status).toBe(200) // vẫn nộp đúng được sau đó
    })
    it('thiếu body / body hỏng', async () => {
      const raw = async (b?: string) => app.request(`/api/sessions/${await sid()}/quiz`, { method: 'POST', headers: { cookie: `ea_session=${await makeToken(SECRET)}` }, body: b }, env)
      expect((await raw()).status).toBe(400)
      expect((await raw('{bad')).status).toBe(400)
      expect((await row()).status).toBe('pending')
    })
  })

  it('buổi không tồn tại → 404; buổi chưa có bài → 409 no_lesson', async () => {
    expect((await call('/api/sessions/99999/quiz', { answers: [] })).status).toBe(404)
    const r = await submit([], 3)
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('no_lesson')
  })

  it('buổi bị lỡ (missed) vẫn nộp quiz được', async () => {
    await db.prepare("UPDATE sessions SET status='missed' WHERE seq=1").run()
    expect((await submit(await allRight())).status).toBe(200)
    expect((await row()).status).toBe('done')
  })

  it('không gọi AI để chấm điểm', async () => {
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    f.mockClear()
    await submit(await allRight())
    expect(f).not.toHaveBeenCalled()
  })

  describe('trước và sau khi nộp', () => {
    it('trước khi nộp: GET buổi không có đáp án, không có kết quả', async () => {
      const { session } = await json(await call(`/api/sessions/${await sid()}`))
      expect(session.result).toBeNull()
      expect(JSON.stringify(session.lesson.quiz)).not.toMatch(/"answer"|"explanation_vi"/)
    })
    it('sau khi nộp: GET buổi trả quiz kèm đáp án + giải thích và kết quả chi tiết (xem lại được)', async () => {
      await submit((await stored()).map(() => null))
      const { session } = await json(await call(`/api/sessions/${await sid()}`))
      expect(session.status).toBe('done')
      expect(session.score).toBe(0)
      expect(session.lesson.quiz[0]).toMatchObject({ answer: expect.anything(), explanation_vi: expect.any(String) })
      expect(session.result.items).toHaveLength(8)
      expect(session.result.items[0]).toHaveProperty('explanation_vi')
    })
    it('sau khi nộp: không chat thêm, không soạn lại, không chọn lại', async () => {
      await submit(await allRight())
      const id = await sid()
      expect((await call(`/api/sessions/${id}/chat`, { message: 'hi' })).status).toBe(409)
      expect((await call(`/api/sessions/${id}/compose`, {})).status).toBe(409)
      expect((await call(`/api/sessions/${id}/choose`, { index: 0 })).status).toBe(409)
    })
    it('buổi khác không bị ảnh hưởng', async () => {
      await submit(await allRight(), 1)
      expect(await row(2)).toMatchObject({ status: 'pending', score: null })
    })
    it('trang lộ trình hiện buổi đã xong kèm điểm', async () => {
      await submit(await allRight())
      const plan = await json(await call('/api/plan'))
      expect(plan.weeks[0].sessions[0]).toMatchObject({ status: 'done', score: 100 })
      expect(plan.plan.done).toBe(1)
    })
  })
})
