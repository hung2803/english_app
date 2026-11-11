import type { MaterialOption } from './materials'

export type LinkProblem =
  | 'unsafe_url' // không phải http(s) công khai (localhost, IP nội bộ…)
  | 'unreachable' // lỗi mạng / quá thời gian
  | 'http_error' // 4xx / 5xx
  | 'not_html' // không phải trang web đọc được (PDF, ảnh, JSON…)
  | 'soft_404' // trả 200 nhưng là trang "không tìm thấy" / yêu cầu đăng nhập
  | 'too_short' // gần như không có nội dung để học
  | 'no_transcript' // podcast không có transcript
  | 'bad_youtube' // video không tồn tại / riêng tư / URL YouTube sai

export type LinkResult = { ok: true } | { ok: false; problem: LinkProblem }

const TIMEOUT_MS = 6000
const MAX_BYTES = 200_000
const MIN_ARTICLE_CHARS = 300
const MIN_PODCAST_CHARS = 800
const UA = 'Mozilla/5.0 (compatible; EnglishCoach/1.0; +learning-material-check)'

/** Chỉ http(s) tới máy chủ công khai: chặn localhost, IP nội bộ, địa chỉ link-local, host không có dấu chấm. */
export function isSafeUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const h = u.hostname.toLowerCase()
  if (!h.includes('.') && !h.startsWith('[')) return false // localhost, tên nội bộ
  if (h.startsWith('[')) return false // IPv6 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false
  }
  return !/\.(local|internal|localhost|lan)$/.test(h)
}

/** ID video từ URL YouTube dạng watch?v= hoặc youtu.be/. null nếu không phải. */
export function youtubeId(raw: string): string | null {
  try {
    const u = new URL(raw)
    const h = u.hostname.replace(/^(www\.|m\.)/, '')
    if (h === 'youtu.be') return /^[\w-]{11}$/.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null
    if (h === 'youtube.com' && u.pathname === '/watch') {
      const v = u.searchParams.get('v')
      return v && /^[\w-]{11}$/.test(v) ? v : null
    }
  } catch {
    // rơi xuống null
  }
  return null
}

export async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  let bytes = 0
  while (bytes < max) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    out += dec.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return out
}

export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&[#\w]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const SOFT_404_TITLE = /(^|\W)(404|page not found|not found|error|access denied|forbidden|sign in|log in|login)(\W|$)/i
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|subscribe|register|paywall)(\/|$|\?)/i

export type PageResult = { ok: true; html: string; text: string; title: string } | { ok: false; problem: LinkProblem }

/**
 * Tải một trang web công khai và kiểm tra nó đọc được (HTML thật, không phải trang lỗi/đăng nhập).
 * Trả về HTML (tối đa ~200KB), văn bản hiển thị và tiêu đề. Không bao giờ ném lỗi. Không kiểm tra độ dài tối thiểu.
 */
export async function inspectPage(url: string): Promise<PageResult> {
  if (!isSafeUrl(url)) return { ok: false, problem: 'unsafe_url' }
  let res: Response
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    return { ok: false, problem: 'unreachable' }
  }
  try {
    if (!res.ok) return { ok: false, problem: 'http_error' }
    if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? '')) return { ok: false, problem: 'not_html' }
    if (res.url && LOGIN_PATH.test(new URL(res.url).pathname)) return { ok: false, problem: 'soft_404' } // bị chuyển tới trang đăng nhập / trả phí
    const html = await readLimited(res, MAX_BYTES)
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
    if (title && SOFT_404_TITLE.test(title) && title.length < 60) return { ok: false, problem: 'soft_404' }
    return { ok: true, html, text: visibleText(html), title }
  } catch {
    return { ok: false, problem: 'unreachable' }
  }
}

/** Kiểm tra một link có thật sự dùng được để học không. Không bao giờ ném lỗi. */
export async function checkLink(o: Pick<MaterialOption, 'type' | 'url'>): Promise<LinkResult> {
  if (!isSafeUrl(o.url)) return { ok: false, problem: 'unsafe_url' }

  if (o.type === 'youtube') {
    if (!youtubeId(o.url)) return { ok: false, problem: 'bad_youtube' }
    try {
      // oEmbed trả 200 khi video tồn tại và công khai; 401/404 khi riêng tư hoặc không có
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(o.url), { signal: AbortSignal.timeout(TIMEOUT_MS) })
      await r.body?.cancel().catch(() => {})
      return r.ok ? { ok: true } : { ok: false, problem: 'bad_youtube' }
    } catch {
      return { ok: false, problem: 'unreachable' }
    }
  }

  const page = await inspectPage(o.url)
  if (!page.ok) return page
  if (page.text.length < (o.type === 'podcast' ? MIN_PODCAST_CHARS : MIN_ARTICLE_CHARS)) return { ok: false, problem: 'too_short' }
  if (o.type === 'podcast' && !/transcript/i.test(page.html)) return { ok: false, problem: 'no_transcript' }
  return { ok: true }
}

/** Kiểm tra song song, chỉ giữ link dùng được (giữ nguyên thứ tự). */
export async function keepValidLinks<T extends Pick<MaterialOption, 'type' | 'url'>>(options: T[], check = checkLink): Promise<T[]> {
  const results = await Promise.all(options.map((o) => check(o)))
  return options.filter((_, i) => results[i].ok)
}
