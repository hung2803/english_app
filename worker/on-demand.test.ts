import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { BANK } from './placement-bank'
import { saveProposal } from './adjustment-store'
import { createTestDb } from './test-db'
import type { Env } from './env'
import { QUIZ8 } from './test-fixtures'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

const A = { type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }
const B = { type: 'article', title: 'B', url: 'https://example.com/b', why_vi: 'b', excerpt: 'b' }
const LESSON = {
  title: 'T', excerpt: 'quote', summary_vi: 's', explanation_vi: 'e',
  vocab: ['a1', 'b2', 'c3', 'd4', 'e5'].map((w) => ({ word: w, meaning_vi: 'm' })),
  grammar: [{ point: 'p', explanation_vi: 'e' }],
  quiz: QUIZ8,
}
const PAGE = '<html><head><title>L</title></head><body>' + '<p>Can I have a coffee please? Yes of course. </p>'.repeat(40) + '</body></html>'

type Kind = 'plan' | 'review' | 'adjust' | 'search' | 'lesson' | 'other'
/** Phân loại lời gọi Gemini theo nội dung yêu cầu. */
function classify(body: any): Kind {
  const text = JSON.stringify(body.contents)
  if (body.tools) return 'search'
  if (text.includes('curriculum designer')) return 'plan'
  if (text.includes('extra REVIEW weeks')) return 'review'
  if (text.includes('reviewing one finished study week')) return 'adjust'
  if (text.includes('lesson') || text.includes('reading text')) return 'lesson'
  return 'other'
}
let gemini: Kind[]
const aiPlan = () => ({ weeks: Array.from({ length: 12 }, (_, i) => ({ week: i + 1, topic: `Topic ${i + 1}`, goal_vi: `Mục tiêu ${i + 1}` })) })

