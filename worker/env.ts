export interface Env {
  DB: D1Database
  /** R2 (tùy chọn): file người học tải lên (PDF, văn bản). Không có thì lưu trong D1 (xem blob-store.ts) */
  FILES?: R2Bucket
  ASSETS: Fetcher
  // biến thường (wrangler.toml)
  GEMINI_MODEL?: string
  // secrets — local: .dev.vars | production: wrangler secret
  GEMINI_API_KEY: string
  APP_PASSWORD: string
  SESSION_SECRET: string
  RESEND_API_KEY: string
  EMAIL_FROM: string
  EMAIL_TO: string
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
  VAPID_SUBJECT: string // mailto:… hoặc https://…
  APP_URL: string // dùng cho link trong email
}

/** Secrets bắt buộc cho từng nhóm chức năng. */
export const REQUIRED_SECRETS = {
  core: ['APP_PASSWORD', 'SESSION_SECRET'],
  ai: ['GEMINI_API_KEY'],
  email: ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO', 'APP_URL'],
  push: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
} as const satisfies Record<string, readonly (keyof Env)[]>

export type SecretGroup = keyof typeof REQUIRED_SECRETS

/** Trả về tên các secret còn thiếu của nhóm (không bao giờ trả giá trị). */
export function missingSecrets(env: Env, group: SecretGroup): string[] {
  return REQUIRED_SECRETS[group].filter((k) => !env[k])
}
