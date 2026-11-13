// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Roadmap from './pages/Roadmap'

type Resp = { status?: number; body: unknown }
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
      const r = list[Math.min(counts[key] ?? 0, list.length - 1)]
      counts[key] = (counts[key] ?? 0) + 1
      return Response.json(r.body, { status: r.status ?? 200 })
    }),
  )
  return { count: (k: string) => calls.filter((c) => c.key === k).length, last: (k: string) => calls.filter((c) => c.key === k).at(-1)?.body }
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const NO_PLAN = (placement_level: string | null) => ({ body: { plan: null, has_placement: placement_level !== null, placement_level } })
const mount = () => render(<MemoryRouter><Roadmap /></MemoryRouter>)
const select = () => screen.getByLabelText('Mức bắt đầu') as HTMLSelectElement
const textarea = () => screen.getByPlaceholderText(/Greetings/) as HTMLTextAreaElement
const create = () => screen.getByRole('button', { name: /Tạo lộ trình|Đang tạo lộ trình/ }) as HTMLButtonElement

describe('Lộ trình — tạo lộ trình đầu tiên', () => {
  it('chưa làm bài kiểm tra: vẫn tạo được bằng cách chọn mức, mặc định "Mới bắt đầu (A0)", có link làm bài kiểm tra', async () => {
    const s = server({ 'GET /plan': [NO_PLAN(null), NO_PLAN(null)], 'POST /plan': { body: { source: 'ai' } } })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    expect(select().value).toBe('A0')
    expect(screen.queryByText(/Theo bài kiểm tra của tôi/)).toBeNull()
    expect(screen.getByText('Làm bài kiểm tra trình độ')).toBeTruthy()
    fireEvent.click(create())
    await waitFor(() => expect(s.count('POST /plan')).toBe(1))
    expect(s.last('POST /plan')).toEqual({ level: 'A0' })
  })

  it('đã có bài kiểm tra: mặc định "Theo bài kiểm tra" (không gửi level), vẫn chọn được mức khác', async () => {
    const s = server({ 'GET /plan': NO_PLAN('B1'), 'POST /plan': { body: { source: 'ai' } } })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    expect(select().value).toBe('')
    expect(screen.getByText('Theo bài kiểm tra của tôi (B1)')).toBeTruthy()
    fireEvent.click(create())
    await waitFor(() => expect(s.count('POST /plan')).toBe(1))
    expect(s.last('POST /plan')).toEqual({})
  })

  it('người mới bắt đầu chọn A0 dù bài kiểm tra ra B1 → gửi level A0', async () => {
    const s = server({ 'GET /plan': NO_PLAN('B1'), 'POST /plan': { body: { source: 'ai' } } })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    fireEvent.change(select(), { target: { value: 'A0' } })
    fireEvent.click(create())
    await waitFor(() => expect(s.count('POST /plan')).toBe(1))
    expect(s.last('POST /plan')).toEqual({ level: 'A0' })
  })

  it('lộ trình riêng: gửi nguyên văn bản; đếm số tuần và báo AI sẽ nối thêm', async () => {
    const s = server({
      'GET /plan': NO_PLAN(null),
      'POST /plan/preview': { body: { weeks: [{ topic: 'Greetings', goal_vi: 'Chào hỏi' }, { topic: 'Numbers', goal_vi: '' }, { topic: 'Food', goal_vi: '' }], to_fill: 9 } },
      'POST /plan': { body: { source: 'custom', filled_weeks: 9 } },
    })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    expect(screen.queryByText(/AI sẽ nối thêm/)).toBeNull()
    fireEvent.change(textarea(), { target: { value: 'Greetings | Chào hỏi\n\nNumbers\nFood' } })
    expect(await screen.findByText(/3 tuần — AI sẽ nối thêm 9 tuần/)).toBeTruthy()
    fireEvent.click(create())
    await waitFor(() => expect(s.count('POST /plan')).toBe(1))
    expect(s.last('POST /plan')).toEqual({ level: 'A0', custom: 'Greetings | Chào hỏi\n\nNumbers\nFood' })
  })

  it('xem trước báo không đọc được/quá 12 tuần: hiện lý do và khóa nút tạo; sửa lại thì mở lại', async () => {
    server({
      'GET /plan': NO_PLAN(null),
      'POST /plan/preview': [{ status: 400, body: { error: 'bad_custom', message: 'Chỉ nhận tối đa 12 tuần (tìm thấy 13).' } }, { body: { weeks: [{ topic: 'T', goal_vi: 'x' }], to_fill: 11 } }],
    })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    fireEvent.change(textarea(), { target: { value: 'quá nhiều' } })
    expect((await screen.findByRole('alert')).textContent).toContain('tìm thấy 13')
    expect(create().disabled).toBe(true)
    fireEvent.change(textarea(), { target: { value: 'T' } })
    expect(await screen.findByText(/Đọc được 1 tuần/)).toBeTruthy()
    expect(create().disabled).toBe(false)
  })

  it('lỗi từ máy chủ (400 lộ trình riêng không hợp lệ): hiện thông báo, giữ nguyên nội dung đã nhập, thử lại được', async () => {
    const s = server({
      'GET /plan': NO_PLAN(null),
      'POST /plan': [{ status: 400, body: { error: 'bad_custom', message: 'Chủ đề quá dài.' } }, { body: { source: 'custom', filled_weeks: 11 } }],
    })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    fireEvent.change(textarea(), { target: { value: 'Only one' } })
    fireEvent.click(create())
    expect(await screen.findByText(/Chủ đề quá dài/)).toBeTruthy()
    expect(textarea().value).toBe('Only one')
    fireEvent.click(screen.getByText('Thử lại'))
    await waitFor(() => expect(s.count('POST /plan')).toBe(2))
  })

  it('tạo xong: tải lại lộ trình và báo số tuần AI nối thêm', async () => {
    const PLAN = {
      body: {
        plan: { level: 'A0', start_date: '2026-11-16', end_date: '2027-02-05', original_end_date: '2027-02-05', done: 0, total: 60, current_week: 1, finished: false, extension_weeks: 0, pending_adjustments: 0, review: null, today: '2026-11-16' },
        weeks: [{ week_no: 1, topic: 'Mine 1', goal_vi: 'Học theo lộ trình của bạn', done: 0, total: 5, sessions: [] }],
      },
    }
    server({ 'GET /plan': [NO_PLAN(null), PLAN], 'POST /plan': { body: { source: 'custom', filled_weeks: 11 } } })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    fireEvent.change(textarea(), { target: { value: 'Mine 1' } })
    fireEvent.click(create())
    expect(await screen.findByText('Mine 1')).toBeTruthy()
    expect(screen.getByText(/11 tuần cuối được nối thêm cho đủ 12 tuần/)).toBeTruthy()
  })

  it('AI lỗi nên dùng bộ mặc định: báo lý do', async () => {
    server({ 'GET /plan': [NO_PLAN(null), { body: { plan: null, has_placement: false, placement_level: null } }], 'POST /plan': { body: { source: 'default', fallback_reason: 'rate' } } })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    fireEvent.click(create())
    await waitFor(() => expect(screen.queryByText(/Đang tạo lộ trình/)).toBeNull())
  })
})

