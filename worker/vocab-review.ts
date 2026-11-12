import { shuffle } from './quiz'

/**
 * Ôn từ vựng của bài đã học gần nhất trước khi mở buổi kế tiếp, qua 3 giai đoạn nối tiếp:
 *   1. Trắc nghiệm   — nhận ra nghĩa (Anh→Việt) và từ (Việt→Anh)
 *   2. Gõ từ         — nhìn nghĩa tiếng Việt, tự gõ từ tiếng Anh
 *   3. Điền vào câu  — gõ từ còn thiếu trong câu ví dụ (theo ngữ cảnh)
 * Mỗi giai đoạn phải đúng 100%: sai dù 1 từ thì làm lại giai đoạn đó TỪ ĐẦU (tất cả các từ).
 * Đúng 100% giai đoạn 3 mới được học tiếp. Chấm ở máy chủ; trạng thái lưu ở sessions.vocab_review_json.
 */

/** Phần của hàng buổi học mà module này cần (SessionInfo['row'] của session-store thỏa mãn). */
export interface SessionLite {
  id: number
  plan_id: number
  seq: number
  status: string
  material_json: string | null
}

async function loadLite(db: D1Database, id: number): Promise<{ row: SessionLite } | null> {
  const row = await db.prepare('SELECT id, plan_id, seq, status, material_json FROM sessions WHERE id = ?').bind(id).first<SessionLite>()
  return row ? { row } : null
}

export const STAGES = 3
export type Stage = 1 | 2 | 3
export type Kind = 'mcq' | 'type' | 'cloze'
export type Dir = 'en_vi' | 'vi_en'

interface Word {
  word: string
  meaning: string
  pos?: string
  example?: string
}

interface State {
  passed: boolean
  stage: Stage
  /** số lượt đã nộp (mọi giai đoạn) */
  round: number
}

export interface ReviewStatus {
  /** true = buổi này phải ôn bài trước mới bắt đầu được */
  required: boolean
  passed: boolean
  total: number
  stage: Stage
  stages: number
  round: number
}

