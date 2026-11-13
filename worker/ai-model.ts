import { usageFor } from './ai-usage'
import type { Env } from './env'

/**
 * Model Gemini cho phép chọn ở trang chủ (tên API chính xác, lấy từ danh sách model của khóa).
 * rpm/tpm/rpd: hạn mức gói miễn phí, chép từ trang https://aistudio.google.com/rate-limit của khóa này; đổi gói thì sửa ở đây.
 */
export const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', rpm: 15, tpm: 250_000, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', rpm: 15, tpm: 250_000, rpd: 500 },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', rpm: 5, tpm: 250_000, rpd: 20 },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', rpm: 5, tpm: 250_000, rpd: 20 },
] as const

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'
const isGeminiModel = (v: unknown): v is string => GEMINI_MODELS.some((m) => m.id === v)

/** Nhớ lựa chọn model trong bộ nhớ của Worker một lúc để mỗi lần gọi AI không tốn thêm một vòng đi-về tới D1 (theo từng DB, nên các test không lẫn nhau). */
const MODEL_CACHE = new WeakMap<object, { model: string; exp: number }>()
const MODEL_CACHE_MS = 30_000

/** Model đang dùng: lựa chọn của người dùng (bảng settings) > biến GEMINI_MODEL > mặc định. Lỗi đọc DB thì dùng biến môi trường. */
export async function currentModel(env: Env): Promise<string> {
  const hit = env.DB ? MODEL_CACHE.get(env.DB) : undefined
  if (hit && hit.exp > Date.now()) return hit.model
  let model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  try {
    const row = await env.DB?.prepare("SELECT value FROM settings WHERE key = 'gemini_model'").first<{ value: string }>()
    if (row && isGeminiModel(row.value)) model = row.value
    if (env.DB) MODEL_CACHE.set(env.DB, { model, exp: Date.now() + MODEL_CACHE_MS })
  } catch {
    // bảng chưa có hoặc DB lỗi: dùng cấu hình mặc định (không nhớ lại để lần sau thử đọc lại)
  }
  return model
}

export async function modelInfo(env: Env) {
  const model = await currentModel(env)
  const m = GEMINI_MODELS.find((x) => x.id === model)
  return {
    model,
    models: GEMINI_MODELS.map(({ id, label }) => ({ id, label })),
    /** hạn mức của model đang dùng; null nếu model ngoài danh sách (GEMINI_MODEL tự đặt) */
    limits: m ? { rpm: m.rpm, tpm: m.tpm, rpd: m.rpd } : null,
    usage: await usageFor(env, model),
  }
}

/** Lưu model người dùng chọn. Chỉ nhận model nằm trong danh sách. */
export async function saveModel(env: Env, model: unknown): Promise<boolean> {
  if (!isGeminiModel(model)) return false
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('gemini_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(model).run()
  MODEL_CACHE.set(env.DB, { model, exp: Date.now() + MODEL_CACHE_MS }) // đổi model có hiệu lực ngay
  return true
}
