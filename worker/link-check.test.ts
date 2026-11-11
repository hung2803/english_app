import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkLink, isSafeUrl, keepValidLinks, youtubeId } from './link-check'
import { findMaterials } from './materials'
import type { Env } from './env'

afterEach(() => vi.unstubAllGlobals())

const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body>${body}</body></html>`
const LONG = '<p>' + 'This is a useful English sentence for learners. '.repeat(30) + '</p>' // ~1400 ký tự
const SHORT = '<p>Hello.</p>'
const res = (body: string, init: ResponseInit & { url?: string } = {}) => {
  const r = new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })
  if (init.url) Object.defineProperty(r, 'url', { value: init.url })
  return r
}
const stub = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const f = vi.fn(async (input: unknown, init?: RequestInit) => fn(String(input), init))
  vi.stubGlobal('fetch', f)
  return f
}
const art = (url = 'https://example.com/a') => ({ type: 'article' as const, url })
const pod = (url = 'https://pod.example.org/ep1') => ({ type: 'podcast' as const, url })
const yt = (url = 'https://www.youtube.com/watch?v=abc12345678') => ({ type: 'youtube' as const, url })

describe('isSafeUrl — chỉ link công khai', () => {
  it('chấp nhận http(s) tới tên miền công khai', () => {
    for (const u of ['https://example.com/a', 'http://news.bbc.co.uk/x?y=1', 'https://sub.domain.org']) expect(isSafeUrl(u)).toBe(true)
  })
  it('chặn giao thức khác, localhost, IP nội bộ, IPv6, tên nội bộ, có tài khoản trong URL', () => {
    const bad = [
      'ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi',
      'http://localhost/a', 'http://localhost:8787/api', 'http://intranet/page',
      'http://127.0.0.1/a', 'http://10.0.0.5/a', 'http://192.168.1.1/a', 'http://172.16.0.1/a', 'http://172.31.9.9/a',
      'http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/a', 'http://[::1]/a',
      'http://printer.local/a', 'http://svc.internal/a', 'https://user:pass@example.com/a',
      'không phải url', '',
    ]
    for (const u of bad) expect(isSafeUrl(u), u).toBe(false)
  })
  it('IP công khai vẫn được (không chặn nhầm 172.15 / 172.32)', () => {
    expect(isSafeUrl('http://172.15.0.1/a')).toBe(true)
    expect(isSafeUrl('http://172.32.0.1/a')).toBe(true)
  })
})

describe('youtubeId', () => {
  it('nhận watch?v= và youtu.be', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=abc12345678')).toBe('abc12345678')
    expect(youtubeId('https://youtube.com/watch?v=abc12345678&t=5')).toBe('abc12345678')
    expect(youtubeId('https://m.youtube.com/watch?v=abc12345678')).toBe('abc12345678')
    expect(youtubeId('https://youtu.be/abc12345678')).toBe('abc12345678')
  })
  it('từ chối kênh, danh sách phát, ID sai độ dài, host giả', () => {
    for (const u of ['https://www.youtube.com/@channel', 'https://www.youtube.com/playlist?list=PL123', 'https://www.youtube.com/watch?v=short', 'https://youtu.be/', 'https://notyoutube.com/watch?v=abc12345678', 'rác'])
      expect(youtubeId(u), u).toBeNull()
  })
})

describe('checkLink — bài viết web', () => {
  it('trang HTML còn sống, đủ nội dung → hợp lệ', async () => {
    stub(() => res(html('Learn English', LONG)))
    expect(await checkLink(art())).toEqual({ ok: true })
  })
  it('gửi User-Agent và theo chuyển hướng', async () => {
    const f = stub(() => res(html('Learn English', LONG)))
    await checkLink(art())
    const init = f.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/EnglishCoach/)
    expect(init.redirect).toBe('follow')
  })
  it('404 / 500 → http_error', async () => {
    stub(() => res('nope', { status: 404 }))
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'http_error' })
    stub(() => res('boom', { status: 500 }))
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'http_error' })
  })
  it('lỗi mạng hoặc quá thời gian → unreachable', async () => {
    stub(() => {
      throw new TypeError('network')
    })
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'unreachable' })
    stub(() => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' })
    })
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'unreachable' })
  })
  it('không phải HTML (PDF, JSON, ảnh) → not_html', async () => {
    for (const type of ['application/pdf', 'application/json', 'image/png', '']) {
      stub(() => res(LONG, { headers: { 'content-type': type } }))
      expect(await checkLink(art()), type).toEqual({ ok: false, problem: 'not_html' })
    }
  })
  it('trả 200 nhưng là trang "không tìm thấy" → soft_404', async () => {
    for (const title of ['404 Not Found', 'Page not found', 'Error', 'Access Denied', 'Sign in to continue']) {
      stub(() => res(html(title, LONG)))
      expect(await checkLink(art()), title).toEqual({ ok: false, problem: 'soft_404' })
    }
  })
  it('tiêu đề dài bình thường có chữ "error" không bị loại nhầm', async () => {
    stub(() => res(html('How to fix common error messages in English grammar and writing for beginners', LONG)))
    expect(await checkLink(art())).toEqual({ ok: true })
  })
  it('bị chuyển hướng tới trang đăng nhập / trả phí → soft_404', async () => {
    stub(() => res(html('Welcome', LONG), { url: 'https://example.com/login?next=/a' }))
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'soft_404' })
    stub(() => res(html('Welcome', LONG), { url: 'https://example.com/subscribe/' }))
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'soft_404' })
  })
  it('gần như không có nội dung → too_short; script/style/menu không tính là nội dung', async () => {
    stub(() => res(html('Tiny', SHORT)))
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'too_short' })
    stub(() => res(html('Scripts', `<script>${'var x = 1;'.repeat(500)}</script><style>${'a{}'.repeat(500)}</style>${SHORT}`)))
    expect(await checkLink(art())).toEqual({ ok: false, problem: 'too_short' })
  })
  it('chỉ đọc tối đa ~200KB (trang khổng lồ không làm treo)', async () => {
    let pulled = 0
    stub(() => {
      const body = new ReadableStream({
        pull(c) {
          pulled += 50_000
          c.enqueue(new TextEncoder().encode('<p>' + 'word '.repeat(10_000) + '</p>'))
          if (pulled > 5_000_000) c.close()
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/html' } })
    })
    expect(await checkLink(art())).toEqual({ ok: true })
    expect(pulled).toBeLessThan(1_000_000)
  })
  it('URL không an toàn: không gọi mạng', async () => {
    const f = stub(() => res(html('x', LONG)))
    expect(await checkLink(art('http://127.0.0.1:8787/api/health'))).toEqual({ ok: false, problem: 'unsafe_url' })
    expect(await checkLink(art('http://169.254.169.254/latest'))).toEqual({ ok: false, problem: 'unsafe_url' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('checkLink — podcast', () => {
  const PODCAST_BODY = '<p>' + 'Welcome to the show. Today we talk about everyday English. '.repeat(25) + '</p>'
  it('trang dài có transcript → hợp lệ', async () => {
    stub(() => res(html('Episode 1', PODCAST_BODY + '<h2>Transcript</h2>')))
    expect(await checkLink(pod())).toEqual({ ok: true })
  })
  it('không có transcript → no_transcript', async () => {
    stub(() => res(html('Episode 1', PODCAST_BODY)))
    expect(await checkLink(pod())).toEqual({ ok: false, problem: 'no_transcript' })
  })
  it('trang podcast ngắn (chỉ có player) → too_short', async () => {
    stub(() => res(html('Episode 1', '<p>Listen now. Transcript available soon.</p>')))
    expect(await checkLink(pod())).toEqual({ ok: false, problem: 'too_short' })
  })
})

describe('checkLink — YouTube', () => {
  it('video tồn tại (oEmbed 200) → hợp lệ, gọi đúng endpoint oEmbed', async () => {
    const f = stub(() => Response.json({ title: 'x' }))
    expect(await checkLink(yt())).toEqual({ ok: true })
    expect(String(f.mock.calls[0][0])).toContain('https://www.youtube.com/oembed')
    expect(String(f.mock.calls[0][0])).toContain(encodeURIComponent('https://www.youtube.com/watch?v=abc12345678'))
  })
  it('video riêng tư / bị xóa (oEmbed 401/404) → bad_youtube', async () => {
    for (const status of [401, 404]) {
      stub(() => new Response('', { status }))
      expect(await checkLink(yt()), String(status)).toEqual({ ok: false, problem: 'bad_youtube' })
    }
  })
  it('URL YouTube sai dạng → bad_youtube, không gọi mạng', async () => {
    const f = stub(() => Response.json({}))
    expect(await checkLink(yt('https://www.youtube.com/@somechannel'))).toEqual({ ok: false, problem: 'bad_youtube' })
    expect(f).not.toHaveBeenCalled()
  })
  it('oEmbed lỗi mạng → unreachable', async () => {
    stub(() => {
      throw new TypeError('network')
    })
    expect(await checkLink(yt())).toEqual({ ok: false, problem: 'unreachable' })
  })
})

describe('keepValidLinks', () => {
  it('chỉ giữ link dùng được, đúng thứ tự, kiểm tra song song', async () => {
    const order: string[] = []
    const check = async (o: { url: string }) => {
      order.push(o.url)
      return o.url.includes('bad') ? ({ ok: false, problem: 'http_error' } as const) : ({ ok: true } as const)
    }
    const r = await keepValidLinks([art('https://a.com/1'), art('https://a.com/bad'), art('https://a.com/2')], check)
    expect(r.map((o) => o.url)).toEqual(['https://a.com/1', 'https://a.com/2'])
    expect(order).toHaveLength(3)
  })
  it('rỗng → rỗng', async () => {
    expect(await keepValidLinks([])).toEqual([])
  })
})

describe('findMaterials: loại link hỏng, bù từ các ứng viên dự phòng', () => {
  const env = { GEMINI_API_KEY: 'k' } as Env
  const ctx = { level: 'A1', topic: 'Food', seq: 1, excludeUrls: [] }
  const opt = (n: number, type = 'article') => ({ type, title: `T${n}`, url: `https://site${n}.example.com/page`, why_vi: 'ok', excerpt: 'x' })

  const aiAndPages = (options: unknown[], pageFor: (url: string) => Response) =>
    stub((url) => {
      if (url.includes('generativelanguage')) {
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ options }) }] } }] })
      }
      return pageFor(url)
    })

  it('5 ứng viên, 2 link hỏng → vẫn đưa đủ 3 link tốt', async () => {
    aiAndPages([opt(1), opt(2), opt(3), opt(4), opt(5)], (u) => (/site(1|3)\./.test(u) ? res('x', { status: 404 }) : res(html('Lesson', LONG))))
    const r = await findMaterials(env, ctx)
    expect(r.map((o) => o.url)).toEqual(['https://site2.example.com/page', 'https://site4.example.com/page', 'https://site5.example.com/page'])
  })
  it('không bao giờ đưa link hỏng cho người học', async () => {
    aiAndPages([opt(1), opt(2), opt(3)], () => res('gone', { status: 410 }))
    expect(await findMaterials(env, ctx)).toEqual([])
  })
  it('nhiều hơn 3 link tốt → chỉ lấy 3 đầu', async () => {
    aiAndPages([opt(1), opt(2), opt(3), opt(4), opt(5)], () => res(html('Lesson', LONG)))
    expect(await findMaterials(env, ctx)).toHaveLength(3)
  })
  it('link nội bộ do AI bịa (SSRF) bị loại, không bị gọi', async () => {
    const f = aiAndPages(
      [{ ...opt(1), url: 'http://169.254.169.254/latest/meta-data' }, { ...opt(2), url: 'http://localhost:8788/api/health' }, opt(3), opt(4)],
      () => res(html('Lesson', LONG)),
    )
    const r = await findMaterials(env, ctx)
    expect(r.map((o) => o.url)).toEqual(['https://site3.example.com/page', 'https://site4.example.com/page'])
    expect(f.mock.calls.map((c) => String(c[0])).some((u) => u.includes('169.254') || u.includes('localhost'))).toBe(false)
  })
  it('trộn loại: web OK, YouTube bị xóa, podcast thiếu transcript → chỉ còn web', async () => {
    aiAndPages([opt(1), opt(2, 'youtube'), opt(3, 'podcast')].map((o, i) => (i === 1 ? { ...o, url: 'https://www.youtube.com/watch?v=abc12345678' } : o)), (u) =>
      u.includes('oembed') ? new Response('', { status: 404 }) : res(html('Lesson', LONG)),
    )
    const r = await findMaterials(env, ctx)
    expect(r.map((o) => o.type)).toEqual(['article'])
  })
})
