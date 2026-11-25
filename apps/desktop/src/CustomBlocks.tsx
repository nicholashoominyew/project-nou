import {useEffect,useRef,useState} from "react";
import {createReactBlockSpec,useEditorChange} from "@blocknote/react";
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
/**
 * A link to another page, drawn as a plain line or as a bordered box. Switch between them from the block's ⠿ menu ("Show as a line / box").
 * Links saved before this existed have no style and stay boxes. `iconSize` is no longer used; it stays in the block so older notes still load.
 */
export const pageBlock=createReactBlockSpec({type:"nouPage",propSchema:{pageId:{default:""},label:{default:"Untitled"},iconSize:{default:"medium",values:["small","medium","big"] as const},style:{default:"box",values:["line","box"] as const},boxBorder:{default:"default"},boxFill:{default:"default"}},content:"none"},{
 render:({block})=>{
  const context=useEditorFeatures();const page=context.pages.find(p=>p.id===block.props.pageId);const box=block.props.style==="box";
  return <div className={"page-link "+(box?"page-link-box":"page-link-line")} data-border={box?boxColor(block.props.boxBorder):undefined} data-fill={box?boxColor(block.props.boxFill):undefined} contentEditable={false}>
   <button className="page-link-open" disabled={!context.canNavigate||!page} onClick={()=>context.open(block.props.pageId)}><Icon name={page?.icon} size={box?26:18}/><span>{page?.title||block.props.label}{!page&&" (unavailable)"}</span></button>
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
import FlowchartView from "./FlowchartView";
import {boxColor} from "./blockOps";
import EmbedView from "./Embed";
import {DEFAULT_HEIGHT} from "./embed";
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
 // One compact row for a PDF (name, Preview, Save a copy) and a bare image; the controls only appear on hover or focus.
 return <div className={"stored-file"+(pdf?" pdf-row":" image-row")} contentEditable={false}>{error?<p role="alert">{error}</p>:!url?<p>Opening file…</p>:pdf?<><div className="pdf-caption"><Icon name="document" size={16}/><strong title={name}>{name}</strong><button onClick={()=>setPreview(v=>!v)}>{preview?"Hide":"Preview"}</button><button onClick={()=>void saveCopy(id,name,pdf).catch(context.onError)}>Save a copy</button></div>{preview&&<iframe title={name} src={url}/>}</>:<ResizableImage url={url} name={name} width={image?.width??0} editable={!!image?.editable} onWidth={image?.onWidth??(()=>{})}/>}</div>;
}
export const imageBlock=createReactBlockSpec({type:"nouImage",propSchema:{fileId:{default:""},name:{default:"Image"},width:{default:0}},content:"none"},{render:({block,editor})=><StoredFile id={block.props.fileId} name={block.props.name} pdf={false} image={{width:block.props.width,editable:editor.isEditable,onWidth:width=>editor.updateBlock(block,{props:{width}})}}/>});
export const pdfBlock=createReactBlockSpec({type:"nouPdf",propSchema:{fileId:{default:""},name:{default:"Document.pdf"}},content:"none"},{render:({block})=><StoredFile id={block.props.fileId} name={block.props.name} pdf/>});
/** Any other file (HTML, documents, archives, ...). It is stored and can be saved back out; it is never opened or rendered in the app. */
export const fileBlock=createReactBlockSpec({type:"nouFile",propSchema:{fileId:{default:""},name:{default:"File"}},content:"none"},{render:({block})=>{
 const context=useEditorFeatures();
 return <div className="stored-file file-card" contentEditable={false}><Icon name="document" size={16}/><strong>{block.props.name}</strong><button onClick={()=>void saveCopy(block.props.fileId,block.props.name,false).catch(context.onError)}>Save a copy</button></div>;
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
/** A flowchart drawn in the note. The chart is stored as JSON in the block (validated on every read); it uses no outside libraries. */
export const flowchartBlock=createReactBlockSpec({type:"nouFlowchart",propSchema:{data:{default:""},mode:{default:"edit",values:["edit","view"] as const}},content:"none"},{
 render:({block,editor})=><FlowchartView data={block.props.data} editable={editor.isEditable} mode={block.props.mode} onChange={json=>editor.updateBlock(block,{props:{data:json}})}/>
});
/**
 * Side-by-side columns. The block's child blocks are the columns: each direct child sits in its own column and can hold anything (text, lists,
 * images, pages). Drag blocks into a column, or press Tab to nest them, as with any block. The layout itself is done by the stylesheet.
 */
function ColumnsHeader({block,editor}:{block:{id:string};editor:any}){
 const read=()=>(editor.getBlock(block.id)?.children??[]).length as number;
 const [count,setCount]=useState(read);
 useEditorChange(()=>setCount(read()),editor);
 return <div className="columns-header" contentEditable={false}><span>{count} column{count===1?"":"s"}</span>
  {editor.isEditable&&count<5&&<button aria-label="Add a column" onClick={()=>{const kids=editor.getBlock(block.id)?.children??[];const last=kids[kids.length-1];if(last)editor.insertBlocks([{type:"paragraph"}] as never,last,"after");else editor.updateBlock(block as never,{children:[{type:"paragraph"}]} as never);setCount(read())}}>+ Add column</button>}</div>;
}
export const columnsBlock=createReactBlockSpec({type:"nouColumns",propSchema:{},content:"none"},{
 render:({block,editor})=><ColumnsHeader block={block} editor={editor}/>
});

/**
 * An embedded page: a live frame of an allowed https page (a Claude artifact, for example), or a snapshot (an .html file stored with the page). `url`, `title`, `height` (pixels),
 * `mode` ("live" or "snapshot") and, for a snapshot, `fileId` (the stored file). Pages that forbid framing show as a card with "Open in new tab".
 */
export const embedBlock=createReactBlockSpec({type:"nouEmbed",propSchema:{url:{default:""},title:{default:""},height:{default:DEFAULT_HEIGHT},mode:{default:"live",values:["live","snapshot"] as const},fileId:{default:""}},content:"none"},{
 render:({block,editor})=>{
  const context=useEditorFeatures();
  return <EmbedView url={block.props.url} title={block.props.title} height={block.props.height} mode={block.props.mode} fileId={block.props.fileId} editable={editor.isEditable} onError={context.onError}
   onChange={patch=>editor.updateBlock(block,{props:patch} as never)}
   onAttach={async file=>{const info=await context.uploadFile(file);editor.updateBlock(block,{props:{fileId:info.id,mode:"snapshot",title:block.props.title||file.name.replace(/\.html?$/i,"")}} as never)}}/>;
 }
});
