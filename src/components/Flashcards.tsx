import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sameRecall, shuffledRecallWords } from '../../shared/recall-answer'
import ChoiceRecall from './ChoiceRecall'
import { api } from '../api'
import { Btn, Card, ErrorBox, Speak, Spinner } from '../ui'

export interface FlashCard {
  recall_stage?: 'choice' | 'type'
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
 * Trả lời trước khi hiện từ. Từ sai hoặc dùng gợi ý chỉ được thử lại một lần trong lượt.
 */
export type PracticeScope = 'all' | 'learning' | 'learned' | 'wrong'
export type ReviewStyle = 'mixed' | 'type' | 'listen' | 'choice'

/** So khớp từ người học viết với đáp án: bỏ khoảng trắng thừa, không phân biệt hoa/thường. */
const sameWord = sameRecall

/**
 * Ôn tự do (`practice`): thẻ ngẫu nhiên bất kỳ, kể cả chưa đến hạn. Chỉ "Quên" làm đổi lịch ôn; Khó/Tốt/Dễ giữ nguyên lịch.
 */
export default function Flashcards({ limit = 10, onFinish, practice, style = 'mixed' }: { limit?: number; onFinish?: () => void; practice?: PracticeScope; style?: ReviewStyle }) {
  const [queue, setQueue] = useState<FlashCard[] | null>(null)
  const [batchSize, setBatchSize] = useState(0)
  const [totalDue, setTotalDue] = useState(0)
  const [remaining, setRemaining] = useState(0) // thẻ đến hạn còn lại ngoài lượt này
  const [backlog, setBacklog] = useState(0) // thẻ đến hạn phải chờ sang ngày sau (vượt trần mỗi ngày)
  const [cap, setCap] = useState(0)
  const [done, setDone] = useState(0)
  // Chỉ hiện đáp án sau khi người học trả lời hoặc chọn không nhớ.
  const [phase, setPhase] = useState<'typing' | 'result'>('typing')
  const [hinted, setHinted] = useState(false)
  const [attempts, setAttempts] = useState<Record<number, number>>({})
  const [deferred, setDeferred] = useState(0)
  const [typed, setTyped] = useState('')
  const [typedOk, setTypedOk] = useState<boolean | null>(null)
  const typeBox = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [lastGrade, setLastGrade] = useState<Grade | null>(null)
  const wordBank = useMemo(() => shuffledRecallWords(queue?.[0]?.word ?? ''), [queue?.[0]?.id, queue?.[0]?.word])

  const resetCard = () => {
    setPhase('typing')
    setHinted(false)
    setTyped('')
    setTypedOk(null)
  }

  const load = useCallback(() => {
    setLoadError(null)
    setQueue(null)
    const path = practice ? `/flashcards/practice?scope=${practice}&limit=${limit}` : `/flashcards/due?limit=${limit}`
    api<{ cards: FlashCard[]; total_due: number; backlog?: number; daily_cap?: number }>(path + (style === 'mixed' ? '&adaptive=1' : ''))
      .then((r) => {
        setQueue(r.cards)
        setBatchSize(r.cards.length)
        setTotalDue(r.total_due)
        setRemaining(Math.max(0, r.total_due - r.cards.length))
        setBacklog(r.backlog ?? 0)
        setCap(r.daily_cap ?? 0)
        setDone(0)
        setAttempts({})
        setDeferred(0)
        resetCard()
        setError(null)
      })
      .catch(setLoadError)
  }, [limit, practice, style])
  useEffect(load, [load])
  useEffect(() => {
    if (phase === 'typing') typeBox.current?.focus()
  }, [phase])

  const advance = (g: Grade) => {
    if (!queue?.length) return
    const card = queue[0]
    const retry = g === 'again' && !attempts[card.id]
    setAttempts((a) => ({ ...a, [card.id]: (a[card.id] ?? 0) + 1 }))
    if (g === 'again' && !retry) setDeferred((n) => n + 1)
    setQueue(q => {
      const rest = (q ?? []).slice(1)
      return retry ? [...rest,card] : rest
    })
    if (!retry) setDone(d => d+1)
    resetCard()
  }

  const grade = async (g: Grade) => {
    if (!queue?.length || busy) return
    const card = queue[0]
    setBusy(true)
    setError(null)
    setLastGrade(g)
    try {
      const body = { grade: g, typed, ...(practice ? { practice: true } : {}), ...(hinted ? { assisted: true } : {}) }
      await api(`/flashcards/${card.id}/review`, body)
      advance(g)
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
        <p className="text-lg font-semibold">{practice ? 'Chưa có từ nào trong nhóm này' : '🎉 Không có thẻ nào đến hạn'}</p>
        <p className="text-sm text-slate-600">{practice ? 'Hãy chọn nhóm khác hoặc học thêm bài mới.' : backlog > 0 ? `Bạn đã ôn đủ ${cap} thẻ hôm nay. Còn ${backlog} thẻ chờ sang ngày mai.` : 'Bạn đã ôn hết từ vựng của hôm nay.'}</p>
        {onFinish && <Btn onClick={onFinish}>Tiếp tục</Btn>}
      </Card>
    )
  }

  if (queue.length === 0) {
    return (
      <Card className="space-y-3 text-center">
        <p className="text-lg font-semibold">✅ Xong lượt ôn!</p>
        <p className="text-sm text-slate-600">Bạn đã ôn {done} thẻ.</p>
        {deferred > 0 && <p className="text-sm text-amber-700">Có {deferred} từ cần ôn thêm, đã giữ lại trong lịch ôn.</p>}
        {practice ? (
          <>
            <p className="text-sm text-slate-600">Ôn tự do không đổi lịch ôn, trừ các từ bạn bấm Quên (sẽ đến hạn hôm nay).</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Btn onClick={load}>Ôn thêm 10 từ khác</Btn>
              {onFinish && <Btn variant="ghost" onClick={onFinish}>Xong</Btn>}
            </div>
          </>
        ) : remaining > 0 ? (
          <>
            <p className="text-sm text-slate-600">Còn {remaining} thẻ đến hạn.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Btn onClick={load}>Ôn thêm</Btn>
              {onFinish && <Btn variant="ghost" onClick={onFinish}>Để sau</Btn>}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-emerald-700">{backlog > 0 ? `Bạn đã ôn đủ ${cap} thẻ hôm nay. Còn ${backlog} thẻ chờ sang ngày mai.` : 'Hôm nay bạn đã ôn hết thẻ đến hạn.'}</p>
            {onFinish && <Btn onClick={onFinish}>Tiếp tục</Btn>}
          </>
        )}
      </Card>
    )
  }

  const card = queue[0]
  const phrase = card.word.trim().split(/\s+/).length > 1
  const pct = Math.round((done / batchSize) * 100)
  if (style === 'choice' || (style === 'mixed' && card.recall_stage === 'choice')) {
    return <Card className="space-y-4">
      <p className="text-xs text-slate-500">Chọn đáp án · Đã ôn {done}/{batchSize}{attempts[card.id] ? ' · Thử lại từ sai' : ''}</p>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Tiến độ ôn" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-indigo-600" style={{width:`${pct}%`}} /></div>
      <ChoiceRecall key={`${card.id}-${attempts[card.id] ?? 0}`} id={card.id} practice={!!practice} onDone={correct => advance(correct ? 'good' : 'again')} />
    </Card>
  }
  const listening = (style === 'listen' || (style === 'mixed' && done % 3 === 2)) && typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
  const target = card.word.trim().replace(/^[“”"(.!?]+|[“”").,!?;:]+$/g, '') || card.word
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp('\\b' + escaped + '\\b', 'gi')
  const masked = card.example && pattern.test(card.example) ? card.example.replace(pattern, '_____') : null
  const sentence = masked && /[a-zA-Z]/.test(masked) ? masked : null
  const contextual = style === 'mixed' && done % 3 === 1 && sentence
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
        {phase === 'typing' && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              setTypedOk(sameWord(typed, card.word))
              setPhase('result')
            }}
          >
            <p className="text-xs text-slate-500">{listening ? 'Nghe và viết từ tiếng Anh' : contextual ? 'Điền từ còn thiếu trong câu' : phrase ? 'Gõ lại cụm từ / câu đã học theo nghĩa bên dưới' : 'Nhìn nghĩa, gõ từ tiếng Anh'}</p>
            {!listening && sentence && <div className="rounded-xl bg-indigo-50 p-3 text-left text-sm text-indigo-900"><p className="mb-1 text-xs font-medium">Câu ví dụ · chỗ trống là từ đang ôn</p><p data-testid="recall-context">{sentence}</p></div>}
            {listening ? <Speak text={card.word} label="Nghe từ cần viết" /> : <div className="space-y-1">
              <p className="text-sm text-slate-600">{sentence ? 'Từ cần điền có nghĩa là:' : 'Bạn cần gõ tiếng Anh của:'}</p>
              <p className="text-2xl font-semibold text-slate-900" data-testid="card-meaning">{card.meaning}</p>
              <p className="text-xs text-slate-500">{phrase ? `Chỉ nhập phần còn thiếu gồm ${wordBank.length} từ, không chép cả câu ví dụ.` : 'Chỉ nhập một từ tiếng Anh, không chép cả câu ví dụ.'}</p>
            </div>}
            {phrase && <p className="text-sm text-slate-600">Cần nhập đủ <strong>{wordBank.length} từ</strong> bằng tiếng Anh. Không bắt buộc viết hoa hoặc dấu câu; hãy dùng đúng cụm đã học.</p>}
            <Btn variant="ghost" onClick={() => setHinted(true)}>Gợi ý</Btn>
            {hinted && (phrase ? <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="text-slate-700">Dùng tất cả các từ dưới đây, sắp xếp rồi gõ lại cụm / câu hoàn chỉnh:</p>
              <div className="flex flex-wrap justify-center gap-2" aria-label="Các từ gợi ý">{wordBank.map((word,i) => <span key={i} className="rounded-lg border border-amber-200 bg-white px-2 py-1">{word}</span>)}</div>
              <p className="text-xs text-slate-500">Đúng với gợi ý được tính là luyện có hỗ trợ, chưa cộng ngày xác nhận đã thuộc.</p>
            </div> : <p className="text-sm text-slate-600">{card.meaning} · Bắt đầu bằng “{card.word[0]}”. Đây là lượt luyện có hỗ trợ.</p>)}
            <input
              ref={typeBox}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Viết lại từ tiếng Anh"
              placeholder={listening ? 'Gõ phần bạn vừa nghe' : phrase ? 'Gõ cụm từ / câu tiếng Anh cần ôn' : `Nhập tiếng Anh của “${card.meaning}”`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={200}
              className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-center outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
            <div className="flex justify-center gap-2">
              <Btn type="submit">Kiểm tra</Btn>
              <Btn variant="ghost" onClick={() => { setTyped(''); setTypedOk(false); setPhase('result') }}>Không nhớ</Btn>
            </div>
          </form>
        )}

        {phase === 'result' && (
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2">
              <p className="text-3xl font-bold text-indigo-700" data-testid="card-word">{card.word}</p>
              <Speak text={card.word} />
            </div>
            {card.pos && <p className="text-xs text-slate-500">({card.pos})</p>}
            <p className={`text-sm font-semibold ${typedOk ? 'text-emerald-700' : 'text-rose-700'}`} role="status">
              {typedOk ? hinted ? '✅ Đúng với gợi ý!' : '✅ Đúng rồi!' : typed.trim() ? `❌ Chưa đúng — bạn viết: ${typed.trim()}` : '❌ Chưa nhớ ra từ này'}
            </p>
            <p className="text-xl font-semibold text-slate-900" data-testid="card-meaning">{card.meaning}</p>
            {card.example && (
              <p className="flex items-center justify-center gap-2 text-sm italic text-slate-600">
                <span>{card.example}</span>
                <Speak text={card.example} label="Nghe câu ví dụ" />
              </p>
            )}
          </div>
        )}
      </div>

      {phase === 'result' && (
        <div>
          {typedOk && hinted ? (
            <div className="space-y-2 text-center">
              <p className="text-sm text-slate-600">Đã luyện đúng với hỗ trợ. Lần ôn sau hãy thử tự nhớ; lượt này chưa cộng tiến độ đã thuộc.</p>
              <Btn disabled={busy} onClick={() => void grade('hard')}>Tiếp tục</Btn>
            </div>
          ) : typedOk ? (
            <>
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
            </>
          ) : (
            <>
              <p className="mb-2 text-center text-sm text-slate-600">Từ này được thử lại một lần trong lượt. Nếu vẫn chưa nhớ, từ được giữ trong lịch ôn.</p>
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void grade('again')}
                  className={`min-h-12 rounded-xl border text-sm font-semibold transition disabled:opacity-50 ${GRADES[0].cls}`}
                >
                  {GRADES[0].label}
                </button>
              </div>
            </>
          )}
        </div>
      )}      {error != null && <ErrorBox error={error} onRetry={lastGrade ? () => void grade(lastGrade) : undefined} />}
    </Card>
  )
}