beforeEach(async () => {
  gemini = []
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('generativelanguage')) {
        const body = JSON.parse(init?.body as string)
        const kind = classify(body)
        gemini.push(kind)
        const payload =
          kind === 'plan' ? aiPlan()
          : kind === 'search' ? { options: [A, B] }
          : kind === 'review' ? { weeks: [{ topic: 'Review: one', goal_vi: 'Ôn một' }, { topic: 'Review: two', goal_vi: 'Ôn hai' }] }
          : kind === 'adjust' ? { summary_vi: 'ok', changes: [] }
          : LESSON
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] })
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    }),
  )
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown) {
  return app.request(
    path,
    { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  )
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const counts = async () =>
  (await db.prepare('SELECT COUNT(*) AS total, SUM(material_json IS NOT NULL) AS withMaterial, SUM(lesson_json IS NOT NULL) AS withLesson FROM sessions').first<{ total: number; withMaterial: number; withLesson: number }>())!
const contentCalls = () => gemini.filter((k) => k === 'search' || k === 'lesson')

describe('lập lộ trình chỉ tạo khung, không soạn nội dung buổi nào', () => {
  it('tạo lộ trình: 60 buổi đều chưa có tài liệu/bài; Gemini chỉ được gọi để lập khung chủ đề', async () => {
    expect((await call('/api/plan', {})).status).toBe(200)
    expect(await counts()).toEqual({ total: 60, withMaterial: 0, withLesson: 0 })
    expect(gemini).toEqual(['plan'])
  })
  it('chủ đề từng tuần có sẵn (khung), nhưng chưa có nội dung buổi', async () => {
    await call('/api/plan', {})
    expect((await db.prepare('SELECT COUNT(*) n FROM plan_weeks').first<{ n: number }>())!.n).toBe(12)
    expect((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE material_json IS NOT NULL OR lesson_json IS NOT NULL OR result_json IS NOT NULL').first<{ n: number }>())!.n).toBe(0)
  })
})

describe('xem / đồng bộ / điều chỉnh lộ trình không soạn nội dung', () => {
  beforeEach(async () => {
    await call('/api/plan', {})
    gemini.length = 0
  })
  it('xem lộ trình, xem buổi, xem danh sách đề xuất: không gọi AI, không tạo nội dung', async () => {
    await call('/api/plan')
    await call(`/api/sessions/${await sid(1)}`)
    await call(`/api/sessions/${await sid(30)}`)
    await call('/api/adjustments')
    await call('/api/placement/progress')
    expect(gemini).toEqual([])
    expect(await counts()).toMatchObject({ withMaterial: 0, withLesson: 0 })
  })
  it('lỡ buổi → hệ thống dời lịch: không soạn gì', async () => {
    await db.prepare("UPDATE sessions SET scheduled_date = date(scheduled_date, '-14 days')").run()
    await call('/api/plan')
    expect(gemini).toEqual([])
    expect(await counts()).toMatchObject({ withMaterial: 0, withLesson: 0 })
  })
  it('duyệt đề xuất điều chỉnh: chỉ đổi chủ đề, không soạn nội dung buổi', async () => {
    const { adjustment } = await saveProposal(db, 1, { week_no: 1, summary_vi: 's', changes: [{ week_no: 3, topic: 'New topic', goal_vi: 'Mục tiêu' }] })
    expect((await call(`/api/adjustments/${adjustment.id}/approve`, {})).status).toBe(200)
    expect(gemini).toEqual([])
    expect(await counts()).toMatchObject({ withMaterial: 0, withLesson: 0 })
  })
  it('thêm tuần ôn tập: AI chỉ soạn khung các tuần ôn, các buổi mới vẫn trống', async () => {
    await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=?").bind(todayVN()).run()
    await call('/api/placement/grade', { answers: BANK.map((b, i) => (i < 12 ? b.answer : (b.answer + 1) % 4)) }) // chưa đạt
    gemini.length = 0
    const r = await call('/api/plan/extend', {})
    expect(r.status).toBe(200)
    expect(gemini).toEqual(['review'])
    expect(await counts()).toEqual({ total: 70, withMaterial: 0, withLesson: 0 })
  })
})

describe('chỉ khi người học bắt đầu buổi nào thì buổi đó mới được soạn', () => {
  beforeEach(async () => {
    await call('/api/plan', {})
    gemini.length = 0
  })

  it('soạn bài khi chưa bắt đầu buổi (chưa tìm tài liệu) → 400, không gọi AI', async () => {
    const r = await call(`/api/sessions/${await sid(1)}/compose`, {})
    expect(r.status).toBe(400)
    expect((await json(r)).error).toBe('no_material')
    expect(gemini).toEqual([])
    expect(await counts()).toMatchObject({ withMaterial: 0, withLesson: 0 })
  })
  it('chọn tài liệu khi chưa bắt đầu → 400, không gọi AI', async () => {
    expect((await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })).status).toBe(400)
    expect(gemini).toEqual([])
  })
  it('bắt đầu buổi 2 khi buổi 1 chưa xong → 409, không gọi AI, không tạo gì', async () => {
    const r = await call(`/api/sessions/${await sid(2)}/materials`, {})
    expect(r.status).toBe(409)
    expect(gemini).toEqual([])
    expect(await counts()).toMatchObject({ withMaterial: 0, withLesson: 0 })
  })
  it('soạn bài cho buổi sau khi chưa bắt đầu → 400, không gọi AI', async () => {
    expect((await call(`/api/sessions/${await sid(40)}/compose`, {})).status).toBe(400)
    expect(gemini).toEqual([])
  })

  it('bắt đầu buổi 1: chỉ tìm tài liệu — chưa soạn bài', async () => {
    expect((await call(`/api/sessions/${await sid(1)}/materials`, {})).status).toBe(200)
    expect(gemini).toEqual(['search'])
    expect(await counts()).toMatchObject({ withMaterial: 1, withLesson: 0 })
  })
  it('chọn tài liệu xong vẫn chưa soạn bài (soạn bài là bước riêng, người học kích hoạt)', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })
    expect(gemini).toEqual(['search'])
    expect(await counts()).toMatchObject({ withMaterial: 1, withLesson: 0 })
  })
  it('xem buổi học (GET) không bao giờ tự soạn bài', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })
    await call(`/api/sessions/${await sid(1)}`)
    await call(`/api/sessions/${await sid(1)}`)
    expect(gemini).toEqual(['search'])
    expect((await json(await call(`/api/sessions/${await sid(1)}`))).session.lesson).toBeNull()
  })
  it('soạn bài buổi 1: đúng 1 lần gọi AI soạn bài, và chỉ buổi 1 có nội dung', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })
    expect((await call(`/api/sessions/${await sid(1)}/compose`, {})).status).toBe(200)
    expect(gemini).toEqual(['search', 'lesson'])
    expect(await counts()).toEqual({ total: 60, withMaterial: 1, withLesson: 1 })
    const others = await db.prepare('SELECT COUNT(*) n FROM sessions WHERE seq > 1 AND (material_json IS NOT NULL OR lesson_json IS NOT NULL)').first<{ n: number }>()
    expect(others!.n).toBe(0)
  })
  it('học xong buổi 1 rồi vẫn chưa có gì cho buổi 2 cho tới khi người học bắt đầu buổi 2', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 0 })
    await call(`/api/sessions/${await sid(1)}/compose`, {})
    await db.prepare("UPDATE sessions SET status='done', score=90, completed_date=? WHERE seq=1").bind(todayVN()).run()
    gemini.length = 0
    await call('/api/plan')
    await call(`/api/sessions/${await sid(2)}`)
    expect(gemini).toEqual([])
    expect((await db.prepare('SELECT material_json, lesson_json FROM sessions WHERE seq = 2').first<{ material_json: string | null; lesson_json: string | null }>())).toEqual({ material_json: null, lesson_json: null })
    await call(`/api/sessions/${await sid(2)}/materials`, {})
    expect(gemini).toEqual(['search'])
    expect(await counts()).toMatchObject({ withMaterial: 2, withLesson: 1 })
  })
  it('thử lại sau lỗi không soạn trước thêm gì: lỗi AI thì không có nội dung nào được lưu', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    expect((await call(`/api/sessions/${await sid(1)}/materials`, {})).status).toBe(503)
    expect(await counts()).toMatchObject({ withMaterial: 0, withLesson: 0 })
  })
  it('mỗi tìm kiếm / soạn bài chỉ chạy cho đúng buổi được yêu cầu (mọi lệnh gọi nội dung ứng với 1 buổi)', async () => {
    await call(`/api/sessions/${await sid(1)}/materials`, {})
    await call(`/api/sessions/${await sid(1)}/choose`, { index: 1 })
    await call(`/api/sessions/${await sid(1)}/compose`, {})
    await call(`/api/sessions/${await sid(1)}/materials`, {}) // gọi lại
    await call(`/api/sessions/${await sid(1)}/compose`, {}) // gọi lại
    expect(contentCalls()).toEqual(['search', 'lesson']) // gọi lại không soạn lại
  })
})
