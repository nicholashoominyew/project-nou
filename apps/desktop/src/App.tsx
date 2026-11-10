import type {SaveStatus} from "./NoteEditor";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {lazy,Suspense,useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open as chooseFile} from "@tauri-apps/plugin-dialog";
import * as Y from "yjs";
import {EditorFeatures,type PageInfo,type FileInfo} from "./EditorContext";
import {Icon,iconNames} from "./Icons";
import {pageDrop,type DropPosition} from "./workspaceModel";
import QuickFind from "./QuickFind";
import {DismissibleDetails,useDismiss} from "./Dismissible";
const NoteEditor=lazy(()=>import("./NoteEditor"));
const BackupPanel=lazy(()=>import("./BackupPanel"));
const ImportNotePanel=lazy(()=>import("./ImportNotePanel"));
type Page=PageInfo;type RowMenu={id:string;x:number;y:number};
const clampSidebar=(w:number)=>Math.min(480,Math.max(200,Math.round(w)));
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
 const [theme,setTheme]=useState<"light"|"dark">(()=>readSetting<string>("nou-theme","light")==="dark"?"dark":"light");
 const [sidebarOpen,setSidebarOpen]=useState<boolean>(()=>readSetting<unknown>("nou-sidebar-open",true)!==false);
 const [sidebarWidth,setSidebarWidth]=useState<number>(()=>{const w=Number(readSetting<unknown>("nou-sidebar-width",260));return Number.isFinite(w)?clampSidebar(w):260});
 const [favoritesOpen,setFavoritesOpen]=useState(true);const [menu,setMenu]=useState<RowMenu|null>(null);const [renaming,setRenaming]=useState<string|null>(null);
 const menuRef=useRef<HTMLDivElement>(null);const cancelRename=useRef(false);
 useDismiss(menu!==null,()=>setMenu(null),menuRef);
 useEffect(()=>writeSetting("nou-sidebar-open",sidebarOpen),[sidebarOpen]);useEffect(()=>writeSetting("nou-sidebar-width",sidebarWidth),[sidebarWidth]);
 const [backupNotice,setBackupNotice]=useState("");const [iconPicker,setIconPicker]=useState(false);
 const [dragged,setDragged]=useState<string|null>(null);const [dropHint,setDropHint]=useState("");const [quickFind,setQuickFind]=useState(false);const iconPickerRef=useRef<HTMLDivElement>(null);
 useDismiss(iconPicker,()=>setIconPicker(false),iconPickerRef);
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
 async function run(action:()=>Promise<unknown>){markBusy(true);setError("");try{await action();await reload()}catch(e){setError(String(e))}finally{markBusy(false)}}
 function openPage(id:string){if(busyRef.current||saveStatusRef.current!=="saved")return;setTabs(old=>old.includes(id)?old:[...old,id]);setSelected(id);setShowTrash(false);setIconPicker(false)}
 function closeTab(id:string){if(guard)return;const next=tabs.filter(t=>t!==id);setTabs(next);if(selected===id)setSelected(next[Math.max(0,tabs.indexOf(id)-1)]??null)}
 function newRootPage(){return run(async()=>{const page=await createRichPage(null,"Untitled");setTabs(old=>[...old,page.id]);setSelected(page.id);setShowTrash(false);setPagesOpen(true)})}
 // Keyboard shortcuts. Ctrl+C/V/X/A and Ctrl+Z/Y are handled natively by the editor and text fields.
 // Ctrl+P prints the open page (print styles hide the app chrome); Ctrl+Q opens Quick find.
 useEffect(()=>{
  const onKey=(event:KeyboardEvent)=>{
   if(event.isComposing||!(event.ctrlKey||event.metaKey)||event.altKey||showRecovery||showImport)return;
   const key=event.key.toLowerCase();
   if(event.key==="\\"){event.preventDefault();setSidebarOpen(open=>!open)}
   else if(key==="q"&&!event.shiftKey){event.preventDefault();setQuickFind(open=>open?false:!guard)}
   else if(key==="p"&&!event.shiftKey){event.preventDefault();if(!event.repeat)window.print()}
   else if(key==="n"&&!event.shiftKey){event.preventDefault();if(!event.repeat&&!guard&&!recoveryBlocked){setQuickFind(false);void newRootPage()}}
   else if(key==="w"&&!event.shiftKey){event.preventDefault();if(!event.repeat&&selected&&tabs.includes(selected))closeTab(selected)}
   else if(event.key==="Tab"&&tabs.length>1){event.preventDefault();if(guard)return;const at=tabs.indexOf(selected??"");openPage(tabs[(at+(event.shiftKey?-1:1)+tabs.length)%tabs.length])}
  };
  window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);
 },[guard,recoveryBlocked,showRecovery,showImport,tabs,selected]);
 async function createChild(){if(!current)throw Error("Select a page first.");markBusy(true);try{const page=await createRichPage(current.id,"Untitled");await reload();setCollapsed(old=>old.filter(id=>id!==current.id));return page}finally{markBusy(false)}}
 async function upload(kind:"image"|"pdf"|"file"):Promise<FileInfo|null>{
  markBusy(true);try{const path=await chooseFile({multiple:false,title:kind==="image"?"Upload an image":kind==="pdf"?"Upload a PDF":"Upload a file",filters:kind==="file"?undefined:[{name:kind==="image"?"Images":"PDF",extensions:kind==="image"?["png","jpg","jpeg","gif","webp"]:["pdf"]}]});if(typeof path!=="string")return null;const file=await invoke<FileInfo>("upload_attachment",{path});if(kind!=="file"&&(kind==="pdf"&&file.mime!=="application/pdf"||kind==="image"&&!file.mime.startsWith("image/")))throw Error("Selected content does not match this block type.");return file}finally{markBusy(false)}
 }
 async function uploadFile(file:File):Promise<FileInfo>{
  if(file.size===0||file.size>20*1024*1024)throw Error(file.name+" must be between 1 byte and 20 MB.");
  markBusy(true);try{return await invoke<FileInfo>("upload_attachment_bytes",new Uint8Array(await file.arrayBuffer()),{headers:{"x-file-name":encodeURIComponent(file.name)}})}finally{markBusy(false)}
 }
 // A file dropped anywhere that is not an editor must never navigate the window to that file.
 useEffect(()=>{const stop=(e:DragEvent)=>{if(e.dataTransfer&&Array.from(e.dataTransfer.types).includes("Files"))e.preventDefault()};window.addEventListener("dragover",stop);window.addEventListener("drop",stop);return()=>{window.removeEventListener("dragover",stop);window.removeEventListener("drop",stop)}},[]);
 async function move(e:React.DragEvent,target:string|null,position:DropPosition){
  e.preventDefault();e.stopPropagation();const id=e.dataTransfer.getData("application/x-nou-page");setDragged(null);setDropHint("");if(guard||recoveryBlocked||!id)return;
  try{const plan=pageDrop(pages,id,target,position);await run(()=>invoke("relocate_page",plan));if(plan.parentId)setCollapsed(old=>old.filter(id=>id!==plan.parentId))}catch(error){setError(String(error))}
 }
 function toggleFavorite(page:Page){return run(()=>invoke("set_page_favorite",{pageId:page.id,favorite:!page.is_favorite}))}
 async function renamePage(page:Page,value:string){setRenaming(null);const title=value.trim()||"Untitled";if(title!==page.title)await run(()=>invoke("rename_page",{pageId:page.id,title}))}
 function addSubpage(page:Page){return run(async()=>{const created=await createRichPage(page.id,"Untitled");setTabs(old=>[...old,created.id]);setSelected(created.id);setShowTrash(false);setCollapsed(old=>old.filter(id=>id!==page.id))})}
 function trashPage(page:Page){if(window.confirm("Move \u201c"+page.title+"\u201d and its subpages to Trash?"))void run(async()=>{await invoke("trash_page",{pageId:page.id});if(selected===page.id)setSelected(null)})}
 function startSidebarResize(event:React.PointerEvent){
  event.preventDefault();const startX=event.clientX;const startWidth=sidebarWidth;
  const move=(e:PointerEvent)=>setSidebarWidth(clampSidebar(startWidth+e.clientX-startX));
  const up=()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",up)};
  window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);window.addEventListener("pointercancel",up);
 }
 /** One sidebar row (Notion style): icon/caret, title, hover actions, context menu, inline rename, drag and drop. */
 function pageRow(page:Page,depth:number,flat=false):React.ReactNode{
  const children=!flat&&pages.some(p=>p.parent_id===page.id);const expanded=!collapsed.includes(page.id);const editing=renaming===page.id;
  const editable=!guard&&!recoveryBlocked;
  const openMenu=(x:number,y:number)=>{if(editable)setMenu(current=>current?.id===page.id?null:{id:page.id,x,y})};
  const zone=(e:React.DragEvent)=>{const rect=e.currentTarget.getBoundingClientRect();const f=(e.clientY-rect.top)/rect.height;return f<.25?"before":f>.75?"after":"inside"};
  return <div className={"tree-row"+(children?" has-children":"")+(selected===page.id&&!showTrash?" active":"")+(menu?.id===page.id?" menu-open":"")+(!flat&&dropHint.startsWith(page.id+":")?" drop-"+dropHint.split(":")[1]:"")}
   draggable={!flat&&editable&&!editing} onDragStart={e=>{e.dataTransfer.setData("application/x-nou-page",page.id);e.dataTransfer.effectAllowed="move";setDragged(page.id)}} onDragEnd={()=>{setDragged(null);setDropHint("")}}
   onDragOver={e=>{if(flat||!dragged||guard)return;e.preventDefault();e.stopPropagation();setDropHint(page.id+":"+zone(e))}}
   onDrop={e=>{if(!flat)void move(e,page.id,zone(e) as DropPosition)}}
   onContextMenu={e=>{e.preventDefault();openMenu(e.clientX,e.clientY)}} style={{paddingLeft:6+depth*14}}>
   <span className="row-lead"><span className="row-icon"><Icon name={page.icon} size={17}/></span>{children&&<button className="tree-toggle" disabled={guard} aria-label={(expanded?"Collapse ":"Expand ")+page.title} aria-expanded={expanded} onClick={()=>setCollapsed(old=>expanded?[...old,page.id]:old.filter(id=>id!==page.id))}>{expanded?"\u25BE":"\u25B8"}</button>}</span>
   {editing?<input className="row-rename" aria-label={"Rename "+page.title} autoFocus defaultValue={page.title} onFocus={e=>e.currentTarget.select()}
     onBlur={e=>{if(cancelRename.current){cancelRename.current=false;return}void renamePage(page,e.target.value)}}
     onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==="Enter")e.currentTarget.blur();else if(e.key==="Escape"){cancelRename.current=true;setRenaming(null)}}}/>
   :<button className="tree-page" disabled={guard} onClick={()=>openPage(page.id)} onDoubleClick={()=>{if(editable)setRenaming(page.id)}}><span>{page.title}</span></button>}
   {!editing&&<span className="row-actions">
    <button aria-label={"More options for "+page.title} aria-haspopup="menu" aria-expanded={menu?.id===page.id} disabled={!editable} onClick={e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();openMenu(r.left,r.bottom+4)}}>{"\u22EF"}</button>
    <button aria-label={"Add a subpage to "+page.title} title="Add a subpage" disabled={!editable} onClick={()=>void addSubpage(page)}>+</button></span>}
  </div>;
 }
 function tree(parent:string|null=null,depth=0,visited=new Set<string>()):React.ReactNode{
  if(depth>100)return null;
  return pages.filter(p=>p.parent_id===parent).sort((a,b)=>a.sort_key.localeCompare(b.sort_key)||a.id.localeCompare(b.id)).map(page=>{
   if(visited.has(page.id))return null;visited.add(page.id);
   const children=pages.some(p=>p.parent_id===page.id);const expanded=!collapsed.includes(page.id);
   return <div key={page.id}>{pageRow(page,depth)}{children&&expanded&&tree(page.id,depth+1,visited)}</div>;
  });
 }
 const favorites=pages.filter(p=>p.is_favorite).sort((a,b)=>a.title.localeCompare(b.title));
 const menuPage=menu?pages.find(p=>p.id===menu.id):undefined;
 if(showRecovery)return <Suspense fallback={<p role="status">Opening backups…</p>}><BackupPanel onBusyChange={value=>{markBusy(value)}} onClose={()=>{setShowRecovery(false);setSelected(null);onEditorStatus("saved");void reload().catch(e=>setError(String(e)))}}/></Suspense>;
 if(showImport)return <Suspense fallback={<p role="status">Opening import…</p>}><ImportNotePanel onClose={()=>setShowImport(false)} onImported={async id=>{await reload();setShowImport(false);setShowTrash(false);openPage(id)}}/></Suspense>;
 return <EditorFeatures.Provider value={{pages,theme,canNavigate:!guard,open:openPage,create:createChild,upload,uploadFile,onError:e=>setError(String(e))}}>
 <main className="shell">
  {sidebarOpen&&<aside className="sidebar" style={{width:sidebarWidth}} aria-label="Sidebar">
   <div className="sb-header"><span className="mark">脳</span><strong className="sb-name">Project NOU</strong>
    <div className="sb-header-actions"><button aria-label="Close sidebar" title="Close sidebar (Ctrl+\\)" onClick={()=>setSidebarOpen(false)}><Icon name="chevronLeft" size={16}/></button>
     <button aria-label="New page" title="New page (Ctrl+N)" disabled={guard||recoveryBlocked} onClick={()=>void newRootPage()}><Icon name="compose" size={16}/></button></div></div>
   <button className="sb-item" disabled={guard} onClick={()=>setQuickFind(true)}><Icon name="search" size={17}/><span>Search</span><kbd>Ctrl+Q</kbd></button>
   <div className="sb-scroll">
    {favorites.length>0&&<section aria-label="Favorites"><div className="sb-section"><button className="sb-section-title" aria-expanded={favoritesOpen} onClick={()=>setFavoritesOpen(v=>!v)}>Favorites</button></div>
     {favoritesOpen&&<nav aria-label="Favorite pages">{favorites.map(page=><div key={page.id}>{pageRow(page,0,true)}</div>)}</nav>}</section>}
    <section aria-label="Private pages"><div className="sb-section" onDragOver={e=>{if(dragged){e.preventDefault();setDropHint("root")}}} onDrop={e=>void move(e,null,"inside")}>
      <button className="sb-section-title" aria-expanded={pagesOpen} onClick={()=>setPagesOpen(v=>!v)}>Private</button>
      <button className="sb-add" aria-label="New root page" title="New page (Ctrl+N)" disabled={guard||recoveryBlocked} onClick={()=>void newRootPage()}>+</button></div>
     {dragged&&<div className={"root-drop "+(dropHint==="root"?"over":"")} onDragOver={e=>{e.preventDefault();setDropHint("root")}} onDrop={e=>void move(e,null,"inside")}>Drop here to move to the top level</div>}
     <nav className="page-tree" aria-label="Pages">{pagesOpen&&tree()}{!pages.length&&<p className="hint">No pages yet.</p>}</nav>
     <button className="sb-item sb-add-page" disabled={guard||recoveryBlocked} onClick={()=>void newRootPage()}><Icon name="plus" size={17}/><span>Add a page</span></button></section>
   </div>
   <div className="sb-bottom">
    <button className={"sb-item"+(showTrash?" active":"")} disabled={guard} onClick={()=>{setShowTrash(v=>!v);onEditorStatus("saved")}}><Icon name="trash" size={17}/><span>Trash</span><em>{trashed.length}</em></button>
    <button className="sb-item" disabled={guard||recoveryBlocked} onClick={()=>setShowImport(true)}><Icon name="import" size={17}/><span>Import recovered note…</span></button>
    <button className="sb-item" disabled={guard} onClick={()=>setShowRecovery(true)}><Icon name="archive" size={17}/><span>Backups &amp; restore</span></button>
    <small>Offline · Saved on this device</small></div>
   <div className="sb-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuenow={sidebarWidth} aria-valuemin={200} aria-valuemax={480} tabIndex={0} onPointerDown={startSidebarResize}
    onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();setSidebarWidth(w=>clampSidebar(w+(e.key==="ArrowRight"?16:-16)))}}}/>
  </aside>}
  <section className="workspace">
   <header className="workspace-topbar">{!sidebarOpen&&<button className="sb-open" aria-label="Open sidebar" title="Open sidebar (Ctrl+\\)" onClick={()=>setSidebarOpen(true)}><Icon name="menu" size={18}/></button>}<div className="page-tabs" role="tablist" aria-label="Open pages">{tabs.map(id=>{const page=pages.find(p=>p.id===id);return page&&<div className={"page-tab "+(id===selected&&!showTrash?"selected":"")} key={id}><button role="tab" aria-selected={id===selected&&!showTrash} disabled={guard} onClick={()=>openPage(id)}><Icon name={page.icon} size={15}/><span>{page.title}</span></button><button className="close-tab" aria-label={"Close "+page.title+" tab"} disabled={guard} onClick={()=>closeTab(id)}>×</button></div>})}</div>
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
   <div className="document-heading"><div className="page-icon-picker" ref={iconPickerRef}><button className="document-icon" aria-label="Assign page icon" disabled={guard||recoveryBlocked} onClick={()=>setIconPicker(v=>!v)}><Icon name={current.icon} size={32}/></button>{iconPicker&&<div className="icon-picker-popover" role="group" aria-label="Monochrome page icons">{iconNames.map(icon=><button key={icon} aria-label={icon+" icon"} aria-pressed={current.icon===icon} disabled={guard} onClick={()=>void run(async()=>{await invoke("set_page_icon",{pageId:current.id,icon});setIconPicker(false)})}><Icon name={icon} size={22}/></button>)}</div>}</div>
    <input className="title-input" aria-label="Page title" readOnly={guard||recoveryBlocked} defaultValue={current.title} onBlur={e=>{const title=e.target.value.trim()||"Untitled";if(!recoveryBlocked&&title!==current.title)void run(()=>invoke("rename_page",{pageId:current.id,title}))}} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur()}}/>
   </div><Suspense fallback={<p role="status">Opening editor…</p>}><NoteEditor pageId={current.id} title={current.title} onStatus={onEditorStatus} readOnly={recoveryBlocked}/></Suspense></div>
   :<div className="empty"><span className="big-mark">脳</span><h1>Your knowledge, your device.</h1><p>Select a page or create a new one.</p><button disabled={guard||recoveryBlocked} onClick={()=>void run(async()=>{const page=await createRichPage(null,"My first page");setTabs(old=>[...old,page.id]);setSelected(page.id)})}>Create a page</button></div>}
  </section>
 {menu&&menuPage&&<div className="row-menu" role="menu" ref={menuRef} style={{left:Math.min(menu.x,window.innerWidth-230),top:Math.min(menu.y,window.innerHeight-190)}}>
  <button role="menuitem" onClick={()=>{setMenu(null);void toggleFavorite(menuPage)}}>{menuPage.is_favorite?"Remove from Favorites":"Add to Favorites"}</button>
  <button role="menuitem" onClick={()=>{setMenu(null);setRenaming(menuPage.id)}}>Rename</button>
  <button role="menuitem" onClick={()=>{setMenu(null);void addSubpage(menuPage)}}>Add subpage</button>
  <hr/><button role="menuitem" className="danger" onClick={()=>{setMenu(null);trashPage(menuPage)}}>Move to Trash</button></div>}
 {quickFind&&<QuickFind pages={pages} onOpen={id=>{setQuickFind(false);openPage(id)}} onClose={()=>setQuickFind(false)}/>}
 </main></EditorFeatures.Provider>;
}
