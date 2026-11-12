import { Hono, type Context } from 'hono'
import { checkPassword, endSession, isLoggedIn, requireAuth, startSession } from './auth'
import { todayVN } from './dates'
import type { Env } from './env'
import { handleError } from './errors'
import { buildWeeks, type SessionRow } from './plan-view'
import { listMessages, MAX_MESSAGE_CHARS, sendMessage } from './chat'
import { deleteUpload, listUploads, MAX_FILE_BYTES, saveFileUpload, saveLinkUpload } from './uploads'
import { chooseMaterial, composeSession, loadSession, publicLesson, sessionView, startLesson, submitQuiz } from './session-store'
import { reviewAndNotify } from './weekly-run'
import { runScheduled } from './cron'
import { buildProgress, listHistory } from './progress'
import { getSettings, updateSettings } from './settings'
import { parseSubscription, pushToAll, removeSubscription, saveSubscription } from './webpush'
import { missingSecrets } from './env'
import { modelInfo, saveModel } from './ai-model'
import { reviewQuestions, reviewStatus as vocabReviewStatus, submitReview } from './vocab-review'
import { exerciseQuestions, exerciseStatus, submitExercise } from './exercise-review'
import { dueCards, FILTERS, isGrade, listVocab, practiceCards, reviewCard, SCOPES, type PracticeScope, type VocabFilter } from './flashcards'
import { dispatchWeeklyReview } from './weekly'
import { approveAdjustment, decideAdjustment, getAdjustment, listAdjustments, toView, type AdjustmentStatus } from './adjustment-store'
import { extendPlan, planProgress, reviewStatus, savePlan, syncSchedule, type PlanRef } from './plan-store'
import { buildCustomPlan, generatePlan, generateReviewWeeks, isLevel, parseCustomPlan, WEEKS } from './planning'
import type { Level } from './placement-bank'
import { buildSchedule, TOTAL_SESSIONS } from './schedule'
import { compareLevels, type PlacementEntry } from './placement-progress'
import { gradeAnswers, publicQuestions, validAnswers } from './placement'

const app = new Hono<{ Bindings: Env }>()

app.onError(handleError)

// ---------- Đăng nhập ----------
app.post('/api/login', async (c) => {
  const body = await c.req.json<{ password?: unknown }>().catch(() => ({ password: '' }))
  if (!(await checkPassword(c.env, String(body.password ?? '')))) {
    return c.json({ error: 'wrong_password', message: 'Sai mật khẩu. Hãy thử lại.' }, 401)
  }
  await startSession(c)
  return c.json({ ok: true })
})

app.post('/api/logout', (c) => {
  endSession(c)
  return c.json({ ok: true })
})

app.get('/api/me', async (c) => c.json({ authed: await isLoggedIn(c) }))

// ---------- Từ đây trở xuống mọi API đều yêu cầu đăng nhập ----------
// (login / logout / me ở trên là các route công khai duy nhất; phải đăng ký TRƯỚC middleware này)
app.use('/api/*', requireAuth)

// ---------- Kiểm tra trình độ ----------
app.get('/api/placement/questions', (c) => c.json({ questions: publicQuestions() }))

app.post('/api/placement/grade', async (c) => {
  const body = await c.req.json<{ answers?: unknown }>().catch(() => ({ answers: undefined }))
  if (!validAnswers(body.answers)) {
    return c.json({ error: 'bad_request', message: 'Hãy trả lời đủ tất cả các câu hỏi.' }, 400)
  }
  const { score, total, level, perLevel } = gradeAnswers(body.answers)
  const taken_at = todayVN()
  await c.env.DB.prepare('INSERT INTO placement_results (score, total, level, taken_at, per_level_json) VALUES (?, ?, ?, ?, ?)')
    .bind(score, total, level, taken_at, JSON.stringify(perLevel))
    .run()
  return c.json({ score, total, level, taken_at })
})

/** So mức CEFR lần đầu với hiện tại + khi nào nên làm lại (sau 12 tuần). */
app.get('/api/placement/progress', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT level, taken_at FROM placement_results ORDER BY id').all<PlacementEntry>()
  return c.json({ progress: compareLevels(results, todayVN()) })
})

/** Lịch sử các lần làm bài, mới nhất trước. */
app.get('/api/placement/results', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, score, total, level, taken_at FROM placement_results ORDER BY id DESC').all()
  return c.json({ results })
})

// ---------- Lộ trình ----------
const activePlanRef = (db: D1Database) =>
  db.prepare("SELECT id, level, placement_id, checked_placement_id FROM plans WHERE status = 'active'").first<PlanRef>()

