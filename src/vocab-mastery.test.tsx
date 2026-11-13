// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import Vocab from './pages/Vocab'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function mount() {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    calls.push(String(url))
    return Response.json({ items: [
      { id: 1, word: 'almost', meaning: 'near', learned: 0, due_date: '2099-01-01', typed_streak: 2, wrong_count: 0 },
      { id: 2, word: 'known', meaning: 'familiar', learned: 1, due_date: '2099-01-01', typed_streak: 3, wrong_count: 0 },
    ], matched: 2, page: 1, page_size: 50, stats: {total:2, learned:1, due:0} })
  }))
  render(<MemoryRouter><Vocab /></MemoryRouter>)
  return calls
}
it('shows memory level, actual recall evidence and completion separately from the review date', async () => {
  mount()
  await screen.findByText('almost')
  const rows = screen.getAllByRole('listitem')
  expect(within(rows[0]).getByText('Gần thuộc')).toBeTruthy()
  expect(within(rows[0]).getByText(/Nhớ đúng 2\/3 ngày khác nhau/)).toBeTruthy()
  expect(screen.getByRole('progressbar', {name:'Tiến độ ghi nhớ: almost'}).getAttribute('aria-valuenow')).toBe('50')
  expect(within(rows[1]).getByText('Đã thuộc')).toBeTruthy()
  expect(screen.getByRole('progressbar', {name:'Tiến độ ghi nhớ: known'}).getAttribute('aria-valuenow')).toBe('100')
  expect(within(rows[0]).getByText('Ôn lại: 01/01/2099')).toBeTruthy()
})
it('sends level filters and priority order to the server for the whole vocabulary list', async () => {
  const calls = mount()
  await screen.findByText('almost')
  expect(calls[0]).toContain('order=priority')
  fireEvent.change(screen.getByLabelText('Lọc theo mức độ ghi nhớ'),{target:{value:'almost'}})
  await waitFor(() => expect(calls.at(-1)).toContain('level=almost'))
  fireEvent.change(screen.getByLabelText('Sắp xếp từ vựng'),{target:{value:'recent'}})
  await waitFor(() => expect(calls.at(-1)).not.toContain('order=priority'))
  expect(calls.at(-1)).toContain('level=almost')
})
