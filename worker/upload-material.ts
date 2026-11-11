import type { MaterialOption, MaterialSet } from './materials'

export interface UploadUsage {
  /** số buổi đã CHỌN tài liệu này trong lộ trình */
  count: number
  /** tiêu đề các bài đã soạn từ tài liệu này (để AI không lặp lại) */
  titles: string[]
}

/** Thống kê mỗi tài liệu tải lên đã được dùng mấy buổi trong lộ trình (không tính buổi `exceptSessionId`). */
export async function usageByUpload(db: D1Database, planId: number, exceptSessionId: number): Promise<Map<number, UploadUsage>> {
  const { results } = await db
    .prepare('SELECT material_json, lesson_json FROM sessions WHERE plan_id = ? AND id != ? AND material_json IS NOT NULL ORDER BY seq')
    .bind(planId, exceptSessionId)
    .all<{ material_json: string; lesson_json: string | null }>()
  const usage = new Map<number, UploadUsage>()
  for (const r of results) {
    const m = JSON.parse(r.material_json) as MaterialSet
    const chosen = m.chosen !== null && m.chosen >= 0 ? m.options[m.chosen] : undefined
    if (!chosen || chosen.type !== 'upload' || !chosen.upload_id) continue
    const u = usage.get(chosen.upload_id) ?? { count: 0, titles: [] }
    u.count++
    const title = r.lesson_json ? (JSON.parse(r.lesson_json) as { title?: string }).title : undefined
    if (title) u.titles.push(title)
    usage.set(chosen.upload_id, u)
  }
  return usage
}

/**
 * Chọn MỘT tài liệu người học đã tải lên để đưa vào danh sách lựa chọn của buổi:
 * tài liệu được dùng ít buổi nhất trong lộ trình này; bằng nhau thì lấy cái tải lên gần nhất.
 * Không có tài liệu nào → null.
 */
export async function pickUploadOption(db: D1Database, planId: number, sessionId: number): Promise<MaterialOption | null> {
  const { results } = await db
    .prepare('SELECT id, kind, title, url, excerpt FROM uploads ORDER BY id DESC')
    .all<{ id: number; kind: 'file' | 'link'; title: string; url: string | null; excerpt: string | null }>()
  if (!results.length) return null
  const usage = await usageByUpload(db, planId, sessionId)
  let best = results[0]
  for (const u of results) if ((usage.get(u.id)?.count ?? 0) < (usage.get(best.id)?.count ?? 0)) best = u
  return {
    type: 'upload',
    title: best.title,
    url: best.kind === 'link' ? (best.url ?? '') : '',
    upload_id: best.id,
    why_vi: 'Tài liệu bạn đã tải lên.',
    excerpt: best.excerpt ?? '',
  }
}

/** Chia văn bản thành các đoạn lớn (~`size` ký tự) theo ranh giới đoạn văn, để học dần từng phần của tài liệu dài. */
export function splitSegments(text: string, size = 6000): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  let cur = ''
  const push = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const p of paras) {
    if (p.length > size) {
      push()
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size))
    } else if (cur && cur.length + p.length + 2 > size) {
      push()
      cur = p
    } else {
      cur = cur ? cur + '\n\n' + p : p
    }
  }
  push()
  return out.length ? out : [text.trim().slice(0, size)]
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
