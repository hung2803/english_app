export type Level = 'A0' | 'A1' | 'A2' | 'B1'
export type QuestionKind = 'vocab' | 'grammar' | 'reading'

export interface PlacementQuestion {
  level: Level
  kind: QuestionKind
  /** đoạn văn cho câu đọc hiểu */
  passage?: string
  question: string
  options: string[]
  /** chỉ số đáp án đúng trong options — không gửi cho client */
  answer: number
}

/** 18 câu ≈ 33 giây/câu ≈ 10 phút. Tăng dần độ khó: A0 → A1 → A2 → B1. */
export const BANK: PlacementQuestion[] = [
  // ---- A0 (4) ----
  { level: 'A0', kind: 'vocab', question: 'Which word is a fruit?', options: ['apple', 'chair', 'car', 'book'], answer: 0 },
  { level: 'A0', kind: 'grammar', question: 'I ___ a student.', options: ['is', 'are', 'am', 'be'], answer: 2 },
  { level: 'A0', kind: 'vocab', question: '"Water" nghĩa là gì?', options: ['lửa', 'đất', 'gió', 'nước'], answer: 3 },
  {
    level: 'A0',
    kind: 'reading',
    passage: 'My name is Lan. I am ten. I like cats.',
    question: 'How old is Lan?',
    options: ['Nine', 'Ten', 'Eleven', 'Twelve'],
    answer: 1,
  },

  // ---- A1 (5) ----
  { level: 'A1', kind: 'grammar', question: 'He ___ coffee every morning.', options: ['drink', 'drinking', 'drinks', 'drank'], answer: 2 },
  { level: 'A1', kind: 'grammar', question: 'There ___ two books on the table.', options: ['is', 'am', 'be', 'are'], answer: 3 },
  { level: 'A1', kind: 'vocab', question: '"___ do you live?" — "In Hanoi."', options: ['Who', 'Where', 'When', 'What'], answer: 1 },
  { level: 'A1', kind: 'grammar', question: 'I ___ to the market yesterday.', options: ['went', 'go', 'goes', 'going'], answer: 0 },
  {
    level: 'A1',
    kind: 'reading',
    passage: 'Tom gets up at 6 o\'clock. He eats bread and drinks milk. Then he goes to school by bike.',
    question: 'How does Tom go to school?',
    options: ['By bus', 'On foot', 'By bike', 'By car'],
    answer: 2,
  },

  // ---- A2 (5) ----
  { level: 'A2', kind: 'grammar', question: 'If it rains tomorrow, we ___ at home.', options: ['stay', 'will stay', 'stayed', 'would stay'], answer: 1 },
  { level: 'A2', kind: 'grammar', question: 'She has lived here ___ 2019.', options: ['for', 'from', 'during', 'since'], answer: 3 },
  { level: 'A2', kind: 'vocab', question: 'The opposite of "expensive" is ___.', options: ['heavy', 'early', 'cheap', 'narrow'], answer: 2 },
  { level: 'A2', kind: 'grammar', question: 'You ___ smoke here. It is forbidden.', options: ["mustn't", 'must', "don't have to", 'may'], answer: 0 },
  {
    level: 'A2',
    kind: 'reading',
    passage: 'Last weekend, Mai wanted to go to the beach, but the weather was bad. It rained all day, so she stayed at home and read a book.',
    question: 'Why did Mai stay at home?',
    options: ['She was tired.', 'She had no money.', 'Her friend was ill.', 'It rained.'],
    answer: 3,
  },

  // ---- B1 (4) ----
  { level: 'B1', kind: 'grammar', question: 'If I ___ more time, I would learn Spanish.', options: ['have', 'had', 'will have', 'would have'], answer: 1 },
  { level: 'B1', kind: 'grammar', question: 'The report ___ by the manager yesterday.', options: ['was written', 'wrote', 'is written', 'has written'], answer: 0 },
  { level: 'B1', kind: 'vocab', question: 'He decided to ___ his job because he wanted to work abroad.', options: ['accept', 'borrow', 'repair', 'quit'], answer: 3 },
  {
    level: 'B1',
    kind: 'reading',
    passage:
      'Many people think working from home is easier. However, without a clear schedule, it is easy to work too long and feel tired. Experts suggest taking regular breaks and finishing work at a fixed time.',
    question: 'What do experts advise?',
    options: ['Work longer hours', 'Avoid working from home', 'Take breaks and stop at a fixed time', 'Work without a schedule'],
    answer: 2,
  },
]
