import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import { Card } from '../ui'

interface Usage {
  rpm: number
  tpm: number
  rpd: number
  tokens_today: { prompt: number; output: number; total: number }
  reset_in_s: number
}
interface Info {
  model: string
  models: { id: string; label: string }[]
  limits: { rpm: number; tpm: number; rpd: number } | null
  usage: Usage
}

const REFRESH_MS = 20_000
const nf = new Intl.NumberFormat('vi-VN')

function fmtReset(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h} giờ ${m} phút` : `${m} phút`
}

function Meter({ label, hint, used, limit }: { label: string; hint: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0
  const color = !limit ? 'bg-slate-400' : pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-slate-600">
        <span><strong className="text-slate-800">{label}</strong> · {hint}</span>
        <span className="tabular-nums">{nf.format(used)}{limit ? ` / ${nf.format(limit)}` : ''}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} ${hint}`}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
        aria-valuenow={used}
        className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200"
      >
        <div className={`h-full rounded-full ${color}`} style={{ width: `${limit ? Math.max(pct, used > 0 ? 3 : 0) : 0}%` }} />
      </div>
    </div>
  )
}

/** Chọn model Gemini và xem mức dùng so với hạn mức (RPM, TPM, RPD) cùng token đã dùng hôm nay. */
export default function AiPicker() {
  const [info, setInfo] = useState<Info | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api<Info>('/ai-model').then(setInfo).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  if (!info) return null

  const choose = async (model: string) => {
    setBusy(true)
    setError('')
    try {
      setInfo(await api<Info>('/ai-model', { model }, { method: 'PUT' }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const { usage, limits } = info
  return (
    <Card className="space-y-3">
      <label className="block text-sm text-slate-700">
        <span className="font-semibold">Model AI (Gemini)</span>
        <select
          value={info.model}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
        >
          {!info.models.some((m) => m.id === info.model) && <option value={info.model}>{info.model}</option>}
          {info.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>

      <div className="space-y-2">
        <Meter label="RPM" hint="yêu cầu / phút" used={usage.rpm} limit={limits?.rpm ?? null} />
        <Meter label="TPM" hint="token / phút" used={usage.tpm} limit={limits?.tpm ?? null} />
        <Meter label="RPD" hint="yêu cầu / ngày" used={usage.rpd} limit={limits?.rpd ?? null} />
      </div>

      <div className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
        <p>
          Token đã dùng hôm nay: <strong>{nf.format(usage.tokens_today.total)}</strong>
          <span className="text-slate-500"> (vào {nf.format(usage.tokens_today.prompt)} · ra {nf.format(usage.tokens_today.output)})</span>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Hạn mức ngày (RPD) làm mới sau {fmtReset(usage.reset_in_s)} (00:00 giờ Thái Bình Dương). Số liệu chỉ tính các lượt gọi từ app này.
          {!limits && ' Model này chưa có trong danh sách nên không biết hạn mức.'}
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </Card>
  )
}
