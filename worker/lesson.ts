import type { Env } from './env'
import { blobStore } from './blob-store'
import { AiError } from './errors'
import { geminiJson, type Part } from './gemini'
import { isSafeUrl, readLimited, visibleText, youtubeId } from './link-check'
import type { MaterialOption } from './materials'
import { groundQuiz, MIN_READING_WORDS, readingWords } from './lesson-grounding'
import { MIN_QUIZ, normalizeQuiz, QUIZ_SIZE, type QuizItem } from './quiz'
import { clipWords } from './text'
import { splitSegments, toBase64 } from './upload-material'

export interface VocabItem {
  word: string
  pos?: string
  meaning_vi: string
  example?: string
}

export interface GrammarItem {
  point: string
  explanation_vi: string
  example?: string
}

export interface LessonSource {
  type: 'article' | 'youtube' | 'podcast' | 'upload' | 'ai'
  url?: string
  /** có khi type = 'upload' */
  upload_id?: number
  title: string
  /** true = bài đọc do AI tự viết (hiển thị rõ cho người học) */
  ai_written: boolean
}

export interface Lesson {
  title: string
  source: LessonSource
  /** đoạn trích ngắn từ nguồn (hoặc toàn bộ bài đọc nếu do AI viết) */
  excerpt: string
  /** bài đọc đầy đủ do AI viết lại bằng lời của mình (bài từ nguồn thật); bài AI tự viết thì nằm ở `excerpt` */
  reading?: string
  /** mục tiêu buổi học, tiếng Việt */
  goals_vi?: string[]
  /** bài tập viết/nói ngắn, làm trong khung chat để được sửa lỗi */
  task?: { en: string; vi: string }
  summary_vi: string
  explanation_vi: string
  vocab: VocabItem[]
  grammar: GrammarItem[]
  /** quiz cuối buổi (có đáp án, chỉ lưu phía máy chủ; gửi cho người học qua `publicLesson`) */
  quiz: QuizItem[]
  /** lý do chuyển sang bài AI tự viết (nếu có), tiếng Việt */
  notice_vi?: string
}

/** Lỗi do NỘI DUNG AI soạn chưa đạt (thiếu phần, quiz không bám bài…): thử lại có thể ổn, nên composeLesson tự thử lại một lần. */
export class LessonQualityError extends AiError {
  constructor(message: string) {
    super('other', message)
    this.name = 'LessonQualityError'
  }
}

export interface ComposeContext {
  level: string
  topic: string
  /** tài liệu đã chọn; null = không có (fallback) → AI tự viết bài */
  chosen: MaterialOption | null
  /** lời giải thích cho người học khi chuyển sang bài AI tự viết vì không có tài liệu */
  fallbackNotice?: string
  /** khi tài liệu đã chọn là tài liệu người học tải lên */
  upload?: UploadCtx
}

export interface UploadCtx {
  id: number
  /** đã học bao nhiêu buổi từ tài liệu này → với văn bản dài, lấy phần kế tiếp */
  partIndex: number
  /** tiêu đề các bài trước từ tài liệu này, để AI không lặp lại */
  usedTitles: string[]
}

/** Thời gian chờ tối đa để soạn một buổi học. */
export const COMPOSE_BUDGET_MS = 55_000
const PAGE_TIMEOUT_MS = 8_000
const MAX_SOURCE_CHARS = 7_000
const MIN_SOURCE_CHARS = 300
export const LESSON_EXCERPT_WORDS = 80
const MAX_EXCERPT = 600 // đoạn trích từ nguồn: ngắn, không chép lại nội dung gốc
const MAX_AI_TEXT = 3_000 // bài đọc do AI tự viết (nội dung của chính AI)
const MIN_VOCAB = 4 // dung sai: prompt yêu cầu 10-12, nhưng vẫn nhận bài có ít nhất 4 từ
const MAX_VOCAB = 12
const MAX_GRAMMAR = 3

const UA = 'Mozilla/5.0 (compatible; EnglishCoach/1.0)'

