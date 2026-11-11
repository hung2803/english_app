import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api'
import Layout from './components/Layout'
import Adjustments from './pages/Adjustments'
import Login from './pages/Login'
import Placement from './pages/Placement'
import Roadmap from './pages/Roadmap'
import Review from './pages/Review'
import Settings from './pages/Settings'
import Uploads from './pages/Uploads'
import History from './pages/History'
import Progress from './pages/Progress'
import Vocab from './pages/Vocab'
import SessionPage from './pages/Session'
import { Card, PageTitle, Spinner } from './ui'

function ApiStatus() {
  const [status, setStatus] = useState('Đang kiểm tra kết nối…')
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setStatus(d.ok ? 'Kết nối máy chủ: bình thường' : 'Máy chủ gặp lỗi'))
      .catch(() => setStatus('Không kết nối được máy chủ (đã chạy npm run dev:api chưa?)'))
  }, [])
  return <p className="text-xs text-slate-500">{status}</p>
}

// Trang giữ chỗ — sẽ thay bằng nội dung thật ở các nhóm nghiệp vụ sau.
function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <PageTitle title={title} hint={hint} />
      <Card>
        <p className="text-sm text-slate-600">Chức năng này sẽ có ở bước sau.</p>
      </Card>
      {title === 'Hôm nay' && (
        <div className="mt-4">
          <ApiStatus />
        </div>
      )}
    </>
  )
}

export default function App() {
  // null = đang kiểm tra phiên đăng nhập
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    api<{ authed: boolean }>('/me')
      .then((r) => setAuthed(r.authed))
      .catch(() => setAuthed(false))
    // API trả 401 ở bất kỳ đâu → quay về màn hình đăng nhập
    const onUnauthorized = () => setAuthed(false)
    window.addEventListener('unauthorized', onUnauthorized)
    return () => window.removeEventListener('unauthorized', onUnauthorized)
  }, [])

  if (authed === null) return <Spinner />
  if (!authed) return <Login onDone={() => setAuthed(true)} />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Placeholder title="Hôm nay" hint="Buổi học tiếp theo và thẻ từ vựng đến hạn" />} />
        <Route path="placement" element={<Placement />} />
        <Route path="adjustments" element={<Adjustments />} />
        <Route path="session/:id" element={<SessionPage />} />
        <Route path="uploads" element={<Uploads />} />
        <Route path="settings" element={<Settings />} />
        <Route path="roadmap" element={<Roadmap />} />
        <Route path="vocab" element={<Vocab />} />
        <Route path="review" element={<Review />} />
        <Route path="progress" element={<Progress />} />
        <Route path="history" element={<History />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