/** Tạo lộ trình 12 tuần / 60 buổi từ kết quả test gần nhất. Đang có lộ trình chạy thì cần `replace: true`. */
app.post('/api/plan', async (c) => {
  const db = c.env.DB
  const body = await c.req.json<{ replace?: unknown; level?: unknown; custom?: unknown }>().catch(() => ({}) as { replace?: unknown; level?: unknown; custom?: unknown })
  // mức bắt đầu: người học tự chọn, hoặc lấy từ bài kiểm tra mới nhất
  if (body.level !== undefined && !isLevel(body.level)) return c.json({ error: 'bad_level', message: 'Mức bắt đầu không hợp lệ (A0, A1, A2 hoặc B1).' }, 400)
  let custom: { topic: string; goal_vi: string }[] | null = null
  if (body.custom !== undefined && body.custom !== null && body.custom !== '') {
    if (typeof body.custom !== 'string') return c.json({ error: 'bad_custom', message: 'Lộ trình riêng phải là văn bản.' }, 400)
    const parsed = parseCustomPlan(body.custom)
    if (!parsed.ok) return c.json({ error: 'bad_custom', message: parsed.message }, 400)
    custom = parsed.weeks
  }
  const placement = await db
    .prepare('SELECT id, level FROM placement_results ORDER BY id DESC LIMIT 1')
    .first<{ id: number; level: Level }>()
  const startLevel: Level | null = (body.level as Level | undefined) ?? placement?.level ?? null
  if (!startLevel) return c.json({ error: 'no_placement', message: 'Hãy làm bài kiểm tra trình độ hoặc chọn mức bắt đầu.' }, 400)

  const active = await activePlanRef(db)
  if (active) {
    const { finished } = await planProgress(db, active.id)
    if (finished) {
      // Học xong lộ trình: phải test lại và ĐẠT (100% mọi mức từ A0 tới mức kế tiếp) mới được sang lộ trình mới.
      const review = await reviewStatus(db, active)
      if (review.state === 'need_retest') {
        return c.json({ error: 'retest_required', message: 'Bạn đã hoàn thành lộ trình. Hãy làm lại bài kiểm tra trình độ trước.' }, 409)
      }
      if (review.state === 'failed') {
        return c.json(
          { error: 'review_required', message: `Bài test lại chưa đạt (cần đúng 100% câu ở các mức ${review.required.join(', ')}). Hãy thêm tuần ôn tập.`, weak: review.weak },
          409,
        )
      }
    } else if (body.replace !== true) {
      return c.json({ error: 'plan_exists', message: 'Đang có lộ trình. Tạo lộ trình mới sẽ thay thế lộ trình hiện tại.' }, 409)
    }
  }

  const today = todayVN()
  const generated = custom ? await buildCustomPlan(c.env, startLevel, custom) : await generatePlan(c.env, startLevel)
  const saved = await savePlan(db, { level: startLevel, placementId: placement?.id ?? null, weeks: generated.weeks, startDate: today, today })
  return c.json({
    plan_id: saved.planId,
    level: startLevel,
    start_date: saved.startDate,
    end_date: saved.endDate,
    sessions: TOTAL_SESSIONS,
    source: generated.source,
    ...('filled_weeks' in generated ? { filled_weeks: generated.filled_weeks } : {}),
    ...(generated.fallback_reason ? { fallback_reason: generated.fallback_reason } : {}),
  })
})

/** Xem trước lộ trình riêng: app đọc văn bản/Markdown thành các tuần để người học kiểm tra trước khi tạo. Không ghi gì vào CSDL. */
app.post('/api/plan/preview', async (c) => {
  const body = await c.req.json<{ custom?: unknown }>().catch(() => ({}) as { custom?: unknown })
  if (typeof body.custom !== 'string') return c.json({ error: 'bad_custom', message: 'Lộ trình riêng phải là văn bản.' }, 400)
  const parsed = parseCustomPlan(body.custom)
  if (!parsed.ok) return c.json({ error: 'bad_custom', message: parsed.message }, 400)
  return c.json({ weeks: parsed.weeks, to_fill: WEEKS - parsed.weeks.length })
})

/**
 * Test lại chưa đạt → thêm 2 tuần ôn tập (mỗi tuần 5 buổi) vào cuối lộ trình hiện tại.
 * Chỉ khi lộ trình đã học xong và bài test lại mới nhất chưa đạt.
 */