const SHAPE = `{
  "title": "lesson title in English, max 10 words",
  "excerpt": "ONE short quote (max 80 words) copied from the source that the lesson is based on",
  "reading": "an ORIGINAL English reading text of 250-350 words at the learner's level, written in your own words about the same content (omit when you wrote the whole reading text in excerpt)",
  "goals_vi": ["2-3 mục tiêu của buổi học, mỗi mục một câu ngắn tiếng Việt, bắt đầu bằng động từ"],
  "task": {"en": "ONE short speaking/writing task in English (2-3 sentences of output), using this lesson's vocabulary", "vi": "đề bài bằng tiếng Việt"},
  "summary_vi": "tóm tắt nội dung bằng tiếng Việt, 2-4 câu",
  "explanation_vi": "giải thích bằng tiếng Việt: ý chính, bối cảnh, mẹo hiểu bài, 5-8 câu",
  "vocab": [{"word":"","pos":"noun|verb|adj|adv|phrase","meaning_vi":"nghĩa tiếng Việt","example":"an English example sentence"}],
  "grammar": [{"point":"grammar point name","explanation_vi":"giải thích ngắn bằng tiếng Việt","example":"an English example sentence"}],
  "quiz": [
    {"type":"mcq","question":"...?","options":["A","B","C","D"],"answer":0,"explanation_vi":"vì sao đáp án đúng, bằng tiếng Việt","word":"a vocab word of this lesson"},
    {"type":"fill","question":"A sentence with exactly one ___ blank.","answer":"one to three words","explanation_vi":"giải thích bằng tiếng Việt","word":"a vocab word of this lesson"}
  ]
}`

/** Mẫu JSON khi AI TỰ VIẾT bài: `excerpt` là TOÀN BỘ bài đọc (không phải trích 80 từ) và không có `reading`. */
const SHAPE_AI = SHAPE.replace(/ {2}"excerpt": "[^\n]*\n/, '  "excerpt": "the FULL reading text you wrote (at least 150 words), every sentence the learner will read",\n').replace(/ {2}"reading": "[^\n]*\n/, '')
const RULES = (c: ComposeContext, ai = false) => `The learner is Vietnamese, CEFR ${c.level}; week topic: "${c.topic}"; the whole session lasts 30 minutes.
Produce 10-12 useful vocabulary items (words or phrases that actually appear in the material or your reading text, suited to ${c.level}), each with an English example sentence, and 2-3 grammar points seen in the text, each with an example.
Write "explanation_vi" as 5-8 sentences that walk the learner through the text paragraph by paragraph.
All explanations and meanings are in Vietnamese; examples are in English at the learner's level. Do not reproduce the source text beyond the short excerpt.
Also write the end-of-lesson quiz: exactly ${QUIZ_SIZE} items, 5 "mcq" and 3 "fill"; at least 2 of the mcq check reading comprehension of the text.
- "mcq": 4 different options, "answer" is the zero-based index of the single correct option.
- "fill": ONE sentence containing exactly one "___" blank; "answer" is one word or a short phrase (max 3 words) that clearly fits.
- Every item must be answerable from this lesson (its vocabulary, grammar, summary or excerpt) and suited to ${c.level}; no trick questions; no two items about the same thing.
- Questions about the text must be answerable ONLY from the reading text the learner sees (what you put in "reading" / "excerpt" in this same JSON). NEVER ask about details that are not written in that text (places, transport, times, people, numbers). Vocabulary and grammar questions may only use this lesson's own vocabulary and grammar points.
- "explanation_vi" explains the correct answer in Vietnamese; "word" is the related vocab word of this lesson when there is one.
Return ONLY JSON in exactly this shape:
${ai ? SHAPE_AI : SHAPE}`

type PromptMode =
  | { kind: 'text'; text: string }
  | { kind: 'video' }
  | { kind: 'ai' }
  | { kind: 'upload-text'; text: string; part: number; parts: number; usedTitles: string[] }
  | { kind: 'upload-pdf'; usedTitles: string[] }

