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
/** Trần số thẻ ôn mỗi ngày: thẻ đến hạn vượt trần xếp hàng sang ngày sau, không dồn hàng trăm thẻ một lúc. */
export const DAILY_CAP = 20
/** Viết đúng từ và chọn Tốt/Dễ liên tiếp chừng này lần thì "đã thuộc" (thay cho chờ khoảng cách ôn 21 ngày; khoảng cách ≥ 21 ngày vẫn tính là thuộc). */
export const STREAK_TO_LEARN = 3

export const isGrade = (g: unknown): g is Grade => typeof g === 'string' && (GRADES as string[]).includes(g)

/** So khớp từ người học viết: bỏ khoảng trắng thừa, không phân biệt hoa/thường. */
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** Số thẻ đến hạn ôn (hạn ôn ≤ hôm nay), chưa tính trần ngày. */
export async function countDue(db: D1Database, today: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM vocab WHERE due_date <= ?').bind(today).first<{ n: number }>())?.n ?? 0
}

export interface Quota {
  cap: number
  /** số thẻ đã ôn xong hôm nay (không còn đến hạn) */
  done: number
  /** số thẻ đến hạn thật sự */
  due: number
  /** số thẻ được ôn hôm nay trong trần (≤ due) */
  shown: number
  /** số thẻ đến hạn phải chờ sang ngày sau vì vượt trần */
  backlog: number
}

/** Hạn mức ôn hôm nay: trần 20 thẻ trừ số thẻ đã ôn xong hôm nay. Thẻ vừa bấm Quên (còn đến hạn) vẫn chiếm chỗ trong phần còn lại. */
export async function quotaFor(db: D1Database, today: string): Promise<Quota> {
  const done = (await db.prepare('SELECT COUNT(*) AS n FROM vocab WHERE reviewed_on = ? AND due_date > ?').bind(today, today).first<{ n: number }>())?.n ?? 0
  const due = await countDue(db, today)
  const shown = Math.min(due, Math.max(0, DAILY_CAP - done))
  return { cap: DAILY_CAP, done, due, shown, backlog: due - shown }
}

export interface DueResult {
  cards: Card[]
  /** số thẻ cần ôn hôm nay (đã tính trần ngày) */
  total_due: number
  backlog: number
  daily_cap: number
  done_today: number
}

/**
 * Các thẻ đến hạn hôm nay, tối đa `limit` thẻ và không vượt trần ngày. Thứ tự ưu tiên:
 * 1) thẻ vừa bấm Quên hôm nay (ôn lại ngay), 2) thẻ hay sai nhất (sai quiz + quên), 3) quá hạn lâu nhất.
 */
export async function dueCards(db: D1Database, today: string, limit = DEFAULT_LIMIT): Promise<DueResult> {
  const q = await quotaFor(db, today)
  const n = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT, q.shown)
  const cards = n
    ? (
        await db
          .prepare(
            `SELECT id, word, pos, meaning, example FROM vocab WHERE due_date <= ?
             ORDER BY (reviewed_on = ?) DESC, (wrong_count + lapses) DESC, due_date, id LIMIT ?`,
          )
          .bind(today, today, n)
          .all<Card>()
      ).results
    : []
  return { cards, total_due: q.shown, backlog: q.backlog, daily_cap: q.cap, done_today: q.done }
}

/** Phạm vi ôn tự do: mọi từ, từ đang học (chưa thuộc), hoặc từ đã thuộc. */
export type PracticeScope = 'all' | 'learning' | 'learned'
export const SCOPES: PracticeScope[] = ['all', 'learning', 'learned']
const SCOPE_SQL: Record<PracticeScope, string> = { all: '1 = 1', learning: 'learned = 0', learned: 'learned = 1' }

/**
 * Ôn tự do: lấy ngẫu nhiên các thẻ BẤT KỲ (kể cả chưa đến hạn) trong phạm vi chọn, tối đa `limit`. Không tính vào trần ngày.
 * `total_due` ở đây là tổng số thẻ trong phạm vi (giữ chung dạng dữ liệu với dueCards để dùng lại giao diện thẻ).
 */
