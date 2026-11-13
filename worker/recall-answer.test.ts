import { expect, it } from 'vitest'
import { sameRecall, shuffledRecallWords } from '../shared/recall-answer'
import { createTestDb } from './test-db'
import { reviewCard } from './flashcards'

it('accepts punctuation/case differences for phrases, preserving spelling and word order', () => {
  expect(sameRecall('nice to meet you!', 'Nice to meet you.')).toBe(true)
  expect(sameRecall('How are you', 'How are you?')).toBe(true)
  expect(sameRecall('  good   morning ', 'Good morning')).toBe(true)
  expect(sameRecall('nice meet to you', 'Nice to meet you')).toBe(false)
  expect(sameRecall('nice to meat you', 'Nice to meet you')).toBe(false)
  expect(sameRecall('I’m fine', "I'm fine.")).toBe(true)
  expect(sameRecall('Im fine', "I'm fine.")).toBe(false)
})
it('word bank keeps all words including duplicates without publishing the original order', () => {
  const words = shuffledRecallWords('Nice to meet you.')
  expect(words.slice().sort()).toEqual(['Nice','to','meet','you'].sort())
  expect(words.join(' ')).not.toBe('Nice to meet you')
  expect(shuffledRecallWords('very very good').sort()).toEqual(['very','very','good'].sort())
})
it('assisted correct recall does not increase mastery, while genuinely wrong answers still lapse', async () => {
  const db = createTestDb()
  await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at,typed_streak,mastery_started_on) VALUES ('Nice to meet you','meaning','2026-11-13','x',2,'2026-11-01')").run()
  const get = () => db.prepare('SELECT * FROM vocab WHERE id=1').first<any>()
  const r = await reviewCard(db,1,'easy','2026-11-13',false,'nice to meet you!',true)
  expect(r).toMatchObject({ok:true,forced_again:false})
  expect(await get()).toMatchObject({typed_streak:2,learned:0,lapses:0})
  await reviewCard(db,1,'easy','2026-11-14',false,'wrong sentence',true)
  expect(await get()).toMatchObject({typed_streak:0,learned:0,lapses:1})
})
