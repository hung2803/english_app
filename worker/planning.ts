import type { Env } from './env'
import { AiError, type AiErrorKind } from './errors'
import { geminiJson } from './gemini'
import type { Level } from './placement-bank'

export const WEEKS = 12

export interface WeekPlan {
  week: number
  /** chủ đề tiếng Anh, ngắn */
  topic: string
  /** mục tiêu tuần bằng tiếng Việt */
  goal_vi: string
}

export interface GeneratedPlan {
  weeks: WeekPlan[]
  source: 'ai' | 'default'
  /** khi dùng bộ mặc định: vì sao AI không dùng được ('invalid' = AI trả nội dung không hợp lệ) */
  fallback_reason?: AiErrorKind | 'invalid'
}

type Row = [topic: string, goal_vi: string]

/** Bộ chủ đề mặc định (12 tuần, dễ → khó, tuần 12 là ôn tập) khi AI lỗi. */
const DEFAULT_TOPICS: Record<Level, Row[]> = {
  A0: [
    ['Greetings & introductions', 'Chào hỏi và giới thiệu bản thân'],
    ['Numbers, days & time', 'Số đếm, thứ trong tuần và giờ giấc'],
    ['Family & friends', 'Nói về gia đình và bạn bè'],
    ['Food & drinks', 'Gọi món và nói về đồ ăn, thức uống'],
    ['Daily routine', 'Mô tả một ngày bình thường'],
    ['My home', 'Nói về nhà cửa và đồ vật quanh nhà'],
    ['Shopping basics', 'Hỏi giá và mua sắm cơ bản'],
    ['Directions & places', 'Hỏi và chỉ đường'],
    ['Hobbies & free time', 'Nói về sở thích'],
    ['Weather & seasons', 'Nói về thời tiết và các mùa'],
    ['Simple past events', 'Kể lại chuyện đã xảy ra'],
    ['Review & mini conversations', 'Ôn tập và hội thoại ngắn'],
  ],
  A1: [
    ['Introducing yourself in detail', 'Giới thiệu bản thân chi tiết hơn'],
    ['Daily routines & habits', 'Nói về thói quen hằng ngày'],
    ['Food, restaurants & ordering', 'Đi ăn nhà hàng, gọi món'],
    ['Shopping & prices', 'Mua sắm và hỏi giá'],
    ['Transport & directions', 'Di chuyển và hỏi đường'],
    ['Past experiences', 'Kể về trải nghiệm đã qua'],
    ['Health & the body', 'Sức khỏe, đi khám bệnh'],
    ['Plans & the future', 'Nói về kế hoạch sắp tới'],
    ['Work & study', 'Nói về công việc và học tập'],
    ['Travel basics', 'Du lịch cơ bản'],
    ['Phone calls & messages', 'Gọi điện, nhắn tin'],
    ['Review & role-play', 'Ôn tập và đóng vai tình huống'],
  ],
  A2: [
    ['Talking about experiences', 'Kể trải nghiệm bằng thì hiện tại hoàn thành'],
    ['Travel & accommodation', 'Đặt phòng, đi lại khi du lịch'],
    ['Work & careers', 'Nói về công việc, phỏng vấn đơn giản'],
    ['Health & lifestyle', 'Nói về lối sống lành mạnh'],
    ['Technology in daily life', 'Công nghệ trong cuộc sống hằng ngày'],
    ['Plans & invitations', 'Mời, hẹn, từ chối lịch sự'],
    ['Describing people & places', 'Miêu tả người và nơi chốn'],
    ['News & short stories', 'Đọc tin ngắn, kể chuyện'],
    ['Opinions & agreeing', 'Nêu ý kiến, đồng ý hoặc không đồng ý'],
    ['Problems & complaints', 'Phàn nàn và giải quyết vấn đề'],
    ['Culture & customs', 'Văn hóa và phong tục'],
    ['Review & longer conversations', 'Ôn tập và hội thoại dài hơn'],
  ],
  B1: [
    ['Storytelling & past narratives', 'Kể chuyện mạch lạc'],
    ['Communication at work', 'Giao tiếp trong công việc'],
    ['Travel problems & solutions', 'Xử lý tình huống khi đi xa'],
    ['Media & news', 'Đọc và bàn luận tin tức'],
    ['Hypotheticals & advice', 'Câu điều kiện và đưa lời khuyên'],
    ['Environment & society', 'Môi trường và xã hội'],
    ['Education & learning', 'Giáo dục và học tập'],
    ['Health & wellbeing', 'Sức khỏe thể chất và tinh thần'],
    ['Technology & the future', 'Công nghệ và tương lai'],
    ['Discussion & debate', 'Tranh luận lịch sự'],
    ['Formal emails & writing', 'Viết email trang trọng'],
    ['Review & fluency practice', 'Ôn tập và luyện nói trôi chảy'],
  ],
}

