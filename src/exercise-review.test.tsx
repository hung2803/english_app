// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExerciseReview from './components/ExerciseReview'

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

const GET = 'GET /sessions/9/exercise-review'
const POST = 'POST /sessions/9/exercise-review'
const status = (remaining: number, round = 0) => ({ prev_seq: 1, remaining, round })
const Q = [
  { index: 1, type: 'mcq', question: 'Who brings your food?', options: ['The doctor', 'The waiter', 'The pilot', 'The driver'] },
  { index: 5, type: 'fill', question: 'Can I see the ___, please?' },
]
const item = (index: number, correct: boolean) => ({ index, question: index === 1 ? 'Who brings your food?' : 'Can I see the ___, please?', correct, answer_text: index === 1 ? 'The waiter' : 'menu', explanation_vi: 'Giải thích tiếng Việt.' })

describe('ExerciseReview — làm lại câu sai của bài tập buổi trước', () => {
  it('trả lời mcq rồi điền từ → gửi đáp án; còn sai: hiện đáp án đúng + giải thích, nút làm lại, chưa cho tiếp tục', async () => {
    const s = server({ [GET]: { body: { status: status(2), questions: Q } }, [POST]: { body: { passed: false, round: 1, remaining: 1, results: [item(1, true), item(5, false)] } } })
    const onPassed = vi.fn()
    render(<ExerciseReview sessionId={9} onPassed={onPassed} />)
    expect((await screen.findByTestId('exercise-question')).textContent).toBe('Who brings your food?')
    expect(screen.getByText(/2 c.*sai/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'The waiter' }))
    expect((await screen.findByTestId('exercise-question')).textContent).toBe('Can I see the ___, please?')
    fireEvent.change(screen.getByLabelText('Đáp án'), { target: { value: 'bill' } })
    fireEvent.click(screen.getByRole('button', { name: 'Nộp' }))
    expect(await screen.findByText(/1\/2/)).toBeTruthy()
    expect(s.calls.find((c) => c.key === POST)!.body).toEqual({ answers: [{ index: 1, choice: 'The waiter' }, { index: 5, choice: 'bill' }] })
    expect(screen.getAllByText(/Đáp án đúng:/)).toHaveLength(2)
    expect(screen.getAllByText('Giải thích tiếng Việt.')).toHaveLength(1) // chỉ câu sai kèm giải thích
    expect(screen.getByRole('button', { name: 'Làm lại 1 câu sai' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tiếp tục' })).toBeNull()
    expect(onPassed).not.toHaveBeenCalled()
  })

  it('có "Đầu bài" ở trên cùng: bài đọc, tóm tắt, từ vựng, ngữ pháp của buổi trước để xem lại; mở sẵn ở mọi câu; mỗi câu có nhãn kiểu trả lời', async () => {
    const material = {
      seq: 1,
      title: 'Ordering food',
      reading: 'Tom and Anna go to a restaurant. The waiter brings the menu.',
      summary_vi: 'Bài nói về gọi món.',
      vocab: [{ word: 'menu', pos: 'noun', meaning_vi: 'thực đơn', example: 'Can I see the menu?' }],
      grammar: [{ point: 'Can I have ...?', explanation_vi: 'Xin phép lịch sự.', example: 'Can I have some water?' }],
    }
    server({ [GET]: { body: { status: status(2), questions: Q, material } } })
    render(<ExerciseReview sessionId={9} onPassed={() => {}} />)
    const box = await screen.findByTestId('exercise-material')
    expect(box.hasAttribute('open')).toBe(true) // mở sẵn
    expect(box.textContent).toContain('Đầu bài: xem lại bài buổi 1 — Ordering food')
    expect(screen.getByTestId('exercise-reading').textContent).toBe('Tom and Anna go to a restaurant. The waiter brings the menu.')
    expect(box.textContent).toContain('Bài nói về gọi món.')
    expect(box.textContent).toContain('thực đơn')
    expect(box.textContent).toContain('Can I see the menu?')
    expect(box.textContent).toContain('Xin phép lịch sự.')
    expect(screen.getByTestId('exercise-kind').textContent).toBe('Chọn một đáp án đúng') // câu 1 là trắc nghiệm
    fireEvent.click(screen.getByRole('button', { name: 'The waiter' }))
    await screen.findByText('Can I see the ___, please?')
    expect(screen.getByTestId('exercise-kind').textContent).toBe('Gõ từ còn thiếu vào chỗ ___') // câu 2 là điền từ
    expect(screen.getByTestId('exercise-material')).toBeTruthy() // vẫn hiện ở câu sau
  })

  it('không có đầu bài (máy chủ cũ) thì không hiện khung, vẫn làm được', async () => {
    server({ [GET]: { body: { status: status(2), questions: Q } } })
    render(<ExerciseReview sessionId={9} onPassed={() => {}} />)
    await screen.findByTestId('exercise-question')
    expect(screen.queryByTestId('exercise-material')).toBeNull()
  })
  it('đúng hết → nút Tiếp tục gọi onPassed; "Làm lại" tải lại các câu còn sai', async () => {
    const s = server({
      [GET]: [{ body: { status: status(1), questions: [Q[1]] } }, { body: { status: status(1, 1), questions: [Q[1]] } }],
      [POST]: [
        { body: { passed: false, round: 1, remaining: 1, results: [item(5, false)] } },
        { body: { passed: true, round: 2, remaining: 0, results: [item(5, true)] } },
      ],
    })
    const onPassed = vi.fn()
    render(<ExerciseReview sessionId={9} onPassed={onPassed} />)
    fireEvent.change(await screen.findByLabelText('Đáp án'), { target: { value: 'x' } })
    fireEvent.submit(screen.getByLabelText('Đáp án').closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Làm lại 1 câu sai' }))
    expect(await screen.findByTestId('exercise-question')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Đáp án'), { target: { value: 'menu' } })
    fireEvent.submit(screen.getByLabelText('Đáp án').closest('form')!)
    expect(await screen.findByText(/1\/1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }))
    await waitFor(() => expect(onPassed).toHaveBeenCalledTimes(1))
    expect(s.calls.filter((c) => c.key === GET)).toHaveLength(2)
  })
})
