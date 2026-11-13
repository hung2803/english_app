// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Flashcards from './components/Flashcards'

function server(routes: Record<string, unknown>) {
  const calls: { key: string; body?: any }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '').replace(/\?.*$/, '')}`
      calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined })
      return key in routes ? Response.json(routes[key]) : Response.json({ message: 'không có route ' + key }, { status: 404 })
    }),
  )
  return { calls }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CARDS = [
  { id: 1, word: 'order', pos: 'verb', meaning: 'gọi món', example: 'I order tea.' },
  { id: 2, word: 'menu', pos: 'noun', meaning: 'thực đơn', example: null },
]
const ROUTES = { 'GET /flashcards/due': { cards: CARDS, total_due: 2 }, 'POST /flashcards/1/review': { next: {}, remaining_due: 1 }, 'POST /flashcards/2/review': { next: {}, remaining_due: 0 } }
const box = () => screen.getByLabelText('Viết lại từ tiếng Anh') as HTMLInputElement

describe('Flashcards — bước viết lại từ sau khi hiện nghĩa', () => {
  it('hiện nghĩa → ẩn từ tiếng Anh (không lộ đáp án), có ô viết lại từ', async () => {
    server(ROUTES)
    render(<Flashcards style="type" />)
    expect((await screen.findByTestId('card-meaning')).textContent).toBeTruthy()
    expect(screen.queryByTestId('card-word')).toBeNull() // từ tiếng Anh bị ẩn
    expect(screen.queryByText('I order tea.')).toBeNull() // câu ví dụ chứa từ cũng ẩn
    expect(screen.queryByRole('button', { name: 'Nghe phát âm: order' })).toBeNull()
    expect(screen.getByTestId('card-meaning').textContent).toBe('gọi món')
    expect(box()).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tốt' })).toBeNull() // chưa chấm được khi chưa viết
  })

  it('viết đúng (không phân biệt hoa thường, khoảng trắng thừa) → báo đúng, hé lộ từ + ví dụ, đủ 4 mức nhớ', async () => {
    server(ROUTES)
    render(<Flashcards style="type" />)
    await screen.findByTestId('card-meaning')
    fireEvent.change(box(), { target: { value: '  ORDER ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }))
    expect(screen.getByText('✅ Đúng rồi!')).toBeTruthy()
    expect(screen.getByTestId('card-word').textContent).toBe('order')
    expect(screen.getByText('I order tea.')).toBeTruthy()
    for (const g of ['Quên', 'Khó', 'Tốt', 'Dễ']) expect(screen.getByRole('button', { name: g })).toBeTruthy()
  })

  it('viết sai → chỉ còn nút Quên (tính là Quên, thẻ quay lại cuối hàng), hiện từ đúng', async () => {
    const s = server(ROUTES)
    render(<Flashcards style="type" />)
    await screen.findByTestId('card-meaning')
    fireEvent.change(box(), { target: { value: 'ordr' } })
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }))
    expect(screen.getByText(/Chưa đúng — bạn viết: ordr/)).toBeTruthy()
    expect(screen.getByTestId('card-word').textContent).toBe('order') // hé lộ đáp án đúng
    for (const g of ['Khó', 'Tốt', 'Dễ']) expect(screen.queryByRole('button', { name: g })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Quên' }))
    await waitFor(() => expect(s.calls.some((c) => c.key === 'POST /flashcards/1/review')).toBe(true))
    expect(s.calls.find((c) => c.key === 'POST /flashcards/1/review')!.body).toEqual({ grade: 'again', typed: 'ordr' }) // gửi cả chữ đã viết để máy chủ tự kiểm
    await waitFor(() => expect(screen.getByTestId('card-meaning').textContent).toBe('th\u1ef1c \u0111\u01a1n'))
    expect(screen.getByText('Đã ôn 0/2')).toBeTruthy() // thẻ sai chưa tính là đã ôn
  })

  it('"Không nhớ": bỏ qua bước viết, tính là chưa đúng', async () => {
    server(ROUTES)
    render(<Flashcards style="type" />)
    await screen.findByTestId('card-meaning')
    fireEvent.click(screen.getByRole('button', { name: 'Không nhớ' }))
    expect(screen.getByText('❌ Chưa nhớ ra từ này')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tốt' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Quên' })).toBeTruthy()
  })

  it('thẻ kế tiếp quay về mặt trước, ô viết được xóa sạch', async () => {
    server(ROUTES)
    render(<Flashcards style="type" />)
    await screen.findByTestId('card-meaning')
    fireEvent.change(box(), { target: { value: 'order' } })
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tốt' }))
    await waitFor(() => expect(screen.getByTestId('card-meaning').textContent).toBe('th\u1ef1c \u0111\u01a1n'))
    expect(box().value).toBe('')
  })

  it('hết thẻ hôm nay nhưng còn thẻ vượt trần ngày: báo đã ôn đủ và số thẻ chờ ngày mai', async () => {
    server({ 'GET /flashcards/due': { cards: [], total_due: 0, backlog: 12, daily_cap: 20, done_today: 20 } })
    render(<Flashcards style="type" />)
    expect(await screen.findByText('Bạn đã ôn đủ 20 thẻ hôm nay. Còn 12 thẻ chờ sang ngày mai.')).toBeTruthy()
  })
})