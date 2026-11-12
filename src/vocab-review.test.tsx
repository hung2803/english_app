// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VocabReview from './components/VocabReview'

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
  return { calls }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const GET = 'GET /sessions/7/vocab-review'
const POST = 'POST /sessions/7/vocab-review'
const st = (stage: number, round = 0) => ({ total: 2, stage, stages: 3, round })
const MCQ = [
  { word: 'order', kind: 'mcq', dir: 'en_vi', prompt: 'order', options: ['gọi món', 'hóa đơn', 'thực đơn', 'bồi bàn'] },
  { word: 'menu', kind: 'mcq', dir: 'vi_en', prompt: 'thực đơn', options: ['bill', 'menu', 'tip', 'waiter'] },
]
const res = (stage: number, o: Record<string, unknown>) => ({
  passed: false, stage, cleared: false, next_stage: stage, round: 1,
  results: [{ word: 'order', meaning: 'gọi món', correct: true }, { word: 'menu', meaning: 'thực đơn', correct: false }], ...o,
})

describe('VocabReview — ôn từ vựng bài trước (3 giai đoạn)', () => {
  it('giai đoạn 1: trả lời hết → gửi đáp án; có từ sai: phải làm lại giai đoạn từ đầu, chưa cho bắt đầu bài', async () => {
    const s = server({ [GET]: { body: { status: st(1), questions: MCQ } }, [POST]: { body: res(1, {}) } })
    const onPassed = vi.fn()
    render(<VocabReview sessionId={7} onPassed={onPassed} />)
    expect(await screen.findByText(/Giai đoạn 1\/3: Trắc nghiệm/)).toBeTruthy()
    expect((await screen.findByTestId('review-prompt')).textContent).toBe('order')
    fireEvent.click(screen.getByRole('button', { name: 'gọi món' }))
    expect((await screen.findByTestId('review-prompt')).textContent).toBe('thực đơn')
    fireEvent.click(screen.getByRole('button', { name: 'tip' })) // chọn sai
    expect(await screen.findByText('Đúng 1/2')).toBeTruthy()
    expect(s.calls.find((c) => c.key === POST)!.body).toEqual({ answers: [{ word: 'order', dir: 'en_vi', choice: 'gọi món' }, { word: 'menu', dir: 'vi_en', choice: 'tip' }] })
    expect(screen.getByText(/phải làm lại giai đoạn 1 từ đầu/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Làm lại giai đoạn 1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Bắt đầu bài học' })).toBeNull()
    expect(onPassed).not.toHaveBeenCalled()
  })

  it('đúng 100% giai đoạn 1 → báo qua giai đoạn, nút sang giai đoạn 2 (chưa mở bài)', async () => {
    const s = server({
      [GET]: [{ body: { status: st(1), questions: [MCQ[0]] } }, { body: { status: st(2, 1), questions: [{ word: 'order', kind: 'type', prompt: 'gọi món' }] } }],
      [POST]: { body: res(1, { cleared: true, next_stage: 2, results: [{ word: 'order', meaning: 'gọi món', correct: true }] }) },
    })
    render(<VocabReview sessionId={7} onPassed={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'gọi món' }))
    expect(await screen.findByText('✅ Qua giai đoạn 1/3!')).toBeTruthy()
    expect(screen.getByText(/giai đoạn 2\/3 — Gõ từ tiếng Anh/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Bắt đầu bài học' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sang giai đoạn 2' }))
    expect(await screen.findByText(/Giai đoạn 2\/3: Gõ từ tiếng Anh/)).toBeTruthy()
    expect(s.calls.filter((c) => c.key === GET)).toHaveLength(2)
  })

  it('giai đoạn 2: gõ từ rồi nhấn Enter/Nộp; chỉ hiện nghĩa tiếng Việt, không có gợi ý chữ cái', async () => {
    const s = server({
      [GET]: { body: { status: st(2, 1), questions: [{ word: 'order', kind: 'type', prompt: 'gọi món' }] } },
      [POST]: { body: res(2, { cleared: true, next_stage: 3, results: [{ word: 'order', meaning: 'gọi món', correct: true }] }) },
    })
    render(<VocabReview sessionId={7} onPassed={() => {}} />)
    expect((await screen.findByTestId('review-prompt')).textContent).toBe('gọi món')
    expect(screen.queryByText(/Gợi ý/)).toBeNull() // không gợi ý chữ cái
    fireEvent.change(screen.getByLabelText('Đáp án'), { target: { value: 'order' } })
    fireEvent.click(screen.getByRole('button', { name: 'Nộp' }))
    await screen.findByText('✅ Qua giai đoạn 2/3!')
    expect(s.calls.find((c) => c.key === POST)!.body).toEqual({ answers: [{ word: 'order', choice: 'order' }] })
  })

  it('giai đoạn 3: điền vào câu; đạt → nút bắt đầu bài học gọi onPassed', async () => {
    server({
      [GET]: { body: { status: st(3, 2), questions: [{ word: 'order', kind: 'cloze', prompt: 'I would like to _____ a pizza.', hint: 'gọi món' }] } },
      [POST]: { body: res(3, { passed: true, cleared: true, results: [{ word: 'order', meaning: 'gọi món', correct: true }] }) },
    })
    const onPassed = vi.fn()
    render(<VocabReview sessionId={7} onPassed={onPassed} />)
    expect((await screen.findByTestId('review-prompt')).textContent).toBe('I would like to _____ a pizza.')
    expect(screen.getByText('Gõ từ còn thiếu trong câu')).toBeTruthy()
    expect(screen.getByText('Gợi ý: gọi món')).toBeTruthy() // gợi ý tiếng Việt, không có chữ cái đầu
    fireEvent.change(screen.getByLabelText('Đáp án'), { target: { value: 'order' } })
    fireEvent.submit(screen.getByLabelText('Đáp án').closest('form')!)
    expect(await screen.findByText('✅ Đạt 100% cả 3 giai đoạn!')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu bài học' }))
    await waitFor(() => expect(onPassed).toHaveBeenCalledTimes(1))
  })
})

describe('VocabReview — xem lại từ đầy đủ', () => {
  const STUDY = [
    { word: 'order', pos: 'verb', meaning: 'gọi món', example: 'I would like to order a pizza.' },
    { word: 'menu', meaning: 'thực đơn' },
  ]

  it('giai đoạn 1: hiện màn hình xem lại (từ, loại từ, nghĩa, câu ví dụ) trước khi làm bài', async () => {
    server({ [GET]: { body: { status: st(1), questions: MCQ, study: STUDY } } })
    render(<VocabReview sessionId={7} onPassed={() => {}} />)
    expect(await screen.findByText('Xem lại từ vựng bài trước')).toBeTruthy()
    expect(screen.getByText('(verb)')).toBeTruthy()
    expect(screen.getByText('— gọi món')).toBeTruthy()
    expect(screen.getByText('I would like to order a pizza.')).toBeTruthy()
    expect(screen.queryByTestId('review-prompt')).toBeNull() // chưa vào câu hỏi
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu làm bài' }))
    expect((await screen.findByTestId('review-prompt')).textContent).toBe('order')
  })

  it('giai đoạn 2, 3: vào thẳng câu hỏi (không lộ câu ví dụ trước khi làm)', async () => {
    server({ [GET]: { body: { status: st(3, 2), questions: [{ word: 'order', kind: 'cloze', prompt: 'I would like to _____ a pizza.', hint: 'gọi món' }], study: STUDY } } })
    render(<VocabReview sessionId={7} onPassed={() => {}} />)
    expect((await screen.findByTestId('review-prompt')).textContent).toBe('I would like to _____ a pizza.')
    expect(screen.queryByText('Xem lại từ vựng bài trước')).toBeNull()
  })

  it('kết quả mỗi lượt hiện đầy đủ từ, loại từ, nghĩa, câu ví dụ và đúng/sai', async () => {
    server({
      [GET]: { body: { status: st(2, 1), questions: [{ word: 'order', kind: 'type', prompt: 'gọi món' }], study: STUDY } },
      [POST]: { body: res(2, { results: [{ ...STUDY[0], correct: false }] }) },
    })
    render(<VocabReview sessionId={7} onPassed={() => {}} />)
    fireEvent.change(await screen.findByLabelText('Đáp án'), { target: { value: 'x' } })
    fireEvent.submit(screen.getByLabelText('Đáp án').closest('form')!)
    expect(await screen.findByText('(verb)')).toBeTruthy()
    expect(screen.getByText('I would like to order a pizza.')).toBeTruthy()
    expect(screen.getByText('— gọi món')).toBeTruthy()
  })
})