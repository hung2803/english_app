// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VocabReview from './components/VocabReview'

type Resp = { status?: number; body: unknown }
function server(routes: Record<string, Resp | Resp[]>) {
  const calls: { key: string; body?: any }[] = []
  const counts: Record<string, number> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace('/api', '')}`
      calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined })
      const h = routes[key]
      if (!h) return Response.json({ message: 'không có route ' + key }, { status: 404 })
      const list = Array.isArray(h) ? h : [h]
      const r = list[Math.min(counts[key] ?? 0, list.length - 1)]
      counts[key] = (counts[key] ?? 0) + 1
      return Response.json(r.body, { status: r.status ?? 200 })
    }),
  )
  return { calls }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const GET = 'GET /sessions/7/vocab-review'
const POST = 'POST /sessions/7/vocab-review'
const st = (stage: number, round = 0) => ({ total: 2, stage, stages: 3, round })
const MCQ = [
  { word: 'order', kind: 'mcq', dir: 'en_vi', prompt: 'order', options: ['gọi món', 'hóa đơn', 'thực đơn', 'bồi bàn'] },
  { word: 'menu', kind: 'mcq', dir: 'vi_en', prompt: 'thực đơn', options: ['bill', 'menu', 'tip', 'waiter'] },
]
const res = (stage: number, o: Record<string, unknown>) => ({
  passed: false, stage, cleared: false, next_stage: stage, round: 1,
  results: [{ word: 'order', meaning: 'gọi món', correct: true }, { word: 'menu', meaning: 'thực đơn', correct: false }], ...o,
})


const CHECK = POST + '/check'
const WORD = { word: 'order', meaning: 'meaning', correct: true }
const QUESTION = { word: 'order', kind: 'type', prompt: 'meaning' }
const checkAnswer = async () => {
 fireEvent.change(await screen.findByLabelText('\u0110\u00e1p \u00e1n'), { target: { value: 'order' } })
 fireEvent.submit(screen.getByLabelText('\u0110\u00e1p \u00e1n').closest('form')!)
 await screen.findByRole('button', { name: 'Ho\u00e0n th\u00e0nh l\u01b0\u1ee3t' })
}
describe('mixed vocabulary review', () => {
 it('asks before revealing the answer, checks on the server, and saves only when finishing',async()=>{
  const calls=server({[GET]:{body:{status:st(1),questions:[QUESTION],study:[]}},[CHECK]:{body:{results:[WORD]}},[POST]:{body:res(1,{passed:true,cleared:true,results:[WORD]})}}).calls
  const done=vi.fn();render(<VocabReview sessionId={7} onPassed={done}/>);
  await screen.findByLabelText('\u0110\u00e1p \u00e1n');expect(screen.queryByText('order')).toBeNull();
  await checkAnswer();expect(calls.filter(c=>c.key===POST)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Ho\u00e0n th\u00e0nh l\u01b0\u1ee3t'}));
  fireEvent.click(await screen.findByRole('button',{name:'B\u1eaft \u0111\u1ea7u b\u00e0i h\u1ecdc'}));
  expect(done).toHaveBeenCalledTimes(1);
  expect(calls.find(c=>c.key===POST)!.body).toEqual({answers:[{word:'order',choice:'order'}]});
 });
 it('loads only the remaining wrong words for a retry',async()=>{
  const wrong={...WORD,correct:false};
  const calls=server({[GET]:[{body:{status:st(1),questions:[QUESTION]}},{body:{status:st(1,1),questions:[QUESTION]}}],[CHECK]:{body:{results:[wrong]}},[POST]:{body:res(1,{results:[wrong]})}}).calls;
  render(<VocabReview sessionId={7} onPassed={()=>{}}/>);await checkAnswer();
  fireEvent.click(screen.getByRole('button',{name:'Ho\u00e0n th\u00e0nh l\u01b0\u1ee3t'}));
  fireEvent.click(await screen.findByRole('button',{name:/1 t\u1eeb sai/}));
  await screen.findByLabelText('\u0110\u00e1p \u00e1n');expect(calls.filter(c=>c.key===GET)).toHaveLength(2);
 });
 it('can continue after a retry even when some words still need review',async()=>{
  const wrong={...WORD,correct:false};
  server({[GET]:{body:{status:st(1,1),questions:[QUESTION]}},[CHECK]:{body:{results:[wrong]}},[POST]:{body:res(1,{passed:true,results:[wrong]})}});
  const done=vi.fn();render(<VocabReview sessionId={7} onPassed={done}/>);await checkAnswer();
  fireEvent.click(screen.getByRole('button',{name:'Ho\u00e0n th\u00e0nh l\u01b0\u1ee3t'}));
  expect(await screen.findByText(/gi\u1eef l\u1ea1i trong l\u1ecbch \u00f4n/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'B\u1eaft \u0111\u1ea7u b\u00e0i h\u1ecdc'}));expect(done).toHaveBeenCalled();
 });
 it('keeps the current question when checking fails',async()=>{
  server({[GET]:{body:{status:st(1),questions:[QUESTION]}},[CHECK]:{status:500,body:{message:'check failed'}}});
  render(<VocabReview sessionId={7} onPassed={()=>{}}/>);
  fireEvent.change(await screen.findByLabelText('\u0110\u00e1p \u00e1n'),{target:{value:'order'}});
  fireEvent.submit(screen.getByLabelText('\u0110\u00e1p \u00e1n').closest('form')!);
  expect(await screen.findByText('check failed')).toBeTruthy();expect(screen.getByTestId('review-prompt').textContent).toBe('meaning');
 });
});
