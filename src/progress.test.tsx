// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ScoreChart from './components/ScoreChart'
import History from './pages/History'
import Progress from './pages/Progress'
import SessionPage from './pages/Session'

type Resp = { status?: number; body: unknown } | (() => { status?: number; body: unknown })
function server(routes: Record<string, Resp | Resp[]>) {
  const calls: string[] = []
  const counts: Record<string, number> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const full = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
      calls.push(full)
      const key = full.replace(/\?.*$/, '')
      const h = routes[key]
      if (!h) return Response.json({ message: 'không có route ' + key }, { status: 404 })
      const list = Array.isArray(h) ? h : [h]
      const one = list[Math.min(counts[key] ?? 0, list.length - 1)]
      counts[key] = (counts[key] ?? 0) + 1
      const r = typeof one === 'function' ? one() : one
      return Response.json(r.body, { status: r.status ?? 200 })
    }),
  )
  return { calls, last: () => calls.at(-1)! }
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const P = (id: number, score: number, date: string, title = `Bài ${id}`) => ({ id, seq: id, week_no: 1, title, score, date, topic: 'Food' })
const base = () => ({
  plan: { id: 1, level: 'A1', start_date: '2026-11-10' },
  streak: { current: 4, best: 9, studied_today: true, last_study_date: '2026-11-17' },
  completion: {
    done: 12, total: 60, percent: 20, target_percent: 80, target_sessions: 48, on_target: false,
    weeks: [{ week_no: 1, topic: 'Food', done: 5, total: 5 }, { week_no: 2, topic: 'Travel', done: 2, total: 5 }, { week_no: 3, topic: 'Work', done: 0, total: 5 }],
  },
  vocab: { total: 40, learned: 10, due: 6, learned_percent: 25 },
  scores: [P(1, 100, '2026-11-10'), P(2, 63, '2026-11-11'), P(3, 88, '2026-11-12')],
  quiz: { count: 3, average: 84, pass_rate: 67, pass_percent: 70 },
  level: { baseline: { level: 'A0', taken_at: '2026-11-01' }, latest: { level: 'A0', taken_at: '2026-11-01' }, bands_gained: null as number | null, success: null as boolean | null, retake_date: '2027-01-24', retake_due: false, days_until_retake: 68 },
})
const mountProgress = () => render(<MemoryRouter><Progress /></MemoryRouter>)

/* ------------------------------------------------------------------ */
describe('Tiến độ — chuỗi ngày học', () => {
  it('hiện số ngày liên tiếp, chuỗi dài nhất, ngày học gần nhất', async () => {
    server({ 'GET /progress': { body: base() } })
    mountProgress()
    expect((await screen.findByLabelText('Chuỗi ngày học')).textContent).toContain('4')
    expect(screen.getByText('4 ngày học liên tiếp')).toBeTruthy()
    expect(screen.getByText(/Dài nhất: 9 ngày · học gần nhất 17\/11\/2026/)).toBeTruthy()
    expect(screen.getByText('✅ Hôm nay bạn đã học')).toBeTruthy()
  })
  it('hôm nay chưa học → nhắc học để giữ chuỗi', async () => {
    server({ 'GET /progress': { body: { ...base(), streak: { current: 2, best: 2, studied_today: false, last_study_date: '2026-11-16' } } } })
    mountProgress()
    expect(await screen.findByText(/Hôm nay chưa học: học một buổi để giữ chuỗi/)).toBeTruthy()
  })
  it('chưa có chuỗi: báo rõ, không có ngày học gần nhất', async () => {
    server({ 'GET /progress': { body: { ...base(), streak: { current: 0, best: 0, studied_today: false, last_study_date: null } } } })
    mountProgress()
    expect(await screen.findByText('Chưa có chuỗi ngày học')).toBeTruthy()
    expect(screen.queryByText(/học gần nhất/)).toBeNull()
  })
  it('ghi chú: chỉ tính thứ 2–thứ 6', async () => {
    server({ 'GET /progress': { body: base() } })
    mountProgress()
    expect(await screen.findByText(/Chỉ tính thứ 2–thứ 6; cuối tuần không làm đứt chuỗi/)).toBeTruthy()
  })
})

