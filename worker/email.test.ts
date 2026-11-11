import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { saveProposal } from './adjustment-store'
import { addDays, todayVN } from './dates'
import { appBase, buildWeeklyEmail, escapeHtml, retryPendingEmails, sendEmail, sendWeeklyEmail } from './email'
import { runScheduled } from './cron'
import type { QuizItem } from './quiz'
import { lessonJson } from './test-fixtures'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
const TODAY = todayVN()
let env: Env
let db: D1Database

const MAIL = { RESEND_API_KEY: 're_secret_key_123', EMAIL_FROM: 'English Coach <onboarding@resend.dev>', EMAIL_TO: 'me@example.com', APP_URL: 'https://english.example.dev' }

type MailCall = { url: string; headers: Record<string, string>; body: any }
let mails: MailCall[]
let mailStatus: number | Error
let ai: { week: unknown } | null

const LESSON = lessonJson()
const QUIZ = LESSON.quiz as QuizItem[]
const ALL = QUIZ.map((q) => q.answer as number | string)

beforeEach(async () => {
  mails = []
  mailStatus = 200
  ai = { week: { summary_vi: 'Tuần này bạn còn yếu từ vựng nhà hàng.', changes: [{ week_no: 3, topic: 'Review: restaurant words', goal_vi: 'Ôn từ vựng nhà hàng' }] } }
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db, ...MAIL } as Env
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('resend.com')) {
        if (mailStatus instanceof Error) throw mailStatus
        mails.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(init?.body as string) })
        return new Response(mailStatus === 200 ? '{"id":"x"}' : '{"message":"boom"}', { status: mailStatus })
      }
      const text = JSON.parse(init?.body as string).contents[0].parts[0].text as string
      if (text.includes('curriculum designer')) return new Response('', { status: 429 })
      if (!ai) return new Response('', { status: 429 })
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(ai.week) }] } }] })
    }),
  )
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(TODAY).run()
  expect((await post('/api/plan', {})).status).toBe(200)
  await db.prepare('UPDATE sessions SET lesson_json = ?').bind(JSON.stringify(LESSON)).run()
})
afterEach(() => vi.unstubAllGlobals())

async function post(path: string, body: unknown, e: Env = env) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: JSON.stringify(body) }, e)
}
const sid = async (seq: number) => (await db.prepare('SELECT id FROM sessions WHERE seq = ?').bind(seq).first<{ id: number }>())!.id
const submit = async (seq: number, answers: unknown = ALL) => post(`/api/sessions/${await sid(seq)}/quiz`, { answers })
const week1 = async () => {
  for (let s = 1; s <= 5; s++) expect((await submit(s)).status).toBe(200)
}
const adj = async () => (await db.prepare('SELECT * FROM plan_adjustments ORDER BY id').all<any>()).results

/* ============================================================ */
describe('escapeHtml / appBase', () => {
  it('escape 5 ký tự nguy hiểm', () => expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'))
  it('appBase: https hoặc localhost; bỏ dấu / cuối; còn lại null', () => {
    expect(appBase('https://english.example.dev/')).toBe('https://english.example.dev')
    expect(appBase('https://x.dev/app//')).toBe('https://x.dev/app')
    expect(appBase('http://localhost:5173')).toBe('http://localhost:5173')
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'ftp://x.com', 'x.com', '', '   ', undefined, 'https://', 'https://a b.com', 'http://localhost.evil.com']) expect(appBase(bad as any), String(bad)).toBeNull()
  })
})

describe('sendEmail — Resend', () => {
  const msg = { subject: 'Chủ đề', html: '<p>x</p>', text: 'x' }

  it('POST tới Resend với Bearer, từ/đến đúng, nội dung html + text', async () => {
    await sendEmail(env, msg)
    expect(mails).toHaveLength(1)
    expect(mails[0].url).toBe('https://api.resend.com/emails')
    expect(mails[0].headers.authorization).toBe('Bearer re_secret_key_123')
    expect(mails[0].body).toEqual({ from: MAIL.EMAIL_FROM, to: ['me@example.com'], subject: 'Chủ đề', html: '<p>x</p>', text: 'x' })
  })
  it('có khóa chống gửi trùng khi truyền idempotencyKey', async () => {
    await sendEmail(env, msg, 'weekly-1-1')
    expect(mails[0].headers['Idempotency-Key']).toBe('weekly-1-1')
  })
  it('thiếu cấu hình → lỗi nêu tên khóa thiếu, không gọi mạng', async () => {
    await expect(sendEmail({ ...env, RESEND_API_KEY: '', EMAIL_TO: '' } as Env, msg)).rejects.toThrow(/RESEND_API_KEY, EMAIL_TO/)
    expect(mails).toHaveLength(0)
  })
  it('Resend trả lỗi → EmailError có mã, KHÔNG lộ khóa API', async () => {
    mailStatus = 403
    const err = await sendEmail(env, msg).catch((e) => e)
    expect(err.message).toContain('403')
    expect(err.message).not.toContain('re_secret_key_123')
  })
  it('lỗi mạng → EmailError', async () => {
    mailStatus = new TypeError('network')
    await expect(sendEmail(env, msg)).rejects.toThrow('Không gọi được dịch vụ email')
  })
})