const avoid = (titles: string[]) => (titles.length ? `
Lessons already made from this material (choose DIFFERENT content, do not repeat): ${titles.map((t) => `"${t}"`).join(', ')}.` : '')

export function buildLessonPrompt(c: ComposeContext, mode: PromptMode): string {
  const src = c.chosen
  if (mode.kind === 'upload-text' && src) {
    return `Build a 30-minute English lesson from part ${mode.part} of ${mode.parts} of the learner's OWN material ("${src.title}"). The learner uploaded it themselves.${avoid(mode.usedTitles)}
--- MATERIAL TEXT ---
${mode.text}
--- END ---
${RULES(c)}`
  }
  if (mode.kind === 'upload-pdf' && src) {
    return `Build a 30-minute English lesson from the attached PDF, which is the learner's OWN material ("${src.title}"). Pick ONE coherent section of about 1-2 pages that suits CEFR ${c.level} and the topic if possible.${avoid(mode.usedTitles)}
${RULES(c)}`
  }
  if (mode.kind === 'text' && src) {
    return `Build a 30-minute English lesson from this ${src.type === 'podcast' ? 'podcast transcript page' : 'web article'} ("${src.title}", ${src.url}).\n--- SOURCE TEXT ---\n${mode.text}\n--- END ---\n${RULES(c)}`
  }
  if (mode.kind === 'video' && src) {
    return `Build a 30-minute English lesson from this YouTube video ("${src.title}"), using its spoken English / captions.\n${RULES(c)}`
  }
  return `Write your OWN original English reading text (250-350 words, at least 150; CEFR ${c.level}) about "${c.topic}", then build the lesson on it. Put the whole reading text in "excerpt" (this one time it may be longer than 80 words) and omit "reading".\n${RULES(c, true)}`
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Kiểm tra và làm sạch bài AI soạn. Thiếu nội dung cốt lõi → AiError để thử lại. */
export function normalizeLesson(raw: unknown, source: LessonSource, notice_vi?: string): Lesson {
  const r = (raw ?? {}) as Record<string, unknown>
  const title = str(r.title, 120)
  // đoạn trích từ nguồn thật: tối đa 80 từ; bài do AI tự viết là nội dung của chính AI nên được dài hơn
  const excerpt = source.ai_written ? str(r.excerpt, MAX_AI_TEXT) : clipWords(str(r.excerpt, MAX_EXCERPT), LESSON_EXCERPT_WORDS)
  const summary_vi = str(r.summary_vi, 2000)
  const explanation_vi = str(r.explanation_vi, 3000)
  const reading = str(r.reading, MAX_AI_TEXT)
  const goals_vi = (Array.isArray(r.goals_vi) ? r.goals_vi : []).map((g) => str(g, 160)).filter(Boolean).slice(0, 3)
  const t = (r.task ?? {}) as Record<string, unknown>
  const task = str(t.en, 400) && str(t.vi, 400) ? { en: str(t.en, 400), vi: str(t.vi, 400) } : undefined

  const seen = new Set<string>()
  const vocab: VocabItem[] = []
  for (const v of Array.isArray(r.vocab) ? (r.vocab as Record<string, unknown>[]) : []) {
    const word = str(v?.word, 60)
    const meaning_vi = str(v?.meaning_vi, 200)
    if (!word || !meaning_vi || seen.has(word.toLowerCase())) continue
    seen.add(word.toLowerCase())
    vocab.push({ word, pos: str(v.pos, 20) || undefined, meaning_vi, example: str(v.example, 300) || undefined })
    if (vocab.length === MAX_VOCAB) break
  }
  const grammar: GrammarItem[] = []
  for (const g of Array.isArray(r.grammar) ? (r.grammar as Record<string, unknown>[]) : []) {
    const point = str(g?.point, 120)
    const explanation_vi = str(g?.explanation_vi, 600)
    if (!point || !explanation_vi) continue
    grammar.push({ point, explanation_vi, example: str(g.example, 300) || undefined })
    if (grammar.length === MAX_GRAMMAR) break
  }

  if (!title || !excerpt || !summary_vi || !explanation_vi || vocab.length < MIN_VOCAB || grammar.length < 1) {
    throw new LessonQualityError('Bài AI soạn thiếu nội dung')
  }
  const quiz = normalizeQuiz(r.quiz, vocab.map((v) => v.word))
  if (!quiz) throw new LessonQualityError('Quiz AI soạn không đủ câu hợp lệ')
  return {
    title, source, excerpt, ...(reading && !source.ai_written ? { reading } : {}), ...(goals_vi.length ? { goals_vi } : {}), ...(task ? { task } : {}),
    summary_vi, explanation_vi, vocab, grammar, quiz, ...(notice_vi ? { notice_vi } : {}) }
}

const AI_SOURCE: LessonSource = { type: 'ai', title: 'Bài đọc do AI viết', ai_written: true }

async function fetchSourceText(url: string, timeoutMs: number): Promise<string> {
  if (!isSafeUrl(url)) return ''
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return ''
    return visibleText(await readLimited(res, 200_000)).slice(0, MAX_SOURCE_CHARS)
  } catch {
    return ''
  }
}

