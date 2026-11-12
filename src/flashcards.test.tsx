// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Flashcards from './components/Flashcards'
import SessionPage from './pages/Session'
import Vocab from './pages/Vocab'
import { Speak } from './ui'

const C = (id: number, word: string, over: Record<string, unknown> = {}) => ({ id, word, pos: 'noun', meaning: `nghĩa ${word}`, example: `A ${word}.`, ...over })

type Resp = { status?: number; body: unknown } | (() => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown })
function server(routes: Record<string, Resp | Resp[]>) {
  const calls: { key: string; body?: any }[] = []
  const counts: Record<string, number> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '').replace(/\?.*$/, '')}`
      calls.push({ key: `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`, body: init?.body ? JSON.parse(init.body as string) : undefined })
      const h = routes[key]
      if (!h) return Response.json({ message: 'không có route ' + key }, { status: 404 })
      const list = Array.isArray(h) ? h : [h]
      const one = list[Math.min(counts[key] ?? 0, list.length - 1)]
      counts[key] = (counts[key] ?? 0) + 1
      const r = typeof one === 'function' ? await one() : one
      return Response.json(r.body, { status: r.status ?? 200 })
    }),
  )
  return {
    calls,
    count: (prefix: string) => calls.filter((c) => c.key.startsWith(prefix)).length,
    bodies: (prefix: string) => calls.filter((c) => c.key.startsWith(prefix)).map((c) => c.body),
  }
}
const due = (cards: unknown[], total = cards.length) => ({ body: { cards, total_due: total } })
const reviewOk = (remaining = 0) => ({ body: { next: { interval_days: 1, due_date: '2026-11-12', learned: 0 }, remaining_due: remaining } })

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as any).speechSynthesis
  delete (globalThis as any).SpeechSynthesisUtterance
})

/** Hiện nghĩa rồi viết lại ĐÚNG từ (bước gõ từ) để tới phần chấm mức nhớ. */
const showMeaning = () => {
  const w = screen.getByTestId('card-word').textContent!
  fireEvent.click(screen.getByText('Hiện nghĩa'))
  fireEvent.change(screen.getByLabelText('Viết lại từ tiếng Anh'), { target: { value: w } })
  fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }))
}
const grade = (name: 'Quên' | 'Khó' | 'Tốt' | 'Dễ') => fireEvent.click(screen.getByRole('button', { name }))
const word = () => screen.getByTestId('card-word').textContent

/* ---------------------------------------------------------------- */
describe('Flashcards — ôn thẻ', () => {
  it('chưa có thẻ đến hạn → báo rõ, có nút Tiếp tục nếu được truyền onFinish', async () => {
    server({ 'GET /flashcards/due': due([]) })
    const fin = vi.fn()
    render(<Flashcards onFinish={fin} />)
    expect(await screen.findByText(/Không có thẻ nào đến hạn/)).toBeTruthy()
    fireEvent.click(screen.getByText('Tiếp tục'))
    expect(fin).toHaveBeenCalled()
  })

  it('mặt trước chỉ có từ; "Hiện nghĩa" mới lộ nghĩa, ví dụ và 4 mức đánh giá', async () => {
    server({ 'GET /flashcards/due': due([C(1, 'menu')]) })
    render(<Flashcards />)
    expect(await screen.findByTestId('card-word')).toBeTruthy()
    expect(word()).toBe('menu')
    expect(screen.queryByTestId('card-meaning')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tốt' })).toBeNull()
    showMeaning()
    expect(screen.getByTestId('card-meaning').textContent).toBe('nghĩa menu')
    expect(screen.getByText('A menu.')).toBeTruthy()
    for (const g of ['Quên', 'Khó', 'Tốt', 'Dễ']) expect(screen.getByRole('button', { name: g })).toBeTruthy()
  })

  it('hiện tiến độ và số thẻ; xin đúng 10 thẻ mặc định', async () => {
    const s = server({ 'GET /flashcards/due': due([C(1, 'a'), C(2, 'b'), C(3, 'c')], 25) })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    expect(s.calls[0].key).toBe('GET /flashcards/due?limit=10')
    expect(screen.getByText('Đã ôn 0/3')).toBeTruthy()
    expect(screen.getByText(/Còn 3 thẻ trong lượt này · 25 thẻ đến hạn/)).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Tiến độ ôn' }).getAttribute('aria-valuenow')).toBe('0')
  })

  it('mỗi mức gửi đúng grade lên máy chủ: again / hard / good / easy', async () => {
    const s = server({
      'GET /flashcards/due': due([C(1, 'a'), C(2, 'b'), C(3, 'c'), C(4, 'd')]),
      'POST /flashcards/1/review': reviewOk(),
      'POST /flashcards/2/review': reviewOk(),
      'POST /flashcards/3/review': reviewOk(),
      'POST /flashcards/4/review': reviewOk(),
    })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    for (const [name, id] of [['Khó', 1], ['Tốt', 2], ['Dễ', 3]] as const) {
      showMeaning()
      grade(name)
      await waitFor(() => expect(s.count(`POST /flashcards/${id}/review`)).toBe(1))
    }
    await waitFor(() => expect(word()).toBe('d'))
    showMeaning()
    grade('Quên')
    await waitFor(() => expect(s.count('POST /flashcards/4/review')).toBe(1))
    expect([1, 2, 3, 4].map((i) => s.bodies(`POST /flashcards/${i}/review`)[0])).toEqual([{ grade: 'hard', typed: 'a' }, { grade: 'good', typed: 'b' }, { grade: 'easy', typed: 'c' }, { grade: 'again', typed: 'd' }])
  })

  it('đánh giá xong → sang thẻ kế tiếp, mặt sau úp lại, tiến độ tăng', async () => {
    server({ 'GET /flashcards/due': due([C(1, 'a'), C(2, 'b')]), 'POST /flashcards/1/review': reviewOk() })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    showMeaning()
    grade('Tốt')
    await waitFor(() => expect(word()).toBe('b'))
    expect(screen.queryByTestId('card-meaning')).toBeNull() // thẻ mới úp lại
    expect(screen.getByText('Đã ôn 1/2')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Tiến độ ôn' }).getAttribute('aria-valuenow')).toBe('50')
  })

  it('"Quên": thẻ quay lại CUỐI hàng để ôn lại ngay trong lượt, chưa tính là đã ôn', async () => {
    server({ 'GET /flashcards/due': due([C(1, 'a'), C(2, 'b')]), 'POST /flashcards/1/review': reviewOk(), 'POST /flashcards/2/review': reviewOk() })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    showMeaning()
    grade('Quên')
    await waitFor(() => expect(word()).toBe('b'))
    expect(screen.getByText('Đã ôn 0/2')).toBeTruthy()
    showMeaning()
    grade('Tốt')
    await waitFor(() => expect(word()).toBe('a')) // "a" quay lại sau "b"
    expect(screen.getByText('Đã ôn 1/2')).toBeTruthy()
  })

  it('"Quên" nhiều lần: thẻ cứ quay lại tới khi đánh giá mức khác', async () => {
    const s = server({ 'GET /flashcards/due': due([C(1, 'a')]), 'POST /flashcards/1/review': reviewOk() })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    for (let i = 0; i < 3; i++) {
      showMeaning()
      grade('Quên')
      await waitFor(() => expect(s.count('POST /flashcards/1/review')).toBe(i + 1))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Quên' })).toBeNull())
      expect(word()).toBe('a')
    }
    showMeaning()
    grade('Dễ')
    expect(await screen.findByText(/Xong lượt ôn/)).toBeTruthy()
  })

  it('ôn hết lượt: tổng kết số thẻ; hết thẻ đến hạn thì báo đã ôn hết', async () => {
    server({ 'GET /flashcards/due': due([C(1, 'a')]), 'POST /flashcards/1/review': reviewOk(0) })
    const fin = vi.fn()
    render(<Flashcards onFinish={fin} />)
    await screen.findByTestId('card-word')
    showMeaning()
    grade('Tốt')
    expect(await screen.findByText('Bạn đã ôn 1 thẻ.')).toBeTruthy()
    expect(screen.getByText(/Hôm nay bạn đã ôn hết thẻ đến hạn/)).toBeTruthy()
    fireEvent.click(screen.getByText('Tiếp tục'))
    expect(fin).toHaveBeenCalled()
  })

  it('còn thẻ đến hạn ngoài lượt: có "Ôn thêm" tải lượt mới; "Để sau" thoát', async () => {
    const s = server({
      'GET /flashcards/due': [due([C(1, 'a')], 3), due([C(2, 'b'), C(3, 'c')], 2)],
      'POST /flashcards/1/review': reviewOk(2),
    })
    const fin = vi.fn()
    render(<Flashcards limit={1} onFinish={fin} />)
    await screen.findByTestId('card-word')
    showMeaning()
    grade('Tốt')
    expect(await screen.findByText('Còn 2 thẻ đến hạn.')).toBeTruthy()
    expect(screen.getByText('Để sau')).toBeTruthy()
    fireEvent.click(screen.getByText('Ôn thêm'))
    await waitFor(() => expect(word()).toBe('b'))
    expect(s.count('GET /flashcards/due')).toBe(2)
    expect(screen.getByText('Đã ôn 0/2')).toBeTruthy() // lượt mới tính lại từ đầu
  })

  it('lỗi khi chấm: hiện thông báo + thử lại, GIỮ nguyên thẻ, thử lại gửi đúng mức đã chọn', async () => {
    const s = server({
      'GET /flashcards/due': due([C(1, 'a'), C(2, 'b')]),
      'POST /flashcards/1/review': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, reviewOk()],
    })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    showMeaning()
    grade('Dễ')
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    expect(word()).toBe('a') // chưa chuyển thẻ
    expect(screen.getByText('Đã ôn 0/2')).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    await waitFor(() => expect(word()).toBe('b'))
    expect(s.bodies('POST /flashcards/1/review')).toEqual([{ grade: 'easy', typed: 'a' }, { grade: 'easy', typed: 'a' }])
  })

  it('đang gửi: các nút mức bị khóa (không chấm hai lần)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const s = server({ 'GET /flashcards/due': due([C(1, 'a'), C(2, 'b')]), 'POST /flashcards/1/review': async () => { await gate; return reviewOk() } })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    showMeaning()
    grade('Tốt')
    await waitFor(() => expect((screen.getByRole('button', { name: 'Dễ' }) as HTMLButtonElement).disabled).toBe(true))
    grade('Dễ')
    grade('Tốt')
    expect(s.count('POST /flashcards/1/review')).toBe(1)
    await act(async () => release())
    await waitFor(() => expect(word()).toBe('b'))
  })

  it('tải thẻ lỗi → thông báo + thử lại', async () => {
    server({ 'GET /flashcards/due': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, due([C(1, 'a')])] })
    render(<Flashcards />)
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByTestId('card-word')).toBeTruthy()
  })

  it('thẻ không có loại từ/ví dụ vẫn hiển thị bình thường', async () => {
    server({ 'GET /flashcards/due': due([C(1, 'menu', { pos: null, example: null })]) })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    showMeaning()
    expect(screen.getByTestId('card-meaning').textContent).toBe('nghĩa menu')
    expect(screen.queryByText(/^\(/)).toBeNull()
  })

  it('nội dung từ vựng hiển thị như chữ thường, không chạy HTML', async () => {
    server({ 'GET /flashcards/due': due([C(1, '<img src=x onerror=alert(1)>', { meaning: '<b>x</b>' })]) })
    const { container } = render(<Flashcards />)
    await screen.findByTestId('card-word')
    showMeaning()
    expect(container.querySelector('img, b')).toBeNull()
    expect(word()).toBe('<img src=x onerror=alert(1)>')
  })
})

/* ---------------------------------------------------------------- */
describe('Speak — nghe phát âm (Web Speech API)', () => {
  function installSpeech(voices: { lang: string; name: string }[] = []) {
    const spoken: { text: string; lang: string; rate: number; voice?: unknown }[] = []
    const synth = {
      cancel: vi.fn(),
      speak: vi.fn((u: any) => spoken.push({ text: u.text, lang: u.lang, rate: u.rate, voice: u.voice })),
      getVoices: () => voices,
    }
    ;(window as any).speechSynthesis = synth
    ;(globalThis as any).SpeechSynthesisUtterance = class {
      lang = ''
      rate = 1
      voice: unknown
      constructor(public text: string) {}
    }
    return { synth, spoken }
  }

  it('trình duyệt không hỗ trợ → không hiện nút', () => {
    const { container } = render(<Speak text="menu" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('bấm → đọc đúng chữ bằng tiếng Anh (en-US), chậm nhẹ; dừng câu đang đọc dở trước', () => {
    const { synth, spoken } = installSpeech()
    render(<Speak text="menu" />)
    fireEvent.click(screen.getByRole('button', { name: 'Nghe phát âm: menu' }))
    expect(synth.cancel).toHaveBeenCalledTimes(1)
    expect(spoken).toEqual([{ text: 'menu', lang: 'en-US', rate: 0.9, voice: undefined }])
  })

  it('chọn giọng tiếng Anh nếu có (ưu tiên en-US), bỏ qua giọng khác', () => {
    const { spoken } = installSpeech([{ lang: 'vi-VN', name: 'Viet' }, { lang: 'en-GB', name: 'UK' }, { lang: 'en-US', name: 'US' }])
    render(<Speak text="hello" />)
    fireEvent.click(screen.getByRole('button'))
    expect((spoken[0].voice as any).name).toBe('US')
  })

  it('chỉ có giọng en-GB → dùng en-GB; chỉ có giọng không phải tiếng Anh → để trình duyệt tự chọn', () => {
    const a = installSpeech([{ lang: 'en-GB', name: 'UK' }])
    render(<Speak text="hello" />)
    fireEvent.click(screen.getByRole('button'))
    expect((a.spoken[0].voice as any).name).toBe('UK')
    cleanup()
    const b = installSpeech([{ lang: 'fr-FR', name: 'FR' }])
    render(<Speak text="hello" />)
    fireEvent.click(screen.getByRole('button'))
    expect(b.spoken[0].voice).toBeUndefined()
  })

  it('nhãn tùy chỉnh cho câu ví dụ; câu dài đọc nguyên câu', () => {
    const { spoken } = installSpeech()
    render(<Speak text="Can I see the menu, please?" label="Nghe câu ví dụ" />)
    fireEvent.click(screen.getByRole('button', { name: 'Nghe câu ví dụ' }))
    expect(spoken[0].text).toBe('Can I see the menu, please?')
  })

  it('trình duyệt ném lỗi khi đọc → không làm hỏng trang', () => {
    const { synth } = installSpeech()
    synth.speak.mockImplementation(() => {
      throw new Error('not-allowed')
    })
    render(<Speak text="menu" />)
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow()
  })

  it('bấm nút nghe không kích hoạt thẻ chứa nó (không lật thẻ/không bấm xuyên)', () => {
    installSpeech()
    const onClick = vi.fn()
    render(<div onClick={onClick}><Speak text="menu" /></div>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('có nút nghe ở thẻ: từ và câu ví dụ (sau khi hiện nghĩa)', async () => {
    const { spoken } = installSpeech()
    server({ 'GET /flashcards/due': due([C(1, 'menu', { example: 'Can I see the menu?' })]) })
    render(<Flashcards />)
    await screen.findByTestId('card-word')
    expect(screen.getAllByRole('button', { name: /Nghe/ })).toHaveLength(1) // mới có từ
    fireEvent.click(screen.getByRole('button', { name: 'Nghe phát âm: menu' }))
    showMeaning()
    fireEvent.click(screen.getByRole('button', { name: 'Nghe câu ví dụ' }))
    expect(spoken.map((s) => s.text)).toEqual(['menu', 'Can I see the menu?'])
  })
})

/* ---------------------------------------------------------------- */
describe('Kho từ vựng — trang /vocab', () => {
  const item = (id: number, word: string, over: Record<string, unknown> = {}) => ({
    id, word, pos: 'noun', meaning: `nghĩa ${word}`, example: `A ${word}.`, due_date: '2099-01-01', learned: 0, wrong_count: 0, ...over,
  })
  const page = (items: unknown[], over: Record<string, unknown> = {}) => ({
    body: { items, matched: items.length, page: 1, page_size: 50, stats: { total: items.length, learned: 0, due: 0 }, ...over },
  })
  const mount = () => render(<MemoryRouter><Vocab /></MemoryRouter>)

  it('hiện thống kê: tổng số từ, đã thuộc, đến hạn', async () => {
    server({ 'GET /vocab': page([item(1, 'menu')], { stats: { total: 12, learned: 4, due: 3 } }) })
    mount()
    await screen.findByText('menu')
    expect(screen.getByText('12').nextSibling!.textContent).toBe('Tổng số từ')
    expect(screen.getByText('4').nextSibling!.textContent).toBe('Đã thuộc')
    expect(screen.getByText('3', { selector: 'p' }).nextSibling!.textContent).toBe('Đến hạn ôn')
  })

  it('mỗi từ: từ, loại từ, nghĩa, ví dụ, nút nghe; nhãn Đã thuộc / Đến hạn / số lần sai', async () => {
    server({ 'GET /vocab': page([
      item(1, 'known', { learned: 1 }),
      item(2, 'dueword', { due_date: '2000-01-01', wrong_count: 2 }),
      item(3, 'later'),
    ]) })
    mount()
    await screen.findByText('known')
    const rows = screen.getAllByRole('listitem')
    expect(rows[0].textContent).toContain('Đã thuộc')
    expect(rows[1].textContent).toContain('Đến hạn')
    expect(rows[1].textContent).toContain('sai 2 lần')
    expect(rows[1].textContent).toContain('Ôn hôm nay')
    expect(rows[2].textContent).toContain('Ôn lại: 01/01/2099')
    expect(rows[2].textContent).toContain('nghĩa later')
    expect(rows[2].textContent).toContain('A later.')
  })

  it('có từ đến hạn → nút "Ôn ngay" dẫn tới /review; không có thì khóa nút', async () => {
    server({ 'GET /vocab': page([item(1, 'a')], { stats: { total: 1, learned: 0, due: 5 } }) })
    mount()
    await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === 'Có 5 từ cần ôn hôm nay.')
    expect(screen.getByText('Ôn ngay').closest('a')!.getAttribute('href')).toBe('/review')
    cleanup()
    server({ 'GET /vocab': page([item(1, 'a')]) })
    mount()
    await screen.findByText(/Hôm nay không có từ nào đến hạn/)
    expect((screen.getByText('Ôn ngay') as HTMLButtonElement).disabled).toBe(true)
  })

  it('có nhiều từ đến hạn hơn trần ngày: hiện số cần ôn hôm nay và số thẻ chờ ngày sau', async () => {
    server({ 'GET /vocab': page([item(1, 'a')], { stats: { total: 60, learned: 0, due: 55, quota: { cap: 20, done: 0, due: 55, shown: 20, backlog: 35 } } }) })
    mount()
    await screen.findByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').startsWith('Có 20 từ cần ôn hôm nay.'))
    expect(screen.getByText(/Mỗi ngày tối đa 20 thẻ; 35 thẻ chờ ngày sau/)).toBeTruthy()
    expect(screen.getByText('Ôn ngay').closest('a')!.getAttribute('href')).toBe('/review')
  })

  it('đã ôn đủ trần hôm nay: khóa nút "Ôn ngay" và báo còn bao nhiêu thẻ chờ ngày mai', async () => {
    server({ 'GET /vocab': page([item(1, 'a')], { stats: { total: 60, learned: 0, due: 30, quota: { cap: 20, done: 20, due: 30, shown: 0, backlog: 30 } } }) })
    mount()
    await screen.findByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').includes('Bạn đã ôn đủ 20 thẻ hôm nay. Còn 30 thẻ chờ ngày mai.'))
    expect((screen.getByText('Ôn ngay') as HTMLButtonElement).disabled).toBe(true)
  })
  it('tìm kiếm: chờ ngừng gõ rồi mới gọi; gửi đúng từ khóa (không cần dấu)', async () => {
    const s = server({ 'GET /vocab': [page([item(1, 'menu'), item(2, 'bill')]), page([item(1, 'menu')], { matched: 1 })] })
    mount()
    await screen.findByText('bill')
    const before = s.count('GET /vocab')
    const box = screen.getByLabelText('Tìm từ vựng')
    fireEvent.change(box, { target: { value: 'th' } })
    fireEvent.change(box, { target: { value: 'thuc don' } })
    expect(s.count('GET /vocab')).toBe(before) // chưa gọi, đang chờ
    await act(async () => void vi.advanceTimersByTime(300))
    await waitFor(() => expect(s.count('GET /vocab')).toBe(before + 1))
    expect(s.calls.at(-1)!.key).toBe('GET /vocab?q=thuc+don&filter=all&page=1')
    expect(await screen.findByText('1 từ khớp')).toBeTruthy()
  })

  it('bộ lọc: bấm đổi và gọi lại với filter tương ứng; nút đang chọn có aria-pressed', async () => {
    const s = server({ 'GET /vocab': page([item(1, 'a')]) })
    mount()
    await screen.findByText('a')
    expect(screen.getByRole('button', { name: 'Tất cả' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Đã thuộc' }))
    await waitFor(() => expect(s.calls.at(-1)!.key).toBe('GET /vocab?q=&filter=learned&page=1'))
    expect(screen.getByRole('button', { name: 'Đã thuộc' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Tất cả' }).getAttribute('aria-pressed')).toBe('false')
    for (const [label, f] of [['Đến hạn ôn', 'due'], ['Đang học', 'learning']] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      await waitFor(() => expect(s.calls.at(-1)!.key).toBe(`GET /vocab?q=&filter=${f}&page=1`))
    }
  })

  it('kho trống: gợi ý từ vựng sẽ tự thêm sau buổi học', async () => {
    server({ 'GET /vocab': page([]) })
    mount()
    expect(await screen.findByText(/Từ vựng sẽ tự được thêm vào đây sau mỗi buổi học/)).toBeTruthy()
  })

  it('tìm/lọc không ra kết quả: báo không khớp (khác với kho trống)', async () => {
    server({ 'GET /vocab': [page([item(1, 'a')], { stats: { total: 5, learned: 0, due: 0 } }), page([], { matched: 0, stats: { total: 5, learned: 0, due: 0 } })] })
    mount()
    await screen.findByText('a')
    fireEvent.change(screen.getByLabelText('Tìm từ vựng'), { target: { value: 'zzz' } })
    await act(async () => void vi.advanceTimersByTime(300))
    expect(await screen.findByText(/Không có từ nào khớp với tìm kiếm hoặc bộ lọc/)).toBeTruthy()
  })

  it('phân trang: hiện Trang x/y, Trước/Sau gọi đúng trang; đổi tìm kiếm quay về trang 1', async () => {
    const s = server({ 'GET /vocab': page([item(1, 'a')], { matched: 120, page_size: 50 }) })
    mount()
    await screen.findByText('Trang 1/3')
    expect((screen.getByText('← Trước') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Sau →'))
    await waitFor(() => expect(s.calls.at(-1)!.key).toBe('GET /vocab?q=&filter=all&page=2'))
    fireEvent.change(screen.getByLabelText('Tìm từ vựng'), { target: { value: 'x' } })
    await act(async () => void vi.advanceTimersByTime(300))
    await waitFor(() => expect(s.calls.at(-1)!.key).toBe('GET /vocab?q=x&filter=all&page=1'))
  })

  it('chỉ một trang → không hiện phân trang', async () => {
    server({ 'GET /vocab': page([item(1, 'a')]) })
    mount()
    await screen.findByText('a')
    expect(screen.queryByLabelText('Phân trang')).toBeNull()
  })

  it('tải lỗi → thông báo + thử lại', async () => {
    server({ 'GET /vocab': [{ status: 500, body: { message: 'Lỗi hệ thống. Hãy thử lại.' } }, page([item(1, 'menu')])] })
    mount()
    expect(await screen.findByText(/Lỗi hệ thống/)).toBeTruthy()
    fireEvent.click(screen.getByText('Thử lại'))
    expect(await screen.findByText('menu')).toBeTruthy()
  })

  it('nút nghe phát âm có ở từ và câu ví dụ trong kho', async () => {
    ;(window as any).speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [] }
    ;(globalThis as any).SpeechSynthesisUtterance = class { lang = ''; rate = 1; constructor(public text: string) {} }
    server({ 'GET /vocab': page([item(1, 'menu')]) })
    mount()
    await screen.findByText('menu')
    expect(screen.getByRole('button', { name: 'Nghe phát âm: menu' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nghe câu ví dụ' })).toBeTruthy()
  })
})

/* ---------------------------------------------------------------- */
describe('Ôn flashcard đầu buổi học', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    body: { session: { id: 1, seq: 1, week_no: 1, topic: 'Food', scheduled_date: '2026-11-16', status: 'pending', score: null, material: null, lesson: null, result: null, ...over } },
  })
  const mount = () => render(<MemoryRouter initialEntries={['/session/1']}><Routes><Route path="/session/:id" element={<SessionPage />} /></Routes></MemoryRouter>)

  it('buổi chưa bắt đầu và có thẻ đến hạn: mời ôn trước, vẫn có nút bắt đầu buổi học', async () => {
    server({ 'GET /sessions/1': session(), 'GET /flashcards/due': due([C(1, 'a')], 7) })
    mount()
    expect(await screen.findByText('Ôn từ vựng trước khi học')).toBeTruthy()
    expect(screen.getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').startsWith('Có 7 thẻ đến hạn ôn'))).toBeTruthy()
    expect(screen.getByText('Bắt đầu buổi học')).toBeTruthy()
  })

  it('không có thẻ đến hạn: không hiện bước ôn', async () => {
    server({ 'GET /sessions/1': session(), 'GET /flashcards/due': due([], 0) })
    mount()
    await screen.findByText('Bắt đầu buổi học')
    expect(screen.queryByText('Ôn từ vựng trước khi học')).toBeNull()
  })

  it('"Bỏ qua" ẩn bước ôn và không chặn bắt đầu buổi học', async () => {
    server({ 'GET /sessions/1': session(), 'GET /flashcards/due': due([C(1, 'a')], 3) })
    mount()
    fireEvent.click(await screen.findByText('Bỏ qua'))
    expect(screen.queryByText('Ôn từ vựng trước khi học')).toBeNull()
    expect(screen.getByText('Bắt đầu buổi học')).toBeTruthy()
  })

  it('"Ôn ngay" mở thẻ ôn ngay trong buổi học; ôn xong → "Tiếp tục" ẩn bước ôn', async () => {
    server({
      'GET /sessions/1': session(),
      'GET /flashcards/due': [due([C(1, 'a')], 1), due([C(1, 'a')], 1)],
      'POST /flashcards/1/review': reviewOk(0),
    })
    mount()
    fireEvent.click(await screen.findByText('Ôn ngay'))
    await screen.findByTestId('card-word')
    showMeaning()
    grade('Tốt')
    fireEvent.click(await screen.findByText('Tiếp tục'))
    await waitFor(() => expect(screen.queryByTestId('card-word')).toBeNull())
    expect(screen.queryByText('Ôn từ vựng trước khi học')).toBeNull()
    expect(screen.getByText('Bắt đầu buổi học')).toBeTruthy()
  })

  it('tải số thẻ lỗi: không chặn, vẫn bắt đầu được buổi học', async () => {
    server({ 'GET /sessions/1': session(), 'GET /flashcards/due': { status: 500, body: { message: 'lỗi' } } })
    mount()
    expect(await screen.findByText('Bắt đầu buổi học')).toBeTruthy()
    expect(screen.queryByText('Ôn từ vựng trước khi học')).toBeNull()
  })

  it('buổi đã bắt đầu (đang chọn tài liệu): không còn bước ôn', async () => {
    const material = { options: [{ type: 'article', title: 'A', url: 'https://example.com/a', why_vi: 'a', excerpt: 'a' }], chosen: null, fallback: false }
    server({ 'GET /sessions/1': session({ material }), 'GET /flashcards/due': due([C(1, 'a')], 3) })
    mount()
    await screen.findByText('Chọn tài liệu này')
    expect(screen.queryByText('Ôn từ vựng trước khi học')).toBeNull()
  })

  it('trong bài học có nút nghe cho từ vựng và câu ví dụ', async () => {
    ;(window as any).speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [] }
    ;(globalThis as any).SpeechSynthesisUtterance = class { lang = ''; rate = 1; constructor(public text: string) {} }
    const lesson = {
      title: 'T', source: { type: 'ai', title: 'AI', ai_written: true }, excerpt: 'e', summary_vi: 's', explanation_vi: 'x',
      vocab: [{ word: 'order', pos: 'verb', meaning_vi: 'gọi món', example: 'I order tea.' }],
      grammar: [{ point: 'Present', explanation_vi: 'g', example: 'I order tea every day.' }],
    }
    server({
      'GET /sessions/1': session({ material: { options: [], chosen: -1, fallback: true }, lesson }),
      'GET /sessions/1/chat': { body: { messages: [] } },
    })
    mount()
    await screen.findByText('gọi món', { exact: false })
    expect(screen.getByRole('button', { name: 'Nghe phát âm: order' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Nghe câu ví dụ' })).toHaveLength(2)
  })
})
