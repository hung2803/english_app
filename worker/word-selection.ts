import { todayVN } from './dates'

interface LessonWord { word: string; meaning_vi: string; pos?: string; example?: string }
const norm = (s: string) => s.trim().toLowerCase()

async function lessonWords(db: D1Database, id: number): Promise<LessonWord[] | null> {
  const row = await db.prepare('SELECT lesson_json FROM sessions WHERE id = ?').bind(id).first<{ lesson_json: string | null }>()
  if (!row?.lesson_json) return null
  try { return (JSON.parse(row.lesson_json) as { vocab: LessonWord[] }).vocab ?? [] } catch { return null }
}

export async function lessonVocabulary(db: D1Database, id: number) {
  const words = await lessonWords(db, id)
  if (!words) return null
  const { results } = await db.prepare('SELECT word, learning_state, learned, typed_streak FROM vocab').all<{ word: string; learning_state: string; learned: number; typed_streak: number }>()
  const byWord = new Map(results.map(w => [norm(w.word), w]))
  let suggestions = 0
  return words.map(w => {
    const row = byWord.get(norm(w.word))
    const state = row?.learning_state ?? 'available'
    const recommended = state === 'available' && row?.learned !== 1 && suggestions++ < 5
    return { ...w, state, learned: row?.learned === 1, remembered_days: row?.typed_streak ?? 0, recommended }
  })
}

export async function selectLessonWord(db: D1Database, id: number, word: string, selected: boolean) {
  const words = await lessonWords(db, id)
  const v = words?.find(w => norm(w.word) === norm(word))
  if (!v) return false
  if (!selected) {
    await db.prepare("UPDATE vocab SET learning_state = 'available', selected_at = NULL WHERE lower(word) = lower(?)").bind(v.word).run()
  } else {
    const today = todayVN()
    await db.prepare(`INSERT INTO vocab (word, meaning, pos, example, session_id, due_date, created_at, learning_state, selected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      ON CONFLICT DO UPDATE SET
        selected_at = CASE WHEN vocab.learning_state = 'available' THEN excluded.selected_at ELSE vocab.selected_at END,
        learning_state = CASE WHEN vocab.learning_state = 'available' THEN 'queued' ELSE vocab.learning_state END`)
      .bind(v.word, v.meaning_vi, v.pos ?? null, v.example ?? null, id, today, today, new Date().toISOString()).run()
  }
  return true
}
