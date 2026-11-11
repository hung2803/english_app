export interface Settings {
  /** bật/tắt nhắc học */
  reminder_enabled: boolean
  /** giờ nhắc theo giờ Việt Nam, dạng HH:MM (24 giờ) */
  reminder_time: string
}

export const DEFAULT_REMINDER_TIME = '20:00'

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export const isValidTime = (v: unknown): v is string => typeof v === 'string' && TIME.test(v)

/** "HH:MM" → số phút kể từ 00:00. */
export const toMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** Đọc cài đặt; thiếu hoặc hỏng thì dùng mặc định (nhắc bật, 20:00). */
export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('reminder_enabled', 'reminder_time')").all<{ key: string; value: string }>()
  const m = new Map(results.map((r) => [r.key, r.value]))
  const time = m.get('reminder_time')
  return {
    reminder_enabled: m.get('reminder_enabled') !== '0',
    reminder_time: isValidTime(time) ? time : DEFAULT_REMINDER_TIME,
  }
}

export type UpdateResult = { ok: true; settings: Settings } | { ok: false; field: 'reminder_enabled' | 'reminder_time' | 'empty' }

/** Cập nhật một phần cài đặt. Giá trị sai kiểu/định dạng → từ chối cả yêu cầu, không đổi gì. */
export async function updateSettings(db: D1Database, patch: unknown): Promise<UpdateResult> {
  const p = (patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>
  const stmts: D1PreparedStatement[] = []
  if ('reminder_enabled' in p) {
    if (typeof p.reminder_enabled !== 'boolean') return { ok: false, field: 'reminder_enabled' }
    stmts.push(db.prepare("INSERT INTO settings (key, value) VALUES ('reminder_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(p.reminder_enabled ? '1' : '0'))
  }
  if ('reminder_time' in p) {
    if (!isValidTime(p.reminder_time)) return { ok: false, field: 'reminder_time' }
    stmts.push(db.prepare("INSERT INTO settings (key, value) VALUES ('reminder_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(p.reminder_time))
  }
  if (!stmts.length) return { ok: false, field: 'empty' }
  await db.batch(stmts)
  return { ok: true, settings: await getSettings(db) }
}
