// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Flashcards from './components/Flashcards'
const label='Vi\u1ebft l\u1ea1i t\u1eeb ti\u1ebfng Anh'
const button=(name:string)=>screen.getByRole('button',{name})
const cards=[{id:1,word:'book',meaning:'reserve',example:'Please book a table.',pos:null},{id:2,word:'menu',meaning:'food list',example:'Read the menu.',pos:null},{id:3,word:'bill',meaning:'payment',example:null,pos:null}]
function setup(selected=cards) {
 const calls:any[]=[]
 vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
  if(!init?.body)return Response.json({cards:selected,total_due:selected.length})
  calls.push(JSON.parse(init.body));return Response.json({next:{},remaining_due:0})
 }))
 return calls
}
function type(word:string){fireEvent.change(screen.getByLabelText(label),{target:{value:word}});fireEvent.click(button('Ki\u1ec3m tra'))}
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete (window as any).speechSynthesis})
it('mixed mode alternates meaning, context and listening without showing the answer',async()=>{
 setup();vi.stubGlobal('SpeechSynthesisUtterance',class{});(window as any).speechSynthesis={cancel:vi.fn(),speak:vi.fn(),getVoices:()=>[]}
 render(<Flashcards/>);await screen.findByLabelText(label);expect(screen.queryByTestId('card-word')).toBeNull()
 type('book');fireEvent.click(button('T\u1ed1t'))
 await screen.findByText('Read the _____.');expect(screen.queryByText('menu')).toBeNull()
 type('menu');fireEvent.click(button('T\u1ed1t'))
 await screen.findByRole('button',{name:'Nghe t\u1eeb c\u1ea7n vi\u1ebft'});expect(screen.queryByText('bill')).toBeNull()
})
it('listening falls back to meaning when speech is unsupported',async()=>{
 setup([cards[0]]);render(<Flashcards style="listen"/>);expect(await screen.findByTestId('card-meaning')).toBeTruthy();expect(screen.queryByTestId('card-word')).toBeNull()
})
it('correct assisted recall continues without a mastery grade or a false failure',async()=>{
 const calls=setup([cards[0]]);render(<Flashcards/>);await screen.findByLabelText(label)
 fireEvent.click(button('G\u1ee3i \u00fd'));type('book');expect(screen.queryByRole('button',{name:'T\u1ed1t'})).toBeNull()
 expect(screen.getByText('✅ Đúng với gợi ý!')).toBeTruthy()
 fireEvent.click(button('Tiếp tục'));await waitFor(()=>expect(calls[0]).toMatchObject({grade:'hard',assisted:true}))
})
it('two wrong attempts finish a round and retain the unresolved word',async()=>{
 const calls=setup([cards[0]]);render(<Flashcards/>);await screen.findByLabelText(label)
 for(let i=0;i<2;i++){type('wrong');fireEvent.click(button('Qu\u00ean'));await waitFor(()=>expect(calls).toHaveLength(i+1));if(i===0)await screen.findByLabelText(label)}
 expect(await screen.findByText(/1 t\u1eeb c\u1ea7n \u00f4n th\u00eam/)).toBeTruthy()
 expect(calls.every(c=>c.grade==='again')).toBe(true)
})
it('places an explicit Vietnamese target beside the blank in a contextual question',async()=>{
 setup([{...cards[0],meaning:'quyển sách',example:'This is a red book.'}]);render(<Flashcards style="type"/>);
 await screen.findByLabelText(label);
 expect(screen.getByTestId('recall-context').textContent).toBe('This is a red _____.');
 expect(screen.getByText('Từ cần điền có nghĩa là:')).toBeTruthy();
 expect(screen.getByTestId('card-meaning').textContent).toBe('quyển sách');
 expect(screen.getByPlaceholderText('Nhập tiếng Anh của “quyển sách”')).toBeTruthy();
 expect(screen.queryByTestId('card-word')).toBeNull();
})
