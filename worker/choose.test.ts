import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { chooseMaterial } from './session-store'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

const OPTS = [
  { type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' },
  { type: 'youtube', title: 'B', url: 'https://www.youtube.com/watch?v=abc12345678', why_vi: 'b', excerpt: 'b' },
  { type: 'podcast', title: 'C', url: 'https://pod.example.org/c', why_vi: 'c', excerpt: 'c' },
]
const PAGE = '<html><head><title>L</title></head><body>' + '<p>Can I have a coffee please? Yes of course. Transcript</p>'.repeat(40) + '</body></html>'
const aiOptions = (options: unknown[]) =>
  vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('generativelanguage')) return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ options }) }] } }] })
    if (url.includes('oembed')) return Response.json({ title: 'ok' })
    return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
  })

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', aiOptions(OPTS))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

async function call(path: string, body?: unknown, authed = true) {
  return app.request(
    path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}
const json = async (r: Response) => (await r.json()) as any
const sid = async (seq = 1) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const begin = async (seq = 1) => call(`/api/sessions/${await sid(seq)}/materials`, {})
const choose = async (index: unknown, seq = 1) => call(`/api/sessions/${await sid(seq)}/choose`, { index })
const stored = async (seq = 1) => JSON.parse((await db.prepare('SELECT material_json FROM sessions WHERE seq = ?').bind(seq).first<{ material_json: string }>())!.material_json)

describe('chọn 1 tài liệu', () => {
  it.each([0, 1, 2])('chọn lựa chọn %i: lưu đúng chỉ số, trả lại danh sách', async (i) => {
    await begin()
    const r = await choose(i)
    expect(r.status).toBe(200)
    expect((await json(r)).material).toMatchObject({ chosen: i, fallback: false })
    expect((await stored()).chosen).toBe(i)
  })
  it('giữ nguyên danh sách tài liệu, chỉ thêm lựa chọn', async () => {
    await begin()
    const before = await stored()
    await choose(1)
    expect(await stored()).toEqual({ ...before, chosen: 1 })
  })
  it('GET buổi học cho thấy lựa chọn đã chọn', async () => {
    await begin()
    await choose(2)
    expect((await json(await call(`/api/sessions/${await sid()}`))).session.material.chosen).toBe(2)
  })
  it('cần đăng nhập', async () => {
    await begin()
    expect((await call(`/api/sessions/${await sid()}/choose`, { index: 0 }, false)).status).toBe(401)
    expect((await stored()).chosen).toBeNull()
  })
})

describe('lựa chọn không hợp lệ → 400, không khóa', () => {
  it('ngoài khoảng, không nguyên, sai kiểu, thiếu', async () => {
    await begin()
    for (const bad of [-1, 3, 99, 1.5, '1', null, undefined, true, [0], { a: 1 }, NaN]) {
      const r = await choose(bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect((await json(r)).error).toBe('invalid_choice')
    }
    expect((await stored()).chosen).toBeNull() // vẫn chưa khóa, chọn lại được
    expect((await choose(0)).status).toBe(200)
  })
  it('body hỏng / không có body → 400', async () => {
    await begin()
    const raw = async (b?: string) => app.request(`/api/sessions/${await sid()}/choose`, { method: 'POST', headers: { cookie: `ea_session=${await makeToken(SECRET)}` }, body: b }, env)
    expect((await raw()).status).toBe(400)
    expect((await raw('{bad')).status).toBe(400)
  })
  it('chưa bắt đầu buổi (chưa có danh sách) → 400 no_material', async () => {
    const r = await choose(0)
    expect(r.status).toBe(400)
    expect((await json(r)).error).toBe('no_material')
  })
  it('buổi không tồn tại → 404', async () => {
    expect((await call('/api/sessions/99999/choose', { index: 0 })).status).toBe(404)
  })
})

describe('khóa: không đổi giữa buổi', () => {
  it('đã chọn 1 mà chọn cái khác → 409 locked, lựa chọn cũ giữ nguyên', async () => {
    await begin()
    await choose(0)
    for (const other of [1, 2]) {
      const r = await choose(other)
      expect(r.status).toBe(409)
      expect((await json(r)).error).toBe('locked')
    }
    expect((await stored()).chosen).toBe(0)
  })
  it('gửi lại đúng lựa chọn cũ (vd mạng chập chờn) → vẫn thành công, không đổi gì', async () => {
    await begin()
    await choose(1)
    const r = await choose(1)
    expect(r.status).toBe(200)
    expect((await json(r)).material.chosen).toBe(1)
  })
  it('lựa chọn không hợp lệ sau khi đã khóa cũng chỉ báo locked', async () => {
    await begin()
    await choose(0)
    expect((await json(await choose(99))).error).toBe('locked')
  })
  it('bắt đầu buổi lại sau khi chọn: vẫn trả đúng lựa chọn, KHÔNG tìm lại tài liệu', async () => {
    await begin()
    await choose(2)
    const fn = aiOptions([{ ...OPTS[0], url: 'https://other.example.com/x' }])
    vi.stubGlobal('fetch', fn)
    const again = await json(await begin())
    expect(again.material).toMatchObject({ chosen: 2, options: OPTS })
    expect(fn).not.toHaveBeenCalled()
  })
  it('buổi dùng bài AI tự viết (fallback) thì không chọn được tài liệu', async () => {
    vi.stubGlobal('fetch', aiOptions([OPTS[0]])) // chỉ 1 nguồn dùng được → fallback
    await begin()
    expect((await stored())).toMatchObject({ fallback: true, chosen: -1, options: [] })
    for (const i of [0, -1]) {
      const r = await choose(i)
      expect(r.status).toBe(409)
      expect((await json(r)).error).toBe('locked')
    }
  })
  it('buổi đã xong thì không chọn được (409 done)', async () => {
    await begin()
    await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq=1").bind(todayVN()).run()
    expect((await json(await choose(0))).error).toBe('done')
  })
  it('hai yêu cầu chọn khác nhau cùng lúc: chỉ một bên thắng, bên kia bị khóa', async () => {
    await begin()
    const id = await sid()
    const [a, b] = await Promise.all([chooseMaterial(db, id, 0), chooseMaterial(db, id, 2)])
    const wins = [a, b].filter((r) => r.ok)
    expect(wins.length).toBeGreaterThanOrEqual(1)
    const final = (await stored()).chosen
    expect([0, 2]).toContain(final)
    for (const r of [a, b]) if (!r.ok) expect(r.reason).toBe('locked')
  })
  it('các buổi khác không bị ảnh hưởng', async () => {
    await begin()
    await choose(0)
    await db.prepare("UPDATE sessions SET status='done', score=80 WHERE seq=1").run()
    await begin(2)
    expect((await stored(2)).chosen).toBeNull()
    expect((await choose(1, 2)).status).toBe(200)
    expect((await stored(1)).chosen).toBe(0)
  })
})

describe('chốt khóa ở CSDL (trigger)', () => {
  it('sau khi chọn: không ghi đè được lựa chọn hay danh sách bằng SQL trực tiếp', async () => {
    await begin()
    await choose(1)
    const before = await stored()
    await expect(db.prepare("UPDATE sessions SET material_json = json_set(material_json, '$.chosen', 2) WHERE seq = 1").run()).rejects.toThrow(/material_locked/)
    await expect(db.prepare("UPDATE sessions SET material_json = '{\"options\":[],\"chosen\":null,\"fallback\":false}' WHERE seq = 1").run()).rejects.toThrow(/material_locked/)
    await expect(db.prepare('UPDATE sessions SET material_json = NULL WHERE seq = 1').run()).rejects.toThrow(/material_locked/)
    expect(await stored()).toEqual(before)
  })
  it('chưa chọn: vẫn ghi được (tạo/làm mới danh sách), và đặt chosen lần đầu được', async () => {
    await begin()
    await db.prepare("UPDATE sessions SET material_json = json_set(material_json, '$.fallback', json('false')) WHERE seq = 1").run()
    await db.prepare("UPDATE sessions SET material_json = json_set(material_json, '$.chosen', 0) WHERE seq = 1").run()
    expect((await stored()).chosen).toBe(0)
  })
  it('các cột khác (bài học, điểm, trạng thái) vẫn cập nhật bình thường sau khi khóa', async () => {
    await begin()
    await choose(0)
    await db.prepare("UPDATE sessions SET lesson_json = '{}', status = 'done', score = 90 WHERE seq = 1").run()
    expect((await db.prepare('SELECT score FROM sessions WHERE seq = 1').first<{ score: number }>())!.score).toBe(90)
  })
  it('ghi lại đúng giá trị cũ (không đổi gì) không bị chặn', async () => {
    await begin()
    await choose(0)
    await db.prepare('UPDATE sessions SET material_json = material_json WHERE seq = 1').run()
  })
})
