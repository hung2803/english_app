import { beforeEach, expect, it } from 'vitest'
import { createTestDb } from './test-db'
import { lessonJson } from './test-fixtures'
import { lessonVocabulary, selectLessonWord } from './word-selection'
import { activateQueued, dueCards, listVocab, reviewCard } from './flashcards'
import { addDays } from './dates'

const DAY = '2026-11-13'
let db: D1Database
beforeEach(async () => {
  db = createTestDb()
  await db.prepare("INSERT INTO plans(id,level,start_date,created_at) VALUES (1,'A1',?,?)").bind(DAY, DAY).run()
  await db.prepare("INSERT INTO sessions(id,plan_id,week_no,seq,scheduled_date,lesson_json) VALUES (1,1,1,1,?,?)").bind(DAY, JSON.stringify(lessonJson())).run()
})
const row = (word: string) => db.prepare('SELECT * FROM vocab WHERE word = ?').bind(word).first<any>()
async function queued(n: number) {
  for (let i = 0; i < n; i++) await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at,learning_state,selected_at) VALUES (?,? ,?,?,'queued',?)").bind(`new${i}`, `meaning${i}`, DAY, DAY, String(i).padStart(3,'0')).run()
}
async function active(n: number) {
  for (let i = 0; i < n; i++) await db.prepare('INSERT INTO vocab(word,meaning,due_date,created_at) VALUES (?,?,?,?)').bind(`old${i}`, 'meaning', DAY, DAY).run()
}
it('suggestions do not enroll words until selected; selection can be removed and added without duplicates', async () => {
  const words = (await lessonVocabulary(db, 1))!
  expect(words.filter(w => w.recommended)).toHaveLength(5)
  expect((await listVocab(db, DAY)).stats.total).toBe(0)
  expect(await selectLessonWord(db, 1, 'menu', true)).toBe(true)
  expect(await row('menu')).toMatchObject({ learning_state: 'queued' })
  await selectLessonWord(db, 1, 'MENU', true)
  expect((await db.prepare('SELECT COUNT(*) AS n FROM vocab').first<any>()).n).toBe(1)
  await selectLessonWord(db, 1, 'menu', false)
  expect(await row('menu')).toMatchObject({ learning_state: 'available' })
  expect((await dueCards(db, DAY)).cards).toEqual([])
  expect(await selectLessonWord(db, 1, 'not in lesson', true)).toBe(false)
})
it('at most five new words are admitted each day, in selection order', async () => {
  await queued(12)
  await Promise.all([activateQueued(db, DAY), activateQueued(db, DAY)])
  expect((await dueCards(db, DAY)).cards.map(w => w.word)).toEqual(['new0','new1','new2','new3','new4'])
  expect((await listVocab(db, DAY, {filter:'queued'})).matched).toBe(7)
  await activateQueued(db, addDays(DAY,1))
  expect(await row('new5')).toMatchObject({learning_state:'active',activated_on:addDays(DAY,1)})
})
it('existing due words reserve the daily budget before new words', async () => {
  await active(12); await queued(8)
  const r = await dueCards(db, DAY, 50)
  expect(r.cards).toHaveLength(15)
  expect((await db.prepare('SELECT COUNT(*) AS n FROM vocab WHERE activated_on = ?').bind(DAY).first<any>()).n).toBe(3)
  await activateQueued(db, DAY)
  expect((await listVocab(db, DAY, {filter:'queued'})).matched).toBe(5)
})
it('a backlog pauses admissions, while retries do not count as extra distinct words', async () => {
  await active(16); await queued(2)
  for (let i=0;i<15;i++) {
    const v=await row(`old${i}`)
    expect((await reviewCard(db,v.id,'again',DAY,false,'')).ok).toBe(true)
  }
  expect(await reviewCard(db,(await row('old15')).id,'good',DAY,false,'old15')).toMatchObject({ok:false,reason:'daily_limit'})
  expect((await reviewCard(db,(await row('old0')).id,'again',DAY,false,'')).ok).toBe(true)
  await activateQueued(db,DAY)
  expect((await row('new0')).learning_state).toBe('queued')
})
it('queued words cannot bypass admission through practice or direct grading', async () => {
  await queued(1)
  expect(await reviewCard(db,(await row('new0')).id,'good',DAY,true,'new0')).toMatchObject({ok:false,reason:'not_active'})
})
it('unselected words stay outside both the due list and the selected vocabulary list', async () => {
  await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at,learning_state,wrong_count) VALUES ('menu','food list',?,?,'available',5)").bind(DAY,DAY).run()
  expect((await dueCards(db,DAY)).cards).toEqual([])
  expect((await listVocab(db,DAY)).stats).toMatchObject({total:0,due:0,queued:0})
  await selectLessonWord(db,1,'menu',true)
  expect((await dueCards(db,DAY)).cards.map(w=>w.word)).toEqual(['menu'])
})
it('mastery requires three different days spanning a week and is revoked on a miss', async () => {
  await active(1); const id=(await row('old0')).id
  for(let i=0;i<4;i++) await reviewCard(db,id,'good',DAY,false,'old0')
  expect(await row('old0')).toMatchObject({typed_streak:1,learned:0})
  await reviewCard(db,id,'good',addDays(DAY,1),false,'old0')
  await reviewCard(db,id,'good',addDays(DAY,3),false,'old0')
  expect(await row('old0')).toMatchObject({typed_streak:3,learned:0})
  await reviewCard(db,id,'good',addDays(DAY,7),false,'old0')
  expect(await row('old0')).toMatchObject({learned:1})
  await reviewCard(db,id,'again',addDays(DAY,8),false,'')
  expect(await row('old0')).toMatchObject({learned:0,typed_streak:0,mastery_started_on:null,last_success_on:null})
})
it('selecting an existing word preserves its schedule and mastery', async () => {
  await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at,learned,interval_days) VALUES ('menu','meaning','2027-01-01',?,1,40)").bind(DAY).run()
  await selectLessonWord(db,1,'menu',true)
  expect(await row('menu')).toMatchObject({learning_state:'active',learned:1,interval_days:40,due_date:'2027-01-01'})
})
