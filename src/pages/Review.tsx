import { useNavigate, useSearchParams } from 'react-router-dom'
import Flashcards, { type ReviewStyle, type PracticeScope } from '../components/Flashcards'
import { PageTitle } from '../ui'

const SCOPES: PracticeScope[] = ['all', 'learning', 'learned', 'wrong']
const SCOPE_LABEL: Record<PracticeScope, string> = { wrong: 'các từ hay sai', all: 'tất cả các từ', learning: 'các từ đang học', learned: 'các từ đã thuộc' }

/**
 * Ôn flashcard riêng (ngoài buổi học), ~10 thẻ mỗi lượt.
 * Mặc định ôn các thẻ đến hạn. `?mode=practice&scope=all|learning|learned` = ôn tự do: thẻ ngẫu nhiên bất kỳ, kể cả chưa đến hạn.
 */
export default function Review() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const scopeParam = params.get('scope') as PracticeScope
  const style: ReviewStyle = params.get('style') === 'choice' ? 'choice' : params.get('style') === 'type' ? 'type' : params.get('style') === 'listen' ? 'listen' : 'mixed'
  const practice = params.get('mode') === 'practice' ? (SCOPES.includes(scopeParam) ? scopeParam : 'all') : undefined
  const selectStyle = (key: ReviewStyle | 'wrong') => {
    const next = new URLSearchParams(params)
    if (key === 'wrong') {
      next.set('mode', 'practice')
      next.set('scope', 'wrong')
      next.set('style', 'mixed')
    } else {
      next.set('style', key)
      if (practice === 'wrong') {
        next.delete('mode')
        next.delete('scope')
      }
    }
    setParams(next)
  }
  return (
    <>
      <PageTitle
        title={practice ? 'Ôn tự do' : 'Ôn từ vựng'}
        hint={practice ? `Ôn ${SCOPE_LABEL[practice]}, không cần đến hạn. Mỗi lượt khoảng 10 thẻ.` : 'Mỗi lượt khoảng 10 thẻ, mất chừng 5 phút.'}
      />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Kiểu ôn tập">
        {([
          ['mixed', 'Ôn theo tiến độ'], ['choice', 'Chọn đáp án'], ['type', 'Luyện gõ từ'],
          ['listen', 'Nghe và viết'], ['wrong', 'Ôn từ hay sai'],
        ] as const).map(([key, label]) => {
          const active = key === 'wrong' ? practice === 'wrong' : style === key && practice !== 'wrong'
          return (
            <button
              key={key}
              className={`min-h-11 rounded-xl border px-3 py-2 text-sm ${active ? 'border-indigo-500 bg-indigo-100 font-semibold text-indigo-700' : 'border-slate-300 bg-white text-slate-600'}`}
              aria-pressed={active}
              onClick={() => selectStyle(key)}
            >{label}</button>
          )
        })}
      </div>
      <p className="mb-3 text-xs text-slate-500">Từ mới: chọn đúng nghĩa trước. Khi đã nhận biết, chuyển sang tự gõ hoặc nghe. Trắc nghiệm đúng ghi nhận “Nhận biết được”; tự nhớ qua nhiều ngày mới đạt “Đã thuộc”. Từ sai được thử lại một lần.</p>
      <Flashcards key={style + practice} style={style} practice={practice} onFinish={() => navigate('/vocab')} />
    </>
  )
}
