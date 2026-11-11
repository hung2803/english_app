import { beforeEach, describe, expect, it } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { BANK } from './placement-bank'
import { gradeAnswers, placeLevel, publicQuestions, validAnswers } from './placement'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
beforeEach(() => {
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, DB: createTestDb() } as Env // DB mới, rỗng cho mỗi test
})

async function call(path: string, init: RequestInit = {}, authed = true) {
  const headers = new Headers(init.headers)
  if (authed) headers.set('cookie', `ea_session=${await makeToken(SECRET)}`)
  if (init.body) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers }, env)
}
const post = (answers: unknown, authed = true) => call('/api/placement/grade', { method: 'POST', body: JSON.stringify({ answers }) }, authed)

describe('câu hỏi gửi cho client', () => {
  it('không lộ đáp án đúng hay mức, ở cả dữ liệu lẫn phản hồi HTTP', async () => {
    const res = await call('/api/placement/questions')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/"answer"|"level"/)
    const { questions } = JSON.parse(text) as { questions: Record<string, unknown>[] }
    expect(questions).toHaveLength(BANK.length)
    for (const q of questions) expect(Object.keys(q).every((k) => ['kind', 'passage', 'question', 'options'].includes(k))).toBe(true)
  })
  it('giữ nguyên thứ tự và nội dung câu hỏi/đáp án', () => {
    publicQuestions().forEach((q, i) => {
      expect(q.question).toBe(BANK[i].question)
      expect(q.options).toEqual(BANK[i].options)
    })
  })
  it('cần đăng nhập', async () => {
    expect((await call('/api/placement/questions', {}, false)).status).toBe(401)
  })
})

/** Bài làm đúng đúng `rightByLevel[mức]` câu của mỗi mức, còn lại sai. */
function answersWith(rightByLevel: Record<string, number>): number[] {
  const used: Record<string, number> = {}
  return BANK.map((q) => {
    used[q.level] = (used[q.level] ?? 0) + 1
    return used[q.level] <= (rightByLevel[q.level] ?? 0) ? q.answer : (q.answer + 1) % 4
  })
}
const levelOf = (r: Record<string, number>) => placeLevel(gradeAnswers(answersWith(r)).perLevel)

describe('xếp mức CEFR', () => {
  it('ngưỡng đạt 60%: A0 cần 3/4, A1 cần 3/5', () => {
    expect(levelOf({ A0: 4, A1: 3 })).toBe('A1')
    expect(levelOf({ A0: 3, A1: 3 })).toBe('A1')
    expect(levelOf({ A0: 2, A1: 5 })).toBe('A0') // A0 2/4 = 50% → trượt
    expect(levelOf({ A0: 4, A1: 2 })).toBe('A0') // A1 2/5 = 40% → trượt
  })
  it('đạt dần từng mức', () => {
    expect(levelOf({ A0: 4, A1: 5, A2: 3 })).toBe('A2')
    expect(levelOf({ A0: 4, A1: 5, A2: 2, B1: 4 })).toBe('A1') // trượt A2 thì B1 không tính
    expect(levelOf({ A0: 4, A1: 5, A2: 5, B1: 3 })).toBe('B1')
    expect(levelOf({ A0: 4, A1: 5, A2: 5, B1: 2 })).toBe('A2')
  })
  it('đoán mò đúng câu khó nhưng trượt câu dễ → vẫn A0', () => {
    expect(levelOf({ A0: 0, A1: 0, A2: 5, B1: 4 })).toBe('A0')
  })
  it('không bỏ sót mức nào: kết quả luôn thuộc A0/A1/A2/B1', () => {
    for (let a = 0; a <= 4; a++)
      for (let b = 0; b <= 5; b++)
        for (let c = 0; c <= 5; c++)
          for (let d = 0; d <= 4; d++) expect(['A0', 'A1', 'A2', 'B1']).toContain(levelOf({ A0: a, A1: b, A2: c, B1: d }))
  })
  it('điểm cao hơn không bao giờ cho mức thấp hơn (đơn điệu)', () => {
    const order = ['A0', 'A1', 'A2', 'B1']
    for (let a = 0; a <= 4; a++)
      for (let b = 0; b <= 5; b++)
        for (let c = 0; c <= 5; c++)
          for (let d = 0; d <= 4; d++) {
            const base = order.indexOf(levelOf({ A0: a, A1: b, A2: c, B1: d }))
            if (a < 4) expect(order.indexOf(levelOf({ A0: a + 1, A1: b, A2: c, B1: d }))).toBeGreaterThanOrEqual(base)
            if (b < 5) expect(order.indexOf(levelOf({ A0: a, A1: b + 1, A2: c, B1: d }))).toBeGreaterThanOrEqual(base)
            if (c < 5) expect(order.indexOf(levelOf({ A0: a, A1: b, A2: c + 1, B1: d }))).toBeGreaterThanOrEqual(base)
            if (d < 4) expect(order.indexOf(levelOf({ A0: a, A1: b, A2: c, B1: d + 1 }))).toBeGreaterThanOrEqual(base)
          }
  })
})

describe('chấm điểm phía server', () => {
  const correct = BANK.map((q) => q.answer)

  it('đúng hết → điểm tối đa, mức B1', async () => {
    expect(await (await post(correct)).json()).toEqual({ score: BANK.length, total: BANK.length, level: 'B1', taken_at: todayVN() })
  })
  it('sai hết → 0 điểm, mức A0', async () => {
    expect(await (await post(correct.map((a) => (a + 1) % 4))).json()).toEqual({ score: 0, total: BANK.length, level: 'A0', taken_at: todayVN() })
  })
  it('đúng một nửa số câu đầu', async () => {
    const half = correct.map((a, i) => (i < 9 ? a : (a + 1) % 4))
    expect((await (await post(half)).json()) as { score: number }).toMatchObject({ score: 9 })
  })
  it('phản hồi chỉ có điểm, tổng và mức; không lộ đáp án từng câu hay thống kê theo mức', async () => {
    const body = await (await post(correct)).json()
    expect(Object.keys(body as object).sort()).toEqual(['level', 'score', 'taken_at', 'total'])
  })
  it('thống kê theo mức dùng nội bộ cộng đúng', () => {
    const t = gradeAnswers(correct).perLevel
    expect(t.A0.right + t.A1.right + t.A2.right + t.B1.right).toBe(BANK.length)
    expect(t.A0.total).toBe(BANK.filter((q) => q.level === 'A0').length)
  })
  it('thiếu câu, thừa câu, sai kiểu, ngoài khoảng → 400', async () => {
    const bad: unknown[] = [
      [],
      correct.slice(1),
      [...correct, 0],
      correct.map(() => 4),
      correct.map(() => -1),
      correct.map(() => 1.5),
      correct.map(() => '1'),
      correct.map((a, i) => (i === 0 ? null : a)),
      'abc',
      null,
    ]
    for (const b of bad) expect((await post(b)).status).toBe(400)
  })
  it('không có body / body hỏng → 400', async () => {
    expect((await call('/api/placement/grade', { method: 'POST' })).status).toBe(400)
    expect((await call('/api/placement/grade', { method: 'POST', body: '{bad' })).status).toBe(400)
  })
  it('chưa đăng nhập → 401', async () => {
    expect((await post(correct, false)).status).toBe(401)
  })
  it('validAnswers kiểm tra đúng', () => {
    expect(validAnswers(correct)).toBe(true)
    expect(validAnswers(correct.slice(1))).toBe(false)
  })
})
