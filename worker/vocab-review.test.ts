import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { createTestDb } from './test-db'
import { lessonJson } from './test-fixtures'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret-xx'
let env: Env
let db: D1Database

async function call(path: string, body?: unknown) {
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id

type V = { word: string; meaning_vi: string; example?: string }
const VOCAB: V[] = [
  { word: 'order', meaning_vi: 'gọi món', example: 'I would like to order a pizza.' },
  { word: 'menu', meaning_vi: 'thực đơn', example: 'Can I see the menu, please?' },
  { word: 'bill', meaning_vi: 'hóa đơn', example: 'Could we have the bills, please?' }, // dạng biến đổi "bills"
  { word: 'waiter', meaning_vi: 'bồi bàn' }, // không có ví dụ → giai đoạn 3 hỏi dạng gõ từ
  { word: 'tip', meaning_vi: 'tiền boa', example: 'Leave a big smile.' }, // ví dụ không chứa từ → dạng gõ từ
]
const MEANING = Object.fromEntries(VOCAB.map((v) => [v.word, v.meaning_vi]))

/** Buổi 1 đã xong với bài có từ vựng; buổi 2 là buổi kế tiếp. */
async function seedDoneFirstLesson(vocab: V[] = VOCAB) {
  await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=?, lesson_json=? WHERE seq=1").bind(todayVN(), JSON.stringify(lessonJson({ vocab }))).run()
  for (const v of vocab) await db.prepare('INSERT OR IGNORE INTO vocab(word,meaning,example,due_date,created_at) VALUES (?,?,?,?,?)').bind(v.word,v.meaning_vi,v.example ?? null,todayVN(),todayVN()).run()
}

/** Trả lời đúng mọi câu, trừ các từ trong `wrongWords` (cố tình sai). */
function answer(questions: any[], wrongWords: string[] = []) {
  return questions.map((q) => {
    let right: string
    if (q.kind === 'mcq') right = q.dir === 'en_vi' ? MEANING[q.word] : q.word
    else right = q.word
    const choice = wrongWords.includes(q.word) ? (q.kind === 'mcq' ? q.options.find((o: string) => o !== right) : 'zzz') : right
    return { word: q.word, dir: q.dir, choice }
  })
}
const get = async (id: number) => json(await call(`/api/sessions/${id}/vocab-review`))
const post = async (id: number, answers: unknown) => json(await call(`/api/sessions/${id}/vocab-review`, { answers }))

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

describe('ôn từ vựng bài trước — bắt buộc', () => {
  it('buổi 1 (chưa có bài trước) không cần ôn; buổi 2 sau khi xong buổi 1 thì bắt buộc, bắt đầu ở giai đoạn 1/3', async () => {
    expect((await json(await call(`/api/sessions/${await sid(1)}`))).session.review.required).toBe(false)
    await seedDoneFirstLesson()
    const { session } = await json(await call(`/api/sessions/${await sid(2)}`))
    expect(session.review).toEqual({ required: true, passed: false, total: 5, stage: 1, stages: 1, round: 0 })
  })

  it('chưa ôn: không bắt đầu được buổi 2 (409, không gọi AI, không lưu gì)', async () => {
    await seedDoneFirstLesson()
    const f = vi.fn(async () => new Response('', { status: 429 }))
    vi.stubGlobal('fetch', f)
    const r = await call(`/api/sessions/${await sid(2)}/materials`, {})
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('review_required')
    expect(f).not.toHaveBeenCalled()
    expect((await db.prepare('SELECT material_json FROM sessions WHERE seq = 2').first<any>()).material_json).toBeNull()
  })

  it('đáp án sai kiểu/định dạng → 400; buổi 1 → 409 không cần ôn; không có buổi → 404', async () => {
    await seedDoneFirstLesson()
    expect((await call(`/api/sessions/${await sid(2)}/vocab-review`, { answers: 'x' })).status).toBe(400)
    expect((await call(`/api/sessions/${await sid(2)}/vocab-review`, { answers: [{ word: 1 }] })).status).toBe(400)
    expect((await call(`/api/sessions/${await sid(1)}/vocab-review`)).status).toBe(409)
    expect((await call('/api/sessions/99999/vocab-review')).status).toBe(404)
  })

  it('bài trước không có từ vựng hợp lệ → không bắt ôn', async () => {
    await seedDoneFirstLesson([])
    expect((await json(await call(`/api/sessions/${await sid(2)}`))).session.review.required).toBe(false)
  })

  it('trạng thái dạng cũ (passed: true) vẫn được coi là đã ôn xong', async () => {
    await seedDoneFirstLesson()
    await db.prepare('UPDATE sessions SET vocab_review_json = ? WHERE seq = 2').bind('{"passed":true,"remaining":[],"round":1}').run()
    expect((await json(await call(`/api/sessions/${await sid(2)}`))).session.review).toMatchObject({ required: true, passed: true })
  })
})


describe('mixed review', () => {
 it('mixes question types and never returns a study sheet before answering', async () => {
  await seedDoneFirstLesson(); const r = await get(await sid(2));
  expect(new Set(r.questions.map((q:any)=>q.kind))).toEqual(new Set(['mcq']));
  expect(r.study).toEqual([]);
  expect(JSON.stringify(r.questions)).not.toMatch(/"(answer|accept)"/);
 });
 it('retries only wrong words once, then opens the next lesson without claiming mastery',async()=>{
  await seedDoneFirstLesson(); const id=await sid(2);const first=await get(id);
  const wrong=first.questions[0].word;
  const r=await post(id,answer(first.questions,[wrong]));expect(r.passed).toBe(false);
  const retry=await get(id);expect(retry.questions.map((q:any)=>q.word)).toEqual([wrong]);
  const final=await post(id,answer(retry.questions,[wrong]));expect(final.passed).toBe(true);expect(final.cleared).toBe(false);
  expect((await json(await call('/api/sessions/'+id))).session.review.passed).toBe(true);
 });
 it('correct first attempt completes immediately and accepts normalized answers',async()=>{
  await seedDoneFirstLesson();const id=await sid(2); const r=await get(id);
  expect((await post(id,answer(r.questions).map(a=>({...a,choice:' '+a.choice.toUpperCase()+' '})))).passed).toBe(true);
 });
 it('checking one question returns feedback without advancing or saving progress',async()=>{
  await seedDoneFirstLesson();const id=await sid(2);const r=await get(id);
  const checked=await json(await call('/api/sessions/'+id+'/vocab-review/check',{answers:answer([r.questions[0]])}));
  expect(checked.results).toHaveLength(1);expect(checked.results[0].correct).toBe(true);
  expect((await get(id)).status.round).toBe(0);
  expect((await db.prepare('SELECT vocab_review_json FROM sessions WHERE id=?').bind(id).first<any>()).vocab_review_json).toBeNull();
 });
 it('records wrong words for later spaced review',async()=>{
  await seedDoneFirstLesson();const id=await sid(2);
  await db.prepare("UPDATE vocab SET learned=1,typed_streak=3 WHERE word='order'").run();
  const r=await get(id);await post(id,answer(r.questions,['order']));
  expect(await db.prepare("SELECT due_date, learned, typed_streak,lapses FROM vocab WHERE word='order'").first()).toMatchObject({due_date:todayVN(),learned:0,typed_streak:0,lapses:1});
 });
 it('merges due words with recent words up to ten, with no duplicates',async()=>{
  await seedDoneFirstLesson();for(let i=0;i<12;i++) await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at) VALUES (?,?,'2000-01-01','x')").bind('extra'+i,'meaning'+i).run();
  const r=await get(await sid(2));expect(r.questions).toHaveLength(10);expect(new Set(r.questions.map((q:any)=>q.word)).size).toBe(10);
 });
});
