import { beforeEach, describe, expect, it } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { todayVN } from './dates'
import { BANK } from './placement-bank'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
let env: Env
beforeEach(() => {
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, DB: createTestDb() } as Env
})

async function call(path: string, body?: unknown, authed = true) {
  const headers: Record<string, string> = {}
  if (authed) headers.cookie = `ea_session=${await makeToken(SECRET)}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const grade = (answers: unknown) => call('/api/placement/grade', { answers })
const stored = async () => (await env.DB.prepare('SELECT * FROM placement_results ORDER BY id').all<Record<string, unknown>>()).results

const correct = BANK.map((q) => q.answer)
const wrong = BANK.map((q) => (q.answer + 1) % 4)

describe('lưu kết quả test trình độ', () => {
  it('nộp bài hợp lệ → lưu 1 dòng đúng điểm, mức, ngày làm (giờ VN)', async () => {
    const res = await grade(correct)
    expect(res.status).toBe(200)
    expect(await stored()).toMatchObject([{ id: 1, score: BANK.length, total: BANK.length, level: 'B1', taken_at: todayVN() }])
    expect(((await res.json()) as { taken_at: string }).taken_at).toBe(todayVN())
  })
  it('ngày làm bài có dạng YYYY-MM-DD', async () => {
    await grade(correct)
    expect((await stored())[0].taken_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('làm lại nhiều lần → giữ đủ lịch sử, mới nhất trước', async () => {
    await grade(wrong)
    await grade(correct)
    const { results } = (await (await call('/api/placement/results')).json()) as { results: { level: string; id: number }[] }
    expect(results.map((r) => r.level)).toEqual(['B1', 'A0'])
    expect(results.map((r) => r.id)).toEqual([2, 1])
  })
  it('bài không hợp lệ (400) thì không lưu gì', async () => {
    for (const bad of [[], BANK.map(() => 9), null]) expect((await grade(bad)).status).toBe(400)
    expect(await stored()).toEqual([])
  })
  it('chưa đăng nhập: không nộp được, không đọc được, không lưu gì', async () => {
    expect((await call('/api/placement/grade', { answers: correct }, false)).status).toBe(401)
    expect((await call('/api/placement/results', undefined, false)).status).toBe(401)
    expect(await stored()).toEqual([])
  })
  it('chưa làm bài nào → danh sách rỗng', async () => {
    expect(await (await call('/api/placement/results')).json()).toEqual({ results: [] })
  })
  it('CSDL từ chối mức không hợp lệ (ràng buộc CHECK)', async () => {
    await expect(env.DB.prepare("INSERT INTO placement_results (score,total,level,taken_at) VALUES (1,18,'C2','2026-01-01')").run()).rejects.toThrow()
  })
})

describe('todayVN', () => {
  it('tính theo giờ Việt Nam: 18:00 UTC đã sang ngày hôm sau ở VN', () => {
    expect(todayVN(Date.UTC(2026, 10, 11, 18, 0, 0))).toBe('2026-11-12')
    expect(todayVN(Date.UTC(2026, 10, 11, 16, 59, 59))).toBe('2026-11-11')
  })
})
