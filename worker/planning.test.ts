import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan, generatePlan, normalizeWeeks, WEEKS } from './planning'
import type { Env } from './env'
import type { Level } from './placement-bank'

const LEVELS: Level[] = ['A0', 'A1', 'A2', 'B1']
const env = { GEMINI_API_KEY: 'k' } as Env

afterEach(() => vi.unstubAllGlobals())

const aiWeeks = (n = WEEKS, mut: (i: number) => object = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ week: i + 1, topic: `Topic ${i + 1}`, goal_vi: `Mục tiêu ${i + 1}`, ...mut(i) }))

const stubAi = (weeks: unknown) => {
  const fn = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ weeks }) }] } }] }))
  vi.stubGlobal('fetch', fn)
  return fn
}
const stubStatus = (status: number) => {
  const fn = vi.fn(async () => new Response('', { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('bộ chủ đề mặc định', () => {
  for (const level of LEVELS) {
    it(`${level}: đủ 12 tuần, đánh số 1–12, không trùng, không rỗng`, () => {
      const p = defaultPlan(level)
      expect(p).toHaveLength(WEEKS)
      expect(p.map((w) => w.week)).toEqual(Array.from({ length: WEEKS }, (_, i) => i + 1))
      expect(new Set(p.map((w) => w.topic)).size).toBe(WEEKS)
      for (const w of p) {
        expect(w.topic.trim()).not.toBe('')
        expect(w.goal_vi.trim()).not.toBe('')
      }
    })
    it(`${level}: tuần 12 là ôn tập`, () => {
      expect(defaultPlan(level)[11].topic).toMatch(/review/i)
    })
    it(`${level}: qua được chính bộ kiểm tra hợp lệ`, () => {
      expect(normalizeWeeks({ weeks: defaultPlan(level) })).not.toBeNull()
    })
  }
  it('mỗi mức có bộ khác nhau', () => {
    const firsts = LEVELS.map((l) => defaultPlan(l)[0].topic)
    expect(new Set(firsts).size).toBe(4)
  })
})

describe('normalizeWeeks', () => {
  it('hợp lệ → đánh lại số tuần 1–12 theo thứ tự', () => {
    const w = normalizeWeeks({ weeks: aiWeeks(WEEKS, () => ({ week: 99 })) })!
    expect(w.map((x) => x.week)).toEqual(Array.from({ length: WEEKS }, (_, i) => i + 1))
  })
  it('cắt khoảng trắng thừa', () => {
    const w = normalizeWeeks({ weeks: aiWeeks(WEEKS, (i) => (i === 0 ? { topic: '  Hello  ' } : {})) })!
    expect(w[0].topic).toBe('Hello')
  })
  it('sai số tuần, thiếu trường, rỗng, quá dài, trùng chủ đề, sai kiểu → null', () => {
    const bad: unknown[] = [
      null, 'x', {}, { weeks: 'x' },
      { weeks: aiWeeks(11) },
      { weeks: aiWeeks(13) },
      { weeks: aiWeeks(WEEKS, (i) => (i === 3 ? { topic: '' } : {})) },
      { weeks: aiWeeks(WEEKS, (i) => (i === 3 ? { goal_vi: '   ' } : {})) },
      { weeks: aiWeeks(WEEKS, (i) => (i === 3 ? { topic: 'x'.repeat(81) } : {})) },
      { weeks: aiWeeks(WEEKS, (i) => (i === 3 ? { goal_vi: 'x'.repeat(201) } : {})) },
      { weeks: aiWeeks(WEEKS, (i) => (i === 5 ? { topic: 'topic 1' } : {})) }, // trùng "Topic 1", không phân biệt hoa thường
      { weeks: aiWeeks(WEEKS, (i) => (i === 2 ? { topic: 7 } : {})) },
      { weeks: [...aiWeeks(11), null] },
    ]
    for (const b of bad) expect(normalizeWeeks(b)).toBeNull()
  })
})

describe('generatePlan', () => {
  it('AI trả hợp lệ → dùng kết quả AI', async () => {
    stubAi(aiWeeks())
    const p = await generatePlan(env, 'A1')
    expect(p.source).toBe('ai')
    expect(p.fallback_reason).toBeUndefined()
    expect(p.weeks[0].topic).toBe('Topic 1')
    expect(p.weeks).toHaveLength(WEEKS)
  })
  it('gửi đúng mức CEFR trong yêu cầu', async () => {
    const fn = stubAi(aiWeeks())
    await generatePlan(env, 'A2')
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.contents[0].parts[0].text).toContain('CEFR A2')
    expect(body.contents[0].parts[0].text).toContain('exactly 12')
  })
  it('API từ chối (429) → bộ mặc định, lý do rate', async () => {
    stubStatus(429)
    const p = await generatePlan(env, 'A0')
    expect(p).toMatchObject({ source: 'default', fallback_reason: 'rate' })
    expect(p.weeks).toEqual(defaultPlan('A0'))
  })
  it('quá thời gian → bộ mặc định, lý do timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }))
    expect(await generatePlan(env, 'B1')).toMatchObject({ source: 'default', fallback_reason: 'timeout' })
  })
  it('khóa sai (403) → bộ mặc định, lý do config', async () => {
    stubStatus(403)
    expect(await generatePlan(env, 'A1')).toMatchObject({ source: 'default', fallback_reason: 'config' })
  })
  it('thiếu khóa → bộ mặc định, không gọi mạng', async () => {
    const fn = stubAi(aiWeeks())
    const p = await generatePlan({} as Env, 'A1')
    expect(p).toMatchObject({ source: 'default', fallback_reason: 'config' })
    expect(fn).not.toHaveBeenCalled()
  })
  it('AI trả sai số tuần → bộ mặc định, lý do invalid', async () => {
    stubAi(aiWeeks(8))
    expect(await generatePlan(env, 'A1')).toMatchObject({ source: 'default', fallback_reason: 'invalid' })
  })
  it('AI trả không phải JSON → bộ mặc định', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: 'xin lỗi, tôi không làm được' }] } }] })))
    expect(await generatePlan(env, 'A1')).toMatchObject({ source: 'default', fallback_reason: 'other' })
  })
  it('AI trả danh sách tuần rỗng → bộ mặc định, lý do invalid', async () => {
    stubAi([])
    expect(await generatePlan(env, 'A1')).toMatchObject({ source: 'default', fallback_reason: 'invalid' })
  })
})
