import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, todayVN } from './dates'
import { HISTORY_PAGE_SIZE, TARGET_PERCENT } from './progress'
import { bestStreak, currentStreak } from './streak'
import { lessonJson } from './test-fixtures'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
const TODAY = todayVN()
let env: Env
let db: D1Database

/* ----------------- chuỗi ngày học ----------------- */
// 2026-11-16 = thứ 2
describe('currentStreak — chuỗi ngày học', () => {
  it('đếm ngày làm việc liên tiếp có buổi xong, tính ngược từ hôm nay', () => {
    expect(currentStreak(['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'], '2026-11-17')).toBe(4)
  })
  it('hôm nay chưa học: chưa đứt chuỗi', () => {
    expect(currentStreak(['2026-11-16', '2026-11-17'], '2026-11-18')).toBe(2)
  })
  it('bỏ một ngày làm việc → đứt chuỗi, đếm lại từ đoạn gần nhất', () => {
    expect(currentStreak(['2026-11-13', '2026-11-17'], '2026-11-17')).toBe(1)
    expect(currentStreak(['2026-11-13', '2026-11-16'], '2026-11-18')).toBe(0) // thứ 3 và thứ 4 bỏ lỡ... hôm nay thứ 4 chưa học, thứ 3 không học
  })
  it('cuối tuần không làm đứt chuỗi', () => {
    expect(currentStreak(['2026-11-12', '2026-11-13'], '2026-11-15')).toBe(2) // CN
    expect(currentStreak(['2026-11-13', '2026-11-16'], '2026-11-16')).toBe(2) // thứ 6 → thứ 2
  })
  it('học vào cuối tuần không cộng thêm vào chuỗi', () => {
    expect(currentStreak(['2026-11-13', '2026-11-14', '2026-11-16'], '2026-11-16')).toBe(2)
  })
  it('chưa học lần nào → 0; trùng ngày (2 buổi/ngày) chỉ tính 1', () => {
    expect(currentStreak([], '2026-11-17')).toBe(0)
    expect(currentStreak(['2026-11-17', '2026-11-17', '2026-11-17'], '2026-11-17')).toBe(1)
  })
  it('quá xa (vài tuần trước) → 0', () => {
    expect(currentStreak(['2026-10-01'], '2026-11-17')).toBe(0)
  })
})

