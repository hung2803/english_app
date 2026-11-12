import { afterEach, describe, expect, it, vi } from 'vitest'
import { gemini } from './gemini'
import { ptDay, recordUsage, secondsToPtMidnight, usageFor } from './ai-usage'
import { modelInfo } from './ai-model'
import { createTestDb } from './test-db'
import type { Env } from './env'

const mkEnv = (over: Partial<Env> = {}) => ({ DB: createTestDb(), GEMINI_API_KEY: 'k', ...over }) as Env
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0) // 04:00 PST

afterEach(() => vi.unstubAllGlobals())

describe('ai_usage', () => {
  it('RPM/TPM chỉ tính 60 giây gần nhất, RPD/token tính theo ngày Thái Bình Dương, tách theo model', async () => {
    const env = mkEnv()
    await recordUsage(env, 'm1', true, { prompt: 100, output: 50, total: 150 }, NOW - 30_000)
    await recordUsage(env, 'm1', true, { prompt: 10, output: 5, total: 15 }, NOW - 90_000) // ngoài cửa sổ phút
    await recordUsage(env, 'm1', false, undefined, NOW - 5_000) // bị từ chối: vẫn tính lượt
    await recordUsage(env, 'm2', true, { prompt: 999, output: 1, total: 1000 }, NOW - 1_000)
    const u = await usageFor(env, 'm1', NOW)
    expect(u).toMatchObject({ rpm: 2, tpm: 150, rpd: 3, tokens_today: { prompt: 110, output: 55, total: 165 } })
  })

  it('ngày khác (theo giờ Thái Bình Dương) không tính vào hôm nay', async () => {
    const env = mkEnv()
    await recordUsage(env, 'm1', true, { prompt: 1, output: 1, total: 2 }, NOW - 30 * 3600_000)
    expect((await usageFor(env, 'm1', NOW)).rpd).toBe(0)
  })

  it('ptDay và số giây tới 00:00 PT', () => {
    expect(ptDay(NOW)).toBe('2026-11-12')
    expect(secondsToPtMidnight(NOW)).toBe(20 * 3600) // 04:00 PST → 00:00 hôm sau = 20 giờ
  })

  it('DB lỗi / chưa có bảng: không ném lỗi', async () => {
    const env = { DB: { prepare: () => { throw new Error('x') } } } as unknown as Env
    await expect(recordUsage(env, 'm', true)).resolves.toBeUndefined()
    expect((await usageFor(env, 'm')).rpd).toBe(0)
  })

  it('gemini() ghi token từ usageMetadata (kể cả token suy luận); lỗi 429 cũng ghi một lượt', async () => {
    const env = mkEnv({ GEMINI_MODEL: 'gemini-3.5-flash-lite' })
    const ok = { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 20, totalTokenCount: 250 } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ok))))
    await gemini(env, [{ text: 'hi' }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(gemini(env, [{ text: 'hi' }])).rejects.toMatchObject({ kind: 'rate' })
    const u = await usageFor(env, 'gemini-3.5-flash-lite')
    expect(u).toMatchObject({ rpd: 2, tokens_today: { prompt: 200, output: 50, total: 250 } })
  })

  it('modelInfo: có hạn mức cho model trong danh sách, null cho model tự đặt', async () => {
    expect((await modelInfo(mkEnv({ GEMINI_MODEL: 'gemini-3.6-flash' }))).limits).toEqual({ rpm: 5, tpm: 250_000, rpd: 20 })
    expect((await modelInfo(mkEnv({ GEMINI_MODEL: 'gemini-x' }))).limits).toBeNull()
  })
})
