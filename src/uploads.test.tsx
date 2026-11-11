// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Uploads from './pages/Uploads'

const U = (over: Record<string, unknown> = {}) => ({
  id: 1, kind: 'file', title: 'Sách A', url: null, mime: 'application/pdf', size_bytes: 2048, excerpt: null,
  created_at: '2026-11-11', times_used: 0, in_use: false, ...over,
})

type Handler = (init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>
/** Máy chủ giả: khóa "METHOD /path"; ghi lại mọi lời gọi. */
function server(routes: Record<string, Handler | Handler[]>) {
  const calls: { key: string; init?: RequestInit }[] = []
  const counts: Record<string, number> = {}
  const f = vi.fn(async (input: unknown, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
    calls.push({ key, init })
    const h = routes[key]
    if (!h) return Response.json({ message: 'không có route ' + key }, { status: 404 })
    const list = Array.isArray(h) ? h : [h]
    const fn = list[Math.min(counts[key] ?? 0, list.length - 1)]
    counts[key] = (counts[key] ?? 0) + 1
    const r = await fn(init)
    return Response.json(r.body, { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return { calls, count: (key: string) => calls.filter((c) => c.key === key).length }
}
const listOf = (...uploads: unknown[]) => () => ({ body: { uploads, total_bytes: 2048 } })
const mount = () => render(<MemoryRouter><Uploads /></MemoryRouter>)

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const pickFile = (name = 'book.pdf', size = 1000) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File([new Uint8Array(size)], name, { type: 'application/pdf' })
  fireEvent.change(input, { target: { files: [file] } })
  return file
}

describe('danh sách tài liệu', () => {
  it('chưa có gì → thông báo trống', async () => {
    server({ 'GET /uploads': listOf() })
    mount()
    expect(await screen.findByText(/Chưa có tài liệu nào/)).toBeTruthy()
  })
  it('hiện từng tài liệu: tên, loại, dung lượng, số buổi đã dùng, đoạn trích; link hiện đường dẫn', async () => {
    server({
      'GET /uploads': listOf(
        U({ id: 3, kind: 'link', title: 'Trang web', url: 'https://example.com/p', mime: 'text/html', size_bytes: null, excerpt: 'A quote.', times_used: 2 }),
        U({ id: 2, title: 'Văn bản', mime: 'text/plain', size_bytes: 3 * 1024 * 1024, times_used: 0 }),
        U({ id: 1, title: 'Sách A', size_bytes: 2048 }),
      ),
    })
    mount()
    expect(await screen.findByText(/Trang web/)).toBeTruthy()
    expect(screen.getByText('https://example.com/p')).toBeTruthy()
    expect(screen.getByText(/đã dùng 2 buổi/)).toBeTruthy()
    expect(screen.getByText(/“A quote\.”/)).toBeTruthy()
    expect(screen.getByText(/3\.0 MB/)).toBeTruthy()
    expect(screen.getAllByText(/2 KB/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/chưa dùng/)).toHaveLength(2)
    expect(screen.getByText(/Đã tải lên \(3\)/)).toBeTruthy()
  })
  it('lỗi tải danh sách → thông báo + thử lại', async () => {
    server({ 'GET /uploads': [() => ({ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }), listOf(U())] })
    mount()
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText(/Sách A/)).toBeTruthy()
  })
})

describe('xóa tài liệu', () => {
  it('bấm Xóa → hỏi xác nhận (chưa xóa); Hủy thì không xóa', async () => {
    const s = server({ 'GET /uploads': listOf(U()) })
    mount()
    fireEvent.click(await screen.findByText('Xóa'))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/Không thể hoàn tác/)).toBeTruthy()
    expect(s.count('DELETE /uploads/1')).toBe(0)
    fireEvent.click(within(dialog).getByText('Hủy'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(s.count('DELETE /uploads/1')).toBe(0)
  })
  it('xác nhận → gọi DELETE đúng id rồi tải lại danh sách (mục biến mất)', async () => {
    const s = server({
      'GET /uploads': [listOf(U(), U({ id: 2, title: 'Khác' })), listOf(U({ id: 2, title: 'Khác' }))],
      'DELETE /uploads/1': () => ({ body: { ok: true, removed_from_sessions: 0, storage_cleaned: true } }),
    })
    mount()
    await screen.findByText(/Sách A/)
    fireEvent.click(screen.getAllByText('Xóa')[0])
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Xóa'))
    await waitFor(() => expect(screen.queryByText(/Sách A/)).toBeNull())
    expect(screen.getByText(/Khác/)).toBeTruthy()
    expect(s.count('DELETE /uploads/1')).toBe(1)
  })
  it('tài liệu đang được chọn cho buổi chưa xong → cảnh báo trong hộp xác nhận', async () => {
    server({ 'GET /uploads': listOf(U({ in_use: true, times_used: 1 })) })
    mount()
    fireEvent.click(await screen.findByText('Xóa'))
    expect(within(screen.getByRole('alertdialog')).getByText(/AI tự viết bài/)).toBeTruthy()
  })
  it('tài liệu không đang dùng thì không có cảnh báo đó', async () => {
    server({ 'GET /uploads': listOf(U()) })
    mount()
    fireEvent.click(await screen.findByText('Xóa'))
    expect(within(screen.getByRole('alertdialog')).queryByText(/AI tự viết bài/)).toBeNull()
  })
  it('xóa lỗi (404) → hiện thông báo, vẫn giữ mục', async () => {
    server({ 'GET /uploads': listOf(U()), 'DELETE /uploads/1': () => ({ status: 404, body: { message: 'Không tìm thấy tài liệu.' } }) })
    mount()
    fireEvent.click(await screen.findByText('Xóa'))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Xóa'))
    expect(await screen.findByText('Không tìm thấy tài liệu.')).toBeTruthy()
    expect(screen.getByText(/Sách A/)).toBeTruthy()
  })
})

describe('tải file lên', () => {
  it('chưa chọn file → báo lỗi, không gọi server', async () => {
    const s = server({ 'GET /uploads': listOf() })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    fireEvent.click(screen.getByText('Tải lên'))
    expect(await screen.findByText('Hãy chọn một file để tải lên.')).toBeTruthy()
    expect(s.count('POST /uploads')).toBe(0)
  })
  it('file quá lớn (> 10 MB) bị chặn ngay ở trình duyệt, không gửi lên', async () => {
    const s = server({ 'GET /uploads': listOf() })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    pickFile('huge.pdf', 10 * 1024 * 1024 + 1)
    fireEvent.click(screen.getByText('Tải lên'))
    expect(await screen.findByText(/File quá lớn \(tối đa 10 MB\)/)).toBeTruthy()
    expect(s.count('POST /uploads')).toBe(0)
  })
  it('tải thành công: gửi multipart có file + tên, báo thành công, làm mới danh sách, xóa ô nhập', async () => {
    const s = server({
      'GET /uploads': [listOf(), listOf(U({ title: 'Tên của tôi' }))],
      'POST /uploads': () => ({ status: 201, body: { upload: U() } }),
    })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    const file = pickFile('book.pdf')
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: ' Tên của tôi ' } })
    fireEvent.click(screen.getByText('Tải lên'))
    expect(await screen.findByText(/Đã tải lên “book\.pdf”/)).toBeTruthy()
    const call = s.calls.find((c) => c.key === 'POST /uploads')!
    const fd = call.init!.body as FormData
    expect(fd).toBeInstanceOf(FormData)
    expect((fd.get('file') as File).name).toBe(file.name)
    expect(fd.get('title')).toBe('Tên của tôi')
    expect((call.init!.headers as Record<string, string> | undefined)?.['content-type']).toBeUndefined() // để trình duyệt tự thêm boundary
    expect(await screen.findByText(/Tên của tôi/)).toBeTruthy()
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).value).toBe('')
  })
  it('server từ chối (trùng / sai loại): hiện đúng thông báo tiếng Việt từ server', async () => {
    server({
      'GET /uploads': listOf(),
      'POST /uploads': () => ({ status: 409, body: { error: 'duplicate', message: 'Bạn đã tải tài liệu này lên rồi.' } }),
    })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    pickFile()
    fireEvent.click(screen.getByText('Tải lên'))
    expect(await screen.findByText('Bạn đã tải tài liệu này lên rồi.')).toBeTruthy()
  })
  it('đang tải: nút bị khóa, hiện "Đang tải lên…" (chống bấm hai lần)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server({ 'GET /uploads': listOf(), 'POST /uploads': async () => { await gate; return { status: 201, body: { upload: U() } } } })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    pickFile()
    fireEvent.click(screen.getByText('Tải lên'))
    const busy = await screen.findByText('Đang tải lên…')
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    release()
    await waitFor(() => expect(screen.queryByText('Đang tải lên…')).toBeNull())
  })
})

