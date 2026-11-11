import { useNavigate } from 'react-router-dom'
import Flashcards from '../components/Flashcards'
import { PageTitle } from '../ui'

/** Ôn flashcard riêng (ngoài buổi học): ~10 thẻ mỗi lượt, ôn thêm khi còn thẻ đến hạn. */
export default function Review() {
  const navigate = useNavigate()
  return (
    <>
      <PageTitle title="Ôn từ vựng" hint="Mỗi lượt khoảng 10 thẻ, mất chừng 5 phút." />
      <Flashcards onFinish={() => navigate('/vocab')} />
    </>
  )
}
