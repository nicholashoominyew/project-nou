import {useEffect,useState} from "react";
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
function StoredFile({id,name,pdf}:{id:string;name:string;pdf:boolean}){
 const context=useEditorFeatures();const [url,setUrl]=useState("");const [error,setError]=useState("");const [preview,setPreview]=useState(false);
 useEffect(()=>{let cancelled=false;let resource="";setUrl("");setError("");if(!id)return;
 void invoke<{data:number[];info:{mime:string}}>("read_attachment",{id}).then(file=>{if(cancelled)return;resource=URL.createObjectURL(new Blob([Uint8Array.from(file.data)],{type:file.info.mime}));setUrl(resource);}).catch(e=>{if(!cancelled)setError(String(e))});
 return()=>{cancelled=true;if(resource)URL.revokeObjectURL(resource)};},[id]);
 async function download(){try{const ext=pdf?"pdf":name.split(".").pop()||"png";const path=await save({defaultPath:name,filters:[{name:pdf?"PDF":"Image",extensions:[ext]}]});if(path)await invoke("export_attachment",{id,path});}catch(e){context.onError(e)}}
 return <div className="stored-file" contentEditable={false}>{error?<p role="alert">{error}</p>:!url?<p>Opening file…</p>:pdf?<><div className="pdf-caption"><Icon name="document"/><strong>{name}</strong><button onClick={()=>setPreview(v=>!v)}>{preview?"Hide preview":"Preview PDF"}</button></div>{preview&&<iframe title={name} src={url}/>}</>:<img src={url} alt={name}/>}
 <div className="file-caption"><span>{name}</span><button disabled={!url} onClick={()=>void download()}>Save a copy</button></div></div>;
}
export const imageBlock=createReactBlockSpec({type:"nouImage",propSchema:{fileId:{default:""},name:{default:"Image"}},content:"none"},{render:({block})=><StoredFile id={block.props.fileId} name={block.props.name} pdf={false}/>});
export const pdfBlock=createReactBlockSpec({type:"nouPdf",propSchema:{fileId:{default:""},name:{default:"Document.pdf"}},content:"none"},{render:({block})=><StoredFile id={block.props.fileId} name={block.props.name} pdf/>});
