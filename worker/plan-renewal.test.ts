import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { isWeekday, todayVN } from './dates'
import { BANK, type Level } from './placement-bank'
import { checkNextPlan, levelsRequired, type LevelTally } from './placement'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
beforeEach(() => {
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: createTestDb() } as Env
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 }))) // AI từ chối → bộ mặc định
})
afterEach(() => vi.unstubAllGlobals())

const req = async (path: string, body?: unknown, authed = true) =>
  app.request(
    path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
const json = async (r: Response) => (await r.json()) as any
const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run()
const q = async <T = any>(sql: string) => (await env.DB.prepare(sql).all<T>()).results

/** Bài làm đúng đúng `right[mức]` câu ở mỗi mức. */
function answersWith(right: Partial<Record<Level, number>>): number[] {
  const used: Record<string, number> = {}
  return BANK.map((b) => {
    used[b.level] = (used[b.level] ?? 0) + 1
    return used[b.level] <= (right[b.level] ?? 0) ? b.answer : (b.answer + 1) % 4
  })
}
const FULL = { A0: 4, A1: 5, A2: 5, B1: 4 }
const takeTest = (right: Partial<Record<Level, number>>) => req('/api/placement/grade', { answers: answersWith(right) })
const finishAll = () => run("UPDATE sessions SET status='done', score=80, completed_date=? WHERE plan_id = (SELECT id FROM plans WHERE status='active')", todayVN())
const getPlan = async () => (await json(await req('/api/plan'))).plan

/** Lộ trình mức A1 (test đầu: đúng A0 + A1), đã học xong cả 60 buổi. */
async function finishedPlanA1() {
  await takeTest({ A0: 4, A1: 5 })
  const r = await req('/api/plan', {})
  expect((await json(r)).level).toBe('A1')
  await finishAll()
}

describe('điều kiện đạt: đúng 100% các mức từ A0 tới mức kế tiếp', () => {
  it('mức cần đạt theo lộ trình', () => {
    expect(levelsRequired('A0')).toEqual(['A0', 'A1'])
    expect(levelsRequired('A1')).toEqual(['A0', 'A1', 'A2']) // ví dụ của bạn
    expect(levelsRequired('A2')).toEqual(['A0', 'A1', 'A2', 'B1'])
    expect(levelsRequired('B1')).toEqual(['A0', 'A1', 'A2', 'B1']) // đã ở mức cao nhất
  })
  const tally = (r: Record<Level, number>): LevelTally => ({
    A0: { right: r.A0, total: 4 }, A1: { right: r.A1, total: 5 }, A2: { right: r.A2, total: 5 }, B1: { right: r.B1, total: 4 },
  })
  it('lộ trình A1: đúng hết A0, A1, A2 → đạt (B1 không bắt buộc)', () => {
    expect(checkNextPlan(tally({ A0: 4, A1: 5, A2: 5, B1: 0 }), 'A1')).toMatchObject({ passed: true, weak: [] })
  })
  it('thiếu dù 1 câu ở mức bắt buộc → chưa đạt, chỉ ra mức yếu', () => {
    expect(checkNextPlan(tally({ A0: 4, A1: 5, A2: 4, B1: 4 }), 'A1')).toMatchObject({ passed: false, weak: ['A2'] })
    expect(checkNextPlan(tally({ A0: 3, A1: 4, A2: 5, B1: 4 }), 'A1').weak).toEqual(['A0', 'A1'])
  })
  it('đúng 60–99% vẫn chưa đạt (khác ngưỡng xếp mức)', () => {
    expect(checkNextPlan(tally({ A0: 4, A1: 4, A2: 4, B1: 4 }), 'A1').passed).toBe(false)
  })
  it('lộ trình B1 phải đúng cả 4 mức', () => {
    expect(checkNextPlan(tally(FULL), 'B1').passed).toBe(true)
    expect(checkNextPlan(tally({ ...FULL, B1: 3 }), 'B1').passed).toBe(false)
  })
  it('không có dữ liệu từng mức (kết quả cũ) → chưa đạt', () => {
    expect(checkNextPlan(null, 'A1').passed).toBe(false)
  })
})

describe('lưu điểm từng mức', () => {
  it('nộp bài lưu per_level_json đúng', async () => {
    await takeTest({ A0: 4, A1: 3, A2: 5, B1: 0 })
    const row = (await q('SELECT per_level_json FROM placement_results'))[0]
    expect(JSON.parse(row.per_level_json)).toEqual({
      A0: { right: 4, total: 4 }, A1: { right: 3, total: 5 }, A2: { right: 5, total: 5 }, B1: { right: 0, total: 4 },
    })
  })
})

describe('hết lộ trình → test lại', () => {
  it('chưa học xong: finished=false, review=null, extension_weeks=0', async () => {
    await takeTest({ A0: 4, A1: 5 })
    await req('/api/plan', {})
    expect(await getPlan()).toMatchObject({ finished: false, review: null, extension_weeks: 0 })
  })

  it('học xong, chưa test lại: review=need_retest; không tạo mới, không thêm tuần ôn (409 retest_required)', async () => {
    await finishedPlanA1()
    expect((await getPlan()).review).toMatchObject({ state: 'need_retest', required: ['A0', 'A1', 'A2'] })
    for (const body of [{}, { replace: true }]) {
      const r = await req('/api/plan', body)
      expect(r.status).toBe(409)
      expect((await json(r)).error).toBe('retest_required')
    }
    const e = await req('/api/plan/extend', {})
    expect(e.status).toBe(409)
    expect((await json(e)).error).toBe('retest_required')
    expect(await q('SELECT * FROM plans')).toHaveLength(1)
  })
})

describe('test lại CHƯA ĐẠT → thêm tuần ôn tập, chưa được tạo lộ trình mới', () => {
  // sai 1 câu ở A2 (mức bắt buộc của lộ trình A1)
  const failRetest = () => takeTest({ A0: 4, A1: 5, A2: 4, B1: 4 })

  it('review=failed kèm mức yếu; tạo lộ trình mới bị chặn kể cả replace:true (409 review_required)', async () => {
    await finishedPlanA1()
    await failRetest()
    expect((await getPlan()).review).toMatchObject({ state: 'failed', weak: ['A2'] })
    for (const body of [{}, { replace: true }]) {
      const r = await req('/api/plan', body)
      expect(r.status).toBe(409)
      expect(await json(r)).toMatchObject({ error: 'review_required', weak: ['A2'] })
    }
    expect(await q('SELECT * FROM plans')).toHaveLength(1)
  })

  it('thêm 2 tuần ôn: tuần 13–14, buổi 61–70, T2–T6, chưa học, từ hôm nay trở đi', async () => {
    await finishedPlanA1()
    await failRetest()
    const r = await req('/api/plan/extend', {})
    expect(r.status).toBe(200)
    expect(await json(r)).toMatchObject({ added_weeks: 2, added_sessions: 10, first_week: 13, weak_levels: ['A2'], source: 'default' })

    const weeks = await q<{ week_no: number; topic: string }>('SELECT week_no, topic FROM plan_weeks WHERE week_no > 12 ORDER BY week_no')
    expect(weeks.map((w) => w.week_no)).toEqual([13, 14])
    expect(weeks.every((w) => /^Review/.test(w.topic))).toBe(true)
    const s = await q<{ seq: number; week_no: number; status: string; scheduled_date: string }>('SELECT * FROM sessions WHERE seq > 60 ORDER BY seq')
    expect(s.map((x) => x.seq)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70])
    expect(s.map((x) => x.week_no)).toEqual([13, 13, 13, 13, 13, 14, 14, 14, 14, 14])
    expect(s.every((x) => x.status === 'pending' && isWeekday(x.scheduled_date) && x.scheduled_date >= todayVN())).toBe(true)
    expect(new Set(s.map((x) => x.scheduled_date)).size).toBe(10)
    expect(await q('SELECT * FROM plans')).toHaveLength(1) // vẫn là một lộ trình
  })

  it('sau khi thêm: lộ trình dài 70 buổi, đang học tuần 13, chưa finished, extension_weeks=2', async () => {
    await finishedPlanA1()
    await failRetest()
    await req('/api/plan/extend', {})
    expect(await getPlan()).toMatchObject({ total: 70, done: 60, finished: false, current_week: 13, extension_weeks: 2, review: null })
    const weeks = (await json(await req('/api/plan'))).weeks
    expect(weeks).toHaveLength(14)
    expect(weeks[12].sessions).toHaveLength(5)
  })

  it('không thêm được lần nữa khi chưa test lại (kết quả đã xét không dùng lại)', async () => {
    await finishedPlanA1()
    await failRetest()
    await req('/api/plan/extend', {})
    await finishAll() // học xong tuần ôn
    expect((await getPlan()).review.state).toBe('need_retest')
    const r = await req('/api/plan/extend', {})
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('retest_required')
    expect((await req('/api/plan', {})).status).toBe(409)
  })

  it('test lại lần 2 vẫn chưa đạt → thêm tiếp 2 tuần nữa (tuần 15–16, buổi 71–80)', async () => {
    await finishedPlanA1()
    await failRetest()
    await req('/api/plan/extend', {})
    await finishAll()
    await takeTest({ A0: 4, A1: 4, A2: 5, B1: 4 }) // lần này sai ở A1
    expect((await getPlan()).review).toMatchObject({ state: 'failed', weak: ['A1'] })
    const r = await req('/api/plan/extend', {})
    expect(await json(r)).toMatchObject({ first_week: 15, added_sessions: 10, weak_levels: ['A1'] })
    expect((await q('SELECT MAX(seq) AS m FROM sessions'))[0].m).toBe(80)
    expect(await getPlan()).toMatchObject({ total: 80, extension_weeks: 4 })
  })

  it('đến lần test lại đạt → được tạo lộ trình mới', async () => {
    await finishedPlanA1()
    await failRetest()
    await req('/api/plan/extend', {})
    await finishAll()
    await takeTest({ A0: 4, A1: 5, A2: 5, B1: 0 })
    expect((await getPlan()).review.state).toBe('passed')
    const r = await req('/api/plan', {})
    expect(r.status).toBe(200)
    expect(await json(r)).toMatchObject({ level: 'A2', sessions: 60 })
  })
})

