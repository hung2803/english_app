import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox, Speak, Spinner } from '../ui'

export interface FlashCard {
  id: number
  word: string
  pos: string | null
  meaning: string
  example: string | null
}

type Grade = 'again' | 'hard' | 'good' | 'easy'
const GRADES: { grade: Grade; label: string; cls: string }[] = [
  { grade: 'again', label: 'Quên', cls: 'border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100' },
  { grade: 'hard', label: 'Khó', cls: 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' },
  { grade: 'good', label: 'Tốt', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100' },
  { grade: 'easy', label: 'Dễ', cls: 'border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100' },
]

/**
 * Ôn flashcard lặp lại ngắt quãng. Mỗi lượt ~10 thẻ (≈ 5 phút).
 * Bấm "Hiện nghĩa" rồi tự đánh giá Quên / Khó / Tốt / Dễ.
 * "Quên" đưa thẻ về cuối hàng để ôn lại ngay trong lượt này; 3 mức còn lại hoàn thành thẻ.
 */
export default function Flashcards({ limit = 10, onFinish }: { limit?: number; onFinish?: () => void }) {
  const [queue, setQueue] = useState<FlashCard[] | null>(null)
  const [batchSize, setBatchSize] = useState(0)
  const [totalDue, setTotalDue] = useState(0)
  const [remaining, setRemaining] = useState(0) // thẻ đến hạn còn lại ngoài lượt này
  const [done, setDone] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [lastGrade, setLastGrade] = useState<Grade | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    setQueue(null)
    api<{ cards: FlashCard[]; total_due: number }>(`/flashcards/due?limit=${limit}`)
      .then((r) => {
        setQueue(r.cards)
        setBatchSize(r.cards.length)
        setTotalDue(r.total_due)
        setRemaining(Math.max(0, r.total_due - r.cards.length))
        setDone(0)
        setFlipped(false)
        setError(null)
      })
      .catch(setLoadError)
  }, [limit])
  useEffect(load, [load])

  const grade = async (g: Grade) => {
    if (!queue?.length || busy) return
    const card = queue[0]
    setBusy(true)
    setError(null)
    setLastGrade(g)
    try {
      await api(`/flashcards/${card.id}/review`, { grade: g })
      setQueue((q) => {
        const rest = (q ?? []).slice(1)
        return g === 'again' ? [...rest, card] : rest
      })
      if (g !== 'again') setDone((d) => d + 1)
      setFlipped(false)
    } catch (e) {
      setError(e) // giữ nguyên thẻ, người học bấm thử lại
    } finally {
      setBusy(false)
    }
  }

  if (loadError != null) return <ErrorBox error={loadError} onRetry={load} />
  if (!queue) return <Spinner text="Đang tải thẻ…" />

  if (batchSize === 0) {
    return (
      <Card className="space-y-3 text-center">
        <p className="text-lg font-semibold">🎉 Không có thẻ nào đến hạn</p>
        <p className="text-sm text-slate-600">Bạn đã ôn hết từ vựng của hôm nay.</p>
        {onFinish && <Btn onClick={onFinish}>Tiếp tục</Btn>}
      </Card>
    )
  }

  if (queue.length === 0) {
    return (
      <Card className="space-y-3 text-center">
        <p className="text-lg font-semibold">✅ Xong lượt ôn!</p>
        <p className="text-sm text-slate-600">Bạn đã ôn {done} thẻ.</p>
        {remaining > 0 ? (
          <>
            <p className="text-sm text-slate-600">Còn {remaining} thẻ đến hạn.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Btn onClick={load}>Ôn thêm</Btn>
              {onFinish && <Btn variant="ghost" onClick={onFinish}>Để sau</Btn>}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-emerald-700">Hôm nay bạn đã ôn hết thẻ đến hạn.</p>
            {onFinish && <Btn onClick={onFinish}>Tiếp tục</Btn>}
          </>
        )}
      </Card>
    )
  }

  const card = queue[0]
  const pct = Math.round((done / batchSize) * 100)
  return (
    <Card className="space-y-4">
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
          <span>Đã ôn {done}/{batchSize}</span>
          <span>Còn {queue.length} thẻ trong lượt này{totalDue > batchSize ? ` · ${totalDue} thẻ đến hạn` : ''}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Tiến độ ôn" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="min-h-40 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center" aria-live="polite">
        <div className="flex items-center justify-center gap-2">
          <p className="text-3xl font-bold text-indigo-700" data-testid="card-word">{card.word}</p>
          <Speak text={card.word} />
        </div>
        {card.pos && <p className="mt-1 text-xs text-slate-500">({card.pos})</p>}

        {flipped ? (
          <div className="mt-4 space-y-2">
            <p className="text-xl font-semibold text-slate-900" data-testid="card-meaning">{card.meaning}</p>
            {card.example && (
              <p className="flex items-center justify-center gap-2 text-sm italic text-slate-600">
                <span>{card.example}</span>
                <Speak text={card.example} label="Nghe câu ví dụ" />
              </p>
            )}
          </div>
        ) : (
          <div className="mt-6">
            <Btn onClick={() => setFlipped(true)}>Hiện nghĩa</Btn>
          </div>
        )}
      </div>

      {flipped && (
        <div>
          <p className="mb-2 text-center text-sm text-slate-600">Bạn nhớ từ này thế nào?</p>
          <div className="grid grid-cols-4 gap-2">
            {GRADES.map((g) => (
              <button
                key={g.grade}
                type="button"
                disabled={busy}
                onClick={() => void grade(g.grade)}
                className={`min-h-12 rounded-xl border text-sm font-semibold transition disabled:opacity-50 ${g.cls}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {error != null && <ErrorBox error={error} onRetry={lastGrade ? () => void grade(lastGrade) : undefined} />}
    </Card>
  )
}
