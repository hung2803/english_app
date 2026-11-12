import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, todayVN } from './dates'
import { composeSession } from './session-store'
import { lessonJson } from './test-fixtures'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database
const TODAY = todayVN()
const TOMORROW = addDays(TODAY, 1)

const A = { type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }
const B = { type: 'article', title: 'B', url: 'https://example.com/b', why_vi: 'b', excerpt: 'b' }
const C = { type: 'article', title: 'C', url: 'https://example.com/c', why_vi: 'c', excerpt: 'c' }
const D = { type: 'article', title: 'D', url: 'https://example.com/d', why_vi: 'd', excerpt: 'd' }
const PAGE = '<html><head><title>L</title></head><body>' + '<p>Can I have a coffee please? Yes of course. </p>'.repeat(40) + '</body></html>'

let lesson: unknown
let lessonStatus: number
function stubAi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('generativelanguage')) {
        const isSearch = Boolean(JSON.parse(init?.body as string).tools)
        if (!isSearch && lessonStatus !== 200) return new Response('', { status: lessonStatus })
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(isSearch ? { options: [A, B, C, D] } : lesson) }] } }] })
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    }),
  )
}

beforeEach(async () => {
  lesson = lessonJson()
  lessonStatus = 200
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(TODAY).run()
  expect((await call('/api/plan', {})).status).toBe(200)
  stubAi()
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown) {
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
/** Bắt đầu → chọn tài liệu đầu → soạn bài cho buổi `seq` (các buổi trước phải đã xong) */
async function compose(seq = 1) {
  expect((await call(`/api/sessions/${await sid(seq)}/materials`, {})).status).toBe(200)
  expect((await call(`/api/sessions/${await sid(seq)}/choose`, { index: 0 })).status).toBe(200)
  return call(`/api/sessions/${await sid(seq)}/compose`, {})
}
const finish = async (seq: number) => {
  await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=?").bind(TODAY, seq).run()
  // buổi kế tiếp đã ôn từ vựng bài trước (cổng ôn từ vựng không phải trọng tâm của các test này)
  await db.prepare('UPDATE sessions SET vocab_review_json = ? WHERE seq = ?').bind('{"passed":true,"remaining":[],"round":1}', seq + 1).run()
}
const vocab = async () => (await db.prepare('SELECT * FROM vocab ORDER BY id').all<any>()).results
const words = async () => (await vocab()).map((v) => v.word)

describe('soạn bài → từ vựng tự vào kho flashcard', () => {
  it('chưa soạn bài thì kho trống (tìm tài liệu / chọn tài liệu chưa nạp gì)', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })
    expect(await vocab()).toEqual([])
  })

  it('soạn xong: toàn bộ từ vựng của bài vào kho, đúng thứ tự', async () => {
    expect((await compose()).status).toBe(200)
    expect(await words()).toEqual(['order', 'menu', 'bill', 'waiter', 'tip'])
  })

  it('mỗi từ lưu đủ: loại từ, nghĩa tiếng Việt, ví dụ, buổi nguồn, ngày tạo', async () => {
    await compose()
    const [first] = await vocab()
    expect(first).toMatchObject({ word: 'order', pos: 'verb', meaning: 'gọi món', example: 'I want to order a pizza.', session_id: await sid(1), created_at: TODAY })
  })

  it('trạng thái ôn ban đầu: chưa học, độ dễ mặc định, KHÔNG tính là đã thuộc, chưa sai lần nào', async () => {
    await compose()
    for (const v of await vocab()) expect(v).toMatchObject({ interval_days: 0, ease: 2.5, reps: 0, learned: 0, wrong_count: 0 })
  })

  it('lần ôn đầu hẹn vào NGÀY MAI (vừa học hôm nay), chưa đến hạn hôm nay', async () => {
    await compose()
    for (const v of await vocab()) expect(v.due_date).toBe(TOMORROW)
    const dueToday = (await db.prepare('SELECT COUNT(*) n FROM vocab WHERE due_date <= ?').bind(TODAY).first<any>()).n
    expect(dueToday).toBe(0)
    const dueTomorrow = (await db.prepare('SELECT COUNT(*) n FROM vocab WHERE due_date <= ?').bind(TOMORROW).first<any>()).n
    expect(dueTomorrow).toBe(5)
  })

  it('từ có loại từ/ví dụ để trống thì lưu NULL, không lỗi', async () => {
    lesson = lessonJson({ vocab: [{ word: 'alpha', meaning_vi: 'a' }, { word: 'beta', meaning_vi: 'b' }, { word: 'gamma', meaning_vi: 'c' }, { word: 'delta', meaning_vi: 'd' }] })
    await compose()
    expect((await vocab())[0]).toMatchObject({ word: 'alpha', pos: null, example: null })
  })

  it('giữ nguyên ký tự đặc biệt: nháy, gạch nối, cụm nhiều từ, có dấu', async () => {
    lesson = lessonJson({ vocab: [
      { word: "don't", meaning_vi: 'không' }, { word: 'ice-cream', meaning_vi: 'kem' }, { word: 'look forward to', meaning_vi: 'mong đợi' }, { word: 'café', meaning_vi: 'quán cà phê' },
    ] })
    await compose()
    expect(await words()).toEqual(["don't", 'ice-cream', 'look forward to', 'café'])
  })

  it('bài do AI tự viết (fallback) cũng nạp từ vựng', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('generativelanguage')) {
        const isSearch = Boolean(JSON.parse(init?.body as string).tools)
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(isSearch ? { options: [] } : lesson) }] } }] })
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    }))
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    expect((await call(`/api/sessions/${await sid(1)}/compose`, {})).status).toBe(200)
    expect(await words()).toHaveLength(5)
  })
})

