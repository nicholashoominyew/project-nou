import * as Y from "yjs";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { blockAttachmentIds, inspectDocument, parseRecovery, type Transfer } from "./noteTransfer";
export default function ImportNotePanel({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => void | Promise<void> }) {
  const [data, setData] = useState<Transfer>();
  const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function choose() {
    setError(""); setData(undefined); setBusy(true);
    try {
      const path = await open({ multiple: false, filters: [{ name: "NOU note recovery", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      const parsed = parseRecovery(await invoke<string>("read_note_import", { path }));
      setData(parsed); setTitle(`${(parsed.title || "Recovered note").slice(0, 980)} (imported)`);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function restore() {
    if (!data) return; setBusy(true); setError("");
    try {
      const doc=new Y.Doc();let ids:string[];try{Y.applyUpdate(doc,Uint8Array.from(data.update));ids=blockAttachmentIds(inspectDocument(doc,data.editorFormat).blocks||[]);}finally{doc.destroy()}
      const page = await invoke<{ id: string }>("import_note", { title: title.trim() || "Recovered note", update: data.update, plainText: data.plainText, format: data.editorFormat, legacyText: data.legacyText ?? null, attachmentIds:ids,files:data.files??[] });
      await onImported(page.id);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <main className="recovery-screen"><header><h1>Import a recovered note</h1><button disabled={busy} onClick={onClose}>Back to notes</button></header>
    <p>Choose a NOU recovery JSON file. Import creates a new root page and leaves your existing notes and the source file unchanged.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void choose()}>Choose recovery JSON…</button>
    {data && <section className="recovery-card"><h2>Review the recovered copy</h2>
      <label>Page title<input aria-label="Imported page title" maxLength={1000} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <p>{data.editorFormat === "blocknote-v1" ? "Rich text and formatting" : "Plain text"} · {data.plainText.length.toLocaleString()} characters</p>
      <pre className="import-preview">{data.plainText.slice(0, 4000)}</pre>
      <button disabled={busy} onClick={() => void restore()}>Import as a new page</button>
    </section>}
    {busy && <p role="status">Working…</p>}
  </main>;
}
