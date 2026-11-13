import { shuffle } from './quiz'
import { todayVN } from './dates'
import { dueCards, reviewCard } from './flashcards'
import { choiceQuestion, recallStages, submitChoice } from './flashcard-choice'

/** Mixed review of up to ten recent/due words. Retry only misses, once; retain unresolved words in SRS. */

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

export const STAGES = 1
export type Stage = 1 | 2 | 3
export type Kind = 'mcq' | 'type' | 'cloze'
export type Dir = 'en_vi' | 'vi_en'

interface Word {
  id?: number
  recall_stage?: 'choice' | 'type'
  word: string
  meaning: string
  pos?: string
  example?: string
}

interface State {
  passed: boolean
  remaining?: string[]
  version?: number
  words?: Word[]
  stage: Stage

  round: number
}

export interface ReviewStatus {

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

  dir?: Dir

  prompt: string
  options?: string[]

  hint?: string
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function cloze(w: Word): { prompt: string; accept: string[] } | null {
  if (!w.example) return null
  const m = w.example.match(new RegExp(`\\b${escapeRe(w.word)}\\w*`, 'i'))
  if (!m) return null
  return { prompt: w.example.replace(m[0], '_____'), accept: [norm(w.word), norm(m[0])] }
}

async function sourceWords(db: D1Database, info: { row: SessionLite }): Promise<Word[] | null> {
  const saved = await rowState(db, info.row.id)
  if (saved?.words?.length) return saved.words
  const prev = await db.prepare("SELECT id FROM sessions WHERE plan_id = ? AND seq < ? AND status = 'done' LIMIT 1").bind(info.row.plan_id, info.row.seq).first()
  if (!prev) return null
  const due = await dueCards(db, todayVN(), 10)
  return due.cards.length ? (await recallStages(db,due.cards)).map(w => ({ id:w.id, word: w.word, meaning: w.meaning, recall_stage:w.recall_stage, ...(w.pos ? {pos:w.pos}:{}), ...(w.example ? {example:w.example}:{}) })) : null
}


function parseState(json: string | null): State | null {
  if (!json) return null
  try {
    const s = JSON.parse(json) as { passed?: unknown; stage?: unknown; round?: unknown; version?: number; remaining?: string[]; words?: Word[] }
    return { passed: s.passed === true, stage: 1, round: s.version === 2 && typeof s.round === 'number' ? s.round : 0, remaining: s.version === 2 && Array.isArray(s.remaining) ? s.remaining : undefined, words: s.version === 2 ? s.words : undefined, version: 2 }
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

export async function reviewQuestions(db: D1Database, sessionId: number): Promise<QuestionsResult> {
  const info = await loadLite(db, sessionId)
  if (!info) return { ok: false, reason: 'not_found' }
  const status = await reviewStatus(db, info)
  if (!status.required) return { ok: false, reason: 'not_required' }
  if (status.passed) return { ok: false, reason: 'passed' }
  const words = (await sourceWords(db, info))!

  const state = await rowState(db, sessionId)
  const selected = state?.remaining ? words.filter(w => state.remaining!.includes(norm(w.word))) : words
  const questions: ReviewQuestion[] = []
  for (const w of selected) {
    const i = (words.indexOf(w) + info.row.seq) % 3
    const c = cloze(w)
    if (status.round > 0 && w.recall_stage !== 'choice') {
      questions.push({ word: w.word, kind: 'type', prompt: w.meaning })
    } else if (w.recall_stage === 'choice' || (w.recall_stage === undefined && i === 0)) {
      const dir: Dir = 'vi_en'
      const choice = w.id ? await choiceQuestion(db,w.id) : null
      questions.push({ word: w.word, kind: 'mcq', dir, prompt: w.meaning, options: choice?.options ?? shuffle([w.word, ...(await distractorPool(db, words, w, dir))]) })
    } else if (i === 2 && c) {
      questions.push({ word: w.word, kind: 'cloze', prompt: c.prompt, hint: w.meaning })
    } else questions.push({ word: w.word, kind: 'type', prompt: w.meaning })
  }
  return { ok: true, status, questions: shuffle(questions), study: [] }
}

export interface ReviewAnswer {
  word: string

  dir?: Dir
  choice: string
}

export interface ReviewItemResult extends StudyWord {
  correct: boolean
}

export type SubmitReviewResult =
  | {
      ok: true

      passed: boolean

      stage: Stage

      cleared: boolean

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

export async function submitReview(db: D1Database, sessionId: number, answers: unknown, preview = false): Promise<SubmitReviewResult> {
  const info = await loadLite(db, sessionId)
  if (!info) return { ok: false, reason: 'not_found' }
  const status = await reviewStatus(db, info)
  if (!status.required) return { ok: false, reason: 'not_required' }
  if (status.passed) return { ok: false, reason: 'passed' }
  if (!validAnswers(answers)) return { ok: false, reason: 'invalid' }

  const words = (await sourceWords(db, info))!
  const stage = status.stage
  const state = await rowState(db, sessionId)
  const selected = state?.remaining ? words.filter(w => state.remaining!.includes(norm(w.word))) : words
  if ((preview && answers.length !== 1) || (!preview && (answers.length !== selected.length || new Set(answers.map(a => norm(a.word))).size !== selected.length)) || answers.some(a => !selected.some(w => norm(w.word) === norm(a.word)))) return { ok: false, reason: 'invalid' }
  const results: ReviewItemResult[] = selected.map((w) => {
    const i = (words.indexOf(w) + info.row.seq) % 3
    const a = answers.find((x) => norm(x.word) === norm(w.word))
    let correct = false
    if (a) {
      const c = norm(a.choice)
      correct = (status.round === 0 && w.recall_stage !== 'choice' && i === 2 ? (cloze(w)?.accept ?? [norm(w.word)]) : [norm(w.word)]).includes(c)
    }
    return { ...toStudy(w), correct }
  })
  const cleared = results.every((r) => r.correct)
  const passed = cleared || status.round >= 1
  const nextStage: Stage = 1
  if (preview) return { ok: true, passed: false, stage, cleared, next_stage: nextStage, round: status.round, results: results.filter(r => answers.some(a => norm(a.word) === norm(r.word))) }
  const remaining = results.filter(r => !r.correct).map(r => norm(r.word))
  const next: State = { passed, stage: nextStage, round: status.round + 1, remaining, version: 2, words }
  const today = todayVN()
  for (const result of results) {
    const card = await db.prepare("SELECT id FROM vocab WHERE lower(word) = lower(?) AND learning_state = 'active'").bind(result.word).first<{id:number}>()
    if (!card) continue
    const position = (words.findIndex(w => norm(w.word) === norm(result.word)) + info.row.seq) % 3
    const word = words.find(w => norm(w.word) === norm(result.word))!
    const isChoice = word.recall_stage === 'choice' || (word.recall_stage === undefined && status.round === 0 && position === 0)
    if (isChoice) {
      const answer = answers.find(a => norm(a.word) === norm(result.word))!
      await submitChoice(db,card.id,answer.choice,today)
    } else {
      await reviewCard(db, card.id, result.correct ? 'good' : 'again', today, false, result.correct ? result.word : '')
    }
  }
  await db.prepare('UPDATE sessions SET vocab_review_json = ? WHERE id = ?').bind(JSON.stringify(next), sessionId).run()

  return { ok: true, passed, stage, cleared, next_stage: nextStage, round: next.round, results }
}
