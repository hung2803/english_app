import { fold, reviewCard, type Card } from './flashcards'
import { shuffle } from './quiz'
import { sameRecall } from '../shared/recall-answer'

async function load(db: D1Database, id: number) {
  return db.prepare("SELECT id,word,meaning,pos,example FROM vocab WHERE id = ? AND learning_state = 'active'").bind(id).first<Card>()
}

export async function recallStages(db: D1Database, cards: Card[]) {
  if (!cards.length) return []
  const { results } = await db.prepare('SELECT id, recognized_on, typed_streak, learned FROM vocab').all<{id:number; recognized_on:string|null; typed_streak:number; learned:number}>()
  const states = new Map(results.map(v => [v.id,v]))
  return cards.map(card => {
    const state = states.get(card.id)
    return { ...card, recall_stage: state?.recognized_on || state?.typed_streak || state?.learned ? 'type' as const : 'choice' as const }
  })
}

export async function choiceQuestion(db: D1Database, id: number) {
  const card = await load(db,id)
  if (!card) return null
  const phrase = card.word.trim().split(/\s+/).length > 1
  const { results } = await db.prepare('SELECT word, meaning FROM vocab WHERE id != ? ORDER BY RANDOM() LIMIT 100').bind(id).all<{word:string;meaning:string}>()
  const fallback = phrase
    ? [{word:'Good morning',meaning:'Chào buổi sáng'},{word:'Nice to meet you',meaning:'Rất vui được gặp bạn'},{word:'See you tomorrow',meaning:'Hẹn gặp bạn ngày mai'},{word:'Thank you',meaning:'Cảm ơn'}]
    : [{word:'book',meaning:'quyển sách'},{word:'pen',meaning:'bút'},{word:'bag',meaning:'túi'},{word:'chair',meaning:'ghế'},{word:'apple',meaning:'quả táo'}]
  const options = [card.word]
  for (const candidate of [...results,...fallback]) {
    if ((candidate.word.trim().split(/\s+/).length > 1) !== phrase) continue
    if (fold(candidate.meaning) === fold(card.meaning)) continue
    if (options.some(word => sameRecall(word,candidate.word))) continue
    options.push(candidate.word)
    if (options.length === 4) break
  }
  return { prompt: card.meaning, phrase, options: shuffle(options) }
}

export async function submitChoice(db: D1Database, id: number, choice: string, today: string, practice = false) {
  const card = await load(db,id)
  if (!card) return { ok:false as const, reason:'not_found' as const }
  const correct = sameRecall(choice,card.word)
  const reviewed = await reviewCard(db,id,correct ? 'hard' : 'again',today,practice,choice,true)
  if (!reviewed.ok) return reviewed
  if (correct) await db.prepare('UPDATE vocab SET recognized_on = ? WHERE id = ?').bind(today,id).run()
  return { ok:true as const, correct, word:card.word, meaning:card.meaning, example:card.example, next:reviewed.next }
}
