import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Btn, Card, ErrorBox } from '../ui'

export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !password) return
    setBusy(true)
    setError(null)
    try {
      await api('/login', { password })
      onDone()
    } catch (err) {
      setError(err)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm items-center px-4">
      <Card className="w-full space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-bold text-indigo-700">English Coach</h1>
          <p className="mt-1 text-sm text-slate-500">Nhập mật khẩu để vào học.</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Mật khẩu</span>
            <div className="flex gap-2">
              <input
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
                className="min-h-11 w-full rounded-xl border border-slate-300 px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="min-h-11 shrink-0 rounded-xl border border-slate-300 px-3 text-sm text-slate-600 hover:bg-slate-100"
              >
                {show ? 'Ẩn' : 'Hiện'}
              </button>
            </div>
          </label>

          {error != null && <ErrorBox error={error} />}

          <Btn type="submit" disabled={busy || !password} className="w-full">
            {busy ? 'Đang vào…' : 'Vào học'}
          </Btn>
        </form>
      </Card>
    </div>
  )
}
