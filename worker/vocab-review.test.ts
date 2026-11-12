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
    expect(session.review).toEqual({ required: true, passed: false, total: 5, stage: 1, stages: 3, round: 0 })
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

describe('giai đoạn 1 — trắc nghiệm', () => {
  it('mỗi từ một câu, 4 lựa chọn khác nhau có đáp án đúng, hai chiều Anh–Việt / Việt–Anh, không lộ đáp án', async () => {
    await seedDoneFirstLesson()
    const { questions, status } = await get(await sid(2))
    expect(status).toMatchObject({ total: 5, stage: 1 })
    expect(questions).toHaveLength(5)
    expect(new Set(questions.map((q: any) => q.word)).size).toBe(5)
    for (const q of questions) {
      expect(q.kind).toBe('mcq')
      expect(q.options).toHaveLength(4)
      expect(new Set(q.options).size).toBe(4)
      expect(q.options).toContain(q.dir === 'en_vi' ? MEANING[q.word] : q.word)
      expect(q.prompt).toBe(q.dir === 'en_vi' ? q.word : MEANING[q.word])
    }
    expect(new Set(questions.map((q: any) => q.dir))).toEqual(new Set(['en_vi', 'vi_en']))
    expect(JSON.stringify(questions)).not.toContain('"answer"')
  })

  it('sai 1 từ: ở lại giai đoạn 1 và lượt sau hỏi LẠI TẤT CẢ các từ (làm lại từ đầu)', async () => {
    await seedDoneFirstLesson()
    const id = await sid(2)
    let { questions } = await get(id)
    const r = await post(id, answer(questions, [questions[0].word]))
    expect(r).toMatchObject({ passed: false, cleared: false, stage: 1, next_stage: 1, round: 1 })
    expect(r.results.filter((x: any) => !x.correct)).toHaveLength(1)
    expect(r.results.every((x: any) => typeof x.meaning === 'string')).toBe(true) // hé lộ nghĩa để học
    ;({ questions } = await get(id))
    expect(questions).toHaveLength(5) // KHÔNG chỉ riêng từ sai
    expect((await call(`/api/sessions/${id}/materials`, {})).status).toBe(409) // vẫn bị chặn
  })

  it('trả kèm danh sách từ đầy đủ để xem lại (từ, nghĩa, loại từ, câu ví dụ) và kết quả mỗi lượt cũng đầy đủ', async () => {
    await seedDoneFirstLesson([{ word: 'order', pos: 'verb', meaning_vi: 'gọi món', example: 'I would like to order a pizza.' }, ...VOCAB.slice(1)] as any)
    const id = await sid(2)
    const { study, questions } = await get(id)
    expect(study).toHaveLength(5)
    expect(study[0]).toEqual({ word: 'order', pos: 'verb', meaning: 'gọi món', example: 'I would like to order a pizza.' })
    expect(study[3]).toEqual({ word: 'waiter', meaning: 'bồi bàn' }) // không ví dụ/loại từ thì bỏ trường
    const r = await post(id, answer(questions))
    expect(r.results.find((x: any) => x.word === 'order')).toMatchObject({ pos: 'verb', meaning: 'gọi món', example: 'I would like to order a pizza.', correct: true })
  })

  it('hướng hỏi do máy chủ quyết định: gửi sai "dir" không giúp đúng', async () => {
    await seedDoneFirstLesson()
    const id = await sid(2)
    const { questions } = await get(id)
    // với câu hỏi nghĩa-của-từ (en_vi), "đáp án" là chính từ ở đề bài (vi_en giả) — phải bị tính sai
    const cheat = questions.map((q: any) => (q.dir === 'en_vi' ? { word: q.word, dir: 'vi_en', choice: q.word } : { word: q.word, dir: 'vi_en', choice: q.word }))
    const r = await post(id, cheat)
    expect(r.cleared).toBe(false)
  })

  it('bỏ trống hoặc thiếu câu trả lời tính là sai', async () => {
    await seedDoneFirstLesson()
    const id = await sid(2)
    const { questions } = await get(id)
    expect((await post(id, answer(questions).slice(0, 3))).cleared).toBe(false)
    expect((await post(id, [])).cleared).toBe(false)
  })

  it('bài trước ít từ (3 từ): vẫn đủ 4 lựa chọn nhờ bổ sung từ kho chung', async () => {
    await seedDoneFirstLesson([{ word: 'cat', meaning_vi: 'mèo' }, { word: 'dog', meaning_vi: 'chó' }, { word: 'bird', meaning_vi: 'chim' }])
    for (const [w, m] of [['fish', 'cá'], ['cow', 'bò'], ['pig', 'lợn']]) await db.prepare("INSERT INTO vocab (word, meaning, due_date, created_at) VALUES (?, ?, 'x', 'x')").bind(w, m).run()
    const { questions } = await get(await sid(2))
    expect(questions).toHaveLength(3)
    expect(questions.every((q: any) => q.options.length === 4)).toBe(true)
  })
})