export interface ReviewQuestion {
  word: string
  kind: Kind
  /** mcq: hướng hỏi (en_vi: hỏi nghĩa của từ Anh; vi_en: hỏi từ Anh của nghĩa Việt). Các kind khác: không dùng */
  dir?: Dir
  /** mcq en_vi: từ tiếng Anh; mcq vi_en và type: nghĩa tiếng Việt; cloze: câu có chỗ trống ____ */
  prompt: string
  options?: string[]
  /** cloze: nghĩa tiếng Việt của từ cần điền (gợi ý duy nhất, không có chữ cái của từ) */
  hint?: string
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Hướng hỏi của câu trắc nghiệm, do máy chủ quyết định theo vị trí từ và lượt (không tin phía client). */
const dirOf = (index: number, round: number): Dir => ((index + round) % 2 === 0 ? 'en_vi' : 'vi_en')

/** Câu ví dụ có chứa từ (cả dạng biến đổi như "orders") → câu có chỗ trống + các đáp án chấp nhận. Không có → null. */
function cloze(w: Word): { prompt: string; accept: string[] } | null {
  if (!w.example) return null
  const m = w.example.match(new RegExp(`\\b${escapeRe(w.word)}\\w*`, 'i'))
  if (!m) return null
  return { prompt: w.example.replace(m[0], '_____'), accept: [norm(w.word), norm(m[0])] }
}

/** Từ vựng của bài đã xong gần nhất trước buổi này (cùng lộ trình). Null nếu không có. */
async function sourceWords(db: D1Database, info: { row: SessionLite }): Promise<Word[] | null> {
  const prev = await db
    .prepare("SELECT lesson_json FROM sessions WHERE plan_id = ? AND seq < ? AND status = 'done' AND lesson_json IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .bind(info.row.plan_id, info.row.seq)
    .first<{ lesson_json: string }>()
  if (!prev) return null
  let vocab: { word?: unknown; pos?: unknown; meaning_vi?: unknown; example?: unknown }[] = []
  try {
    vocab = (JSON.parse(prev.lesson_json) as { vocab?: typeof vocab }).vocab ?? []
  } catch {
    return null
  }
  const seen = new Set<string>()
  const out: Word[] = []
  for (const v of vocab) {
    if (typeof v.word !== 'string' || typeof v.meaning_vi !== 'string' || !v.word.trim() || !v.meaning_vi.trim()) continue
    if (seen.has(norm(v.word))) continue
    seen.add(norm(v.word))
    out.push({ word: v.word.trim(), meaning: v.meaning_vi.trim(), ...(typeof v.pos === 'string' && v.pos.trim() ? { pos: v.pos.trim() } : {}), ...(typeof v.example === 'string' && v.example.trim() ? { example: v.example.trim() } : {}) })
  }
  return out.length ? out : null
}

/** Đọc trạng thái. Dạng cũ (chỉ có passed/remaining): đã đạt thì coi là đạt, chưa thì về giai đoạn 1. */
function parseState(json: string | null): State | null {
  if (!json) return null
  try {
    const s = JSON.parse(json) as { passed?: unknown; stage?: unknown; round?: unknown }
    const stage = s.stage === 2 || s.stage === 3 ? s.stage : 1
    return { passed: s.passed === true, stage: s.passed === true ? 3 : stage, round: typeof s.round === 'number' ? s.round : 0 }
  } catch {
    return null
  }
}

const rowState = async (db: D1Database, id: number) =>
  parseState((await db.prepare('SELECT vocab_review_json FROM sessions WHERE id = ?').bind(id).first<{ vocab_review_json: string | null }>())?.vocab_review_json ?? null)

export async function reviewStatus(db: D1Database, info: { row: SessionLite }): Promise<ReviewStatus> {
  const none: ReviewStatus = { required: false, passed: false, total: 0, stage: 1, stages: STAGES, round: 0 }
  // buổi đã bắt đầu (có tài liệu) hoặc đã xong: không chặn nữa
  if (info.row.status === 'done' || info.row.material_json) return none
  const words = await sourceWords(db, info)
  if (!words) return none
  const st = await rowState(db, info.row.id)
  return { required: true, passed: st?.passed === true, total: words.length, stage: st?.stage ?? 1, stages: STAGES, round: st?.round ?? 0 }
}

/** Buổi này đang bị chặn vì chưa ôn xong từ vựng bài trước? */
export async function reviewBlocks(db: D1Database, info: { row: SessionLite }): Promise<boolean> {
  const s = await reviewStatus(db, info)
  return s.required && !s.passed
}

async function distractorPool(db: D1Database, words: Word[], correct: Word, dir: Dir): Promise<string[]> {
  const pick = (w: Word) => (dir === 'en_vi' ? w.meaning : w.word)
  const answer = pick(correct)
  const pool = new Set(words.filter((w) => w !== correct).map(pick).filter((t) => norm(t) !== norm(answer)))
  if (pool.size < 3) {
    // bài ít từ: bổ sung từ kho từ vựng chung
    const { results } = await db.prepare('SELECT word, meaning FROM vocab ORDER BY RANDOM() LIMIT 20').all<{ word: string; meaning: string }>()
    for (const r of results) {
      const t = dir === 'en_vi' ? r.meaning : r.word
      if (t && norm(t) !== norm(answer) && norm(r.word) !== norm(correct.word)) pool.add(t)
    }
  }
  return shuffle([...pool]).slice(0, 3)
}

/** Thông tin đầy đủ của từ để xem lại (trước khi làm bài và sau mỗi lượt). */
export interface StudyWord {
  word: string
  meaning: string
  pos?: string
  example?: string
}

const toStudy = (w: Word): StudyWord => ({ word: w.word, meaning: w.meaning, ...(w.pos ? { pos: w.pos } : {}), ...(w.example ? { example: w.example } : {}) })

export type QuestionsResult =
  | { ok: true; status: ReviewStatus; questions: ReviewQuestion[]; study: StudyWord[] }
  | { ok: false; reason: 'not_found' | 'not_required' | 'passed' }

/** Câu hỏi của giai đoạn hiện tại: LUÔN đủ tất cả các từ của bài (sai thì làm lại từ đầu). */
export async function reviewQuestions(db: D1Database, sessionId: number): Promise<QuestionsResult> {
  const info = await loadLite(db, sessionId)
  if (!info) return { ok: false, reason: 'not_found' }
  const status = await reviewStatus(db, info)
  if (!status.required) return { ok: false, reason: 'not_required' }
  if (status.passed) return { ok: false, reason: 'passed' }
  const words = (await sourceWords(db, info))!

  const questions: ReviewQuestion[] = []
  for (const [i, w] of words.entries()) {
    if (status.stage === 1) {
      const dir = dirOf(i, status.round)
      const correct = dir === 'en_vi' ? w.meaning : w.word
      const options = shuffle([correct, ...(await distractorPool(db, words, w, dir))])
      questions.push({ word: w.word, kind: 'mcq', dir, prompt: dir === 'en_vi' ? w.word : w.meaning, options })
    } else if (status.stage === 2) {
      questions.push({ word: w.word, kind: 'type', prompt: w.meaning })
    } else {
      const c = cloze(w)
      // không có câu ví dụ chứa từ → hỏi dạng gõ từ (vẫn kiểm tra được từ đó)
      questions.push(c ? { word: w.word, kind: 'cloze', prompt: c.prompt, hint: w.meaning } : { word: w.word, kind: 'type', prompt: w.meaning })
    }
  }
  return { ok: true, status, questions: shuffle(questions), study: words.map(toStudy) }
}

export interface ReviewAnswer {
  word: string
  /** bỏ qua: hướng hỏi do máy chủ quyết định (giữ để tương thích) */
  dir?: Dir
  choice: string
}

export interface ReviewItemResult extends StudyWord {
  correct: boolean
}

export type SubmitReviewResult =
  | {
      ok: true
      /** đã qua cả 3 giai đoạn → mở được buổi học */
      passed: boolean
      /** giai đoạn vừa nộp */
      stage: Stage
      /** đúng 100% giai đoạn vừa nộp (còn giai đoạn sau nếu chưa passed) */
      cleared: boolean
      /** giai đoạn người học phải làm tiếp (sai → giữ nguyên, đúng hết → giai đoạn kế) */
      next_stage: Stage
      round: number
      results: ReviewItemResult[]
    }
  | { ok: false; reason: 'not_found' | 'not_required' | 'passed' | 'invalid' }

function validAnswers(a: unknown): a is ReviewAnswer[] {
  return (
    Array.isArray(a) &&
    a.length <= 100 &&
    a.every((x) => x && typeof x.word === 'string' && (x.dir === undefined || x.dir === 'en_vi' || x.dir === 'vi_en') && typeof x.choice === 'string' && x.choice.length <= 300)
  )
}

/** Chấm một lượt của giai đoạn hiện tại. Sai (hoặc bỏ trống) dù một từ → giữ nguyên giai đoạn, lượt sau làm lại từ đầu. */
export async function submitReview(db: D1Database, sessionId: number, answers: unknown): Promise<SubmitReviewResult> {
  const info = await loadLite(db, sessionId)
  if (!info) return { ok: false, reason: 'not_found' }
  const status = await reviewStatus(db, info)
  if (!status.required) return { ok: false, reason: 'not_required' }
  if (status.passed) return { ok: false, reason: 'passed' }
  if (!validAnswers(answers)) return { ok: false, reason: 'invalid' }

  const words = (await sourceWords(db, info))!
  const stage = status.stage
  const results: ReviewItemResult[] = words.map((w, i) => {
    const a = answers.find((x) => norm(x.word) === norm(w.word))
    let correct = false
    if (a) {
      const c = norm(a.choice)
      if (stage === 1) correct = c === norm(dirOf(i, status.round) === 'vi_en' ? w.word : w.meaning)
      else if (stage === 2) correct = c === norm(w.word)
      else correct = (cloze(w)?.accept ?? [norm(w.word)]).includes(c)
    }
    return { ...toStudy(w), correct }
  })
  const cleared = results.every((r) => r.correct)
  const passed = cleared && stage === STAGES
  const nextStage = (cleared && stage < STAGES ? stage + 1 : stage) as Stage
  const next: State = { passed, stage: nextStage, round: status.round + 1 }
  await db.prepare('UPDATE sessions SET vocab_review_json = ? WHERE id = ?').bind(JSON.stringify(next), sessionId).run()
  return { ok: true, passed, stage, cleared, next_stage: nextStage, round: next.round, results }
}
