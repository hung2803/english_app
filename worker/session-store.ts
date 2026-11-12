import type { Env } from './env'
import { addDays, todayVN } from './dates'
import { composeLesson, type Lesson } from './lesson'
import { gradeQuiz, publicQuiz, validateAnswers, wrongWords, type PublicQuizItem, type QuizResult } from './quiz'
import { AiError } from './errors'
import { findMaterials, MAX_OPTIONS, MIN_OPTIONS, type MaterialOption, type MaterialSet } from './materials'
import { pickUploadOption, usageByUpload } from './upload-material'
import { exerciseBlocks } from './exercise-review'
import { reviewBlocks } from './vocab-review'

export interface SessionRow {
  id: number
  plan_id: number
  week_no: number
  seq: number
  scheduled_date: string
  status: 'pending' | 'done' | 'missed'
  material_json: string | null
  lesson_json: string | null
  result_json: string | null
  score: number | null
  completed_date: string | null
  /** NULL = không yêu cầu, 0 = quiz chưa đạt 100% (phải làm lại câu sai), 1 = đã đạt 100% */
  quiz_mastered: number | null
  /** điểm lần nộp đầu, có khi đã làm lại quiz tới 100% (khi đó `score` = 100) */
  first_score: number | null
}

export interface SessionInfo {
  row: SessionRow
  topic: string
  level: string
}

export async function loadSession(db: D1Database, id: number): Promise<SessionInfo | null> {
  const row = await db
    .prepare('SELECT id, plan_id, week_no, seq, scheduled_date, status, material_json, lesson_json, result_json, score, completed_date, quiz_mastered, first_score FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionRow>()
  if (!row) return null
  const w = await db.prepare('SELECT topic FROM plan_weeks WHERE plan_id = ? AND week_no = ?').bind(row.plan_id, row.week_no).first<{ topic: string }>()
  const p = await db.prepare('SELECT level FROM plans WHERE id = ?').bind(row.plan_id).first<{ level: string }>()
  return { row, topic: w?.topic ?? '', level: p?.level ?? '' }
}

/** Bài học gửi cho client: chưa nộp quiz thì KHÔNG kèm đáp án/giải thích/từ liên quan của quiz. */
export type PublicLesson = Omit<Lesson, 'quiz'> & { quiz: PublicQuizItem[] | Lesson['quiz'] }
export function publicLesson(l: Lesson, done: boolean): PublicLesson {
  return done ? l : { ...l, quiz: publicQuiz(l.quiz) }
}

/** Dạng gửi cho client. */
export function sessionView(s: SessionInfo) {
  const r = s.row
  return {
    id: r.id,
    seq: r.seq,
    week_no: r.week_no,
    topic: s.topic,
    scheduled_date: r.scheduled_date,
    status: r.status,
    score: r.score,
    completed_date: r.completed_date,
    quiz_mastered: r.quiz_mastered,
    first_score: r.first_score,
    material: r.material_json ? (JSON.parse(r.material_json) as MaterialSet) : null,
    lesson: r.lesson_json ? publicLesson(JSON.parse(r.lesson_json) as Lesson, r.status === 'done') : null,
    // kết quả quiz (đáp án + giải thích từng câu): chỉ có khi đã nộp
    result: r.result_json ? (JSON.parse(r.result_json) as QuizResult) : null,
  }
}

/** Buổi chưa xong đầu tiên của lộ trình (học tuần tự, không nhảy cóc). */
export async function nextSessionId(db: D1Database, planId: number): Promise<number | null> {
  const r = await db
    .prepare("SELECT id FROM sessions WHERE plan_id = ? AND status != 'done' ORDER BY seq LIMIT 1")
    .bind(planId)
    .first<{ id: number }>()
  return r?.id ?? null
}

/** Nguồn đã chọn ở các buổi khác của lộ trình, để không đưa lại. */
export async function usedUrls(db: D1Database, planId: number, exceptSessionId: number): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT material_json FROM sessions WHERE plan_id = ? AND id != ? AND material_json IS NOT NULL')
    .bind(planId, exceptSessionId)
    .all<{ material_json: string }>()
  const urls: string[] = []
  for (const r of results) {
    const m = JSON.parse(r.material_json) as MaterialSet
    if (m.chosen !== null && m.chosen >= 0 && m.options[m.chosen]?.url) urls.push(m.options[m.chosen].url)
  }
  return urls
}