describe('Tiến độ — hoàn thành lộ trình (mục tiêu ≥ 80%)', () => {
  it('số buổi xong/tổng và tỉ lệ; thanh có vạch mục tiêu 80%', async () => {
    server({ 'GET /progress': { body: base() } })
    mountProgress()
    expect((await screen.findByText('12/60')).textContent).toBe('12/60')
    const bar = screen.getByRole('progressbar', { name: 'Tỉ lệ hoàn thành lộ trình' })
    expect(bar.getAttribute('aria-valuenow')).toBe('20')
    expect(bar.querySelector('[title="Mục tiêu 80%"]')).toBeTruthy()
  })
  it('chưa đạt mục tiêu: nói rõ cần bao nhiêu buổi, còn thiếu bao nhiêu', async () => {
    server({ 'GET /progress': { body: base() } })
    mountProgress()
    expect(await screen.findByText('Mục tiêu ≥ 80%: cần ít nhất 48 buổi, còn thiếu 36 buổi.')).toBeTruthy()
  })
  it('đạt mục tiêu: hiện dấu tích', async () => {
    const d = base()
    d.completion = { ...d.completion, done: 48, percent: 80, on_target: true }
    server({ 'GET /progress': { body: d } })
    mountProgress()
    expect(await screen.findByText('✅ Đã đạt mục tiêu hoàn thành ≥ 80%.')).toBeTruthy()
  })
  it('theo từng tuần: số buổi xong/tổng và chủ đề', async () => {
    server({ 'GET /progress': { body: base() } })
    mountProgress()
    const list = await screen.findByRole('list', { name: 'Tiến độ từng tuần' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByLabelText('Tuần 1: 5 trên 5 buổi').textContent).toBe('5/5')
    expect(within(rows[1]).getByLabelText('Tuần 2: 2 trên 5 buổi').textContent).toBe('2/5')
    expect(rows[1].textContent).toContain('Travel')
    // 5 ô nhỏ mỗi tuần, tô đúng số buổi xong
    expect(rows[1].querySelectorAll('span[aria-hidden] > span')).toHaveLength(5)
    expect(rows[1].querySelectorAll('.bg-indigo-600')).toHaveLength(2)
  })
  it('chưa có lộ trình: mời về trang lộ trình', async () => {
    server({ 'GET /progress': { body: { ...base(), plan: null, completion: null } } })
    mountProgress()
    expect(await screen.findByText('Bạn chưa có lộ trình đang học.')).toBeTruthy()
    expect(screen.getByText('Về lộ trình').closest('a')!.getAttribute('href')).toBe('/roadmap')
  })
})

describe('Tiến độ — số từ đã học / đã thuộc', () => {
  it('tổng, đã thuộc, đến hạn, tỉ lệ đã thuộc, liên kết sang kho từ vựng', async () => {
    server({ 'GET /progress': { body: base() } })
    mountProgress()
    await screen.findByText('Đã học')
    const card = screen.getByText('Đã học').closest('div')!.parentElement!
    expect(card.textContent).toContain('40')
    expect(card.textContent).toContain('10')
    expect(card.textContent).toContain('6')
    expect(screen.getByRole('progressbar', { name: 'Tỉ lệ từ đã thuộc' }).getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getByText(/25% số từ đã thuộc/)).toBeTruthy()
    expect(screen.getByText('Xem kho từ vựng').closest('a')!.getAttribute('href')).toBe('/vocab')
  })
  it('kho trống: gợi ý từ vựng sẽ được thêm sau buổi học', async () => {
    server({ 'GET /progress': { body: { ...base(), vocab: { total: 0, learned: 0, due: 0, learned_percent: 0 } } } })
    mountProgress()
    expect(await screen.findByText('Từ vựng sẽ được thêm sau mỗi buổi học.')).toBeTruthy()
  })
})

describe('Tiến độ — mức CEFR', () => {
  it('chưa so sánh được: nêu rõ và hẹn ngày làm lại', async () => {
    server({ 'GET /progress': { body: base() } })
    mountProgress()
    expect(await screen.findByText('Chưa có lần làm lại để so sánh.')).toBeTruthy()
    expect(screen.getByText('Nên làm lại bài kiểm tra vào 24/01/2027 (còn 68 ngày).')).toBeTruthy()
    expect(screen.queryByText('Làm lại bài kiểm tra')).toBeNull()
  })
  it('lên bậc: chúc mừng, ghi số bậc', async () => {
    const d = base()
    d.level = { ...d.level, latest: { level: 'A1', taken_at: '2027-01-20' }, bands_gained: 1, success: true }
    server({ 'GET /progress': { body: d } })
    mountProgress()
    expect(await screen.findByText(/Đạt mục tiêu: đã lên ít nhất 1 bậc/)).toBeTruthy()
    expect(screen.getByText('(+1 bậc)')).toBeTruthy()
  })
  it('chưa lên bậc: khuyến khích tiếp tục', async () => {
    const d = base()
    d.level = { ...d.level, bands_gained: 0, success: false }
    server({ 'GET /progress': { body: d } })
    mountProgress()
    expect(await screen.findByText(/Chưa lên bậc so với lần đầu/)).toBeTruthy()
  })
  it('đã đến hạn làm lại: có nút dẫn tới bài kiểm tra', async () => {
    const d = base()
    d.level = { ...d.level, retake_due: true, days_until_retake: 0 }
    server({ 'GET /progress': { body: d } })
    mountProgress()
    expect(await screen.findByText('Đã đến lúc làm lại bài kiểm tra trình độ.')).toBeTruthy()
    expect(screen.getByText('Làm lại bài kiểm tra').closest('a')!.getAttribute('href')).toBe('/placement')
  })
  it('chưa làm test nào → không có khung mức CEFR', async () => {
    server({ 'GET /progress': { body: { ...base(), level: null } } })
    mountProgress()
    await screen.findByText('Hoàn thành lộ trình')
    expect(screen.queryByText('Trình độ CEFR')).toBeNull()
  })
})

describe('Tiến độ — tải', () => {
  it('lỗi → thông báo + thử lại', async () => {
    server({ 'GET /progress': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, { body: base() }] })
    mountProgress()
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('4 ngày học liên tiếp')).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ */
describe('Biểu đồ điểm quiz theo thời gian', () => {
  const circles = (c: HTMLElement) => [...c.querySelectorAll('circle')]
  const chartOf = (c: HTMLElement) => c.querySelector('svg')!

  it('chưa có điểm: thay biểu đồ bằng lời giải thích', async () => {
    server({ 'GET /progress': { body: { ...base(), scores: [], quiz: { count: 0, average: null, pass_rate: null, pass_percent: 70 } } } })
    mountProgress()
    expect(await screen.findByText(/Chưa có điểm quiz nào/)).toBeTruthy()
    expect(document.querySelector('svg')).toBeNull()
  })

  it('mỗi bài là một chấm; tên biểu đồ nêu số bài; có thống kê trung bình và tỉ lệ đạt', async () => {
    server({ 'GET /progress': { body: base() } })
    const { container } = mountProgress()
    await screen.findByLabelText('Biểu đồ điểm quiz theo thời gian, 3 bài')
    expect(circles(container)).toHaveLength(3)
    expect(screen.getByText(/Trung bình/).textContent).toContain('84%')
    expect(screen.getByText(/Trung bình/).textContent).toContain('đạt 67% số bài')
  })

  it('chấm ĐẠT (≥70%) đặc, chấm CHƯA ĐẠT rỗng — không chỉ dựa vào màu', () => {
    const { container } = render(<ScoreChart scores={[P(1, 100, '2026-11-10'), P(2, 63, '2026-11-11'), P(3, 70, '2026-11-12'), P(4, 69, '2026-11-13')]} />)
    expect(circles(container).map((c) => c.getAttribute('data-pass'))).toEqual(['true', 'false', 'true', 'false']) // 70 là đạt, 69 chưa
    expect(circles(container)[0].getAttribute('class')).toContain('fill-indigo-600')
    expect(circles(container)[1].getAttribute('class')).toContain('fill-white')
  })

  it('có đường ngưỡng "Đạt từ 70%" và chú giải cho cả hai loại chấm', () => {
    const { container } = render(<ScoreChart scores={[P(1, 80, '2026-11-10'), P(2, 50, '2026-11-11')]} />)
    expect(container.textContent).toContain('Đạt từ 70%')
    expect(container.querySelector('line[stroke-dasharray]')).toBeTruthy()
    expect(screen.getByLabelText('Chú thích').textContent).toContain('Đạt (≥ 70%)')
    expect(screen.getByLabelText('Chú thích').textContent).toContain('Chưa đạt')
  })

  it('vị trí chấm theo điểm: điểm cao nằm trên (cy nhỏ hơn), 0% và 100% chạm hai đầu trục', () => {
    const { container } = render(<ScoreChart scores={[P(1, 100, '2026-11-10'), P(2, 0, '2026-11-11'), P(3, 50, '2026-11-12')]} />)
    const cy = circles(container).map((c) => Number(c.getAttribute('cy')))
    expect(cy[0]).toBeLessThan(cy[2])
    expect(cy[2]).toBeLessThan(cy[1])
    expect(cy[0]).toBe(14) // đỉnh trục (đệm trên)
    expect(cy[1]).toBe(226) // đáy trục
  })

  it('một điểm duy nhất: vẽ chấm, không có đường nối', () => {
    const { container } = render(<ScoreChart scores={[P(1, 90, '2026-11-10')]} />)
    expect(circles(container)).toHaveLength(1)
    expect(container.querySelector('path')).toBeNull()
  })

  it('nhiều điểm: có đường nối mảnh; nhãn trục ngày chỉ vài mốc, không dày đặc', () => {
    const many = Array.from({ length: 20 }, (_, i) => P(i + 1, 50 + i, `2026-11-${String(i + 1).padStart(2, '0')}`))
    const { container } = render(<ScoreChart scores={many} />)
    expect(container.querySelector('path')!.getAttribute('stroke-width')).toBe('2')
    const dateLabels = [...container.querySelectorAll('text')].filter((t) => /^\d{2}\/\d{2}$/.test(t.textContent ?? ''))
    expect(dateLabels).toHaveLength(4)
    expect(dateLabels[0].textContent).toBe('01/11')
    expect(dateLabels.at(-1)!.textContent).toBe('20/11')
  })

  describe('rê chuột / chạm để xem chi tiết', () => {
    const rect = { left: 0, top: 0, width: 640, height: 260, right: 640, bottom: 260, x: 0, y: 0, toJSON() {} }
    const hover = (svg: SVGSVGElement, clientX: number) => {
      svg.getBoundingClientRect = () => rect as DOMRect
      fireEvent.pointerMove(svg, { clientX })
    }
    it('khung thông tin hiện điểm, đạt/chưa đạt, tên bài, buổi và ngày của điểm gần con trỏ nhất', () => {
      const { container } = render(<ScoreChart scores={[P(1, 100, '2026-11-10', 'First'), P(2, 63, '2026-11-11', 'Second'), P(3, 88, '2026-11-12', 'Third')]} />)
      expect(screen.queryByRole('status')).toBeNull()
      hover(chartOf(container), 40) // sát điểm đầu
      let tip = screen.getByRole('status')
      expect(tip.textContent).toContain('100% · Đạt')
      expect(tip.textContent).toContain('First')
      expect(tip.textContent).toContain('Buổi 1 · 10/11/2026')
      hover(chartOf(container), 330) // giữa → điểm thứ hai
      tip = screen.getByRole('status')
      expect(tip.textContent).toContain('63% · Chưa đạt')
      expect(tip.textContent).toContain('Second')
    })
    it('điểm đang chọn phóng to; rời con trỏ thì ẩn khung', () => {
      const { container } = render(<ScoreChart scores={[P(1, 100, '2026-11-10'), P(2, 63, '2026-11-11')]} />)
      hover(chartOf(container), 600)
      expect(circles(container)[1].getAttribute('r')).toBe('6')
      expect(circles(container)[0].getAttribute('r')).toBe('4')
      fireEvent.pointerLeave(chartOf(container))
      expect(screen.queryByRole('status')).toBeNull()
      expect(circles(container)[1].getAttribute('r')).toBe('4')
    })
    it('chạm (pointerdown) trên điện thoại cũng hiện chi tiết', () => {
      const { container } = render(<ScoreChart scores={[P(1, 100, '2026-11-10'), P(2, 63, '2026-11-11')]} />)
      chartOf(container).getBoundingClientRect = () => rect as DOMRect
      fireEvent.pointerDown(chartOf(container), { clientX: 40 })
      expect(screen.getByRole('status').textContent).toContain('100%')
    })
    it('tên bài là nội dung do AI sinh ra: hiển thị như chữ thường, không chạy HTML', () => {
      const { container } = render(<ScoreChart scores={[P(1, 90, '2026-11-10', '<img src=x onerror=alert(1)>')]} />)
      hover(chartOf(container), 320)
      expect(container.querySelector('img')).toBeNull()
      expect(screen.getByRole('status').textContent).toContain('<img src=x onerror=alert(1)>')
    })
  })

  it('có bảng số liệu thay thế (cho người dùng đọc màn hình): ngày, buổi, bài, điểm, đánh dấu chưa đạt', () => {
    const { container } = render(<ScoreChart scores={[P(1, 100, '2026-11-10', 'First'), P(2, 63, '2026-11-11', 'Second')]} />)
    expect(screen.getByText('Xem dạng bảng')).toBeTruthy()
    const rows = [...container.querySelectorAll('tbody tr')].map((r) => r.textContent)
    expect(rows).toEqual(['10/11/2026' + '1' + 'First' + '100%', '11/11/2026' + '2' + 'Second' + '63% (chưa đạt)'])
  })
})

/* ------------------------------------------------------------------ */
describe('Lịch sử buổi học', () => {
  const item = (id: number, over: Record<string, unknown> = {}) => ({
    id, seq: id, week_no: 1, topic: 'Food & restaurants', title: `Lesson ${id}`,
    source: { type: 'article', title: 'Example article', url: 'https://example.com/a', ai_written: false },
    score: 85, passed: true, completed_date: '2026-11-1' + (id % 10), vocab_count: 5, ...over,
  })
  const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ body: { items, matched: items.length, total: items.length, page: 1, page_size: 20, ...over } })
  const mount = () => render(<MemoryRouter><History /></MemoryRouter>)

  it('chưa có buổi nào: báo rõ + dẫn về lộ trình', async () => {
    server({ 'GET /history': page([]) })
    mount()
    expect(await screen.findByText(/Chưa có buổi học nào hoàn thành/)).toBeTruthy()
    expect(screen.getByText('Về lộ trình').closest('a')!.getAttribute('href')).toBe('/roadmap')
  })

  it('mỗi buổi: tên bài, chủ đề, buổi/tuần, điểm đạt/chưa đạt, nguồn, ngày, số từ vựng', async () => {
    server({ 'GET /history': page([
      item(1),
      item(2, { score: 55, passed: false, source: { type: 'ai', title: 'Bài đọc do AI viết', ai_written: true } }),
      item(3, { source: { type: 'youtube', title: 'A video', ai_written: false } }),
      item(4, { source: { type: 'upload', title: 'My book', ai_written: false } }),
    ]) })
    mount()
    await screen.findByText('Lesson 1')
    const rows = screen.getAllByRole('listitem')
    expect(rows[0].textContent).toContain('Buổi 1 · Tuần 1: Food & restaurants')
    expect(rows[0].textContent).toContain('🌐 Example article')
    expect(rows[0].textContent).toContain('5 từ vựng')
    expect(within(rows[0]).getByLabelText('Điểm 85%, đạt').textContent).toBe('✓ 85%')
    expect(within(rows[1]).getByLabelText('Điểm 55%, chưa đạt').textContent).toBe('! 55%')
    expect(rows[1].textContent).toContain('✍️ Bài đọc do AI viết')
    expect(rows[2].textContent).toContain('▶️ A video')
    expect(rows[3].textContent).toContain('📎 My book')
  })

  it('bấm một buổi → mở lại buổi đó (liên kết tới /session/:id)', async () => {
    server({ 'GET /history': page([item(7)]) })
    mount()
    expect((await screen.findByText('Lesson 7')).closest('a')!.getAttribute('href')).toBe('/session/7')
    expect(screen.getByText(/Xem lại bài, từ vựng, quiz/)).toBeTruthy()
  })

  it('bài không có tiêu đề: dùng chủ đề', async () => {
    server({ 'GET /history': page([item(1, { title: '' })]) })
    mount()
    expect((await screen.findAllByText('Food & restaurants')).length).toBeGreaterThan(0)
  })

  it('tìm theo chủ đề: chờ ngừng gõ rồi mới gọi, gửi đúng từ khóa, đổi nhãn "khớp"', async () => {
    const s = server({ 'GET /history': [page([item(1), item(2)], { matched: 2 }), page([item(2)], { matched: 1, total: 2 })] })
    mount()
    await screen.findByText('Lesson 2')
    expect(screen.getByText('2 buổi đã học')).toBeTruthy()
    const before = s.calls.length
    const box = screen.getByLabelText('Tìm buổi học')
    fireEvent.change(box, { target: { value: 'f' } })
    fireEvent.change(box, { target: { value: 'food' } })
    expect(s.calls.length).toBe(before)
    await act(async () => void vi.advanceTimersByTime(300))
    await waitFor(() => expect(s.last()).toBe('GET /history?q=food&page=1'))
    expect(await screen.findByText('1 buổi khớp')).toBeTruthy()
  })

  it('tìm không ra: báo không khớp (khác với chưa học buổi nào)', async () => {
    server({ 'GET /history': [page([item(1)], { total: 1 }), page([], { matched: 0, total: 1 })] })
    mount()
    await screen.findByText('Lesson 1')
    fireEvent.change(screen.getByLabelText('Tìm buổi học'), { target: { value: 'zzz' } })
    await act(async () => void vi.advanceTimersByTime(300))
    expect(await screen.findByText('Không có buổi nào khớp với tìm kiếm.')).toBeTruthy()
  })

  it('phân trang: Trang x/y, Trước/Sau gọi đúng trang; đổi từ khóa quay về trang 1', async () => {
    const s = server({ 'GET /history': page([item(1)], { matched: 45, total: 45 }) })
    mount()
    await screen.findByText('Trang 1/3')
    expect((screen.getByText('← Trước') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Sau →'))
    await waitFor(() => expect(s.last()).toBe('GET /history?q=&page=2'))
    fireEvent.change(screen.getByLabelText('Tìm buổi học'), { target: { value: 'x' } })
    await act(async () => void vi.advanceTimersByTime(300))
    await waitFor(() => expect(s.last()).toBe('GET /history?q=x&page=1'))
  })

  it('tải lỗi → thông báo + thử lại', async () => {
    server({ 'GET /history': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, page([item(1)])] })
    mount()
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('Lesson 1')).toBeTruthy()
  })

  it('nội dung do AI sinh ra hiển thị như chữ thường', async () => {
    server({ 'GET /history': page([item(1, { title: '<img src=x onerror=alert(1)>' })]) })
    const { container } = mount()
    await screen.findByText('<img src=x onerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
  })

  it('từ lịch sử bấm vào buổi: mở trang buổi đã xong (bài, từ vựng, quiz, hội thoại)', async () => {
    const lesson = {
      title: 'Lesson 7', source: { type: 'article', url: 'https://example.com/a', title: 'Example article', ai_written: false },
      excerpt: 'e', summary_vi: 'Tóm tắt bài cũ.', explanation_vi: 'x',
      vocab: [{ word: 'order', meaning_vi: 'gọi món' }], grammar: [{ point: 'p', explanation_vi: 'g' }], quiz: [],
    }
    server({
      'GET /history': page([item(7)]),
      'GET /sessions/7': { body: { session: { id: 7, seq: 7, week_no: 1, topic: 'Food', scheduled_date: '2026-11-11', status: 'done', score: 85, material: null, lesson, result: { score: 85, right: 7, total: 8, passed: true, items: [], review_words: [] } } } },
      'GET /sessions/7/chat': { body: { messages: [] } },
    })
    render(
      <MemoryRouter initialEntries={['/history']}>
        <Routes>
          <Route path="/history" element={<History />} />
          <Route path="/session/:id" element={<SessionPage />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByText('Lesson 7'))
    expect(await screen.findByText('Tóm tắt bài cũ.')).toBeTruthy()
    expect(screen.getByText('Kết quả quiz')).toBeTruthy()
  })
})
