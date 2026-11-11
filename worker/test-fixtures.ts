// Dữ liệu mẫu dùng chung trong test.

/** Quiz hợp lệ 8 câu (5 trắc nghiệm + 3 điền từ) cho bài có từ vựng order, menu, bill, waiter, tip. */
export const QUIZ8 = [
  { type: 'mcq', question: 'What do you ask for at the end of a meal?', options: ['The bill', 'The door', 'The tree', 'The road'], answer: 0, explanation_vi: 'The bill là hóa đơn.', word: 'bill' },
  { type: 'mcq', question: 'Who brings your food?', options: ['The doctor', 'The waiter', 'The pilot', 'The driver'], answer: 1, explanation_vi: 'Waiter là bồi bàn.', word: 'waiter' },
  { type: 'mcq', question: 'What does "menu" mean?', options: ['Thực đơn', 'Hóa đơn', 'Cái bàn', 'Cái ghế'], answer: 0, explanation_vi: 'Menu là thực đơn.', word: 'menu' },
  { type: 'mcq', question: 'Choose the correct sentence.', options: ['I order tea.', 'I orders tea.', 'I ordering tea.', 'I ordered tea now.'], answer: 0, explanation_vi: 'Chủ ngữ I dùng động từ nguyên mẫu.', word: 'order' },
  { type: 'mcq', question: 'What is a tip?', options: ['Extra money for service', 'A kind of fish', 'A big hat', 'A road sign'], answer: 0, explanation_vi: 'Tip là tiền boa.', word: 'tip' },
  { type: 'fill', question: 'Can I see the ___, please?', answer: 'menu', explanation_vi: 'Xem thực đơn: the menu.', word: 'menu' },
  { type: 'fill', question: 'I would like to ___ a pizza.', answer: 'order', explanation_vi: 'Gọi món: order.', word: 'order' },
  { type: 'fill', question: 'The ___ is friendly and fast.', answer: 'waiter', explanation_vi: 'Bồi bàn: waiter.', word: 'waiter' },
]

/** Bài học hợp lệ (đủ quiz) cho test, ghi đè từng trường khi cần. */
export function lessonJson(over: Record<string, unknown> = {}) {
  return {
    title: 'Ordering food and drinks',
    excerpt: 'Can I have a coffee, please?',
    summary_vi: 'Bài nói về cách gọi đồ ăn thức uống.',
    explanation_vi: 'Người nói gọi cà phê một cách lịch sự.',
    vocab: [
      { word: 'order', pos: 'verb', meaning_vi: 'gọi món', example: 'I want to order a pizza.' },
      { word: 'menu', pos: 'noun', meaning_vi: 'thực đơn', example: 'Can I see the menu?' },
      { word: 'bill', pos: 'noun', meaning_vi: 'hóa đơn', example: 'The bill, please.' },
      { word: 'waiter', pos: 'noun', meaning_vi: 'bồi bàn', example: 'The waiter is friendly.' },
      { word: 'tip', pos: 'noun', meaning_vi: 'tiền boa', example: 'Leave a tip.' },
    ],
    grammar: [{ point: 'Can I have ...?', explanation_vi: 'Câu xin phép lịch sự.', example: 'Can I have some water?' }],
    quiz: QUIZ8,
    ...over,
  }
}