describe('test lại ĐẠT → lộ trình mới', () => {
  it('đúng 100% A0–A2 (B1 sai hết) → passed → lập lộ trình mới ở mức mới, lộ trình cũ lưu trữ', async () => {
    await finishedPlanA1()
    await takeTest({ A0: 4, A1: 5, A2: 5, B1: 0 })
    expect((await getPlan()).review).toMatchObject({ state: 'passed', weak: [] })

    const r = await req('/api/plan', {}) // không cần replace
    expect(r.status).toBe(200)
    expect(await json(r)).toMatchObject({ level: 'A2', sessions: 60 })
    const plans = await q<{ level: string; status: string }>('SELECT level, status FROM plans ORDER BY id')
    expect(plans).toEqual([{ level: 'A1', status: 'archived' }, { level: 'A2', status: 'active' }])
    expect(await q("SELECT * FROM sessions WHERE plan_id = 1 AND status = 'done'")).toHaveLength(60)
    expect(await q('SELECT * FROM sessions WHERE plan_id = 2')).toHaveLength(60)
    expect(await getPlan()).toMatchObject({ level: 'A2', finished: false, done: 0, extension_weeks: 0 })
  })

  it('đã đạt thì không cần/không cho thêm tuần ôn (409 already_passed)', async () => {
    await finishedPlanA1()
    await takeTest(FULL)
    const r = await req('/api/plan/extend', {})
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('already_passed')
  })

  it('sau khi có lộ trình mới, vòng sau lại phải test mới (không dùng kết quả cũ)', async () => {
    await finishedPlanA1()
    await takeTest({ A0: 4, A1: 5, A2: 5, B1: 0 })
    await req('/api/plan', {}) // lộ trình A2
    await finishAll()
    expect((await getPlan()).review.state).toBe('need_retest')
  })
})

