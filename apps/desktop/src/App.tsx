import type {SaveStatus} from "./NoteEditor";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {lazy,Suspense,useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open as chooseFile} from "@tauri-apps/plugin-dialog";
import * as Y from "yjs";
import {EditorFeatures,type PageInfo,type FileInfo} from "./EditorContext";
import {Icon,iconNames} from "./Icons";
import {pageDrop,type DropPosition} from "./workspaceModel";
const NoteEditor=lazy(()=>import("./NoteEditor"));
const BackupPanel=lazy(()=>import("./BackupPanel"));
const ImportNotePanel=lazy(()=>import("./ImportNotePanel"));
type Page=PageInfo;type SearchHit={id:string;title:string;parent_id:string|null};
function readSetting<T,>(key:string,fallback:T):T{try{return JSON.parse(localStorage.getItem(key)||"null")??fallback}catch{return fallback}}
function writeSetting(key:string,value:unknown){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}
async function createRichPage(parentId:string|null,title:string):Promise<Page>{
 const {migrateLegacy}=await import("./blockModel");const empty=new Y.Doc();const rich=migrateLegacy(empty);
 try{return await invoke<Page>("create_page",{parentId,title,initialUpdate:Array.from(Y.encodeStateAsUpdate(rich))})}finally{rich.destroy();empty.destroy()}
}
export default function App(){
 const [pages,setPages]=useState<Page[]>([]);const [trashed,setTrashed]=useState<Page[]>([]);
 const [selected,setSelected]=useState<string|null>(()=>readSetting("nou-active-tab",null));
 const [tabs,setTabs]=useState<string[]>(()=>{const v=readSetting<unknown>("nou-open-tabs",[]);return Array.isArray(v)?v.filter(x=>typeof x==="string"):[]});
 const [collapsed,setCollapsed]=useState<string[]>(()=>{const v=readSetting<unknown>("nou-collapsed",[]);return Array.isArray(v)?v.filter(x=>typeof x==="string"):[]});
 const [pagesOpen,setPagesOpen]=useState(true);const [showTrash,setShowTrash]=useState(false);
 const [showRecovery,setShowRecovery]=useState(false);const [showImport,setShowImport]=useState(false);
 const [error,setError]=useState("");const [busy,setBusy]=useState(false);const busyRef=useRef(false);
 const [recoveryBlocked,setRecoveryBlocked]=useState(false);const [editorStatus,setEditorStatus]=useState<SaveStatus>("saved");
 const saveStatusRef=useRef<SaveStatus>("saved");
 const [theme,setTheme]=useState<"light"|"dark">(()=>readSetting("nou-theme","light")==="dark"?"dark":"light");
 const [search,setSearch]=useState("");const [hits,setHits]=useState<SearchHit[]>([]);const [searching,setSearching]=useState(false);
 const [backupNotice,setBackupNotice]=useState("");const [iconPicker,setIconPicker]=useState(false);
 const [dragged,setDragged]=useState<string|null>(null);const [dropHint,setDropHint]=useState("");
 const onEditorStatus=useCallback((s:SaveStatus)=>{saveStatusRef.current=s;setEditorStatus(s)},[]);
 function markBusy(value:boolean){busyRef.current=value;setBusy(value)}
 const guard=busy||editorStatus!=="saved";
 const current=pages.find(p=>p.id===selected);
 const reload=useCallback(async()=>{
  const [active,deleted,status]=await Promise.all([invoke<Page[]>("list_pages"),invoke<Page[]>("list_trashed_pages"),invoke<boolean>("notes_write_blocked")]);
  setPages(active);setTrashed(deleted);setRecoveryBlocked(!!status);
  setTabs(old=>old.filter(id=>active.some(p=>p.id===id)));setSelected(old=>old&&active.some(p=>p.id===old)?old:null);
 },[]);
 useEffect(()=>{void reload().catch(e=>setError(String(e)))},[reload]);
 useEffect(()=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;writeSetting("nou-theme",theme)},[theme]);
 useEffect(()=>writeSetting("nou-open-tabs",tabs),[tabs]);useEffect(()=>writeSetting("nou-active-tab",selected),[selected]);useEffect(()=>writeSetting("nou-collapsed",collapsed),[collapsed]);
 useEffect(()=>{
  const guardClose=(event:BeforeUnloadEvent)=>{if(saveStatusRef.current!=="saved"||busyRef.current){event.preventDefault();event.returnValue=""}};
  window.addEventListener("beforeunload",guardClose);
  let disposed=false;let unlisten:(()=>void)|undefined;
  void getCurrentWindow().onCloseRequested(event=>{if(saveStatusRef.current!=="saved"||busyRef.current){event.preventDefault();setError("Wait for the current operation, or copy/retry unsaved content before closing NOU.")}}).then(fn=>{if(disposed)fn();else unlisten=fn}).catch(()=>undefined);
  const fullscreen=(event:KeyboardEvent)=>{if(event.key==="F11"&&!event.repeat){event.preventDefault();void toggleFullscreen()}};
  window.addEventListener("keydown",fullscreen);
  return()=>{disposed=true;unlisten?.();window.removeEventListener("beforeunload",guardClose);window.removeEventListener("keydown",fullscreen)};
 },[]);
 async function toggleFullscreen(){try{const win=getCurrentWindow();await win.setFullscreen(!await win.isFullscreen())}catch(e){setError(String(e))}}
 useEffect(()=>{
  let cancelled=false;const check=()=>{void invoke<{enabled:boolean;error:string|null;last_success:unknown}>("backup_schedule_status").then(s=>{if(!cancelled)setBackupNotice(s?.error?"Backup needs attention: "+s.error:s?.enabled&&!s.last_success?"First weekly backup is pending.":"")}).catch(e=>{if(!cancelled)setBackupNotice(String(e))})};
  check();const timer=window.setInterval(check,30000);return()=>{cancelled=true;window.clearInterval(timer)};
 },[]);
 useEffect(()=>{
  if(!search.trim()){setHits([]);setSearching(false);return}let cancelled=false;setSearching(true);
  const timer=window.setTimeout(()=>{void invoke<SearchHit[]>("search_notes",{query:search}).then(result=>{if(!cancelled)setHits(result)}).catch(e=>{if(!cancelled)setError(String(e))}).finally(()=>{if(!cancelled)setSearching(false)})},180);
  return()=>{cancelled=true;window.clearTimeout(timer)};
 },[search,pages]);
 async function run(action:()=>Promise<unknown>){markBusy(true);setError("");try{await action();await reload()}catch(e){setError(String(e))}finally{markBusy(false)}}
 function openPage(id:string){if(busyRef.current||saveStatusRef.current!=="saved")return;setTabs(old=>old.includes(id)?old:[...old,id]);setSelected(id);setShowTrash(false);setIconPicker(false)}
 function closeTab(id:string){if(guard)return;const next=tabs.filter(t=>t!==id);setTabs(next);if(selected===id)setSelected(next[Math.max(0,tabs.indexOf(id)-1)]??null)}
 async function createChild(){if(!current)throw Error("Select a page first.");markBusy(true);try{const page=await createRichPage(current.id,"Untitled");await reload();setCollapsed(old=>old.filter(id=>id!==current.id));return page}finally{markBusy(false)}}
 async function upload(kind:"image"|"pdf"):Promise<FileInfo|null>{
  markBusy(true);try{const path=await chooseFile({multiple:false,title:kind==="image"?"Upload an image":"Upload a PDF",filters:[{name:kind==="image"?"Images":"PDF",extensions:kind==="image"?["png","jpg","jpeg","gif","webp"]:["pdf"]}]});if(typeof path!=="string")return null;const file=await invoke<FileInfo>("upload_attachment",{path});if(kind==="pdf"&&file.mime!=="application/pdf"||kind==="image"&&!file.mime.startsWith("image/"))throw Error("Selected content does not match this block type.");return file}finally{markBusy(false)}
 }
 async function move(e:React.DragEvent,target:string|null,position:DropPosition){
  e.preventDefault();e.stopPropagation();const id=e.dataTransfer.getData("application/x-nou-page");setDragged(null);setDropHint("");if(guard||recoveryBlocked||!id)return;
  try{const plan=pageDrop(pages,id,target,position);await run(()=>invoke("relocate_page",plan));if(plan.parentId)setCollapsed(old=>old.filter(id=>id!==plan.parentId))}catch(error){setError(String(error))}
 }
 function tree(parent:string|null=null,depth=0,visited=new Set<string>()):React.ReactNode{
  if(depth>100)return null;
  return pages.filter(p=>p.parent_id===parent).sort((a,b)=>a.sort_key.localeCompare(b.sort_key)||a.id.localeCompare(b.id)).map(page=>{
   if(visited.has(page.id))return null;visited.add(page.id);
   const children=pages.some(p=>p.parent_id===page.id);const expanded=!collapsed.includes(page.id);
   return <div key={page.id}><div className={"tree-row "+(selected===page.id?"active ":"")+(dropHint.startsWith(page.id+":")?"drop-"+dropHint.split(":")[1]:"")}
    draggable={!guard&&!recoveryBlocked} onDragStart={e=>{e.dataTransfer.setData("application/x-nou-page",page.id);e.dataTransfer.effectAllowed="move";setDragged(page.id)}} onDragEnd={()=>{setDragged(null);setDropHint("")}}
    onDragOver={e=>{if(!dragged||guard)return;e.preventDefault();e.stopPropagation();const rect=e.currentTarget.getBoundingClientRect();const f=(e.clientY-rect.top)/rect.height;setDropHint(page.id+":"+(f<.25?"before":f>.75?"after":"inside"))}}
    onDrop={e=>{const rect=e.currentTarget.getBoundingClientRect();const f=(e.clientY-rect.top)/rect.height;void move(e,page.id,f<.25?"before":f>.75?"after":"inside")}} style={{paddingLeft:8+depth*16}}>
    <button className="tree-toggle" disabled={!children||guard} aria-label={(expanded?"Collapse ":"Expand ")+page.title} aria-expanded={children?expanded:undefined} onClick={()=>setCollapsed(old=>expanded?[...old,page.id]:old.filter(id=>id!==page.id))}>{children?(expanded?"⌄":"›"):""}</button>
    <button className="tree-page" disabled={guard} onClick={()=>openPage(page.id)}><Icon name={page.icon}/><span>{page.title}</span></button>
   </div>{children&&expanded&&tree(page.id,depth+1,visited)}</div>;
  });
 }
 if(showRecovery)return <Suspense fallback={<p role="status">Opening backups…</p>}><BackupPanel onBusyChange={value=>{markBusy(value)}} onClose={()=>{setShowRecovery(false);setSelected(null);setSearch("");onEditorStatus("saved");void reload().catch(e=>setError(String(e)))}}/></Suspense>;
 if(showImport)return <Suspense fallback={<p role="status">Opening import…</p>}><ImportNotePanel onClose={()=>setShowImport(false)} onImported={async id=>{await reload();setShowImport(false);setShowTrash(false);setSearch("");openPage(id)}}/></Suspense>;
 return <EditorFeatures.Provider value={{pages,theme,canNavigate:!guard,open:openPage,create:createChild,upload,onError:e=>setError(String(e))}}>
 <main className="shell">
  <aside className="sidebar">
   <div className="brand"><span className="mark">脳</span><div><strong>Project NOU</strong><small>Your local workspace</small></div></div>
   <input className="search-input" aria-label="Search notes" placeholder="Search notes…" disabled={guard} value={search} onChange={e=>{setSearch(e.target.value);setShowTrash(false)}}/>
   <div className="sidebar-heading" onDragOver={e=>{if(dragged){e.preventDefault();setDropHint("root")}}} onDrop={e=>void move(e,null,"inside")}>
    <button className="section-toggle" aria-expanded={pagesOpen} onClick={()=>setPagesOpen(v=>!v)}> {pagesOpen?"⌄":"›"} Workspace</button>
    <button disabled={guard||recoveryBlocked} aria-label="New root page" onClick={()=>void run(async()=>{const page=await createRichPage(null,"Untitled");setTabs(old=>[...old,page.id]);setSelected(page.id);setShowTrash(false);setPagesOpen(true)})}>＋</button>
   </div>
   {dragged&&<div className={"root-drop "+(dropHint==="root"?"over":"")} onDragOver={e=>{e.preventDefault();setDropHint("root")}} onDrop={e=>void move(e,null,"inside")}>Drop here to move to root</div>}
   <nav className="page-tree" aria-label={search.trim()?"Search results":"Pages"}>
    {search.trim()?<><small className="search-caption">{searching?"Searching…":hits.length+" matches"}</small>{hits.map(hit=><button className="tree-page search-result" key={hit.id} disabled={guard} onClick={()=>openPage(hit.id)}><Icon name={pages.find(p=>p.id===hit.id)?.icon}/>{hit.title}</button>)}</>:pagesOpen&&tree()}
   </nav>
   <div className="sidebar-bottom"><button className={"sidebar-control "+(showTrash?"active":"")} disabled={guard} onClick={()=>{setShowTrash(v=>!v);setSearch("");onEditorStatus("saved")}}>Trash <span>{trashed.length}</span></button>
    <details className="workspace-tools"><summary>Workspace tools</summary><button disabled={guard||recoveryBlocked} onClick={()=>setShowImport(true)}>Import recovered note…</button><button disabled={guard} onClick={()=>setShowRecovery(true)}>Backups & restore</button></details>
    <small>Offline · Saved on this device</small>
   </div>
  </aside>
  <section className="workspace">
   <header className="workspace-topbar"><div className="page-tabs" role="tablist" aria-label="Open pages">{tabs.map(id=>{const page=pages.find(p=>p.id===id);return page&&<div className={"page-tab "+(id===selected&&!showTrash?"selected":"")} key={id}><button role="tab" aria-selected={id===selected&&!showTrash} disabled={guard} onClick={()=>openPage(id)}><Icon name={page.icon} size={15}/><span>{page.title}</span></button><button className="close-tab" aria-label={"Close "+page.title+" tab"} disabled={guard} onClick={()=>closeTab(id)}>×</button></div>})}</div>
    <div className="window-tools"><button aria-label={"Switch to "+(theme==="light"?"dark":"light")+" mode"} title="Light / dark mode" onClick={()=>setTheme(v=>v==="light"?"dark":"light")}>{theme==="light"?"☾":"☀"}</button><button aria-label="Toggle fullscreen" title="Fullscreen (F11)" onClick={()=>void toggleFullscreen()}>⛶</button></div>
   </header>
   {backupNotice&&<p className="notice" role="status">{backupNotice} Open Workspace tools → Backups & restore.</p>}
   {recoveryBlocked&&<p className="notice">A restore needs review. Notes are read-only until you review Backups & restore.</p>}
   {error&&<div role="alert" className="error">{error}<button onClick={()=>setError("")}>Dismiss</button></div>}
   {showTrash?<div className="document trash-screen"><h1>Trash</h1><p>Restoring a page also restores its subpages deleted in the same operation.</p>{!trashed.length&&<p>Trash is empty.</p>}{trashed.map(page=><div className="trash-row" key={page.id}><span><Icon name={page.icon}/>{page.title}</span><button disabled={guard||recoveryBlocked} onClick={()=>void run(()=>invoke("restore_page",{pageId:page.id}))}>Restore</button></div>)}</div>
   :current?<div className="document" key={current.id}><div className="toolbar"><span>Workspace / {current.title}</span><div className="actions">
    <button disabled={guard||recoveryBlocked} onClick={()=>void run(async()=>{const page=await createRichPage(current.id,"Untitled");setTabs(old=>[...old,page.id]);setSelected(page.id);setCollapsed(old=>old.filter(id=>id!==current.id))})}>+ Subpage</button>
    <button aria-label="Move page up" title="Move page up" disabled={guard||recoveryBlocked} onClick={()=>void run(()=>invoke("move_page",{pageId:current.id,direction:"up"}))}>↑</button>
    <button aria-label="Move page down" title="Move page down" disabled={guard||recoveryBlocked} onClick={()=>void run(()=>invoke("move_page",{pageId:current.id,direction:"down"}))}>↓</button>
    <button className="danger" disabled={guard||recoveryBlocked} onClick={()=>{if(window.confirm("Move this page and its subpages to Trash?"))void run(async()=>{await invoke("trash_page",{pageId:current.id});setSelected(null)})}}>Trash</button><div id="note-export-host"/>
   </div></div>
   <div className="document-heading"><div className="page-icon-picker"><button className="document-icon" aria-label="Assign page icon" disabled={guard||recoveryBlocked} onClick={()=>setIconPicker(v=>!v)}><Icon name={current.icon} size={32}/></button>{iconPicker&&<div className="icon-picker-popover" role="group" aria-label="Monochrome page icons">{iconNames.map(icon=><button key={icon} aria-label={icon+" icon"} aria-pressed={current.icon===icon} disabled={guard} onClick={()=>void run(async()=>{await invoke("set_page_icon",{pageId:current.id,icon});setIconPicker(false)})}><Icon name={icon} size={22}/></button>)}</div>}</div>
    <input className="title-input" aria-label="Page title" readOnly={guard||recoveryBlocked} defaultValue={current.title} onBlur={e=>{const title=e.target.value.trim()||"Untitled";if(!recoveryBlocked&&title!==current.title)void run(()=>invoke("rename_page",{pageId:current.id,title}))}} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur()}}/>
   </div><Suspense fallback={<p role="status">Opening editor…</p>}><NoteEditor pageId={current.id} title={current.title} onStatus={onEditorStatus} readOnly={recoveryBlocked}/></Suspense></div>
   :<div className="empty"><span className="big-mark">脳</span><h1>Your knowledge, your device.</h1><p>Select a page or create a new one.</p><button disabled={guard||recoveryBlocked} onClick={()=>void run(async()=>{const page=await createRichPage(null,"My first page");setTabs(old=>[...old,page.id]);setSelected(page.id)})}>Create a page</button></div>}
  </section>
 </main></EditorFeatures.Provider>;
}
