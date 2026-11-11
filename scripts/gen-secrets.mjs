// Tạo .dev.vars cho môi trường local. Chỉ điền các khóa còn thiếu; không ghi đè giá trị đã có.
// Chạy: npm run secrets:init
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const FILE = '.dev.vars'
const b64url = (buf) => Buffer.from(buf).toString('base64url')

function vapidPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pub = publicKey.export({ format: 'jwk' })
  const prv = privateKey.export({ format: 'jwk' })
  // khóa công khai dạng không nén: 0x04 || X || Y (65 byte); khóa riêng: d (32 byte)
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])
  return { pub: b64url(raw), prv: prv.d }
}

const current = {}
if (existsSync(FILE)) {
  for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) current[m[1]] = m[2]
  }
}

// khóa tự sinh, chỉ tạo khi chưa có (VAPID là một cặp: thiếu một nửa thì tạo lại cả cặp)
const generated = {}
if (!current.SESSION_SECRET) generated.SESSION_SECRET = b64url(randomBytes(32))
if (!current.VAPID_PUBLIC_KEY || !current.VAPID_PRIVATE_KEY) {
  const k = vapidPair()
  generated.VAPID_PUBLIC_KEY = k.pub
  generated.VAPID_PRIVATE_KEY = k.prv
}

// khóa người dùng phải tự điền
const manual = {
  GEMINI_API_KEY: '',
  APP_PASSWORD: '',
  RESEND_API_KEY: '',
  EMAIL_FROM: 'English Coach <onboarding@resend.dev>',
  EMAIL_TO: '',
  VAPID_SUBJECT: '',
  APP_URL: 'http://localhost:5173',
}

const merged = { ...manual, ...generated, ...current }
const order = ['GEMINI_API_KEY', 'APP_PASSWORD', 'SESSION_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'APP_URL']
const extra = Object.keys(merged).filter((k) => !order.includes(k))
writeFileSync(FILE, [...order, ...extra].map((k) => `${k}=${merged[k] ?? ''}`).join('\n') + '\n')

console.log(`Đã cập nhật ${FILE}`)
if (Object.keys(generated).length) console.log('Tự tạo mới:', Object.keys(generated).join(', '))
const todo = order.filter((k) => k in manual && !merged[k])
if (todo.length) console.log('Bạn cần tự điền:', todo.join(', '))
