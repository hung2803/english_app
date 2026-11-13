import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Btn, ErrorBox, Speak } from '../ui'

interface Word { word: string; meaning_vi: string; pos?: string; example?: string }
interface Selection extends Word { state: 'available' | 'queued' | 'active'; learned: boolean; recommended: boolean }

export default function LessonVocabulary({ sessionId, words }: { sessionId?: number; words: Word[] }) {
  const [selection, setSelection] = useState<Selection[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(() => {
    if (!sessionId) return
    setError(null)
    return api<{ words: Selection[] }>(`/sessions/${sessionId}/vocabulary`).then(r => setSelection(r.words)).catch(setError)
  }, [sessionId])
  useEffect(() => { setSelection(null); void load() }, [load])

  const choose = async (items: Word[], selected: boolean) => {
    setBusy(true)
    setError(null)
    try {
      for (const w of items) {
        const r = await api<{ words: Selection[] }>(`/sessions/${sessionId}/vocabulary`, { word: w.word, selected })
        setSelection(r.words)
      }
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const suggestions = selection?.filter(w => w.recommended) ?? []
  return (
    <div className="space-y-3">
      {sessionId && <>
        <p className="text-sm text-slate-600">Chọn những từ bạn muốn nhớ. Mỗi ngày ôn tối đa 15 từ, trong đó tối đa 5 từ mới. Từ chọn thêm sẽ chờ theo thứ tự bạn chọn; từ chưa chọn vẫn xem và nghe được tại đây.</p>
        {suggestions.length > 0 && <Btn variant="ghost" disabled={busy} onClick={() => void choose(suggestions, true)}>Chọn {suggestions.length} từ gợi ý</Btn>}
        {selection && <p className="text-xs text-slate-500">Đã chọn {selection.filter(w => w.state !== 'available').length}/{selection.length} từ trong bài</p>}
      </>}
      {error != null && <ErrorBox error={error} onRetry={() => void load()} />}
      <ul className="space-y-3">
        {words.map(v => {
          const chosen = selection?.find(w => w.word.toLowerCase() === v.word.toLowerCase())
          const selected = !!chosen && chosen.state !== 'available'
          return (
            <li key={v.word} className="rounded-xl border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-indigo-700">{v.word}</span><Speak text={v.word} />
                {v.pos && <span className="text-slate-500">({v.pos})</span>}
                <span>— {v.meaning_vi}</span>
                {chosen?.recommended && <span className="rounded-full bg-indigo-50 px-2 text-xs text-indigo-700">Gợi ý</span>}
                {chosen?.learned && <span className="text-xs text-emerald-700">Đã thuộc</span>}
                {chosen?.state === 'queued' && <span className="text-xs text-amber-700">Đã chọn, chờ học</span>}
                {chosen?.state === 'active' && !chosen.learned && <span className="text-xs text-indigo-700">Đang học</span>}
              </div>
              {v.example && <p className="mt-1 flex items-center gap-2 text-slate-500"><span>{v.example}</span><Speak text={v.example} label="Nghe câu ví dụ" /></p>}
              {sessionId && <button
                type="button" disabled={busy || !selection} aria-pressed={selected}
                aria-label={`${selected ? 'Bỏ khỏi ôn tập' : 'Thêm vào ôn tập'}: ${v.word}`}
                onClick={() => void choose([v], !selected)}
                className={`mt-2 min-h-11 rounded-xl border px-3 py-2 font-medium disabled:opacity-50 ${selected ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-300 bg-white text-slate-700'}`}
              >{selected ? '✓ Đã chọn · Bỏ chọn' : '+ Thêm vào ôn tập'}</button>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