/* ============================================================ */
describe('buildWeeklyEmail — nội dung', () => {
  const data = { weekNo: 1, scores: [100, 63, 38, 25, 75], average: 60, lowCount: 3, weekWords: [{ word: 'waiter', sessions: 3 }, { word: 'menu', sessions: 2 }] }
  const withChanges = { week_no: 1, status: 'pending' as const, summary_vi: 'Bạn còn yếu từ vựng nhà hàng.', changes: [{ week_no: 3, topic: 'Review: restaurant words', goal_vi: 'Ôn từ vựng nhà hàng' }, { week_no: 4, topic: 'Past tense', goal_vi: 'Luyện thì quá khứ' }] }
  const none = { ...withChanges, status: 'no_change' as const, changes: [], summary_vi: 'Tuần rất tốt.' }

  it('tiêu đề nêu tuần và điểm trung bình', () => {
    expect(buildWeeklyEmail(withChanges, data, null).subject).toBe('Tổng kết tuần 1: điểm quiz trung bình 60%')
    expect(buildWeeklyEmail(withChanges, { ...data, average: null, scores: [] }, null).subject).toBe('Tổng kết tuần 1')
  })
  it('nêu điểm từng buổi, trung bình, số buổi dưới 70%, từ làm sai, nhận xét của AI', () => {
    const { html, text } = buildWeeklyEmail(withChanges, data, null)
    for (const t of [html, text]) {
      expect(t).toContain('100%, 63%, 38%, 25%, 75%')
      expect(t).toContain('60%')
      expect(t).toContain('3 buổi dưới 70%')
      expect(t).toContain('waiter, menu')
      expect(t).toContain('Bạn còn yếu từ vựng nhà hàng.')
    }
  })
  it('có đề xuất: liệt kê từng thay đổi kèm mục tiêu, nhắc "không duyệt thì giữ lộ trình cũ", có nút duyệt trỏ tới /adjustments', () => {
    const { html, text } = buildWeeklyEmail(withChanges, data, 'https://english.example.dev')
    for (const t of [html, text]) {
      expect(t).toContain('Tuần 3')
      expect(t).toContain('Review: restaurant words')
      expect(t).toContain('Ôn từ vựng nhà hàng')
      expect(t).toContain('Tuần 4')
      expect(t).toContain('Nếu bạn không duyệt, lộ trình cũ được giữ nguyên')
      expect(t).toContain('https://english.example.dev/adjustments')
    }
    expect(html).toContain('Xem và duyệt trong ứng dụng')
    expect(text).toContain('Xem và duyệt:')
  })
  it('không có đề xuất: nói rõ không đổi gì, không có lời mời duyệt', () => {
    const { html, text } = buildWeeklyEmail(none, data, 'https://english.example.dev')
    expect(text).toContain('AI không đề xuất thay đổi lộ trình.')
    expect(html).toContain('AI không đề xuất thay đổi lộ trình tuần này.')
    expect(html + text).not.toContain('Xem và duyệt')
    expect(html + text).not.toContain('không duyệt')
    expect(html).toContain('Mở ứng dụng')
  })
  it('thiếu địa chỉ app hợp lệ: vẫn có nội dung, chỉ không có link', () => {
    const { html, text } = buildWeeklyEmail(withChanges, data, null)
    expect(html).not.toContain('href=')
    expect(text).not.toContain('http')
  })
  it('chưa có điểm: ghi "chưa có điểm"', () => {
    expect(buildWeeklyEmail(none, { ...data, scores: [], average: null, weekWords: [] }, null).text).toContain('chưa có điểm')
  })
  it('nội dung do AI sinh ra được escape trong HTML (chống chèn mã / lừa link)', () => {
    const evil = { ...withChanges, summary_vi: '<script>alert(1)</script>', changes: [{ week_no: 3, topic: '<img src=x onerror=alert(1)>', goal_vi: '"><a href="https://evil.com">click</a>' }] }
    const { html } = buildWeeklyEmail(evil, { ...data, weekWords: [{ word: '<b>x</b>', sessions: 1 }] }, 'https://english.example.dev')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>x</b>')
    expect(html).not.toContain('href="https://evil.com"')
    expect(html).toContain('&lt;script&gt;')
  })
  it('chỉ có đúng một link (nút duyệt) — không có link nào từ nội dung AI', () => {
    const { html } = buildWeeklyEmail(withChanges, data, 'https://english.example.dev')
    expect((html.match(/href=/g) ?? []).length).toBe(1)
  })
})

