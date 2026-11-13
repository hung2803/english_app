import { beforeEach, describe, expect, it } from 'vitest'
import app from './index'
import { makeToken } from './auth'
import { addDays, todayVN } from './dates'
import { fold, PAGE_SIZE } from './flashcards'
import { GRADES, LEARNED_INTERVAL, MAX_INTERVAL, MIN_EASE, review } from './srs'
import { createTestDb } from './test-db'
import type { Env } from './env'

const SECRET = 'test-secret-test-secret-test-secret'
const TODAY = todayVN()
let env: Env
let db: D1Database

const fresh = { interval_days: 0, ease: 2.5, reps: 0 }

describe('SRS — 4 mức đánh giá', () => {
  it('có đúng 4 mức', () => expect(GRADES).toEqual(['again', 'hard', 'good', 'easy']))

  describe('good (Tốt): 1 ngày → 3 ngày → × độ dễ', () => {
    it('từ mới: 1 ngày', () => expect(review(fresh, 'good')).toMatchObject({ interval_days: 1, reps: 1, due_in: 1, ease: 2.5 }))
    it('lần 2: 3 ngày', () => expect(review({ interval_days: 1, ease: 2.5, reps: 1 }, 'good')).toMatchObject({ interval_days: 3, reps: 2 }))
    it('lần 3 trở đi: khoảng cách × độ dễ', () => {
      expect(review({ interval_days: 3, ease: 2.5, reps: 2 }, 'good').interval_days).toBe(8)
      expect(review({ interval_days: 8, ease: 2.5, reps: 3 }, 'good').interval_days).toBe(20)
    })
    it('chuỗi trả lời Tốt liên tiếp: 1, 3, 8, 20, 50, 125', () => {
      let c = fresh
      const seq: number[] = []
      for (let i = 0; i < 6; i++) {
        const n = review(c, 'good')
        seq.push(n.interval_days)
        c = n
      }
      expect(seq).toEqual([1, 3, 8, 20, 50, 125])
    })
  })

  describe('again (Quên): học lại, ôn lại ngay trong hôm nay', () => {
    it('đặt lại về 0, đến hạn hôm nay, độ dễ −0,2', () => {
      expect(review({ interval_days: 10, ease: 2.5, reps: 4 }, 'again')).toEqual({ interval_days: 0, ease: 2.3, reps: 0, learned: 0, due_in: 0 })
    })
    it('độ dễ không xuống dưới 1,3', () => {
      expect(review({ interval_days: 5, ease: 1.35, reps: 2 }, 'again').ease).toBe(MIN_EASE)
      expect(review({ interval_days: 5, ease: MIN_EASE, reps: 2 }, 'again').ease).toBe(MIN_EASE)
    })
    it('thẻ đang "đã thuộc" cũng mất trạng thái đã thuộc', () => {
      expect(review({ interval_days: 40, ease: 2.5, reps: 6 }, 'again').learned).toBe(0)
    })
  })

  describe('hard (Khó): × 1,2, ít nhất 1 ngày', () => {
    it('từ mới → 1 ngày (không bao giờ 0)', () => expect(review(fresh, 'hard')).toMatchObject({ interval_days: 1, reps: 1, ease: 2.35 }))
    it('khoảng cách × 1,2 làm tròn', () => expect(review({ interval_days: 10, ease: 2.5, reps: 3 }, 'hard').interval_days).toBe(12))
    it('độ dễ −0,15, tối thiểu 1,3', () => expect(review({ interval_days: 10, ease: 1.4, reps: 3 }, 'hard').ease).toBe(MIN_EASE))
  })

  describe('easy (Dễ): nhảy xa hơn', () => {
    it('từ mới → 3 ngày, độ dễ +0,15', () => expect(review(fresh, 'easy')).toMatchObject({ interval_days: 3, ease: 2.65, reps: 1 }))
    it('sau đó × độ dễ × 1,3, ít nhất 4 ngày', () => {
      expect(review({ interval_days: 3, ease: 2.5, reps: 2 }, 'easy').interval_days).toBe(10)
      expect(review({ interval_days: 1, ease: 1.3, reps: 1 }, 'easy').interval_days).toBe(4)
    })
  })

  it('thứ tự mức: với cùng một thẻ, Dễ ≥ Tốt ≥ Khó ≥ Quên về khoảng cách ôn', () => {
    for (const c of [fresh, { interval_days: 1, ease: 2.5, reps: 1 }, { interval_days: 8, ease: 2.2, reps: 3 }, { interval_days: 30, ease: 1.8, reps: 6 }]) {
      const [a, h, g, e] = GRADES.map((x) => review(c, x).interval_days)
      expect(e).toBeGreaterThanOrEqual(g)
      expect(g).toBeGreaterThanOrEqual(h - 1) // Khó có thể bằng Tốt ở thẻ rất mới
      expect(h).toBeGreaterThanOrEqual(a)
    }
  })

  describe('"đã thuộc"', () => {
    it(`khi khoảng cách ôn ≥ ${LEARNED_INTERVAL} ngày`, () => {
      expect(review({ interval_days: 8, ease: 2.5, reps: 3 }, 'good').learned).toBe(0) // 20 ngày
      expect(review({ interval_days: 9, ease: 2.5, reps: 3 }, 'good').learned).toBe(1) // 23 ngày
      expect(review({ interval_days: 20, ease: 2.5, reps: 4 }, 'hard').learned).toBe(1) // 24 ngày
    })
    it('khoảng cách tối đa 365 ngày', () => {
      expect(review({ interval_days: 300, ease: 2.5, reps: 8 }, 'easy').interval_days).toBe(MAX_INTERVAL)
    })
  })

  it('không đổi đầu vào, độ dễ làm tròn 2 chữ số', () => {
    const c = { interval_days: 5, ease: 2.35, reps: 2 }
    const n = review(c, 'hard')
    expect(c).toEqual({ interval_days: 5, ease: 2.35, reps: 2 })
    expect(n.ease).toBe(2.2)
  })
})

