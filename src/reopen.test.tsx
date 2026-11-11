// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Roadmap from './pages/Roadmap'
import SessionPage from './pages/Session'

const LESSON = {
  title: 'Ordering food',
  source: { type: 'article', url: 'https://example.com/a', title: 'Ordering food', ai_written: false },
  excerpt: 'Can I have a coffee?', summary_vi: 'Tóm tắt bài cũ.', explanation_vi: 'Giải thích bài cũ.',
  vocab: [{ word: 'order', pos: 'verb', meaning_vi: 'gọi món', example: 'I order tea.' }],
  grammar: [{ point: 'Can I have ...?', explanation_vi: 'Câu xin phép.', example: 'Can I have water?' }],
}
const MATERIAL = { options: [{ type: 'article', title: 'Ordering food', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }], chosen: 0, fallback: false }
const CHAT = [
  { id: 1, role: 'user', content: 'I go to market yesterday', created_at: '2026-11-11T08:00:00.000Z', correction: { has_errors: true, corrected: 'I went to the market yesterday.', issues: [{ original: 'I go', fixed: 'I went', explanation_vi: 'Thì quá khứ đơn.' }] } },
  { id: 2, role: 'assistant', content: 'Nice! What did you buy?', created_at: '2026-11-11T08:00:00.000Z' },
]
const sess = (id: number, seq: number, status: string, score: number | null) => ({ id, week_no: 1, seq, scheduled_date: '2026-11-1' + seq, status, score })
const PLAN = {
  plan: { id: 1, level: 'A1', start_date: '2026-11-10', end_date: '2026-12-01', original_end_date: '2026-12-01', done: 2, total: 5, current_week: 1, finished: false, extension_weeks: 0, review: null, pending_adjustments: 0, today: '2026-11-13' },
  weeks: [{ week_no: 1, topic: 'Food', goal_vi: 'Đồ ăn', done: 2, total: 5, sessions: [sess(11, 1, 'done', 90), sess(12, 2, 'done', 55), sess(13, 3, 'pending', null), sess(14, 4, 'pending', null), sess(15, 5, 'missed', null)] }],
}

let calls: string[]
function server(routes: Record<string, unknown>) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
      calls.push(key)
      return key in routes ? Response.json(routes[key] as object) : Response.json({ message: 'không có route ' + key }, { status: 404 })
    }),
  )
}
const oldSession = (over: Record<string, unknown> = {}) => ({
  session: { id: 11, seq: 1, week_no: 1, topic: 'Food', scheduled_date: '2026-11-11', status: 'done', score: 90, completed_date: '2026-11-11', material: MATERIAL, lesson: LESSON, ...over },
})

const app = () => (
  <MemoryRouter initialEntries={['/roadmap']}>
    <Routes>
      <Route path="/roadmap" element={<Roadmap />} />
      <Route path="/session/:id" element={<SessionPage />} />
    </Routes>
  </MemoryRouter>
)

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('lộ trình: buổi đã xong mở lại được', () => {
  it('buổi đã xong là liên kết "Xem lại" kèm điểm; buổi tiếp theo là "Học ngay"; buổi chưa tới/bị lỡ không phải liên kết', async () => {
    server({ 'GET /plan': PLAN })
    render(app())
    await screen.findByText('Food')
    const hrefs = [...document.querySelectorAll('li a')].map((a) => [a.getAttribute('href'), a.textContent])
    expect(hrefs).toEqual([
      ['/session/11', expect.stringContaining('90% · Xem lại')],
      ['/session/12', expect.stringContaining('55% · Xem lại')],
      ['/session/13', expect.stringContaining('Học ngay')],
    ])
    expect(screen.getByLabelText('Buổi 4: Chưa học').querySelector('a')).toBeNull()
    expect(screen.getByLabelText('Buổi 5: Bị lỡ').querySelector('a')).toBeNull()
  })

  it('bấm buổi đã xong → mở trang buổi đó, thấy bài và hội thoại cũ', async () => {
    server({ 'GET /plan': PLAN, 'GET /sessions/11': oldSession(), 'GET /sessions/11/chat': { messages: CHAT } })
    render(app())
    fireEvent.click(await screen.findByText(/90% · Xem lại/))
    expect(await screen.findByText('Tóm tắt bài cũ.')).toBeTruthy()
    expect(await screen.findByText('I go to market yesterday')).toBeTruthy()
    expect(screen.getByText('Nice! What did you buy?')).toBeTruthy()
  })
})

