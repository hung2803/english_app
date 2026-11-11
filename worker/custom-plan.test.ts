import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { buildCustomPlan, defaultPlan, parseCustomPlan, WEEKS } from './planning'
import { createTestDb } from './test-db'
import type { Env } from './env'

const ok = (text: string) => {
  const r = parseCustomPlan(text)
  if (!r.ok) throw new Error('parse lỗi: ' + r.message)
  return r.weeks
}
const NL = String.fromCharCode(10)
const lines = (n: number) => Array.from({ length: n }, (_, i) => `Chủ đề ${i + 1}`).join('\n')

describe('parseCustomPlan — đọc lộ trình người học nhập', () => {
  it('mỗi dòng một tuần; "Chủ đề | Mục tiêu" tách được mục tiêu, thiếu thì dùng mục tiêu mặc định', () => {
    expect(ok('Greetings | Chào hỏi\nFood')).toEqual([
      { topic: 'Greetings', goal_vi: 'Chào hỏi' },
      { topic: 'Food', goal_vi: 'Học theo lộ trình của bạn' },
    ])
  })
  it('bỏ số thứ tự và gạch đầu dòng ở đầu dòng', () => {
    expect(ok('1. Greetings'+NL+'2) Numbers'+NL+'- Food'+NL+'* Family'+NL+'• Home').map((w) => w.topic)).toEqual(['Greetings', 'Numbers', 'Food', 'Family', 'Home'])
  })
  it('có dòng "Tuần N" / "Week N": chỉ các dòng đó là tuần, dòng khác (mô tả) bị bỏ', () => {
    expect(ok('Tuần 1: Shopping'+NL+'Week 2 - Travel'+NL+'mô tả không phải tuần').map((w) => w.topic)).toEqual(['Shopping', 'Travel'])
  })
  it('bỏ dòng trống, khoảng trắng thừa, CRLF; bỏ chủ đề trùng (không phân biệt hoa thường)', () => {
    expect(ok('  Food  \r\n\r\n\r\nfood\r\nHome\r\n').map((w) => w.topic)).toEqual(['Food', 'Home'])
  })
  it('mục tiêu có dấu | bên trong vẫn giữ nguyên phần còn lại', () => {
    expect(ok('A | x | y')[0]).toEqual({ topic: 'A', goal_vi: 'x | y' })
  })
  it('rỗng / chỉ toàn dòng trống hoặc "1." → lỗi', () => {
    for (const t of ['', '   \n\n', '1.\n2.\n']) expect(parseCustomPlan(t)).toMatchObject({ ok: false })
  })
  it('đúng 12 dòng được, 13 dòng báo lỗi nói rõ số dòng', () => {
    expect(ok(lines(12))).toHaveLength(12)
    const r = parseCustomPlan(lines(13))
    expect(r).toMatchObject({ ok: false })
    expect((r as { message: string }).message).toContain('13')
  })
  it('chủ đề quá 80 ký tự, mục tiêu quá 200 ký tự, văn bản quá 20000 ký tự → lỗi', () => {
    expect(parseCustomPlan('x'.repeat(81))).toMatchObject({ ok: false })
    expect(parseCustomPlan('A | ' + 'y'.repeat(201))).toMatchObject({ ok: false })
    expect(parseCustomPlan('a\n'.repeat(10100))).toMatchObject({ ok: false })
  })
})

