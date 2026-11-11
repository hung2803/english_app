// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Chat, { MAX_MESSAGE_CHARS } from './components/Chat'

type Resp = { status?: number; body: unknown } | (() => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown })
function server(routes: Record<string, Resp | Resp[]>) {
  const calls: { key: string; body?: any }[] = []
  const counts: Record<string, number> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
      calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined })
      const h = routes[key]
      if (!h) return Response.json({ message: 'không có route ' + key }, { status: 404 })
      const list = Array.isArray(h) ? h : [h]
      const one = list[Math.min(counts[key] ?? 0, list.length - 1)]
      counts[key] = (counts[key] ?? 0) + 1
      const r = typeof one === 'function' ? await one() : one
      return Response.json(r.body, { status: r.status ?? 200 })
    }),
  )
  return { calls, count: (k: string) => calls.filter((c) => c.key === k).length }
}
const M = (id: number, role: 'user' | 'assistant', content: string) => ({ id, role, content, created_at: '2026-11-11T08:00:00.000Z' })
const aiDown = { status: 503, body: { error: 'ai_unavailable', kind: 'rate', retryable: true, message: 'AI đang từ chối yêu cầu hoặc đã hết hạn mức. Hãy thử lại sau ít phút.' } }

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const box = () => screen.getByLabelText('Tin nhắn') as HTMLTextAreaElement
const sendBtn = () => screen.getByRole('button', { name: /^(Gửi|Đang gửi…)$/ }) as HTMLButtonElement

describe('Chat — hiển thị', () => {
  it('chưa có hội thoại: gợi ý cách bắt đầu', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [] } } })
    render(<Chat sessionId={1} />)
    expect(await screen.findByText(/Hãy viết một câu tiếng Anh để bắt đầu/)).toBeTruthy()
  })
  it('hiện lịch sử: tin của người học và của AI, phân biệt được vai', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [M(1, 'user', 'Hello!'), M(2, 'assistant', 'Hi! What is your name?')] } } })
    render(<Chat sessionId={1} />)
    const mine = await screen.findByText('Hello!')
    expect(mine.getAttribute('data-role')).toBe('user')
    expect(screen.getByText('Hi! What is your name?').getAttribute('data-role')).toBe('assistant')
  })
  it('tải lịch sử lỗi → thông báo + thử lại', async () => {
    server({ 'GET /sessions/1/chat': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, { body: { messages: [M(1, 'user', 'Hello!')] } }] })
    render(<Chat sessionId={1} />)
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Hello!')).toBeTruthy()
  })
  it('buổi đã xong (readOnly): chỉ xem lịch sử, không có ô nhập', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [M(1, 'user', 'Hello!')] } } })
    render(<Chat sessionId={1} readOnly />)
    expect(await screen.findByText('Hello!')).toBeTruthy()
    expect(screen.queryByLabelText('Tin nhắn')).toBeNull()
    expect(screen.getByText(/Buổi học đã xong/)).toBeTruthy()
  })
  it('readOnly và không có hội thoại → báo không có', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [] } } })
    render(<Chat sessionId={1} readOnly />)
    expect(await screen.findByText('Không có hội thoại nào trong buổi này.')).toBeTruthy()
  })
})

