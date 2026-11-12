import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { splitSegments, toBase64 } from './upload-material'
import { createTestBucket } from './test-r2'
import { createTestDb } from './test-db'
import type { Env } from './env'
import { QUIZ8 } from './test-fixtures'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database
let objects: ReturnType<typeof createTestBucket>['objects']

const enc = (s: string) => new TextEncoder().encode(s)
const A = { type: 'article', title: 'AI article A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }
const B = { type: 'article', title: 'AI article B', url: 'https://example.com/b', why_vi: 'b', excerpt: 'b' }
const C = { type: 'article', title: 'AI article C', url: 'https://example.com/c', why_vi: 'c', excerpt: 'c' }
const PAGE = '<html><head><title>L</title></head><body>' + '<p>Can I have a coffee please? Yes of course. </p>'.repeat(40) + '</body></html>'
const PDF = enc('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')

const lessonJson = (title = 'From my document') => ({
  title, excerpt: 'A short quote from the document.', summary_vi: 'Tóm tắt.', explanation_vi: 'Giải thích.',
  vocab: ['alpha', 'beta', 'gamma', 'delta', 'omega'].map((w) => ({ word: w, meaning_vi: 'nghĩa ' + w })),
  grammar: [{ point: 'Present simple', explanation_vi: 'Thói quen.' }],
  quiz: QUIZ8,
})

/** Ghi lại mọi lời gọi Gemini để kiểm tra nội dung yêu cầu. */
let geminiCalls: { tools?: unknown; parts: any[] }[]
function net(opts: { search?: (n: number) => Response; lesson?: (n: number) => Response; page?: (url: string) => Response } = {}) {
  let ns = 0, nl = 0
  geminiCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('generativelanguage')) {
        const body = JSON.parse(init?.body as string)
        geminiCalls.push({ tools: body.tools, parts: body.contents[0].parts })
        if (body.tools) return (opts.search ?? (() => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ options: [A, B, C] }) }] } }] })))(++ns)
        return (opts.lesson ?? (() => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(lessonJson()) }] } }] })))(++nl)
      }
      if (url.includes('oembed')) return Response.json({ title: 'ok' })
      return opts.page ? opts.page(url) : new Response(PAGE, { headers: { 'content-type': 'text/html' } })
    }),
  )
}
const searchOf = (options: unknown[]) => () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ options }) }] } }] })

beforeEach(async () => {
  db = createTestDb()
  const r2 = createTestBucket()
  objects = r2.objects
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db, FILES: r2.bucket } as Env
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  net()
  expect((await call('/api/plan', {})).status).toBe(200)
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
const begin = async (seq = 1) => json(await call(`/api/sessions/${await sid(seq)}/materials`, {}))
const choose = async (index: number, seq = 1) => call(`/api/sessions/${await sid(seq)}/choose`, { index })
const compose = async (seq = 1) => call(`/api/sessions/${await sid(seq)}/compose`, {})
const finish = async (seq: number) => {
  await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=?").bind(todayVN(), seq).run()
  // buổi kế tiếp đã ôn từ vựng bài trước (cổng ôn từ vựng không phải trọng tâm của các test này)
  await db.prepare('UPDATE sessions SET vocab_review_json = ? WHERE seq = ?').bind('{"passed":true,"remaining":[],"round":1}', seq + 1).run()
}

/** Chèn thẳng tài liệu tải lên (file trong R2 hoặc link) */
async function addFile(name: string, bytes: Uint8Array, mime: string, title = name) {
  const key = `uploads/${crypto.randomUUID()}.${name.split('.').pop()}`
  await env.FILES!.put(key, bytes)
  return (await db.prepare("INSERT INTO uploads (kind, title, r2_key, mime, size_bytes, excerpt, created_at, sha256) VALUES ('file', ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(title, key, mime, bytes.byteLength, mime === 'text/plain' ? 'Chapter one begins here.' : null, todayVN(), crypto.randomUUID()).first<{ id: number }>())!.id
}
const addLink = async (url: string, title = 'My link') =>
  (await db.prepare("INSERT INTO uploads (kind, title, url, mime, excerpt, created_at) VALUES ('link', ?, ?, 'text/html', 'A quote from the page.', ?) RETURNING id").bind(title, url, todayVN()).first<{ id: number }>())!.id

describe('splitSegments / toBase64', () => {
  it('chia theo ranh giới đoạn văn, mỗi đoạn lớn không vượt quá cỡ cho phép', () => {
    const para = (i: number) => `Paragraph ${i}. ` + 'word '.repeat(100)
    const text = Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n')
    const seg = splitSegments(text, 2000)
    expect(seg.length).toBeGreaterThan(3)
    for (const s of seg) expect(s.length).toBeLessThanOrEqual(2000)
    expect(seg.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, '')) // không mất chữ (bỏ khoảng trắng đầu/cuối đoạn)
  })
  it('một đoạn văn khổng lồ bị cắt cứng; văn bản ngắn / rỗng không lỗi', () => {
    expect(splitSegments('x'.repeat(5000), 2000)).toHaveLength(3)
    expect(splitSegments('Short text.', 2000)).toEqual(['Short text.'])
    expect(splitSegments('   ', 2000)).toEqual([''])
  })
  it('toBase64 giải mã lại đúng, kể cả file lớn', () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 256)
    expect(Uint8Array.from(atob(toBase64(big)), (c) => c.charCodeAt(0))).toEqual(big)
  })
})

