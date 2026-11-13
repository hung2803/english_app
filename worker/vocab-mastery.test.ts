import { expect, it } from 'vitest'
import { vocabMastery } from '../shared/vocab-mastery'
import { createTestDb } from './test-db'
import { listVocab } from './flashcards'

const TODAY = '2026-11-13'
it('reports recall milestones without inferring mastery from a due date or elapsed time', () => {
  expect(vocabMastery({ learned: 0 }, TODAY)).toMatchObject({ level: 'new', progress: 0 })
  expect(vocabMastery({ learned: 0, lapses: 1 }, TODAY)).toMatchObject({ level: 'relearn', progress: 0 })
  expect(vocabMastery({ learned: 0, typed_streak: 1, mastery_started_on: TODAY }, TODAY)).toMatchObject({ level: 'learning', progress: 25 })
  expect(vocabMastery({ learned: 0, typed_streak: 2, mastery_started_on: '2026-11-11' }, TODAY)).toMatchObject({ level: 'almost', days: 2, span: 2, progress: 50 })
  expect(vocabMastery({ learned: 0, typed_streak: 3, mastery_started_on: '2026-11-01' }, TODAY).progress).toBe(75)
  expect(vocabMastery({ learned: 1 }, TODAY)).toMatchObject({ level: 'learned', progress: 100 })
  expect(vocabMastery({ learned: 0, typed_streak: 3, learning_state: 'queued' }, TODAY)).toMatchObject({ level: 'queued', progress: 0 })
})
it('handles historical wrong counts and invalid dates without hiding newer successful recall', () => {
  expect(vocabMastery({ learned: 0, wrong_count: 9, typed_streak: 2, mastery_started_on: 'invalid' }, TODAY)).toMatchObject({ level: 'almost', span: 0, progress: 50 })
  expect(vocabMastery({ learned: 0, typed_streak: 1, mastery_started_on: '2099-01-01' }, TODAY).span).toBe(0)
})
it('filters globally before pagination and prioritizes due words before future reviews', async () => {
  const db = createTestDb()
  for (let i = 0; i < 55; i++) await db.prepare('INSERT INTO vocab(word,meaning,due_date,created_at,typed_streak) VALUES (?,?,?,?,2)').bind(`almost${i}`, 'meaning', '2099-01-01', TODAY).run()
  await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at,lapses) VALUES ('weak','meaning','2099-01-01',?,1)").bind(TODAY).run()
  await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at,learned) VALUES ('known-due','meaning',?,?,1)").bind(TODAY,TODAY).run()
  const page = await listVocab(db,TODAY,{level:'almost',page:2,order:'priority'})
  expect(page.matched).toBe(55)
  expect(page.items).toHaveLength(5)
  expect(page.items.every(w => w.typed_streak === 2)).toBe(true)
  const sorted = await listVocab(db,TODAY,{order:'priority'})
  expect(sorted.items[0].word).toBe('known-due')
  expect(sorted.items[1].word).toBe('weak')
  expect((await listVocab(db,TODAY,{level:'relearn',q:'weak'})).matched).toBe(1)
})
