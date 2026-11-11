import { NavLink, Outlet } from 'react-router-dom'
import { api } from '../api'

export const NAV = [
  { to: '/', label: 'Hôm nay', icon: '🏠' },
  { to: '/roadmap', label: 'Lộ trình', icon: '🗺️' },
  { to: '/vocab', label: 'Từ vựng', icon: '🔤' },
  { to: '/uploads', label: 'Tài liệu', icon: '📎' },
  { to: '/progress', label: 'Tiến độ', icon: '📈' },
  { to: '/history', label: 'Lịch sử', icon: '📚' },
]

export default function Layout() {
  return (
    <div className="mx-auto min-h-dvh max-w-3xl md:max-w-4xl">
      {/* Desktop: thanh menu trên cùng */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-bold text-indigo-700">English Coach</span>
          <nav aria-label="Menu chính" className="hidden gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-indigo-100 font-semibold text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <NavLink to="/settings" aria-label="Cài đặt" className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-indigo-100 font-semibold text-indigo-700' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
            ⚙️ <span className="hidden sm:inline">Cài đặt</span>
          </NavLink>
          <button
            type="button"
            onClick={async () => {
              await api('/logout', {}).catch(() => {})
              window.dispatchEvent(new Event('unauthorized')) // App quay về màn hình đăng nhập
            }}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="px-4 py-4 pb-24 md:pb-8">
        <Outlet />
      </main>

      {/* Điện thoại: thanh menu dưới cùng */}
      <nav
        aria-label="Menu chính"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-6 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `flex min-h-14 flex-col items-center justify-center text-xs ${isActive ? 'font-semibold text-indigo-700' : 'text-slate-500'}`
            }
          >
            <span aria-hidden className="text-lg leading-none">
              {n.icon}
            </span>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