describe('Lộ trình — tạo lại khi đã có lộ trình', () => {
  const PLAN = (finished = false) => ({
    body: {
      plan: { level: 'B1', start_date: '2026-11-16', end_date: '2027-02-05', original_end_date: '2027-02-05', done: 3, total: 60, current_week: 1, finished, extension_weeks: 0, pending_adjustments: 0, review: finished ? { state: 'need_retest', required: ['A0'], weak: [] } : null, today: '2026-11-16' },
      weeks: [{ week_no: 1, topic: 'Old topic', goal_vi: 'x', done: 3, total: 5, sessions: [] }],
    },
  })

  it('đang học dở: có mục "Tạo lại lộ trình", cảnh báo thay thế, mặc định mức hiện tại; gửi replace=true và level đã chọn', async () => {
    const s = server({ 'GET /plan': PLAN(), 'POST /plan': { body: { source: 'ai' } } })
    mount()
    await screen.findByText('Old topic')
    expect(screen.getByText(/thay thế/)).toBeTruthy()
    expect(select().value).toBe('B1')
    expect(screen.queryByText('Làm bài kiểm tra trình độ')).toBeNull()
    fireEvent.change(select(), { target: { value: 'A0' } })
    fireEvent.change(textarea(), { target: { value: 'My plan' } })
    fireEvent.click(create())
    await waitFor(() => expect(s.count('POST /plan')).toBe(1))
    expect(s.last('POST /plan')).toEqual({ level: 'A0', custom: 'My plan', replace: true })
  })
  it('đã học xong lộ trình: không hiện mục tạo lại (đi theo luồng test lại)', async () => {
    server({ 'GET /plan': PLAN(true) })
    mount()
    await screen.findByText('Old topic')
    expect(screen.queryByText(/Tạo lại lộ trình/)).toBeNull()
  })
})

describe('Lộ trình — nạp file Markdown', () => {
  const MD = '# Lộ trình\n## Tuần 1: Greetings\n## Tuần 2: Numbers\n'
  const fileInput = () => screen.getByLabelText(/Nạp từ file Markdown/) as HTMLInputElement
  const pick = (f: File) => fireEvent.change(fileInput(), { target: { files: [f] } })

  it('chọn file .md: nội dung điền vào ô nhập, mục lộ trình riêng tự mở, gửi xem trước cho máy chủ đọc; tạo thì gửi đúng văn bản', async () => {
    const s = server({
      'GET /plan': NO_PLAN(null),
      'POST /plan/preview': { body: { weeks: [{ topic: 'Greetings', goal_vi: 'x' }, { topic: 'Numbers', goal_vi: 'x' }], to_fill: 10 } },
      'POST /plan': { body: { source: 'custom', filled_weeks: 10 } },
    })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    pick(new File([MD], 'lo-trinh.md', { type: 'text/markdown' }))
    await waitFor(() => expect(textarea().value).toBe(MD))
    expect(screen.getByText('lo-trinh.md')).toBeTruthy()
    expect(await screen.findByText(/Đọc được 2 tuần — AI sẽ nối thêm 10 tuần/)).toBeTruthy()
    expect(s.last('POST /plan/preview')).toEqual({ custom: MD })
    fireEvent.click(create())
    await waitFor(() => expect(s.count('POST /plan')).toBe(1))
    expect(s.last('POST /plan')).toEqual({ level: 'A0', custom: MD })
  })

  it('file quá lớn: báo lỗi, không nạp', async () => {
    server({ 'GET /plan': NO_PLAN(null) })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    pick(new File(['x'.repeat(100_001)], 'big.md'))
    expect((await screen.findByRole('alert')).textContent).toContain('quá lớn')
    expect(textarea().value).toBe('')
  })

  it('file dài quá 20000 ký tự (dưới 100 KB): báo lỗi, không nạp', async () => {
    server({ 'GET /plan': NO_PLAN(null) })
    mount()
    await screen.findByLabelText('Mức bắt đầu')
    pick(new File(['x'.repeat(20_001)], 'long.md'))
    expect((await screen.findByRole('alert')).textContent).toContain('quá dài')
    expect(textarea().value).toBe('')
  })
})
