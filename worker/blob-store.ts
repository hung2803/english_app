import type { Env } from './env'
import { toBase64 } from './upload-material'

/**
 * Nơi lưu file người học tải lên (PDF, văn bản).
 * - Có R2 (binding `FILES`): lưu ở R2.
 * - Không có R2: lưu ngay trong D1 (bảng file_blobs), mỗi file cắt thành các đoạn base64 nhỏ.
 * Hai chế độ dùng chung một khóa (`uploads.r2_key`), nên bật/tắt R2 không đổi phần còn lại của app.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>
  /** null = không có file */
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

/** Mỗi đoạn tối đa ~500 KB gốc (~670 KB base64): dưới giới hạn ~2 MB mỗi giá trị của D1. */
export const CHUNK_BYTES = 500_000

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function r2Store(bucket: R2Bucket): BlobStore {
  return {
    async put(key, bytes, mime) {
      await bucket.put(key, bytes, { httpMetadata: { contentType: mime } })
    },
    async get(key) {
      const obj = await bucket.get(key)
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null
    },
    async delete(key) {
      await bucket.delete(key)
    },
  }
}

function d1Store(db: D1Database): BlobStore {
  return {
    async put(key, bytes) {
      const stmts = [db.prepare('DELETE FROM file_blobs WHERE key = ?').bind(key)]
      for (let i = 0, part = 0; i < bytes.length || part === 0; i += CHUNK_BYTES, part++) {
        stmts.push(db.prepare('INSERT INTO file_blobs (key, part, data) VALUES (?, ?, ?)').bind(key, part, toBase64(bytes.subarray(i, i + CHUNK_BYTES))))
      }
      await db.batch(stmts) // một giao dịch: lỗi thì không để lại file dở dang
    },
    async get(key) {
      const { results } = await db.prepare('SELECT data FROM file_blobs WHERE key = ? ORDER BY part').bind(key).all<{ data: string }>()
      if (!results.length) return null
      const parts = results.map((r) => fromBase64(r.data))
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let at = 0
      for (const p of parts) {
        out.set(p, at)
        at += p.length
      }
      return out
    },
    async delete(key) {
      await db.prepare('DELETE FROM file_blobs WHERE key = ?').bind(key).run()
    },
  }
}

export const blobStore = (env: Env): BlobStore => (env.FILES ? r2Store(env.FILES) : d1Store(env.DB))