export type StartResult =
  | { ok: true; material: MaterialSet; created: boolean }
  | { ok: false; reason: 'not_found' | 'done' | 'not_next' | 'exercise_required' | 'review_required' }

/**
 * Bắt đầu buổi học: AI tìm 2–3 tài liệu. Chỉ buổi chưa xong đầu tiên mới bắt đầu được.
 * Đã tìm rồi thì trả lại đúng danh sách cũ (không gọi AI lần nữa, không đổi lựa chọn giữa buổi).
 * Fallback (AI sẽ tự viết bài ở bước soạn bài) khi: tìm được ít hơn 2 lựa chọn dùng được, hoặc bước tìm kiếm lỗi
 * (quá thời gian, phản hồi hỏng…).
 * Sai khóa/model thì KHÔNG fallback (AI tự viết cũng sẽ bị từ chối): ném lỗi, không lưu gì. Hết hạn mức (429) của bước tìm kiếm thì vẫn fallback,
 * vì công cụ tìm kiếm Google có hạn mức riêng và có thể không có ở gói miễn phí; nếu API từ chối hẳn thì bước soạn bài báo lỗi để thử lại.
 */
export async function startLesson(env: Env, sessionId: number): Promise<StartResult> {
  const s = await loadSession(env.DB, sessionId)
  if (!s) return { ok: false, reason: 'not_found' }
  if (s.row.status === 'done') return { ok: false, reason: 'done' }
  if (s.row.material_json) return { ok: true, material: JSON.parse(s.row.material_json) as MaterialSet, created: false }
  if ((await nextSessionId(env.DB, s.row.plan_id)) !== s.row.id) return { ok: false, reason: 'not_next' }
  // phải làm lại bài tập buổi trước tới 100%, rồi ôn từ vựng bài trước (đúng 100%) mới mở bài mới
  if (await exerciseBlocks(env.DB, s)) return { ok: false, reason: 'exercise_required' }
  if (await reviewBlocks(env.DB, s)) return { ok: false, reason: 'review_required' }

  let options: MaterialOption[] = []
  let searchFailed = false
  try {
    options = await findMaterials(env, {
      level: s.level,
      topic: s.topic,
      seq: s.row.seq,
      excludeUrls: await usedUrls(env.DB, s.row.plan_id, s.row.id),
    })
  } catch (e) {
    // sai khóa/model: AI tự viết cũng sẽ bị từ chối → báo lỗi. Còn lại (hết hạn mức tìm kiếm Google — gói không có hạn mức này sẽ luôn 429, quá hạn, phản hồi hỏng…) → AI tự viết bài
    if (!(e instanceof AiError) || e.kind === 'config') throw e
    searchFailed = true
  }
  // tài liệu người học đã tải lên được đưa vào danh sách như MỘT lựa chọn (chiếm 1 trong tối đa 3 chỗ)
  const upload = await pickUploadOption(env.DB, s.row.plan_id, s.row.id)
  if (upload) options = [...options.slice(0, MAX_OPTIONS - 1), upload]
  const usable = upload ? options.length >= 1 : options.length >= MIN_OPTIONS // có tài liệu của người học thì không cần fallback
  const material: MaterialSet =
    usable
      ? { options, chosen: null, fallback: false }
      : { options: [], chosen: -1, fallback: true, fallback_reason: searchFailed ? 'search_error' : 'no_results' }

  // chỉ ghi nếu chưa ai ghi trước (hai yêu cầu đồng thời): bên thắng quyết định danh sách
  await env.DB.prepare('UPDATE sessions SET material_json = ? WHERE id = ? AND material_json IS NULL').bind(JSON.stringify(material), sessionId).run()
  const fresh = await loadSession(env.DB, sessionId)
  return { ok: true, material: JSON.parse(fresh!.row.material_json!) as MaterialSet, created: true }
}

export type ChooseResult =
  | { ok: true; material: MaterialSet; created: boolean }
  | { ok: false; reason: 'not_found' | 'done' | 'no_material' | 'invalid_choice' | 'locked' }

/**
 * Chọn 1 tài liệu trong danh sách AI đã tìm. Sau khi chọn là KHÓA: không đổi giữa buổi.
 * - Gửi lại đúng lựa chọn cũ (vd mạng chập chờn): thành công, không đổi gì.
 * - Gửi lựa chọn khác sau khi đã khóa, hoặc buổi đã dùng bài AI tự viết (fallback): 'locked'.
 * Việc khóa là một câu UPDATE có điều kiện (chosen còn NULL) nên hai yêu cầu đồng thời chỉ một bên thắng.
 */