describe('không trùng', () => {
  it('soạn lại cùng buổi (gọi lần 2): trả bài cũ, kho không thêm dòng nào', async () => {
    await compose()
    await call(`/api/sessions/${await sid(1)}/compose`, {})
    await call(`/api/sessions/${await sid(1)}/compose`, {})
    expect(await vocab()).toHaveLength(5)
  })

  it('từ đã có từ buổi trước (cùng chữ): không thêm bản trùng, giữ nguyên dòng cũ và tiến độ ôn', async () => {
    await compose(1)
    await db.prepare("UPDATE vocab SET interval_days = 12, reps = 4, learned = 0, ease = 2.2, wrong_count = 2, due_date = ? WHERE word = 'menu'").bind(addDays(TODAY, 12)).run()
    await finish(1)
    lesson = lessonJson({ title: 'Buổi hai', vocab: [
      { word: 'menu', meaning_vi: 'NGHĨA MỚI', example: 'New example.' }, { word: 'ticket', meaning_vi: 'vé' }, { word: 'seat', meaning_vi: 'ghế' }, { word: 'queue', meaning_vi: 'hàng' },
    ] })
    await compose(2)
    expect(await words()).toEqual(['order', 'menu', 'bill', 'waiter', 'tip', 'ticket', 'seat', 'queue']) // menu không lặp
    expect(await vocab()).toHaveLength(8)
    expect((await db.prepare("SELECT * FROM vocab WHERE word = 'menu'").first<any>())).toMatchObject({
      meaning: 'thực đơn', session_id: await sid(1), interval_days: 12, reps: 4, ease: 2.2, wrong_count: 2, due_date: addDays(TODAY, 12),
    })
  })

  it('không phân biệt hoa thường: "Order" ở buổi sau không thêm khi đã có "order"', async () => {
    await compose(1)
    await finish(1)
    lesson = lessonJson({ vocab: [{ word: 'Order', meaning_vi: 'x' }, { word: 'MENU', meaning_vi: 'y' }, { word: 'newword', meaning_vi: 'z' }, { word: 'another', meaning_vi: 'w' }] })
    await compose(2)
    expect(await vocab()).toHaveLength(7)
    expect((await words()).filter((w) => w.toLowerCase() === 'order')).toEqual(['order'])
  })

  it('từ đã có trong kho từ trước (vd nạp qua quiz) không bị ghi đè khi soạn bài', async () => {
    await db.prepare("INSERT INTO vocab (word, meaning, due_date, interval_days, reps, learned, created_at) VALUES ('bill', 'giữ nguyên', ?, 30, 6, 1, '2026-01-01')").bind(addDays(TODAY, 30)).run()
    await compose()
    expect((await db.prepare("SELECT * FROM vocab WHERE word = 'bill'").first<any>())).toMatchObject({ meaning: 'giữ nguyên', learned: 1, interval_days: 30, reps: 6, created_at: '2026-01-01' })
    expect(await vocab()).toHaveLength(5)
  })

  it('hai yêu cầu soạn bài đồng thời: kho vẫn không trùng, đủ 5 từ', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })
    await Promise.all([call(`/api/sessions/${await sid(1)}/compose`, {}), call(`/api/sessions/${await sid(1)}/compose`, {})])
    expect(await vocab()).toHaveLength(5)
    expect(new Set((await words()).map((w) => w.toLowerCase())).size).toBe(5)
  })

  it('ràng buộc CSDL: không thể có hai từ giống nhau (không phân biệt hoa thường)', async () => {
    await db.prepare("INSERT INTO vocab (word, meaning, due_date, created_at) VALUES ('Apple', 'a', 'x', 'x')").run()
    await expect(db.prepare("INSERT INTO vocab (word, meaning, due_date, created_at) VALUES ('apple', 'b', 'x', 'x')").run()).rejects.toThrow()
  })
})