app.post('/api/plan/extend', async (c) => {
  const db = c.env.DB
  const plan = await activePlanRef(db)
  if (!plan) return c.json({ error: 'no_plan', message: 'Chưa có lộ trình.' }, 400)
  if (!(await planProgress(db, plan.id)).finished) {
    return c.json({ error: 'not_finished', message: 'Hãy học xong các buổi hiện có trước.' }, 409)
  }
  const review = await reviewStatus(db, plan)
  if (review.state === 'need_retest') return c.json({ error: 'retest_required', message: 'Hãy làm lại bài kiểm tra trình độ trước.' }, 409)
  if (review.state === 'passed') return c.json({ error: 'already_passed', message: 'Bạn đã đạt, hãy tạo lộ trình mới.' }, 409)

  const lastWeek = (await db.prepare('SELECT MAX(week_no) AS w FROM plan_weeks WHERE plan_id = ?').bind(plan.id).first<{ w: number }>())?.w ?? 0
  const { results: hard } = await db.prepare('SELECT word FROM vocab WHERE wrong_count > 0 ORDER BY wrong_count DESC LIMIT 20').all<{ word: string }>()
  const generated = await generateReviewWeeks(c.env, {
    level: plan.level,
    weakLevels: review.weak,
    hardWords: hard.map((h) => h.word),
    startWeek: lastWeek + 1,
  })
  const today = todayVN()
  const saved = await extendPlan(db, { planId: plan.id, weeks: generated.weeks, start: today, checkedPlacementId: review.placementId! })
  return c.json({
    plan_id: plan.id,
    added_weeks: saved.weeks,
    added_sessions: saved.sessions,
    first_week: saved.firstWeek,
    end_date: saved.endDate,
    weak_levels: review.weak,
    source: generated.source,
    ...(generated.fallback_reason ? { fallback_reason: generated.fallback_reason } : {}),
  })
})

/** Lộ trình đang chạy: các tuần, chủ đề, các buổi và trạng thái từng buổi. */
app.get('/api/plan', async (c) => {
  const db = c.env.DB
  const plan = await db
    .prepare("SELECT id, level, start_date, placement_id, checked_placement_id FROM plans WHERE status = 'active'")
    .first<PlanRef & { start_date: string }>()
  if (!plan) {
    const placement = await db.prepare('SELECT level FROM placement_results ORDER BY id DESC LIMIT 1').first<{ level: Level }>()
    return c.json({ plan: null, has_placement: placement !== null, placement_level: placement?.level ?? null })
  }
  const today = todayVN()
  await syncSchedule(db, plan.id, today) // dời buổi bị lỡ trước khi đọc
  const [weeks, sessions] = await Promise.all([
    db.prepare('SELECT week_no, topic, goal_vi FROM plan_weeks WHERE plan_id = ? ORDER BY week_no').bind(plan.id).all<{ week_no: number; topic: string; goal_vi: string }>(),
    db
      .prepare('SELECT id, week_no, seq, scheduled_date, status, score FROM sessions WHERE plan_id = ? ORDER BY seq')
      .bind(plan.id)
      .all<SessionRow>(),
  ])
  const view = buildWeeks(weeks.results, sessions.results, today)
  const all = view.flatMap((w) => w.sessions)
  const next = all.find((s) => s.status !== 'done')
  const finished = all.length > 0 && !next
  return c.json({
    plan: {
      id: plan.id,
      level: plan.level,
      start_date: plan.start_date,
      end_date: all[all.length - 1]?.scheduled_date ?? plan.start_date,
      // ngày kết thúc theo lịch gốc (chưa dời) để so với end_date hiện tại
      original_end_date: buildSchedule(plan.start_date)[TOTAL_SESSIONS - 1].scheduled_date,
      done: all.filter((s) => s.status === 'done').length,
      total: all.length,
      current_week: next ? sessions.results.find((s) => s.id === next.id)!.week_no : null,
      // số tuần ôn tập đã thêm (ngoài 12 tuần gốc)
      pending_adjustments: (await listAdjustments(db, 'pending')).length,
      extension_weeks: Math.max(0, Math.max(0, ...view.map((w) => w.week_no)) - WEEKS),
      finished,
      // Khi finished: need_retest → cần làm lại test; passed → được tạo lộ trình mới; failed → cần thêm tuần ôn tập
      review: finished ? await reviewStatus(db, plan) : null,
      today,
    },
    weeks: view,
  })
})

// ---------- Điều chỉnh lộ trình cuối tuần ----------
const STATUSES: AdjustmentStatus[] = ['pending', 'approved', 'rejected', 'no_change']

