import { useState } from 'react'
import { fmtDate } from '../ui'

export interface ScorePoint {
  id: number
  seq: number
  week_no: number
  title: string
  score: number
  date: string
}

const W = 640
const H = 260
const PAD = { l: 40, r: 14, t: 14, b: 34 }
const PASS = 70
const GRID = [0, 25, 50, 75, 100]

/**
 * Biểu đồ đường điểm quiz theo thời gian (một trục, 0–100%).
 * - đường mảnh 2px, chấm tròn r=4; điểm CHƯA ĐẠT (<70%) vẽ chấm rỗng để không chỉ dựa vào màu;
 * - đường đứt nét "Đạt 70%"; lưới nhạt;
 * - rê chuột/chạm để xem chi tiết (đường dóng + khung thông tin); có bảng số liệu thay thế.
 */
export default function ScoreChart({ scores }: { scores: ScorePoint[] }) {
  const [active, setActive] = useState<number | null>(null)
  const n = scores.length
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v: number) => PAD.t + ih - (v / 100) * ih

  const pointAt = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect()
    const px = ((clientX - r.left) / (r.width || W)) * W
    let best = 0
    let bd = Infinity
    scores.forEach((_, i) => {
      const d = Math.abs(x(i) - px)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return best
  }

  const line = scores.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.score).toFixed(1)}`).join(' ')
  // nhãn trục x: đầu, cuối và vài mốc giữa, tránh chồng chữ
  const tickIdx = n <= 6 ? scores.map((_, i) => i) : [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1]
  const act = active !== null ? scores[active] : null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label={`Biểu đồ điểm quiz theo thời gian, ${n} bài`}
        onPointerMove={(e) => setActive(pointAt(e.clientX, e.currentTarget))}
        onPointerDown={(e) => setActive(pointAt(e.clientX, e.currentTarget))}
        onPointerLeave={() => setActive(null)}
      >
        {GRID.map((g) => (
          <g key={g}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="currentColor" className="text-slate-200" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(g) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">{g}%</text>
          </g>
        ))}

        <line x1={PAD.l} x2={W - PAD.r} y1={y(PASS)} y2={y(PASS)} stroke="currentColor" className="text-emerald-500" strokeWidth={1.5} strokeDasharray="5 4" />
        <text x={W - PAD.r} y={y(PASS) - 5} textAnchor="end" className="fill-emerald-700 text-[11px] font-medium">Đạt từ 70%</text>

        {n > 1 && <path d={line} fill="none" stroke="currentColor" className="text-indigo-600" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}

        {act && active !== null && <line x1={x(active)} x2={x(active)} y1={PAD.t} y2={PAD.t + ih} stroke="currentColor" className="text-slate-400" strokeWidth={1} />}

        {scores.map((s, i) => {
          const pass = s.score >= PASS
          return (
            <circle
              key={s.id}
              cx={x(i)}
              cy={y(s.score)}
              r={active === i ? 6 : 4}
              strokeWidth={2}
              className={pass ? 'fill-indigo-600 stroke-white' : 'fill-white stroke-indigo-600'}
              data-pass={pass}
            />
          )
        })}

        {tickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 12} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'} className="fill-slate-500 text-[11px]">
            {scores[i].date.slice(8, 10)}/{scores[i].date.slice(5, 7)}
          </text>
        ))}
      </svg>

      {act && active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 w-44 -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-2 text-xs shadow-lg"
          style={{ left: `${Math.min(88, Math.max(12, (x(active) / W) * 100))}%`, top: 0 }}
        >
          <p className="font-semibold text-slate-900">{act.score}% · {act.score >= PASS ? 'Đạt' : 'Chưa đạt'}</p>
          <p className="truncate text-slate-600">{act.title}</p>
          <p className="text-slate-400">Buổi {act.seq} · {fmtDate(act.date)}</p>
        </div>
      )}

      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500" aria-label="Chú thích">
        <li><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-indigo-600" />Đạt (≥ 70%)</li>
        <li><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full border-2 border-indigo-600 bg-white" />Chưa đạt</li>
      </ul>

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-indigo-700">Xem dạng bảng</summary>
        <table className="mt-2 w-full text-left text-xs">
          <thead>
            <tr className="text-slate-500"><th className="py-1 pr-2">Ngày</th><th className="pr-2">Buổi</th><th className="pr-2">Bài</th><th className="text-right">Điểm</th></tr>
          </thead>
          <tbody>
            {scores.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="py-1 pr-2">{fmtDate(s.date)}</td>
                <td className="pr-2">{s.seq}</td>
                <td className="max-w-40 truncate pr-2">{s.title}</td>
                <td className="text-right font-medium">{s.score}%{s.score < PASS ? ' (chưa đạt)' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}
