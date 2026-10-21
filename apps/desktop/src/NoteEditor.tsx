import { useEffect, useRef, useState } from "react";
import { save as chooseSavePath } from "@tauri-apps/plugin-dialog";
import { exportNote } from "./noteTransfer";
import { createPortal } from "react-dom";
import {useEditorFeatures} from "./EditorContext";
import {filterSuggestionItems,insertOrUpdateBlockForSlashMenu} from "@blocknote/core/extensions";
import {getDefaultReactSlashMenuItems,SuggestionMenuController} from "@blocknote/react";
import {blockAttachmentIds,documentAttachmentIds,recoveryData} from "./noteTransfer";
import { invoke } from "@tauri-apps/api/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { blocksToPlainText, FRAGMENT, migrateLegacy, noteSchema, SaveQueue } from "./blockModel";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

export type SaveStatus = "loading" | "saved" | "saving" | "failed";
type Loaded = { updates: number[][]; format: string; legacy_text: string | null; seq: number; epoch: number };
type Session = { doc: Y.Doc; loaded: Loaded; queue: SaveQueue };

function RichEditor({ session, disabled, onChange }: { session: Session; disabled: boolean; onChange: (text: string, ids?:string[]) => void }) {
  const context=useEditorFeatures();const [pending,setPending]=useState(false);
  const editor = useCreateBlockNote(withCollaboration({ schema: noteSchema, collaboration: {
    fragment: session.doc.getXmlFragment(FRAGMENT), user: { name: "Local user", color: "#52675a" },
  } }), [session]);
  async function create(kind:"page"|"image"|"pdf"){
    const anchor=editor.getTextCursorPosition().block.id;setPending(true);
    try{
      if(kind==="page"){
        const page=await context.create();
        if(!editor.getBlock(anchor))throw Error("Insertion point changed; the new page is available in the sidebar.");
        editor.setTextCursorPosition(anchor,"end");insertOrUpdateBlockForSlashMenu(editor,{type:"nouPage",props:{pageId:page.id,label:page.title,iconSize:"medium"}});
      }else{
        const file=await context.upload(kind);if(!file)return;
        if(!editor.getBlock(anchor))throw Error("Insertion point changed. Choose the file again to insert it.");
        editor.setTextCursorPosition(anchor,"end");insertOrUpdateBlockForSlashMenu(editor,{type:kind==="image"?"nouImage":"nouPdf",props:{fileId:file.id,name:file.name}});
      }
    }catch(error){context.onError(error)}finally{setPending(false)}
  }
  const items=()=>[...getDefaultReactSlashMenuItems(editor),
    {title:"Page",aliases:["page","subpage"],group:"NOU",onItemClick:()=>void create("page")},
    {title:"Bookmark",aliases:["bookmark","link"],group:"NOU",onItemClick:()=>insertOrUpdateBlockForSlashMenu(editor,{type:"nouBookmark"})},
    {title:"Image",aliases:["image","photo","upload"],group:"NOU",onItemClick:()=>void create("image")},
    {title:"PDF",aliases:["pdf","document","upload"],group:"NOU",onItemClick:()=>void create("pdf")}
  ];
  return <BlockNoteView editor={editor} theme={context.theme} editable={!disabled&&!pending} slashMenu={false} onChange={() => onChange(blocksToPlainText(editor.document),blockAttachmentIds(editor.document))}>
    <SuggestionMenuController triggerCharacter="/" getItems={async query=>filterSuggestionItems(items(),query)}/>
  </BlockNoteView>;
}

