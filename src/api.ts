export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** false = thử lại không giúp được (vd thiếu khóa API) */
    public retryable = true,
    /** 'rate' | 'timeout' | 'config' | 'other' khi là lỗi AI */
    public kind?: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit, timeoutMs?: number): Promise<T> {
  let res: Response
  const ctl = new AbortController()
  const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : undefined
  try {
    res = await fetch('/api' + path, { ...init, signal: ctl.signal })
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ApiError(0, 'Máy chủ phản hồi quá lâu. Hãy thử lại.', true, 'timeout')
    }
    throw new ApiError(0, 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.')
  } finally {
    clearTimeout(timer)
  }
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('unauthorized'))
  if (!res.ok) {
    throw new ApiError(res.status, data.message || 'Có lỗi xảy ra. Hãy thử lại.', data.retryable !== false, data.kind)
  }
  return data as T
}

/**
 * Gọi API: GET khi không có body, POST JSON khi có body (hoặc `method` chỉ định, vd 'DELETE').
 * `timeoutMs`: bỏ chờ sau chừng đó (dùng cho các lệnh gọi AI, tối đa ~60 giây ở phía máy chủ).
 */
export function api<T = any>(path: string, body?: unknown, opts: { timeoutMs?: number; method?: string } = {}): Promise<T> {
  return request<T>(
    path,
    {
      method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    opts.timeoutMs,
  )
}

/** Gửi form nhiều phần (tải file lên). Không tự đặt Content-Type để trình duyệt thêm boundary. */
export function apiForm<T = any>(path: string, form: FormData, timeoutMs = 120_000): Promise<T> {
  return request<T>(path, { method: 'POST', body: form }, timeoutMs)
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
export const isRetryable = (e: unknown) => !(e instanceof ApiError) || e.retryable
