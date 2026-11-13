import { expect,it } from 'vitest'
import { createTestDb } from './test-db'
import { practiceCards } from './flashcards'
it('wrong-word practice includes quiz errors and forgotten cards, excluding untouched words',async()=>{
 const db=createTestDb();for(const [word,wrong,lapses] of [['quiz',2,0],['forgot',0,1],['fresh',0,0]] as const) await db.prepare("INSERT INTO vocab(word,meaning,due_date,created_at,wrong_count,lapses) VALUES (?,?,'2099-01-01','x',?,?)").bind(word,word,wrong,lapses).run()
 const r=await practiceCards(db,'wrong');expect(r.cards.map(c=>c.word).sort()).toEqual(['forgot','quiz']);expect(r.total_due).toBe(2)
})