export async function practiceCards(db: D1Database, scope: PracticeScope, limit = DEFAULT_LIMIT): Promise<DueResult> {
  const n = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT)
  const where = SCOPE_SQL[scope]
  const { results } = await db.prepare(`SELECT id, word, pos, meaning, example FROM vocab WHERE ${where} ORDER BY RANDOM() LIMIT ?`).bind(n).all<Card>()
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM vocab WHERE ${where}`).first<{ n: number }>())?.n ?? 0
  return { cards: results, total_due: total, backlog: 0, daily_cap: DAILY_CAP, done_today: 0 }
}

export type ReviewResult =
  | { ok: true; next: CardNext & { due_date: string; typed_streak: number }; remaining_due: number; forced_again: boolean }
  | { ok: false; reason: 'not_found' }

/**
 * Chấm một lần ôn: tính lịch ôn kế tiếp bằng SRS, cập nhật "đã thuộc", trả số thẻ còn phải ôn hôm nay (đã tính trần ngày).
 * - `typed` (chữ người học viết lại từ tiếng Anh): máy chủ tự so với từ; sai thì ép thành "Quên".
 * - "Đã thuộc" = viết đúng + chọn Tốt/Dễ liên tiếp STREAK_TO_LEARN lần, hoặc khoảng cách ôn ≥ 21 ngày. Khó giữ nguyên chuỗi; Quên đưa chuỗi về 0.
 * - `practice` = ôn tự do (thẻ có thể chưa đến hạn): chỉ "Quên" làm đổi thẻ (quay lại ôn hôm nay); Khó/Tốt/Dễ giữ nguyên
 *   để ôn sớm không đẩy lịch ôn ra xa một cách giả tạo.
 */
export async function reviewCard(db: D1Database, id: number, grade: Grade, today: string, practice = false, typed?: string): Promise<ReviewResult> {
  const card = await db
    .prepare('SELECT word, interval_days, ease, reps, learned, due_date, typed_streak FROM vocab WHERE id = ?')
    .bind(id)
    .first<{ word: string; interval_days: number; ease: number; reps: number; learned: 0 | 1; due_date: string; typed_streak: number }>()
  if (!card) return { ok: false, reason: 'not_found' }

  const typedOk = typed === undefined ? null : norm(typed) === norm(card.word)
  const forced_again = typedOk === false && grade !== 'again'
  const g: Grade = typedOk === false ? 'again' : grade
  const capped = async () => (await quotaFor(db, today)).shown

  if (practice && g !== 'again') {
    const due_in = Math.max(0, Math.round((Date.parse(card.due_date) - Date.parse(today)) / 86_400_000))
    return { ok: true, next: { interval_days: card.interval_days, ease: card.ease, reps: card.reps, learned: card.learned, due_in, due_date: card.due_date, typed_streak: card.typed_streak }, remaining_due: await capped(), forced_again }
  }

  const next = review(card, g)
  const due_date = addDays(today, next.due_in)
  const streak = g === 'again' ? 0 : g !== 'hard' && typedOk === true ? card.typed_streak + 1 : card.typed_streak
  const learned: 0 | 1 = streak >= STREAK_TO_LEARN || next.learned === 1 ? 1 : 0
  await db
    .prepare('UPDATE vocab SET interval_days = ?, ease = ?, reps = ?, learned = ?, due_date = ?, typed_streak = ?, lapses = lapses + ?, reviewed_on = ? WHERE id = ?')
    .bind(next.interval_days, next.ease, next.reps, learned, due_date, streak, g === 'again' ? 1 : 0, today, id)
    .run()
  return { ok: true, next: { ...next, learned, due_date, typed_streak: streak }, remaining_due: await capped(), forced_again }
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
  stats: { total: number; learned: number; due: number; quota: Quota }
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
    quota: await quotaFor(db, today),
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
