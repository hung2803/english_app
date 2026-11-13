// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { afterEach,expect,it,vi } from 'vitest'
import ChoiceRecall from './components/ChoiceRecall'
import Flashcards from './components/Flashcards'

afterEach(()=>{cleanup();vi.unstubAllGlobals()})
const question={prompt:'quyển sách',phrase:false,options:['pen','book','bag','chair']}
function server(correct=true){
  const calls:any[]=[]
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    calls.push({url:String(url),body:init?.body?JSON.parse(init.body):undefined})
    if(String(url).includes('/due'))return Response.json({cards:[{id:1,word:'book',meaning:'quyển sách',example:null,pos:null,recall_stage:'choice'}],total_due:1})
    if(!init?.body)return Response.json(question)
    return Response.json({correct,word:'book',meaning:'quyển sách',example:'This is a red book.'})
  }))
  return calls
}
it('asks for a choice from the Vietnamese meaning without a typing field or context riddle',async()=>{
  const calls=server();const done=vi.fn();render(<ChoiceRecall id={1} practice={false} onDone={done}/>);
  await screen.findByText('quyển sách');expect(screen.queryByRole('textbox')).toBeNull();expect(screen.queryByText('This is a red book.')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'B. book'}));expect(await screen.findByText('✓ Nhận biết được!')).toBeTruthy()
  expect(screen.getByText('This is a red book.')).toBeTruthy();expect(done).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'Tiếp tục'}));expect(done).toHaveBeenCalledWith(true)
  expect(calls.find(c=>c.body)?.body).toEqual({choice:'book'})
})
it('wrong choices reveal the correct word and complete with a retry signal',async()=>{
  server(false);const done=vi.fn();render(<ChoiceRecall id={1} practice onDone={done}/>);
  fireEvent.click(await screen.findByRole('button',{name:'D. chair'}));await screen.findByText('Chưa đúng · xem lại đáp án')
  expect(screen.getByText('Bạn chọn: chair')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Tiếp tục'}));expect(done).toHaveBeenCalledWith(false)
})
it('automatic review starts new words with choices and records them only once',async()=>{
  const calls=server();render(<Flashcards/>);
  fireEvent.click(await screen.findByRole('button',{name:'B. book'}));await screen.findByText('✓ Nhận biết được!')
  fireEvent.click(screen.getByRole('button',{name:'Tiếp tục'}));expect(await screen.findByText('✅ Xong lượt ôn!')).toBeTruthy()
  expect(calls[0].url).toContain('adaptive=1');expect(calls.filter(c=>c.body)).toHaveLength(1)
  expect(calls.some(c=>c.url.endsWith('/review'))).toBe(false)
})
it('network errors do not advance the word or claim a correct choice',async()=>{
  const done=vi.fn();vi.stubGlobal('fetch',vi.fn(async(_url,init)=>!init?.body?Response.json(question):Response.json({message:'save failed'},{status:500})))
  render(<ChoiceRecall id={1} practice={false} onDone={done}/>);fireEvent.click(await screen.findByRole('button',{name:'B. book'}))
  await screen.findByText('save failed');expect(done).not.toHaveBeenCalled();expect(screen.queryByText('✓ Nhận biết được!')).toBeNull()
  await waitFor(()=>expect((screen.getByRole('button',{name:'B. book'}) as HTMLButtonElement).disabled).toBe(false))
})