export function defaultPlan(level: Level): WeekPlan[] {
  return DEFAULT_TOPICS[level].map(([topic, goal_vi], i) => ({ week: i + 1, topic, goal_vi }))
}

const MAX_TOPIC = 80
const MAX_GOAL = 200

/** Kiểm tra và chuẩn hóa kết quả AI. Trả null nếu không dùng được. */
export function normalizeWeeks(raw: unknown): WeekPlan[] | null {
  const list = (raw as { weeks?: unknown })?.weeks
  if (!Array.isArray(list) || list.length !== WEEKS) return null
  const weeks: WeekPlan[] = []
  for (const w of list) {
    const topic = typeof w?.topic === 'string' ? w.topic.trim() : ''
    const goal = typeof w?.goal_vi === 'string' ? w.goal_vi.trim() : ''
    if (!topic || !goal || topic.length > MAX_TOPIC || goal.length > MAX_GOAL) return null
    weeks.push({ week: 0, topic, goal_vi: goal })
  }
  if (new Set(weeks.map((w) => w.topic.toLowerCase())).size !== WEEKS) return null // trùng chủ đề
  return weeks.map((w, i) => ({ ...w, week: i + 1 }))
}

function prompt(level: Level): string {
  return `You are an English curriculum designer for a Vietnamese self-learner.
Learner level: CEFR ${level}. Goal: basic everyday communication, balancing listening, speaking, reading and writing. Plan: ${WEEKS} weeks, 5 sessions per week, 30 minutes each; the learner should move up one CEFR band by the end.
Design exactly ${WEEKS} weekly themes:
- progress from easier to harder;
- every theme practical for everyday life and suited to ${level};
- all ${WEEKS} topics different from each other;
- week ${WEEKS} is a review of the previous weeks.
Return ONLY JSON in this exact shape:
{"weeks":[{"week":1,"topic":"English title, max 6 words","goal_vi":"Mục tiêu của tuần bằng tiếng Việt, tối đa 15 từ"}]}`
}

/** AI lập khung 12 tuần theo mức CEFR; lỗi hoặc nội dung không hợp lệ thì dùng bộ mặc định. */
export async function generatePlan(env: Env, level: Level): Promise<GeneratedPlan> {
  try {
    const raw = await geminiJson<unknown>(env, [{ text: prompt(level) }], { timeoutMs: 45_000 })
    const weeks = normalizeWeeks(raw)
    if (weeks) return { weeks, source: 'ai' }
    return { weeks: defaultPlan(level), source: 'default', fallback_reason: 'invalid' }
  } catch (e) {
    if (!(e instanceof AiError)) throw e // lỗi lập trình thật thì không nuốt
    return { weeks: defaultPlan(level), source: 'default', fallback_reason: e.kind }
  }
}

// ---------- Lộ trình riêng của người học ----------
export const LEVELS: readonly Level[] = ['A0', 'A1', 'A2', 'B1']
export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
export { MAX_CUSTOM_CHARS, parseCustomPlan, type CustomParse } from './custom-parse'

export interface CustomPlan extends Omit<GeneratedPlan, 'source'> {
  source: 'custom'
  /** số tuần cuối do AI/bộ mặc định nối thêm cho đủ 12 tuần */
  filled_weeks: number
}

/**
 * Lộ trình riêng + nối thêm cho đủ 12 tuần (không trùng chủ đề đã nhập). Nối thêm bằng khung của AI
 * theo mức đã chọn, lỗi thì dùng bộ mặc định. Nhập đủ 12 tuần thì không gọi AI.
 */
