import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { createTestBucket } from './test-r2'
import { createTestDb } from './test-db'
import { detectFileType, MAX_FILE_BYTES, sanitizeTitle } from './uploads'
import { countWords } from './text'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database
let objects: ReturnType<typeof createTestBucket>['objects']

const enc = (s: string) => new TextEncoder().encode(s)
const PDF = enc('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')
const TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(30)

beforeEach(() => {
  db = createTestDb()
  const r2 = createTestBucket()
  objects = r2.objects
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db, FILES: r2.bucket } as Env
})
afterEach(() => vi.unstubAllGlobals())

async function postFile(parts: { file?: { name: string; bytes: Uint8Array | string; type?: string }; title?: string }, authed = true, headers: Record<string, string> = {}) {
  const fd = new FormData()
  if (parts.file) fd.append('file', new File([typeof parts.file.bytes === 'string' ? enc(parts.file.bytes) : parts.file.bytes], parts.file.name, { type: parts.file.type }))
  if (parts.title !== undefined) fd.append('title', parts.title)
  return app.request('/api/uploads', { method: 'POST', headers: { ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}), ...headers }, body: fd }, env)
}
const postLink = async (body: unknown, authed = true) =>
  app.request('/api/uploads/link', { method: 'POST', headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }, env)
const json = async (r: Response) => (await r.json()) as any
const rows = async () => (await db.prepare('SELECT * FROM uploads ORDER BY id').all<any>()).results

