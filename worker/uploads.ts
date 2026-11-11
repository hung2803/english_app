import type { Env } from './env'
import { inspectPage, isSafeUrl, type LinkProblem } from './link-check'
import { urlKey } from './materials'
import { clipWords } from './text'

/** Giới hạn mỗi file: 10 MB (Gemini nhận tối đa ~20 MB cả yêu cầu, base64 nở thêm ~33%). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_TITLE = 120
export const UPLOAD_EXCERPT_WORDS = 40
const MIN_LINK_CHARS = 300

export type FileKind = 'pdf' | 'text'

export interface UploadRow {
  id: number
  kind: 'file' | 'link'
  title: string
  url: string | null
  mime: string | null
  size_bytes: number | null
  excerpt: string | null
  created_at: string
}

/** Dạng gửi cho client: KHÔNG có khóa R2. */
export const COLUMNS = 'id, kind, title, url, mime, size_bytes, excerpt, created_at'

export type DetectResult = { ok: true; kind: FileKind; mime: string; ext: string; text?: string } | { ok: false; reason: 'empty' | 'unsupported_type' | 'type_mismatch' }

const EXT_KIND: Record<string, FileKind> = { pdf: 'pdf', txt: 'text', md: 'text' }

const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')

function isPdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  return head.includes('%PDF-')
}

/**
 * Nhận dạng file bằng NỘI DUNG (không tin phần mở rộng hay Content-Type do client gửi):
 * PDF phải có chữ ký %PDF-; văn bản phải là UTF-8 hợp lệ, không có byte NUL. Phần mở rộng phải khớp nội dung.
 */
export function detectFileType(bytes: Uint8Array, filename: string): DetectResult {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty' }
  const ext = extOf(filename)
  const want = EXT_KIND[ext]
  if (!want) return { ok: false, reason: 'unsupported_type' }

  if (isPdf(bytes)) return want === 'pdf' ? { ok: true, kind: 'pdf', mime: 'application/pdf', ext } : { ok: false, reason: 'type_mismatch' }
  if (want === 'pdf') return { ok: false, reason: 'type_mismatch' }

  if (bytes.subarray(0, 8192).includes(0)) return { ok: false, reason: 'type_mismatch' } // nhị phân
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return { ok: true, kind: 'text', mime: 'text/plain', ext, text }
  } catch {
    return { ok: false, reason: 'type_mismatch' }
  }
}

/** Tên hiển thị: bỏ ký tự điều khiển, gộp khoảng trắng, cắt độ dài. */
export function sanitizeTitle(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

const baseName = (filename: string) => sanitizeTitle(filename.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, ''))

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type SaveResult =
  | { ok: true; upload: UploadRow }
  | { ok: false; reason: 'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch' | 'duplicate'; existingId?: number }