describe('mở lại buổi đã xong', () => {
  const open = () =>
    render(
      <MemoryRouter initialEntries={['/session/11']}>
        <Routes>
          <Route path="/session/:id" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>,
    )

  it('hiện đủ bài học đã soạn: nguồn, tóm tắt, giải thích, từ vựng, ngữ pháp', async () => {
    server({ 'GET /sessions/11': oldSession(), 'GET /sessions/11/chat': { messages: [] } })
    open()
    expect(await screen.findByText('Tóm tắt bài cũ.')).toBeTruthy()
    expect(screen.getByText('Giải thích bài cũ.')).toBeTruthy()
    expect(screen.getByText('order')).toBeTruthy()
    expect(screen.getByText(/Can I have \.\.\.\?/)).toBeTruthy()
    expect(screen.getByText(/Nguồn: Ordering food/)).toBeTruthy()
  })

  it('hội thoại cũ hiện đầy đủ, kèm phần AI đã sửa lỗi và giải thích tiếng Việt', async () => {
    server({ 'GET /sessions/11': oldSession(), 'GET /sessions/11/chat': { messages: CHAT } })
    open()
    const fix = await screen.findByLabelText('Sửa lỗi')
    expect(fix.textContent).toContain('Câu đúng: I went to the market yesterday.')
    expect(fix.textContent).toContain('Thì quá khứ đơn.')
    expect([...document.querySelectorAll('[data-role]')].map((e) => e.textContent)).toEqual(['I go to market yesterday', 'Nice! What did you buy?'])
  })

  it('chỉ xem: không có ô nhập/nút Gửi, có ghi chú buổi đã xong', async () => {
    server({ 'GET /sessions/11': oldSession(), 'GET /sessions/11/chat': { messages: CHAT } })
    open()
    await screen.findByText('Tóm tắt bài cũ.')
    expect(screen.queryByLabelText('Tin nhắn')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Gửi' })).toBeNull()
    expect(screen.getByText(/Buổi học đã xong\. Đây là lịch sử hội thoại\./)).toBeTruthy()
  })

  it('không kích hoạt lại gì: không tìm tài liệu, không chọn, không soạn bài, không gửi chat', async () => {
    server({ 'GET /sessions/11': oldSession(), 'GET /sessions/11/chat': { messages: CHAT } })
    open()
    await screen.findByText('Tóm tắt bài cũ.')
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([])
    expect(screen.queryByText('Bắt đầu buổi học')).toBeNull()
    expect(screen.queryByText('Chọn tài liệu này')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('buổi cũ không có hội thoại nào → báo rõ', async () => {
    server({ 'GET /sessions/11': oldSession(), 'GET /sessions/11/chat': { messages: [] } })
    open()
    expect(await screen.findByText('Không có hội thoại nào trong buổi này.')).toBeTruthy()
  })

  it('buổi cũ dùng bài AI viết vẫn hiện nhãn "do AI viết"', async () => {
    const ai = { ...LESSON, source: { type: 'ai', title: 'Bài đọc do AI viết', ai_written: true }, notice_vi: 'Không tìm được tài liệu phù hợp nên AI tự viết bài đọc.' }
    server({ 'GET /sessions/11': oldSession({ lesson: ai, material: { options: [], chosen: -1, fallback: true, fallback_reason: 'no_results' } }), 'GET /sessions/11/chat': { messages: [] } })
    open()
    expect(await screen.findByText('Bài đọc do AI viết.')).toBeTruthy()
  })

  it('buổi chưa xong (đang học) vẫn có ô nhập chat — khác với buổi đã xong', async () => {
    server({ 'GET /sessions/11': oldSession({ status: 'pending', score: null, completed_date: null }), 'GET /sessions/11/chat': { messages: [] } })
    open()
    expect(await screen.findByLabelText('Tin nhắn')).toBeTruthy()
  })
})