/* ============================================================ */
describe('gửi email sau buổi thứ 5 (tạo đề xuất → gửi)', () => {
  it('buổi thứ 5 xong → đề xuất được tạo và email gửi NGAY, đúng một lần', async () => {
    await week1()
    expect(mails).toHaveLength(1)
    const m = mails[0]
    expect(m.body.to).toEqual(['me@example.com'])
    expect(m.body.subject).toBe('Tổng kết tuần 1: điểm quiz trung bình 100%')
    expect(m.body.html).toContain('Review: restaurant words')
    expect(m.body.html).toContain('https://english.example.dev/adjustments')
    expect(m.headers['Idempotency-Key']).toBe('weekly-1-1')
    expect((await adj())[0].emailed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('4 buổi đầu không gửi email', async () => {
    for (let s = 1; s <= 4; s++) await submit(s)
    expect(mails).toHaveLength(0)
  })

  it('gửi cả khi AI thấy không cần đổi (vẫn là tổng kết tuần)', async () => {
    ai = { week: { summary_vi: 'Tuần rất tốt.', changes: [] } }
    await week1()
    expect(mails).toHaveLength(1)
    expect(mails[0].body.text).toContain('AI không đề xuất thay đổi lộ trình.')
  })

  it('email dùng điểm và từ làm sai THẬT của tuần', async () => {
    const wrong = QUIZ.map((q) => (q.type === 'mcq' ? ((q.answer as number) + 1) % 4 : 'wrong'))
    for (let s = 1; s <= 4; s++) await submit(s, ALL)
    await submit(5, wrong)
    expect(mails[0].body.text).toContain('100%, 100%, 100%, 100%, 0%')
    expect(mails[0].body.text).toContain('1 buổi dưới 70%')
    expect(mails[0].body.text).toMatch(/Từ làm sai: .*bill/)
  })

  it('tuần 2 xong → email riêng cho tuần 2; tuần 1 không gửi lại', async () => {
    await week1()
    for (let s = 6; s <= 10; s++) await submit(s)
    expect(mails.map((m) => m.body.subject.slice(0, 15))).toEqual(['Tổng kết tuần 1', 'Tổng kết tuần 2'])
  })

  it('chưa cấu hình email: bỏ qua im lặng, đề xuất vẫn tạo, emailed_at trống để gửi sau khi cấu hình', async () => {
    env = { ...env, RESEND_API_KEY: '' } as Env
    await week1()
    expect(mails).toHaveLength(0)
    expect((await adj())[0]).toMatchObject({ week_no: 1, status: 'pending', emailed_at: null })
  })

  it('Resend lỗi: quiz và đề xuất vẫn bình thường, emailed_at trống (không báo đã gửi sai)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mailStatus = 500
    await week1()
    expect((await adj())[0]).toMatchObject({ status: 'pending', emailed_at: null })
    expect((await db.prepare("SELECT status FROM sessions WHERE seq = 5").first<any>()).status).toBe('done')
  })

  it('mạng tới Resend đứt: như trên, không ném lỗi', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mailStatus = new TypeError('network')
    await week1()
    expect((await adj())[0].emailed_at).toBeNull()
  })

  it('AI điều chỉnh lỗi: không có đề xuất thì không gửi email', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ai = null
    await week1()
    expect(await adj()).toEqual([])
    expect(mails).toHaveLength(0)
  })
})

