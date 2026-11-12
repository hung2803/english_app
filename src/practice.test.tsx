// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Flashcards from './components/Flashcards'

function server(routes: Record<string, unknown>) {
  const calls: { key: string; body?: any }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
      calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined })
      return key in routes ? Response.json(routes[key]) : Response.json({ message: 'không có route ' + key }, { status: 404 })
    }),
  )
  return { calls }
}
/** Hiện nghĩa rồi viết lại đúng từ để tới phần chấm mức nhớ. */
const showAndType = (word: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Hiện nghĩa' }))
  fireEvent.change(screen.getByLabelText('Viết lại từ tiếng Anh'), { target: { value: word } })
  fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CARD = { id: 5, word: 'later1', pos: null, meaning: 'nghĩa', example: null }

describe('Flashcards — ôn tự do', () => {
  it('gọi endpoint ôn tự do theo phạm vi; chấm điểm gửi kèm practice: true', async () => {
    const s = server({
      'GET /flashcards/practice?scope=learned&limit=10': { cards: [CARD], total_due: 7 },
      'POST /flashcards/5/review': { next: {}, remaining_due: 0 },
    })
    render(<Flashcards practice="learned" />)
    await screen.findByRole('button', { name: 'Hiện nghĩa' })
    showAndType('later1')
    fireEvent.click(screen.getByRole('button', { name: 'Tốt' }))
    expect(await screen.findByText('✅ Xong lượt ôn!')).toBeTruthy()
    expect(s.calls.find((c) => c.key === 'POST /flashcards/5/review')!.body).toEqual({ grade: 'good', practice: true })
    // ôn tự do: luôn cho ôn thêm, không nói "đến hạn"
    expect(screen.getByRole('button', { name: 'Ôn thêm 10 từ khác' })).toBeTruthy()
    expect(screen.queryByText(/thẻ đến hạn/)).toBeNull()
  })

  it('nhóm rỗng: báo chưa có từ trong nhóm', async () => {
    server({ 'GET /flashcards/practice?scope=all&limit=10': { cards: [], total_due: 0 } })
    render(<Flashcards practice="all" />)
    expect(await screen.findByText('Chưa có từ nào trong nhóm này')).toBeTruthy()
  })

  it('ôn thường (không practice): vẫn gọi /flashcards/due và gửi body như cũ', async () => {
    const s = server({ 'GET /flashcards/due?limit=10': { cards: [CARD], total_due: 1 }, 'POST /flashcards/5/review': { next: {}, remaining_due: 0 } })
    render(<Flashcards />)
    await screen.findByRole('button', { name: 'Hiện nghĩa' })
    showAndType('later1')
    fireEvent.click(screen.getByRole('button', { name: 'Dễ' }))
    await waitFor(() => expect(s.calls.some((c) => c.key === 'POST /flashcards/5/review')).toBe(true))
    expect(s.calls.find((c) => c.key === 'POST /flashcards/5/review')!.body).toEqual({ grade: 'easy' })
  })
})
