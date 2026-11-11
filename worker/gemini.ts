import type { Env } from './env'
import { AiError } from './errors'

export type Part =
  | { text: string }
  | { fileData: { fileUri: string; mimeType?: string } }
  | { inlineData: { mimeType: string; data: string } }

export interface GeminiOpts {
  tools?: unknown[]
  /** mặc định 55 giây (giới hạn chờ 60 giây của một buổi học) */
  timeoutMs?: number
  /** chỉ dẫn hệ thống (vai trò, quy tắc) — tách khỏi nội dung người dùng gửi */
  system?: string
  /** các lượt hội thoại trước đó, theo thứ tự; `parts` là lượt hiện tại của người dùng */
  history?: { role: 'user' | 'model'; text: string }[]
  /** true: trả văn bản thường, không ép JSON (dùng cho chat) */
  plain?: boolean
}

interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[]
  promptFeedback?: { blockReason?: string }
}

/** Gọi Gemini, trả về văn bản. Mọi lỗi đều thành AiError. */
export async function gemini(env: Env, parts: Part[], opts: GeminiOpts = {}): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new AiError('config', 'Thiếu GEMINI_API_KEY')

  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
  const generationConfig: Record<string, unknown> = { temperature: 0.7 }
  // responseMimeType json không dùng chung được với công cụ google_search
  if (!opts.tools && !opts.plain) generationConfig.responseMimeType = 'application/json'
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 }
  const contents = [...(opts.history ?? []).map((h) => ({ role: h.role, parts: [{ text: h.text }] })), { role: 'user', parts }]
  const body: Record<string, unknown> = { contents, generationConfig }
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] }
  if (opts.tools) body.tools = opts.tools

  let res: Response
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 55_000),
    })
  } catch (e) {
    const name = (e as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') throw new AiError('timeout', 'Hết thời gian chờ')
    throw new AiError('other', 'Không gọi được Gemini')
  }

  if (res.status === 429 || res.status === 503) throw new AiError('rate', `Gemini ${res.status}`)
  // 404 = tên model đã bị Google gỡ/đổi → lỗi cấu hình, thử lại cũng vô ích
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new AiError('config', `Gemini ${res.status}`)
  if (res.status === 400) {
    // khóa sai trả 400 "API key not valid"
    const text = await res.text().catch(() => '')
    throw new AiError(/api key/i.test(text) ? 'config' : 'other', 'Gemini 400')
  }
  if (!res.ok) throw new AiError('other', `Gemini ${res.status}`)

  const data = (await res.json().catch(() => ({}))) as GeminiResponse
  if (data.promptFeedback?.blockReason) throw new AiError('other', 'Yêu cầu bị chặn: ' + data.promptFeedback.blockReason)
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new AiError('other', 'Gemini trả về rỗng')
  return text
}

export function extractJson<T>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/g, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AiError('other', 'Gemini không trả JSON')
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T
  } catch {
    throw new AiError('other', 'JSON từ Gemini không hợp lệ')
  }
}

export async function geminiJson<T>(env: Env, parts: Part[], opts: GeminiOpts = {}): Promise<T> {
  return extractJson<T>(await gemini(env, parts, opts))
}