export async function buildCustomPlan(env: Env, level: Level, custom: { topic: string; goal_vi: string }[]): Promise<CustomPlan> {
  const topics: { topic: string; goal_vi: string }[] = [...custom]
  let fallback_reason: GeneratedPlan['fallback_reason']
  if (topics.length < WEEKS) {
    const gen = await generatePlan(env, level)
    fallback_reason = gen.fallback_reason
    const used = new Set(topics.map((t) => t.topic.toLowerCase()))
    for (const w of [...gen.weeks, ...defaultPlan(level)]) {
      if (topics.length >= WEEKS) break
      if (used.has(w.topic.toLowerCase())) continue
      used.add(w.topic.toLowerCase())
      topics.push({ topic: w.topic, goal_vi: w.goal_vi })
    }
  }
  return {
    weeks: topics.slice(0, WEEKS).map((t, i) => ({ week: i + 1, ...t })),
    source: 'custom',
    filled_weeks: WEEKS - custom.length,
    ...(fallback_reason ? { fallback_reason } : {}),
  }
}

// ---------- Tuần ôn tập thêm khi test lại chưa đạt ----------
export const REVIEW_WEEKS = 2

export interface ReviewInput {
  level: Level
  /** các mức chưa đúng 100% ở bài test lại */
  weakLevels: Level[]
  /** từ hay sai (nếu có) */
  hardWords: string[]
  /** tuần đầu tiên của đợt ôn (vd 13) */
  startWeek: number
}

/** Bộ chủ đề ôn mặc định khi AI lỗi. */
export function defaultReviewWeeks(i: ReviewInput, count = REVIEW_WEEKS): WeekPlan[] {
  const weak = i.weakLevels.length ? i.weakLevels.join(', ') : i.level
  const base: [string, string][] = [
    [`Review: key vocabulary & grammar (${weak})`, `Ôn lại từ vựng và ngữ pháp trọng tâm ở mức ${weak}`],
    [`Review: reading & listening practice (${weak})`, `Luyện đọc, nghe và làm lại các phần còn yếu ở mức ${weak}`],
    [`Review: mixed practice & mini conversations`, 'Ôn tổng hợp và hội thoại ngắn'],
    [`Review: error correction & writing`, 'Sửa lỗi hay gặp và luyện viết'],
  ]
  return Array.from({ length: count }, (_, k) => ({ week: i.startWeek + k, topic: base[k % base.length][0], goal_vi: base[k % base.length][1] }))
}

/** AI soạn các tuần ôn dựa trên mức yếu và từ hay sai; lỗi hoặc không hợp lệ thì dùng bộ mặc định. */
export async function generateReviewWeeks(env: Env, i: ReviewInput, count = REVIEW_WEEKS): Promise<GeneratedPlan> {
  const text = `You are an English tutor. A Vietnamese learner finished a ${WEEKS}-week course at CEFR ${i.level} but did NOT pass the re-test.
Weak CEFR levels in the re-test (not 100% correct): ${i.weakLevels.join(', ') || 'unknown'}.
${i.hardWords.length ? `Words the learner often gets wrong: ${i.hardWords.slice(0, 20).join(', ')}.` : ''}
Design exactly ${count} extra REVIEW weeks (5 sessions per week) that target these weaknesses, with different topics from each other.
Return ONLY JSON: {"weeks":[{"week":1,"topic":"English title starting with 'Review:', max 8 words","goal_vi":"Mục tiêu bằng tiếng Việt, tối đa 15 từ"}]}`
  try {
    const raw = (await geminiJson<{ weeks?: unknown }>(env, [{ text }], { timeoutMs: 45_000 })).weeks
    if (Array.isArray(raw) && raw.length === count) {
      const weeks: WeekPlan[] = []
      for (const [k, w] of (raw as { topic?: unknown; goal_vi?: unknown }[]).entries()) {
        const topic = typeof w?.topic === 'string' ? w.topic.trim() : ''
        const goal = typeof w?.goal_vi === 'string' ? w.goal_vi.trim() : ''
        if (!topic || !goal || topic.length > MAX_TOPIC || goal.length > MAX_GOAL) throw new AiError('other', 'invalid')
        weeks.push({ week: i.startWeek + k, topic, goal_vi: goal })
      }
      if (new Set(weeks.map((w) => w.topic.toLowerCase())).size === weeks.length) return { weeks, source: 'ai' }
    }
    return { weeks: defaultReviewWeeks(i, count), source: 'default', fallback_reason: 'invalid' }
  } catch (e) {
    if (!(e instanceof AiError)) throw e
    return { weeks: defaultReviewWeeks(i, count), source: 'default', fallback_reason: e.message === 'invalid' ? 'invalid' : e.kind }
  }
}