describe('thêm link', () => {
  it('nút bị khóa khi chưa nhập đường dẫn', async () => {
    server({ 'GET /uploads': listOf() })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    expect((screen.getByRole('button', { name: 'Thêm link' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('thêm link thành công: gửi url + tên, báo thành công, làm mới danh sách', async () => {
    const s = server({
      'GET /uploads': [listOf(), listOf(U({ id: 5, kind: 'link', title: 'Trang X', url: 'https://example.com/x', mime: 'text/html', size_bytes: null }))],
      'POST /uploads/link': () => ({ status: 201, body: { upload: U() } }),
    })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    fireEvent.change(screen.getByPlaceholderText('https://…'), { target: { value: ' https://example.com/x ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Thêm link' }))
    expect(await screen.findByText('Đã thêm link.')).toBeTruthy()
    expect(JSON.parse(s.calls.find((c) => c.key === 'POST /uploads/link')!.init!.body as string)).toEqual({ url: 'https://example.com/x' })
    expect(await screen.findByText(/Trang X/)).toBeTruthy()
  })
  it('link bị từ chối (không an toàn / trang lỗi): hiện thông báo của server, ô nhập giữ nguyên để sửa', async () => {
    server({
      'GET /uploads': listOf(),
      'POST /uploads/link': () => ({ status: 400, body: { error: 'unsafe_url', message: 'Không dùng được đường dẫn này (phải là trang web công khai).' } }),
    })
    mount()
    await screen.findByText(/Chưa có tài liệu nào/)
    const input = screen.getByPlaceholderText('https://…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'http://localhost/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Thêm link' }))
    expect(await screen.findByText(/Không dùng được đường dẫn này/)).toBeTruthy()
    expect(input.value).toBe('http://localhost/x')
  })
})
