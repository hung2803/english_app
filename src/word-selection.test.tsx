// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { afterEach,expect,it,vi } from 'vitest'
import LessonVocabulary from './components/LessonVocabulary'
const words=[{word:'menu',meaning_vi:'food list',example:'Read the menu.'},{word:'book',meaning_vi:'reserve'}]
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function server(fail=false){
 let selected=false;const calls:any[]=[]
 vi.stubGlobal('fetch',vi.fn(async(_input,init)=>{
  if(init?.body){calls.push(JSON.parse(init.body));if(fail)return Response.json({message:'save failed'},{status:500});selected=JSON.parse(init.body).selected}
  return Response.json({words:words.map(w=>({...w,state:w.word==='menu'&&selected?'queued':'available',recommended:true,learned:false}))})
 }));return calls
}
it('shows all lesson words without enrolling them and allows selecting then removing a word',async()=>{
 const calls=server();render(<LessonVocabulary sessionId={1} words={words}/>);
 expect(await screen.findByText('Read the menu.')).toBeTruthy();
 const add=await screen.findByRole('button',{name:'Th\u00eam v\u00e0o \u00f4n t\u1eadp: menu'});await waitFor(()=>expect((add as HTMLButtonElement).disabled).toBe(false));
 expect(calls).toHaveLength(0);fireEvent.click(add);
 expect(await screen.findByText('\u0110\u00e3 ch\u1ecdn, ch\u1edd h\u1ecdc')).toBeTruthy();
 const remove=await screen.findByRole('button',{name:'B\u1ecf kh\u1ecfi \u00f4n t\u1eadp: menu'});fireEvent.click(remove);
 await waitFor(()=>expect(calls).toHaveLength(2));expect(calls).toEqual([{word:'menu',selected:true},{word:'menu',selected:false}]);
})
it('does not claim a selection was saved when the server rejects it',async()=>{
 server(true);render(<LessonVocabulary sessionId={1} words={words}/>);
 const add=await screen.findByRole('button',{name:'Th\u00eam v\u00e0o \u00f4n t\u1eadp: menu'});await waitFor(()=>expect((add as HTMLButtonElement).disabled).toBe(false));fireEvent.click(add);
 expect(await screen.findByText('save failed')).toBeTruthy();expect(screen.queryByText('\u0110\u00e3 ch\u1ecdn, ch\u1edd h\u1ecdc')).toBeNull();
})
it('read-only lesson rendering without a session still allows viewing all words',()=>{
 render(<LessonVocabulary words={words}/>);expect(screen.getByText('menu')).toBeTruthy();expect(screen.queryByRole('button',{name:/menu$/})).toBeNull();
})