describe('bestStreak — chuỗi dài nhất', () => {
  it('đoạn liên tiếp dài nhất (qua cuối tuần vẫn nối)', () => {
    expect(bestStreak(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-13', '2026-11-16', '2026-11-17'])).toBe(3) // 9,10,11 | 13,16,17 = 3 | 3
    expect(bestStreak(['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18'])).toBe(5)
  })
  it('bỏ cách quãng → các đoạn riêng, lấy dài nhất', () => {
    expect(bestStreak(['2026-11-09', '2026-11-10', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18'])).toBe(4) // 13,16,17,18
  })
  it('rỗng → 0; một ngày → 1; ngày cuối tuần bị bỏ qua', () => {
    expect(bestStreak([])).toBe(0)
    expect(bestStreak(['2026-11-17'])).toBe(1)
    expect(bestStreak(['2026-11-14', '2026-11-15'])).toBe(0)
  })
  it('không phụ thuộc thứ tự đầu vào', () => {
    expect(bestStreak(['2026-11-17', '2026-11-16', '2026-11-13'])).toBe(3)
  })
})

/* ----------------- API ----------------- */
async function call(path: string, authed = true) {
  return app.request(path, { headers: authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {} }, env)
}
const post = async (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: JSON.stringify(body) }, env)
const json = async (r: Response) => (await r.json()) as any

beforeEach(() => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
})
afterEach(() => vi.unstubAllGlobals())

async function makePlan(level = 'A1') {
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,?,?)").bind(level, TODAY).run()
  expect((await post('/api/plan', {})).status).toBe(200)
}
/** Đánh dấu buổi xong ở ngày cho trước (điểm tùy ý), kèm bài học mẫu */
async function done(seq: number, date: string, score: number | null = 80, lesson: Record<string, unknown> = {}) {
  await db.prepare("UPDATE sessions SET status = 'done', score = ?, completed_date = ?, lesson_json = ? WHERE seq = ?").bind(score, date, JSON.stringify(lessonJson(lesson)), seq).run()
}
const progress = async () => json(await call('/api/progress'))

describe('GET /api/progress', () => {
  it('cần đăng nhập', async () => expect((await call('/api/progress', false)).status).toBe(401))

  it('chưa có gì: mọi số bằng 0, không có lộ trình', async () => {
    expect(await progress()).toEqual({
      plan: null,
      streak: { current: 0, best: 0, studied_today: false, last_study_date: null },
      completion: null,
      vocab: { total: 0, learned: 0, due: 0, learned_percent: 0 },
      scores: [],
      quiz: { count: 0, average: null, pass_rate: null, pass_percent: 70 },
      level: null,
    })
  })

  describe('chuỗi ngày học', () => {
    it('đếm từ các buổi đã xong (nhiều buổi cùng ngày chỉ tính 1 ngày)', async () => {
      await makePlan()
      const d1 = TODAY
      await done(1, d1)
      await done(2, d1)
      const s = (await progress()).streak
      expect(s.studied_today).toBe(true)
      expect(s.last_study_date).toBe(d1)
      expect(s.current).toBeGreaterThanOrEqual(0)
      expect(s.best).toBeGreaterThanOrEqual(0)
    })
    it('chuỗi qua nhiều ngày làm việc liên tiếp (mốc cố định để test ổn định)', async () => {
      await makePlan()
      const mon = '2026-11-16'
      for (const [i, d] of [['1', '2026-11-12'], ['2', '2026-11-13'], ['3', mon], ['4', '2026-11-17']] as const) await done(Number(i), d)
      const rows = (await db.prepare("SELECT DISTINCT completed_date d FROM sessions WHERE status='done'").all<any>()).results.map((r) => r.d)
      expect(currentStreak(rows, '2026-11-17')).toBe(4)
      expect(bestStreak(rows)).toBe(4)
    })
    it('studied_today false khi chưa học hôm nay; last_study_date là ngày học gần nhất', async () => {
      await makePlan()
      await done(1, addDays(TODAY, -3))
      const s = (await progress()).streak
      expect(s.studied_today).toBe(false)
      expect(s.last_study_date).toBe(addDays(TODAY, -3))
    })
    it('tính cả buổi của lộ trình cũ đã lưu trữ', async () => {
      await makePlan()
      await done(1, addDays(TODAY, -1))
      await db.prepare("UPDATE plans SET status = 'archived'").run()
      expect((await progress()).streak.last_study_date).toBe(addDays(TODAY, -1))
    })
  })

  describe('hoàn thành lộ trình (mục tiêu ≥ 80%)', () => {
    it('chưa học: 0/60 = 0%, cần 48 buổi, chưa đạt mục tiêu', async () => {
      await makePlan()
      const c = (await progress()).completion
      expect(c).toMatchObject({ done: 0, total: 60, percent: 0, target_percent: TARGET_PERCENT, target_sessions: 48, on_target: false })
    })
    it('theo từng tuần: số buổi xong / tổng, kèm chủ đề; 12 tuần × 5 buổi', async () => {
      await makePlan()
      for (const s of [1, 2, 3, 6]) await done(s, TODAY)
      const { completion } = await progress()
      expect(completion.weeks).toHaveLength(12)
      expect(completion.weeks[0]).toMatchObject({ week_no: 1, done: 3, total: 5 })
      expect(completion.weeks[1]).toMatchObject({ week_no: 2, done: 1, total: 5 })
      expect(completion.weeks[2]).toMatchObject({ week_no: 3, done: 0, total: 5 })
      expect(completion.weeks.every((w: any) => w.topic !== '')).toBe(true)
      expect(completion).toMatchObject({ done: 4, total: 60, percent: 7 })
    })
    it('ranh giới 80%: 47/60 chưa đạt, 48/60 đạt', async () => {
      await makePlan()
      await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq <= 47").bind(TODAY).run()
      expect((await progress()).completion).toMatchObject({ done: 47, percent: 78, on_target: false })
      await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq = 48").bind(TODAY).run()
      expect((await progress()).completion).toMatchObject({ done: 48, percent: 80, on_target: true })
    })
    it('xong cả 60 buổi → 100%', async () => {
      await makePlan()
      await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=?").bind(TODAY).run()
      expect((await progress()).completion).toMatchObject({ done: 60, percent: 100, on_target: true })
    })
    it('lộ trình có tuần ôn tập thêm: tổng và mục tiêu tính theo tổng buổi mới', async () => {
      await makePlan()
      await db.prepare("INSERT INTO plan_weeks (plan_id, week_no, topic, goal_vi) VALUES (1, 13, 'Review', 'Ôn')").run()
      await db.prepare("INSERT INTO sessions (plan_id, seq, week_no, scheduled_date) SELECT 1, 61 + n, 13, '2099-01-01' FROM (SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4)").run()
      const c = (await progress()).completion
      expect(c).toMatchObject({ total: 65, target_sessions: 52 })
      expect(c.weeks).toHaveLength(13)
    })
    it('buổi bị lỡ (missed) không tính là xong', async () => {
      await makePlan()
      await db.prepare("UPDATE sessions SET status='missed' WHERE seq <= 5").run()
      expect((await progress()).completion.done).toBe(0)
    })
    it('chỉ tính lộ trình đang chạy', async () => {
      await makePlan()
      await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=? WHERE seq <= 10").bind(TODAY).run()
      await db.prepare("UPDATE plans SET status = 'archived'").run()
      await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (12,18,'A2',?)").bind(TODAY).run()
      expect((await post('/api/plan', {})).status).toBe(200)
      expect((await progress()).completion).toMatchObject({ done: 0, total: 60 })
    })
  })

  describe('từ vựng đã học / đã thuộc', () => {
    it('tổng số từ, đã thuộc, đến hạn, % đã thuộc', async () => {
      const add = (w: string, o: { learned?: number; due?: string }) =>
        db.prepare('INSERT INTO vocab (word, meaning, due_date, learned, created_at) VALUES (?, ?, ?, ?, ?)').bind(w, 'x', o.due ?? addDays(TODAY, 5), o.learned ?? 0, TODAY).run()
      await add('a', { learned: 1, due: addDays(TODAY, 30) })
      await add('b', { learned: 1, due: addDays(TODAY, 30) })
      await add('c', { due: TODAY })
      await add('d', { due: addDays(TODAY, -1) })
      await add('e', {})
      expect((await progress()).vocab).toEqual({ total: 5, learned: 2, due: 2, learned_percent: 40 })
    })
  })

  describe('điểm quiz theo thời gian', () => {
    it('cũ → mới, kèm tiêu đề bài và chủ đề tuần; buổi chưa xong/không có điểm bị bỏ', async () => {
      await makePlan()
      await done(2, addDays(TODAY, -1), 63, { title: 'Second lesson' })
      await done(1, addDays(TODAY, -3), 100, { title: 'First lesson' })
      await done(3, TODAY, 38, { title: 'Third lesson' })
      await db.prepare("UPDATE sessions SET status='done', score=NULL, completed_date=? WHERE seq = 4").bind(TODAY).run() // done nhưng không điểm
      const { scores } = await progress()
      expect(scores.map((s: any) => [s.seq, s.score, s.title])).toEqual([[1, 100, 'First lesson'], [2, 63, 'Second lesson'], [3, 38, 'Third lesson']])
      expect(scores[0]).toMatchObject({ week_no: 1, date: addDays(TODAY, -3) })
      expect(scores[0].topic).not.toBe('')
    })
    it('cùng ngày thì theo thứ tự làm', async () => {
      await makePlan()
      await done(2, TODAY, 50)
      await done(1, TODAY, 90)
      expect((await progress()).scores.map((s: any) => s.seq)).toEqual([1, 2]) // id nhỏ trước
    })
    it('điểm trung bình, tỉ lệ đạt (≥ 70%)', async () => {
      await makePlan()
      for (const [i, sc] of [100, 88, 63, 38, 70].entries()) await done(i + 1, addDays(TODAY, -5 + i), sc)
      expect((await progress()).quiz).toEqual({ count: 5, average: 72, pass_rate: 60, pass_percent: 70 }) // đạt: 100, 88, 70
    })
    it('điểm 0 vẫn được tính (không nhầm với "không có điểm")', async () => {
      await makePlan()
      await done(1, TODAY, 0)
      const p = await progress()
      expect(p.scores).toHaveLength(1)
      expect(p.quiz).toMatchObject({ count: 1, average: 0, pass_rate: 0 })
    })
    it('bài không có tiêu đề: dùng chủ đề tuần', async () => {
      await makePlan()
      await db.prepare("UPDATE sessions SET status='done', score=80, completed_date=?, lesson_json=NULL WHERE seq=1").bind(TODAY).run()
      const s = (await progress()).scores[0]
      expect(s.title).toBe(s.topic)
    })
    it('gồm cả điểm của lộ trình cũ', async () => {
      await makePlan()
      await done(1, addDays(TODAY, -2), 90)
      await db.prepare("UPDATE plans SET status = 'archived'").run()
      expect((await progress()).scores).toHaveLength(1)
    })
  })

  describe('mức CEFR đầu → hiện tại', () => {
    it('một lần test: chưa so sánh được', async () => {
      await makePlan('A1')
      expect((await progress()).level).toMatchObject({ baseline: { level: 'A1' }, latest: { level: 'A1' }, bands_gained: null, success: null })
    })
    it('lên bậc → success', async () => {
      await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (8,18,'A0',?)").bind(addDays(TODAY, -90)).run()
      await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (12,18,'A1',?)").bind(TODAY).run()
      expect((await progress()).level).toMatchObject({ bands_gained: 1, success: true })
    })
  })
})

/* ----------------- lịch sử buổi học ----------------- */
const history = async (qs = '') => json(await call('/api/history' + qs))

describe('GET /api/history — lịch sử buổi học', () => {
  it('cần đăng nhập', async () => expect((await call('/api/history', false)).status).toBe(401))
  it('chưa có buổi nào xong → rỗng', async () => {
    expect(await history()).toMatchObject({ items: [], matched: 0, total: 0, page: 1 })
  })

  it('chỉ các buổi ĐÃ XONG, mới nhất trước; đủ thông tin để mở lại', async () => {
    await makePlan()
    await done(1, addDays(TODAY, -2), 90, { title: 'Lesson one' })
    await done(2, addDays(TODAY, -1), 55, { title: 'Lesson two', source: { type: 'article', url: 'https://example.com/a', title: 'Example article', ai_written: false } })
    const h = await history()
    expect(h.items.map((i: any) => i.seq)).toEqual([2, 1])
    expect(h.items[0]).toMatchObject({
      seq: 2, week_no: 1, title: 'Lesson two', score: 55, passed: false, completed_date: addDays(TODAY, -1), vocab_count: 5,
      source: { type: 'article', title: 'Example article', url: 'https://example.com/a', ai_written: false },
    })
    expect(h.items[1]).toMatchObject({ seq: 1, score: 90, passed: true })
    expect(h.items[0].topic).not.toBe('')
    expect(h).toMatchObject({ matched: 2, total: 2 })
  })

  it('buổi chưa xong / bị lỡ không có trong lịch sử', async () => {
    await makePlan()
    await db.prepare("UPDATE sessions SET status='missed' WHERE seq = 1").run()
    await done(2, TODAY)
    expect((await history()).items.map((i: any) => i.seq)).toEqual([2])
  })

  it('bài AI tự viết: source.ai_written = true', async () => {
    await makePlan()
    await done(1, TODAY, 80, { source: { type: 'ai', title: 'Bài đọc do AI viết', ai_written: true } })
    expect((await history()).items[0].source).toEqual({ type: 'ai', title: 'Bài đọc do AI viết', ai_written: true })
  })

  it('bao gồm cả lộ trình đã lưu trữ', async () => {
    await makePlan()
    await done(1, TODAY)
    await db.prepare("UPDATE plans SET status = 'archived'").run()
    expect((await history()).items).toHaveLength(1)
  })

  describe('tìm theo chủ đề', () => {
    beforeEach(async () => {
      await makePlan()
      await db.prepare("UPDATE plan_weeks SET topic = 'Food & restaurants' WHERE week_no = 1").run()
      await db.prepare("UPDATE plan_weeks SET topic = 'Travel and hotels' WHERE week_no = 2").run()
      await done(1, addDays(TODAY, -5), 80, { title: 'Ordering a pizza' })
      await done(2, addDays(TODAY, -4), 80, { title: 'Ordering coffee' })
      await done(6, addDays(TODAY, -1), 80, { title: 'Booking a room', vocab: [{ word: 'reservation', meaning_vi: 'đặt chỗ' }, { word: 'luggage', meaning_vi: 'hành lý' }, { word: 'passport', meaning_vi: 'hộ chiếu' }, { word: 'ticket', meaning_vi: 'vé' }] })
    })
    const titles = async (q: string) => (await history('?q=' + encodeURIComponent(q))).items.map((i: any) => i.title)

    it('theo chủ đề của tuần (không phân biệt hoa thường)', async () => {
      expect(await titles('FOOD')).toEqual(['Ordering coffee', 'Ordering a pizza'])
      expect(await titles('travel')).toEqual(['Booking a room'])
    })
    it('theo tiêu đề bài', async () => expect(await titles('pizza')).toEqual(['Ordering a pizza']))
    it('theo từ vựng của bài', async () => expect(await titles('luggage')).toEqual(['Booking a room']))
    it('theo tên nguồn', async () => {
      await done(3, TODAY, 80, { title: 'From source', source: { type: 'article', url: 'https://example.com/x', title: 'BBC Learning English', ai_written: false } })
      expect(await titles('bbc learning')).toEqual(['From source'])
    })
    it('không cần gõ dấu tiếng Việt: tìm "đặt chỗ" hoặc "dat cho" trong tên chủ đề tiếng Việt', async () => {
      await db.prepare("UPDATE plan_weeks SET topic = 'Đặt chỗ & du lịch' WHERE week_no = 3").run()
      await done(11, TODAY, 80, { title: 'Hotel booking' })
      expect(await titles('dat cho')).toEqual(['Hotel booking'])
      expect(await titles('ĐẶT CHỖ')).toEqual(['Hotel booking'])
    })
    it('không khớp → rỗng, matched = 0, total vẫn là tổng số buổi đã học', async () => {
      const h = await history('?q=zzz')
      expect(h.items).toEqual([])
      expect(h).toMatchObject({ matched: 0, total: 3 })
    })
    it('chuỗi rỗng / khoảng trắng = tất cả; ký tự đặc biệt không gây lỗi', async () => {
      expect(await titles('')).toHaveLength(3)
      expect(await titles('   ')).toHaveLength(3)
      for (const q of ['%', "'; DROP TABLE sessions; --", '\\', '.*']) expect((await call('/api/history?q=' + encodeURIComponent(q))).status).toBe(200)
      expect((await db.prepare('SELECT COUNT(*) n FROM sessions').first<any>()).n).toBe(60)
    })
  })

  it(`phân trang ${HISTORY_PAGE_SIZE} buổi/trang, không trùng không sót`, async () => {
    await makePlan()
    for (let s = 1; s <= HISTORY_PAGE_SIZE + 5; s++) await done(s, addDays(TODAY, -(HISTORY_PAGE_SIZE + 5) + s), 80)
    const p1 = await history()
    const p2 = await history('?page=2')
    expect(p1.items).toHaveLength(HISTORY_PAGE_SIZE)
    expect(p2.items).toHaveLength(5)
    expect(p1).toMatchObject({ matched: HISTORY_PAGE_SIZE + 5, page: 1, page_size: HISTORY_PAGE_SIZE })
    expect(new Set([...p1.items, ...p2.items].map((i: any) => i.id)).size).toBe(HISTORY_PAGE_SIZE + 5)
    expect((await history('?page=99')).items).toEqual([])
    expect((await history('?page=-1')).page).toBe(1)
    expect((await history('?page=abc')).page).toBe(1)
  })

  it('mở lại một buổi trong lịch sử thấy đủ tài liệu, từ vựng, quiz (kèm đáp án)', async () => {
    await makePlan()
    await db.prepare('UPDATE sessions SET material_json = ? WHERE seq = 1').bind(JSON.stringify({ options: [{ type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }], chosen: 0, fallback: false })).run()
    await done(1, TODAY, 100)
    await db.prepare('UPDATE sessions SET result_json = ? WHERE seq = 1').bind(JSON.stringify({ score: 100, right: 8, total: 8, passed: true, items: [] })).run()
    const id = (await history()).items[0].id
    const { session } = await json(await call(`/api/sessions/${id}`))
    expect(session.material.options[0].url).toBe('https://example.com/a')
    expect(session.lesson.vocab).toHaveLength(5)
    expect(session.lesson.quiz[0]).toHaveProperty('answer')
    expect(session.result.score).toBe(100)
  })
})