describe('đưa tài liệu người học vào danh sách lựa chọn', () => {
  it('chưa tải gì lên → danh sách như cũ (3 tài liệu AI), không có lựa chọn upload', async () => {
    const { material } = await begin()
    expect(material.options.map((o: any) => o.type)).toEqual(['article', 'article', 'article'])
  })

  it('có tài liệu tải lên → thành MỘT lựa chọn, chiếm 1 trong tối đa 3 chỗ (AI còn 2)', async () => {
    const id = await addFile('story.txt', enc('Chapter one begins here.'), 'text/plain', 'My story')
    const { material } = await begin()
    expect(material.options).toHaveLength(3)
    expect(material.options.slice(0, 2).map((o: any) => o.url)).toEqual([A.url, B.url])
    expect(material.options[2]).toEqual({ type: 'upload', title: 'My story', url: '', upload_id: id, why_vi: 'Tài liệu bạn đã tải lên.', excerpt: 'Chapter one begins here.' })
    expect(material.fallback).toBe(false)
  })

  it('link tải lên: lựa chọn có url để xem trước', async () => {
    const id = await addLink('https://mysite.example.com/page', 'Trang của tôi')
    const { material } = await begin()
    expect(material.options[2]).toMatchObject({ type: 'upload', upload_id: id, url: 'https://mysite.example.com/page', title: 'Trang của tôi' })
  })

  it('file PDF: lựa chọn không có url, không lộ khóa R2', async () => {
    await addFile('book.pdf', PDF, 'application/pdf', 'My book')
    const text = JSON.stringify(await begin())
    expect(text).not.toContain('uploads/')
    expect(text).not.toContain('r2_key')
  })

  it('AI chỉ tìm được 1 nguồn: vẫn đưa danh sách có tài liệu của người học (không cần fallback)', async () => {
    net({ search: searchOf([A]) })
    await addFile('story.txt', enc('hello'), 'text/plain', 'Mine')
    const { material } = await begin()
    expect(material).toMatchObject({ fallback: false, chosen: null })
    expect(material.options.map((o: any) => o.type)).toEqual(['article', 'upload'])
  })

  it('AI không tìm được gì nhưng có tài liệu của người học → chỉ còn lựa chọn đó, không fallback', async () => {
    net({ search: searchOf([]) })
    await addFile('story.txt', enc('hello'), 'text/plain', 'Mine')
    const { material } = await begin()
    expect(material.fallback).toBe(false)
    expect(material.options.map((o: any) => o.type)).toEqual(['upload'])
  })

  it('tìm kiếm lỗi (500) nhưng có tài liệu của người học → vẫn dùng được', async () => {
    net({ search: () => new Response('', { status: 500 }) })
    await addFile('story.txt', enc('hello'), 'text/plain', 'Mine')
    expect((await begin()).material.options.map((o: any) => o.type)).toEqual(['upload'])
  })

  it('sai khóa/model (403) vẫn báo lỗi, không lưu gì (kể cả khi có tài liệu của người học)', async () => {
    net({ search: () => new Response('', { status: 403 }) })
    await addFile('story.txt', enc('hello'), 'text/plain', 'Mine')
    const r = await call(`/api/sessions/${await sid(1)}/materials`, {})
    expect(r.status).toBe(503)
    expect((await db.prepare('SELECT material_json FROM sessions WHERE seq = 1').first<{ material_json: string | null }>())!.material_json).toBeNull()
  })

  it('luân phiên: tài liệu được CHỌN nhiều buổi rồi thì nhường tài liệu ít dùng hơn; chỉ tính khi đã chọn', async () => {
    const older = await addFile('older.txt', enc('older text'), 'text/plain', 'Older')
    const newer = await addFile('newer.txt', enc('newer text'), 'text/plain', 'Newer')
    // buổi 1: bằng nhau → lấy cái mới nhất
    let { material } = await begin(1)
    expect(material.options.at(-1).upload_id).toBe(newer)
    await choose(2, 1) // chọn upload (vị trí 3 → chỉ số 2)
    await finish(1)
    // buổi 2: "newer" đã dùng 1 buổi → đưa "older"
    ;({ material } = await begin(2))
    expect(material.options.at(-1).upload_id).toBe(older)
    // buổi 2 không chọn upload (chọn AI), buổi 3: older chưa được chọn lần nào → vẫn đưa older
    await choose(0, 2)
    await finish(2)
    ;({ material } = await begin(3))
    expect(material.options.at(-1).upload_id).toBe(older)
  })

  it('upload đã bị xóa khỏi bảng thì không được đưa vào danh sách', async () => {
    const id = await addFile('gone.txt', enc('x'), 'text/plain', 'Gone')
    await db.prepare('DELETE FROM uploads WHERE id = ?').bind(id).run()
    expect((await begin()).material.options.every((o: any) => o.type === 'article')).toBe(true)
  })
})

