import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { AiError, aiErrorBody, handleError } from './errors'
import { gemini, extractJson } from './gemini'
import type { Env } from './env'

const env = { GEMINI_API_KEY: 'k' } as Env

afterEach(() => vi.unstubAllGlobals())

const stubFetch = (res: Response | Error) =>
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (res instanceof Error) throw res
    return res
  }))

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return (e as AiError).kind
  }
  return 'no-error'
}

describe('gemini() phân loại lỗi', () => {
  it('thiếu khóa → config', async () => {
    expect(await kindOf(gemini({} as Env, [{ text: 'x' }]))).toBe('config')
  })
  it('503 báo "Google quá tải", 429 báo hết hạn mức (không nhầm lẫn)', () => {
    expect(aiErrorBody(new AiError('rate', 'Gemini 503')).message).toMatch(/quá tải/)
    expect(aiErrorBody(new AiError('rate', 'Gemini 429')).message).toMatch(/hết hạn mức/)
  })

  it('429 và 503 → rate', async () => {
    stubFetch(new Response('', { status: 429 }))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('rate')
    stubFetch(new Response('', { status: 503 }))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('rate')
  })
  it('403, 404 (model bị gỡ) và 400 "API key not valid" → config', async () => {
    for (const status of [403, 404]) {
      stubFetch(new Response('', { status }))
      expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('config')
    }
    stubFetch(new Response('API key not valid', { status: 400 }))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('config')
  })
  it('500 → other', async () => {
    stubFetch(new Response('', { status: 500 }))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('other')
  })
  it('quá thời gian → timeout; lỗi mạng → other', async () => {
    stubFetch(Object.assign(new Error('t'), { name: 'TimeoutError' }))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('timeout')
    stubFetch(new TypeError('network'))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('other')
  })
  it('trả rỗng hoặc bị chặn → other', async () => {
    stubFetch(Response.json({ candidates: [] }))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('other')
    stubFetch(Response.json({ promptFeedback: { blockReason: 'SAFETY' } }))
    expect(await kindOf(gemini(env, [{ text: 'x' }]))).toBe('other')
  })
  it('thành công trả văn bản', async () => {
    stubFetch(Response.json({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }))
    expect(await gemini(env, [{ text: 'x' }])).toBe('{"a":1}')
  })
})

describe('extractJson', () => {
  it('bóc JSON khỏi khối markdown', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('JSON hỏng → AiError other', () => {
    expect(() => extractJson('{"a":')).toThrow(AiError)
    expect(() => extractJson('không có json')).toThrow(AiError)
  })
})

describe('handleError → phản hồi API thống nhất', () => {
  const app = new Hono()
  app.onError(handleError)
  app.get('/rate', () => { throw new AiError('rate', 'x') })
  app.get('/config', () => { throw new AiError('config', 'x') })
  app.get('/boom', () => { throw new Error('boom') })

  it('rate: 503, retryable, có Retry-After, thông báo tiếng Việt', async () => {
    const r = await app.request('/rate')
    expect(r.status).toBe(503)
    expect(r.headers.get('Retry-After')).toBe('60')
    expect(await r.json()).toMatchObject({ error: 'ai_unavailable', kind: 'rate', retryable: true })
  })
  it('config: không cho thử lại', async () => {
    const body = (await (await app.request('/config')).json()) as { retryable: boolean; message: string }
    expect(body.retryable).toBe(false)
    expect(body.message).toContain('GEMINI_API_KEY')
  })
  it('lỗi khác: 500, không lộ chi tiết', async () => {
    const r = await app.request('/boom')
    expect(r.status).toBe(500)
    expect(JSON.stringify(await r.json())).not.toContain('boom')
  })
})