/**
 * Soạn bài từ tài liệu đã chọn trong tối đa `budgetMs` (mặc định 55 giây, để chừa chút cho phản hồi trong giới hạn 60 giây):
 * link nguồn + đoạn trích ngắn, tóm tắt và giải thích tiếng Việt, từ vựng + ngữ pháp.
 *
 * Khi không có tài liệu (fallback), không đọc được trang, hoặc video không dùng được → AI tự viết bài đọc và ghi rõ `ai_written`.
 * Lỗi từ chối/quá hạn của API được ném ra (không chuyển sang fallback vì cũng sẽ bị từ chối).
 */
async function composeOnce(env: Env, c: ComposeContext, opts: { budgetMs?: number } = {}): Promise<Lesson> {
  const t0 = Date.now()
  const budget = opts.budgetMs ?? COMPOSE_BUDGET_MS
  const left = () => Math.max(1_000, budget - (Date.now() - t0))
  const call = async (parts: Part[]) => geminiJson<unknown>(env, parts, { timeoutMs: left() })

  const writeByAi = async (reason?: string) =>
    normalizeLesson(await call([{ text: buildLessonPrompt(c, { kind: 'ai' }) }]), AI_SOURCE, reason)

  const src = c.chosen

  /** Bài từ tài liệu người học tải lên (file PDF/văn bản trong R2, hoặc link). Không đọc được → AI tự viết + ghi chú. */
  const composeFromUpload = async (): Promise<Lesson> => {
    const up = c.upload!
    const unreadable = 'Không đọc được tài liệu bạn đã tải lên nên AI tự viết bài đọc.'
    const row = await env.DB.prepare('SELECT kind, title, url, r2_key, mime FROM uploads WHERE id = ?')
      .bind(up.id)
      .first<{ kind: 'file' | 'link'; title: string; url: string | null; r2_key: string | null; mime: string | null }>()
    if (!row) return writeByAi(unreadable) // đã bị xóa
    const source: LessonSource = { type: 'upload', title: row.title, ai_written: false, upload_id: up.id, ...(row.url ? { url: row.url } : {}) }
    const done = (raw: unknown) => normalizeLesson(raw, source)
    const textLesson = async (text: string, part: number, parts: number) =>
      done(await call([{ text: buildLessonPrompt(c, { kind: 'upload-text', text, part, parts, usedTitles: up.usedTitles }) }]))

    if (row.kind === 'link') {
      const text = await fetchSourceText(row.url ?? '', Math.min(PAGE_TIMEOUT_MS, left()))
      return text.length < MIN_SOURCE_CHARS ? writeByAi(unreadable) : textLesson(text, 1, 1)
    }

    const bytes = row.r2_key ? await blobStore(env).get(row.r2_key) : null
    if (!bytes) return writeByAi(unreadable)

    if (row.mime === 'application/pdf') {
      try {
        const raw = await call([
          { inlineData: { mimeType: 'application/pdf', data: toBase64(bytes) } },
          { text: buildLessonPrompt(c, { kind: 'upload-pdf', usedTitles: up.usedTitles }) },
        ])
        return done(raw)
      } catch (e) {
        // PDF quét ảnh / hỏng: AI không đọc được → tự viết nếu còn thời gian và không phải lỗi từ chối/quá hạn
        if (e instanceof AiError && e.kind === 'other' && budget - (Date.now() - t0) > 20_000) return writeByAi(unreadable)
        throw e
      }
    }

    const segments = splitSegments(new TextDecoder().decode(bytes), MAX_SOURCE_CHARS - 1000)
    const idx = up.partIndex % segments.length
    return textLesson(segments[idx], idx + 1, segments.length)
  }

  if (src?.type === 'upload' && c.upload) return composeFromUpload()
  if (!src) return writeByAi(c.fallbackNotice) // không có tài liệu: AI tự viết (fallback)

  if (src.type === 'youtube') {
    if (!youtubeId(src.url)) return writeByAi('Không dùng được video đã chọn nên AI tự viết bài đọc.')
    try {
      const raw = await call([{ fileData: { fileUri: src.url } }, { text: buildLessonPrompt(c, { kind: 'video' }) }])
      return normalizeLesson(raw, { type: 'youtube', url: src.url, title: src.title, ai_written: false })
    } catch (e) {
      // video không có phụ đề / AI không đọc được: chỉ chuyển sang AI tự viết nếu còn đủ thời gian và không phải lỗi từ chối/quá hạn
      if (e instanceof AiError && e.kind === 'other' && budget - (Date.now() - t0) > 20_000) {
        return writeByAi('AI không đọc được video đã chọn nên tự viết bài đọc.')
      }
      throw e
    }
  }

  const text = await fetchSourceText(src.url, Math.min(PAGE_TIMEOUT_MS, left()))
  if (text.length < MIN_SOURCE_CHARS) return writeByAi('Không đọc được tài liệu đã chọn nên AI tự viết bài đọc.')
  const raw = await call([{ text: buildLessonPrompt(c, { kind: 'text', text }) }])
  return normalizeLesson(raw, { type: src.type, url: src.url, title: src.title, ai_written: false })
}

