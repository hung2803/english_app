import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { MAX_ISSUES, normalizeCorrection } from './chat'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

const LESSON = {
  title: 'Ordering food', source: { type: 'ai', title: 'AI', ai_written: true }, excerpt: 'Can I have a coffee?',
  summary_vi: 's', explanation_vi: 'e',
  vocab: ['menu', 'bill', 'waiter', 'order', 'tip'].map((w) => ({ word: w, meaning_vi: 'm' })),
  grammar: [{ point: 'p', explanation_vi: 'e' }],
}
const FIXED = {
  corrected: 'I went to the market yesterday.',
  issues: [{ original: 'I go to the market yesterday', fixed: 'I went to the market yesterday', explanation_vi: 'Có "yesterday" nên dùng thì quá khứ đơn: go → went.' }],
}
const J = (reply: string, correction: unknown) => JSON.stringify({ reply, correction })

let sent: { contents: { role: string; parts: { text: string }[] }[]; systemInstruction?: { parts: { text: string }[] } }[]
let model: string | (() => Response)
function stubAi() {
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(init?.body as string))
      return typeof model === 'function' ? model() : Response.json({ candidates: [{ content: { parts: [{ text: model }] } }] })
    }),
  )
}

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  expect((await call('/api/plan', {})).status).toBe(200)
  await db.prepare('UPDATE sessions SET lesson_json = ? WHERE seq = 1').bind(JSON.stringify(LESSON)).run()
  model = J('Nice!', { corrected: '', issues: [] })
  stubAi()
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
const sid = async () => (await db.prepare('SELECT id FROM sessions WHERE seq = 1').first<{ id: number }>())!.id
const say = async (message: unknown) => call(`/api/sessions/${await sid()}/chat`, { message })
const history = async () => json(await call(`/api/sessions/${await sid()}/chat`))
const rowCount = async () => (await db.prepare('SELECT COUNT(*) n FROM chat_messages').first<{ n: number }>())!.n

describe('normalizeCorrection', () => {
  it('có lỗi hợp lệ → has_errors, giữ câu đã sửa', () => {
    expect(normalizeCorrection(FIXED, 'x')).toEqual({ has_errors: true, corrected: FIXED.corrected, issues: FIXED.issues })
  })
  it('không có lỗi (rỗng / thiếu) → has_errors=false', () => {
    expect(normalizeCorrection({ issues: [] }, 'x')).toEqual({ has_errors: false, corrected: '', issues: [] })
    expect(normalizeCorrection({}, 'x')).toEqual({ has_errors: false, corrected: '', issues: [] })
    expect(normalizeCorrection({ corrected: 'abc', issues: 'x' }, 'x')).toEqual({ has_errors: false, corrected: '', issues: [] })
  })
  it('không phải object → null', () => {
    for (const bad of [null, undefined, 'x', 5, true]) expect(normalizeCorrection(bad, 'x')).toBeNull()
  })
  it('chỉ giữ lỗi đủ original + fixed + giải thích và có thay đổi thật', () => {
    const r = normalizeCorrection({
      corrected: 'ok',
      issues: [
        { original: 'a', fixed: 'a', explanation_vi: 'không đổi' },
        { original: 'b', fixed: 'c', explanation_vi: '' },
        { original: '', fixed: 'c', explanation_vi: 'x' },
        { original: 'd', fixed: '', explanation_vi: 'x' },
        { original: 'e', fixed: 'f', explanation_vi: 'đúng' },
        null, 'x', 7,
      ],
    }, 'x')
    expect(r!.issues).toEqual([{ original: 'e', fixed: 'f', explanation_vi: 'đúng' }])
  })
  it(`tối đa ${MAX_ISSUES} lỗi, giữ thứ tự AI đưa (quan trọng nhất trước)`, () => {
    const issues = Array.from({ length: 9 }, (_, i) => ({ original: `bad${i}`, fixed: `good${i}`, explanation_vi: `vì ${i}` }))
    const r = normalizeCorrection({ corrected: 'x', issues }, 'x')!
    expect(r.issues.map((i) => i.original)).toEqual(['bad0', 'bad1', 'bad2', 'bad3', 'bad4'])
  })
  it('thiếu câu hoàn chỉnh → ghép từ các lỗi trên câu gốc', () => {
    const r = normalizeCorrection({ issues: [{ original: 'I go', fixed: 'I went', explanation_vi: 'thì quá khứ' }] }, 'I go home yesterday')!
    expect(r.corrected).toBe('I went home yesterday')
  })
  it('cắt độ dài các trường', () => {
    const r = normalizeCorrection({ corrected: 'c'.repeat(5000), issues: [{ original: 'o'.repeat(999), fixed: 'f'.repeat(999), explanation_vi: 'e'.repeat(999) }] }, 'x')!
    expect(r.issues[0].original).toHaveLength(200)
    expect(r.issues[0].fixed).toHaveLength(200)
    expect(r.issues[0].explanation_vi).toHaveLength(300)
    expect(r.corrected.length).toBeLessThanOrEqual(1000)
  })
  it('khoảng trắng thừa bị bỏ; tiếng Việt có dấu giữ nguyên', () => {
    const r = normalizeCorrection({ corrected: '  She likes tea.  ', issues: [{ original: ' She like ', fixed: ' She likes ', explanation_vi: '  Ngôi thứ ba số ít thêm -s.  ' }] }, 'x')!
    expect(r.corrected).toBe('She likes tea.')
    expect(r.issues[0]).toEqual({ original: 'She like', fixed: 'She likes', explanation_vi: 'Ngôi thứ ba số ít thêm -s.' })
  })
})