describe('detectFileType — nhận dạng bằng nội dung', () => {
  it('PDF thật; txt/md UTF-8 thật', () => {
    expect(detectFileType(PDF, 'a.pdf')).toMatchObject({ ok: true, kind: 'pdf', mime: 'application/pdf' })
    expect(detectFileType(PDF, 'A.PDF')).toMatchObject({ ok: true, kind: 'pdf' })
    expect(detectFileType(enc('Xin chào, hello. Tiếng Việt có dấu ✓'), 'a.txt')).toMatchObject({ ok: true, kind: 'text', mime: 'text/plain' })
    expect(detectFileType(enc('# Title\n\ntext'), 'notes.md')).toMatchObject({ ok: true, kind: 'text' })
  })
  it('chữ ký PDF có thể nằm trong 1024 byte đầu (có rác phía trước)', () => {
    expect(detectFileType(enc('junk\n\n' + '%PDF-1.4 ...'), 'a.pdf').ok).toBe(true)
  })
  it('đuôi .pdf nhưng nội dung không phải PDF → type_mismatch', () => {
    expect(detectFileType(enc('chỉ là văn bản'), 'fake.pdf')).toEqual({ ok: false, reason: 'type_mismatch' })
    expect(detectFileType(new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'virus.pdf')).toEqual({ ok: false, reason: 'type_mismatch' }) // "MZ" của file .exe
  })
  it('đuôi .txt nhưng thật ra là PDF → type_mismatch', () => {
    expect(detectFileType(PDF, 'a.txt')).toEqual({ ok: false, reason: 'type_mismatch' })
  })
  it('nhị phân (có byte NUL) hoặc UTF-8 hỏng dù đuôi .txt → type_mismatch', () => {
    expect(detectFileType(new Uint8Array([0x68, 0x69, 0x00, 0x01]), 'a.txt')).toEqual({ ok: false, reason: 'type_mismatch' })
    expect(detectFileType(new Uint8Array([0xff, 0xfe, 0xfd, 0x41]), 'a.txt')).toEqual({ ok: false, reason: 'type_mismatch' })
  })
  it('đuôi không hỗ trợ → unsupported_type; không có đuôi cũng vậy', () => {
    for (const n of ['a.exe', 'a.png', 'a.zip', 'a.html', 'a.epub', 'a.docx', 'a', 'a.']) expect(detectFileType(PDF, n), n).toEqual({ ok: false, reason: 'unsupported_type' })
  })
  it('rỗng → empty', () => {
    expect(detectFileType(new Uint8Array(), 'a.pdf')).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('sanitizeTitle', () => {
  it('bỏ ký tự điều khiển và < >, gộp khoảng trắng, cắt 120 ký tự', () => {
    expect(sanitizeTitle('  Hello\n\tWorld\u0000 <b>x</b>  ')).toBe('Hello World b x /b')
    expect(sanitizeTitle('x'.repeat(500))).toHaveLength(120)
    expect(sanitizeTitle('   ')).toBe('')
  })
})

describe('POST /api/uploads — tải file', () => {
  it('cần đăng nhập, không lưu gì khi chưa đăng nhập', async () => {
    const r = await postFile({ file: { name: 'a.pdf', bytes: PDF } }, false)
    expect(r.status).toBe(401)
    expect(await rows()).toEqual([])
    expect(objects.size).toBe(0)
  })

  it('PDF hợp lệ: lưu nguyên bytes vào R2, ghi CSDL, trả 201 (không lộ khóa R2)', async () => {
    const r = await postFile({ file: { name: 'My Book.pdf', bytes: PDF, type: 'application/pdf' } })
    expect(r.status).toBe(201)
    const { upload } = await json(r)
    expect(upload).toMatchObject({ kind: 'file', title: 'My Book', url: null, mime: 'application/pdf', size_bytes: PDF.byteLength, excerpt: null, created_at: todayVN() })
    expect(Object.keys(upload)).not.toContain('r2_key')
    expect(JSON.stringify(upload)).not.toContain('uploads/')
    const [row] = await rows()
    expect(row.r2_key).toMatch(/^uploads\/[0-9a-f-]{36}\.pdf$/)
    expect(objects.get(row.r2_key)!.bytes).toEqual(PDF)
    expect(objects.get(row.r2_key)!.contentType).toBe('application/pdf')
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('văn bản .txt: lưu và cắt đoạn trích 40 từ đầu', async () => {
    const r = await postFile({ file: { name: 'story.txt', bytes: TEXT } })
    expect(r.status).toBe(201)
    const { upload } = await json(r)
    expect(upload.mime).toBe('text/plain')
    expect(countWords(upload.excerpt)).toBe(40)
    expect(upload.excerpt.startsWith('The quick brown fox')).toBe(true)
    expect((await rows())[0].r2_key).toMatch(/\.txt$/)
  })

  it('.md được nhận; tiếng Việt có dấu giữ nguyên', async () => {
    const r = await postFile({ file: { name: 'ghi-chu.md', bytes: '# Từ vựng\nXin chào các bạn, đây là bài học.' } })
    expect(r.status).toBe(201)
    expect((await json(r)).upload.excerpt).toContain('Xin chào')
  })

  it('tên do người học đặt được dùng và làm sạch; không có thì lấy tên file bỏ đuôi', async () => {
    expect((await json(await postFile({ file: { name: 'a.pdf', bytes: PDF }, title: '  Sách <đỏ>  ' }))).upload.title).toBe('Sách đỏ')
    expect((await json(await postFile({ file: { name: 'b.txt', bytes: 'hello world' }, title: '   ' }))).upload.title).toBe('b')
  })

  it('tên file độc hại không đi vào khóa lưu trữ (chống path traversal)', async () => {
    const r = await postFile({ file: { name: '../../etc/passwd.pdf', bytes: PDF } })
    expect(r.status).toBe(201)
    const [row] = await rows()
    expect(row.r2_key).not.toContain('..')
    expect(row.r2_key).not.toContain('passwd')
    expect(row.title).toBe('passwd')
  })

  it('chống trùng: cùng nội dung → 409, kèm id đã có, không ghi thêm vào R2 hay CSDL', async () => {
    const first = await json(await postFile({ file: { name: 'a.pdf', bytes: PDF } }))
    const r = await postFile({ file: { name: 'khac-ten.pdf', bytes: PDF } })
    expect(r.status).toBe(409)
    expect(await json(r)).toMatchObject({ error: 'duplicate', existing_id: first.upload.id })
    expect(await rows()).toHaveLength(1)
    expect(objects.size).toBe(1)
  })

  it('khác nội dung thì tải được nhiều file', async () => {
    await postFile({ file: { name: 'a.txt', bytes: 'first file content' } })
    await postFile({ file: { name: 'b.txt', bytes: 'second file content' } })
    expect(await rows()).toHaveLength(2)
    expect(objects.size).toBe(2)
  })

  describe('giới hạn kích thước', () => {
    it('đúng giới hạn 10 MB thì nhận', async () => {
      const big = new Uint8Array(MAX_FILE_BYTES)
      big.set(PDF)
      expect((await postFile({ file: { name: 'big.pdf', bytes: big } })).status).toBe(201)
    })
    it('vượt 10 MB dù chỉ 1 byte → 413, không lưu gì', async () => {
      const big = new Uint8Array(MAX_FILE_BYTES + 1)
      big.set(PDF)
      const r = await postFile({ file: { name: 'big.pdf', bytes: big } })
      expect(r.status).toBe(413)
      expect((await json(r)).error).toBe('too_large')
      expect(await rows()).toEqual([])
      expect(objects.size).toBe(0)
    })
    it('khai báo Content-Length quá lớn → từ chối ngay, không đọc nội dung', async () => {
      const r = await postFile({ file: { name: 'a.pdf', bytes: PDF } }, true, { 'content-length': String(MAX_FILE_BYTES * 5) })
      expect(r.status).toBe(413)
      expect(objects.size).toBe(0)
    })
  })

  describe('từ chối file không hợp lệ (không lưu gì)', () => {
    const cases: [string, { name: string; bytes: Uint8Array | string }, number, string][] = [
      ['đuôi không hỗ trợ (.exe)', { name: 'setup.exe', bytes: PDF }, 415, 'unsupported_type'],
      ['đuôi .html', { name: 'a.html', bytes: '<html>' }, 415, 'unsupported_type'],
      ['.epub (chưa hỗ trợ)', { name: 'book.epub', bytes: 'PK' }, 415, 'unsupported_type'],
      ['.pdf giả (nội dung là văn bản)', { name: 'a.pdf', bytes: 'không phải pdf' }, 415, 'type_mismatch'],
      ['.exe đổi tên thành .pdf', { name: 'a.pdf', bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]) }, 415, 'type_mismatch'],
      ['.txt là nhị phân', { name: 'a.txt', bytes: new Uint8Array([1, 2, 0, 3]) }, 415, 'type_mismatch'],
      ['file rỗng', { name: 'a.txt', bytes: new Uint8Array() }, 400, 'empty'],
    ]
    for (const [name, file, status, error] of cases) {
      it(`${name} → ${status} ${error}`, async () => {
        const r = await postFile({ file })
        expect(r.status).toBe(status)
        expect((await json(r)).error).toBe(error)
        expect(await rows()).toEqual([])
        expect(objects.size).toBe(0)
      })
    }
    it('Content-Type do client khai (application/pdf) không được tin', async () => {
      const r = await postFile({ file: { name: 'a.pdf', bytes: 'chỉ là chữ', type: 'application/pdf' } })
      expect(r.status).toBe(415)
    })
    it('không có file / trường file không phải file → 400 no_file', async () => {
      expect((await json(await postFile({}))).error).toBe('no_file')
      const fd = new FormData()
      fd.append('file', 'chỉ là chuỗi')
      const r = await app.request('/api/uploads', { method: 'POST', headers: { cookie: `ea_session=${await makeToken(SECRET)}` }, body: fd }, env)
      expect(r.status).toBe(400)
    })
    it('không phải multipart → 400', async () => {
      const r = await app.request('/api/uploads', { method: 'POST', headers: { cookie: `ea_session=${await makeToken(SECRET)}`, 'content-type': 'application/json' }, body: '{}' }, env)
      expect(r.status).toBe(400)
    })
  })

  describe('lỗi hạ tầng', () => {
    it('ghi CSDL lỗi → xóa file vừa ghi ở R2 (không để file mồ côi)', async () => {
      const real = db
      env = {
        ...env,
        DB: Object.assign(Object.create(real), {
          prepare: (sql: string) => (/INSERT INTO uploads/.test(sql) ? { bind: () => ({ first: async () => { throw new Error('db down') } }) } : real.prepare(sql)),
        }),
      } as Env
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const r = await postFile({ file: { name: 'a.pdf', bytes: PDF } })
      expect(r.status).toBe(500)
      expect(objects.size).toBe(0)
    })
    it('R2 lỗi → 500, không ghi dòng nào vào CSDL', async () => {
      env = { ...env, FILES: { put: async () => { throw new Error('r2 down') }, delete: async () => {} } as unknown as R2Bucket } as Env
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect((await postFile({ file: { name: 'a.pdf', bytes: PDF } })).status).toBe(500)
      expect(await rows()).toEqual([])
    })
  })
})

describe('POST /api/uploads/link — đưa link', () => {
  const PAGE = (title: string, body = TEXT) => `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`
  const stubPage = (html: string, init: ResponseInit = { headers: { 'content-type': 'text/html' } }) => {
    const f = vi.fn(async () => new Response(html, init))
    vi.stubGlobal('fetch', f)
    return f
  }

  it('cần đăng nhập', async () => {
    stubPage(PAGE('x'))
    expect((await postLink({ url: 'https://example.com/a' }, false)).status).toBe(401)
    expect(await rows()).toEqual([])
  })

  it('link hợp lệ: lưu link + tiêu đề trang + đoạn trích 40 từ, không lưu nội dung trang, không có file R2', async () => {
    stubPage(PAGE('Learn English Fast'))
    const r = await postLink({ url: 'https://example.com/learn' })
    expect(r.status).toBe(201)
    const { upload } = await json(r)
    expect(upload).toMatchObject({ kind: 'link', title: 'Learn English Fast', url: 'https://example.com/learn', mime: 'text/html', size_bytes: null, created_at: todayVN() })
    expect(countWords(upload.excerpt)).toBe(40)
    const [row] = await rows()
    expect(row.r2_key).toBeNull()
    expect(JSON.stringify(row).length).toBeLessThan(800) // không lưu cả trang
    expect(objects.size).toBe(0)
  })

  it('tên do người học đặt được ưu tiên; thiếu tiêu đề trang thì lấy tên miền', async () => {
    stubPage(PAGE('Tiêu đề trang'))
    expect((await json(await postLink({ url: 'https://example.com/a', title: 'Tên của tôi' }))).upload.title).toBe('Tên của tôi')
    stubPage('<html><body><p>' + TEXT + '</p></body></html>')
    expect((await json(await postLink({ url: 'https://other.example.org/b' }))).upload.title).toBe('other.example.org')
  })

  it('link không an toàn (nội bộ/localhost/giao thức khác) → không gọi mạng', async () => {
    const f = stubPage(PAGE('x'))
    for (const url of ['http://localhost:8788/api/health', 'http://169.254.169.254/latest', 'http://192.168.1.1/', 'http://10.0.0.1/x', 'https://u:p@example.com/']) {
      const r = await postLink({ url })
      expect(r.status, url).toBe(400)
      expect((await json(r)).error).toBe('unsafe_url')
    }
    for (const url of ['ftp://example.com/a', 'javascript:alert(1)', 'example.com/a', '', '   ']) {
      expect((await postLink({ url })).status, url).toBe(400)
    }
    expect(f).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
  })

  it('url thiếu / sai kiểu / body hỏng → 400', async () => {
    for (const body of [{}, { url: 5 }, { url: null }, '{bad']) expect((await postLink(body)).status).toBe(400)
  })

  it('trang lỗi / không phải HTML / quá ngắn / đăng nhập → 422, không lưu', async () => {
    const cases: [string, Response][] = [
      ['http_error', new Response('nope', { status: 404 })],
      ['not_html', new Response(PAGE('x'), { headers: { 'content-type': 'application/pdf' } })],
      ['too_short', new Response(PAGE('x', 'Hi.'), { headers: { 'content-type': 'text/html' } })],
      ['soft_404', new Response(PAGE('404 Not Found'), { headers: { 'content-type': 'text/html' } })],
    ]
    for (const [error, resp] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => resp.clone()))
      const r = await postLink({ url: 'https://example.com/a' })
      expect(r.status, error).toBe(422)
      expect((await json(r)).error, error).toBe(error)
    }
    expect(await rows()).toEqual([])
  })

  it('lỗi mạng → 422 unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network') }))
    const r = await postLink({ url: 'https://example.com/a' })
    expect(r.status).toBe(422)
    expect((await json(r)).error).toBe('unreachable')
  })

  it('chống trùng link (khác utm / # / www / dấu / cuối) → 409, không gọi mạng lần nữa', async () => {
    const f = stubPage(PAGE('A'))
    const first = await json(await postLink({ url: 'https://example.com/a' }))
    f.mockClear()
    for (const url of ['https://www.example.com/a/', 'https://example.com/a?utm_source=x#top', 'HTTPS://EXAMPLE.COM/a']) {
      const r = await postLink({ url })
      expect(r.status, url).toBe(409)
      expect((await json(r)).existing_id).toBe(first.upload.id)
    }
    expect(f).not.toHaveBeenCalled()
    expect(await rows()).toHaveLength(1)
  })

  it('link và file là hai loại riêng, cùng tồn tại được', async () => {
    stubPage(PAGE('A'))
    await postLink({ url: 'https://example.com/a' })
    await postFile({ file: { name: 'a.pdf', bytes: PDF } })
    expect((await rows()).map((r) => r.kind)).toEqual(['link', 'file'])
  })
})

describe('ràng buộc CSDL', () => {
  it('uploads từ chối kind=file thiếu khóa R2, kind=link thiếu url, và hash trùng', async () => {
    await expect(db.prepare("INSERT INTO uploads (kind, title, created_at) VALUES ('file', 't', '2026-01-01')").run()).rejects.toThrow()
    await expect(db.prepare("INSERT INTO uploads (kind, title, created_at) VALUES ('link', 't', '2026-01-01')").run()).rejects.toThrow()
    await db.prepare("INSERT INTO uploads (kind, title, r2_key, created_at, sha256) VALUES ('file', 't', 'k1', '2026-01-01', 'abc')").run()
    await expect(db.prepare("INSERT INTO uploads (kind, title, r2_key, created_at, sha256) VALUES ('file', 't2', 'k2', '2026-01-01', 'abc')").run()).rejects.toThrow()
  })
})