export async function chooseMaterial(db: D1Database, sessionId: number, index: unknown): Promise<ChooseResult> {
  const s = await loadSession(db, sessionId)
  if (!s) return { ok: false, reason: 'not_found' }
  if (s.row.status === 'done') return { ok: false, reason: 'done' }
  if (!s.row.material_json) return { ok: false, reason: 'no_material' }
  const m = JSON.parse(s.row.material_json) as MaterialSet

  if (m.chosen !== null) {
    return m.chosen === index && m.chosen >= 0 ? { ok: true, material: m, created: false } : { ok: false, reason: 'locked' }
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= m.options.length) return { ok: false, reason: 'invalid_choice' }

  const res = await db
    .prepare("UPDATE sessions SET material_json = json_set(material_json, '$.chosen', ?) WHERE id = ? AND json_extract(material_json, '$.chosen') IS NULL")
    .bind(index, sessionId)
    .run()
  const fresh = JSON.parse((await loadSession(db, sessionId))!.row.material_json!) as MaterialSet
  if (((res.meta as { changes?: number }).changes ?? 0) === 1) return { ok: true, material: fresh, created: true }
  // thua cuộc đua: yêu cầu khác đã khóa trước
  return fresh.chosen === index ? { ok: true, material: fresh, created: false } : { ok: false, reason: 'locked' }
}

const NOTICE_NO_RESULTS = 'Không tìm được tài liệu phù hợp nên AI tự viết bài đọc.'
const NOTICE_SEARCH_ERROR = 'Bước tìm tài liệu gặp lỗi nên AI tự viết bài đọc.'

export type ComposeResult =
  | { ok: true; lesson: Lesson; created: boolean }
  | { ok: false; reason: 'not_found' | 'done' | 'no_material' | 'not_chosen' }

/**
 * Soạn bài cho buổi học từ tài liệu đã chọn (hoặc AI tự viết khi fallback). Gọi lại trả đúng bài đã soạn, không gọi AI nữa.
 * Lỗi AI được ném ra và KHÔNG lưu gì, để người học thử lại. Hai yêu cầu đồng thời: chỉ bài đầu tiên được lưu.
 */
