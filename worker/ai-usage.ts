import type { Env } from './env'

export interface TokenUsage {
  prompt: number
  output: number
  total: number
}

const PT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
/** Ngày theo giờ Thái Bình Dương, dạng YYYY-MM-DD (Google reset hạn mức ngày lúc 00:00 giờ này). */
export const ptDay = (ms: number) => PT_DAY.format(ms)

/** Ghi một lần gọi Gemini. Không bao giờ làm hỏng lệnh gọi AI nếu ghi lỗi. */
export async function recordUsage(env: Env, model: string, ok: boolean, u?: TokenUsage, now = Date.now()): Promise<void> {
  try {
    await env.DB?.prepare('INSERT INTO ai_usage (ts, day, model, prompt_tokens, output_tokens, total_tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(now, ptDay(now), model, u?.prompt ?? 0, u?.output ?? 0, u?.total ?? 0, ok ? 1 : 0)
      .run()
  } catch {
    // bảng chưa có (chưa chạy migration) hoặc DB lỗi: bỏ qua
  }
}

export interface UsageView {
  rpm: number
  tpm: number
  rpd: number
  /** token hôm nay (theo ngày Thái Bình Dương) */
  tokens_today: { prompt: number; output: number; total: number }
  /** số giây tới lúc Google reset hạn mức ngày */
  reset_in_s: number
}

/** Số giây từ `now` tới 00:00 giờ Thái Bình Dương kế tiếp. */
export function secondsToPtMidnight(now: number): number {
  const today = ptDay(now)
  let lo = now
  let hi = now + 25 * 3600_000
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (ptDay(mid) === today) lo = mid
    else hi = mid
  }
  return Math.max(0, Math.ceil((hi - now) / 1000))
}

export async function usageFor(env: Env, model: string, now = Date.now()): Promise<UsageView> {
  const empty: UsageView = { rpm: 0, tpm: 0, rpd: 0, tokens_today: { prompt: 0, output: 0, total: 0 }, reset_in_s: secondsToPtMidnight(now) }
  try {
    // hai truy vấn độc lập: chạy song song để không cộng dồn thời gian chờ D1
    const [minute, day] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens), 0) AS t FROM ai_usage WHERE model = ? AND ts > ?')
        .bind(model, now - 60_000)
        .first<{ n: number; t: number }>(),
      env.DB.prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(total_tokens), 0) AS t FROM ai_usage WHERE model = ? AND day = ?',
      )
        .bind(model, ptDay(now))
        .first<{ n: number; p: number; o: number; t: number }>(),
    ])
    return {
      rpm: minute?.n ?? 0,
      tpm: minute?.t ?? 0,
      rpd: day?.n ?? 0,
      tokens_today: { prompt: day?.p ?? 0, output: day?.o ?? 0, total: day?.t ?? 0 },
      reset_in_s: empty.reset_in_s,
    }
  } catch {
    return empty
  }
}
