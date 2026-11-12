import { useNavigate, useSearchParams } from 'react-router-dom'
import Flashcards, { type PracticeScope } from '../components/Flashcards'
import { PageTitle } from '../ui'

const SCOPES: PracticeScope[] = ['all', 'learning', 'learned']
const SCOPE_LABEL: Record<PracticeScope, string> = { all: 'tất cả các từ', learning: 'các từ đang học', learned: 'các từ đã thuộc' }

/**
 * Ôn flashcard riêng (ngoài buổi học), ~10 thẻ mỗi lượt.
 * Mặc định ôn các thẻ đến hạn. `?mode=practice&scope=all|learning|learned` = ôn tự do: thẻ ngẫu nhiên bất kỳ, kể cả chưa đến hạn.
 */
export default function Review() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const scopeParam = params.get('scope') as PracticeScope
  const practice = params.get('mode') === 'practice' ? (SCOPES.includes(scopeParam) ? scopeParam : 'all') : undefined
  return (
    <>
      <PageTitle
        title={practice ? 'Ôn tự do' : 'Ôn từ vựng'}
        hint={practice ? `Ôn ${SCOPE_LABEL[practice]}, không cần đến hạn. Mỗi lượt khoảng 10 thẻ.` : 'Mỗi lượt khoảng 10 thẻ, mất chừng 5 phút.'}
      />
      <Flashcards practice={practice} onFinish={() => navigate('/vocab')} />
    </>
  )
}