export default function NoteEditor({ pageId, onStatus, readOnly = false, title = "Untitled" }: { pageId: string; title?: string; onStatus: (status: SaveStatus) => void; readOnly?: boolean }) {
  const [session, setSession] = useState<Session>();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [exportError, setExportError] = useState("");
  const [converting, setConverting] = useState(false);
  const active = useRef<Session | undefined>(undefined);
  const failed = useRef(false);
  const revision = useRef(0);
  const latestText = useRef("");
  const latestFiles = useRef<string[]>([]);
  function report(next: SaveStatus) { setStatus(next); onStatus(next); }

  useEffect(() => {
    let cancelled = false;
    const doc = new Y.Doc(); const queue = new SaveQueue();
    setSession(undefined); failed.current = false; setError(""); report("loading");
    void invoke<Loaded>("load_note", { pageId }).then(loaded => {
      if (cancelled) return;
      if (!["text-v1", "blocknote-v1"].includes(loaded.format)) throw new Error("Unsupported note format; original data retained.");
      for (const bytes of loaded.updates) Y.applyUpdate(doc, Uint8Array.from(bytes));
      if (loaded.format === "blocknote-v1" && !doc.getXmlFragment(FRAGMENT).length) throw new Error("Rich-text fragment is missing. Restore a verified copy; do not reset this note.");
      const next = { doc, loaded, queue }; active.current = next; setSession(next);
      const original = doc.getText("body").toString(); setText(original); latestText.current = original;
      latestFiles.current=documentAttachmentIds(doc,loaded.format);
      report("saved");
    }).catch(e => { if (!cancelled) { failed.current = true; setError(String(e)); setStatus("failed"); onStatus("saved"); } });
    return () => {
      cancelled = true; active.current = undefined;
      void queue.settled().then(() => doc.destroy());
    };
  }, [pageId, reload]);

  function save(nextText: string, ids:string[]=[]) {
    const s = active.current;
    if (!s || failed.current || readOnly) return;
    latestFiles.current=ids;
    latestText.current = nextText; setText(nextText); report("saving");
    const generation = ++revision.current;
    const update = Array.from(Y.encodeStateAsUpdate(s.doc));
    void s.queue.enqueue(() => invoke<number>("save_note", {
      pageId, update, plainText: nextText, format: s.loaded.format, epoch: s.loaded.epoch, attachmentIds:ids,
    })).then(seq => {
      s.loaded.seq = seq;
      if (active.current === s && generation === revision.current) report("saved");
    }).catch(e => {
      if (active.current !== s) return;
      failed.current = true; report("failed"); setError(`Saving failed: ${String(e)}. Your current content remains here. Retry or copy it before leaving.`);
    });
  }
  async function exportCurrent(kind: "txt" | "md" | "html" | "json") {
    const s = active.current; if (!s) return;
    setExporting(true); setExportError(""); setExportMessage("");
    try {
      let content = exportNote(s.doc, s.loaded.format as "text-v1" | "blocknote-v1", pageId, title, kind, s.loaded.legacy_text);
      if(kind==="json"){
        const data=recoveryData(s.doc,s.loaded.format as "text-v1"|"blocknote-v1",pageId,title,s.loaded.legacy_text);
        data.files=await Promise.all(documentAttachmentIds(s.doc,s.loaded.format).map(async id=>{const f=await invoke<{info:{id:string;name:string};data:number[]}>("read_attachment",{id});return{id:f.info.id,name:f.info.name,data:f.data};}));
        content=JSON.stringify(data,null,2);
      }
      const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80).replace(/[. ]+$/, "") || "note";
      const path = await chooseSavePath({ defaultPath: `${filename}.${kind}`, filters: [{ name: `Note ${kind.toUpperCase()}`, extensions: [kind] }] });
      if (path) {
        await invoke("write_note_export", { path, content });
        setExportMessage(`Export saved: ${path}`);
      }
    } catch (e) { setExportError(String(e)); }
    finally { setExporting(false); }
  }
  async function downloadRecovery(kind: "text" | "yjs") {
    const s=active.current;if(!s)return;
    let content=latestText.current;
    try {
      if(kind==="yjs"){
        const data=recoveryData(s.doc,s.loaded.format as "text-v1"|"blocknote-v1",pageId,title,s.loaded.legacy_text);
        const ids=documentAttachmentIds(s.doc,s.loaded.format);
        if(ids.length)data.files=await Promise.all(ids.map(async id=>{const file=await invoke<{info:{id:string;name:string};data:number[]}>("read_attachment",{id});return{id:file.info.id,name:file.info.name,data:file.data}}));
        content=JSON.stringify(data);
      }
      if(content.length>128*1024*1024)throw Error("Recovery transfer exceeds 128 MB; use a complete backup and preserve this note state.");
      const url=URL.createObjectURL(new Blob([content],{type:kind==="text"?"text/plain;charset=utf-8":"application/json"}));
      const link=document.createElement("a");link.href=url;link.download=`nou-note-${pageId}.${kind==="text"?"txt":"json"}`;document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error){setError(`Recovery download failed: ${String(error)}. Keep this note open; your current content remains here.`);}
  }
  async function convert() {
    const s = active.current; if (!s || status !== "saved" || readOnly) return;
    setConverting(true); report("saving"); setError("");
    let migrated: Y.Doc | undefined;
    try {
      migrated = migrateLegacy(s.doc);
      const original = s.doc.getText("body").toString();
      await invoke("migrate_note", { pageId, update: Array.from(Y.encodeStateAsUpdate(migrated)), plainText: original, original, expectedSeq: s.loaded.seq, epoch: s.loaded.epoch });
      setReload(v => v + 1);
    } catch (e) { setError(`Conversion did not complete: ${String(e)}. Your original note is retained. Reopen to check the saved format before retrying.`); report("saved"); }
    finally { migrated?.destroy(); setConverting(false); }
  }
  const exportMenu=session&&<details className="note-export"><summary aria-label="Page options">⋯</summary><div className="export-dropdown"><strong>Export this note</strong>
    <p>Choose a new filename. JSON includes uploaded files; use a complete backup if it exceeds the transfer size limit.</p>
    {(["txt","md","html","json"] as const).map(kind=><button key={kind} disabled={exporting||converting} onClick={()=>void exportCurrent(kind)}>{kind==="json"?"Recovery JSON":kind.toUpperCase()}</button>)}
    {exportMessage&&<p role="status">{exportMessage}</p>}{exportError&&<p role="alert">{exportError}</p>}</div></details>;
  return <section className="note-editor">
    <div className="save-status" aria-live="polite">{status === "loading" ? "Opening note…" : status === "saving" ? "Saving locally…" : status === "saved" ? "Saved on this device" : "Save error — content retained in this window"}</div>
    {document.getElementById("note-export-host") ? createPortal(exportMenu,document.getElementById("note-export-host")!) : exportMenu}
    {error && <p className="editor-error" role="alert">{error}</p>}
    {session?.loaded.format === "text-v1" && <>
      <div className="migration-notice"><strong>Original plain-text note</strong><p>Convert this note to rich-text blocks when you are ready. NOU preserves the exact original text and creates a local recovery copy first. Plain text stays literal; Markdown is not interpreted.</p>
        <button disabled={status !== "saved" || readOnly} onClick={() => void convert()}>Convert this note to rich text</button></div>
      <textarea aria-label="Note content" value={text} readOnly={status === "failed" || readOnly || converting} onChange={e => {
        const next = e.target.value; const body = session.doc.getText("body");
        session.doc.transact(() => { body.delete(0, body.length); body.insert(0, next); }); save(next);
      }} spellCheck />
    </>}
    {session?.loaded.format === "blocknote-v1" && <>
      <RichEditor session={session} disabled={status === "failed" || readOnly} onChange={save} />
    </>}
    {status === "failed" && <div className="recovery-card">
      {session ? <><button disabled={readOnly} onClick={() => { session.queue.reset(); failed.current = false; setError(""); save(latestText.current,latestFiles.current); }}>Retry saving all current content</button>
        <button onClick={() => { if (window.confirm("Only continue if you have copied your unsaved content. Leaving this note may discard unsaved edits.")) onStatus("saved"); }}>I copied my content — allow navigation</button>
        <button onClick={() => downloadRecovery("text")}>Download recovery text</button>
        <button onClick={() => downloadRecovery("yjs")}>Download recovery data with formatting</button>
        <p>Recovery downloads contain this note only. Keep the JSON file for formatting recovery; it is not a full backup package and cannot be opened by Backups & restore.</p>
        <details open><summary>Copy current text for recovery</summary><textarea aria-label="Recovery text" readOnly value={text} /></details>
        <details><summary>Copy full Yjs state (preserves formatting)</summary><textarea aria-label="Recovery Yjs state" readOnly value={JSON.stringify(Array.from(Y.encodeStateAsUpdate(session.doc)))} /></details></>
        : <button onClick={() => setReload(v => v + 1)}>Retry opening note</button>}
    </div>}
  </section>;
}