describe('buildCustomPlan — nối cho đủ 12 tuần', () => {
  afterEach(() => vi.unstubAllGlobals())
  const env = { GEMINI_API_KEY: 'k' } as Env
  const aiWeeks = Array.from({ length: WEEKS }, (_, i) => ({ week: i + 1, topic: `AI topic ${i + 1}`, goal_vi: `Mục tiêu AI ${i + 1}` }))

  it('nhập đủ 12 tuần: dùng nguyên, KHÔNG gọi AI', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const p = await buildCustomPlan(env, 'A0', ok(lines(12)))
    expect(f).not.toHaveBeenCalled()
    expect(p).toMatchObject({ source: 'custom', filled_weeks: 0 })
    expect(p.weeks.map((w) => w.topic)).toEqual(Array.from({ length: 12 }, (_, i) => `Chủ đề ${i + 1}`))
    expect(p.weeks.map((w) => w.week)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })
  it('nhập 3 tuần: giữ 3 tuần đầu đúng thứ tự, 9 tuần sau do AI nối tiếp', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ weeks: aiWeeks }) }] } }] })))
    const p = await buildCustomPlan(env, 'A0', ok('Mine 1\nMine 2\nMine 3'))
    expect(p.weeks).toHaveLength(WEEKS)
    expect(p.weeks.slice(0, 3).map((w) => w.topic)).toEqual(['Mine 1', 'Mine 2', 'Mine 3'])
    expect(p.weeks[3].topic).toBe('AI topic 1')
    expect(p.weeks[11].topic).toBe('AI topic 9')
    expect(p.filled_weeks).toBe(9)
    expect(p.fallback_reason).toBeUndefined()
  })
  it('AI lỗi: nối bằng bộ chủ đề mặc định của mức đã chọn, báo lý do, không trùng chủ đề đã nhập', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    const first = defaultPlan('A0')[0].topic // người học nhập trùng một chủ đề mặc định
    const p = await buildCustomPlan(env, 'A0', ok(first))
    expect(p.weeks).toHaveLength(WEEKS)
    expect(p.fallback_reason).toBe('rate')
    expect(new Set(p.weeks.map((w) => w.topic.toLowerCase())).size).toBe(WEEKS)
    expect(p.weeks[0].topic).toBe(first)
  })
})

