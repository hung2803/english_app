// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LessonSteps, { STEP_MINUTES, TOTAL_STUDY_MINUTES, splitSentences, lessonReading, type LessonData } from './components/LessonSteps'
import Quiz, { QuizResultView, type QuizQuestion, type QuizResult } from './components/Quiz'
import ExerciseReview from './components/ExerciseReview'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const LESSON: LessonData = {
  title: 'My day',
  source: { type: 'ai', title: 'AI', ai_written: true },
  excerpt: 'I wake up at six. I eat breakfast.',
  summary_vi: 'Bài nói về một ngày.',
  explanation_vi: 'Giải thích tiếng Việt của bài.',
  goals_vi: ['Nói về thói quen hằng ngày'],
  vocab: [{ word: 'wake up', pos: 'verb', meaning_vi: 'thức dậy', example: 'I wake up early.' }],
  grammar: [{ point: 'Present simple', explanation_vi: 'Dùng cho thói quen.', example: 'I get up.', examples: ['I wake up at six.', 'I eat breakfast.'] }],
  grammar_practice: [
    { question: 'I ___ up at six.', answer: 'wake', explanation_vi: 'Chủ ngữ I.' },
    { question: 'She ___ tea.', answer: 'drinks' },
  ],
  sentences: [
    { en: 'I wake up at six.', vi: 'Tôi thức dậy lúc sáu giờ.' },
    { en: 'I eat breakfast.', vi: 'Tôi ăn sáng.' },
  ],
  task: { en: 'Write 5 sentences about yourself.', vi: 'Viết 5 câu về bản thân.' },
}
const mount = (l: LessonData = LESSON) => render(<MemoryRouter><LessonSteps l={l} chat={<div data-testid="chat-slot">chat</div>} /></MemoryRouter>)