describe('POST /chat — sửa lỗi câu người học viết', () => {
  it('câu có lỗi: trả về câu đã sửa + từng lỗi kèm giải thích tiếng Việt', async () => {
    model = J('Nice! What did you buy?', FIXED)
    const { user, assistant } = await json(await say('I go to the market yesterday'))
    expect(user.correction).toEqual({ has_errors: true, corrected: 'I went to the market yesterday.', issues: FIXED.issues })
    expect(assistant.content).toBe('Nice! What did you buy?')
    expect(assistant.correction).toBeUndefined() // chỉ tin của người học mới có phần sửa
  })

  it('câu đúng: has_errors=false', async () => {
    model = J('Great!', { corrected: '', issues: [] })
    expect((await json(await say('I went to the market yesterday.'))).user.correction).toEqual({ has_errors: false, corrected: '', issues: [] })
  })

  it('AI vừa trả lời vừa sửa lỗi trong MỘT lần gọi', async () => {
    model = J('Nice!', FIXED)
    await say('I go to the market yesterday')
    expect(sent).toHaveLength(1)
  })

  it('đề bài yêu cầu giải thích bằng tiếng Việt, chỉ sửa lỗi thật, bỏ qua sở thích văn phong', async () => {
    await say('hello')
    const sys = sent[0].systemInstruction!.parts[0].text
    expect(sys).toContain('"explanation_vi" fields are in VIETNAMESE')
    expect(sys).toContain('real mistakes')
    expect(sys).toContain('Ignore style preferences')
    expect(sys).toContain('not English')
  })

  it('LƯU phần sửa lỗi cùng tin nhắn; xem lại lịch sử vẫn thấy', async () => {
    model = J('Nice!', FIXED)
    await say('I go to the market yesterday')
    const [mine, ai] = (await history()).messages
    expect(mine.correction).toMatchObject({ has_errors: true, corrected: 'I went to the market yesterday.' })
    expect(mine.correction.issues[0].explanation_vi).toContain('thì quá khứ đơn')
    expect(ai.correction).toBeUndefined()
    const rows = (await db.prepare('SELECT role, corrections_json FROM chat_messages ORDER BY id').all<any>()).results
    expect(JSON.parse(rows[0].corrections_json).has_errors).toBe(true)
    expect(rows[1].corrections_json).toBeNull()
  })

  it('AI thiếu/sai phần sửa lỗi: vẫn chat được, correction = null (UI không hiện)', async () => {
    for (const bad of [undefined, null, 'oops', 42, []]) {
      model = JSON.stringify({ reply: 'Still fine.', correction: bad })
      const r = await json(await say('hello ' + String(bad)))
      expect(r.assistant.content).toBe('Still fine.')
      expect(r.user.correction).toBeNull()
    }
    expect(await rowCount()).toBe(10)
  })

  it('AI trả thiếu reply → 503, không lưu gì (kể cả phần sửa)', async () => {
    model = JSON.stringify({ correction: FIXED })
    expect((await say('hello')).status).toBe(503)
    expect(await rowCount()).toBe(0)
  })

  it('AI trả văn bản thường, không phải JSON → 503, không lưu gì', async () => {
    model = () => Response.json({ candidates: [{ content: { parts: [{ text: 'Just plain text.' }] } }] })
    expect((await say('hello')).status).toBe(503)
    expect(await rowCount()).toBe(0)
  })

  it('AI bọc JSON trong khối markdown vẫn đọc được', async () => {
    const fenced = '```json\n' + J('Fenced reply.', FIXED) + '\n```'
    model = () => Response.json({ candidates: [{ content: { parts: [{ text: fenced }] } }] })
    const r = await json(await say('I go to the market yesterday'))
    expect(r.assistant.content).toBe('Fenced reply.')
    expect(r.user.correction.has_errors).toBe(true)
  })

  it('tiếng Việt / không phải tiếng Anh: AI mời viết tiếng Anh, không sinh lỗi sửa', async () => {
    model = J('Can you try in English? Say it in a short sentence.', { corrected: '', issues: [] })
    const r = await json(await say('Tôi thích cà phê'))
    expect(r.user.correction).toEqual({ has_errors: false, corrected: '', issues: [] })
    expect(r.assistant.content).toContain('try in English')
  })

  it('lịch sử gửi cho AI là câu GỐC của người học (không phải câu đã sửa)', async () => {
    model = J('Nice!', FIXED)
    await say('I go to the market yesterday')
    model = J('And then?', { corrected: '', issues: [] })
    await say('I buy fish')
    expect(sent[1].contents.slice(0, 2).map((c) => [c.role, c.parts[0].text])).toEqual([
      ['user', 'I go to the market yesterday'],
      ['model', 'Nice!'],
    ])
  })

  it('chỉ sửa lỗi của tin nhắn VỪA GỬI, không "sửa lại" tin cũ', async () => {
    model = J('Nice!', FIXED)
    await say('I go to the market yesterday')
    model = J('Ok.', { corrected: '', issues: [] })
    await say('I like fish.')
    const msgs = (await history()).messages.filter((m: any) => m.role === 'user')
    expect(msgs[0].correction.has_errors).toBe(true)
    expect(msgs[1].correction.has_errors).toBe(false)
  })

  it('tin nhắn cũ chưa từng được chấm (corrections_json rỗng) → correction null', async () => {
    await db.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', 'old', ?)").bind(await sid(), new Date().toISOString()).run()
    expect((await history()).messages[0].correction).toBeNull()
  })
})