describe('Chat — gửi tin nhắn', () => {
  const ok = () => server({
    'GET /sessions/1/chat': { body: { messages: [] } },
    'POST /sessions/1/chat': { body: { user: M(1, 'user', 'I like coffee.'), assistant: M(2, 'assistant', 'Nice! Do you drink it every day?') } },
  })

  it('nút Gửi bị khóa khi ô trống hoặc chỉ có khoảng trắng', async () => {
    ok()
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    expect(sendBtn().disabled).toBe(true)
    fireEvent.change(box(), { target: { value: '   ' } })
    expect(sendBtn().disabled).toBe(true)
    fireEvent.change(box(), { target: { value: 'hi' } })
    expect(sendBtn().disabled).toBe(false)
  })

  it('gửi → hiện tin của mình + câu trả lời của AI, xóa ô nhập, gửi đúng nội dung đã cắt khoảng trắng', async () => {
    const s = ok()
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: '  I like coffee.  ' } })
    fireEvent.click(sendBtn())
    expect(await screen.findByText('Nice! Do you drink it every day?')).toBeTruthy()
    expect(screen.getByText('I like coffee.')).toBeTruthy()
    expect(box().value).toBe('')
    expect(s.calls.find((c) => c.key === 'POST /sessions/1/chat')!.body).toEqual({ message: 'I like coffee.' })
    expect(screen.queryByText(/Hãy viết một câu tiếng Anh để bắt đầu/)).toBeNull()
  })

  it('đang chờ AI: hiện "AI đang trả lời…", khóa ô nhập và nút (không gửi trùng)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const s = server({
      'GET /sessions/1/chat': { body: { messages: [] } },
      'POST /sessions/1/chat': async () => { await gate; return { body: { user: M(1, 'user', 'hi'), assistant: M(2, 'assistant', 'Hello!') } } },
    })
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: 'hi' } })
    fireEvent.click(sendBtn())
    expect(await screen.findByText('AI đang trả lời…')).toBeTruthy()
    expect(box().disabled).toBe(true)
    expect(sendBtn().disabled).toBe(true)
    fireEvent.click(sendBtn())
    fireEvent.submit(screen.getByRole('form', { name: 'Gửi tin nhắn' }))
    expect(s.count('POST /sessions/1/chat')).toBe(1)
    await act(async () => release())
    expect(await screen.findByText('Hello!')).toBeTruthy()
    expect(screen.queryByText('AI đang trả lời…')).toBeNull()
  })

  it('Enter gửi tin; Shift+Enter không gửi', async () => {
    const s = ok()
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: 'I like coffee.' } })
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    expect(s.count('POST /sessions/1/chat')).toBe(0)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Nice! Do you drink it every day?')).toBeTruthy()
    expect(s.count('POST /sessions/1/chat')).toBe(1)
  })

  it('AI từ chối: thông báo tiếng Việt, GIỮ NGUYÊN chữ đã gõ, không hiện tin dở; thử lại thành công', async () => {
    const s = server({
      'GET /sessions/1/chat': { body: { messages: [] } },
      'POST /sessions/1/chat': [aiDown, { body: { user: M(1, 'user', 'I like coffee.'), assistant: M(2, 'assistant', 'Nice!') } }],
    })
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: 'I like coffee.' } })
    fireEvent.click(sendBtn())
    expect(await screen.findByText(/AI đang từ chối yêu cầu/)).toBeTruthy()
    expect(box().value).toBe('I like coffee.')
    expect(screen.queryByText('I like coffee.', { selector: 'p' })).toBeNull() // chưa hiện như tin đã gửi
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Nice!')).toBeTruthy()
    expect(s.count('POST /sessions/1/chat')).toBe(2)
    expect(box().value).toBe('')
    expect(screen.queryByText(/AI đang từ chối yêu cầu/)).toBeNull()
  })

  it('lỗi không thể thử lại (thiếu khóa API): có thông báo nhưng không có nút Thử lại', async () => {
    server({
      'GET /sessions/1/chat': { body: { messages: [] } },
      'POST /sessions/1/chat': { status: 503, body: { error: 'ai_unavailable', kind: 'config', retryable: false, message: 'Chưa cấu hình đúng khóa Gemini (GEMINI_API_KEY).' } },
    })
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: 'hi' } })
    fireEvent.click(sendBtn())
    expect(await screen.findByText(/Chưa cấu hình đúng khóa Gemini/)).toBeTruthy()
    expect(screen.queryByText('Thử lại')).toBeNull()
  })

  it('quá 40 giây không phản hồi → báo quá lâu, giữ chữ đã gõ', async () => {
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
      if (init?.method !== 'POST') return Promise.resolve(Response.json({ messages: [] }))
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('t', 'TimeoutError'))))
    }))
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: 'hi' } })
    fireEvent.click(sendBtn())
    await screen.findByText('AI đang trả lời…')
    await act(async () => void vi.advanceTimersByTime(41_000))
    expect(await screen.findByText(/phản hồi quá lâu/)).toBeTruthy()
    expect(box().value).toBe('hi')
  })

  it('buổi đã xong giữa chừng (409): hiện thông báo của server', async () => {
    server({
      'GET /sessions/1/chat': { body: { messages: [] } },
      'POST /sessions/1/chat': { status: 409, body: { error: 'done', message: 'Buổi học này đã xong, không chat thêm được.', retryable: false } },
    })
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: 'hi' } })
    fireEvent.click(sendBtn())
    expect(await screen.findByText('Buổi học này đã xong, không chat thêm được.')).toBeTruthy()
  })
})

