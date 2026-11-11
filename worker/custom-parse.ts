/**
 * Đọc lộ trình người học tự nhập hoặc nạp từ file Markdown/văn bản → danh sách tuần { topic, goal_vi }.
 *
 * Cách nhận diện (theo thứ tự ưu tiên):
 *  1. Có dòng "Tuần N …" / "Week N …" (tiêu đề, gạch đầu dòng hay chữ thường) → mỗi dòng đó là một tuần, các dòng khác bị bỏ.
 *  2. Có bảng Markdown → mỗi hàng dữ liệu là một tuần (cột đầu là số tuần thì bỏ, cột tiếp là chủ đề, cột sau nữa là mục tiêu).
 *  3. Có tiêu đề `#` → các tiêu đề ở cấp xuất hiện từ 2 lần trở lên (hoặc cấp cao nhất nếu chỉ có một tiêu đề) là các tuần;
 *     tiêu đề tên tài liệu xuất hiện một lần ở cấp cao hơn bị bỏ qua.
 *  4. Còn lại → mỗi dòng không trống một tuần.
 * Chủ đề có thể viết "Chủ đề | Mục tiêu". Bỏ chủ đề trùng. Tối đa MAX_WEEKS tuần.
 */
export const MAX_TOPIC = 80
export const MAX_GOAL = 200
export const MAX_WEEKS = 12
export const MAX_CUSTOM_CHARS = 20_000
export const DEFAULT_CUSTOM_GOAL = 'Học theo lộ trình của bạn'

export type CustomWeek = { topic: string; goal_vi: string }
export type CustomParse = { ok: true; weeks: CustomWeek[] } | { ok: false; message: string }

const WEEK_LINE = /^\s*(?:#{1,6}\s*)?(?:(?:[-*+•]|\d+[.)])\s*)?(?:[*_]{1,3})?\s*(?:tuần|tuan|week)\s*\d+/i
const WEEK_PREFIX = /^\s*(?:tuần|tuan|week)\s*\d+\s*(?:[:.\-–—)]\s*|\s+)?/i
const LIST_PREFIX = /^\s*(?:[-*+•]+|\d+\s*[.)])\s*/
const HEADING_MARK = /^\s*#{1,6}\s*/
const HEADING = /^(#{1,6})\s+(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Bỏ ký hiệu Markdown trong dòng: đậm/nghiêng, mã, liên kết, trích dẫn, tiêu đề. */
function cleanInline(s: string): string {
  return s
    .replace(/^\s*>+\s*/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function toWeek(raw: string): CustomWeek | null {
  const text = cleanInline(cleanInline(raw.replace(HEADING_MARK, '').replace(LIST_PREFIX, '')).replace(WEEK_PREFIX, '').replace(LIST_PREFIX, ''))
  if (!text) return null
  const [topic, ...rest] = text.split('|')
  const t = topic.trim().replace(/^[:\-–—]\s*/, '')
  if (!t) return null
  return { topic: t, goal_vi: rest.join('|').trim() || DEFAULT_CUSTOM_GOAL }
}

function tableWeeks(lines: string[]): CustomWeek[] {
  const out: CustomWeek[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!TABLE_ROW.test(line) || TABLE_SEP.test(line)) continue
    if (i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) continue // hàng tiêu đề cột
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => cleanInline(c))
    if (/^(?:\d+|(?:tuần|week)\s*\d+)$/i.test(cells[0] ?? '')) cells.shift()
    const topic = (cells[0] ?? '').trim()
    if (!topic) continue
    out.push({ topic, goal_vi: (cells[1] ?? '').trim() || DEFAULT_CUSTOM_GOAL })
  }
  return out
}

function headingWeeks(lines: string[]): CustomWeek[] {
  const heads = lines.map((l) => HEADING.exec(l)).filter((m): m is RegExpExecArray => m !== null)
  if (heads.length === 0) return []
  const count = new Map<number, number>()
  for (const m of heads) count.set(m[1].length, (count.get(m[1].length) ?? 0) + 1)
  const levels = [...count.keys()].sort((a, b) => a - b)
  const level = levels.find((l) => (count.get(l) ?? 0) >= 2) ?? levels[0]
  return heads.filter((m) => m[1].length === level).flatMap((m) => toWeek(m[2]) ?? [])
}

export function parseCustomPlan(input: string): CustomParse {
  if (input.length > MAX_CUSTOM_CHARS) return { ok: false, message: `Lộ trình quá dài (tối đa ${MAX_CUSTOM_CHARS} ký tự).` }
  const lines = input.replace(/^﻿/, '').split(/\r?\n/)

  // bỏ khối mã (```), vì không phải nội dung lộ trình
  const text: string[] = []
  let fenced = false
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      fenced = !fenced
      continue
    }
    if (!fenced) text.push(l)
  }

  let found: CustomWeek[]
  if (text.some((l) => WEEK_LINE.test(l))) found = text.filter((l) => WEEK_LINE.test(l)).flatMap((l) => toWeek(l) ?? [])
  else if (text.some((l) => TABLE_ROW.test(l) && !TABLE_SEP.test(l))) found = tableWeeks(text)
  else if (text.some((l) => HEADING.test(l))) found = headingWeeks(text)
  else found = text.filter((l) => l.trim() && !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(l)).flatMap((l) => toWeek(l) ?? [])

  const seen = new Set<string>()
  const weeks: CustomWeek[] = []
  for (const w of found) {
    if (w.topic.length > MAX_TOPIC) return { ok: false, message: `Chủ đề "${w.topic.slice(0, 20)}…" quá dài (tối đa ${MAX_TOPIC} ký tự).` }
    if (w.goal_vi.length > MAX_GOAL) return { ok: false, message: `Mục tiêu của "${w.topic}" quá dài (tối đa ${MAX_GOAL} ký tự).` }
    const key = w.topic.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    weeks.push(w)
  }
  if (weeks.length === 0) return { ok: false, message: 'Không tìm thấy chủ đề nào. Hãy nhập mỗi dòng một tuần, hoặc dùng tiêu đề/bảng/"Tuần N" trong file Markdown.' }
  if (weeks.length > MAX_WEEKS) return { ok: false, message: `Chỉ nhận tối đa ${MAX_WEEKS} tuần (tìm thấy ${weeks.length}). Hãy bớt tuần hoặc chia thành nhiều lộ trình.` }
  return { ok: true, weeks }
}
