import type { ErrorHandler } from 'hono'

/**
 * rate    — API từ chối / quá tải / hết hạn mức (429, 503): thử lại sau
 * timeout — AI trả lời quá lâu
 * config  — thiếu hoặc sai khóa API: thử lại không giúp được gì
 * other   — lỗi khác từ AI (rỗng, bị chặn, JSON hỏng…): thử lại có thể ổn
 */
export type AiErrorKind = 'rate' | 'timeout' | 'config' | 'other'

export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

const MESSAGES: Record<AiErrorKind, string> = {
  rate: 'AI đang từ chối yêu cầu hoặc đã hết hạn mức. Hãy thử lại sau ít phút.',
  timeout: 'AI phản hồi quá lâu. Hãy thử lại.',
  config: 'Chưa cấu hình đúng khóa hoặc tên model Gemini (GEMINI_API_KEY, GEMINI_MODEL). Hãy kiểm tra cấu hình rồi thử lại.',
  other: 'AI gặp lỗi tạm thời. Hãy thử lại.',
}

export function aiErrorBody(e: AiError) {
  return {
    error: 'ai_unavailable' as const,
    kind: e.kind,
    retryable: e.kind !== 'config',
    message: MESSAGES[e.kind],
  }
}

/** Mọi lỗi AI trong API đều ra cùng một dạng JSON, mã 503. */
export const handleError: ErrorHandler = (err, c) => {
  if (err instanceof AiError) {
    if (err.kind === 'rate') c.header('Retry-After', '60')
    return c.json(aiErrorBody(err), 503)
  }
  console.error(err)
  return c.json({ error: 'server_error', retryable: true, message: 'Lỗi hệ thống. Hãy thử lại.' }, 500)
}
