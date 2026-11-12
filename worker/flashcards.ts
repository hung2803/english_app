import { addDays } from './dates'
import { GRADES, review, type CardNext, type Grade } from './srs'

export interface Card {
  id: number
  word: string
  pos: string | null
  meaning: string
  example: string | null
}

/** Mặc định mỗi lần ôn ~10 thẻ ≈ 5 phút (cỡ 30 giây/thẻ). */
export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 50

export const isGrade = (g: unknown): g is Grade => typeof g === 'string' && (GRADES as string[]).includes(g)

/** Số thẻ đến hạn ôn (hạn ôn ≤ hôm nay). */
export async function countDue(db: D1Database, today: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM vocab WHERE due_date <= ?').bind(today).first<{ n: number }>())?.n ?? 0
}

/** Các thẻ đến hạn, cũ nhất trước (quá hạn lâu nhất ôn trước), tối đa `limit`. */
export async function dueCards(db: D1Database, today: string, limit = DEFAULT_LIMIT): Promise<{ cards: Card[]; total_due: number }> {
  const n = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT)
  const { results } = await db
    .prepare('SELECT id, word, pos, meaning, example FROM vocab WHERE due_date <= ? ORDER BY due_date, id LIMIT ?')
    .bind(today, n)
    .all<Card>()
  return { cards: results, total_due: await countDue(db, today) }
}

/** Phạm vi ôn tự do: mọi từ, từ đang học (chưa thuộc), hoặc từ đã thuộc. */
export type PracticeScope = 'all' | 'learning' | 'learned'
export const SCOPES: PracticeScope[] = ['all', 'learning', 'learned']
const SCOPE_SQL: Record<PracticeScope, string> = { all: '1 = 1', learning: 'learned = 0', learned: 'learned = 1' }

/**
 * Ôn tự do: lấy ngẫu nhiên các thẻ BẤT KỲ (kể cả chưa đến hạn) trong phạm vi chọn, tối đa `limit`.
 * `total_due` ở đây là tổng số thẻ trong phạm vi (giữ chung dạng dữ liệu với dueCards để dùng lại giao diện thẻ).
 */
export async function practiceCards(db: D1Database, scope: PracticeScope, limit = DEFAULT_LIMIT): Promise<{ cards: Card[]; total_due: number }> {
  const n = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT)
  const where = SCOPE_SQL[scope]
  const { results } = await db.prepare(`SELECT id, word, pos, meaning, example FROM vocab WHERE ${where} ORDER BY RANDOM() LIMIT ?`).bind(n).all<Card>()
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM vocab WHERE ${where}`).first<{ n: number }>())?.n ?? 0
  return { cards: results, total_due: total }
}

export type ReviewResult = { ok: true; next: CardNext & { due_date: string }; remaining_due: number } | { ok: false; reason: 'not_found' }

/** Chấm một lần ôn: tính lịch ôn kế tiếp bằng SRS, cập nhật "đã thuộc", trả số thẻ còn đến hạn. */
/**
 * `practice` = ôn tự do (thẻ có thể chưa đến hạn): chỉ "Quên" làm đổi lịch (thẻ quay lại ôn hôm nay); Khó/Tốt/Dễ giữ nguyên lịch
 * để ôn sớm không đẩy lịch ôn ra xa một cách giả tạo.
 */
export async function reviewCard(db: D1Database, id: number, grade: Grade, today: string, practice = false): Promise<ReviewResult> {
  const card = await db.prepare('SELECT interval_days, ease, reps, learned, due_date FROM vocab WHERE id = ?').bind(id).first<{ interval_days: number; ease: number; reps: number; learned: 0 | 1; due_date: string }>()
  if (!card) return { ok: false, reason: 'not_found' }
  if (practice && grade !== 'again') {
    const due_in = Math.max(0, Math.round((Date.parse(card.due_date) - Date.parse(today)) / 86_400_000))
    return { ok: true, next: { interval_days: card.interval_days, ease: card.ease, reps: card.reps, learned: card.learned, due_in, due_date: card.due_date }, remaining_due: await countDue(db, today) }
  }
  const next = review(card, grade)
  const due_date = addDays(today, next.due_in)
  await db
    .prepare('UPDATE vocab SET interval_days = ?, ease = ?, reps = ?, learned = ?, due_date = ? WHERE id = ?')
    .bind(next.interval_days, next.ease, next.reps, next.learned, due_date, id)
    .run()
  return { ok: true, next: { ...next, due_date }, remaining_due: await countDue(db, today) }
}

// ---------- Kho từ vựng ----------

export interface VocabItem extends Card {
  due_date: string
  interval_days: number
  reps: number
  learned: 0 | 1
  wrong_count: number
  session_id: number | null
  created_at: string
}

export type VocabFilter = 'all' | 'due' | 'learned' | 'learning'
export const FILTERS: VocabFilter[] = ['all', 'due', 'learned', 'learning']

/** Bỏ dấu + hạ chữ thường để tìm kiếm không phân biệt hoa thường và dấu tiếng Việt. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export interface VocabPage {
  items: VocabItem[]
  /** số kết quả khớp bộ lọc + tìm kiếm */
  matched: number
  page: number
  page_size: number
  stats: { total: number; learned: number; due: number }
}

export const PAGE_SIZE = 50

/**
 * Kho từ vựng: tìm theo từ hoặc nghĩa (không phân biệt hoa thường và dấu), lọc theo trạng thái, phân trang.
 * - all: tất cả; due: đến hạn ôn; learned: đã thuộc; learning: đang học (chưa thuộc).
 */
export async function listVocab(db: D1Database, today: string, opts: { q?: string; filter?: VocabFilter; page?: number } = {}): Promise<VocabPage> {
  const { results } = await db
    .prepare('SELECT id, word, pos, meaning, example, due_date, interval_days, reps, learned, wrong_count, session_id, created_at FROM vocab ORDER BY id DESC')
    .all<VocabItem>()
  const stats = {
    total: results.length,
    learned: results.filter((v) => v.learned === 1).length,
    due: results.filter((v) => v.due_date <= today).length,
  }
  const q = fold(opts.q ?? '')
  const filter = opts.filter && FILTERS.includes(opts.filter) ? opts.filter : 'all'
  const matches = results.filter((v) => {
    if (filter === 'due' && v.due_date > today) return false
    if (filter === 'learned' && v.learned !== 1) return false
    if (filter === 'learning' && v.learned === 1) return false
    return !q || fold(v.word).includes(q) || fold(v.meaning).includes(q)
  })
  const page = Math.max(1, Math.floor(opts.page ?? 1) || 1)
  return { items: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), matched: matches.length, page, page_size: PAGE_SIZE, stats }
}