export async function composeSession(env: Env, sessionId: number): Promise<ComposeResult> {
  const s = await loadSession(env.DB, sessionId)
  if (!s) return { ok: false, reason: 'not_found' }
  if (s.row.status === 'done') return { ok: false, reason: 'done' }
  if (s.row.lesson_json) return { ok: true, lesson: JSON.parse(s.row.lesson_json) as Lesson, created: false }
  if (!s.row.material_json) return { ok: false, reason: 'no_material' }
  const m = JSON.parse(s.row.material_json) as MaterialSet
  if (m.chosen === null) return { ok: false, reason: 'not_chosen' }

  const chosen = m.chosen >= 0 ? (m.options[m.chosen] ?? null) : null
  const prior = chosen?.type === 'upload' && chosen.upload_id ? (await usageByUpload(env.DB, s.row.plan_id, s.row.id)).get(chosen.upload_id) : undefined
  const lesson = await composeLesson(env, {
    level: s.level,
    topic: s.topic,
    chosen,
    upload: chosen?.type === 'upload' && chosen.upload_id ? { id: chosen.upload_id, partIndex: prior?.count ?? 0, usedTitles: prior?.titles ?? [] } : undefined,
    fallbackNotice: m.fallback_reason === 'search_error' ? NOTICE_SEARCH_ERROR : NOTICE_NO_RESULTS,
  })
  // Lưu bài VÀ nạp từ vựng của bài vào kho flashcard trong MỘT giao dịch:
  // - từ đã có trong kho (không phân biệt hoa thường) thì giữ nguyên, không trùng, không mất tiến độ ôn;
  // - từ mới hẹn ôn lần đầu vào NGÀY MAI (vừa học hôm nay); chỉ yêu cầu thắng cuộc đua mới nạp.
  const lessonJson = JSON.stringify(lesson)
  const today = todayVN()
  const firstReview = addDays(today, 1)
  const [saved] = await env.DB.batch([
    env.DB.prepare('UPDATE sessions SET lesson_json = ? WHERE id = ? AND lesson_json IS NULL').bind(lessonJson, sessionId),
    ...lesson.vocab.map((v) =>
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO vocab (word, pos, meaning, example, session_id, due_date, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT lesson_json FROM sessions WHERE id = ?) = ?`,
        )
        .bind(v.word, v.pos ?? null, v.meaning_vi, v.example ?? null, sessionId, firstReview, today, sessionId, lessonJson),
    ),
  ])
  const res = saved
  const fresh = await loadSession(env.DB, sessionId)
  return { ok: true, lesson: JSON.parse(fresh!.row.lesson_json!) as Lesson, created: ((res.meta as { changes?: number }).changes ?? 0) === 1 }
}

export type SubmitResult =
  | { ok: true; result: QuizResult }
  | { ok: false; reason: 'not_found' | 'done' | 'no_lesson' | 'invalid_answers' }

/**
 * Nộp quiz: chấm tự động Ở MÁY CHỦ rồi chốt buổi học. Chỉ nộp được MỘT lần (đáp án được hé lộ ngay sau đó nên không cho làm lại).
 * Điểm dưới 70% là "chưa đạt" nhưng buổi vẫn tính là xong.
 * Lưu kết quả + điểm + ngày xong + trạng thái 'done' trong một câu UPDATE có điều kiện (hai lần nộp đồng thời chỉ một bên thắng).
 */
export async function submitQuiz(db: D1Database, sessionId: number, answers: unknown, today: string): Promise<SubmitResult> {
  const s = await loadSession(db, sessionId)
  if (!s) return { ok: false, reason: 'not_found' }
  if (s.row.status === 'done') return { ok: false, reason: 'done' }
  if (!s.row.lesson_json) return { ok: false, reason: 'no_lesson' }
  const lesson = JSON.parse(s.row.lesson_json) as Lesson
  if (!validateAnswers(lesson.quiz, answers)) return { ok: false, reason: 'invalid_answers' }

  const result = gradeQuiz(lesson.quiz, answers)
  // câu sai (hoặc bỏ trống) → từ vựng liên quan vào hàng ôn NGAY
  const wrong = wrongWords(result)
  result.review_words = wrong
  const resultJson = JSON.stringify(result)
  // chỉ chạy các lệnh từ vựng nếu CHÍNH yêu cầu này chốt được buổi học (kết quả đã lưu trùng khớp với kết quả vừa chấm)
  const mine = '(SELECT result_json FROM sessions WHERE id = ?) = ?'
  const vocabStmts = wrong.flatMap((w) => {
    const v = lesson.vocab.find((x) => x.word.toLowerCase() === w.toLowerCase())
    if (!v) return []
    return [
      // chưa có trong kho thì thêm (từ vựng của bài chưa được nạp tự động)
      db
        .prepare(
          `INSERT OR IGNORE INTO vocab (word, pos, meaning, example, session_id, due_date, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${mine}`,
        )
        .bind(v.word, v.pos ?? null, v.meaning_vi, v.example ?? null, sessionId, today, today, sessionId, resultJson),
      // đã có thì đặt lại như bấm "Quên": đến hạn hôm nay, học lại từ đầu, giảm độ dễ, ghi nhận một lần sai
      db
        .prepare(
          `UPDATE vocab SET due_date = ?, interval_days = 0, reps = 0, learned = 0, typed_streak = 0, ease = MAX(1.3, ease - 0.2), wrong_count = wrong_count + 1
           WHERE lower(word) = lower(?) AND ${mine}`,
        )
        .bind(today, v.word, sessionId, resultJson),
    ]
  })
  const [first] = await db.batch([
    db
      // quiz_mastered: 1 nếu đúng hết, 0 nếu còn câu sai (phải làm lại các câu sai trước khi mở buổi kế tiếp)
      .prepare("UPDATE sessions SET status = 'done', score = ?, result_json = ?, completed_date = ?, quiz_mastered = ? WHERE id = ? AND status != 'done'")
      .bind(result.score, resultJson, today, result.score === 100 ? 1 : 0, sessionId),
    ...vocabStmts,
  ])
  if (((first.meta as { changes?: number }).changes ?? 0) !== 1) return { ok: false, reason: 'done' } // bị nộp trước bởi yêu cầu khác
  return { ok: true, result }
}
