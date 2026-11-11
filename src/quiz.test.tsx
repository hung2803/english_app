// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Quiz, { QuizResultView, type QuizResult } from './components/Quiz'
import SessionPage from './pages/Session'

const QUIZ = [
  { type: 'mcq' as const, question: 'Who brings your food?', options: ['The doctor', 'The waiter', 'The pilot', 'The driver'] },
  { type: 'mcq' as const, question: 'What is a tip?', options: ['Extra money', 'A fish', 'A hat', 'A sign'] },
  { type: 'fill' as const, question: 'Can I see the ___, please?' },
]

type Resp = { status?: number; body: unknown } | (() => Promise<{ status?: number; body: unknown }>)
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
  return { calls, count: (k: string) => calls.filter((c) => c.key === k).length, last: (k: string) => calls.filter((c) => c.key === k).at(-1)?.body }
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const submitBtn = () => screen.getByRole('button', { name: /^(Nộp bài|Nộp bài luôn|Đang chấm…)$/ }) as HTMLButtonElement
const fillBox = () => screen.getByLabelText('Đáp án câu 3') as HTMLInputElement
const pick = (q: number, text: string) => fireEvent.click(within(screen.getAllByRole('group')[q]).getByLabelText(text))

describe('Quiz — làm bài', () => {
  it('hiện đủ câu hỏi: trắc nghiệm có các lựa chọn, điền từ có ô nhập; KHÔNG có đáp án', () => {
    server({})
    render(<Quiz sessionId={1} quiz={QUIZ} onSubmitted={() => {}} />)
    expect(screen.getByText('1. Who brings your food?')).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(8)
    expect(fillBox()).toBeTruthy()
    expect(screen.getByText(/3 câu\. Nộp xong sẽ có điểm và đáp án, và không làm lại được/)).toBeTruthy()
  })

  it('làm đủ rồi nộp → gửi đúng: chỉ số lựa chọn (số) và chữ đã cắt khoảng trắng; gọi onSubmitted', async () => {
    const s = server({ 'POST /sessions/1/quiz': { body: { result: {} } } })
    const done = vi.fn()
    render(<Quiz sessionId={1} quiz={QUIZ} onSubmitted={done} />)
    pick(0, 'The waiter')
    pick(1, 'Extra money')
    fireEvent.change(fillBox(), { target: { value: '  menu  ' } })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(s.last('POST /sessions/1/quiz')).toEqual({ answers: [1, 0, 'menu'] })
  })

  it('còn câu chưa làm: hiện số câu còn lại; bấm Nộp lần đầu chỉ hỏi xác nhận, chưa gửi', async () => {
    const s = server({ 'POST /sessions/1/quiz': { body: {} } })
    render(<Quiz sessionId={1} quiz={QUIZ} onSubmitted={() => {}} />)
    pick(0, 'The waiter')
    expect(screen.getByText('Còn 2 câu chưa trả lời')).toBeTruthy()
    fireEvent.click(submitBtn())
    expect(screen.getByRole('alert').textContent).toContain('Bạn còn 2 câu chưa trả lời, các câu này tính là sai')
    expect(s.count('POST /sessions/1/quiz')).toBe(0)
  })

  it('xác nhận "Nộp bài luôn" → gửi, câu bỏ trống là null (điền từ chỉ có khoảng trắng cũng là null)', async () => {
    const s = server({ 'POST /sessions/1/quiz': { body: {} } })
    const done = vi.fn()
    render(<Quiz sessionId={1} quiz={QUIZ} onSubmitted={done} />)
    pick(0, 'The waiter')
    fireEvent.change(fillBox(), { target: { value: '   ' } })
    fireEvent.click(submitBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Nộp bài luôn' }))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(s.last('POST /sessions/1/quiz')).toEqual({ answers: [1, null, null] })
  })

  it('"Làm tiếp" hủy xác nhận; sửa câu trả lời cũng hủy xác nhận', () => {
    server({})
    render(<Quiz sessionId={1} quiz={QUIZ} onSubmitted={() => {}} />)
    fireEvent.click(submitBtn())
    fireEvent.click(screen.getByText('Làm tiếp'))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(submitBtn())
    pick(1, 'A fish')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('đang chấm: nút khóa, không gửi trùng', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const s = server({ 'POST /sessions/1/quiz': async () => { await gate; return { body: {} } } })
    render(<Quiz sessionId={1} quiz={[QUIZ[0]]} onSubmitted={() => {}} />)
    pick(0, 'The waiter')
    fireEvent.click(submitBtn())
    expect((await screen.findByRole('button', { name: 'Đang chấm…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('form', { name: 'Quiz cuối buổi' }))
    expect(s.count('POST /sessions/1/quiz')).toBe(1)
    await act(async () => release())
  })

  it('lỗi mạng/máy chủ: hiện thông báo + thử lại, GIỮ NGUYÊN các câu đã làm; thử lại thành công', async () => {
    const done = vi.fn()
    const s = server({
      'POST /sessions/1/quiz': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, { body: { result: {} } }],
    })
    render(<Quiz sessionId={1} quiz={QUIZ} onSubmitted={done} />)
    pick(0, 'The waiter')
    pick(1, 'Extra money')
    fireEvent.change(fillBox(), { target: { value: 'menu' } })
    fireEvent.click(submitBtn())
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    expect((screen.getAllByRole('radio')[1] as HTMLInputElement).checked).toBe(true)
    expect(fillBox().value).toBe('menu')
    expect(done).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Thử lại'))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(s.count('POST /sessions/1/quiz')).toBe(2)
    expect(s.last('POST /sessions/1/quiz')).toEqual({ answers: [1, 0, 'menu'] })
  })

  it('đã nộp rồi (409): hiện thông báo của máy chủ', async () => {
    server({ 'POST /sessions/1/quiz': { status: 409, body: { error: 'done', message: 'Buổi học này đã nộp quiz rồi, không làm lại được.', retryable: false } } })
    render(<Quiz sessionId={1} quiz={[QUIZ[0]]} onSubmitted={() => {}} />)
    pick(0, 'The waiter')
    fireEvent.click(submitBtn())
    expect(await screen.findByText(/đã nộp quiz rồi/)).toBeTruthy()
  })
})

describe('QuizResultView — điểm, đáp án, giải thích', () => {
  const RESULT: QuizResult = {
    score: 67, right: 2, total: 3, passed: false,
    items: [
      { index: 0, type: 'mcq', question: 'Who brings your food?', options: ['The doctor', 'The waiter', 'The pilot', 'The driver'], given: 1, correct: true, answer: 1, answer_text: 'The waiter', explanation_vi: 'Waiter là bồi bàn.' },
      { index: 1, type: 'mcq', question: 'What is a tip?', options: ['Extra money', 'A fish', 'A hat', 'A sign'], given: 2, correct: false, answer: 0, answer_text: 'Extra money', explanation_vi: 'Tip là tiền boa.' },
      { index: 2, type: 'fill', question: 'Can I see the ___, please?', given: null, correct: false, answer: 'menu', answer_text: 'menu', explanation_vi: 'Xem thực đơn: the menu.' },
    ],
  }

  it('hiện điểm và số câu đúng', () => {
    render(<QuizResultView result={RESULT} />)
    expect(screen.getByLabelText('Điểm').textContent).toBe('67%')
    expect(screen.getByText('Đúng 2/3 câu')).toBeTruthy()
  })
  it('chưa đạt (<70%): nói rõ buổi học VẪN tính là xong', () => {
    render(<QuizResultView result={RESULT} />)
    expect(screen.getByText(/Chưa đạt \(cần từ 70%\), nhưng buổi học này vẫn được tính là đã xong/)).toBeTruthy()
  })
  it('đạt: hiện chúc mừng, không có lời "chưa đạt"', () => {
    render(<QuizResultView result={{ ...RESULT, score: 100, right: 3, passed: true }} />)
    expect(screen.getByText(/Đạt! Bạn đã hoàn thành buổi học này/)).toBeTruthy()
    expect(screen.queryByText(/Chưa đạt/)).toBeNull()
  })
  it('mỗi câu: đánh dấu đúng/sai, câu bạn chọn, giải thích; câu sai có thêm đáp án đúng', () => {
    render(<QuizResultView result={RESULT} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-correct'))).toEqual(['true', 'false', 'false'])
    expect(items[0].textContent).toContain('Bạn chọn: The waiter')
    expect(items[0].textContent).not.toContain('Đáp án đúng') // câu đúng không cần nhắc lại
    expect(items[0].textContent).toContain('Waiter là bồi bàn.')
    expect(items[1].textContent).toContain('Bạn chọn: A hat') // chỉ số 2 → nội dung lựa chọn
    expect(items[1].textContent).toContain('Đáp án đúng: Extra money')
    expect(items[1].textContent).toContain('Tip là tiền boa.')
  })
  it('câu bỏ trống: ghi "(bỏ trống)" và hiện đáp án đúng', () => {
    render(<QuizResultView result={RESULT} />)
    const last = screen.getAllByRole('listitem')[2]
    expect(last.textContent).toContain('(bỏ trống)')
    expect(last.textContent).toContain('Đáp án đúng: menu')
  })
  it('điền từ: hiện đúng chữ người học đã gõ', () => {
    const r = { ...RESULT, items: [{ ...RESULT.items[2], given: 'menus' }] }
    render(<QuizResultView result={{ ...r, total: 1, right: 0, score: 0 }} />)
    expect(screen.getByText('menus')).toBeTruthy()
  })
  it('nội dung do AI sinh ra hiển thị như chữ thường, không chạy HTML', () => {
    const evil = { ...RESULT, items: [{ ...RESULT.items[1], question: '<img src=x onerror=alert(1)>', explanation_vi: '<script>x</script>', answer_text: '<b>y</b>' }] }
    const { container } = render(<QuizResultView result={evil} />)
    expect(container.querySelector('img, script, b')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

/* ---------------- ghép vào trang buổi học ---------------- */
describe('trang buổi học: quiz và kết quả', () => {
  const LESSON = {
    title: 'Ordering food', source: { type: 'article', url: 'https://example.com/a', title: 'Ordering food', ai_written: false },
    excerpt: 'Can I have a coffee?', summary_vi: 'Tóm tắt bài.', explanation_vi: 'Giải thích bài.',
    vocab: [{ word: 'order', meaning_vi: 'gọi món' }], grammar: [{ point: 'Can I have', explanation_vi: 'Xin phép.' }],
  }
  const MATERIAL = { options: [{ type: 'article', title: 'Ordering food', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }], chosen: 0, fallback: false }
  const RESULT = {
    score: 100, right: 3, total: 3, passed: true,
    items: [
      { index: 0, type: 'mcq', question: 'Who brings your food?', options: ['The doctor', 'The waiter', 'The pilot', 'The driver'], given: 1, correct: true, answer: 1, answer_text: 'The waiter', explanation_vi: 'Waiter là bồi bàn.' },
    ],
  }
  const session = (over: Record<string, unknown>) => ({ body: { session: { id: 1, seq: 1, week_no: 1, topic: 'Food', scheduled_date: '2026-11-16', status: 'pending', score: null, material: MATERIAL, lesson: { ...LESSON, quiz: QUIZ }, result: null, ...over } } })
  const mount = () => render(<MemoryRouter initialEntries={['/session/1']}><Routes><Route path="/session/:id" element={<SessionPage />} /></Routes></MemoryRouter>)

  it('buổi đang học: có quiz sau bài học và hội thoại', async () => {
    server({ 'GET /sessions/1': session({}), 'GET /sessions/1/chat': { body: { messages: [] } } })
    mount()
    expect(await screen.findByRole('form', { name: 'Quiz cuối buổi' })).toBeTruthy()
    expect(screen.getByText('Tóm tắt bài.')).toBeTruthy()
  })

  it('nộp quiz xong: tải lại buổi và hiện kết quả thay cho form (không làm lại được)', async () => {
    const s = server({
      'GET /sessions/1': [session({}), session({ status: 'done', score: 100, result: RESULT, lesson: { ...LESSON, quiz: [] } })],
      'GET /sessions/1/chat': { body: { messages: [] } },
      'POST /sessions/1/quiz': { body: { result: RESULT } },
    })
    mount()
    await screen.findByRole('form', { name: 'Quiz cuối buổi' })
    pick(0, 'The waiter')
    pick(1, 'Extra money')
    fireEvent.change(fillBox(), { target: { value: 'menu' } })
    fireEvent.click(submitBtn())
    expect(await screen.findByText('Kết quả quiz')).toBeTruthy()
    expect(screen.getByLabelText('Điểm').textContent).toBe('100%')
    expect(screen.queryByRole('form', { name: 'Quiz cuối buổi' })).toBeNull()
    expect(s.count('POST /sessions/1/quiz')).toBe(1)
  })

  it('mở lại buổi đã xong: thấy kết quả + đáp án + giải thích, không có form quiz', async () => {
    server({ 'GET /sessions/1': session({ status: 'done', score: 100, result: RESULT }), 'GET /sessions/1/chat': { body: { messages: [] } } })
    mount()
    expect(await screen.findByText('Kết quả quiz')).toBeTruthy()
    expect(screen.getByText('Waiter là bồi bàn.')).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Quiz cuối buổi' })).toBeNull()
  })

  it('bài cũ không có quiz: không hiện form quiz', async () => {
    server({ 'GET /sessions/1': session({ lesson: { ...LESSON } }), 'GET /sessions/1/chat': { body: { messages: [] } } })
    mount()
    await screen.findByText('Tóm tắt bài.')
    expect(screen.queryByRole('form', { name: 'Quiz cuối buổi' })).toBeNull()
  })
})

describe('QuizResultView — từ cần ôn lại', () => {
  const base: QuizResult = {
    score: 50, right: 1, total: 2, passed: false,
    items: [{ index: 0, type: 'mcq', question: 'Q?', options: ['a', 'b', 'c', 'd'], given: 1, correct: false, answer: 0, answer_text: 'a', explanation_vi: 'Vì a.' }],
  }
  it('có từ làm sai: báo đã đưa vào hàng ôn, liệt kê từng từ', () => {
    render(<QuizResultView result={{ ...base, review_words: ['bill', 'order'] }} />)
    const box = screen.getByLabelText('Từ cần ôn')
    expect(box.textContent).toContain('Các từ bạn làm sai đã được đưa vào hàng ôn')
    expect(box.textContent).toContain('bill, order')
  })
  it('đúng hết (danh sách rỗng) hoặc kết quả cũ chưa có trường này: không hiện khung', () => {
    const { unmount } = render(<QuizResultView result={{ ...base, passed: true, score: 100, review_words: [] }} />)
    expect(screen.queryByLabelText('Từ cần ôn')).toBeNull()
    unmount()
    render(<QuizResultView result={base} />)
    expect(screen.queryByLabelText('Từ cần ôn')).toBeNull()
  })
  it('từ cần ôn hiển thị như chữ thường, không chạy HTML', () => {
    const { container } = render(<QuizResultView result={{ ...base, review_words: ['<b>x</b>'] }} />)
    expect(container.querySelector('aside b, [aria-label="Từ cần ôn"] b:not(strong b)')).toBeNull()
    expect(screen.getByLabelText('Từ cần ôn').textContent).toContain('<b>x</b>')
  })
})
