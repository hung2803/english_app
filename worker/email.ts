import { collectWeekData } from './adjustment'
import { getAdjustment, type Adjustment } from './adjustment-store'
import { todayVN } from './dates'
import type { Env } from './env'
import { missingSecrets } from './env'

/** Dịch vụ gửi email: Resend (https://resend.com), gói miễn phí 100 thư/ngày — thừa cho một người dùng. */
export const RESEND_URL = 'https://api.resend.com/emails'

export class EmailError extends Error {}

export const emailConfigured = (env: Env) => missingSecrets(env, 'email').length === 0

export interface EmailMessage {
  subject: string
  html: string
  text: string
}

/** Gửi một email tới EMAIL_TO. Lỗi → EmailError (không kèm khóa API). `idempotencyKey` chống gửi trùng khi thử lại. */
export async function sendEmail(env: Env, msg: EmailMessage, idempotencyKey?: string): Promise<void> {
  const missing = missingSecrets(env, 'email')
  if (missing.length) throw new EmailError('Chưa cấu hình email: thiếu ' + missing.join(', '))
  let res: Response
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.EMAIL_TO], subject: msg.subject, html: msg.html, text: msg.text }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new EmailError('Không gọi được dịch vụ email')
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new EmailError(`Dịch vụ email trả lỗi ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`)
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Địa chỉ gốc của app cho link trong email; không hợp lệ thì null (email vẫn gửi, chỉ không có link). */
export function appBase(url: string | undefined): string | null {
  const u = (url ?? '').trim().replace(/\/+$/, '')
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u) || /^http:\/\/localhost(:\d+)?(\/[^\s]*)?$/i.test(u) ? u : null
}

export interface WeeklyData {
  weekNo: number
  scores: number[]
  average: number | null
  lowCount: number
  weekWords: { word: string; sessions: number }[]
}

/** Email tổng kết tuần: điểm quiz, từ làm sai, nhận xét của AI, các thay đổi đề xuất kèm link duyệt trong app. Mọi nội dung động đều được escape. */
export function buildWeeklyEmail(adj: Pick<Adjustment, 'week_no' | 'summary_vi' | 'changes' | 'status'>, d: WeeklyData, base: string | null): EmailMessage {
  const e = escapeHtml
  const scores = d.scores.length ? d.scores.map((s) => `${s}%`).join(', ') : 'chưa có điểm'
  const hasChanges = adj.changes.length > 0
  const link = base ? `${base}/adjustments` : null
  const subject = `Tổng kết tuần ${adj.week_no}${d.average !== null ? `: điểm quiz trung bình ${d.average}%` : ''}`

  const text = [
    `Tổng kết tuần ${adj.week_no}`,
    '',
    `Điểm quiz các buổi: ${scores}${d.average !== null ? ` (trung bình ${d.average}%, ${d.lowCount} buổi dưới 70%)` : ''}`,
    d.weekWords.length ? `Từ làm sai: ${d.weekWords.map((w) => w.word).join(', ')}` : '',
    '',
    adj.summary_vi,
    '',
    hasChanges ? 'AI đề xuất đổi chủ đề các tuần sau:' : 'AI không đề xuất thay đổi lộ trình.',
    ...adj.changes.map((c) => `- Tuần ${c.week_no}: ${c.topic} (${c.goal_vi})`),
    hasChanges ? '\nNếu bạn không duyệt, lộ trình cũ được giữ nguyên.' : '',
    link ? `\n${hasChanges ? 'Xem và duyệt' : 'Mở ứng dụng'}: ${link}` : '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n')

  const html = `<!doctype html><html lang="vi"><body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#1e293b">
<div style="max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 4px;color:#4338ca">Tổng kết tuần ${adj.week_no}</h1>
<p style="margin:0 0 16px;color:#64748b;font-size:13px">English Coach</p>
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:12px">
<p style="margin:0 0 6px;font-weight:bold">Điểm quiz các buổi</p>
<p style="margin:0">${e(scores)}</p>
${d.average !== null ? `<p style="margin:6px 0 0;color:#475569;font-size:13px">Trung bình ${d.average}% · ${d.lowCount} buổi dưới 70%</p>` : ''}
${d.weekWords.length ? `<p style="margin:10px 0 0;font-size:13px"><b>Từ làm sai:</b> ${e(d.weekWords.map((w) => w.word).join(', '))}</p>` : ''}
</div>
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:12px">
<p style="margin:0">${e(adj.summary_vi)}</p>
</div>
<div style="background:#fff;border:1px solid ${hasChanges ? '#fcd34d' : '#e2e8f0'};border-radius:12px;padding:16px;margin-bottom:16px">
${
  hasChanges
    ? `<p style="margin:0 0 8px;font-weight:bold">AI đề xuất đổi chủ đề các tuần sau</p><ul style="margin:0;padding-left:18px">${adj.changes
        .map((c) => `<li style="margin-bottom:6px"><b>Tuần ${c.week_no}:</b> ${e(c.topic)}<br><span style="color:#64748b;font-size:13px">${e(c.goal_vi)}</span></li>`)
        .join('')}</ul><p style="margin:10px 0 0;color:#64748b;font-size:13px">Nếu bạn không duyệt, lộ trình cũ được giữ nguyên.</p>`
    : '<p style="margin:0">AI không đề xuất thay đổi lộ trình tuần này.</p>'
}
</div>
${link ? `<p style="text-align:center;margin:0"><a href="${e(link)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">${hasChanges ? 'Xem và duyệt trong ứng dụng' : 'Mở ứng dụng'}</a></p>` : ''}
</div></body></html>`

  return { subject, html, text }
}

