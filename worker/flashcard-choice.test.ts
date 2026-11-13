import { beforeEach, expect, it } from 'vitest'
import { createTestDb } from './test-db'
import { choiceQuestion, recallStages, submitChoice } from './flashcard-choice'
import { dueCards, listVocab } from './flashcards'
import { vocabMastery } from '../shared/vocab-mastery'

let db: D1Database
const DAY='2026-11-13'
beforeEach(async()=>{
  db=createTestDb()
  await db.prepare("INSERT INTO vocab(word,meaning,example,due_date,created_at) VALUES ('book','quyển sách','This is a red book.',?,?)").bind(DAY,DAY).run()
})
const card=()=>db.prepare('SELECT * FROM vocab WHERE id=1').first<any>()
it('offers four unique choices from the meaning, with no answer key or example before answering',async()=>{
  const q=(await choiceQuestion(db,1))!
  expect(q.prompt).toBe('quyển sách');expect(q.options).toHaveLength(4)
  expect(new Set(q.options.map(s=>s.toLowerCase())).size).toBe(4)
  expect(q.options).toContain('book');expect(q).not.toHaveProperty('answer');expect(q).not.toHaveProperty('example')
})
it('supports full phrases with phrase distractors',async()=>{
  await db.prepare("UPDATE vocab SET word='Nice to meet you',meaning='Rất vui được gặp bạn' WHERE id=1").run()
  const q=(await choiceQuestion(db,1))!
  expect(q.phrase).toBe(true);expect(q.options).toHaveLength(4)
  expect(q.options.every(word=>word.includes(' '))).toBe(true)
})
it('recognition advances to typing without granting independent recall or mastery',async()=>{
  const due=await dueCards(db,DAY)
  expect((await recallStages(db,due.cards))[0].recall_stage).toBe('choice')
  expect(await submitChoice(db,1,'book',DAY)).toMatchObject({ok:true,correct:true,word:'book'})
  expect(await card()).toMatchObject({recognized_on:DAY,typed_streak:0,learned:0,mastery_started_on:null})
  expect((await recallStages(db,due.cards))[0].recall_stage).toBe('type')
  expect(vocabMastery(await card(),DAY)).toMatchObject({level:'recognized',progress:0})
  for(const day of ['2026-11-15','2026-11-20','2026-12-01'])await submitChoice(db,1,'book',day)
  expect(await card()).toMatchObject({typed_streak:0,learned:0})
  expect((await listVocab(db,'2026-12-01',{level:'recognized'})).matched).toBe(1)
})
it('a wrong choice is graded on the server and returns the correction',async()=>{
  await db.prepare("UPDATE vocab SET recognized_on=?,typed_streak=3,learned=1 WHERE id=1").bind(DAY).run()
  const r=await submitChoice(db,1,'chair',DAY)
  expect(r).toMatchObject({ok:true,correct:false,word:'book',meaning:'quyển sách',example:'This is a red book.'})
  expect(await card()).toMatchObject({recognized_on:null,typed_streak:0,learned:0,lapses:1})
})
it('does not admit queued words or bypass the daily review budget',async()=>{
  for(let i=0;i<15;i++)await db.prepare('INSERT INTO vocab(word,meaning,due_date,created_at,reviewed_on) VALUES (?,?,?,?,?)').bind('done'+i,'meaning','2099-01-01',DAY,DAY).run()
  expect(await submitChoice(db,1,'book',DAY)).toMatchObject({ok:false,reason:'daily_limit'})
  expect((await card()).recognized_on).toBeNull()
  await db.prepare("UPDATE vocab SET learning_state='queued' WHERE id=1").run()
  expect(await choiceQuestion(db,1)).toBeNull()
})