describe('chọn tài liệu tải lên và soạn bài', () => {
  const uploadIndex = (m: any) => m.options.findIndex((o: any) => o.type === 'upload')

  it('văn bản: AI đọc nội dung file trong R2, bài có nguồn "upload" (không có nhãn AI viết)', async () => {
    const id = await addFile('story.txt', enc('Once upon a time there was a little cat who loved fish.'), 'text/plain', 'Cat story')
    const { material } = await begin()
    await choose(uploadIndex(material))
    net()
    const { lesson } = await json(await compose())
    expect(lesson.source).toEqual({ type: 'upload', title: 'Cat story', ai_written: false, upload_id: id })
    expect(lesson.notice_vi).toBeUndefined()
    const prompt = geminiCalls[0].parts[0].text as string
    expect(prompt).toContain('Once upon a time there was a little cat')
    expect(prompt).toContain("learner's OWN material")
    expect(prompt).toContain('part 1 of 1')
    expect(geminiCalls[0].tools).toBeUndefined() // không dùng tìm kiếm Google
  })

  it('PDF: gửi nguyên file cho Gemini (inlineData, application/pdf), đúng bytes', async () => {
    await addFile('book.pdf', PDF, 'application/pdf', 'My book')
    const { material } = await begin()
    await choose(uploadIndex(material))
    net()
    const { lesson } = await json(await compose())
    expect(lesson.source).toMatchObject({ type: 'upload', title: 'My book', ai_written: false })
    const inline = geminiCalls[0].parts[0].inlineData
    expect(inline.mimeType).toBe('application/pdf')
    expect(Uint8Array.from(atob(inline.data), (c) => c.charCodeAt(0))).toEqual(PDF)
    expect(geminiCalls[0].parts[1].text).toContain("learner's OWN material")
    expect(geminiCalls[0].parts[1].text).toContain('ONE coherent section')
  })

  it('link tải lên: tải trang rồi đưa nội dung cho AI; nguồn có url', async () => {
    const id = await addLink('https://mysite.example.com/page', 'Trang của tôi')
    const { material } = await begin()
    await choose(uploadIndex(material))
    net()
    const { lesson } = await json(await compose())
    expect(lesson.source).toEqual({ type: 'upload', title: 'Trang của tôi', ai_written: false, upload_id: id, url: 'https://mysite.example.com/page' })
    expect(geminiCalls[0].parts[0].text).toContain('Can I have a coffee')
  })

  it('tài liệu dài: mỗi buổi học một PHẦN kế tiếp; bài trước được báo cho AI để không lặp lại', async () => {
    const para = (i: number) => `PART_MARK_${i} ` + 'sentence about cats. '.repeat(120)
    const text = Array.from({ length: 8 }, (_, i) => para(i)).join('\n\n') // ~19k ký tự → vài phần
    await addFile('longbook.txt', enc(text), 'text/plain', 'Long book')
    const { material } = await begin(1)
    await choose(uploadIndex(material), 1)
    net({ lesson: () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(lessonJson('Lesson about chapter one')) }] } }] }) })
    expect((await compose(1)).status).toBe(200)
    const p1 = geminiCalls[0].parts[0].text as string
    expect(p1).toMatch(/part 1 of \d+/)
    expect(p1).toContain('PART_MARK_0')
    expect(p1).not.toContain('Lessons already made')
    await finish(1)

    net({ search: searchOf([A, B, C]) })
    const m2 = (await begin(2)).material
    await choose(uploadIndex(m2), 2)
    net()
    await compose(2)
    const p2 = geminiCalls[0].parts[0].text as string
    expect(p2).toMatch(/part 2 of \d+/)
    expect(p2).not.toContain('PART_MARK_0 ') // phần 1 không lặp lại
    expect(p2).toContain('Lesson about chapter one') // báo cho AI bài đã làm
  })

  it('không lưu nội dung tài liệu vào bài: chỉ đoạn trích ngắn', async () => {
    await addFile('story.txt', enc('SECRET_BODY_TEXT ' + 'long text here. '.repeat(200)), 'text/plain', 'Story')
    const { material } = await begin()
    await choose(uploadIndex(material))
    net({ lesson: () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...lessonJson(), excerpt: 'SECRET_BODY_TEXT ' + 'long text here. '.repeat(200) }) }] } }] }) })
    const { lesson } = await json(await compose())
    expect(lesson.excerpt.split(/\s+/).length).toBeLessThanOrEqual(80)
    const stored = (await db.prepare('SELECT material_json, lesson_json FROM sessions WHERE seq = 1').first<any>())
    expect((stored.material_json + stored.lesson_json).length).toBeLessThan(4000) // tài liệu gốc ~3.200 ký tự × nhiều lần thì mới vượt
    expect(stored.lesson_json.split('long text here.').length - 1).toBeLessThanOrEqual(30)
  })

  it('tài liệu bị xóa sau khi chọn → AI tự viết bài + ghi chú, không lỗi', async () => {
    const id = await addFile('story.txt', enc('hello world'), 'text/plain', 'Gone soon')
    const { material } = await begin()
    await choose(uploadIndex(material))
    await db.prepare('DELETE FROM uploads WHERE id = ?').bind(id).run()
    net()
    const { lesson } = await json(await compose())
    expect(lesson.source.ai_written).toBe(true)
    expect(lesson.notice_vi).toMatch(/Không đọc được tài liệu bạn đã tải lên/)
  })

  it('file đã bị xóa khỏi R2 → AI tự viết bài + ghi chú', async () => {
    await addFile('story.txt', enc('hello world'), 'text/plain', 'Lost file')
    const { material } = await begin()
    await choose(uploadIndex(material))
    objects.clear()
    net()
    const { lesson } = await json(await compose())
    expect(lesson.source).toMatchObject({ type: 'ai', ai_written: true })
  })

  it('PDF AI không đọc được (lỗi khác) → tự viết bài (gọi AI 2 lần); API từ chối (429) → 503', async () => {
    await addFile('scan.pdf', PDF, 'application/pdf', 'Scan')
    const { material } = await begin()
    await choose(uploadIndex(material))
    net({ lesson: (n) => (n === 1 ? new Response('', { status: 500 }) : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(lessonJson()) }] } }] })) })
    const { lesson } = await json(await compose())
    expect(lesson.source.ai_written).toBe(true)
    expect(geminiCalls).toHaveLength(2)

    // (buổi khác) 429 không fallback
    await db.prepare("UPDATE sessions SET lesson_json = NULL WHERE seq = 1").run()
    net({ lesson: () => new Response('', { status: 429 }) })
    expect((await compose()).status).toBe(503)
  })

  it('chọn upload bị khóa như mọi tài liệu khác: không đổi sang lựa chọn khác', async () => {
    await addFile('story.txt', enc('hello world'), 'text/plain', 'Mine')
    const { material } = await begin()
    const i = uploadIndex(material)
    await choose(i)
    expect((await choose(0)).status).toBe(409)
  })

  it('GET buổi học thấy lựa chọn upload và bài đã soạn', async () => {
    await addFile('story.txt', enc('hello world story text'), 'text/plain', 'Mine')
    const { material } = await begin()
    await choose(uploadIndex(material))
    await compose()
    const { session } = await json(await call(`/api/sessions/${await sid(1)}`))
    expect(session.material.options[session.material.chosen].type).toBe('upload')
    expect(session.lesson.source.type).toBe('upload')
  })
})