/** Kiểm tra bài đã soạn: bài AI viết đủ dài (lượt đầu) và quiz chỉ còn các câu bám sát bài (≥ MIN_QUIZ câu). */
function ensureGrounded(l: Lesson, strictLength: boolean): Lesson {
  if (strictLength && l.source.ai_written && readingWords(l) < MIN_READING_WORDS) throw new LessonQualityError('Bài đọc AI viết quá ngắn')
  const quiz = groundQuiz(l)
  if (quiz.length < MIN_QUIZ) throw new LessonQualityError('Quiz AI soạn không bám sát bài đọc')
  return { ...l, quiz }
}

/**
 * Soạn bài (xem composeOnce) rồi kiểm tra chất lượng: quiz phải bám sát bài đọc người học thấy.
 * Bài chưa đạt thì thử lại MỘT lần nếu còn đủ thời gian (lần thử lại chỉ cần quiz bám bài, không bắt buộc bài đọc đủ dài).
 */
export async function composeLesson(env: Env, c: ComposeContext, opts: { budgetMs?: number } = {}): Promise<Lesson> {
  const t0 = Date.now()
  const budget = opts.budgetMs ?? COMPOSE_BUDGET_MS
  for (let attempt = 1; ; attempt++) {
    try {
      return ensureGrounded(await composeOnce(env, c, { budgetMs: Math.max(1_000, budget - (Date.now() - t0)) }), attempt === 1)
    } catch (e) {
      // nội dung chưa đạt, hoặc AI trả JSON hỏng (lỗi thoáng qua): thử lại một lần. Lỗi API (429/503/khóa sai/quá hạn) thì không.
      const retryable = e instanceof LessonQualityError || (e instanceof AiError && e.kind === 'other' && /JSON/.test(e.message))
      if (retryable && attempt === 1 && budget - (Date.now() - t0) > 25_000) continue
      throw e
    }
  }
}