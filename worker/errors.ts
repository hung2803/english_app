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
  config: 'Chưa cấu hình đúng khóa hoặc tên model Gemini (GEMINI_API_KEY, GEMINI_MODEL), hoặc khóa chưa có quyền dùng model đó. Hãy kiểm tra cấu hình rồi thử lại.',
  other: 'AI gặp lỗi tạm thời. Hãy thử lại.',
}

/** 503 = máy chủ Google quá tải (không phải hết hạn mức): thông báo riêng để người dùng không nhầm. */
const OVERLOADED = 'Máy chủ AI của Google đang quá tải (không phải hết hạn mức của bạn). Hãy bấm thử lại sau vài giây.'

export function aiErrorBody(e: AiError) {
  return {
    error: 'ai_unavailable' as const,
    kind: e.kind,
    retryable: e.kind !== 'config',
    message: e.kind === 'rate' && /\b503\b/.test(e.message) ? OVERLOADED : MESSAGES[e.kind],
  }
}

/** Mọi lỗi AI trong API đều ra cùng một dạng JSON, mã 503. */
export const handleError: ErrorHandler = (err, c) => {
  if (err instanceof AiError) {
    console.warn(`[ai] ${err.kind}: ${err.message}`) // chi tiết (vd "AI 404") để xem trong log, không gửi cho người dùng
    if (err.kind === 'rate') c.header('Retry-After', '60')
    return c.json(aiErrorBody(err), 503)
  }
  console.error(err)
  return c.json({ error: 'server_error', retryable: true, message: 'Lỗi hệ thống. Hãy thử lại.' }, 500)
}