/** Đề xuất của lộ trình đang chạy (mới nhất trước), kèm chủ đề hiện tại để so sánh. ?status= để lọc. */
app.get('/api/adjustments', async (c) => {
  const status = c.req.query('status') as AdjustmentStatus | undefined
  if (status && !STATUSES.includes(status)) return c.json({ error: 'bad_request', message: 'Trạng thái không hợp lệ.' }, 400)
  const list = await listAdjustments(c.env.DB, status)
  return c.json({ adjustments: await Promise.all(list.map((a) => toView(c.env.DB, a))) })
})

app.get('/api/adjustments/:id', async (c) => {
  const adj = await getAdjustment(c.env.DB, Number(c.req.param('id')))
  if (!adj) return c.json({ error: 'not_found', message: 'Không tìm thấy đề xuất.' }, 404)
  return c.json({ adjustment: await toView(c.env.DB, adj) })
})

const DECIDE_ERRORS = {
  not_found: [404, 'Không tìm thấy đề xuất.'],
  already_decided: [409, 'Đề xuất này đã được quyết định rồi.'],
  plan_inactive: [409, 'Lộ trình này không còn đang học.'],
} as const

/** Duyệt: áp dụng thay đổi chủ đề vào các tuần sau (tuần đã bắt đầu thì bỏ qua). */
app.post('/api/adjustments/:id/approve', async (c) => {
  const r = await approveAdjustment(c.env.DB, Number(c.req.param('id')))
  if (!r.ok) return c.json({ error: r.reason, message: DECIDE_ERRORS[r.reason][1] }, DECIDE_ERRORS[r.reason][0])
  return c.json({ adjustment: await toView(c.env.DB, r.adjustment), applied: r.applied, skipped: r.skipped })
})

/** Từ chối: giữ nguyên lộ trình cũ. */
app.post('/api/adjustments/:id/reject', async (c) => {
  const r = await decideAdjustment(c.env.DB, Number(c.req.param('id')), 'rejected')
  if (!r.ok) return c.json({ error: r.reason, message: DECIDE_ERRORS[r.reason][1] }, DECIDE_ERRORS[r.reason][0])
  return c.json({ adjustment: await toView(c.env.DB, r.adjustment) })
})

// ---------- Buổi học ----------
app.get('/api/sessions/:id', async (c) => {
  const s = await loadSession(c.env.DB, Number(c.req.param('id')))
  if (!s) return c.json({ error: 'not_found', message: 'Không tìm thấy buổi học.' }, 404)
  return c.json({ session: { ...sessionView(s), exercise: await exerciseStatus(c.env.DB, s), review: await vocabReviewStatus(c.env.DB, s) } })
})

const EXERCISE_ERRORS = {
  not_found: [404, 'Không tìm thấy buổi học.'],
  not_required: [409, 'Buổi này không cần làm lại bài tập của buổi trước.'],
  invalid: [400, 'Câu trả lời không hợp lệ.'],
} as const

/** Các câu còn sai trong bài tập buổi trước (buổi này bị chặn tới khi đạt 100%). Lựa chọn trắc nghiệm được xáo lại. */
app.get('/api/sessions/:id/exercise-review', async (c) => {
  const r = await exerciseQuestions(c.env.DB, Number(c.req.param('id')))
  if (!r.ok) return c.json({ error: r.reason, message: EXERCISE_ERRORS[r.reason][1] }, EXERCISE_ERRORS[r.reason][0])
  return c.json({ status: r.status, questions: r.questions })
})

/** Nộp một lượt làm lại: { answers: [{ index, choice }] }. Chấm ở máy chủ; câu sai ở lại lượt sau, hết câu sai thì mở khóa. */
app.post('/api/sessions/:id/exercise-review', async (c) => {
  const body = await c.req.json<{ answers?: unknown }>().catch(() => ({ answers: undefined }))
  const r = await submitExercise(c.env.DB, Number(c.req.param('id')), body.answers)
  if (!r.ok) return c.json({ error: r.reason, message: EXERCISE_ERRORS[r.reason][1] }, EXERCISE_ERRORS[r.reason][0])
  const { ok: _ok, ...rest } = r
  return c.json(rest)
})

const REVIEW_ERRORS = {
  not_found: [404, 'Không tìm thấy buổi học.'],
  not_required: [409, 'Buổi này không cần ôn từ vựng bài trước.'],
  passed: [409, 'Bạn đã ôn xong từ vựng bài trước.'],
  invalid: [400, 'Câu trả lời không hợp lệ.'],
} as const

/** Câu hỏi ôn từ vựng bài trước (chỉ các từ chưa đúng). Phải đạt 100% mới bắt đầu được buổi này. */
app.get('/api/sessions/:id/vocab-review', async (c) => {
  const r = await reviewQuestions(c.env.DB, Number(c.req.param('id')))
  if (!r.ok) return c.json({ error: r.reason, message: REVIEW_ERRORS[r.reason][1] }, REVIEW_ERRORS[r.reason][0])
  return c.json({ status: r.status, questions: r.questions, study: r.study })
})