describe('POST /api/plan — chọn mức bắt đầu + lộ trình riêng', () => {
  const SECRET = 'test-secret-test-secret-test-secret'
  let env: Env
  let fetchFn: ReturnType<typeof vi.fn>
  beforeEach(() => {
    env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: createTestDb() } as Env
    fetchFn = vi.fn(async () => new Response('', { status: 429 })) // AI lỗi → bộ mặc định
    vi.stubGlobal('fetch', fetchFn)
  })
  afterEach(() => vi.unstubAllGlobals())

  const post = async (body: unknown) =>
    app.request('/api/plan', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` } }, env)
  const get = async () => (await app.request('/api/plan', { headers: { cookie: `ea_session=${await makeToken(SECRET)}` } }, env)).json() as Promise<any>
  const q = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).all<T>().then((r) => r.results)
  const placement = (level: string) => env.DB.prepare('INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,?,?)').bind(level, todayVN()).run()

  it('chưa làm bài kiểm tra nhưng chọn mức A0 → tạo được lộ trình mức A0, placement_id rỗng', async () => {
    const r = await post({ level: 'A0' })
    expect(r.status).toBe(200)
    expect((await r.json()) as any).toMatchObject({ level: 'A0', sessions: 60 })
    expect((await q<any>("SELECT level, placement_id FROM plans WHERE status='active'"))[0]).toEqual({ level: 'A0', placement_id: null })
    expect(await q('SELECT 1 FROM plan_weeks')).toHaveLength(12)
  })
  it('đã kiểm tra ra B1 nhưng người học chọn A0 (mới bắt đầu) → dùng A0, vẫn ghi lần kiểm tra', async () => {
    await placement('B1')
    const r = await post({ level: 'A0' })
    expect(((await r.json()) as any).level).toBe('A0')
    const plan = (await q<any>("SELECT level, placement_id FROM plans WHERE status='active'"))[0]
    expect(plan.level).toBe('A0')
    expect(plan.placement_id).not.toBeNull()
  })
  it('không chọn mức → lấy mức từ bài kiểm tra như cũ; không có cả hai → 400', async () => {
    expect((await post({})).status).toBe(400)
    await placement('A2')
    expect(((await (await post({})).json()) as any).level).toBe('A2')
  })
  it('mức không hợp lệ → 400', async () => {
    for (const level of ['C1', 'a0', 5, null]) {
      const r = await post({ level })
      expect(r.status, String(level)).toBe(400)
      expect(((await r.json()) as any).error).toBe('bad_level')
    }
  })
  it('mức bắt đầu quyết định bộ chủ đề (AI lỗi → bộ mặc định đúng mức)', async () => {
    await post({ level: 'A0' })
    const topics = (await q<{ topic: string }>('SELECT topic FROM plan_weeks ORDER BY week_no')).map((t) => t.topic)
    expect(topics).toEqual(defaultPlan('A0').map((w) => w.topic))
  })
  it('lộ trình riêng 12 tuần: lưu đúng chủ đề + mục tiêu, nguồn custom, không gọi AI', async () => {
    const custom = Array.from({ length: 12 }, (_, i) => `My topic ${i + 1} | Mục tiêu ${i + 1}`).join('\n')
    const r = await post({ level: 'A1', custom })
    expect((await r.json()) as any).toMatchObject({ source: 'custom', filled_weeks: 0, level: 'A1' })
    expect(fetchFn).not.toHaveBeenCalled()
    const weeks = await q<any>('SELECT week_no, topic, goal_vi FROM plan_weeks ORDER BY week_no')
    expect(weeks[0]).toEqual({ week_no: 1, topic: 'My topic 1', goal_vi: 'Mục tiêu 1' })
    expect(weeks[11].topic).toBe('My topic 12')
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(60)
  })
  it('lộ trình riêng ngắn hơn 12 tuần: nối cho đủ 12, báo số tuần nối thêm và lý do khi AI lỗi', async () => {
    const r = await post({ level: 'A0', custom: 'Alpha\nBeta' })
    expect((await r.json()) as any).toMatchObject({ source: 'custom', filled_weeks: 10, fallback_reason: 'rate' })
    const topics = (await q<{ topic: string }>('SELECT topic FROM plan_weeks ORDER BY week_no')).map((t) => t.topic)
    expect(topics).toHaveLength(12)
    expect(topics.slice(0, 2)).toEqual(['Alpha', 'Beta'])
  })
  it('lộ trình riêng không hợp lệ → 400 kèm thông báo tiếng Việt, KHÔNG thay lộ trình đang có', async () => {
    await post({ level: 'A0' })
    const before = await q<any>("SELECT id FROM plans WHERE status='active'")
    for (const custom of ['\n\n', Array.from({ length: 13 }, (_, i) => `T${i}`).join('\n'), 123]) {
      const r = await post({ level: 'A0', custom, replace: true })
      expect(r.status).toBe(400)
      expect(((await r.json()) as any).error).toBe('bad_custom')
    }
    expect(await q<any>("SELECT id FROM plans WHERE status='active'")).toEqual(before)
  })
  it('custom rỗng ("") được coi như không nhập: AI lập như thường', async () => {
    const r = await post({ level: 'A0', custom: '' })
    expect((await r.json()) as any).toMatchObject({ source: 'default' })
  })
  it('đang có lộ trình chưa xong: vẫn cần replace=true mới thay (áp dụng cả khi chọn mức/lộ trình riêng)', async () => {
    await post({ level: 'A0' })
    const r = await post({ level: 'A1', custom: 'X' })
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).error).toBe('plan_exists')
    const r2 = await post({ level: 'A1', custom: 'X', replace: true })
    expect(r2.status).toBe(200)
    expect((await q<any>("SELECT level FROM plans WHERE status='active'"))[0].level).toBe('A1')
  })
  it('GET /api/plan khi chưa có lộ trình: trả mức của bài kiểm tra gần nhất để giao diện gợi ý', async () => {
    expect(await get()).toMatchObject({ plan: null, has_placement: false, placement_level: null })
    await placement('A1')
    expect(await get()).toMatchObject({ plan: null, has_placement: true, placement_level: 'A1' })
  })
  it('lộ trình tạo không cần bài kiểm tra vẫn xem được và đọc được (GET /api/plan)', async () => {
    await post({ level: 'A0' })
    const d = await get()
    expect(d.plan).toMatchObject({ level: 'A0', total: 60 })
    expect(d.weeks).toHaveLength(12)
  })
})


describe('parseCustomPlan — file Markdown', () => {
  const md = (...l: string[]) => l.join(NL)
  it('tiêu đề tài liệu (# một lần) bị bỏ; các tiêu đề ## là các tuần; mô tả dưới tiêu đề bị bỏ', () => {
    const w = ok(md('# Lộ trình học tiếng Anh', '', 'Mô tả chung.', '## Tuần 1: Greetings', '- nói xin chào', '- tự giới thiệu', '## Tuần 2: Numbers', '- đếm 1-100'))
    expect(w.map((x) => x.topic)).toEqual(['Greetings', 'Numbers'])
  })
  it('tiêu đề ## không có chữ "Tuần": cấp xuất hiện từ 2 lần là các tuần, ### con bị bỏ', () => {
    const w = ok(md('# Kế hoạch', '## Greetings', '### Từ vựng', '## Food', '### Ngữ pháp', '## Travel'))
    expect(w.map((x) => x.topic)).toEqual(['Greetings', 'Food', 'Travel'])
  })
  it('chỉ có đúng một tiêu đề → tiêu đề đó là một tuần', () => {
    expect(ok('# Only topic').map((x) => x.topic)).toEqual(['Only topic'])
  })
  it('bảng Markdown: bỏ hàng tiêu đề + dòng ---, bỏ cột số tuần, cột 2 là mục tiêu', () => {
    const w = ok(md('| Tuần | Chủ đề | Mục tiêu |', '|---|---|---|', '| 1 | Greetings | Chào hỏi |', '| 2 | **Numbers** | Đếm số |', '| Tuần 3 | Food |  |'))
    expect(w).toEqual([
      { topic: 'Greetings', goal_vi: 'Chào hỏi' },
      { topic: 'Numbers', goal_vi: 'Đếm số' },
      { topic: 'Food', goal_vi: 'Học theo lộ trình của bạn' },
    ])
  })
  it('bảng không có cột số tuần: cột 1 là chủ đề', () => {
    expect(ok(md('| Chủ đề | Mục tiêu |', '| :-- | :-- |', '| Greetings | Chào hỏi |')).map((x) => x.topic)).toEqual(['Greetings'])
  })
  it('bỏ ký hiệu Markdown: đậm, nghiêng, mã, liên kết, trích dẫn; bỏ khối ```mã```', () => {
    const w = ok(md('- **Greetings** | _Chào_ `hỏi`', '> Food & [drinks](https://x.com)', '```', 'bỏ qua dòng này', '```', '---'))
    expect(w).toEqual([
      { topic: 'Greetings', goal_vi: 'Chào hỏi' },
      { topic: 'Food & drinks', goal_vi: 'Học theo lộ trình của bạn' },
    ])
  })
  it('BOM đầu file và CRLF không ảnh hưởng', () => {
    const CR = String.fromCharCode(13)
    expect(ok(String.fromCharCode(0xfeff) + '## A' + CR + NL + '## B' + CR + NL).map((x) => x.topic)).toEqual(['A', 'B'])
  })
  it('nhiều hơn 12 tuần → lỗi nêu số tuần tìm thấy; không âm thầm cắt bớt', () => {
    const r = parseCustomPlan(Array.from({ length: 15 }, (_, i) => `## Tuần ${i + 1}: T${i}`).join(NL))
    expect(r).toMatchObject({ ok: false })
    expect((r as { message: string }).message).toContain('15')
  })
})

describe('POST /api/plan/preview', () => {
  const SECRET = 'test-secret-test-secret-test-secret'
  const env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: createTestDb() } as Env
  const preview = async (body: unknown, authed = true) =>
    app.request('/api/plan/preview', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) } }, env)

  it('trả các tuần đọc được + số tuần AI sẽ nối thêm; không ghi vào CSDL', async () => {
    const r = await preview({ custom: ['## Tuần 1: A | Mục tiêu A', '## Tuần 2: B'].join(NL) })
    expect(r.status).toBe(200)
    expect((await r.json()) as any).toEqual({ weeks: [{ topic: 'A', goal_vi: 'Mục tiêu A' }, { topic: 'B', goal_vi: 'Học theo lộ trình của bạn' }], to_fill: 10 })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM plans').first<{ n: number }>())!.n).toBe(0)
  })
  it('không đọc được → 400 kèm thông báo; không phải văn bản → 400; chưa đăng nhập → 401', async () => {
    const r = await preview({ custom: '   ' })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).message).toContain('Không tìm thấy chủ đề')
    expect((await preview({ custom: 5 })).status).toBe(400)
    expect((await preview({ custom: 'A' }, false)).status).toBe(401)
  })
})
