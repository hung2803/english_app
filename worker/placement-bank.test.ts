import { describe, expect, it } from 'vitest'
import { BANK } from './placement-bank'

describe('ngân hàng câu hỏi trình độ', () => {
  it('có 15–20 câu, ≈ 10 phút (25–40 giây/câu)', () => {
    expect(BANK.length).toBeGreaterThanOrEqual(15)
    expect(BANK.length).toBeLessThanOrEqual(20)
    const secondsPerQuestion = (10 * 60) / BANK.length
    expect(secondsPerQuestion).toBeGreaterThanOrEqual(25)
    expect(secondsPerQuestion).toBeLessThanOrEqual(40)
  })

  it('đủ 3 loại: từ vựng, ngữ pháp, đọc hiểu (mỗi loại ≥ 3 câu)', () => {
    for (const kind of ['vocab', 'grammar', 'reading'] as const) {
      expect(BANK.filter((q) => q.kind === kind).length).toBeGreaterThanOrEqual(3)
    }
  })

  it('đủ 4 mức A0/A1/A2/B1, mỗi mức ≥ 4 câu (đủ để xét đạt/không)', () => {
    for (const level of ['A0', 'A1', 'A2', 'B1'] as const) {
      expect(BANK.filter((q) => q.level === level).length).toBeGreaterThanOrEqual(4)
    }
  })

  it('xếp tăng dần theo mức', () => {
    const order = ['A0', 'A1', 'A2', 'B1']
    const idx = BANK.map((q) => order.indexOf(q.level))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('mỗi câu có 4 đáp án khác nhau và đáp án đúng hợp lệ', () => {
    for (const q of BANK) {
      expect(q.options).toHaveLength(4)
      expect(new Set(q.options).size).toBe(4)
      expect(Number.isInteger(q.answer)).toBe(true)
      expect(q.answer).toBeGreaterThanOrEqual(0)
      expect(q.answer).toBeLessThan(4)
      expect(q.question.trim()).not.toBe('')
    }
  })

  it('câu đọc hiểu có đoạn văn, câu khác thì không', () => {
    for (const q of BANK) expect(Boolean(q.passage)).toBe(q.kind === 'reading')
  })

  it('không trùng câu hỏi', () => {
    expect(new Set(BANK.map((q) => q.question)).size).toBe(BANK.length)
  })

  it('vị trí đáp án đúng phân bố đều (mỗi vị trí ≥ 3 câu), không đoán mò được', () => {
    for (let i = 0; i < 4; i++) expect(BANK.filter((q) => q.answer === i).length).toBeGreaterThanOrEqual(3)
  })
})