/** Lưu file người học tải lên: kiểm tra nội dung, chống trùng, ghi vào R2 rồi ghi CSDL (lỗi CSDL thì xóa file vừa ghi). */
export async function saveFileUpload(env: Env, f: { name: string; bytes: Uint8Array; title?: string }, today: string): Promise<SaveResult> {
  if (f.bytes.byteLength > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' }
  const t = detectFileType(f.bytes, f.name)
  if (!t.ok) return t

  const hash = await sha256(f.bytes)
  const dup = await env.DB.prepare('SELECT id FROM uploads WHERE sha256 = ?').bind(hash).first<{ id: number }>()
  if (dup) return { ok: false, reason: 'duplicate', existingId: dup.id }

  const title = sanitizeTitle(f.title ?? '') || baseName(f.name) || 'Tài liệu'
  const key = `uploads/${crypto.randomUUID()}.${t.ext}` // không dùng tên file của client trong khóa lưu trữ
  const excerpt = t.kind === 'text' ? clipWords(t.text!, UPLOAD_EXCERPT_WORDS) || null : null

  await env.FILES.put(key, f.bytes, { httpMetadata: { contentType: t.mime } })
  try {
    const row = await env.DB.prepare(
      `INSERT INTO uploads (kind, title, r2_key, mime, size_bytes, excerpt, created_at, sha256)
       VALUES ('file', ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
      .bind(title, key, t.mime, f.bytes.byteLength, excerpt, today, hash)
      .first<UploadRow>()
    return { ok: true, upload: row! }
  } catch (e) {
    await env.FILES.delete(key).catch(() => {})
    if (/UNIQUE/i.test(String(e))) return { ok: false, reason: 'duplicate' } // hai yêu cầu cùng lúc
    throw e
  }
}

export type LinkSaveResult =
  | { ok: true; upload: UploadRow }
  | { ok: false; reason: 'bad_url' | 'duplicate' | LinkProblem; existingId?: number }

/** Lưu link người học đưa: phải là trang web công khai đọc được. Chỉ lưu link + tiêu đề + đoạn trích ngắn. */
export async function saveLinkUpload(env: Env, rawUrl: string, title: string | undefined, today: string): Promise<LinkSaveResult> {
  const url = rawUrl.trim()
  if (!/^https?:\/\//i.test(url) || url.length > 500) return { ok: false, reason: 'bad_url' }
  if (!isSafeUrl(url)) return { ok: false, reason: 'unsafe_url' }

  const key = urlKey(url)
  const { results } = await env.DB.prepare("SELECT id, url FROM uploads WHERE kind = 'link'").all<{ id: number; url: string }>()
  const dup = results.find((r) => urlKey(r.url) === key)
  if (dup) return { ok: false, reason: 'duplicate', existingId: dup.id }

  const page = await inspectPage(url)
  if (!page.ok) return { ok: false, reason: page.problem }
  if (page.text.length < MIN_LINK_CHARS) return { ok: false, reason: 'too_short' }

  const name = sanitizeTitle(title ?? '') || sanitizeTitle(page.title.replace(/&[#\w]+;/g, ' ')) || new URL(url).hostname
  const row = await env.DB.prepare(
    `INSERT INTO uploads (kind, title, url, mime, excerpt, created_at) VALUES ('link', ?, ?, 'text/html', ?, ?) RETURNING ${COLUMNS}`,
  )
    .bind(name, url, clipWords(page.text, UPLOAD_EXCERPT_WORDS), today)
    .first<UploadRow>()
  return { ok: true, upload: row! }
}

// ---------- Danh sách + xóa ----------

export interface UploadListItem extends UploadRow {
  /** số buổi đã CHỌN tài liệu này */
  times_used: number
  /** đang được chọn ở một buổi chưa xong (xóa sẽ làm buổi đó phải để AI tự viết bài) */
  in_use: boolean
}

interface MaterialLike {
  options: { type: string; upload_id?: number }[]
  chosen: number | null
  fallback: boolean
  fallback_reason?: string
}

/** Danh sách tài liệu đã tải (mới nhất trước), kèm số buổi đã dùng. Không lộ khóa R2. */
export async function listUploads(db: D1Database): Promise<{ uploads: UploadListItem[]; total_bytes: number }> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM uploads ORDER BY id DESC`).all<UploadRow>()
  const { results: sess } = await db
    .prepare(`SELECT material_json, status FROM sessions WHERE material_json LIKE '%"type":"upload"%'`)
    .all<{ material_json: string; status: string }>()
  const used = new Map<number, { times: number; open: boolean }>()
  for (const s of sess) {
    const m = JSON.parse(s.material_json) as MaterialLike
    const o = m.chosen !== null && m.chosen >= 0 ? m.options[m.chosen] : undefined
    if (!o || o.type !== 'upload' || !o.upload_id) continue
    const u = used.get(o.upload_id) ?? { times: 0, open: false }
    u.times++
    if (s.status !== 'done') u.open = true
    used.set(o.upload_id, u)
  }
  const uploads = results.map((r) => ({ ...r, times_used: used.get(r.id)?.times ?? 0, in_use: used.get(r.id)?.open ?? false }))
  return { uploads, total_bytes: results.reduce((a, r) => a + (r.size_bytes ?? 0), 0) }
}

export type DeleteResult = { ok: true; removed_from_sessions: number; storage_cleaned: boolean } | { ok: false; reason: 'not_found' }

/**
 * Xóa tài liệu đã tải: xóa dòng CSDL, bỏ khỏi danh sách lựa chọn của các buổi CHƯA chọn, rồi xóa file ở R2.
 * Bài đã soạn từ tài liệu này được giữ nguyên (chỉ lưu đoạn trích). Buổi đã chọn nhưng chưa soạn sẽ để AI tự viết bài.
 * Xóa R2 lỗi thì vẫn coi là đã xóa (file mồ côi không ảnh hưởng ai), chỉ báo `storage_cleaned: false`.
 */
export async function deleteUpload(env: Env, id: number): Promise<DeleteResult> {
  const row = await env.DB.prepare('SELECT r2_key FROM uploads WHERE id = ?').bind(id).first<{ r2_key: string | null }>()
  if (!row) return { ok: false, reason: 'not_found' }

  // buổi chưa chọn tài liệu mà danh sách có tài liệu này → gỡ khỏi danh sách (nếu hết lựa chọn thì chuyển sang AI tự viết)
  const { results: pending } = await env.DB.prepare(
    `SELECT id, material_json FROM sessions WHERE lesson_json IS NULL AND material_json LIKE '%"upload_id":${Number(id)}%'`,
  ).all<{ id: number; material_json: string }>()
  const updates: D1PreparedStatement[] = []
  for (const s of pending) {
    const m = JSON.parse(s.material_json) as MaterialLike
    if (m.chosen !== null) continue // đã chọn rồi thì khóa, không đổi (bài sẽ được AI viết khi soạn)
    const options = m.options.filter((o) => !(o.type === 'upload' && o.upload_id === id))
    if (options.length === m.options.length) continue
    const next: MaterialLike =
      options.length > 0 ? { ...m, options } : { options: [], chosen: -1, fallback: true, fallback_reason: 'no_results' }
    updates.push(env.DB.prepare('UPDATE sessions SET material_json = ? WHERE id = ?').bind(JSON.stringify(next), s.id))
  }
  await env.DB.batch([...updates, env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(id)])

  let storage_cleaned = true
  if (row.r2_key) {
    try {
      await env.FILES.delete(row.r2_key)
    } catch (e) {
      storage_cleaned = false
      console.error('r2 delete failed', row.r2_key, e)
    }
  }
  return { ok: true, removed_from_sessions: updates.length, storage_cleaned }
}