/** Nộp một lượt ôn: { answers: [{ word, dir, choice }] }. Chấm ở máy chủ; từ sai ở lại lượt sau. */
app.post('/api/sessions/:id/vocab-review', async (c) => {
  const body = await c.req.json<{ answers?: unknown }>().catch(() => ({ answers: undefined }))
  const r = await submitReview(c.env.DB, Number(c.req.param('id')), body.answers)
  if (!r.ok) return c.json({ error: r.reason, message: REVIEW_ERRORS[r.reason][1] }, REVIEW_ERRORS[r.reason][0])
  const { ok: _ok, ...rest } = r
  return c.json(rest)
})

const START_ERRORS = {
  not_found: [404, 'Không tìm thấy buổi học.'],
  done: [409, 'Buổi học này đã xong.'],
  not_next: [409, 'Hãy học các buổi trước theo thứ tự.'],
  exercise_required: [409, 'Hãy làm lại các câu sai của bài tập buổi trước và đạt 100% để mở bài mới.'],
  review_required: [409, 'Hãy ôn từ vựng bài trước và đạt 100% để mở bài mới.'],
} as const

/** Bắt đầu buổi: AI tìm 2–3 tài liệu để người học chọn 1. Gọi lại trả đúng danh sách cũ. */
app.post('/api/sessions/:id/materials', async (c) => {
  const r = await startLesson(c.env, Number(c.req.param('id')))
  if (!r.ok) return c.json({ error: r.reason, message: START_ERRORS[r.reason][1] }, START_ERRORS[r.reason][0])
  return c.json({ material: r.material })
})

const CHOOSE_ERRORS = {
  not_found: [404, 'Không tìm thấy buổi học.'],
  done: [409, 'Buổi học này đã xong.'],
  no_material: [400, 'Hãy bắt đầu buổi học để AI tìm tài liệu trước.'],
  invalid_choice: [400, 'Lựa chọn không hợp lệ.'],
  locked: [409, 'Đã chọn tài liệu cho buổi này, không đổi được giữa buổi.'],
} as const

/** Chọn 1 trong các tài liệu AI đã tìm. Sau khi chọn là khóa. Body: { index } */
app.post('/api/sessions/:id/choose', async (c) => {
  const body = await c.req.json<{ index?: unknown }>().catch(() => ({ index: undefined }))
  const r = await chooseMaterial(c.env.DB, Number(c.req.param('id')), body.index)
  if (!r.ok) return c.json({ error: r.reason, message: CHOOSE_ERRORS[r.reason][1] }, CHOOSE_ERRORS[r.reason][0])
  return c.json({ material: r.material })
})

const COMPOSE_ERRORS = {
  not_found: [404, 'Không tìm thấy buổi học.'],
  done: [409, 'Buổi học này đã xong.'],
  no_material: [400, 'Hãy bắt đầu buổi học để AI tìm tài liệu trước.'],
  not_chosen: [400, 'Hãy chọn một tài liệu trước.'],
} as const

/** AI soạn bài từ tài liệu đã chọn (tối đa ~60 giây). Gọi lại trả đúng bài đã soạn. */
app.post('/api/sessions/:id/compose', async (c) => {
  const r = await composeSession(c.env, Number(c.req.param('id')))
  if (!r.ok) return c.json({ error: r.reason, message: COMPOSE_ERRORS[r.reason][1] }, COMPOSE_ERRORS[r.reason][0])
  return c.json({ lesson: publicLesson(r.lesson, false) }) // quiz chưa kèm đáp án
})

// ---------- Tài liệu người học tải lên ----------
const UPLOAD_ERRORS = {
  no_file: [400, 'Hãy chọn một file để tải lên.'],
  empty: [400, 'File rỗng.'],
  too_large: [413, `File quá lớn (tối đa ${MAX_FILE_BYTES / 1024 / 1024} MB).`],
  unsupported_type: [415, 'Chỉ nhận file PDF, TXT hoặc MD.'],
  type_mismatch: [415, 'Nội dung file không khớp với loại file (PDF hỏng, hoặc văn bản không phải UTF-8).'],
  duplicate: [409, 'Bạn đã tải tài liệu này lên rồi.'],
  bad_url: [400, 'Đường dẫn phải bắt đầu bằng http:// hoặc https://.'],
  unsafe_url: [400, 'Không dùng được đường dẫn này (phải là trang web công khai).'],
  unreachable: [422, 'Không mở được trang này. Hãy kiểm tra đường dẫn.'],
  http_error: [422, 'Trang này trả về lỗi, không mở được.'],
  not_html: [422, 'Đường dẫn này không phải trang web đọc được (có thể là PDF hoặc tệp khác — hãy tải file lên).'],
  soft_404: [422, 'Trang này không tồn tại hoặc yêu cầu đăng nhập.'],
  too_short: [422, 'Trang này gần như không có nội dung để học.'],
  no_transcript: [422, 'Trang này không dùng được.'],
  bad_youtube: [422, 'Trang này không dùng được.'],
} as const
type UploadReason = keyof typeof UPLOAD_ERRORS

