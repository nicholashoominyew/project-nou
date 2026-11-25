import type {SaveStatus} from "./NoteEditor";
import {getCurrentWindow} from "@tauri-apps/api/window";
import WindowControls from "./WindowControls";
import {lazy,Suspense,useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open as chooseFile} from "@tauri-apps/plugin-dialog";
import * as Y from "yjs";
import {EditorFeatures,type PageInfo,type FileInfo} from "./EditorContext";
import {Icon} from "./Icons";
import {iconNames} from "./iconPaths";
import {pageDrop,type DropPosition} from "./workspaceModel";
import ShortcutsHelp from "./ShortcutsHelp";
import SettingsPage from "./SettingsPage";
import BotsHub from "./BotsHub";
import Home from "./Home";
import QuickCapture from "./QuickCapture";
import { keep } from "./stable";
import { localDate } from "./resurface";
import { SidebarResults, SidebarSearchBox } from "./SidebarSearch";
import { LockButton, LockGate } from "./PageLock";
import { appendBlocksToNote } from "./noteAppend";
import {useReminders,ReminderToast} from "./timetable/reminders";
import TopTimer from "./timetable/TopTimer";
import {CheckinPopups,useCheckinPopups} from "./checkins";
import {UndoHost} from "./undo";
import { INBOX_KEY, parseCapture, pickInbox } from "./captureParse";
const GatewayPanel=lazy(()=>import("./GatewayPanel"));
const GraphView=lazy(()=>import("./GraphView"));
const FileTracker=lazy(()=>import("./FileTracker"));
const LifeTimetableLazy=lazy(()=>import("./timetable/LifeTimetable"));
const HabitsLazy=lazy(()=>import("./Habits"));
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
 // Split view: a second page shown beside the open one. It has its own editor, so it has its own save status; nothing can be switched while either is saving.
 const [splitId,setSplitId]=useState<string|null>(()=>{const v=readSetting<unknown>("nou-split-page",null);return typeof v==="string"?v:null});
 const [splitStatus,setSplitStatus]=useState<SaveStatus>("saved");const splitStatusRef=useRef<SaveStatus>("saved");const splitIdRef=useRef<string|null>(null);splitIdRef.current=splitId;
 const onSplitStatus=useCallback((s:SaveStatus)=>{splitStatusRef.current=s;setSplitStatus(s)},[]);
 useEffect(()=>writeSetting("nou-split-page",splitId),[splitId]);
 const [theme,setTheme]=useState<"light"|"dark">(()=>readSetting<string>("nou-theme","light")==="dark"?"dark":"light");
 const [sidebarOpen,setSidebarOpen]=useState<boolean>(()=>readSetting<unknown>("nou-sidebar-open",true)!==false);
 const [sidebarWidth,setSidebarWidth]=useState<number>(()=>{const w=Number(readSetting<unknown>("nou-sidebar-width",260));return Number.isFinite(w)?clampSidebar(w):260});
 const [favoritesOpen,setFavoritesOpen]=useState(true);const [menu,setMenu]=useState<RowMenu|null>(null);const [renaming,setRenaming]=useState<string|null>(null);
 const menuRef=useRef<HTMLDivElement>(null);const cancelRename=useRef(false);
 useDismiss(menu!==null,()=>setMenu(null),menuRef);
 // A split page that no longer exists (deleted, trashed, restored from an older backup) closes the split.
 useEffect(()=>{if(splitId&&splitId===selected){splitStatusRef.current="saved";setSplitStatus("saved");setSplitId(null)}},[selected,splitId]);
 useEffect(()=>{if(splitId&&pages.length&&!pages.some(p=>p.id===splitId)){splitStatusRef.current="saved";setSplitStatus("saved");setSplitId(null)}},[pages,splitId]);
 // A narrow window gives the page the room: the sidebar folds away when the window becomes narrow, and comes back when it is wide again (only if it was folded this way).
 useEffect(()=>{if(typeof window.matchMedia!=="function")return;const q=window.matchMedia("(max-width: 720px)");let folded=false;const apply=(narrow:boolean)=>{if(narrow){setSidebarOpen(open=>{folded=open;return false})}else if(folded){folded=false;setSidebarOpen(true)}};if(q.matches)apply(true);const on=(e:MediaQueryListEvent)=>apply(e.matches);q.addEventListener?.("change",on);return()=>q.removeEventListener?.("change",on)},[]);
 useEffect(()=>writeSetting("nou-sidebar-open",sidebarOpen),[sidebarOpen]);useEffect(()=>writeSetting("nou-sidebar-width",sidebarWidth),[sidebarWidth]);
 const [backupNotice,setBackupNotice]=useState("");const [iconPicker,setIconPicker]=useState(false);
 const [dragged,setDragged]=useState<string|null>(null);const [dropHint,setDropHint]=useState("");const [quickFind,setQuickFind]=useState(false);const [quickFindText,setQuickFindText]=useState("");const [showShortcuts,setShowShortcuts]=useState(false);const [showGateway,setShowGateway]=useState(false);const [showGraph,setShowGraph]=useState(false);const [showCapture,setShowCapture]=useState(false);const [showFiles,setShowFiles]=useState(false);const [showTimetable,setShowTimetable]=useState(false);const [showHabits,setShowHabits]=useState(false);const [sbQuery,setSbQuery]=useState("");const [showSettings,setShowSettings]=useState(false);const [showBot,setShowBot]=useState(false);const [waiting,setWaiting]=useState(0);const [lockedIds,setLockedIds]=useState<string[]>([]);const [focus,setFocus]=useState(false);const [peekBusy,setPeekBusy]=useState(false);const peekBusyRef=useRef(false);const reportPeekBusy=useCallback((value:boolean)=>{peekBusyRef.current=value;setPeekBusy(value)},[]);
 const pagesRef=useRef<Page[]>([]);pagesRef.current=pages;const closedTabs=useRef<string[]>([]);const nav=useRef({stack:[] as string[],index:-1,skip:false});
 const [zoom,setZoom]=useState<number>(()=>{const z=Number(readSetting<unknown>("nou-zoom",1));return Number.isFinite(z)?Math.min(2,Math.max(0.5,z)):1});
 useEffect(()=>{document.documentElement.style.setProperty("zoom",String(zoom));writeSetting("nou-zoom",zoom)},[zoom]);
 // The window lets a trackpad pinch through to the page (the graph uses it). Everywhere else Ctrl+wheel and pinch must not zoom the whole window: the app has its own zoom (Ctrl +, - and 0).
 useEffect(()=>{const block=(e:WheelEvent)=>{if(e.ctrlKey&&!(e.target instanceof Element&&e.target.closest(".graph-svg")))e.preventDefault()};window.addEventListener("wheel",block,{passive:false,capture:true});return()=>window.removeEventListener("wheel",block,{capture:true} as EventListenerOptions)},[]);
 useEffect(()=>{const n=nav.current;if(!selected)return;if(n.skip){n.skip=false;return}if(n.stack[n.index]===selected)return;n.stack=n.stack.slice(0,n.index+1);n.stack.push(selected);n.index=n.stack.length-1;if(n.stack.length>100){n.stack.shift();n.index--}},[selected]);
 function goHistory(step:-1|1){const n=nav.current;if(guard)return;let i=n.index+step;while(i>=0&&i<n.stack.length&&!pagesRef.current.some(p=>p.id===n.stack[i]))i+=step;if(i<0||i>=n.stack.length)return;const id=n.stack[i];n.index=i;if(id!==selected)n.skip=true;openPage(id)}const iconPickerRef=useRef<HTMLDivElement>(null);
 useDismiss(iconPicker,()=>setIconPicker(false),iconPickerRef);
 const onEditorStatus=useCallback((s:SaveStatus)=>{saveStatusRef.current=s;setEditorStatus(s)},[]);
 function markBusy(value:boolean){busyRef.current=value;setBusy(value)}
 const guard=busy||editorStatus!=="saved"||peekBusy||(splitId!==null&&splitStatus!=="saved");
 // Saving after a pause in typing briefly sets the guard on every few keystrokes. That must not be visible: the sidebar and toolbar keep their normal look.
 const typing=!busy&&!peekBusy&&(editorStatus==="saving"||editorStatus==="loading");
 const current=pages.find(p=>p.id===selected);
 const reload=useCallback(async()=>{
  const [active,deleted,status,locked]=await Promise.all([invoke<Page[]>("list_pages"),invoke<Page[]>("list_trashed_pages"),invoke<boolean>("notes_write_blocked"),invoke<string[]>("list_locked_pages").catch(()=>[] as string[])]);
  setPages(old=>keep(old,active));setTrashed(old=>keep(old,deleted));setRecoveryBlocked(!!status);setLockedIds(old=>keep(old,Array.isArray(locked)?locked:[]));
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
 function closeSplit(){if(splitIdRef.current&&splitStatusRef.current!=="saved")return;splitStatusRef.current="saved";setSplitStatus("saved");setSplitId(null)}
 function openSplit(id:string){
  if(busyRef.current||peekBusyRef.current||saveStatusRef.current!=="saved"||splitStatusRef.current!=="saved")return;
  if(!selected){openPage(id);return}
  if(id===selected)return;
  splitStatusRef.current="saved";setSplitStatus("saved");setSplitId(id);
 }
 function swapSplit(){
  const other=splitIdRef.current;
  if(!other||!selected||busyRef.current||peekBusyRef.current||saveStatusRef.current!=="saved"||splitStatusRef.current!=="saved")return;
  const was=selected;setTabs(old=>old.includes(other)?old:[...old,other]);setSelected(other);setSplitId(was);
 }
 function openPage(id:string){if(busyRef.current||peekBusyRef.current||saveStatusRef.current!=="saved"||(splitIdRef.current!==null&&splitStatusRef.current!=="saved"))return;if(id===splitIdRef.current){splitStatusRef.current="saved";setSplitStatus("saved");setSplitId(null)}setTabs(old=>old.includes(id)?old:[...old,id]);setSelected(id);setShowTrash(false);setShowGraph(false);setShowFiles(false);setShowTimetable(false);setShowHabits(false);setShowSettings(false);setShowBot(false);setIconPicker(false)}
 function closeTab(id:string){if(guard)return;closedTabs.current.push(id);const next=tabs.filter(t=>t!==id);setTabs(next);if(selected===id)setSelected(next[Math.max(0,tabs.indexOf(id)-1)]??null)}
 function reopenTab(){if(guard)return;while(closedTabs.current.length){const id=closedTabs.current.pop()!;if(!tabs.includes(id)&&pagesRef.current.some(p=>p.id===id)){openPage(id);return}}}
 function newRootPage(){return run(async()=>{const page=await createRichPage(null,"Untitled");setTabs(old=>[...old,page.id]);setSelected(page.id);setShowTrash(false);setPagesOpen(true)})}
 // Bots Hub: the sidebar item shows how many queue items wait for you (N WAITING). The page keeps it current while it is open and reports changes at once.
 useEffect(()=>{
  if(showBot)return;let off=false;
  const check=async()=>{try{const s=await invoke<{waiting:number}>("hub_summary");if(!off&&s&&typeof s.waiting==="number")setWaiting(s.waiting)}catch{/* the count is a convenience */}};
  void check();const t=window.setInterval(()=>void check(),5000);return()=>{off=true;window.clearInterval(t)};
 },[showBot]);
 // Quick capture: what is typed goes to the end of the Inbox page (made on first use), without leaving the current page.
 async function captureText(text:string):Promise<string>{
  const blocks=parseCapture(text);if(!blocks.length)throw new Error("Type something to capture.");
  let id=pickInbox(pagesRef.current,readSetting<string|null>(INBOX_KEY,null));
  if(!id){const page=await createRichPage(null,"Inbox");id=page.id;await reload()}
  writeSetting(INBOX_KEY,id);
  const out=await appendBlocksToNote(id,blocks);
  if(out.changed)try{window.dispatchEvent(new CustomEvent("nou:note-changed",{detail:id}))}catch{}
  return out.changed?"Saved to Inbox.":out.message;
 }
 const inboxId=pickInbox(pages,readSetting<string|null>(INBOX_KEY,null));
 // Permanent pages: Home, Graph, Inbox, Bots Hub and Files have fixed places in the sidebar and cannot be moved or deleted. The Inbox is the one note among them.
 const reminders=useReminders();const checkins=useCheckinPopups();
 function openHabits(){setShowTrash(false);setShowGraph(false);setShowFiles(false);setShowSettings(false);setShowBot(false);setShowTimetable(false);setShowHabits(true)}
 function openTimetable(){setShowTrash(false);setShowGraph(false);setShowFiles(false);setShowSettings(false);setShowBot(false);setShowTimetable(true);setShowHabits(false)}
 function openInboxPage(){if(inboxId){openPage(inboxId);return}void run(async()=>{const page=await createRichPage(null,"Inbox");writeSetting(INBOX_KEY,page.id);setTabs(old=>[...old,page.id]);setSelected(page.id);setShowTrash(false);setShowGraph(false);setShowFiles(false);setShowTimetable(false);setShowHabits(false);setShowSettings(false);setShowBot(false)})}
 // The daily page: one top-level page named for the date, made the first time it is asked for.
 function openDaily(){if(guard||recoveryBlocked)return;const day=localDate();const found=pagesRef.current.find(p=>p.parent_id===null&&p.title===day);if(found){openPage(found.id);return}void run(async()=>{const page=await createRichPage(null,day);setTabs(old=>[...old,page.id]);setSelected(page.id);setShowTrash(false)})}
 function openInbox(){const id=pickInbox(pagesRef.current,readSetting<string|null>(INBOX_KEY,null));if(!id)return;setShowCapture(false);openPage(id)}
 // Keyboard shortcuts. Ctrl+C/V/X/A and Ctrl+Z/Y are handled natively by the editor and text fields.
 // Ctrl+P prints the open page (print styles hide the app chrome); Ctrl+Q opens Quick find.
 useEffect(()=>{
  const onKey=(event:KeyboardEvent)=>{
   if(event.isComposing||!(event.ctrlKey||event.metaKey)||event.altKey||showRecovery||showImport)return;
   const key=event.key.toLowerCase();
   if(event.key==="\\"){event.preventDefault();setSidebarOpen(open=>!open)}
   else if(key==="q"&&!event.shiftKey){event.preventDefault();setQuickFind(open=>open?false:!guard)}
   else if(key==="a"&&event.shiftKey){event.preventDefault();if(!event.repeat&&!recoveryBlocked&&!busyRef.current)setShowCapture(open=>!open)}
   else if(key==="p"&&!event.shiftKey){event.preventDefault();if(!event.repeat)window.print()}
   else if(key==="n"&&!event.shiftKey){event.preventDefault();if(!event.repeat&&!guard&&!recoveryBlocked){setQuickFind(false);void newRootPage()}}
   else if(key==="w"&&!event.shiftKey){event.preventDefault();if(!event.repeat&&selected&&tabs.includes(selected))closeTab(selected)}
   else if(event.key==="/"){event.preventDefault();setShowShortcuts(open=>!open)}
   else if(event.key==="["||event.key==="]"){event.preventDefault();goHistory(event.key==="["?-1:1)}
   else if(key==="f"&&event.shiftKey){event.preventDefault();if(!event.repeat)setFocus(v=>!v)}
   else if(key==="t"&&event.shiftKey){event.preventDefault();if(!event.repeat)reopenTab()}
   else if(key==="l"&&event.shiftKey){event.preventDefault();if(!event.repeat)setTheme(v=>v==="light"?"dark":"light")}
   else if(key==="u"&&event.shiftKey){event.preventDefault();const parent=pagesRef.current.find(p=>p.id===selected)?.parent_id;if(parent&&!event.repeat)openPage(parent)}
   else if(event.key==="="||event.key==="+"){event.preventDefault();setZoom(z=>Math.min(2,Math.round((z+0.1)*10)/10))}
   else if(event.key==="-"||event.key==="_"){event.preventDefault();setZoom(z=>Math.max(0.5,Math.round((z-0.1)*10)/10))}
   else if(event.key==="0"){event.preventDefault();setZoom(1)}
   else if(/^[1-9]$/.test(event.key)&&!event.shiftKey&&tabs.length){event.preventDefault();const target=event.key==="9"?tabs[tabs.length-1]:tabs[Number(event.key)-1];if(target&&!guard)openPage(target)}
   else if(event.key==="Tab"&&tabs.length>1){event.preventDefault();if(guard)return;const at=tabs.indexOf(selected??"");openPage(tabs[(at+(event.shiftKey?-1:1)+tabs.length)%tabs.length])}
  };
  window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);
 },[guard,recoveryBlocked,showRecovery,showImport,tabs,selected]);
 useEffect(()=>{
  if(!focus)return;
  const onEsc=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!event.defaultPrevented&&!document.querySelector(".bn-suggestion-menu,.bn-formatting-toolbar,.db-menu,.row-menu"))setFocus(false)};
  window.addEventListener("keydown",onEsc);return()=>window.removeEventListener("keydown",onEsc);
 },[focus]);
 // Workspace / Parent / Child: every ancestor is a link. The chain is cycle-safe even if the page tree were ever corrupt.
 const crumbs=(()=>{const out:Page[]=[];const seen=new Set<string>();let page:Page|undefined=current;while(page&&!seen.has(page.id)){seen.add(page.id);out.unshift(page);const parent:string|null=page.parent_id;page=parent?pages.find(p=>p.id===parent):undefined}return out})();
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
   onContextMenu={e=>{e.preventDefault();openMenu(e.clientX,e.clientY)}} style={{paddingLeft:6+depth*16}}>
   <span className="row-lead"><span className="row-icon"><Icon name={page.icon} size={17}/></span>{children&&<button className="tree-toggle" disabled={guard} aria-label={(expanded?"Collapse ":"Expand ")+page.title} aria-expanded={expanded} onClick={()=>setCollapsed(old=>expanded?[...old,page.id]:old.filter(id=>id!==page.id))}>{expanded?"\u25BE":"\u25B8"}</button>}</span>
   {editing?<input className="row-rename" aria-label={"Rename "+page.title} autoFocus defaultValue={page.title} onFocus={e=>e.currentTarget.select()}
     onBlur={e=>{if(cancelRename.current){cancelRename.current=false;return}void renamePage(page,e.target.value)}}
     onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==="Enter")e.currentTarget.blur();else if(e.key==="Escape"){cancelRename.current=true;setRenaming(null)}}}/>
   :<button className="tree-page" disabled={guard} onClick={()=>openPage(page.id)} onDoubleClick={()=>{if(editable)setRenaming(page.id)}}><span>{page.title}{lockedIds.includes(page.id)&&<span className="row-lock" title="Locked with a password"><Icon name="lock" size={12}/></span>}</span></button>}
   {!editing&&<span className="row-actions">
    <button aria-label={"More options for "+page.title} aria-haspopup="menu" aria-expanded={menu?.id===page.id} disabled={!editable} onClick={e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();openMenu(r.left,r.bottom+4)}}>{"\u22EF"}</button>
    <button aria-label={"Add a subpage to "+page.title} title="Add a subpage" disabled={!editable} onClick={()=>void addSubpage(page)}>+</button></span>}
  </div>;
 }
 function tree(parent:string|null=null,depth=0,visited=new Set<string>()):React.ReactNode{
  if(depth>100)return null;
  return pages.filter(p=>p.parent_id===parent&&p.id!==inboxId).sort((a,b)=>a.sort_key.localeCompare(b.sort_key)||a.id.localeCompare(b.id)).map(page=>{
   if(visited.has(page.id))return null;visited.add(page.id);
   const children=pages.some(p=>p.parent_id===page.id);const expanded=!collapsed.includes(page.id);
   return <div key={page.id}>{pageRow(page,depth)}{children&&expanded&&tree(page.id,depth+1,visited)}</div>;
  });
 }
 const favorites=pages.filter(p=>p.is_favorite).sort((a,b)=>a.title.localeCompare(b.title));
 const menuPage=menu?pages.find(p=>p.id===menu.id):undefined;
 if(showRecovery)return <Suspense fallback={<p role="status">Opening backups…</p>}><BackupPanel onBusyChange={value=>{markBusy(value)}} onClose={()=>{setShowRecovery(false);setSelected(null);onEditorStatus("saved");void reload().catch(e=>setError(String(e)))}}/></Suspense>;
 if(showGateway)return <Suspense fallback={<p role="status">Opening AI access…</p>}><GatewayPanel onClose={()=>setShowGateway(false)}/></Suspense>;
 if(showImport)return <Suspense fallback={<p role="status">Opening import…</p>}><ImportNotePanel onClose={()=>setShowImport(false)} onImported={async id=>{await reload();setShowImport(false);setShowTrash(false);openPage(id)}}/></Suspense>;
 return <EditorFeatures.Provider value={{pages,theme,canNavigate:!guard,open:openPage,create:createChild,upload,uploadFile,onError:e=>setError(String(e)),setPeekBusy:reportPeekBusy}}>
 <main className={"shell"+(focus?" focus":"")+(typing?" typing":"")}>
  {sidebarOpen&&<aside className="sidebar" style={{width:sidebarWidth}} aria-label="Sidebar">
   <div className="sb-header" data-tauri-drag-region><span className="mark">脳</span><strong className="sb-name">NOU</strong>
    <div className="sb-header-actions"><button aria-label="Close sidebar" title="Close sidebar (Ctrl+\\)" onClick={()=>setSidebarOpen(false)}><Icon name="chevronLeft" size={16}/></button>
     <button aria-label="New page" title="New page (Ctrl+N)" disabled={guard||recoveryBlocked} onClick={()=>void newRootPage()}><Icon name="compose" size={16}/></button></div></div>
   <SidebarSearchBox query={sbQuery} onQuery={setSbQuery} disabled={guard}/>
   <button className={"sb-item"+(!current&&!showTrash&&!showGraph&&!showFiles&&!showTimetable&&!showHabits&&!showSettings&&!showBot?" active":"")} disabled={guard} onClick={()=>{setSelected(null);setShowTrash(false);setShowGraph(false);setShowFiles(false);setShowTimetable(false);setShowHabits(false);setShowSettings(false);setShowBot(false)}}><Icon name="home" size={17}/><span>Home</span></button>
   <button className={"sb-item"+(showGraph?" active":"")} disabled={guard} onClick={()=>{setShowTrash(false);setShowFiles(false);setShowTimetable(false);setShowHabits(false);setShowSettings(false);setShowBot(false);setShowGraph(v=>!v)}}><Icon name="link" size={17}/><span>Graph</span></button>
   <button className={"sb-item"+(!!inboxId&&selected===inboxId&&!showTrash&&!showGraph&&!showFiles&&!showTimetable&&!showHabits&&!showSettings&&!showBot?" active":"")} disabled={guard||(!inboxId&&recoveryBlocked)} onClick={openInboxPage}><Icon name="inbox" size={17}/><span>Inbox</span></button>
   <button className={"sb-item"+(showBot?" active":"")} disabled={guard} onClick={()=>{setShowTrash(false);setShowGraph(false);setShowFiles(false);setShowTimetable(false);setShowHabits(false);setShowSettings(false);setShowBot(v=>!v)}}><Icon name="hub" size={17}/><span>Bots Hub</span>{waiting>0&&<em className="sb-badge" aria-label={waiting+" waiting for you"}>{waiting} WAITING</em>}</button>
   <button className={"sb-item"+(showFiles?" active":"")} disabled={guard} onClick={()=>{setShowTrash(false);setShowGraph(false);setShowSettings(false);setShowBot(false);setShowTimetable(false);setShowHabits(false);setShowFiles(v=>!v)}}><Icon name="folder" size={17}/><span>Files</span></button>
   <button className={"sb-item"+(showTimetable?" active":"")} disabled={guard} onClick={openTimetable}><Icon name="calendar" size={17}/><span>Life Timetable</span></button>
   <button className={"sb-item"+(showHabits?" active":"")} disabled={guard} onClick={openHabits}><Icon name="check" size={17}/><span>Habits</span></button>
   {sbQuery.trim()&&<div className="sb-scroll"><SidebarResults query={sbQuery} pages={pages} disabled={guard} onOpen={id=>{setSbQuery("");openPage(id)}}/></div>}
   <div className="sb-scroll" style={sbQuery.trim()?{display:"none"}:undefined}>
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
    <button className={"sb-item"+(showSettings||showTrash?" active":"")} disabled={guard} onClick={()=>{setShowGraph(false);setShowFiles(false);setShowTimetable(false);setShowHabits(false);setShowTrash(false);setShowBot(false);setShowSettings(v=>!v);onEditorStatus("saved")}}><Icon name="settings" size={17}/><span>Settings</span></button>
    </div>
   <div className="sb-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuenow={sidebarWidth} aria-valuemin={200} aria-valuemax={480} tabIndex={0} onPointerDown={startSidebarResize}
    onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();setSidebarWidth(w=>clampSidebar(w+(e.key==="ArrowRight"?16:-16)))}}}/>
  </aside>}
  <section className={"workspace"+(splitId&&current?" split":"")}>
   <header className="workspace-topbar" data-tauri-drag-region>{!sidebarOpen&&<button className="sb-open" aria-label="Open sidebar" title="Open sidebar (Ctrl+\\)" onClick={()=>setSidebarOpen(true)}><Icon name="menu" size={18}/></button>}<div className="tab-strip" data-tauri-drag-region><div className="page-tabs" role="tablist" aria-label="Open pages">{tabs.map(id=>{const page=pages.find(p=>p.id===id);return page&&<div className={"page-tab "+(id===selected&&!showTrash?"selected":"")} key={id}><button role="tab" aria-selected={id===selected&&!showTrash} disabled={guard} onClick={()=>openPage(id)}><i className="tab-dot" aria-hidden="true"/><span>{page.title}</span></button><button className="close-tab" aria-label={"Close "+page.title+" tab"} disabled={guard} onClick={()=>closeTab(id)}><Icon name="close" size={12}/></button></div>})}</div><button className="tab-new" aria-label="Open a page in a new tab" title="New tab" disabled={guard} onClick={()=>{setQuickFindText("");setQuickFind(true)}}><Icon name="plus" size={14}/></button></div>
    <div className="window-tools" data-tauri-drag-region><TopTimer onOpen={openTimetable} disabled={guard}/><button className="theme-tool" aria-label={"Switch to "+(theme==="light"?"dark":"light")+" mode"} title="Light / dark mode" onClick={()=>setTheme(v=>v==="light"?"dark":"light")}><Icon name={theme==="light"?"moon":"sun"} size={17}/></button><button className="fs-tool" aria-label="Toggle fullscreen" title="Fullscreen (F11)" onClick={()=>void toggleFullscreen()}><Icon name="fullscreen" size={17}/></button></div>
    <WindowControls/>
   </header>
   <ReminderToast reminder={reminders.toast} dismiss={reminders.dismiss}/>
   <CheckinPopups state={checkins}/>
   <UndoHost/>
   {backupNotice&&<p className="notice" role="status">{backupNotice} Open Workspace tools → Backups & restore.</p>}
   {recoveryBlocked&&<p className="notice">A restore needs review. Notes are read-only until you review Backups & restore.</p>}
   {error&&<div role="alert" className="error">{error}<button onClick={()=>setError("")}>Dismiss</button></div>}
   <div className={splitId&&current&&!showTrash&&!showGraph&&!showFiles&&!showTimetable&&!showHabits&&!showSettings&&!showBot?"workspace-body split":"workspace-body"}>
   {showBot?<BotsHub disabled={recoveryBlocked} pages={pages} openPage={openPage} onTokens={()=>setShowGateway(true)} onWaiting={setWaiting} refresh={reload}/>
   :showSettings&&!showTrash?<SettingsPage trashedCount={trashed.length} disabled={guard} readOnly={recoveryBlocked} onBackups={()=>setShowRecovery(true)} onImport={()=>setShowImport(true)} onTrash={()=>{setShowSettings(false);setShowTrash(true);onEditorStatus("saved")}} onAccess={()=>setShowGateway(true)}/>
   :showTrash?<div className="document trash-screen"><p><button className="link-button" onClick={()=>{setShowTrash(false);setShowSettings(true)}}>← Settings</button></p><h1>Trash</h1><p>Restoring a page also restores its subpages deleted in the same operation.</p>{!trashed.length&&<p>Trash is empty.</p>}{trashed.map(page=><div className="trash-row" key={page.id}><span><Icon name={page.icon}/>{page.title}</span><button disabled={guard||recoveryBlocked} onClick={()=>void run(()=>invoke("restore_page",{pageId:page.id}))}>Restore</button></div>)}</div>
   :showTimetable?<Suspense fallback={<p role="status">Opening the timetable…</p>}><LifeTimetableLazy disabled={recoveryBlocked}/></Suspense>
   :showHabits?<Suspense fallback={<p role="status">Opening habits…</p>}><HabitsLazy disabled={recoveryBlocked}/></Suspense>
   :showFiles?<Suspense fallback={<p role="status">Opening files…</p>}><FileTracker onOpen={openPage} disabled={guard}/></Suspense>
   :showGraph?<Suspense fallback={<p role="status">Opening graph…</p>}><GraphView pages={pages} onOpen={openPage} disabled={guard}/></Suspense>
   :current?<div className="document" key={current.id}><div className="toolbar"><nav className="breadcrumb" aria-label="Breadcrumb"><button disabled={guard} onClick={()=>setSelected(null)}>Workspace</button>{crumbs.map((page,i)=><span key={page.id}><span aria-hidden="true"> / </span>{i<crumbs.length-1?<button disabled={guard} onClick={()=>openPage(page.id)}>{page.title}</button>:<span aria-current="page">{page.title}</span>}</span>)}</nav><div className="actions">
    <LockButton pageId={current.id} locked={lockedIds.includes(current.id)} disabled={guard||recoveryBlocked} onChanged={()=>void reload().catch(e=>setError(String(e)))}/>
    <button aria-label="Focus mode" title="Focus mode (Ctrl+Shift+F)" onClick={()=>setFocus(true)}>Focus</button>
    {current.id!==inboxId&&<button className="danger" disabled={guard||recoveryBlocked} onClick={()=>{if(window.confirm("Move this page and its subpages to Trash?"))void run(async()=>{await invoke("trash_page",{pageId:current.id});setSelected(null)})}}>Trash</button>}<div id="note-export-host"/>
   </div></div>
   <div className="document-heading"><div className="page-icon-picker" ref={iconPickerRef}><button className="document-icon" aria-label="Assign page icon" disabled={guard||recoveryBlocked} onClick={()=>setIconPicker(v=>!v)}><Icon name={current.icon} size={32}/></button>{iconPicker&&<div className="icon-picker-popover" role="group" aria-label="Monochrome page icons">{iconNames.map(icon=><button key={icon} aria-label={icon+" icon"} aria-pressed={current.icon===icon} disabled={guard} onClick={()=>void run(async()=>{await invoke("set_page_icon",{pageId:current.id,icon});setIconPicker(false)})}><Icon name={icon} size={22}/></button>)}</div>}</div>
    <input className="title-input" aria-label="Page title" readOnly={guard||recoveryBlocked} defaultValue={current.title} onBlur={e=>{const title=e.target.value.trim()||"Untitled";if(!recoveryBlocked&&title!==current.title)void run(()=>invoke("rename_page",{pageId:current.id,title}))}} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur()}}/>
   </div><p className="doc-status">Offline · Saved on this device</p><LockGate pageId={current.id} locked={lockedIds.includes(current.id)} title={current.title}><Suspense fallback={<p role="status">Opening editor…</p>}><NoteEditor pageId={current.id} title={current.title} onStatus={onEditorStatus} readOnly={recoveryBlocked}/></Suspense></LockGate></div>
   :<Home pages={pages} open={openPage} openDaily={()=>void openDaily()} newPage={()=>void newRootPage()} disabled={guard||recoveryBlocked} refresh={reload} onManageAccess={()=>setShowGateway(true)}/>}
   {splitId&&current&&!showTrash&&!showGraph&&!showFiles&&!showTimetable&&!showHabits&&!showSettings&&!showBot&&(()=>{const other=pages.find(p=>p.id===splitId);return other?<aside className="split-pane" aria-label="Split view">
    <header className="split-header"><strong title={other.title}>{other.title||"Untitled"}</strong>
     <button disabled={guard} onClick={swapSplit} title="Swap the two pages">Swap</button>
     <button disabled={guard} onClick={()=>{const id=other.id;closeSplit();openPage(id)}} title="Open this page on its own">Open alone</button>
     <button disabled={splitStatus!=="saved"} onClick={closeSplit} aria-label="Close split view">Close</button></header>
    <div className="split-body"><LockGate pageId={other.id} locked={lockedIds.includes(other.id)} title={other.title}><Suspense fallback={<p role="status">Opening editor…</p>}><NoteEditor key={other.id} pageId={other.id} title={other.title} onStatus={onSplitStatus} readOnly={recoveryBlocked} secondary/></Suspense></LockGate></div>
   </aside>:null})()}
   </div>
  </section>
 {menu&&menuPage&&<div className="row-menu" role="menu" ref={menuRef} style={{left:Math.min(menu.x,window.innerWidth-230),top:Math.min(menu.y,window.innerHeight-190)}}>
  <button role="menuitem" onClick={()=>{setMenu(null);void toggleFavorite(menuPage)}}>{menuPage.is_favorite?"Remove from Favorites":"Add to Favorites"}</button>
  {current&&menuPage.id!==selected&&<button role="menuitem" disabled={guard} onClick={()=>{setMenu(null);openSplit(menuPage.id)}}>Open in split view</button>}
  <button role="menuitem" onClick={()=>{setMenu(null);setRenaming(menuPage.id)}}>Rename</button>
  <button role="menuitem" disabled={guard} onClick={()=>{setMenu(null);void run(()=>invoke("move_page",{pageId:menuPage.id,direction:"up"}))}}>Move up</button>
  <button role="menuitem" disabled={guard} onClick={()=>{setMenu(null);void run(()=>invoke("move_page",{pageId:menuPage.id,direction:"down"}))}}>Move down</button>
  <button role="menuitem" onClick={()=>{setMenu(null);void addSubpage(menuPage)}}>Add subpage</button>
  <hr/><button role="menuitem" className="danger" onClick={()=>{setMenu(null);trashPage(menuPage)}}>Move to Trash</button></div>}
 {focus&&<button className="focus-exit" onClick={()=>setFocus(false)} title="Leave focus mode (Esc)">Exit focus mode</button>}
 {showCapture&&<QuickCapture save={captureText} onOpenInbox={openInbox} onClose={()=>setShowCapture(false)} disabled={recoveryBlocked}/>}
 <button className="fab" aria-label="Quick capture" title="Quick capture" disabled={recoveryBlocked||busy} onClick={()=>setShowCapture(true)}><Icon name="bolt" size={22}/></button>
 {showShortcuts&&<ShortcutsHelp onClose={()=>setShowShortcuts(false)}/>}
 {quickFind&&<QuickFind initialQuery={quickFindText} pages={pages} onOpen={id=>{setQuickFind(false);openPage(id)}} onClose={()=>{setQuickFind(false);setQuickFindText("")}}/>}
 </main></EditorFeatures.Provider>;
}
