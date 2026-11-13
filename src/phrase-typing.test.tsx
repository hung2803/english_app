// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Flashcards from './components/Flashcards'

afterEach(() => {cleanup(); vi.unstubAllGlobals()})
const answer = () => screen.getByLabelText('Viết lại từ tiếng Anh')
function setup(example: string | null = 'Nice to meet you, Tom.') {
  const calls: any[] = []
  vi.stubGlobal('fetch',vi.fn(async (_url,init) => {
    if (init?.body) {calls.push(JSON.parse(init.body)); return Response.json({next:{},remaining_due:0})}
    return Response.json({cards:[{id:1,word:'Nice to meet you',meaning:'Rất vui được gặp bạn',example,pos:'phrase'}],total_due:1})
  }))
  render(<Flashcards style="type" />)
  return calls
}
it('shows the phrase length and a masked example before the learner answers',async()=>{
  setup()
  await screen.findByLabelText('Viết lại từ tiếng Anh')
  expect(screen.getByText('4 từ')).toBeTruthy()
  expect(screen.getByTestId('recall-context').textContent).toBe('_____, Tom.')
  expect(screen.queryByTestId('card-word')).toBeNull()
  expect(screen.queryByLabelText('Các từ gợi ý')).toBeNull()
})
it('offers a word bank and acknowledges correct assisted answers without claiming mastery',async()=>{
  const calls=setup(null)
  await screen.findByLabelText('Viết lại từ tiếng Anh')
  fireEvent.click(screen.getByRole('button',{name:'Gợi ý'}))
  const bank=screen.getByLabelText('Các từ gợi ý')
  for(const word of ['Nice','to','meet','you'])expect(within(bank).getByText(word)).toBeTruthy()
  fireEvent.change(answer(),{target:{value:'nice to meet you!'}})
  fireEvent.click(screen.getByRole('button',{name:'Kiểm tra'}))
  expect(screen.getByText('✅ Đúng với gợi ý!')).toBeTruthy()
  expect(screen.queryByRole('button',{name:'Tốt'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'Tiếp tục'}))
  await waitFor(()=>expect(calls).toEqual([{grade:'hard',typed:'nice to meet you!',assisted:true}]))
})
it('does not count a punctuation difference as a failed unassisted phrase recall',async()=>{
  const calls=setup()
  await screen.findByLabelText('Viết lại từ tiếng Anh')
  fireEvent.change(answer(),{target:{value:'nice to meet you.'}})
  fireEvent.click(screen.getByRole('button',{name:'Kiểm tra'}))
  expect(screen.getByText('✅ Đúng rồi!')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'Tốt'}))
  await waitFor(()=>expect(calls[0]).toMatchObject({grade:'good',typed:'nice to meet you.'}))
  expect(calls[0].assisted).toBeUndefined()
})
