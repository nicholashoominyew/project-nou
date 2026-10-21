import { useEffect, useRef, useState } from "react";
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

function RichEditor({ session, disabled, onChange }: { session: Session; disabled: boolean; onChange: (text: string) => void }) {
  const editor = useCreateBlockNote(withCollaboration({ schema: noteSchema, collaboration: {
    fragment: session.doc.getXmlFragment(FRAGMENT), user: { name: "Local user", color: "#52675a" },
  } }), [session]);
  return <BlockNoteView editor={editor} theme="light" editable={!disabled} onChange={() => onChange(blocksToPlainText(editor.document))} />;
}

export default function NoteEditor({ pageId, onStatus, readOnly = false }: { pageId: string; onStatus: (status: SaveStatus) => void; readOnly?: boolean }) {
  const [session, setSession] = useState<Session>();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [converting, setConverting] = useState(false);
  const active = useRef<Session | undefined>(undefined);
  const failed = useRef(false);
  const revision = useRef(0);
  const latestText = useRef("");
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
      report("saved");
    }).catch(e => { if (!cancelled) { failed.current = true; setError(String(e)); setStatus("failed"); onStatus("saved"); } });
    return () => {
      cancelled = true; active.current = undefined;
      void queue.settled().then(() => doc.destroy());
    };
  }, [pageId, reload]);

  function save(nextText: string) {
    const s = active.current;
    if (!s || failed.current || readOnly) return;
    latestText.current = nextText; setText(nextText); report("saving");
    const generation = ++revision.current;
    const update = Array.from(Y.encodeStateAsUpdate(s.doc));
    void s.queue.enqueue(() => invoke<number>("save_note", {
      pageId, update, plainText: nextText, format: s.loaded.format, epoch: s.loaded.epoch,
    })).then(seq => {
      s.loaded.seq = seq;
      if (active.current === s && generation === revision.current) report("saved");
    }).catch(e => {
      if (active.current !== s) return;
      failed.current = true; report("failed"); setError(`Saving failed: ${String(e)}. Your current content remains here. Retry or copy it before leaving.`);
    });
  }
  function downloadRecovery(kind: "text" | "yjs") {
    const s = active.current; if (!s) return;
    const content = kind === "text" ? latestText.current : JSON.stringify({
      format: "nou-note-recovery-v1", pageId, editorFormat: s.loaded.format,
      plainText: latestText.current, update: Array.from(Y.encodeStateAsUpdate(s.doc)),
    });
    const url = URL.createObjectURL(new Blob([content], { type: kind === "text" ? "text/plain;charset=utf-8" : "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `nou-note-${pageId}.${kind === "text" ? "txt" : "json"}`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  return <section className="note-editor">
    <div className="save-status" aria-live="polite">{status === "loading" ? "Opening note…" : status === "saving" ? "Saving locally…" : status === "saved" ? "Saved on this device" : "Save error — content retained in this window"}</div>
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
      <p className="editor-help">Type / for blocks · Select text for formatting · Drag the block handle to reorder · Ctrl+Z to undo</p>
      {!!session.loaded.legacy_text && <details><summary>Original text before conversion (preserved)</summary><textarea aria-label="Original preserved text" readOnly value={session.loaded.legacy_text} /></details>}
    </>}
    {status === "failed" && <div className="recovery-card">
      {session ? <><button disabled={readOnly} onClick={() => { session.queue.reset(); failed.current = false; setError(""); save(latestText.current); }}>Retry saving all current content</button>
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
