import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { filterFiles, formatBytes, isUnused, kindOf, totals, type Kind, type SortBy, type TrackedFile } from "./fileList";

/** Writes a stored file out to a place the person chooses. Never changes or removes the stored copy. */
async function saveCopy(f: TrackedFile) {
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  const path = await save({ defaultPath: f.name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
  if (path) await invoke("export_attachment", { id: f.id, path });
}

/**
 * Every file stored with your notes: what it is, how big, and which pages use it. Files no page uses are flagged so you can see what is
 * taking space. This screen only reads; it cannot delete or change a file.
 */
export default function FileTracker({ onOpen, disabled }: { onOpen: (id: string) => void; disabled?: boolean }) {
  const [files, setFiles] = useState<TrackedFile[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState<SortBy>("newest");
  const [unusedOnly, setUnusedOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<TrackedFile[]>("list_files").then(list => { if (!cancelled) setFiles(Array.isArray(list) ? list : []); }).catch(e => { if (!cancelled) { setError(String(e)); setFiles([]); } });
    return () => { cancelled = true; };
  }, []);

  const shown = useMemo(() => filterFiles(files ?? [], { text, kind, unusedOnly, sort }), [files, text, kind, unusedOnly, sort]);
  const sum = useMemo(() => totals(files ?? []), [files]);

  async function copy(f: TrackedFile) {
    setError(""); setNote("");
    try { await saveCopy(f); setNote("Saved a copy of " + f.name); } catch (e) { setError(String(e)); }
  }

  return <div className="document files-screen">
    <h1>Files</h1>
    <p className="hint">Everything stored with your notes. This list only shows files; it never deletes or changes one.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {note && <p className="hint" role="status">{note}</p>}
    {files === null ? <p role="status">Loading…</p> : <>
      <p role="status" className="files-total">{sum.count} file{sum.count === 1 ? "" : "s"}, {formatBytes(sum.bytes)}{sum.unusedCount > 0 && <> · <strong>{sum.unusedCount} not used by any page</strong> ({formatBytes(sum.unusedBytes)})</>}</p>
      <div className="files-tools">
        <input aria-label="Search files" type="search" placeholder="Search by file or page name" value={text} onChange={e => setText(e.target.value)} />
        <label>Type <select aria-label="File type" value={kind} onChange={e => setKind(e.target.value as Kind)}><option value="all">All</option><option value="image">Images</option><option value="pdf">PDFs</option><option value="other">Other</option></select></label>
        <label>Sort <select aria-label="Sort files" value={sort} onChange={e => setSort(e.target.value as SortBy)}><option value="newest">Newest first</option><option value="name">Name</option><option value="size">Largest first</option></select></label>
        <label><input type="checkbox" checked={unusedOnly} onChange={e => setUnusedOnly(e.target.checked)} /> Unused only</label>
      </div>
      {!files.length ? <p>No files yet. Add an image, PDF or file to a note with / and it will be listed here.</p>
        : !shown.length ? <p>No files match.</p>
        : <ul className="files-list" aria-label="Files">{shown.map(f => <li key={f.id} className={isUnused(f) ? "unused" : undefined}>
          <div className="files-main"><strong title={f.name}>{f.name}</strong><span className="hint">{kindOf(f.mime) === "image" ? "Image" : kindOf(f.mime) === "pdf" ? "PDF" : f.mime || "File"} · {formatBytes(f.bytes)}</span></div>
          <div className="files-pages">{f.pages.length ? f.pages.map(p => <button key={p.id} className="link-button" disabled={disabled} onClick={() => onOpen(p.id)}>{p.title || "Untitled"}</button>)
            : f.trashed_pages ? <em>Only on {f.trashed_pages} page{f.trashed_pages === 1 ? "" : "s"} in the trash</em> : <em className="files-unused">Not used by any page</em>}</div>
          <button onClick={() => void copy(f)} aria-label={"Save a copy of " + f.name}>Save a copy</button>
        </li>)}</ul>}
    </>}
  </div>;
}