describe('sendWeeklyEmail — đúng một lần', () => {
  const makeAdj = async () => (await saveProposal(db, 1, { week_no: 1, summary_vi: 'Tóm tắt.', changes: [{ week_no: 3, topic: 'T', goal_vi: 'G' }] })).adjustment.id

  it('gửi lần đầu → sent; lần hai → already_sent, không gọi Resend nữa', async () => {
    const id = await makeAdj()
    expect(await sendWeeklyEmail(env, id)).toBe('sent')
    expect(await sendWeeklyEmail(env, id)).toBe('already_sent')
    expect(mails).toHaveLength(1)
  })
  it('hai lần gọi đồng thời: chỉ MỘT email', async () => {
    const id = await makeAdj()
    const r = await Promise.all([sendWeeklyEmail(env, id), sendWeeklyEmail(env, id)])
    expect(r.sort()).toEqual(['already_sent', 'sent'])
    expect(mails).toHaveLength(1)
  })
  it('gửi lỗi → trả lại quyền gửi (emailed_at về trống), lần sau gửi lại được', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = await makeAdj()
    mailStatus = 500
    expect(await sendWeeklyEmail(env, id)).toBe('failed')
    expect((await adj())[0].emailed_at).toBeNull()
    mailStatus = 200
    expect(await sendWeeklyEmail(env, id)).toBe('sent')
  })
  it('chưa cấu hình → not_configured; id lạ → not_found', async () => {
    const id = await makeAdj()
    expect(await sendWeeklyEmail({ ...env, EMAIL_TO: '' } as Env, id)).toBe('not_configured')
    expect(await sendWeeklyEmail(env, 99999)).toBe('not_found')
  })
  it('ghi nhật ký gửi (notification_log) khi thành công', async () => {
    await sendWeeklyEmail(env, await makeAdj())
    expect((await db.prepare("SELECT kind, day FROM notification_log WHERE kind = 'weekly_email'").all<any>()).results).toEqual([{ kind: 'weekly_email', day: TODAY }])
  })
})

describe('gửi lại email chưa gửi được (cron)', () => {
  const mk = (week: number, created = TODAY) =>
    db.prepare("INSERT INTO plan_adjustments (plan_id, week_no, summary_vi, changes_json, created_at) VALUES (1, ?, 's', '[]', ?)").bind(week, created).run()

  it('gửi các email còn trống emailed_at; không gửi lại cái đã gửi', async () => {
    await mk(1)
    await mk(2)
    await db.prepare("UPDATE plan_adjustments SET emailed_at = '2026-01-01T00:00:00Z' WHERE week_no = 1").run()
    expect(await retryPendingEmails(env)).toEqual({ sent: 1, failed: 0 })
    expect(mails).toHaveLength(1)
    expect(mails[0].headers['Idempotency-Key']).toBe('weekly-1-2')
  })
  it('bỏ qua đề xuất quá cũ (> 7 ngày) để không gửi email cũ', async () => {
    await mk(1, addDays(TODAY, -9))
    expect(await retryPendingEmails(env)).toEqual({ sent: 0, failed: 0 })
    expect(mails).toHaveLength(0)
  })
  it('Resend vẫn lỗi: đếm failed, giữ lại để lần sau', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mk(1)
    mailStatus = 500
    expect(await retryPendingEmails(env)).toEqual({ sent: 0, failed: 1 })
    expect((await adj())[0].emailed_at).toBeNull()
  })
  it('chưa cấu hình email → không làm gì', async () => {
    await mk(1)
    expect(await retryPendingEmails({ ...env, RESEND_API_KEY: '' } as Env)).toEqual({ sent: 0, failed: 0 })
  })
  it('cron tự gửi lại email bị lỗi lúc trước khi Resend hồi phục', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mailStatus = 500
    await week1()
    expect((await adj())[0].emailed_at).toBeNull() // lần gửi đầu hỏng
    mails.length = 0
    mailStatus = 200
    const r = await runScheduled(env, Date.parse(`${TODAY}T01:00:00Z`))
    expect(r.emails).toEqual({ sent: 1, failed: 0 })
    expect(mails).toHaveLength(1)
  })
})

describe('cron thử lại khi AI lỗi lúc nộp quiz', () => {
  it('AI hồi phục: cron tạo đề xuất cho tuần vừa xong và gửi email', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ai = null
    await week1()
    expect(await adj()).toEqual([])
    ai = { week: { summary_vi: 'Đã hồi phục.', changes: [] } }
    const r = await runScheduled(env, Date.parse(`${TODAY}T01:00:00Z`))
    expect(r.review_retried).toEqual([{ planId: 1, weekNo: 1 }])
    expect((await adj())[0]).toMatchObject({ week_no: 1, status: 'no_change' })
    expect(mails).toHaveLength(1)
    expect((await runScheduled(env, Date.parse(`${TODAY}T01:10:00Z`))).review_retried).toEqual([]) // đã có đề xuất, không thử lại nữa
  })
  it('AI vẫn lỗi: cron không ném lỗi, lần sau thử tiếp', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ai = null
    await week1()
    const r = await runScheduled(env, Date.parse(`${TODAY}T01:00:00Z`))
    expect(r.review_retried).toEqual([{ planId: 1, weekNo: 1 }])
    expect(await adj()).toEqual([])
  })
})
