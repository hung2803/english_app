import { describe, expect, it } from 'vitest'
import { blobStore, CHUNK_BYTES } from './blob-store'
import { deleteUpload, saveFileUpload } from './uploads'
import { createTestDb } from './test-db'
import type { Env } from './env'

const mkEnv = (over: Partial<Env> = {}) => ({ DB: createTestDb(), ...over }) as Env
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256)
const count = async (env: Env) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM file_blobs').first<{ n: number }>())!.n

describe('kho file trong D1 (không có R2)', () => {
  it('lưu rồi đọc lại đúng từng byte: file nhỏ, file rỗng, file nhiều đoạn', async () => {
    const env = mkEnv()
    const s = blobStore(env)
    for (const n of [0, 1, 1234, CHUNK_BYTES, CHUNK_BYTES + 1, CHUNK_BYTES * 2 + 777]) {
      const data = bytesOf(n)
      await s.put(`k/${n}`, data, 'application/octet-stream')
      expect(await s.get(`k/${n}`)).toEqual(data)
    }
  })

  it('file lớn được cắt thành đoạn nhỏ hơn giới hạn 2 MB của D1', async () => {
    const env = mkEnv()
    await blobStore(env).put('big', bytesOf(CHUNK_BYTES * 3 + 5), 'application/pdf')
    expect(await count(env)).toBe(4)
    const max = (await env.DB.prepare('SELECT MAX(LENGTH(data)) AS m FROM file_blobs').first<{ m: number }>())!.m
    expect(max).toBeLessThan(1_000_000)
  })

  it('ghi đè cùng khóa: không còn đoạn thừa của bản cũ', async () => {
    const env = mkEnv()
    const s = blobStore(env)
    await s.put('k', bytesOf(CHUNK_BYTES * 3), 'x')
    await s.put('k', bytesOf(10), 'x')
    expect(await count(env)).toBe(1)
    expect(await s.get('k')).toEqual(bytesOf(10))
  })

  it('khóa không tồn tại → null; xóa chỉ xóa đúng khóa đó', async () => {
    const env = mkEnv()
    const s = blobStore(env)
    expect(await s.get('none')).toBeNull()
    await s.put('a', bytesOf(5), 'x')
    await s.put('b', bytesOf(6), 'x')
    await s.delete('a')
    expect(await s.get('a')).toBeNull()
    expect(await s.get('b')).toEqual(bytesOf(6))
    await s.delete('none') // không lỗi
  })

  it('có R2 (binding FILES) thì dùng R2, không đụng bảng D1', async () => {
    const stored = new Map<string, Uint8Array>()
    const bucket = {
      put: async (k: string, v: Uint8Array) => void stored.set(k, v),
      get: async (k: string) => (stored.has(k) ? { arrayBuffer: async () => stored.get(k)!.buffer } : null),
      delete: async (k: string) => void stored.delete(k),
    } as unknown as R2Bucket
    const env = mkEnv({ FILES: bucket })
    await blobStore(env).put('r', bytesOf(20), 'x')
    expect(stored.has('r')).toBe(true)
    expect(await count(env)).toBe(0)
    expect(await blobStore(env).get('r')).toEqual(bytesOf(20))
    await blobStore(env).delete('r')
    expect(stored.size).toBe(0)
  })
})

describe('tải tài liệu lên khi không có R2', () => {
  const TXT = new TextEncoder().encode('Chapter one begins here. '.repeat(40))

  it('saveFileUpload lưu nội dung vào D1; xóa tài liệu thì xóa luôn nội dung', async () => {
    const env = mkEnv()
    const r = await saveFileUpload(env, { name: 'story.txt', bytes: TXT }, '2026-11-12')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const row = (await env.DB.prepare('SELECT r2_key FROM uploads WHERE id = ?').bind(r.upload.id).first<{ r2_key: string }>())!
    expect(await blobStore(env).get(row.r2_key)).toEqual(TXT)
    expect(await count(env)).toBeGreaterThan(0)

    const d = await deleteUpload(env, r.upload.id)
    expect(d).toMatchObject({ ok: true, storage_cleaned: true })
    expect(await count(env)).toBe(0)
  })

  it('tải trùng file: báo trùng, không để lại nội dung thừa', async () => {
    const env = mkEnv()
    expect((await saveFileUpload(env, { name: 'a.txt', bytes: TXT }, '2026-11-12')).ok).toBe(true)
    const before = await count(env)
    expect(await saveFileUpload(env, { name: 'b.txt', bytes: TXT }, '2026-11-12')).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(await count(env)).toBe(before)
  })
})