describe('3 giai đoạn nối tiếp', () => {
  it('đúng 100% giai đoạn 1 → sang 2 (gõ từ) → sang 3 (điền câu) → đạt; sai ở giữa thì làm lại giai đoạn đó từ đầu', async () => {
    await seedDoneFirstLesson()
    const id = await sid(2)

    // giai đoạn 1
    let { questions } = await get(id)
    let r = await post(id, answer(questions))
    expect(r).toMatchObject({ passed: false, cleared: true, stage: 1, next_stage: 2 })
    expect((await json(await call(`/api/sessions/${id}`))).session.review).toMatchObject({ stage: 2, passed: false })

    // giai đoạn 2: gõ từ từ nghĩa tiếng Việt
    ;({ questions } = await get(id))
    expect(questions).toHaveLength(5)
    for (const q of questions) {
      expect(q.kind).toBe('type')
      expect(q.prompt).toBe(MEANING[q.word])
      expect(q.hint).toBeUndefined() // đề đã là nghĩa tiếng Việt; không gợi ý chữ cái của từ
      expect(q.options).toBeUndefined()
    }
    r = await post(id, answer(questions, ['menu'])) // sai 1 từ
    expect(r).toMatchObject({ cleared: false, stage: 2, next_stage: 2 })
    ;({ questions } = await get(id))
    expect(questions).toHaveLength(5) // làm lại cả 5 từ
    // gõ không phân biệt hoa thường và khoảng trắng thừa
    r = await post(id, answer(questions).map((a) => ({ ...a, choice: `  ${a.choice.toUpperCase()} ` })))
    expect(r).toMatchObject({ cleared: true, stage: 2, next_stage: 3, passed: false })

    // giai đoạn 3: điền vào câu
    ;({ questions } = await get(id))
    const byWord = Object.fromEntries(questions.map((q: any) => [q.word, q]))
    expect(byWord.order.kind).toBe('cloze')
    expect(byWord.order.prompt).toBe('I would like to _____ a pizza.')
    expect(byWord.order.hint).toBe('gọi món') // chỉ gợi ý tiếng Việt, không có chữ cái đầu của từ
    expect(byWord.waiter.hint).toBeUndefined()
    expect(questions.every((q: any) => !(q.hint ?? '').includes('_'))).toBe(true) // gợi ý không có chữ cái của từ
    expect(byWord.bill.kind).toBe('cloze') // "bills" trong câu
    expect(byWord.bill.prompt).toBe('Could we have the _____, please?')
    expect(byWord.waiter.kind).toBe('type') // không có ví dụ → gõ từ
    expect(byWord.tip.kind).toBe('type') // ví dụ không chứa từ → gõ từ
    expect(JSON.stringify(questions)).not.toMatch(/"(answer|accept)"/)

    // cloze chấp nhận cả dạng gốc lẫn dạng trong câu ("bill" và "bills")
    for (const choice of ['bill', 'bills']) {
      const a = answer(questions).map((x) => (x.word === 'bill' ? { ...x, choice } : x))
      const res = await post(id, a)
      expect(res.cleared).toBe(true)
      if (choice === 'bill') {
        expect(res).toMatchObject({ passed: true, stage: 3 })
        break
      }
    }
    expect((await json(await call(`/api/sessions/${id}`))).session.review).toMatchObject({ required: true, passed: true })
    expect((await call(`/api/sessions/${id}/materials`, {})).status).not.toBe(409) // đã mở khóa
    expect((await call(`/api/sessions/${id}/vocab-review`)).status).toBe(409) // ôn xong rồi
  })

  it('sai ở giai đoạn 3 → ở lại giai đoạn 3, không bị đẩy về giai đoạn 1; chưa mở khóa', async () => {
    await seedDoneFirstLesson()
    const id = await sid(2)
    await db.prepare('UPDATE sessions SET vocab_review_json = ? WHERE seq = 2').bind('{"passed":false,"stage":3,"round":4}').run()
    const { questions } = await get(id)
    const r = await post(id, answer(questions, ['order']))
    expect(r).toMatchObject({ passed: false, cleared: false, stage: 3, next_stage: 3, round: 5 })
    expect((await call(`/api/sessions/${id}/materials`, {})).status).toBe(409)
  })
})
