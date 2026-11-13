import { addDays } from './dates'
import { sameRecall } from '../shared/recall-answer'
import { vocabMastery, MASTERY_LEVELS, type MasteryLevel } from '../shared/vocab-mastery'
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
export const DAILY_CAP = 15
export const NEW_DAILY_CAP = 5
/** Tự nhớ đúng ít nhất 3 ngày khác nhau, qua ít nhất một tuần, mới ghi nhận đã thuộc. */
export const STREAK_TO_LEARN = 3

export const isGrade = (g: unknown): g is Grade => typeof g === 'string' && (GRADES as string[]).includes(g)

/** So khớp từ người học viết: bỏ khoảng trắng thừa, không phân biệt hoa/thường. */
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** Số thẻ đến hạn ôn (hạn ôn ≤ hôm nay), chưa tính trần ngày. */
export async function countDue(db: D1Database, today: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM vocab WHERE learning_state = 'active' AND due_date <= ?").bind(today).first<{ n: number }>())?.n ?? 0
}

export interface Quota {
  cap: number
  /** Số từ khác nhau đã ôn hôm nay; ôn lại từ sai không chiếm thêm suất. */
  done: number
  /** số thẻ đến hạn thật sự */
  due: number
  /** số thẻ được ôn hôm nay trong trần (≤ due) */
  shown: number
  /** số thẻ đến hạn phải chờ sang ngày sau vì vượt trần */
  backlog: number
}

/** Hạn mức 15 từ khác nhau, cho phép thử lại những từ đã ôn trong ngày. */
export async function quotaFor(db: D1Database, today: string): Promise<Quota> {
  const done = (await db.prepare('SELECT COUNT(*) AS n FROM vocab WHERE reviewed_on = ?').bind(today).first<{ n: number }>())?.n ?? 0
  const due = await countDue(db, today)
  const retry = (await db.prepare("SELECT COUNT(*) AS n FROM vocab WHERE learning_state = 'active' AND reviewed_on = ? AND due_date <= ?").bind(today, today).first<{ n: number }>())?.n ?? 0
  const shown = retry + Math.min(due - retry, Math.max(0, DAILY_CAP - done))
  return { cap: DAILY_CAP, done, due, shown, backlog: due - shown }
}

/** Admit queued words in selection order, after reserving room for existing due cards. */
export async function activateQueued(db: D1Database, today: string): Promise<void> {
  await db.prepare(`UPDATE vocab SET learning_state = 'active', activated_on = ?, due_date = ? WHERE id IN (
    SELECT id FROM vocab WHERE learning_state = 'queued' ORDER BY selected_at, id
    LIMIT MAX(0, MIN(
      ? - (SELECT COUNT(*) FROM vocab WHERE activated_on = ?),
      ? - (SELECT COUNT(*) FROM vocab WHERE reviewed_on = ?)
        - (SELECT COUNT(*) FROM vocab WHERE learning_state = 'active' AND due_date <= ? AND (reviewed_on IS NULL OR reviewed_on != ?))
    )))`).bind(today, today, NEW_DAILY_CAP, today, DAILY_CAP, today, today, today).run()
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
  await activateQueued(db, today)
  const q = await quotaFor(db, today)
  const n = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT, q.shown)
  const cards = n
    ? (
        await db
          .prepare(
            `SELECT id, word, pos, meaning, example FROM vocab WHERE learning_state = 'active' AND due_date <= ?
             ORDER BY (reviewed_on = ?) DESC, (wrong_count + lapses) DESC, due_date, id LIMIT ?`,
          )
          .bind(today, today, n)
          .all<Card>()
      ).results
    : []
  return { cards, total_due: q.shown, backlog: q.backlog, daily_cap: q.cap, done_today: q.done }
}

/** Phạm vi ôn tự do: mọi từ, từ đang học (chưa thuộc), hoặc từ đã thuộc. */
export type PracticeScope = 'all' | 'learning' | 'learned' | 'wrong'
export const SCOPES: PracticeScope[] = ['all', 'learning', 'learned', 'wrong']
const SCOPE_SQL: Record<PracticeScope, string> = { wrong: '(wrong_count + lapses) > 0', all: '1 = 1', learning: 'learned = 0', learned: 'learned = 1' }

