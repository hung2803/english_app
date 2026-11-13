import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Btn, ErrorBox, Speak, Spinner } from '../ui'

interface Question { prompt: string; phrase: boolean; options: string[] }
interface Result { correct: boolean; word: string; meaning: string; example: string | null }

export default function ChoiceRecall({ id, practice, onDone }: { id: number; practice: boolean; onDone: (correct: boolean) => void }) {
  const [question,setQuestion] = useState<Question | null>(null)
  const [result,setResult] = useState<Result | null>(null)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState<unknown>(null)
  const [selected,setSelected] = useState('')
  const load = useCallback(() => {
    setError(null)
    return api<Question>(`/flashcards/${id}/choice`).then(setQuestion).catch(setError)
  },[id])
  useEffect(() => {void load()},[load])
  const choose = async (choice: string) => {
    if (busy || result) return
    setBusy(true);setSelected(choice);setError(null)
    try {setResult(await api<Result>(`/flashcards/${id}/choice`,{choice,...(practice ? {practice:true} : {})}))}
    catch(e) {setError(e)} finally {setBusy(false)}
  }
  if (!question) return error ? <ErrorBox error={error} onRetry={() => void load()} /> : <Spinner text="Đang tải đáp án lựa chọn…" />
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-indigo-50 p-5 text-center">
        <p className="text-sm text-slate-600">{question.phrase ? 'Cụm tiếng Anh nào có nghĩa là:' : 'Từ tiếng Anh nào có nghĩa là:'}</p>
        <p className="mt-2 text-2xl font-semibold text-slate-900">{question.prompt}</p>
      </div>
      {!result ? <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Chọn đáp án">
        {question.options.map((option,i) => <button key={option} type="button" disabled={busy}
          onClick={() => void choose(option)}
          className={`min-h-14 rounded-xl border p-3 text-left font-medium disabled:opacity-60 ${selected === option ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-white hover:bg-indigo-50'}`}>
          <span className="mr-2 text-xs text-slate-400">{String.fromCharCode(65+i)}.</span>{' '}{option}
        </button>)}
      </div> : <div className="space-y-3" role="status">
        <p className={`font-semibold ${result.correct ? 'text-emerald-700' : 'text-rose-700'}`}>{result.correct ? '✓ Nhận biết được!' : 'Chưa đúng · xem lại đáp án'}</p>
        {!result.correct && <p className="text-sm text-slate-500">Bạn chọn: {selected}</p>}
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="flex items-center gap-2 text-xl font-semibold text-indigo-700">{result.word}<Speak text={result.word} /></p>
          <p className="mt-1 text-sm">{result.meaning}</p>
          {result.example && <p className="mt-2 flex items-center gap-2 text-sm italic text-slate-500"><span>{result.example}</span><Speak text={result.example} label="Nghe câu ví dụ" /></p>}
        </div>
        <p className="text-xs text-slate-500">{result.correct ? 'Đã nhận biết đúng nghĩa. Chế độ “Ôn theo tiến độ” sẽ chuyển sang luyện tự gõ hoặc nghe ở lượt sau; trắc nghiệm không cộng ngày xác nhận đã thuộc.' : 'Từ này sẽ được thử lại một lần trong lượt, sau đó giữ trong lịch ôn nếu vẫn chưa nhớ.'}</p>
        <Btn onClick={() => onDone(result.correct)}>Tiếp tục</Btn>
      </div>}
      {error != null && <ErrorBox error={error} onRetry={() => void choose(selected)} />}
    </div>
  )
}
