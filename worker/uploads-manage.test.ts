import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { createTestBucket } from './test-r2'
import { createTestDb } from './test-db'
import type { Env } from './env'
import { QUIZ8, READING } from './test-fixtures'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database
let objects: ReturnType<typeof createTestBucket>['objects']

const enc = (s: string) => new TextEncoder().encode(s)
const PDF = enc('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')
const A = { type: 'article', title: 'AI A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }
const B = { type: 'article', title: 'AI B', url: 'https://example.com/b', why_vi: 'b', excerpt: 'b' }
const PAGE = '<html><head><title>Page</title></head><body>' + '<p>Can I have a coffee please? Yes of course. </p>'.repeat(40) + '</body></html>'
const LESSON = {
  title: 'Lesson', excerpt: READING, summary_vi: 's', explanation_vi: 'e',
  vocab: ['a1', 'b2', 'c3', 'd4', 'e5'].map((w) => ({ word: w, meaning_vi: 'm' })),
  grammar: [{ point: 'p', explanation_vi: 'e' }],
  quiz: QUIZ8,
}

beforeEach(async () => {
  db = createTestDb()
  const r2 = createTestBucket()
  objects = r2.objects
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db, FILES: r2.bucket } as Env
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('generativelanguage')) {
        const isSearch = Boolean(JSON.parse(init?.body as string).tools)
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(isSearch ? { options: [A, B] } : LESSON) }] } }] })
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    }),
  )
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown, method?: string, authed = true) {
  return app.request(
    path,
    {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const del = (id: number, authed = true) => call(`/api/uploads/${id}`, undefined, 'DELETE', authed)
const list = async () => json(await call('/api/uploads'))

async function uploadFile(name: string, bytes: Uint8Array, title?: string) {
  const fd = new FormData()
  fd.append('file', new File([bytes], name))
  if (title) fd.append('title', title)
  const r = await app.request('/api/uploads', { method: 'POST', headers: { cookie: `ea_session=${await makeToken(SECRET)}` }, body: fd }, env)
  expect(r.status).toBe(201)
  return (await json(r)).upload as { id: number }
}
const uploadLink = async (url: string, title?: string) => {
  const r = await call('/api/uploads/link', { url, title })
  expect(r.status).toBe(201)
  return (await json(r)).upload as { id: number }
}
const begin = async (seq = 1) => json(await call(`/api/sessions/${await sid(seq)}/materials`, {}))
const choose = async (index: number, seq = 1) => call(`/api/sessions/${await sid(seq)}/choose`, { index })
const compose = async (seq = 1) => call(`/api/sessions/${await sid(seq)}/compose`, {})
const finish = (seq: number) => db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=?").bind(todayVN(), seq).run()
const uploadIdx = (m: any) => m.options.findIndex((o: any) => o.type === 'upload')

describe('GET /api/uploads — danh sách', () => {
  it('cần đăng nhập', async () => {
    expect((await call('/api/uploads', undefined, undefined, false)).status).toBe(401)
  })
  it('chưa có gì → rỗng', async () => {
    expect(await list()).toEqual({ uploads: [], total_bytes: 0 })
  })
  it('mới nhất trước; có file lẫn link; đủ thông tin, KHÔNG lộ khóa R2 hay hash', async () => {
    await uploadFile('a.pdf', PDF, 'Sách A')
    await uploadFile('b.txt', enc('Hello world, this is text.'), 'Văn bản B')
    await uploadLink('https://example.com/page', 'Link C')
    const { uploads, total_bytes } = await list()
    expect(uploads.map((u: any) => u.title)).toEqual(['Link C', 'Văn bản B', 'Sách A'])
    expect(uploads.map((u: any) => u.kind)).toEqual(['link', 'file', 'file'])
    expect(uploads[0]).toMatchObject({ url: 'https://example.com/page', mime: 'text/html', size_bytes: null, times_used: 0, in_use: false, created_at: todayVN() })
    expect(uploads[2]).toMatchObject({ mime: 'application/pdf', size_bytes: PDF.byteLength })
    expect(total_bytes).toBe(PDF.byteLength + enc('Hello world, this is text.').byteLength)
    const text = JSON.stringify(uploads)
    expect(text).not.toContain('r2_key')
    expect(text).not.toContain('uploads/')
    expect(text).not.toContain('sha256')
  })
  it('đếm số buổi đã CHỌN tài liệu; đang dùng ở buổi chưa xong thì in_use', async () => {
    const up = await uploadFile('a.txt', enc('Some text for the lesson.'), 'Mine')
    const { material } = await begin(1)
    expect((await list()).uploads[0]).toMatchObject({ times_used: 0, in_use: false }) // mới được đưa vào danh sách, chưa chọn
    await choose(uploadIdx(material), 1)
    expect((await list()).uploads[0]).toMatchObject({ id: up.id, times_used: 1, in_use: true })
    await compose(1)
    await finish(1)
    expect((await list()).uploads[0]).toMatchObject({ times_used: 1, in_use: false }) // đã học xong
  })
})

describe('DELETE /api/uploads/:id — xóa', () => {
  it('cần đăng nhập, không xóa gì khi chưa đăng nhập', async () => {
    const up = await uploadFile('a.pdf', PDF)
    expect((await del(up.id, false)).status).toBe(401)
    expect((await list()).uploads).toHaveLength(1)
    expect(objects.size).toBe(1)
  })
  it('xóa file: mất dòng CSDL VÀ file ở R2', async () => {
    const up = await uploadFile('a.pdf', PDF)
    const key = (await db.prepare('SELECT r2_key FROM uploads').first<{ r2_key: string }>())!.r2_key
    expect(objects.has(key)).toBe(true)
    const r = await del(up.id)
    expect(r.status).toBe(200)
    expect(await json(r)).toEqual({ ok: true, removed_from_sessions: 0, storage_cleaned: true })
    expect((await list()).uploads).toEqual([])
    expect(objects.size).toBe(0)
  })
  it('xóa link: chỉ mất dòng CSDL', async () => {
    const up = await uploadLink('https://example.com/page')
    expect((await del(up.id)).status).toBe(200)
    expect((await list()).uploads).toEqual([])
  })
  it('chỉ xóa đúng tài liệu được chọn, các tài liệu khác (và file của chúng) còn nguyên', async () => {
    const a = await uploadFile('a.txt', enc('first document'))
    const b = await uploadFile('b.txt', enc('second document'))
    await del(a.id)
    const { uploads } = await list()
    expect(uploads.map((u: any) => u.id)).toEqual([b.id])
    expect(objects.size).toBe(1)
  })
  it('id không tồn tại hoặc đã xóa → 404', async () => {
    expect((await del(99999)).status).toBe(404)
    const up = await uploadFile('a.txt', enc('hello world'))
    await del(up.id)
    expect((await del(up.id)).status).toBe(404)
  })
  it('sau khi xóa có thể tải lại đúng file đó (hash không còn bị giữ)', async () => {
    const up = await uploadFile('a.txt', enc('same content here'))
    await del(up.id)
    const again = await uploadFile('a.txt', enc('same content here'))
    expect(again.id).not.toBe(up.id)
  })
  it('R2 xóa lỗi: vẫn xóa dòng CSDL, báo storage_cleaned=false (không kẹt tài liệu "ma")', async () => {
    const up = await uploadFile('a.txt', enc('hello world'))
    env = { ...env, FILES: { ...env.FILES, delete: async () => { throw new Error('r2 down') } } as unknown as R2Bucket } as Env
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await del(up.id)
    expect(r.status).toBe(200)
    expect((await json(r)).storage_cleaned).toBe(false)
    expect((await list()).uploads).toEqual([])
  })
})

describe('xóa tài liệu và các buổi học liên quan', () => {
  it('buổi đã có danh sách nhưng CHƯA chọn: tài liệu bị gỡ khỏi danh sách, còn lại giữ nguyên', async () => {
    const up = await uploadFile('a.txt', enc('hello world text'), 'Mine')
    const { material } = await begin(1)
    expect(material.options.map((o: any) => o.type)).toEqual(['article', 'article', 'upload'])
    const r = await json(await del(up.id))
    expect(r.removed_from_sessions).toBe(1)
    const after = (await json(await call(`/api/sessions/${await sid(1)}`))).session.material
    expect(after.options.map((o: any) => o.url)).toEqual([A.url, B.url])
    expect(after).toMatchObject({ chosen: null, fallback: false })
  })
  it('danh sách chỉ có tài liệu đó → sau khi xóa chuyển sang AI tự viết (fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('generativelanguage')) {
          const isSearch = Boolean(JSON.parse(init?.body as string).tools)
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(isSearch ? { options: [] } : LESSON) }] } }] })
        }
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
      }),
    )
    const up = await uploadFile('a.txt', enc('hello world text'), 'Mine')
    expect((await begin(1)).material.options.map((o: any) => o.type)).toEqual(['upload'])
    await del(up.id)
    const m = (await json(await call(`/api/sessions/${await sid(1)}`))).session.material
    expect(m).toEqual({ options: [], chosen: -1, fallback: true, fallback_reason: 'no_results' })
    expect((await compose(1)).status).toBe(200) // soạn được: AI tự viết
  })
  it('đã CHỌN nhưng chưa soạn: lựa chọn giữ nguyên (khóa), soạn bài thì AI tự viết + ghi chú', async () => {
    const up = await uploadFile('a.txt', enc('hello world text'), 'Mine')
    const { material } = await begin(1)
    await choose(uploadIdx(material), 1)
    const r = await json(await del(up.id))
    expect(r.removed_from_sessions).toBe(0)
    const { lesson } = await json(await compose(1))
    expect(lesson.source).toMatchObject({ type: 'ai', ai_written: true })
    expect(lesson.notice_vi).toMatch(/Không đọc được tài liệu bạn đã tải lên/)
  })
  it('bài ĐÃ soạn từ tài liệu được giữ nguyên sau khi xóa tài liệu', async () => {
    const up = await uploadFile('a.txt', enc('hello world text'), 'Mine')
    const { material } = await begin(1)
    await choose(uploadIdx(material), 1)
    const before = (await json(await compose(1))).lesson
    await finish(1)
    await del(up.id)
    const after = (await json(await call(`/api/sessions/${await sid(1)}`))).session.lesson
    expect({ ...after, quiz: undefined }).toEqual({ ...before, quiz: undefined }) // buổi đã xong: quiz kèm đáp án để xem lại
    expect(after.quiz).toHaveLength(8)
    expect(after.source).toMatchObject({ type: 'upload', title: 'Mine' })
  })
  it('xóa tài liệu không đụng tới danh sách của buổi chứa tài liệu khác (id gần giống, vd 1 và 11)', async () => {
    const ids: number[] = []
    for (let i = 0; i < 12; i++) ids.push((await uploadFile(`f${i}.txt`, enc(`document number ${i} content`))).id)
    const { material } = await begin(1)
    const shown = material.options.at(-1).upload_id as number // tài liệu mới nhất (id 12)
    expect(shown).toBe(ids[11])
    await del(ids[0]) // xóa id=1: không được ảnh hưởng tới upload_id 12
    const after = (await json(await call(`/api/sessions/${await sid(1)}`))).session.material
    expect(after.options.at(-1).upload_id).toBe(shown)
  })
  it('xóa tài liệu không ảnh hưởng buổi chưa bắt đầu và không gọi AI', async () => {
    const up = await uploadFile('a.txt', enc('hello world text'))
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchSpy.mockClear()
    await del(up.id)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE material_json IS NOT NULL').first<{ n: number }>())!.n).toBe(0)
  })
})