describe('chỉ nạp khi soạn bài thành công', () => {
  it('AI lỗi (429) khi soạn bài: không nạp từ nào, thử lại được và lúc đó mới nạp', async () => {
    lessonStatus = 429
    expect((await compose()).status).toBe(503)
    expect(await vocab()).toEqual([])
    lessonStatus = 200
    expect((await call(`/api/sessions/${await sid(1)}/compose`, {})).status).toBe(200)
    expect(await vocab()).toHaveLength(5)
  })

  it('bài AI trả không hợp lệ (thiếu quiz): không lưu bài, không nạp từ', async () => {
    lesson = lessonJson({ quiz: [] })
    expect((await compose()).status).toBe(503)
    expect(await vocab()).toEqual([])
    expect((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<any>()).lesson_json).toBeNull()
  })

  it('lỗi giữa chừng khi ghi: giao dịch quay lui — không có bài, không có từ nào', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })
    const real = db
    const broken = Object.assign(Object.create(real), {
      batch: async (stmts: D1PreparedStatement[]) => real.batch([...stmts, real.prepare("INSERT INTO vocab (word, meaning, due_date, created_at) VALUES ('tip', 'dup', 'x', 'x')")]),
    }) as D1Database
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(composeSession({ ...env, DB: broken } as Env, await sid(1))).rejects.toThrow()
    expect(await vocab()).toEqual([])
    expect((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<any>()).lesson_json).toBeNull()
  })

  it('buổi chưa chọn tài liệu / đã xong: soạn bị từ chối và không nạp gì', async () => {
    expect((await call(`/api/sessions/${await sid(1)}/compose`, {})).status).toBe(400)
    await finish(1)
    expect((await call(`/api/sessions/${await sid(1)}/compose`, {})).status).toBe(409)
    expect(await vocab()).toEqual([])
  })
})

describe('liên thông với quiz', () => {
  it('sau khi từ đã vào kho, làm sai câu quiz thì từ ĐÓ chuyển sang đến hạn hôm nay (không tạo bản trùng)', async () => {
    await compose()
    const stored = JSON.parse((await db.prepare('SELECT lesson_json FROM sessions WHERE seq = 1').first<any>()).lesson_json).quiz as { type: string; answer: number | string; word?: string }[]
    // sai đúng câu đầu tiên có từ liên quan
    const answers = stored.map((q, i) => (i === 0 ? (q.type === 'mcq' ? ((q.answer as number) + 1) % 4 : 'wrong') : q.answer))
    const r = await call(`/api/sessions/${await sid(1)}/quiz`, { answers })
    expect(r.status).toBe(200)
    const w = stored[0].word!
    expect(await vocab()).toHaveLength(5)
    expect((await db.prepare('SELECT * FROM vocab WHERE lower(word) = lower(?)').bind(w).first<any>())).toMatchObject({ due_date: TODAY, wrong_count: 1 })
    // các từ làm đúng vẫn hẹn ngày mai
    const others = (await db.prepare('SELECT due_date FROM vocab WHERE lower(word) != lower(?)').bind(w).all<any>()).results
    expect(others.every((o) => o.due_date === TOMORROW)).toBe(true)
  })
})
