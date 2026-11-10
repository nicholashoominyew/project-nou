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