describe('buổi học 4 bước + quiz', () => {
  it('hiện bài đọc ngay khi mở buổi học dù giải thích thu gọn và lượt nghe 1 ẩn phụ đề', () => {
    mount()
    const reading = screen.getByTestId('lesson-reading')
    expect(reading.textContent).toBe('I wake up at six. I eat breakfast.')
    expect(reading.closest('[hidden]')).toBeNull()
    expect(screen.getByRole('button', {name:/Xem giải thích nội dung bài/}).getAttribute('aria-expanded')).toBe('false')
    expect(within(screen.getByTestId('listen-pass-1')).queryByText('I wake up at six.')).toBeNull()
  })
  it('ưu tiên bài đọc đầy đủ, rồi các câu tiếng Anh và cuối cùng đoạn trích của bài cũ', () => {
    expect(lessonReading({...LESSON,reading:'Full English reading.'})).toBe('Full English reading.')
    expect(lessonReading({...LESSON,reading:'  ',excerpt:'Short excerpt.'})).toBe('I wake up at six. I eat breakfast.')
    expect(lessonReading({...LESSON,reading:undefined,sentences:undefined})).toBe(LESSON.excerpt)
    mount({...LESSON,sentences:undefined})
    expect(screen.getByTestId('lesson-reading').textContent).toBe(LESSON.excerpt)
  })
  it('50 phút học (10 + 12 + 13 + 15) và 10 phút quiz; hiện đủ 4 bước theo thứ tự', () => {
    expect(TOTAL_STUDY_MINUTES).toBe(50)
    expect(Object.values(STEP_MINUTES)).toEqual([10, 12, 13, 15])
    mount()
    expect(screen.getByTestId('session-plan').textContent).toContain('60 phút: 50 phút học')
    expect(screen.getByTestId('session-plan').textContent).toContain('10 phút quiz')
    const steps = [1, 2, 3, 4].map((n) => screen.getByTestId(`step-${n}`).textContent)
    expect(steps[0]).toContain('Ôn cũ và học từ mới')
    expect(steps[1]).toContain('ngữ pháp')
    expect(steps[2]).toContain('Nghe')
    expect(steps[3]).toContain('Nói và viết')
    expect(steps.map((s) => /(\d+) phút/.exec(s!)![1])).toEqual(['10', '12', '13', '15'])
    expect(screen.getByTestId('chat-slot')).toBeTruthy() // khung chat nằm trong bước 4
  })

  it('bước 1: nút ôn thẻ đến hạn và từ mới có loại từ, nghĩa, ví dụ', () => {
    mount()
    expect(screen.getByText('Ôn các thẻ đến hạn').closest('a')!.getAttribute('href')).toBe('/review')
    expect(screen.getByText('wake up')).toBeTruthy()
    expect(screen.getByText(/thức dậy/)).toBeTruthy()
    expect(screen.getByText('I wake up early.')).toBeTruthy()
  })

  it('bước 2: một điểm ngữ pháp, các câu ví dụ để chép vào vở', () => {
    mount()
    expect(screen.getByText('Present simple')).toBeTruthy()
    expect(screen.getByText('Chép các ví dụ này vào vở')).toBeTruthy()
    expect(screen.getByText('I wake up at six.', { selector: 'span' })).toBeTruthy()
  })

  it('bước 2: bài tập tự chấm — đáp án chỉ hiện sau khi bấm "Xem đáp án", báo đúng/chưa khớp', () => {
    mount()
    expect(screen.queryByTestId('practice-answer-0')).toBeNull()
    fireEvent.change(screen.getByLabelText('Bài tập ngữ pháp 1'), { target: { value: 'Wake' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Xem đáp án' })[0])
    expect(screen.getByTestId('practice-answer-0').textContent).toContain('✅ Đúng')
    expect(screen.getByTestId('practice-answer-0').textContent).toContain('Chủ ngữ I.')
    fireEvent.change(screen.getByLabelText('Bài tập ngữ pháp 2'), { target: { value: 'drink' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Xem đáp án' })[1])
    expect(screen.getByTestId('practice-answer-1').textContent).toContain('❌ Chưa khớp')
    expect(screen.getByTestId('practice-answer-1').textContent).toContain('drinks')
  })

  it('bước 3: nghe 3 lượt — lượt 1 không có chữ; lượt 2 có phụ đề tiếng Anh; lượt 3 từng câu, bản dịch bật/tắt', () => {
    mount()
    expect(screen.getByTestId('listen-pass-1')).toBeTruthy()
    expect(within(screen.getByTestId('listen-pass-1')).queryByText('I wake up at six.')).toBeNull() // lượt 1: không phụ đề

    fireEvent.click(screen.getByRole('tab', { name: /Lượt 2/ }))
    const pass2 = screen.getByTestId('listen-pass-2')
    expect(within(pass2).getByText('I wake up at six.')).toBeTruthy()
    expect(within(pass2).queryByText('Tôi thức dậy lúc sáu giờ.')).toBeNull() // chưa dịch ở lượt 2

    fireEvent.click(screen.getByRole('tab', { name: /Lượt 3/ }))
    expect(screen.queryByTestId('vi-0')).toBeNull() // bản dịch tắt mặc định
    fireEvent.click(screen.getByLabelText('Hiện bản dịch tiếng Việt'))
    expect(screen.getByTestId('vi-0').textContent).toBe('Tôi thức dậy lúc sáu giờ.')
    expect(screen.getByTestId('vi-1').textContent).toBe('Tôi ăn sáng.')
    fireEvent.click(screen.getByLabelText('Hiện bản dịch tiếng Việt'))
    expect(screen.queryByTestId('vi-0')).toBeNull()
  })

  it('bài cũ chưa có câu kèm dịch: tự tách bài đọc thành câu, không hiện nút bản dịch', () => {
    expect(splitSentences('I wake up. Do you? Yes!').map((s) => s.en)).toEqual(['I wake up.', 'Do you?', 'Yes!'])
    mount({ ...LESSON, sentences: undefined })
    fireEvent.click(screen.getByRole('tab', { name: /Lượt 3/ }))
    expect(within(screen.getByTestId('listen-pass-3')).getByText('I eat breakfast.')).toBeTruthy()
    expect(screen.queryByLabelText('Hiện bản dịch tiếng Việt')).toBeNull()
  })

  it('bước 3: không có micro/ghi âm thì báo nhẹ nhàng, không lỗi', () => {
    mount()
    fireEvent.click(screen.getByRole('tab', { name: /Lượt 3/ }))
    expect(screen.getAllByText('Trình duyệt này chưa hỗ trợ ghi âm.').length).toBeGreaterThan(0)
  })

  it('bước 4: đề bài viết 5 câu về bản thân, hướng dẫn sửa lỗi, đọc to, ghi âm', () => {
    mount()
    expect(screen.getByText('Viết 5 câu về bản thân.')).toBeTruthy()
    expect(screen.getByText(/Viết 5 câu về bản thân vào khung chat/)).toBeTruthy()
    expect(screen.getByText(/Nhại theo giọng mẫu 10 phút/)).toBeTruthy()
  })

  it('giải thích nội dung bài (tiếng Việt) thu gọn, bấm để xem', () => {
    mount()
    const btn = screen.getByRole('button', { name: /Xem giải thích nội dung bài/ })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(screen.getByRole('button', { name: 'Ẩn giải thích' }).getAttribute('aria-expanded')).toBe('true')
  })
})

describe('quiz 5 dạng câu hỏi', () => {
  const QUIZ: QuizQuestion[] = [
    { type: 'mcq', question: 'Who brings food?', options: ['The doctor', 'The waiter', 'The pilot', 'The driver'] },
    { type: 'fill', question: 'She ___ (go) to school.' },
    { type: 'rewrite', question: 'Rewrite as a question: "He likes coffee."' },
    { type: 'order', question: 'Put the words in order.', words: ['early', 'I', 'up', 'get'] },
    { type: 'error', question: 'She [[go]] to school.' },
  ]
  function server() {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(init!.body as string))
      return Response.json({ result: {} })
    }))
    return calls
  }

  it('mỗi câu có nhãn dạng + gợi ý; câu "tìm lỗi" gạch chân đúng phần bị đánh dấu; có đồng hồ 10 phút', () => {
    mount_quiz()
    expect(screen.getByRole('timer').textContent).toBe('10:00')
    expect(screen.getByText('Quiz cuối buổi (10 phút)')).toBeTruthy()
    const kinds = [0, 1, 2, 3, 4].map((i) => screen.getByTestId(`quiz-kind-${i}`).textContent)
    expect(kinds).toEqual(['Trắc nghiệm', 'Điền vào chỗ trống', 'Viết lại câu', 'Sắp xếp từ thành câu', 'Tìm và sửa lỗi sai'])
    const u = document.querySelector('legend u')!
    expect(u.textContent).toBe('go') // phần [[go]] được gạch chân, không hiện dấu [[ ]]
    expect(screen.queryByText(/\[\[/)).toBeNull()
  })

  function mount_quiz() {
    return render(<Quiz sessionId={7} quiz={QUIZ} onSubmitted={() => {}} />)
  }

  it('sắp xếp từ: bấm từ để ghép câu, bấm "Bỏ từ cuối"/"Xóa hết"; mỗi từ chỉ dùng một lần', () => {
    mount_quiz()
    const group = screen.getByRole('group', { name: 'Sắp xếp câu 4' })
    const pick = (w: string) => fireEvent.click(within(group).getByRole('button', { name: w }))
    expect(screen.getByTestId('order-sentence').textContent).toContain('Bấm các từ')
    pick('I'); pick('get'); pick('up'); pick('early')
    expect(screen.getByTestId('order-sentence').textContent).toBe('I get up early')
    expect((within(group).getByRole('button', { name: 'I' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(group).getByRole('button', { name: 'Bỏ từ cuối' }))
    expect(screen.getByTestId('order-sentence').textContent).toBe('I get up')
    fireEvent.click(within(group).getByRole('button', { name: 'Xóa hết' }))
    expect(screen.getByTestId('order-sentence').textContent).toContain('Bấm các từ')
  })

  it('nộp bài: gửi chuỗi cho mọi dạng chữ (điền, viết lại, ghép câu, sửa lỗi) và chỉ số cho trắc nghiệm', async () => {
    const calls = server()
    mount_quiz()
    fireEvent.click(within(screen.getAllByRole('group')[0]).getByLabelText('The waiter'))
    fireEvent.change(screen.getByLabelText('Đáp án câu 2'), { target: { value: ' goes ' } })
    fireEvent.change(screen.getByLabelText('Đáp án câu 3'), { target: { value: 'Does he like coffee?' } })
    const group = screen.getByRole('group', { name: 'Sắp xếp câu 4' })
    for (const w of ['I', 'get', 'up', 'early']) fireEvent.click(within(group).getByRole('button', { name: w }))
    fireEvent.change(screen.getByLabelText('Đáp án câu 5'), { target: { value: 'goes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Nộp bài' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ answers: [1, 'goes', 'Does he like coffee?', 'I get up early', 'goes'] })
  })

  it('kết quả: hiện nhãn dạng, câu gạch chân, các từ cho sẵn, đáp án đúng của câu "tìm lỗi" là câu đã sửa', () => {
    const result: QuizResult = {
      score: 50, right: 1, total: 2, passed: false,
      items: [
        { index: 0, type: 'order', question: 'Put the words in order.', words: ['up', 'I'], given: 'up I', correct: false, answer: 'I up.', answer_text: 'I up.', explanation_vi: 'Giải thích.' },
        { index: 1, type: 'error', question: 'She [[go]] to school.', given: 'goes', correct: true, answer: 'goes', answer_text: 'She goes to school.', explanation_vi: 'Ngôi thứ ba.' },
      ],
    }
    render(<QuizResultView result={result} />)
    expect(screen.getByText('Sắp xếp từ thành câu')).toBeTruthy()
    expect(screen.getByText('Tìm và sửa lỗi sai')).toBeTruthy()
    expect(screen.getByText(/Các từ cho sẵn: up \/ I/)).toBeTruthy()
    expect(document.querySelector('li u')!.textContent).toBe('go')
    expect(screen.getByText('I up.')).toBeTruthy()
  })
})

describe('làm lại câu sai dạng mới', () => {
  it('câu sắp xếp từ và tìm lỗi sai: ghép câu / gõ phần sửa rồi nộp; câu hỏi gạch chân phần lỗi', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
      if (key.startsWith('GET')) {
        return Response.json({
          status: { prev_seq: 1, remaining: 2, round: 0 },
          questions: [
            { index: 3, type: 'order', question: 'Put the words in order.', words: ['early', 'I', 'up', 'get'] },
            { index: 4, type: 'error', question: 'She [[go]] to school.' },
          ],
        })
      }
      calls.push(JSON.parse(init!.body as string))
      return Response.json({ passed: true, round: 1, remaining: 0, results: [] })
    }))
    render(<ExerciseReview sessionId={9} onPassed={() => {}} />)
    await screen.findByTestId('exercise-question')
    expect(screen.getByTestId('exercise-kind').textContent).toContain('Sắp xếp từ thành câu')
    const group = screen.getByRole('group', { name: 'Sắp xếp câu' })
    for (const w of ['I', 'get', 'up', 'early']) fireEvent.click(within(group).getByRole('button', { name: w }))
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }))
    await waitFor(() => expect(screen.getByTestId('exercise-kind').textContent).toContain('Tìm và sửa lỗi sai'))
    expect(screen.getByTestId('exercise-question').querySelector('u')!.textContent).toBe('go')
    fireEvent.change(screen.getByLabelText('Đáp án'), { target: { value: 'goes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Nộp' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ answers: [{ index: 3, choice: 'I get up early' }, { index: 4, choice: 'goes' }] })
  })
})
