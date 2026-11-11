import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { buildPrompt, collectWeekData, generateAdjustment, normalizeProposal, type WeekData } from './adjustment'
import { AiError } from './errors'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
let db: D1Database

beforeEach(async () => {
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  await db.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (10,18,'A1',?)").bind(todayVN()).run()
  const r = await app.request('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `ea_session=${await makeToken(SECRET)}` }, body: '{}' }, env)
  expect(r.status).toBe(200)
})
afterEach(() => vi.unstubAllGlobals())

const setScores = (scores: number[], week = 1) =>
  db.batch(scores.map((sc, i) => db.prepare("UPDATE sessions SET status='done', score=?, completed_date=? WHERE seq=?").bind(sc, todayVN(), (week - 1) * 5 + i + 1)))
const addWord = (word: string, wrong: number) =>
  db.prepare('INSERT INTO vocab (word, meaning, due_date, created_at, wrong_count) VALUES (?, ?, ?, ?, ?)').bind(word, 'nghĩa', todayVN(), todayVN(), wrong).run()
const WEEK1 = { planId: 1, weekNo: 1 }
const aiReply = (obj: unknown) =>
  vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] }))

describe('collectWeekData', () => {
  it('điểm các buổi đã xong của tuần, trung bình, số buổi dưới 70%', async () => {
    await setScores([90, 60, 50, 80, 70])
    const d = await collectWeekData(db, WEEK1)
    expect(d.scores).toEqual([90, 60, 50, 80, 70])
    expect(d.average).toBe(70)
    expect(d.lowCount).toBe(2) // 60 và 50; đúng 70 là đạt
    expect(d.level).toBe('A1')
    expect(d.topic).not.toBe('')
  })
  it('không lẫn điểm của tuần khác', async () => {
    await setScores([100, 100, 100, 100, 100], 1)
    await setScores([10, 20, 30, 40, 50], 2)
    expect((await collectWeekData(db, WEEK1)).scores).toEqual([100, 100, 100, 100, 100])
    expect((await collectWeekData(db, { planId: 1, weekNo: 2 })).scores).toEqual([10, 20, 30, 40, 50])
  })
  it('chưa có điểm → average null', async () => {
    expect(await collectWeekData(db, WEEK1)).toMatchObject({ scores: [], average: null, lowCount: 0 })
  })
  it('từ hay sai: chỉ từ đã sai ≥ 1 lần, nhiều nhất trước, tối đa 15', async () => {
    await addWord('never', 0)
    await addWord('although', 5)
    await addWord('despite', 2)
    for (let i = 0; i < 20; i++) await addWord('w' + i, 1)
    const d = await collectWeekData(db, WEEK1)
    expect(d.hardWords).toHaveLength(15)
    expect(d.hardWords[0]).toEqual({ word: 'although', wrong: 5 })
    expect(d.hardWords[1]).toEqual({ word: 'despite', wrong: 2 })
    expect(d.hardWords.map((w) => w.word)).not.toContain('never')
  })
  it('chỉ các tuần sau CHƯA bắt đầu (không có buổi xong) mới được đổi', async () => {
    await setScores([80, 80, 80, 80, 80], 1)
    await db.prepare("UPDATE sessions SET status='done', score=70 WHERE seq=6").run() // tuần 2 đã bắt đầu
    const d = await collectWeekData(db, WEEK1)
    expect(d.futureWeeks.map((w) => w.week_no)).toEqual(Array.from({ length: 10 }, (_, i) => i + 3)) // 3..12
  })
  it('tuần cuối → không còn tuần nào để đổi', async () => {
    expect((await collectWeekData(db, { planId: 1, weekNo: 12 })).futureWeeks).toEqual([])
  })
})

describe('buildPrompt', () => {
  it('nêu đủ điểm, từ hay sai, tuần sau và mức CEFR', async () => {
    await setScores([90, 40, 85, 80, 95])
    await addWord('although', 4)
    const p = buildPrompt(await collectWeekData(db, WEEK1))
    expect(p).toContain('CEFR A1')
    expect(p).toContain('90%, 40%, 85%, 80%, 95%')
    expect(p).toContain('average 78%')
    expect(p).toContain('1 below 70%')
    expect(p).toContain('although (wrong 4x)')
    expect(p).toContain('week 2:')
    expect(p).toContain('week 12:')
    expect(p).toContain('"changes":[]')
  })
  it('thiếu dữ liệu vẫn tạo được yêu cầu hợp lệ', async () => {
    const p = buildPrompt(await collectWeekData(db, WEEK1))
    expect(p).toContain('no quiz scores')
    expect(p).toContain('none recorded')
  })
})