describe('Chat — giới hạn độ dài', () => {
  it(`đếm ký tự; quá ${MAX_MESSAGE_CHARS} thì báo đỏ và khóa nút Gửi`, async () => {
    const s = server({ 'GET /sessions/1/chat': { body: { messages: [] } } })
    render(<Chat sessionId={1} />)
    await screen.findByLabelText('Tin nhắn')
    fireEvent.change(box(), { target: { value: 'a'.repeat(MAX_MESSAGE_CHARS) } })
    expect(screen.getByText(`${MAX_MESSAGE_CHARS}/${MAX_MESSAGE_CHARS}`).className).not.toMatch(/rose/)
    expect(sendBtn().disabled).toBe(false)
    fireEvent.change(box(), { target: { value: 'a'.repeat(MAX_MESSAGE_CHARS + 1) } })
    expect(screen.getByText(`${MAX_MESSAGE_CHARS + 1}/${MAX_MESSAGE_CHARS}`).className).toMatch(/rose/)
    expect(sendBtn().disabled).toBe(true)
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(s.count('POST /sessions/1/chat')).toBe(0))
  })
})

describe('Chat — hiển thị sửa lỗi', () => {
  const FIX = {
    has_errors: true,
    corrected: 'I went to the market yesterday.',
    issues: [{ original: 'I go to the market yesterday', fixed: 'I went to the market yesterday', explanation_vi: 'Có "yesterday" nên dùng thì quá khứ đơn: go → went.' }],
  }
  const withCorrection = (c: unknown) => ({ id: 1, role: 'user', content: 'I go to the market yesterday', created_at: '2026-11-11T08:00:00.000Z', correction: c })

  it('câu có lỗi: hiện câu đã sửa và từng lỗi kèm giải thích tiếng Việt', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [withCorrection(FIX), M(2, 'assistant', 'Nice!')] } } })
    render(<Chat sessionId={1} />)
    const box = await screen.findByLabelText('Sửa lỗi')
    expect(box.textContent).toContain('Câu đúng: I went to the market yesterday.')
    expect(box.textContent).toContain('I go to the market yesterday')
    expect(box.textContent).toContain('Có "yesterday" nên dùng thì quá khứ đơn')
  })
  it('lỗi cũ (original) được gạch ngang, bản sửa (fixed) nổi bật', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [withCorrection(FIX)] } } })
    render(<Chat sessionId={1} />)
    const box = await screen.findByLabelText('Sửa lỗi')
    const struck = box.querySelector('.line-through')!
    expect(struck.textContent).toBe('I go to the market yesterday')
    expect(box.querySelector('.font-medium')!.textContent).toBe('I went to the market yesterday')
  })
  it('nhiều lỗi: hiện đủ, theo thứ tự', async () => {
    const many = { has_errors: true, corrected: 'She likes tea.', issues: [
      { original: 'She like', fixed: 'She likes', explanation_vi: 'Thêm -s ngôi thứ ba.' },
      { original: 'teas', fixed: 'tea', explanation_vi: 'Danh từ không đếm được.' },
    ] }
    server({ 'GET /sessions/1/chat': { body: { messages: [withCorrection(many)] } } })
    render(<Chat sessionId={1} />)
    const box = await screen.findByLabelText('Sửa lỗi')
    expect(box.querySelectorAll('li')).toHaveLength(2)
    expect(box.querySelectorAll('li')[0].textContent).toContain('Thêm -s ngôi thứ ba.')
  })
  it('câu đúng: hiện lời khen, không có khung sửa lỗi', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [withCorrection({ has_errors: false, corrected: '', issues: [] })] } } })
    render(<Chat sessionId={1} />)
    expect(await screen.findByText(/Câu của bạn đúng/)).toBeTruthy()
    expect(screen.queryByLabelText('Sửa lỗi')).toBeNull()
  })
  it('chưa chấm được (correction null) hoặc tin của AI: không hiện gì thêm', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [withCorrection(null), M(2, 'assistant', 'Hi!')] } } })
    render(<Chat sessionId={1} />)
    await screen.findByText('Hi!')
    expect(screen.queryByLabelText('Sửa lỗi')).toBeNull()
    expect(screen.queryByText(/Câu của bạn đúng/)).toBeNull()
  })
  it('gửi tin mới: phần sửa lỗi hiện ngay cùng câu trả lời của AI', async () => {
    server({
      'GET /sessions/1/chat': { body: { messages: [] } },
      'POST /sessions/1/chat': { body: { user: { ...withCorrection(FIX) }, assistant: M(2, 'assistant', 'Nice! What did you buy?') } },
    })
    render(<Chat sessionId={1} />)
    fireEvent.change(await screen.findByLabelText('Tin nhắn'), { target: { value: 'I go to the market yesterday' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }))
    expect(await screen.findByLabelText('Sửa lỗi')).toBeTruthy()
    expect(screen.getByText('Nice! What did you buy?')).toBeTruthy()
  })
  it('buổi đã xong (chỉ xem): vẫn thấy phần sửa lỗi của các tin cũ', async () => {
    server({ 'GET /sessions/1/chat': { body: { messages: [withCorrection(FIX)] } } })
    render(<Chat sessionId={1} readOnly />)
    expect(await screen.findByLabelText('Sửa lỗi')).toBeTruthy()
  })
  it('nội dung do AI sinh ra được hiển thị như chữ thường, không chạy HTML', async () => {
    const evil = { has_errors: true, corrected: '<img src=x onerror=alert(1)>', issues: [{ original: '<b>x</b>', fixed: '<script>y</script>', explanation_vi: '<i>z</i>' }] }
    server({ 'GET /sessions/1/chat': { body: { messages: [withCorrection(evil)] } } })
    render(<Chat sessionId={1} />)
    const box = await screen.findByLabelText('Sửa lỗi')
    expect(box.querySelector('img, script, b, i')).toBeNull()
    expect(box.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('Chat — lịch sử được giữ khi mở lại buổi', () => {
  it('rời đi rồi quay lại: hội thoại cũ được tải lại từ máy chủ, đúng thứ tự', async () => {
    const msgs = [M(1, 'user', 'Hello!'), M(2, 'assistant', 'Hi! Name?'), M(3, 'user', 'I am An.'), M(4, 'assistant', 'Nice, An!')]
    const s = server({ 'GET /sessions/1/chat': { body: { messages: msgs } } })
    const first = render(<Chat sessionId={1} />)
    expect(await screen.findByText('Nice, An!')).toBeTruthy()
    first.unmount()
    render(<Chat sessionId={1} />)
    expect(await screen.findByText('Nice, An!')).toBeTruthy()
    expect(s.count('GET /sessions/1/chat')).toBe(2)
    const bubbles = [...document.querySelectorAll('[data-role]')].map((e) => e.textContent)
    expect(bubbles).toEqual(['Hello!', 'Hi! Name?', 'I am An.', 'Nice, An!'])
  })
  it('đổi sang buổi khác: tải hội thoại của buổi đó, không lẫn', async () => {
    server({
      'GET /sessions/1/chat': { body: { messages: [M(1, 'user', 'session one')] } },
      'GET /sessions/2/chat': { body: { messages: [M(9, 'user', 'session two')] } },
    })
    const { rerender } = render(<Chat sessionId={1} />)
    expect(await screen.findByText('session one')).toBeTruthy()
    rerender(<Chat sessionId={2} />)
    expect(await screen.findByText('session two')).toBeTruthy()
  })
})
