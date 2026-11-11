import type { Env } from './env'
import { AiError } from './errors'
import { geminiJson, type Part } from './gemini'
import { isSafeUrl, readLimited, visibleText, youtubeId } from './link-check'
import type { MaterialOption } from './materials'
import { normalizeQuiz, QUIZ_SIZE, type QuizItem } from './quiz'
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
  summary_vi: string
  explanation_vi: string
  vocab: VocabItem[]
  grammar: GrammarItem[]
  /** quiz cuối buổi (có đáp án, chỉ lưu phía máy chủ; gửi cho người học qua `publicLesson`) */
  quiz: QuizItem[]
  /** lý do chuyển sang bài AI tự viết (nếu có), tiếng Việt */
  notice_vi?: string
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
const MAX_AI_TEXT = 1_500 // bài đọc do AI tự viết (nội dung của chính AI)
const MIN_VOCAB = 4
const MAX_VOCAB = 8
const MAX_GRAMMAR = 2

const UA = 'Mozilla/5.0 (compatible; EnglishCoach/1.0)'

const SHAPE = `{
  "title": "lesson title in English, max 10 words",
  "excerpt": "ONE short quote (max 80 words) copied from the source that the lesson is based on",
  "summary_vi": "tóm tắt nội dung bằng tiếng Việt, 2-4 câu",
  "explanation_vi": "giải thích bằng tiếng Việt: ý chính, bối cảnh, mẹo hiểu bài, 3-6 câu",
  "vocab": [{"word":"","pos":"noun|verb|adj|adv|phrase","meaning_vi":"nghĩa tiếng Việt","example":"an English example sentence"}],
  "grammar": [{"point":"grammar point name","explanation_vi":"giải thích ngắn bằng tiếng Việt","example":"an English example sentence"}],
  "quiz": [
    {"type":"mcq","question":"...?","options":["A","B","C","D"],"answer":0,"explanation_vi":"vì sao đáp án đúng, bằng tiếng Việt","word":"a vocab word of this lesson"},
    {"type":"fill","question":"A sentence with exactly one ___ blank.","answer":"one to three words","explanation_vi":"giải thích bằng tiếng Việt","word":"a vocab word of this lesson"}
  ]
}`

const RULES = (c: ComposeContext) => `The learner is Vietnamese, CEFR ${c.level}; week topic: "${c.topic}"; the whole session lasts 30 minutes.
Produce 6-8 useful vocabulary items (words or phrases that actually appear in the material, suited to ${c.level}), and 1-2 grammar points seen in the material.
All explanations and meanings are in Vietnamese; examples are in English at the learner's level. Do not reproduce the source text beyond the short excerpt.
Also write the end-of-lesson quiz: exactly ${QUIZ_SIZE} items, 5 "mcq" and 3 "fill".
- "mcq": 4 different options, "answer" is the zero-based index of the single correct option.
- "fill": ONE sentence containing exactly one "___" blank; "answer" is one word or a short phrase (max 3 words) that clearly fits.
- Every item must be answerable from this lesson (its vocabulary, grammar, summary or excerpt) and suited to ${c.level}; no trick questions; no two items about the same thing.
- "explanation_vi" explains the correct answer in Vietnamese; "word" is the related vocab word of this lesson when there is one.
Return ONLY JSON in exactly this shape:
${SHAPE}`

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
  return `Write your OWN original English reading text (120-180 words, CEFR ${c.level}) about "${c.topic}", then build the lesson on it. Put the whole reading text in "excerpt" (this one time it may be longer than 80 words).\n${RULES(c)}`
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
    throw new AiError('other', 'Bài AI soạn thiếu nội dung')
  }
  const quiz = normalizeQuiz(r.quiz, vocab.map((v) => v.word))
  if (!quiz) throw new AiError('other', 'Quiz AI soạn không đủ câu hợp lệ')
  return { title, source, excerpt, summary_vi, explanation_vi, vocab, grammar, quiz, ...(notice_vi ? { notice_vi } : {}) }
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
export async function composeLesson(env: Env, c: ComposeContext, opts: { budgetMs?: number } = {}): Promise<Lesson> {
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

    const obj = row.r2_key ? await env.FILES.get(row.r2_key) : null
    if (!obj) return writeByAi(unreadable)
    const bytes = new Uint8Array(await obj.arrayBuffer())

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