export type EmailOutcome = 'sent' | 'already_sent' | 'not_configured' | 'not_found' | 'failed'

/**
 * Gửi email tổng kết tuần cho một đề xuất, đúng MỘT lần: giành quyền gửi bằng một câu UPDATE có điều kiện (emailed_at còn trống),
 * gửi lỗi thì trả lại (emailed_at về trống) để lần chạy sau thử lại. Chưa cấu hình email thì bỏ qua, không phải lỗi.
 */
export async function sendWeeklyEmail(env: Env, adjustmentId: number, now = Date.now()): Promise<EmailOutcome> {
  if (!emailConfigured(env)) return 'not_configured'
  const adj = await getAdjustment(env.DB, adjustmentId)
  if (!adj) return 'not_found'
  const stamp = new Date(now).toISOString()
  const claim = await env.DB.prepare('UPDATE plan_adjustments SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL').bind(stamp, adjustmentId).run()
  if (((claim.meta as { changes?: number }).changes ?? 0) !== 1) return 'already_sent'
  try {
    const data = await collectWeekData(env.DB, { planId: adj.plan_id, weekNo: adj.week_no })
    await sendEmail(env, buildWeeklyEmail(adj, data, appBase(env.APP_URL)), `weekly-${adj.plan_id}-${adj.week_no}`)
    await env.DB.prepare("INSERT OR IGNORE INTO notification_log (kind, day, sent_at) VALUES ('weekly_email', ?, ?)").bind(todayVN(now), stamp).run()
    return 'sent'
  } catch (e) {
    await env.DB.prepare('UPDATE plan_adjustments SET emailed_at = NULL WHERE id = ?').bind(adjustmentId).run()
    console.error('weekly email failed', adjustmentId, e instanceof Error ? e.message : e)
    return 'failed'
  }
}

/** Gửi lại các email tổng kết chưa gửi được (trong 7 ngày gần đây). */
export async function retryPendingEmails(env: Env, now = Date.now()): Promise<{ sent: number; failed: number }> {
  if (!emailConfigured(env)) return { sent: 0, failed: 0 }
  const since = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10)
  const { results } = await env.DB.prepare('SELECT id FROM plan_adjustments WHERE emailed_at IS NULL AND created_at >= ? ORDER BY id').bind(since).all<{ id: number }>()
  const out = { sent: 0, failed: 0 }
  for (const r of results) {
    const o = await sendWeeklyEmail(env, r.id, now)
    if (o === 'sent') out.sent++
    else if (o === 'failed') out.failed++
  }
  return out
}