describe('thêm tuần ôn: điều kiện và AI', () => {
  it('chưa có lộ trình → 400; chưa đăng nhập → 401; chưa học xong → 409 not_finished', async () => {
    expect((await req('/api/plan/extend', {})).status).toBe(400)
    await takeTest({ A0: 4, A1: 5 })
    await req('/api/plan', {})
    const r = await req('/api/plan/extend', {})
    expect(r.status).toBe(409)
    expect((await json(r)).error).toBe('not_finished')
    expect((await req('/api/plan/extend', {}, false)).status).toBe(401)
  })

  it('AI soạn tuần ôn hợp lệ → dùng; prompt nêu mức yếu và từ hay sai', async () => {
    await finishedPlanA1()
    await run("INSERT INTO vocab (word, meaning, due_date, created_at, wrong_count) VALUES ('although', 'mặc dù', ?, ?, 3)", todayVN(), todayVN())
    await takeTest({ A0: 4, A1: 5, A2: 4, B1: 4 })
    const fn = vi.fn(async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ weeks: [{ topic: 'Review: connectors', goal_vi: 'Ôn từ nối' }, { topic: 'Review: tenses', goal_vi: 'Ôn các thì' }] }) }] } }],
      }),
    )
    vi.stubGlobal('fetch', fn)
    const r = await req('/api/plan/extend', {})
    expect(await json(r)).toMatchObject({ source: 'ai', added_weeks: 2 })
    const prompt = JSON.parse((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).contents[0].parts[0].text as string
    expect(prompt).toContain('A2')
    expect(prompt).toContain('although')
    expect((await q('SELECT topic FROM plan_weeks WHERE week_no = 13'))[0].topic).toBe('Review: connectors')
  })

  it('AI trả sai số tuần → dùng bộ mặc định, vẫn thêm đủ 2 tuần', async () => {
    await finishedPlanA1()
    await takeTest({ A0: 4, A1: 5, A2: 4, B1: 4 })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: '{"weeks":[{"topic":"x","goal_vi":"y"}]}' }] } }] })))
    const r = await json(await req('/api/plan/extend', {}))
    expect(r).toMatchObject({ source: 'default', fallback_reason: 'invalid', added_weeks: 2 })
  })

  it('lỗi giữa chừng khi lưu → không để lại tuần/buổi dở dang', async () => {
    await finishedPlanA1()
    await takeTest({ A0: 4, A1: 5, A2: 4, B1: 4 })
    const real = env.DB
    env = {
      ...env,
      DB: Object.assign(Object.create(real), {
        batch: async (stmts: D1PreparedStatement[]) =>
          real.batch([...stmts, real.prepare("INSERT INTO sessions (plan_id, seq, week_no, scheduled_date) VALUES (1, 1, 1, '2026-01-01')")]), // trùng seq → lỗi
      }),
    } as Env
    expect((await req('/api/plan/extend', {})).status).toBe(500)
    expect(await q('SELECT * FROM sessions WHERE seq > 60')).toEqual([])
    expect(await q('SELECT * FROM plan_weeks WHERE week_no > 12')).toEqual([])
    expect((await q('SELECT checked_placement_id AS c FROM plans'))[0].c).toBeNull() // chưa ghi nhận đã xét
  })
})
