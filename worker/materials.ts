import type { Env } from './env'
import { extractJson, gemini } from './gemini'
import { checkLink, keepValidLinks } from './link-check'
import { clipWords } from './text'

export type MaterialType = 'article' | 'youtube' | 'podcast' | 'upload'

export interface MaterialOption {
  type: MaterialType
  title: string
  url: string
  /** vì sao phù hợp, tiếng Việt */
  why_vi: string
  /** đoạn trích ngắn từ nguồn (chỉ lưu link + đoạn trích, không lưu toàn bộ nội dung) */
  excerpt: string
  /** có khi type = 'upload': id trong bảng uploads (tài liệu người học tải lên) */
  upload_id?: number
}

/** Danh sách lựa chọn của một buổi. chosen: null = chưa chọn; chỉ số = đã chọn; -1 = AI tự viết bài (fallback). */
export interface MaterialSet {
  options: MaterialOption[]
  chosen: number | null
  fallback: boolean
  /** vì sao phải để AI tự viết bài: không tìm được tài liệu dùng được, hay bước tìm kiếm bị lỗi */
  fallback_reason?: 'no_results' | 'search_error'
}

/** Đoạn trích hiển thị ở danh sách lựa chọn: ngắn (chỉ lưu link + đoạn trích, không lưu nội dung gốc). */
export const MATERIAL_EXCERPT_WORDS = 40
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 3
/** Xin AI nhiều hơn số cần hiển thị, vì một số link sẽ bị loại khi kiểm tra. */
export const MAX_CANDIDATES = 5

export interface SearchContext {
  level: string
  topic: string
  /** buổi thứ mấy trong lộ trình, để AI đổi góc tiếp cận */
  seq: number
  /** nguồn đã dùng ở các buổi trước, không đưa lại */
  excludeUrls: string[]
}

const TYPE_ALIASES: Record<string, MaterialType> = {
  article: 'article', web: 'article', webpage: 'article', blog: 'article', news: 'article',
  youtube: 'youtube', video: 'youtube',
  podcast: 'podcast', audio: 'podcast',
}

const cut = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

/** Chuẩn hóa URL để so trùng: bỏ #fragment, tham số theo dõi, dấu / cuối, www. */
export function urlKey(u: string): string {
  try {
    const x = new URL(u)
    x.hash = ''
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|si$)/i.test(k)) x.searchParams.delete(k)
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase()
  } catch {
    return u.toLowerCase()
  }
}

/**
 * Làm sạch kết quả AI: chỉ giữ mục có đủ tiêu đề + URL http(s) hợp lệ + loại tài liệu hiểu được;
 * bỏ trùng (kể cả trùng nguồn đã dùng); tối đa 3.
 */
export function normalizeOptions(raw: unknown, excludeUrls: string[] = [], limit = MAX_OPTIONS): MaterialOption[] {
  const list = (raw as { options?: unknown })?.options
  if (!Array.isArray(list)) return []
  const seen = new Set(excludeUrls.map(urlKey))
  const out: MaterialOption[] = []
  for (const o of list as Record<string, unknown>[]) {
    const type = TYPE_ALIASES[String(o?.type ?? '').toLowerCase().trim()]
    const title = cut(o?.title, 160)
    const url = cut(o?.url, 500)
    if (!type || !title || !/^https?:\/\/[^\s]+$/i.test(url)) continue
    const key = urlKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type, title, url, why_vi: cut(o?.why_vi, 240), excerpt: clipWords(cut(o?.excerpt, 400), MATERIAL_EXCERPT_WORDS) })
    if (out.length === limit) break
  }
  return out
}

export function buildSearchPrompt(c: SearchContext): string {
  return `Use Google Search to find ${MAX_CANDIDATES} different, FREE, currently accessible English learning materials for a Vietnamese learner at CEFR level ${c.level}.
Topic of the week: "${c.topic}" (this is session ${c.seq} of the course, so pick a fresh angle).
Allowed types, mix them if possible:
- "article": a short free web article or lesson page (no paywall, no login);
- "youtube": a short YouTube video (under 10 minutes) that has English captions;
- "podcast": a podcast episode whose page has a full transcript.
Rules: language level must suit ${c.level}; prefer short, clear sources; give REAL URLs you actually found, never invent one.${
    c.excludeUrls.length ? `\nDo NOT use these sources again:\n${c.excludeUrls.slice(0, 30).map((u) => `- ${u}`).join('\n')}` : ''
  }
Return ONLY a JSON object, no other text:
{"options":[{"type":"article|youtube|podcast","title":"...","url":"https://...","why_vi":"1 câu tiếng Việt: vì sao phù hợp với trình độ và chủ đề","excerpt":"a short quote copied from the source, max 40 words"}]}`
}

/**
 * AI tìm tài liệu bằng Google Search, rồi KIỂM TRA từng link (còn sống, đọc được, đúng loại) trước khi đưa cho người học.
 * Trả về 0–3 lựa chọn đã kiểm tra.
 * Lỗi AI (từ chối, quá hạn…) được ném ra để bên gọi báo người học thử lại.
 */
export async function findMaterials(env: Env, c: SearchContext, check: typeof checkLink = checkLink): Promise<MaterialOption[]> {
  const text = await gemini(env, [{ text: buildSearchPrompt(c) }], { tools: [{ google_search: {} }], timeoutMs: 45_000 })
  let parsed: unknown
  try {
    parsed = extractJson<unknown>(text)
  } catch {
    return [] // AI trả lời bằng văn xuôi, không có JSON dùng được → coi như không tìm được
  }
  const candidates = normalizeOptions(parsed, c.excludeUrls, MAX_CANDIDATES)
  return (await keepValidLinks(candidates, check)).slice(0, MAX_OPTIONS)
}
