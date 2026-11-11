// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionPage from './pages/Session'
import { AiProgress } from './ui'

const OPTIONS = [
  { type: 'article', title: 'Ordering food', url: 'https://example.com/a', why_vi: 'Dễ đọc', excerpt: 'Can I have a coffee?' },
  { type: 'youtube', title: 'At the restaurant', url: 'https://www.youtube.com/watch?v=abc12345678', why_vi: 'Có phụ đề', excerpt: 'Hello' },
]
const LESSON = {
  title: 'Ordering food',
  source: { type: 'article', url: 'https://example.com/a', title: 'Ordering food', ai_written: false },
  excerpt: 'Can I have a coffee?',
  summary_vi: 'Tóm tắt bài.',
  explanation_vi: 'Giải thích bài.',
  vocab: [{ word: 'order', pos: 'verb', meaning_vi: 'gọi món', example: 'I order tea.' }],
  grammar: [{ point: 'Can I have ...?', explanation_vi: 'Câu xin phép.', example: 'Can I have water?' }],
}
const base = { id: 1, seq: 1, week_no: 1, topic: 'Food', scheduled_date: '2026-11-16', status: 'pending', material: null, lesson: null }

type Resp = { status?: number; body: unknown } | (() => Promise<{ status?: number; body: unknown }>)
/** Máy chủ giả: map "METHOD path" → danh sách phản hồi lần lượt (lần cuối lặp lại). */
function server(routes: Record<string, Resp[]>) {
  const counts: Record<string, number> = {}
  const f = vi.fn(async (input: unknown, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
    const list = routes[key]
    if (!list) return Response.json({ error: 'not_found', message: 'không có route ' + key }, { status: 404 })
    const i = Math.min(counts[key] ?? 0, list.length - 1)
    counts[key] = (counts[key] ?? 0) + 1
    const r = typeof list[i] === 'function' ? await (list[i] as () => Promise<{ status?: number; body: unknown }>)() : (list[i] as { status?: number; body: unknown })
    return Response.json(r.body, { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return { f, calls: (key: string) => f.mock.calls.filter((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0]).replace('/api', '')}` === key).length }
}
const session = (over: Record<string, unknown>) => ({ body: { session: { ...base, ...over } } })
const mount = () =>
  render(
    <MemoryRouter initialEntries={['/session/1']}>
      <Routes>
        <Route path="/session/:id" element={<SessionPage />} />
        <Route path="/roadmap" element={<p>Trang lộ trình</p>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AiProgress — thanh tiến trình', () => {
  const bar = () => screen.getByRole('progressbar')
  it('bắt đầu ở 0%, tăng theo thời gian, dừng ở 95% khi quá hạn', async () => {
    render(<AiProgress stages={['A', 'B', 'C']} seconds={60} />)
    expect(bar().getAttribute('aria-valuenow')).toBe('0')
    await act(async () => void vi.advanceTimersByTime(30_000))
    const half = Number(bar().getAttribute('aria-valuenow'))
    expect(half).toBeGreaterThan(40)
    expect(half).toBeLessThan(55)
    await act(async () => void vi.advanceTimersByTime(120_000))
    expect(bar().getAttribute('aria-valuenow')).toBe('95') // không bao giờ tự báo 100%
  })
  it('đổi dòng trạng thái theo tiến độ và hiện số giây đã chờ', async () => {
    render(<AiProgress stages={['Đang đọc', 'Đang soạn', 'Sắp xong']} seconds={60} />)
    expect(screen.getByText('Đang đọc')).toBeTruthy()
    await act(async () => void vi.advanceTimersByTime(30_000))
    expect(screen.getByText('Đang soạn')).toBeTruthy()
    expect(screen.getByText(/đã chờ 30 giây/)).toBeTruthy()
  })
  it('quá thời gian dự kiến → báo đang lâu hơn dự kiến', async () => {
    render(<AiProgress stages={['A']} seconds={10} />)
    await act(async () => void vi.advanceTimersByTime(12_000))
    expect(screen.getByText(/nhiều thời gian hơn dự kiến/)).toBeTruthy()
  })
  it('dọn timer khi tháo khỏi màn hình (không rò rỉ)', async () => {
    const { unmount } = render(<AiProgress stages={['A']} />)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('trang buổi học: tìm tài liệu', () => {
  it('chưa bắt đầu: có nút "Bắt đầu buổi học", chưa gọi AI', async () => {
    const s = server({ 'GET /sessions/1': [session({})] })
    mount()
    expect(await screen.findByText('Bắt đầu buổi học')).toBeTruthy()
    expect(s.calls('POST /sessions/1/materials')).toBe(0)
  })
  it('bấm bắt đầu → hiện thanh tiến trình trong lúc AI chạy, xong thì hiện danh sách để chọn', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server({
      'GET /sessions/1': [session({}), session({ material: { options: OPTIONS, chosen: null, fallback: false } })],
      'POST /sessions/1/materials': [async () => { await gate; return { body: { material: { options: OPTIONS, chosen: null, fallback: false } } } }],
    })
    mount()
    fireEvent.click(await screen.findByText('Bắt đầu buổi học'))
    expect(await screen.findByRole('progressbar')).toBeTruthy() // đang chạy
    expect(screen.queryByText('Bắt đầu buổi học')).toBeNull()
    await act(async () => release())
    expect(await screen.findByText('Ordering food')).toBeTruthy() // danh sách lựa chọn
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
  it('API từ chối: hiện thông báo tiếng Việt + nút "Thử lại"; bấm thử lại thì chạy lại và thành công', async () => {
    const s = server({
      'GET /sessions/1': [session({}), session({ material: { options: OPTIONS, chosen: null, fallback: false } })],
      'POST /sessions/1/materials': [
        { status: 503, body: { error: 'ai_unavailable', kind: 'rate', retryable: true, message: 'AI đang từ chối yêu cầu hoặc đã hết hạn mức. Hãy thử lại sau ít phút.' } },
        { body: { material: { options: OPTIONS, chosen: null, fallback: false } } },
      ],
    })
    mount()
    fireEvent.click(await screen.findByText('Bắt đầu buổi học'))
    expect(await screen.findByText(/AI đang từ chối yêu cầu/)).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull() // thanh tiến trình biến mất khi lỗi
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Ordering food')).toBeTruthy()
    expect(s.calls('POST /sessions/1/materials')).toBe(2)
  })
  it('lỗi không thể thử lại (thiếu khóa API): có thông báo nhưng KHÔNG có nút "Thử lại"', async () => {
    server({
      'GET /sessions/1': [session({})],
      'POST /sessions/1/materials': [{ status: 503, body: { error: 'ai_unavailable', kind: 'config', retryable: false, message: 'Chưa cấu hình đúng khóa Gemini (GEMINI_API_KEY).' } }],
    })
    mount()
    fireEvent.click(await screen.findByText('Bắt đầu buổi học'))
    expect(await screen.findByText(/Chưa cấu hình đúng khóa Gemini/)).toBeTruthy()
    expect(screen.queryByText('Thử lại')).toBeNull()
  })
  it('mất mạng: thông báo + thử lại', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (init?.method !== 'POST') return Response.json({ session: base, total_due: 0, cards: [] })
      if (n++ === 0) throw new TypeError('network')
      return Response.json({ material: { options: OPTIONS, chosen: null, fallback: false } })
    }))
    mount()
    fireEvent.click(await screen.findByText('Bắt đầu buổi học'))
    expect(await screen.findByText(/Không kết nối được máy chủ/)).toBeTruthy()
    expect(screen.getByText('Thử lại')).toBeTruthy()
  })
  it('quá 70 giây không phản hồi → báo quá lâu + thử lại', async () => {
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (init?.method !== 'POST') return Promise.resolve(Response.json({ session: base, total_due: 0, cards: [] }))
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))))
    }))
    mount()
    fireEvent.click(await screen.findByText('Bắt đầu buổi học'))
    await screen.findByRole('progressbar')
    await act(async () => void vi.advanceTimersByTime(71_000))
    expect(await screen.findByText(/phản hồi quá lâu/)).toBeTruthy()
    expect(screen.getByText('Thử lại')).toBeTruthy()
  })
})

describe('trang buổi học: chọn tài liệu và soạn bài', () => {
  const withOptions = { material: { options: OPTIONS, chosen: null, fallback: false } }
  it('chọn một tài liệu → gọi API chọn với đúng chỉ số', async () => {
    const s = server({
      'GET /sessions/1': [session(withOptions), session({ material: { ...withOptions.material, chosen: 1 } })],
      'POST /sessions/1/choose': [{ body: { material: { ...withOptions.material, chosen: 1 } } }],
      'POST /sessions/1/compose': [() => new Promise(() => {})], // soạn bài đang chạy
    })
    mount()
    const buttons = await screen.findAllByText('Chọn tài liệu này')
    fireEvent.click(buttons[1])
    await waitFor(() => expect(s.calls('POST /sessions/1/choose')).toBe(1))
    const body = JSON.parse((s.f.mock.calls.find((c) => String(c[0]).endsWith('/choose'))![1] as RequestInit).body as string)
    expect(body).toEqual({ index: 1 })
  })
  it('đã chọn rồi: tự soạn bài, có thanh tiến trình; xong thì hiện bài học đầy đủ', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server({
      'GET /sessions/1': [session({ material: { ...withOptions.material, chosen: 0 } }), session({ material: { ...withOptions.material, chosen: 0 }, lesson: LESSON })],
      'POST /sessions/1/compose': [async () => { await gate; return { body: { lesson: LESSON } } }],
    })
    mount()
    expect(await screen.findByRole('progressbar')).toBeTruthy()
    await act(async () => release())
    expect(await screen.findByText('Tóm tắt bài.')).toBeTruthy()
    expect(screen.getByText('Giải thích bài.')).toBeTruthy()
    expect(screen.getByText('order')).toBeTruthy()
    expect(screen.getByText(/Can I have \.\.\.\?/)).toBeTruthy()
    expect(screen.getByText(/Nguồn: Ordering food/)).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
  it('soạn bài lỗi: thông báo + thử lại, và chỉ gọi soạn bài đúng 1 lần cho tới khi bấm thử lại', async () => {
    const s = server({
      'GET /sessions/1': [session({ material: { ...withOptions.material, chosen: 0 } }), session({ material: { ...withOptions.material, chosen: 0 }, lesson: LESSON })],
      'POST /sessions/1/compose': [
        { status: 503, body: { error: 'ai_unavailable', kind: 'timeout', retryable: true, message: 'AI phản hồi quá lâu. Hãy thử lại.' } },
        { body: { lesson: LESSON } },
      ],
    })
    mount()
    expect(await screen.findByText(/AI phản hồi quá lâu/)).toBeTruthy()
    expect(s.calls('POST /sessions/1/compose')).toBe(1) // không tự lặp vô hạn
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Tóm tắt bài.')).toBeTruthy()
    expect(s.calls('POST /sessions/1/compose')).toBe(2)
  })
  it('fallback: báo AI tự viết bài, soạn tự động; bài hiện nhãn "do AI viết" kèm lý do', async () => {
    const ai = { ...LESSON, source: { type: 'ai', title: 'Bài đọc do AI viết', ai_written: true }, notice_vi: 'Không tìm được tài liệu.' }
    server({
      'GET /sessions/1': [session({ material: { options: [], chosen: -1, fallback: true } }), session({ material: { options: [], chosen: -1, fallback: true }, lesson: ai })],
      'POST /sessions/1/compose': [{ body: { lesson: ai } }],
    })
    mount()
    expect(await screen.findByText('Bài đọc do AI viết.')).toBeTruthy()
    expect(screen.getByText(/Không tìm được tài liệu\./)).toBeTruthy()
  })
  it('chọn tài liệu bị khóa (409): hiện thông báo, không có nút thử lại', async () => {
    server({
      'GET /sessions/1': [session(withOptions)],
      'POST /sessions/1/choose': [{ status: 409, body: { error: 'locked', message: 'Đã chọn tài liệu cho buổi này, không đổi được giữa buổi.', retryable: false } }],
    })
    mount()
    fireEvent.click((await screen.findAllByText('Chọn tài liệu này'))[0])
    expect(await screen.findByText(/không đổi được giữa buổi\./)).toBeTruthy()
  })
  it('lời nhắc: sau khi chọn sẽ không đổi được', async () => {
    server({ 'GET /sessions/1': [session(withOptions)] })
    mount()
    expect(await screen.findByText(/Sau khi chọn sẽ không đổi được giữa buổi/)).toBeTruthy()
  })
  it('tải buổi học lỗi → thông báo + thử lại', async () => {
    server({ 'GET /sessions/1': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, session({})] })
    mount()
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Bắt đầu buổi học')).toBeTruthy()
  })
})

describe('trang buổi học: fallback AI tự viết bài', () => {
  const fb = (reason?: 'no_results' | 'search_error') => ({ material: { options: [], chosen: -1, fallback: true, ...(reason ? { fallback_reason: reason } : {}) } })
  it('không tìm được tài liệu: báo rõ lý do và tự soạn', async () => {
    server({ 'GET /sessions/1': [session(fb('no_results'))], 'POST /sessions/1/compose': [() => new Promise(() => {})] })
    mount()
    expect(await screen.findByText('Không tìm được tài liệu phù hợp, AI sẽ tự viết bài đọc cho buổi này.')).toBeTruthy()
    expect(await screen.findByRole('progressbar')).toBeTruthy()
  })
  it('tìm kiếm lỗi: báo lý do khác', async () => {
    server({ 'GET /sessions/1': [session(fb('search_error'))], 'POST /sessions/1/compose': [() => new Promise(() => {})] })
    mount()
    expect(await screen.findByText('Bước tìm tài liệu gặp lỗi, AI sẽ tự viết bài đọc cho buổi này.')).toBeTruthy()
  })
  it('bài do AI viết luôn hiện nhãn "Bài đọc do AI viết", không có link nguồn giả', async () => {
    const ai = { ...LESSON, source: { type: 'ai', title: 'Bài đọc do AI viết', ai_written: true }, notice_vi: 'Bước tìm tài liệu gặp lỗi nên AI tự viết bài đọc.' }
    server({ 'GET /sessions/1': [session({ ...fb('search_error'), lesson: ai })] })
    mount()
    expect(await screen.findByText('Bài đọc do AI viết.')).toBeTruthy()
    expect(screen.getByText(/Bước tìm tài liệu gặp lỗi nên AI tự viết bài đọc\./)).toBeTruthy()
    expect(screen.queryByText(/Nguồn:/)).toBeNull()
  })
  it('bài có tài liệu thật thì không hiện nhãn AI viết, có link nguồn', async () => {
    server({ 'GET /sessions/1': [session({ material: { options: OPTIONS, chosen: 0, fallback: false }, lesson: LESSON })] })
    mount()
    expect(await screen.findByText(/Nguồn: Ordering food/)).toBeTruthy()
    expect(screen.queryByText('Bài đọc do AI viết.')).toBeNull()
  })
  it('AI từ chối khi viết bài: thông báo + thử lại', async () => {
    server({
      'GET /sessions/1': [session(fb('no_results')), session({ ...fb('no_results'), lesson: { ...LESSON, source: { type: 'ai', title: 'Bài đọc do AI viết', ai_written: true } } })],
      'POST /sessions/1/compose': [
        { status: 503, body: { error: 'ai_unavailable', kind: 'rate', retryable: true, message: 'AI đang từ chối yêu cầu hoặc đã hết hạn mức. Hãy thử lại sau ít phút.' } },
        { body: { lesson: LESSON } },
      ],
    })
    mount()
    expect(await screen.findByText(/AI đang từ chối yêu cầu/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Bài đọc do AI viết.')).toBeTruthy()
  })
})

describe('trang buổi học: tài liệu người học tải lên', () => {
  const FILE_OPT = { type: 'upload', upload_id: 7, title: 'My story', url: '', why_vi: 'Tài liệu bạn đã tải lên.', excerpt: 'Chapter one begins here.' }
  const LINK_OPT = { type: 'upload', upload_id: 8, title: 'Trang của tôi', url: 'https://mysite.example.com/page', why_vi: 'Tài liệu bạn đã tải lên.', excerpt: 'A quote.' }
  const material = (...opts: unknown[]) => ({ material: { options: opts, chosen: null, fallback: false } })

  it('hiện nhãn "Tài liệu của bạn" cho lựa chọn tải lên, lẫn với tài liệu AI tìm', async () => {
    server({ 'GET /sessions/1': [session(material(OPTIONS[0], OPTIONS[1], FILE_OPT))] })
    mount()
    expect(await screen.findByText('📎 Tài liệu của bạn')).toBeTruthy()
    expect(screen.getByText('My story')).toBeTruthy()
    expect(screen.getAllByText('Chọn tài liệu này')).toHaveLength(3)
  })
  it('file tải lên không có link "Xem trước"; link tải lên và tài liệu AI thì có', async () => {
    server({ 'GET /sessions/1': [session(material(FILE_OPT))] })
    mount()
    await screen.findByText('My story')
    expect(screen.queryByText(/Xem trước/)).toBeNull()
    cleanup()
    server({ 'GET /sessions/1': [session(material(LINK_OPT, OPTIONS[0]))] })
    mount()
    await screen.findByText('Trang của tôi')
    expect(screen.getAllByText(/Xem trước/)).toHaveLength(2)
  })
  it('chọn tài liệu tải lên → gửi đúng chỉ số', async () => {
    const s = server({
      'GET /sessions/1': [session(material(OPTIONS[0], FILE_OPT)), session({ material: { options: [OPTIONS[0], FILE_OPT], chosen: 1, fallback: false } })],
      'POST /sessions/1/choose': [{ body: {} }],
      'POST /sessions/1/compose': [() => new Promise(() => {})],
    })
    mount()
    fireEvent.click((await screen.findAllByText('Chọn tài liệu này'))[1])
    await waitFor(() => expect(s.calls('POST /sessions/1/choose')).toBe(1))
    expect(JSON.parse((s.f.mock.calls.find((c) => String(c[0]).endsWith('/choose'))![1] as RequestInit).body as string)).toEqual({ index: 1 })
  })
  it('bài từ tài liệu tải lên: hiện tên tài liệu, không có nhãn "do AI viết"', async () => {
    const lesson = { ...LESSON, source: { type: 'upload', title: 'My story', ai_written: false, upload_id: 7 } }
    server({ 'GET /sessions/1': [session({ material: { options: [FILE_OPT], chosen: 0, fallback: false }, lesson })] })
    mount()
    expect(await screen.findByText('Tóm tắt bài.')).toBeTruthy()
    expect(screen.queryByText('Bài đọc do AI viết.')).toBeNull()
    expect(screen.queryByText(/Nguồn:/)).toBeNull() // file không có link nguồn
    expect(screen.getByText('My story')).toBeTruthy()
  })
})