describe('normalizeProposal', () => {
  const d: WeekData = {
    weekNo: 3, level: 'A1', topic: 'T3', scores: [], average: null, lowCount: 0, hardWords: [], weekWords: [],
    futureWeeks: [
      { week_no: 4, topic: 'Food', goal_vi: 'Đồ ăn' },
      { week_no: 5, topic: 'Travel', goal_vi: 'Du lịch' },
    ],
  }
  const ok = (changes: unknown[]) => normalizeProposal({ summary_vi: 'Tuần này khá tốt.', changes }, d)

  it('đề xuất hợp lệ', () => {
    expect(ok([{ week_no: 4, topic: 'Review: past tense', goal_vi: 'Ôn thì quá khứ' }])).toEqual({
      week_no: 3,
      summary_vi: 'Tuần này khá tốt.',
      changes: [{ week_no: 4, topic: 'Review: past tense', goal_vi: 'Ôn thì quá khứ' }],
    })
  })
  it('changes rỗng là hợp lệ (không cần đổi gì)', () => {
    expect(ok([]).changes).toEqual([])
    expect(normalizeProposal({ summary_vi: 'Tốt.' }, d).changes).toEqual([])
  })
  it('bỏ thay đổi sai tuần: tuần đã qua / không tồn tại / chính tuần vừa xong', () => {
    const r = ok([
      { week_no: 3, topic: 'x', goal_vi: 'y' },
      { week_no: 1, topic: 'x', goal_vi: 'y' },
      { week_no: 99, topic: 'x', goal_vi: 'y' },
      { week_no: '4', topic: 'x', goal_vi: 'y' },
      { week_no: 5, topic: 'Shopping', goal_vi: 'Mua sắm' },
    ])
    expect(r.changes.map((c) => c.week_no)).toEqual([5])
  })
  it('bỏ trùng tuần (giữ cái đầu), rỗng, quá dài, không đổi gì', () => {
    const r = ok([
      { week_no: 4, topic: 'First', goal_vi: 'a' },
      { week_no: 4, topic: 'Second', goal_vi: 'b' },
      { week_no: 5, topic: '', goal_vi: 'b' },
    ])
    expect(r.changes).toEqual([{ week_no: 4, topic: 'First', goal_vi: 'a' }])
    expect(ok([{ week_no: 5, topic: 'x'.repeat(81), goal_vi: 'a' }]).changes).toEqual([])
    expect(ok([{ week_no: 5, topic: 'Travel', goal_vi: 'Du lịch' }]).changes).toEqual([]) // y hệt cũ
    expect(ok([{ week_no: 5, topic: 'TRAVEL', goal_vi: 'Du lịch' }]).changes).toEqual([])
  })
  it('sắp theo số tuần', () => {
    const r = ok([{ week_no: 5, topic: 'B', goal_vi: 'b' }, { week_no: 4, topic: 'A', goal_vi: 'a' }])
    expect(r.changes.map((c) => c.week_no)).toEqual([4, 5])
  })
  it('thiếu/rỗng/quá dài tóm tắt, hoặc không phải object → AiError', () => {
    for (const bad of [null, 'x', {}, { summary_vi: '' }, { summary_vi: '   ' }, { summary_vi: 5 }, { summary_vi: 'x'.repeat(801) }]) {
      expect(() => normalizeProposal(bad, d)).toThrow(AiError)
    }
  })
  it('changes không phải mảng → coi như rỗng', () => {
    expect(normalizeProposal({ summary_vi: 'ok', changes: 'x' }, d).changes).toEqual([])
  })
})

describe('generateAdjustment', () => {
  it('AI trả đề xuất → trả về đúng, chỉ các tuần sau hợp lệ', async () => {
    await setScores([90, 55, 40, 80, 50])
    await addWord('although', 4)
    vi.stubGlobal('fetch', aiReply({
      summary_vi: 'Bạn còn yếu ở từ nối.',
      changes: [{ week_no: 3, topic: 'Review: connectors', goal_vi: 'Ôn từ nối' }, { week_no: 1, topic: 'bad', goal_vi: 'bad' }],
    }))
    const p = await generateAdjustment(env, db, WEEK1)
    expect(p).toEqual({ week_no: 1, summary_vi: 'Bạn còn yếu ở từ nối.', changes: [{ week_no: 3, topic: 'Review: connectors', goal_vi: 'Ôn từ nối' }] })
  })
  it('gửi cho AI đúng điểm quiz và từ hay sai', async () => {
    await setScores([90, 55, 40, 80, 50])
    await addWord('although', 4)
    const fn = aiReply({ summary_vi: 'ok', changes: [] })
    vi.stubGlobal('fetch', fn)
    await generateAdjustment(env, db, WEEK1)
    const prompt = JSON.parse((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).contents[0].parts[0].text as string
    expect(prompt).toContain('90%, 55%, 40%, 80%, 50%')
    expect(prompt).toContain('although')
  })
  it('kết quả tốt → AI có thể trả không đổi gì', async () => {
    await setScores([100, 95, 90, 100, 95])
    vi.stubGlobal('fetch', aiReply({ summary_vi: 'Tuần rất tốt.', changes: [] }))
    expect((await generateAdjustment(env, db, WEEK1)).changes).toEqual([])
  })
  it('không lưu gì vào CSDL', async () => {
    vi.stubGlobal('fetch', aiReply({ summary_vi: 'ok', changes: [{ week_no: 2, topic: 'New topic', goal_vi: 'Mục tiêu mới' }] }))
    const before = (await db.prepare('SELECT topic FROM plan_weeks WHERE week_no = 2').first<{ topic: string }>())!.topic
    await generateAdjustment(env, db, WEEK1)
    expect((await db.prepare('SELECT topic FROM plan_weeks WHERE week_no = 2').first<{ topic: string }>())!.topic).toBe(before)
    expect((await db.prepare('SELECT COUNT(*) n FROM plan_adjustments').first<{ n: number }>())!.n).toBe(0)
  })
  it('AI từ chối / lỗi → ném AiError để thử lại sau', async () => {
    await expect(generateAdjustment(env, db, WEEK1)).rejects.toMatchObject({ kind: 'rate' }) // fetch 429 mặc định
  })
  it('AI trả JSON hỏng hoặc thiếu tóm tắt → AiError', async () => {
    vi.stubGlobal('fetch', aiReply('không phải json'))
    await expect(generateAdjustment(env, db, WEEK1)).rejects.toBeInstanceOf(AiError)
    vi.stubGlobal('fetch', aiReply({ changes: [] }))
    await expect(generateAdjustment(env, db, WEEK1)).rejects.toBeInstanceOf(AiError)
  })
})
