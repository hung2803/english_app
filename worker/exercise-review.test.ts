import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { createTestDb } from './test-db'
import { lessonJson, QUIZ8 } from './test-fixtures'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret-xx'
let env: Env
let db: D1Database

async function call(path: string, body?: unknown) {
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const row = async (seq: number) => (await db.prepare('SELECT status, score, first_score, quiz_mastered, quiz_retry_json FROM sessions WHERE seq = ?').bind(seq).first<any>())!

/** Đáp án của quiz gốc; các câu có chỉ số trong `wrong` thì cố tình sai. */
const quizAnswers = (wrong: number[] = []) =>
  QUIZ8.map((q, i) => (q.type === 'mcq' ? (wrong.includes(i) ? ((q.answer as number) + 1) % 4 : q.answer) : wrong.includes(i) ? 'zzz' : q.answer))

/** Buổi 1 có bài (đủ quiz); nộp quiz qua API với các câu sai chỉ định. */
async function finishFirst(wrong: number[]) {
  await db.prepare('UPDATE sessions SET lesson_json = ? WHERE seq = 1').bind(JSON.stringify(lessonJson())).run()
  const r = await call(`/api/sessions/${await sid(1)}/quiz`, { answers: quizAnswers(wrong) })
  expect(r.status).toBe(200)
}

/** Trả lời các câu đang hỏi: đúng hết, trừ các chỉ số trong `wrong`. */
const answerRound = (questions: any[], wrong: number[] = []) =>
  questions.map((q) => {
    const item = QUIZ8[q.index]
    const right = item.type === 'mcq' ? (item.options as string[])[item.answer as number] : (item.answer as string)
    const bad = item.type === 'mcq' ? (item.options as string[]).find((o) => o !== right)! : 'zzz'
    return { index: q.index, choice: wrong.includes(q.index) ? bad : right }
  })
const get = async (id: number) => json(await call(`/api/sessions/${id}/exercise-review`))
const post = async (id: number, answers: unknown) => json(await call(`/api/sessions/${id}/exercise-review`, { answers }))

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

describe('bài tập buổi trước phải đạt 100% mới mở buổi sau', () => {
  it('nộp quiz: đúng hết → quiz_mastered = 1; còn sai → 0 (buổi vẫn xong, điểm gốc giữ nguyên)', async () => {
    await finishFirst([])
    expect(await row(1)).toMatchObject({ status: 'done', score: 100, quiz_mastered: 1 })
    expect((await json(await call(`/api/sessions/${await sid(2)}`))).session.exercise.required).toBe(false)
  })

  it('còn câu sai: buổi 2 bắt buộc làm lại, không bắt đầu được (409 exercise_required, không gọi AI)', async () => {
    await finishFirst([1, 5])
    expect(await row(1)).toMatchObject({ status: 'done', score: 75, quiz_mastered: 0 })
    const { session } = await json(await call(`/api/sessions/${await sid(2)}`))
    expect(session.exercise).toEqual({ required: true, prev_seq: 1, remaining: 2, round: 0 })

    const f = vi.fn(async () => new Response('', { status: 429 }))
    vi.stubGlobal('fetch', f)
    const r = await call(`/api/sessions/${await sid(2)}/materials`, {})
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('exercise_required')
    expect(f).not.toHaveBeenCalled()
  })

  it('câu hỏi: chỉ các câu sai, lựa chọn xáo lại, không lộ đáp án/giải thích', async () => {
    await finishFirst([1, 5])
    const { questions, status } = await get(await sid(2))
    expect(status).toMatchObject({ required: true, remaining: 2 })
    expect(questions.map((q: any) => q.index)).toEqual([1, 5])
    expect([...questions[0].options].sort()).toEqual([...(QUIZ8[1].options as string[])].sort())
    expect(questions[1].options).toBeUndefined() // câu điền từ
    expect(JSON.stringify(questions)).not.toMatch(/"answer|explanation_vi|"word"/)
  })

  it('kèm "đầu bài": bài đọc, tóm tắt, từ vựng, ngữ pháp của buổi trước (không có quiz hay đáp án)', async () => {
    await finishFirst([1, 5])
    const { material } = await get(await sid(2))
    expect(material).toMatchObject({ seq: 1, title: 'Ordering food and drinks', summary_vi: 'Bài nói về cách gọi đồ ăn thức uống.' })
    expect(material.reading).toContain('The waiter is friendly and fast') // bài đọc người học đã thấy
    expect(material.vocab.map((v: any) => v.word)).toEqual(['order', 'menu', 'bill', 'waiter', 'tip'])
    expect(material.grammar[0]).toMatchObject({ point: 'Can I have ...?' })
    expect(JSON.stringify(material)).not.toMatch(/"quiz"|"answer"|explanation_vi":"The bill|"options"/)
  })
  it('one correction round opens the next lesson and preserves scores when answers are still wrong', async () => {
    await finishFirst([1,5]); const id=await sid(2);const {questions}=await get(id);
    const r=await post(id,answerRound(questions,[5]));
    expect(r).toMatchObject({passed:true,remaining:1,round:1});
    expect(await row(1)).toMatchObject({score:75,first_score:null,quiz_mastered:0});
    expect(r.results.find((x:any)=>x.index===5)).toMatchObject({correct:false,answer_text:QUIZ8[5].answer});
    expect((await json(await call('/api/sessions/'+id))).session.exercise.required).toBe(false);
    expect((await call('/api/sessions/'+id+'/exercise-review')).status).toBe(409);
  })
  it('a fully correct correction round records mastery and retains the original score',async()=>{
    await finishFirst([1,5]);const id=await sid(2);const {questions}=await get(id);
    expect((await post(id,answerRound(questions))).passed).toBe(true);
    expect(await row(1)).toMatchObject({score:100,first_score:75,quiz_mastered:1});
  })

  it('lựa chọn lạ (không có trong đề) và bỏ trống tính là sai', async () => {
    await finishFirst([1])
    const id = await sid(2)
    expect((await post(id, [{ index: 1, choice: 'unknown' }])).results[0].correct).toBe(false)
    expect((await call('/api/sessions/'+id+'/exercise-review')).status).toBe(409)
  })

  it('đáp án sai kiểu → 400; buổi không bị chặn → 409; không có buổi → 404', async () => {
    await finishFirst([1])
    expect((await call(`/api/sessions/${await sid(2)}/exercise-review`, { answers: 'x' })).status).toBe(400)
    expect((await call(`/api/sessions/${await sid(2)}/exercise-review`, { answers: [{ index: 'a', choice: 1 }] })).status).toBe(400)
    expect((await call(`/api/sessions/${await sid(1)}/exercise-review`)).status).toBe(409)
    expect((await call('/api/sessions/99999/exercise-review')).status).toBe(404)
  })

  it('buổi cũ / đánh dấu xong bằng tay (quiz_mastered NULL) không bị chặn', async () => {
    await db.prepare("UPDATE sessions SET status='done', score=40, completed_date=?, lesson_json=? WHERE seq=1").bind(todayVN(), JSON.stringify(lessonJson())).run()
    expect((await json(await call(`/api/sessions/${await sid(2)}`))).session.exercise.required).toBe(false)
  })
})