const uploadError = (c: import('hono').Context, reason: UploadReason, existingId?: number) =>
  c.json({ error: reason, message: UPLOAD_ERRORS[reason][1], ...(existingId ? { existing_id: existingId } : {}) }, UPLOAD_ERRORS[reason][0])

/** Tải file lên (multipart/form-data: file, title?). Nhận PDF / TXT / MD, tối đa 10 MB. */
app.post('/api/uploads', async (c) => {
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > MAX_FILE_BYTES + 100_000) return uploadError(c, 'too_large') // từ chối sớm, trước khi đọc nội dung
  const form = await c.req.parseBody().catch(() => null)
  const file = form?.file
  if (!(file instanceof File)) return uploadError(c, 'no_file')
  if (file.size > MAX_FILE_BYTES) return uploadError(c, 'too_large')
  const title = typeof form?.title === 'string' ? form.title : undefined
  const r = await saveFileUpload(c.env, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), title }, todayVN())
  if (!r.ok) return uploadError(c, r.reason, r.existingId)
  return c.json({ upload: r.upload }, 201)
})

/** Đưa link: { url, title? }. Phải là trang web công khai đọc được. */
app.post('/api/uploads/link', async (c) => {
  const body = await c.req.json<{ url?: unknown; title?: unknown }>().catch(() => ({ url: undefined, title: undefined }))
  if (typeof body.url !== 'string') return uploadError(c, 'bad_url')
  const r = await saveLinkUpload(c.env, body.url, typeof body.title === 'string' ? body.title : undefined, todayVN())
  if (!r.ok) return uploadError(c, r.reason, r.existingId)
  return c.json({ upload: r.upload }, 201)
})

/** Danh sách tài liệu đã tải, kèm số buổi đã dùng. */
app.get('/api/uploads', async (c) => c.json(await listUploads(c.env.DB)))

/** Xóa tài liệu đã tải (file ở R2 cũng bị xóa). Bài đã soạn từ tài liệu này được giữ nguyên. */
app.delete('/api/uploads/:id', async (c) => {
  const r = await deleteUpload(c.env, Number(c.req.param('id')))
  if (!r.ok) return c.json({ error: 'not_found', message: 'Không tìm thấy tài liệu.' }, 404)
  return c.json({ ok: true, removed_from_sessions: r.removed_from_sessions, storage_cleaned: r.storage_cleaned })
})

// ---------- Chat luyện viết trong buổi học ----------
/** Lịch sử chat của buổi học (cũ → mới). */
app.get('/api/sessions/:id/chat', async (c) => {
  const id = Number(c.req.param('id'))
  if (!(await loadSession(c.env.DB, id))) return c.json({ error: 'not_found', message: 'Không tìm thấy buổi học.' }, 404)
  return c.json({ messages: await listMessages(c.env.DB, id) })
})

const CHAT_ERRORS = {
  not_found: [404, 'Không tìm thấy buổi học.'],
  done: [409, 'Buổi học này đã xong, không chat thêm được.'],
  no_lesson: [409, 'Hãy soạn bài trước khi luyện hội thoại.'],
  empty: [400, 'Hãy nhập tin nhắn.'],
  too_long: [400, `Tin nhắn quá dài (tối đa ${MAX_MESSAGE_CHARS} ký tự).`],
} as const

/** Gửi tin nhắn, AI trả lời theo chủ đề và trình độ. Body: { message } */
app.post('/api/sessions/:id/chat', async (c) => {
  const body = await c.req.json<{ message?: unknown }>().catch(() => ({ message: undefined }))
  const r = await sendMessage(c.env, Number(c.req.param('id')), body.message)
  if (!r.ok) return c.json({ error: r.reason, message: CHAT_ERRORS[r.reason][1] }, CHAT_ERRORS[r.reason][0])
  return c.json(r.value)
})

/**
 * Chạy một việc nền SAU khi đã trả lời người học (Cloudflare `waitUntil`): người học không phải chờ, lỗi chỉ ghi log.
 * Không có ExecutionContext (vd test) thì chờ xong tại chỗ để kết quả xác định.
 */
