import {useEffect,useRef,useState} from "react";
import {createReactBlockSpec} from "@blocknote/react";
import {invoke} from "@tauri-apps/api/core";
import {save} from "@tauri-apps/plugin-dialog";
import {Icon} from "./Icons";
import {useEditorFeatures} from "./EditorContext";
export function bookmarkUrl(value:string):string{
 const text=value.trim();if(!text)throw Error("Enter a web address.");
 const u=new URL(/^[a-z][a-z0-9+.-]*:/i.test(text)?text:"https://"+text);
 if(!["https:","http:"].includes(u.protocol)||u.username||u.password)throw Error("Use an HTTP or HTTPS address without embedded credentials.");
 return u.href;
}
const sizes={small:18,medium:28,big:44} as const;
export const pageBlock=createReactBlockSpec({type:"nouPage",propSchema:{pageId:{default:""},label:{default:"Untitled"},iconSize:{default:"medium",values:["small","medium","big"] as const}},content:"none"},{
 render:({block,editor})=>{
  const context=useEditorFeatures();const page=context.pages.find(p=>p.id===block.props.pageId);
  return <div className="page-link-card" contentEditable={false}>
   <button className="page-link-open" disabled={!context.canNavigate||!page} onClick={()=>context.open(block.props.pageId)}><Icon name={page?.icon} size={sizes[block.props.iconSize]}/><span>{page?.title||block.props.label}{!page&&" (unavailable)"}</span></button>
   {editor.isEditable&&<div className="icon-size-options" aria-label="Page link icon size">{(["small","medium","big"] as const).map(size=><button key={size} aria-pressed={block.props.iconSize===size} onClick={()=>editor.updateBlock(block,{props:{iconSize:size}})}>{size}</button>)}</div>}
  </div>;
 }
});
export const bookmarkBlock=createReactBlockSpec({type:"nouBookmark",propSchema:{url:{default:""},title:{default:""}},content:"none"},{
 render:({block,editor})=>{
  const context=useEditorFeatures();let normalized="";try{normalized=bookmarkUrl(block.props.url)}catch{}
  return <div className="bookmark-card" contentEditable={false}><Icon name="link" size={24}/><div>
   <input aria-label="Bookmark title" placeholder="Bookmark title" readOnly={!editor.isEditable} value={block.props.title} onChange={e=>editor.updateBlock(block,{props:{title:e.target.value}})}/>
   <input aria-label="Bookmark URL" placeholder="https://example.com" readOnly={!editor.isEditable} value={block.props.url} onChange={e=>editor.updateBlock(block,{props:{url:e.target.value}})}/>
  </div><button disabled={!normalized} onClick={()=>void invoke("open_bookmark",{url:normalized}).catch(context.onError)}>Open ↗</button></div>;
 }
});
import Database from "./DatabaseView";
const MIN_IMAGE_WIDTH=80;
function useBlobUrl(id:string){
 const [url,setUrl]=useState("");const [error,setError]=useState("");
 useEffect(()=>{let cancelled=false;let resource="";setUrl("");setError("");if(!id)return;
  void invoke<{data:number[];info:{mime:string}}>("read_attachment",{id}).then(file=>{if(cancelled)return;resource=URL.createObjectURL(new Blob([Uint8Array.from(file.data)],{type:file.info.mime}));setUrl(resource)}).catch(e=>{if(!cancelled)setError(String(e))});
  return()=>{cancelled=true;if(resource)URL.revokeObjectURL(resource)};},[id]);
 return {url,error};
}
async function saveCopy(id:string,name:string,pdf:boolean){
 const ext=pdf?"pdf":name.includes(".")?name.split(".").pop()!.toLowerCase():"";
 const path=await save({defaultPath:name,filters:ext?[{name:ext.toUpperCase(),extensions:[ext]}]:undefined});
 if(path)await invoke("export_attachment",{id,path});
}
function ResizableImage({url,name,width,editable,onWidth}:{url:string;name:string;width:number;editable:boolean;onWidth:(width:number)=>void}){
 const box=useRef<HTMLDivElement>(null);const [live,setLive]=useState<number|null>(null);
 const limit=()=>box.current?.parentElement?.clientWidth||1200;
 const clamp=(value:number)=>Math.round(Math.max(MIN_IMAGE_WIDTH,Math.min(value,limit())));
 function startDrag(event:React.PointerEvent){
  event.preventDefault();event.stopPropagation();const startX=event.clientX;const startWidth=box.current?.getBoundingClientRect().width||0;
  const move=(e:PointerEvent)=>setLive(clamp(startWidth+e.clientX-startX));
  const up=(e:PointerEvent)=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",up);setLive(null);onWidth(clamp(startWidth+e.clientX-startX))};
  window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);window.addEventListener("pointercancel",up);
 }
 const current=live??width;
 return <div className={live!==null?"resizable-image dragging":"resizable-image"} ref={box} style={current>0?{width:current}:undefined}>
  <img src={url} alt={name} draggable={false}/>
  {editable&&<>
   <div className="image-sizes" role="group" aria-label="Image size">{[25,50,75,100].map(percent=><button key={percent} onClick={()=>onWidth(clamp(limit()*percent/100))}>{percent}%</button>)}<button onClick={()=>onWidth(0)} title="Original size">Auto</button></div>
   <button className="resize-handle" role="slider" aria-label="Image width" aria-orientation="horizontal" aria-valuemin={MIN_IMAGE_WIDTH} aria-valuemax={limit()} aria-valuenow={Math.round(current>0?current:box.current?.getBoundingClientRect().width||0)}
    onPointerDown={startDrag} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();const base=current>0?current:box.current?.getBoundingClientRect().width||limit();onWidth(clamp(base+(e.key==="ArrowRight"?20:-20)))}}}/>
  </>}
 </div>;
}
function StoredFile({id,name,pdf,image}:{id:string;name:string;pdf:boolean;image?:{width:number;editable:boolean;onWidth:(width:number)=>void}}){
 const context=useEditorFeatures();const {url,error}=useBlobUrl(id);const [preview,setPreview]=useState(false);
 return <div className="stored-file" contentEditable={false}>{error?<p role="alert">{error}</p>:!url?<p>Opening file…</p>:pdf?<><div className="pdf-caption"><Icon name="document"/><strong>{name}</strong><button onClick={()=>setPreview(v=>!v)}>{preview?"Hide preview":"Preview PDF"}</button></div>{preview&&<iframe title={name} src={url}/>}</>:<ResizableImage url={url} name={name} width={image?.width??0} editable={!!image?.editable} onWidth={image?.onWidth??(()=>{})}/>}
 {pdf&&<div className="file-caption"><span>{name}</span><button disabled={!url} onClick={()=>void saveCopy(id,name,pdf).catch(context.onError)}>Save a copy</button></div>}</div>;
}
export const imageBlock=createReactBlockSpec({type:"nouImage",propSchema:{fileId:{default:""},name:{default:"Image"},width:{default:0}},content:"none"},{render:({block,editor})=><StoredFile id={block.props.fileId} name={block.props.name} pdf={false} image={{width:block.props.width,editable:editor.isEditable,onWidth:width=>editor.updateBlock(block,{props:{width}})}}/>});
export const pdfBlock=createReactBlockSpec({type:"nouPdf",propSchema:{fileId:{default:""},name:{default:"Document.pdf"}},content:"none"},{render:({block})=><StoredFile id={block.props.fileId} name={block.props.name} pdf/>});
/** Any other file (HTML, documents, archives, ...). It is stored and can be saved back out; it is never opened or rendered in the app. */
export const fileBlock=createReactBlockSpec({type:"nouFile",propSchema:{fileId:{default:""},name:{default:"File"}},content:"none"},{render:({block})=>{
 const context=useEditorFeatures();
 return <div className="stored-file file-card" contentEditable={false}><Icon name="document" size={22}/><strong>{block.props.name}</strong><button onClick={()=>void saveCopy(block.props.fileId,block.props.name,false).catch(context.onError)}>Save a copy</button></div>;
}});
/** An inline database: the block only stores the id; rows, columns and views live in the Notes database (ADR-003). */
export const databaseBlock=createReactBlockSpec({type:"nouDatabase",propSchema:{databaseId:{default:""}},content:"none"},{render:({block,editor})=>{
 const context=useEditorFeatures();
 return <div className="db-block" contentEditable={false}><Database databaseId={block.props.databaseId} readOnly={!editor.isEditable} onError={context.onError}/></div>;
}});
export type LinkedTodo={id:string;text:string;checked:boolean;pages:number};
/** Tells every open linked to-do about a change so copies on screen stay in step (other pages read the shared state when they open). */
export const announceLinkedTodo=(todo:LinkedTodo)=>{try{window.dispatchEvent(new CustomEvent("nou:linked-todo",{detail:todo}))}catch{/* only a refresh hint */}};
export function LinkedTodoView({todoId,cachedText,cachedChecked,editable,onCache}:{todoId:string;cachedText:string;cachedChecked:boolean;editable:boolean;onCache:(todo:{text:string;checked:boolean})=>void}){
 const context=useEditorFeatures();
 const [todo,setTodo]=useState<LinkedTodo|null>(null);const [missing,setMissing]=useState(false);const [draft,setDraft]=useState(cachedText);
 const [showPages,setShowPages]=useState(false);const [pages,setPages]=useState<{id:string;title:string}[]>([]);
 const editing=useRef(false);
 useEffect(()=>{let cancelled=false;
  void invoke<LinkedTodo[]>("linked_todo_get",{ids:[todoId]}).then(list=>{if(cancelled)return;const t=Array.isArray(list)?list[0]:undefined;if(t){setTodo(t);if(!editing.current)setDraft(t.text);setMissing(false)}else setMissing(true)}).catch(()=>{if(!cancelled)setMissing(true)});
  const on=(e:Event)=>{const t=(e as CustomEvent<LinkedTodo>).detail;if(t&&t.id===todoId){setTodo(t);if(!editing.current)setDraft(t.text)}};
  window.addEventListener("nou:linked-todo",on);return()=>{cancelled=true;window.removeEventListener("nou:linked-todo",on)};
 },[todoId]);
 const checked=todo?todo.checked:cachedChecked;
 async function change(next:{checked?:boolean;text?:string}){
  try{const t=await invoke<LinkedTodo>("linked_todo_set",{id:todoId,checked:next.checked??null,text:next.text??null});setTodo(t);setDraft(t.text);announceLinkedTodo(t);onCache({text:t.text,checked:t.checked})}
  catch(e){context.onError(e)}
 }
 async function togglePages(){
  const open=!showPages;setShowPages(open);
  if(open)try{setPages(await invoke<{id:string;title:string}[]>("linked_todo_pages",{id:todoId}))}catch{setPages([])}
 }
 return <div className={"linked-todo"+(checked?" done":"")} contentEditable={false}>
  <input type="checkbox" aria-label="Done" checked={checked} disabled={!editable||missing||!todo} onChange={e=>void change({checked:e.target.checked})}/>
  <input className="linked-todo-text" aria-label="To-do text" placeholder="To-do" value={missing?cachedText:draft} readOnly={!editable||missing}
   onFocus={()=>{editing.current=true}} onChange={e=>setDraft(e.target.value)}
   onBlur={()=>{editing.current=false;if(todo&&draft.trim()!==todo.text)void change({text:draft})}}
   onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();(e.target as HTMLInputElement).blur()}}}/>
  {missing?<span className="linked-todo-note" role="status">Unavailable</span>
   :<button className="linked-todo-pages" aria-expanded={showPages} aria-label={"Shown on "+(todo?.pages??0)+" pages"} title="Where this to-do appears" onClick={()=>void togglePages()}><Icon name="link" size={14}/>{todo?.pages??""}</button>}
  {showPages&&<div className="linked-todo-list" role="group" aria-label="Pages with this to-do">{!pages.length?<em>Not on any other page yet</em>:pages.map(p=><button key={p.id} disabled={!context.canNavigate} onClick={()=>context.open(p.id)}>{p.title||"Untitled"}</button>)}</div>}
 </div>;
}
/** A to-do that can appear on several pages. Its state lives in the Notes database (linked_todos); the block stores the id and a copy of the text for search. */
export const linkedTodoBlock=createReactBlockSpec({type:"nouLinkedTodo",propSchema:{todoId:{default:""},text:{default:""},checked:{default:false}},content:"none"},{
 render:({block,editor})=><LinkedTodoView todoId={block.props.todoId} cachedText={block.props.text} cachedChecked={block.props.checked} editable={editor.isEditable}
  onCache={t=>{if(t.text!==block.props.text||t.checked!==block.props.checked)editor.updateBlock(block,{props:{text:t.text,checked:t.checked}})}}/>
});
