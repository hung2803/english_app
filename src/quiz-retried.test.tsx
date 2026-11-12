// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuizResultView, type QuizResult } from './components/Quiz'

afterEach(cleanup)

const R: QuizResult = {
  score: 75,
  right: 6,
  total: 8,
  passed: true,
  items: [{ index: 0, type: 'fill', question: 'Q ___', given: 'x', correct: false, answer: 'menu', answer_text: 'menu', explanation_vi: 'vì sao' }],
}

describe('QuizResultView — sau khi làm lại bài tập tới 100%', () => {
  it('hiện điểm cuối 100% và ghi rõ điểm lần làm đầu (không còn hiện % cũ làm điểm chính)', () => {
    render(<QuizResultView result={R} retried={{ finalScore: 100, firstScore: 75 }} />)
    expect(screen.getByLabelText('Điểm').textContent).toBe('100%')
    expect(screen.getByText(/Lần làm đầu: 75% \(đúng 6\/8 câu\)/)).toBeTruthy()
    expect(screen.getByText(/Đã làm lại các câu sai và đạt 100%/)).toBeTruthy()
  })

  it('chưa làm lại: hiện điểm gốc như cũ', () => {
    render(<QuizResultView result={R} />)
    expect(screen.getByLabelText('Điểm').textContent).toBe('75%')
    expect(screen.getByText('Đúng 6/8 câu')).toBeTruthy()
    expect(screen.queryByText(/Lần làm đầu/)).toBeNull()
  })
})