async function runInBackground(c: Context<{ Bindings: Env }>, job: Promise<unknown>): Promise<void> {
  const safe = job.then(
    () => undefined,
    (e) => console.error('background job failed', e),
  )
  try {
    c.executionCtx.waitUntil(safe)
  } catch {
    await safe
  }
}

const SUBMIT_ERRORS = {
  not_found: [404, 'Không tìm thấy buổi học.'],
  done: [409, 'Buổi học này đã nộp quiz rồi, không làm lại được.'],
  no_lesson: [409, 'Buổi học chưa có bài để làm quiz.'],
  invalid_answers: [400, 'Câu trả lời không hợp lệ. Hãy làm lại đủ các câu rồi nộp.'],
} as const

/** Nộp quiz cuối buổi: chấm tự động, trả kết quả + đáp án + giải thích, chốt buổi học. Body: { answers: (number|string|null)[] } */
app.post('/api/sessions/:id/quiz', async (c) => {
  const body = await c.req.json<{ answers?: unknown }>().catch(() => ({ answers: undefined }))
  const r = await submitQuiz(c.env.DB, Number(c.req.param('id')), body.answers, todayVN())
  if (!r.ok) return c.json({ error: r.reason, message: SUBMIT_ERRORS[r.reason][1] }, SUBMIT_ERRORS[r.reason][0])
  // Nếu buổi vừa nộp hoàn tất một tuần (thường là buổi thứ 5) → AI xem điểm quiz + từ hay sai và đề xuất điều chỉnh, chạy nền
  await runInBackground(
    c,
    dispatchWeeklyReview(c.env.DB, Number(c.req.param('id')), async (week) => {
      await reviewAndNotify(c.env, week)
    }),
  )
  return c.json({ result: r.result })
})

// ---------- Từ vựng & flashcard ----------
/** Thẻ đến hạn ôn (mặc định 10 thẻ ≈ 5 phút), cũ nhất trước. ?limit= (tối đa 50) */
app.get('/api/flashcards/due', async (c) => c.json(await dueCards(c.env.DB, todayVN(), Number(c.req.query('limit') ?? 0) || undefined)))

/** Ôn tự do: thẻ ngẫu nhiên BẤT KỲ (kể cả chưa đến hạn). ?scope=all|learning|learned, ?limit= */
app.get('/api/flashcards/practice', async (c) => {
  const scope = (c.req.query('scope') ?? 'all') as PracticeScope
  if (!SCOPES.includes(scope)) return c.json({ error: 'bad_request', message: 'Phạm vi ôn không hợp lệ.' }, 400)
  return c.json(await practiceCards(c.env.DB, scope, Number(c.req.query('limit') ?? 0) || undefined))
})

/**
 * Đánh giá một lần ôn: { grade: 'again' | 'hard' | 'good' | 'easy', practice?: boolean } → lịch ôn kế tiếp, "đã thuộc" khi khoảng cách ≥ 21 ngày.
 * practice = ôn tự do: chỉ "Quên" đổi lịch.
 */
app.post('/api/flashcards/:id/review', async (c) => {
  const body = await c.req.json<{ grade?: unknown; practice?: unknown; typed?: unknown }>().catch(() => ({ grade: undefined, practice: undefined, typed: undefined }))
  if (!isGrade(body.grade)) return c.json({ error: 'bad_request', message: 'Mức đánh giá không hợp lệ (Quên / Khó / Tốt / Dễ).' }, 400)
  const typed = typeof body.typed === 'string' ? body.typed.slice(0, 200) : undefined // chữ người học viết lại từ (nếu có): máy chủ tự so với từ, sai thì ép thành Quên
  const r = await reviewCard(c.env.DB, Number(c.req.param('id')), body.grade, todayVN(), body.practice === true, typed)
  if (!r.ok) return c.json({ error: 'not_found', message: 'Không tìm thấy từ vựng.' }, 404)
  return c.json({ next: r.next, remaining_due: r.remaining_due, forced_again: r.forced_again })
})

/** Kho từ vựng: ?q= tìm theo từ/nghĩa, ?filter=all|due|learned|learning, ?page= */
app.get('/api/vocab', async (c) => {
  const filter = (c.req.query('filter') ?? 'all') as VocabFilter
  if (!FILTERS.includes(filter)) return c.json({ error: 'bad_request', message: 'Bộ lọc không hợp lệ.' }, 400)
  return c.json(await listVocab(c.env.DB, todayVN(), { q: c.req.query('q') ?? '', filter, page: Number(c.req.query('page') ?? 1) }))
})