/**
 * Ôn tự do: lấy ngẫu nhiên các thẻ BẤT KỲ (kể cả chưa đến hạn) trong phạm vi chọn, tối đa `limit`. Không tính vào trần ngày.
 * `total_due` ở đây là tổng số thẻ trong phạm vi (giữ chung dạng dữ liệu với dueCards để dùng lại giao diện thẻ).
 */
export async function practiceCards(db: D1Database, scope: PracticeScope, limit = DEFAULT_LIMIT): Promise<DueResult> {
  const n = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT)
  const where = `learning_state = 'active' AND (${SCOPE_SQL[scope]})`
  const { results } = await db.prepare(`SELECT id, word, pos, meaning, example FROM vocab WHERE ${where} ORDER BY RANDOM() LIMIT ?`).bind(n).all<Card>()
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM vocab WHERE ${where}`).first<{ n: number }>())?.n ?? 0
  return { cards: results, total_due: total, backlog: 0, daily_cap: DAILY_CAP, done_today: 0 }
}

export type ReviewResult =
  | { ok: true; next: CardNext & { due_date: string; typed_streak: number }; remaining_due: number; forced_again: boolean }
  | { ok: false; reason: 'not_found' | 'not_active' | 'daily_limit' }

/**
 * Chấm một lần ôn: tính lịch ôn kế tiếp bằng SRS, cập nhật "đã thuộc", trả số thẻ còn phải ôn hôm nay (đã tính trần ngày).
 * - `typed` (chữ người học viết lại từ tiếng Anh): máy chủ tự so với từ; sai thì ép thành "Quên".
 * - "Đã thuộc" = viết đúng + Tốt/Dễ qua ít nhất 3 ngày khác nhau và 7 ngày kiểm chứng. Khó giữ nguyên; Quên đặt lại.
 * - `practice` = ôn tự do (thẻ có thể chưa đến hạn): chỉ "Quên" làm đổi thẻ (quay lại ôn hôm nay); Khó/Tốt/Dễ giữ nguyên
 *   để ôn sớm không đẩy lịch ôn ra xa một cách giả tạo.
 */
export async function reviewCard(db: D1Database, id: number, grade: Grade, today: string, practice = false, typed?: string, assisted = false): Promise<ReviewResult> {
  const card = await db
    .prepare('SELECT word, interval_days, ease, reps, learned, due_date, typed_streak, learning_state, reviewed_on, mastery_started_on, last_success_on FROM vocab WHERE id = ?')
    .bind(id)
    .first<{ word: string; interval_days: number; ease: number; reps: number; learned: 0 | 1; due_date: string; typed_streak: number; learning_state: string; reviewed_on: string | null; mastery_started_on: string | null; last_success_on: string | null }>()
  if (!card) return { ok: false, reason: 'not_found' }
  if (card.learning_state !== 'active') return { ok: false, reason: 'not_active' }
  if (!practice && card.reviewed_on !== today && (await quotaFor(db, today)).done >= DAILY_CAP) return { ok: false, reason: 'daily_limit' }

  const typedOk = typed === undefined ? null : sameRecall(typed, card.word)
  const forced_again = typedOk === false && grade !== 'again'
  const g: Grade = typedOk === false || grade === 'again' ? 'again' : assisted ? 'hard' : grade
  const capped = async () => (await quotaFor(db, today)).shown

  if ((practice || card.last_success_on === today) && g !== 'again') {
    const due_in = Math.max(0, Math.round((Date.parse(card.due_date) - Date.parse(today)) / 86_400_000))
    return { ok: true, next: { interval_days: card.interval_days, ease: card.ease, reps: card.reps, learned: card.learned, due_in, due_date: card.due_date, typed_streak: card.typed_streak }, remaining_due: await capped(), forced_again }
  }

  const next = review(card, g)
  const due_date = addDays(today, next.due_in)
  const success = !assisted && g !== 'again' && g !== 'hard' && typedOk === true
  const streak = g === 'again' ? 0 : success ? card.typed_streak + 1 : card.typed_streak
  const started = g === 'again' ? null : success ? (card.mastery_started_on ?? today) : card.mastery_started_on
  const lastSuccess = g === 'again' ? null : success ? today : card.last_success_on
  const span = started ? (Date.parse(today) - Date.parse(started)) / 86_400_000 : 0
  const learned: 0 | 1 = g === 'again' ? 0 : card.learned === 1 || (streak >= STREAK_TO_LEARN && span >= 7) ? 1 : 0
  const saved = await db
    .prepare(`UPDATE vocab SET interval_days = ?, ease = ?, reps = ?, learned = ?, due_date = ?, typed_streak = ?, lapses = lapses + ?, reviewed_on = ?, mastery_started_on = ?, last_success_on = ?
      , recognized_on = CASE WHEN ? = 1 THEN NULL ELSE recognized_on END
      WHERE id = ? AND (reviewed_on = ? OR (SELECT COUNT(*) FROM vocab WHERE reviewed_on = ?) < ? OR ? = 1)`)
    .bind(next.interval_days, next.ease, next.reps, learned, due_date, streak, g === 'again' ? 1 : 0, today, started, lastSuccess, g === 'again' ? 1 : 0, id, today, today, DAILY_CAP, practice ? 1 : 0)
    .run()
  if (!saved.meta.changes) return { ok: false, reason: 'daily_limit' }
  return { ok: true, next: { ...next, learned, due_date, typed_streak: streak }, remaining_due: await capped(), forced_again }
}
// ---------- Kho từ vựng ----------

export interface VocabItem extends Card {
  recognized_on: string | null
  lapses: number
  learning_state: 'available' | 'queued' | 'active'
  typed_streak: number
  mastery_started_on: string | null
  due_date: string
  interval_days: number
  reps: number
  learned: 0 | 1
  wrong_count: number
  session_id: number | null
  created_at: string
}

export type VocabFilter = 'all' | 'due' | 'learned' | 'learning' | 'queued'
export const FILTERS: VocabFilter[] = ['all', 'due', 'learned', 'learning', 'queued']

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
  stats: { total: number; learned: number; due: number; queued: number; quota: Quota }
}

export const PAGE_SIZE = 50

/**
 * Kho từ vựng: tìm theo từ hoặc nghĩa (không phân biệt hoa thường và dấu), lọc theo trạng thái, phân trang.
 * - all: tất cả; due: đến hạn ôn; learned: đã thuộc; learning: đang học (chưa thuộc).
 */
export async function listVocab(db: D1Database, today: string, opts: { q?: string; filter?: VocabFilter; page?: number; level?: MasteryLevel; order?: 'priority' } = {}): Promise<VocabPage> {
  await activateQueued(db, today)
  const { results } = await db
    .prepare("SELECT id, word, pos, meaning, example, due_date, interval_days, reps, learned, wrong_count, lapses, session_id, created_at, learning_state, typed_streak, mastery_started_on, recognized_on FROM vocab WHERE learning_state != 'available' ORDER BY CASE WHEN learning_state = 'queued' THEN 0 ELSE 1 END, CASE WHEN learning_state = 'queued' THEN selected_at END, CASE WHEN learning_state = 'queued' THEN id END, id DESC")
    .all<VocabItem>()
  const stats = {
    total: results.length,
    queued: results.filter(v => v.learning_state === 'queued').length,
    learned: results.filter((v) => v.learned === 1).length,
    due: results.filter((v) => v.learning_state === 'active' && v.due_date <= today).length,
    quota: await quotaFor(db, today),
  }
  const q = fold(opts.q ?? '')
  const filter = opts.filter && FILTERS.includes(opts.filter) ? opts.filter : 'all'
  const matches = results.filter((v) => {
    if (opts.level && vocabMastery(v, today).level !== opts.level) return false
    if (filter === 'queued' && v.learning_state !== 'queued') return false
    if (filter === 'due' && (v.learning_state !== 'active' || v.due_date > today)) return false
    if (filter === 'learned' && v.learned !== 1) return false
    if (filter === 'learning' && (v.learned === 1 || v.learning_state !== 'active')) return false
    return !q || fold(v.word).includes(q) || fold(v.meaning).includes(q)
  })
  if (opts.order === 'priority') {
    matches.sort((a, b) => {
      const aDue = a.learning_state === 'active' && a.due_date <= today
      const bDue = b.learning_state === 'active' && b.due_date <= today
      if (aDue !== bDue) return aDue ? -1 : 1
      const rank = MASTERY_LEVELS.indexOf(vocabMastery(a, today).level) - MASTERY_LEVELS.indexOf(vocabMastery(b, today).level)
      if (rank) return rank
      return aDue && bDue ? a.due_date.localeCompare(b.due_date) : 0
    })
  }
  const page = Math.max(1, Math.floor(opts.page ?? 1) || 1)
  return { items: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), matched: matches.length, page, page_size: PAGE_SIZE, stats }
}