describe('fold — tìm kiếm không phân biệt hoa thường và dấu', () => {
  it('bỏ dấu tiếng Việt, đ → d, hạ chữ thường', () => {
    expect(fold('Thực Đơn')).toBe('thuc don')
    expect(fold('  Hóa   đơn ')).toBe('hoa don')
    expect(fold('CAFÉ')).toBe('cafe')
  })
})

/* ---------------- qua API ---------------- */
async function call(path: string, body?: unknown, authed = true) {
  return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(authed ? { cookie: `ea_session=${await makeToken(SECRET)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const json = async (r: Response) => (await r.json()) as any
let n = 0
async function addWord(word: string, o: Partial<{ meaning: string; due: string; interval: number; reps: number; ease: number; learned: number; wrong: number; pos: string; example: string }> = {}) {
  n++
  return (await db.prepare('INSERT INTO vocab (word, pos, meaning, example, due_date, interval_days, reps, ease, learned, wrong_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(word, o.pos ?? 'noun', o.meaning ?? 'nghĩa ' + word, o.example ?? `A ${word}.`, o.due ?? TODAY, o.interval ?? 0, o.reps ?? 0, o.ease ?? 2.5, o.learned ?? 0, o.wrong ?? 0, TODAY).first<{ id: number }>())!.id
}
const row = async (id: number) => (await db.prepare('SELECT * FROM vocab WHERE id = ?').bind(id).first<any>())!

beforeEach(() => {
  n = 0
  db = createTestDb()
  env = { APP_PASSWORD: 'x', SESSION_SECRET: SECRET, GEMINI_API_KEY: 'k', DB: db } as Env
})

describe('GET /api/flashcards/due — thẻ đến hạn', () => {
  it('cần đăng nhập', async () => expect((await call('/api/flashcards/due', undefined, false)).status).toBe(401))

  it('kho trống → không có thẻ', async () => {
    expect(await json(await call('/api/flashcards/due'))).toMatchObject({ cards: [], total_due: 0, backlog: 0, daily_cap: 15, done_today: 0 })
  })

  it('chỉ trả thẻ đến hạn (hạn ≤ hôm nay); thẻ hẹn ngày mai thì chưa', async () => {
    await addWord('today', { due: TODAY })
    await addWord('overdue', { due: addDays(TODAY, -5) })
    await addWord('tomorrow', { due: addDays(TODAY, 1) })
    await addWord('nextweek', { due: addDays(TODAY, 7) })
    const r = await json(await call('/api/flashcards/due'))
    expect(r.cards.map((c: any) => c.word)).toEqual(['overdue', 'today'])
    expect(r.total_due).toBe(2)
  })

  it('quá hạn lâu nhất ôn trước; cùng ngày theo thứ tự thêm vào', async () => {
    await addWord('b', { due: addDays(TODAY, -1) })
    await addWord('a', { due: addDays(TODAY, -3) })
    await addWord('c', { due: addDays(TODAY, -1) })
    expect((await json(await call('/api/flashcards/due'))).cards.map((c: any) => c.word)).toEqual(['a', 'b', 'c'])
  })

  it('mặc định 10 thẻ (≈ 5 phút), total_due cho biết còn bao nhiêu cần ôn hôm nay (đã tính trần 20/ngày)', async () => {
    for (let i = 0; i < 15; i++) await addWord('w' + i)
    const r = await json(await call('/api/flashcards/due'))
    expect(r.cards).toHaveLength(10)
    expect(r.total_due).toBe(15)
    expect(r.backlog).toBe(0)
  })

  it('?limit= tùy chỉnh, tối đa 50; giá trị rác dùng mặc định', async () => {
    for (let i = 0; i < 60; i++) await addWord('w' + i)
    expect((await json(await call('/api/flashcards/due?limit=3'))).cards).toHaveLength(3)
    expect((await json(await call('/api/flashcards/due?limit=999'))).cards).toHaveLength(15) // chặn bởi trần 20 thẻ/ngày (giới hạn kỹ thuật 50)
    expect((await json(await call('/api/flashcards/due?limit=abc'))).cards).toHaveLength(10)
    expect((await json(await call('/api/flashcards/due?limit=-5'))).cards).toHaveLength(1)
  })

  it('thẻ chỉ có các trường cần để ôn (không lộ trạng thái SRS nội bộ)', async () => {
    await addWord('menu', { pos: 'noun', meaning: 'thực đơn', example: 'Can I see the menu?' })
    expect(Object.keys((await json(await call('/api/flashcards/due'))).cards[0]).sort()).toEqual(['example', 'id', 'meaning', 'pos', 'word'])
  })
})

describe('POST /api/flashcards/:id/review — chấm lần ôn', () => {
  const rev = (id: number, grade: unknown) => call(`/api/flashcards/${id}/review`, { grade })

  it('cần đăng nhập, không đổi gì khi chưa đăng nhập', async () => {
    const id = await addWord('menu')
    expect((await call(`/api/flashcards/${id}/review`, { grade: 'good' }, false)).status).toBe(401)
    expect((await row(id)).reps).toBe(0)
  })

  it('Tốt: lưu khoảng cách, độ dễ, số lần đúng, hẹn ngày ôn tiếp theo', async () => {
    const id = await addWord('menu')
    const r = await json(await rev(id, 'good'))
    expect(r.next).toMatchObject({ interval_days: 1, reps: 1, due_in: 1, due_date: addDays(TODAY, 1), learned: 0 })
    expect(await row(id)).toMatchObject({ interval_days: 1, reps: 1, ease: 2.5, learned: 0, due_date: addDays(TODAY, 1) })
  })

  it('Quên: vẫn đến hạn HÔM NAY (ôn lại trong buổi), học lại từ đầu', async () => {
    const id = await addWord('menu', { interval: 10, reps: 4, due: TODAY })
    await rev(id, 'again')
    expect(await row(id)).toMatchObject({ interval_days: 0, reps: 0, ease: 2.3, due_date: TODAY })
    expect((await json(await call('/api/flashcards/due'))).cards.map((c: any) => c.word)).toContain('menu')
  })

  it('thẻ vừa ôn Tốt thì biến mất khỏi danh sách đến hạn', async () => {
    const a = await addWord('a')
    await addWord('b')
    await rev(a, 'good')
    const r = await json(await call('/api/flashcards/due'))
    expect(r.cards.map((c: any) => c.word)).toEqual(['b'])
    expect(r.total_due).toBe(1)
  })

  it('trả số thẻ còn đến hạn sau lần ôn', async () => {
    const a = await addWord('a')
    await addWord('b')
    await addWord('c')
    expect((await json(await rev(a, 'good'))).remaining_due).toBe(2)
  })

  it('"đã thuộc" khi khoảng cách ôn ≥ 21 ngày; mất khi bấm Quên', async () => {
    const id = await addWord('menu', { interval: 9, reps: 3, ease: 2.5, due: TODAY })
    const r = await json(await rev(id, 'good')) // 9 × 2.5 = 23
    expect(r.next).toMatchObject({ interval_days: 23, learned: 0 })
    expect((await row(id)).learned).toBe(0)
    await rev(id, 'again')
    expect((await row(id)).learned).toBe(0)
  })

  it('ôn nhiều ngày liên tiếp: lịch giãn dần đúng chuỗi 1, 3, 8', async () => {
    const id = await addWord('menu')
    const seq: number[] = []
    for (let i = 0; i < 3; i++) seq.push((await json(await rev(id, 'good'))).next.interval_days)
    expect(seq).toEqual([1, 3, 8])
  })

  it.each(GRADES)('chấp nhận mức "%s"', async (g) => {
    const id = await addWord('menu')
    expect((await rev(id, g)).status).toBe(200)
  })

  it('mức không hợp lệ → 400, không đổi gì', async () => {
    const id = await addWord('menu')
    for (const bad of ['great', '', null, undefined, 3, ['good'], { grade: 'good' }]) {
      expect((await rev(id, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(await row(id)).toMatchObject({ reps: 0, interval_days: 0, due_date: TODAY })
  })

  it('thiếu body / body hỏng → 400; thẻ không tồn tại → 404', async () => {
    const id = await addWord('menu')
    const raw = async (b?: string) => app.request(`/api/flashcards/${id}/review`, { method: 'POST', headers: { cookie: `ea_session=${await makeToken(SECRET)}` }, body: b }, env)
    expect((await raw()).status).toBe(400)
    expect((await raw('{bad')).status).toBe(400)
    expect((await rev(99999, 'good')).status).toBe(404)
  })

  it('chỉ đổi đúng thẻ được ôn', async () => {
    const a = await addWord('a')
    const b = await addWord('b')
    await rev(a, 'easy')
    expect(await row(b)).toMatchObject({ reps: 0, interval_days: 0 })
  })
})

describe('GET /api/vocab — kho từ vựng', () => {
  it('cần đăng nhập', async () => expect((await call('/api/vocab', undefined, false)).status).toBe(401))

  it('kho trống', async () => {
    expect(await json(await call('/api/vocab'))).toMatchObject({ items: [], matched: 0, stats: { total: 0, learned: 0, due: 0 } })
  })

  it('thống kê: tổng số từ, đã thuộc, đến hạn', async () => {
    await addWord('a', { learned: 1, due: addDays(TODAY, 30), interval: 30 })
    await addWord('b', { learned: 1, due: addDays(TODAY, 25), interval: 25 })
    await addWord('c', { due: TODAY })
    await addWord('d', { due: addDays(TODAY, -2) })
    await addWord('e', { due: addDays(TODAY, 3) })
    expect((await json(await call('/api/vocab'))).stats).toMatchObject({ total: 5, learned: 2, due: 2, quota: { cap: 15, done: 0, due: 2, shown: 2, backlog: 0 } })
  })

  it('mới thêm hiện trước; mỗi từ có đủ thông tin', async () => {
    await addWord('first')
    await addWord('second', { meaning: 'thứ hai', pos: 'adj', example: 'It is second.', wrong: 3 })
    const { items } = await json(await call('/api/vocab'))
    expect(items.map((i: any) => i.word)).toEqual(['second', 'first'])
    expect(items[0]).toMatchObject({ meaning: 'thứ hai', pos: 'adj', example: 'It is second.', wrong_count: 3, learned: 0, due_date: TODAY })
  })

  describe('tìm kiếm', () => {
    beforeEach(async () => {
      await addWord('menu', { meaning: 'thực đơn' })
      await addWord('bill', { meaning: 'hóa đơn' })
      await addWord('Order', { meaning: 'gọi món' })
      await addWord('ice-cream', { meaning: 'kem' })
    })
    const find = async (q: string, extra = '') => (await json(await call(`/api/vocab?q=${encodeURIComponent(q)}${extra}`))).items.map((i: any) => i.word)

    it('theo từ tiếng Anh, không phân biệt hoa thường', async () => {
      expect(await find('MEN')).toEqual(['menu'])
      expect(await find('order')).toEqual(['Order'])
      expect(await find('ice')).toEqual(['ice-cream'])
    })
    it('theo nghĩa tiếng Việt, không cần gõ dấu', async () => {
      expect(await find('thuc don')).toEqual(['menu'])
      expect(await find('hoa don')).toEqual(['bill'])
      expect(await find('GỌI')).toEqual(['Order'])
      expect(await find('goi mon')).toEqual(['Order'])
    })
    it('khớp nhiều từ: mới nhất trước', async () => {
      expect(await find('don')).toEqual(['bill', 'menu']) // "hóa đơn" và "thực đơn"
    })
    it('không có kết quả → rỗng, matched = 0', async () => {
      const r = await json(await call('/api/vocab?q=zzz'))
      expect(r.items).toEqual([])
      expect(r.matched).toBe(0)
      expect(r.stats.total).toBe(4) // thống kê vẫn là của cả kho
    })
    it('ký tự đặc biệt của SQL/regex được xem là chữ thường, không gây lỗi', async () => {
      for (const q of ['%', '_', "'; DROP TABLE vocab; --", '.*', '\\']) expect((await call(`/api/vocab?q=${encodeURIComponent(q)}`)).status).toBe(200)
      expect(await find('%')).toEqual([])
      expect((await json(await call('/api/vocab'))).stats.total).toBe(4)
    })
    it('khoảng trắng đầu/cuối được bỏ; chuỗi rỗng = tất cả', async () => {
      expect(await find('  menu  ')).toEqual(['menu'])
      expect(await find('')).toHaveLength(4)
    })
  })

  describe('bộ lọc', () => {
    beforeEach(async () => {
      await addWord('known', { learned: 1, interval: 30, due: addDays(TODAY, 30) })
      await addWord('duenow', { due: TODAY })
      await addWord('overdue', { due: addDays(TODAY, -4) })
      await addWord('later', { due: addDays(TODAY, 5), interval: 5 })
    })
    const f = async (filter: string) => (await json(await call(`/api/vocab?filter=${filter}`))).items.map((i: any) => i.word).sort()
    it('all', async () => expect(await f('all')).toEqual(['duenow', 'known', 'later', 'overdue']))
    it('due: chỉ từ đến hạn ôn', async () => expect(await f('due')).toEqual(['duenow', 'overdue']))
    it('learned: chỉ từ đã thuộc', async () => expect(await f('learned')).toEqual(['known']))
    it('learning: chưa thuộc', async () => expect(await f('learning')).toEqual(['duenow', 'later', 'overdue']))
    it('bộ lọc không hợp lệ → 400', async () => expect((await call('/api/vocab?filter=weird')).status).toBe(400))
    it('kết hợp tìm kiếm + bộ lọc', async () => {
      expect((await json(await call('/api/vocab?filter=due&q=over'))).items.map((i: any) => i.word)).toEqual(['overdue'])
      expect((await json(await call('/api/vocab?filter=learned&q=over'))).items).toEqual([])
    })
    it('matched đếm theo bộ lọc, stats vẫn là của cả kho', async () => {
      const r = await json(await call('/api/vocab?filter=due'))
      expect(r.matched).toBe(2)
      expect(r.stats).toMatchObject({ total: 4, learned: 1, due: 2 })
    })
  })

  it(`phân trang ${PAGE_SIZE} từ/trang`, async () => {
    for (let i = 0; i < PAGE_SIZE + 5; i++) await addWord('w' + String(i).padStart(3, '0'))
    const p1 = await json(await call('/api/vocab'))
    expect(p1.items).toHaveLength(PAGE_SIZE)
    expect(p1).toMatchObject({ matched: PAGE_SIZE + 5, page: 1, page_size: PAGE_SIZE })
    const p2 = await json(await call('/api/vocab?page=2'))
    expect(p2.items).toHaveLength(5)
    expect(new Set([...p1.items, ...p2.items].map((i: any) => i.id)).size).toBe(PAGE_SIZE + 5) // không trùng, không sót
    expect((await json(await call('/api/vocab?page=99'))).items).toEqual([])
    expect((await json(await call('/api/vocab?page=-3'))).page).toBe(1)
    expect((await json(await call('/api/vocab?page=abc'))).page).toBe(1)
  })

  it('không lộ khóa nội bộ nào ngoài các trường cần hiển thị', async () => {
    await addWord('menu')
    expect(Object.keys((await json(await call('/api/vocab'))).items[0]).sort()).toEqual(
      ['created_at', 'due_date', 'example', 'id', 'interval_days', 'lapses', 'learned', 'learning_state', 'mastery_started_on', 'meaning', 'pos', 'recognized_on', 'reps', 'session_id', 'typed_streak', 'word', 'wrong_count'],
    )
  })
})

describe('liên thông: ôn → kho', () => {
  it('từ ôn đạt "đã thuộc" xuất hiện ở bộ lọc "Đã thuộc" và thống kê', async () => {
    const id = await addWord('menu', { interval: 9, reps: 3, due: TODAY })
    await db.prepare('UPDATE vocab SET typed_streak = 2, mastery_started_on = ?, last_success_on = ? WHERE id = ?').bind(addDays(TODAY, -7), addDays(TODAY, -2), id).run()
    await call(`/api/flashcards/${id}/review`, { grade: 'good', typed: 'menu' })
    const r = await json(await call('/api/vocab?filter=learned'))
    expect(r.items.map((i: any) => i.word)).toEqual(['menu'])
    expect(r.stats).toMatchObject({ learned: 1, due: 0 })
  })
})