// ---------- Tiến độ + lịch sử ----------
/** Tiến độ tổng hợp: chuỗi ngày học, hoàn thành, từ vựng, điểm quiz theo thời gian, mức CEFR đầu → hiện tại. */
app.get('/api/progress', async (c) => c.json(await buildProgress(c.env.DB, todayVN())))

/** Lịch sử các buổi đã học, mới nhất trước. ?q= tìm theo chủ đề / tiêu đề / nguồn / từ vựng, ?page= */
app.get('/api/history', async (c) => c.json(await listHistory(c.env.DB, { q: c.req.query('q') ?? '', page: Number(c.req.query('page') ?? 1) })))

// ---------- Cài đặt thông báo ----------
async function notificationStatus(c: Context<{ Bindings: Env }>) {
  const subs = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>()
  return {
    push_configured: missingSecrets(c.env, 'push').length === 0,
    push_devices: subs?.n ?? 0,
    email_configured: missingSecrets(c.env, 'email').length === 0,
  }
}

/** Cài đặt nhắc học (giờ nhắc, bật/tắt) + trạng thái thông báo đẩy / email. */
app.get('/api/settings', async (c) => c.json({ settings: await getSettings(c.env.DB), notifications: await notificationStatus(c) }))

/** Đổi cài đặt: { reminder_enabled?: boolean, reminder_time?: "HH:MM" } */
app.put('/api/settings', async (c) => {
  const body = await c.req.json().catch(() => null)
  const r = await updateSettings(c.env.DB, body)
  if (!r.ok) {
    const msg = {
      reminder_enabled: 'Trạng thái nhắc học không hợp lệ.',
      reminder_time: 'Giờ nhắc không hợp lệ (dạng HH:MM, từ 00:00 đến 23:59).',
      empty: 'Không có cài đặt nào để lưu.',
    }[r.field]
    return c.json({ error: 'bad_request', field: r.field, message: msg }, 400)
  }
  return c.json({ settings: r.settings, notifications: await notificationStatus(c) })
})

// ---------- Chọn model AI ----------
app.get('/api/ai-model', async (c) => c.json(await modelInfo(c.env)))

/** Đổi model Gemini: { model: <id trong danh sách> } */
app.put('/api/ai-model', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { model?: unknown } | null
  if (!(await saveModel(c.env, body?.model))) return c.json({ error: 'bad_request', message: 'Model không hợp lệ.' }, 400)
  return c.json(await modelInfo(c.env))
})

// ---------- Thông báo đẩy trình duyệt ----------
/** Khóa công khai VAPID để trình duyệt đăng ký (không phải bí mật). */
app.get('/api/push/key', (c) => {
  if (missingSecrets(c.env, 'push').length) return c.json({ error: 'not_configured', message: 'Chưa cấu hình thông báo đẩy trên máy chủ.' }, 503)
  return c.json({ public_key: c.env.VAPID_PUBLIC_KEY })
})

/** Đăng ký thiết bị nhận nhắc học: { endpoint, keys: { p256dh, auth } } (kết quả của PushSubscription.toJSON()). */
app.post('/api/push/subscribe', async (c) => {
  const sub = parseSubscription(await c.req.json().catch(() => null))
  if (!sub) return c.json({ error: 'bad_request', message: 'Thông tin đăng ký thông báo không hợp lệ.' }, 400)
  await saveSubscription(c.env.DB, sub, todayVN())
  return c.json({ ok: true })
})

/** Hủy đăng ký một thiết bị: { endpoint } */
app.post('/api/push/unsubscribe', async (c) => {
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({ endpoint: undefined }))
  if (typeof body.endpoint !== 'string') return c.json({ error: 'bad_request', message: 'Thiếu thiết bị cần hủy.' }, 400)
  return c.json({ ok: true, removed: await removeSubscription(c.env.DB, body.endpoint) })
})

/** Gửi thử một thông báo tới mọi thiết bị đã đăng ký (để kiểm tra). */
app.post('/api/push/test', async (c) => {
  if (missingSecrets(c.env, 'push').length) return c.json({ error: 'not_configured', message: 'Chưa cấu hình thông báo đẩy trên máy chủ.' }, 503)
  return c.json(await pushToAll(c.env))
})

app.get('/api/health', async (c) => {
  const db = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
  return c.json({ ok: db?.ok === 1 })
})

app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'Không tìm thấy' }, 404))

// Cloudflare gọi `fetch` cho yêu cầu web và `scheduled` cho Cron Trigger (xem wrangler.toml)
export default Object.assign(app, {
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(env).then(() => undefined))
  },
})
