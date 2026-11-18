import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Icon } from "./Icons";
import { useDismiss } from "./Dismissible";
import { MAX_PREVIEW_BYTES, MAX_TEXT_CHARS, filterFiles, formatBytes, isUnused, kindOf, previewKind, totals, type Kind, type SortBy, type TrackedFile } from "./fileList";

/** Writes a stored file out to a place the person chooses. Never changes or removes the stored copy. */
async function saveCopy(f: TrackedFile) {
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  const path = await save({ defaultPath: f.name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
  if (path) await invoke("export_attachment", { id: f.id, path });
}

type Loaded = { data: number[]; info: { mime: string } };
/** Reads a stored file once it is wanted (a card scrolled into view, or opened for preview) and hands back a temporary address for it. */
function useFileUrl(f: TrackedFile, wanted: boolean, forceMime?: string): { url: string; bytes: Uint8Array | null; error: string } {
  const [state, setState] = useState<{ url: string; bytes: Uint8Array | null; error: string }>({ url: "", bytes: null, error: "" });
  useEffect(() => {
    if (!wanted) return;
    if (f.bytes > MAX_PREVIEW_BYTES) { setState({ url: "", bytes: null, error: "Too large to preview here (" + formatBytes(f.bytes) + ")." }); return; }
    let off = false, made = "";
    invoke<Loaded>("read_attachment", { id: f.id }).then(file => {
      if (off) return;
      const bytes = Uint8Array.from(file.data);
      made = URL.createObjectURL(new Blob([bytes], { type: forceMime ?? file.info.mime }));
      setState({ url: made, bytes, error: "" });
    }).catch(e => { if (!off) setState({ url: "", bytes: null, error: String(e) }); });
    return () => { off = true; if (made) URL.revokeObjectURL(made); };
  }, [f.id, f.bytes, wanted, forceMime]);
  return state;
}

/** One tile in the gallery: a picture for an image, an icon for everything else. Pictures load only when the tile is on screen. */
function Tile({ f, onOpen }: { f: TrackedFile; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const isImage = previewKind(f.mime, f.name) === "image";
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  const { url } = useFileUrl(f, isImage && seen);
  const label = kindOf(f.mime) === "image" ? "Image" : kindOf(f.mime) === "pdf" ? "PDF" : (f.name.includes(".") ? f.name.split(".").pop()!.toUpperCase() : "File");
  return <li className={"file-tile" + (isUnused(f) ? " unused" : "")}>
    <button ref={ref} className="file-thumb" aria-label={"Preview " + f.name} onClick={onOpen}>
      {isImage && url ? <img src={url} alt="" loading="lazy" /> : <span className="file-glyph"><Icon name={kindOf(f.mime) === "pdf" ? "pdf" : kindOf(f.mime) === "image" ? "image" : "attachment"} size={34} /><em>{label}</em></span>}
    </button>
    <div className="file-caption"><strong title={f.name}>{f.name}</strong><span className="hint">{formatBytes(f.bytes)}{isUnused(f) ? " · unused" : ""}</span></div>
  </li>;
}

/** A large look at one file, with the pages that use it. Images, PDFs and text files show here; anything else offers a copy. */
function PreviewDialog({ files, index, setIndex, onClose, onOpenPage, onCopy, disabled }: { files: TrackedFile[]; index: number; setIndex: (i: number) => void; onClose: () => void; onOpenPage: (id: string) => void; onCopy: (f: TrackedFile) => void; disabled?: boolean }) {
  const f = files[index];
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  const kind = previewKind(f.mime, f.name);
  const { url, bytes, error } = useFileUrl(f, kind !== "none", kind === "pdf" ? "application/pdf" : undefined);
  const text = useMemo(() => {
    if (kind !== "text" || !bytes) return "";
    const t = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, MAX_TEXT_CHARS * 4));
    return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) + "\n… (shortened)" : t;
  }, [kind, bytes]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && index < files.length - 1) { e.preventDefault(); setIndex(index + 1); }
      else if (e.key === "ArrowLeft" && index > 0) { e.preventDefault(); setIndex(index - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, files.length, setIndex]);
  return <div className="quick-find-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="file-preview" role="dialog" aria-modal="true" aria-label={"Preview of " + f.name} ref={ref}>
      <header><strong title={f.name}>{f.name}</strong><span className="hint">{formatBytes(f.bytes)} · {index + 1} of {files.length}</span>
        <span className="file-preview-tools">
          <button aria-label="Previous file" disabled={index === 0} onClick={() => setIndex(index - 1)}>‹</button>
          <button aria-label="Next file" disabled={index >= files.length - 1} onClick={() => setIndex(index + 1)}>›</button>
          <button onClick={() => onCopy(f)} aria-label={"Save a copy of " + f.name}>Save a copy</button>
          <button onClick={onClose} aria-label="Close preview">Close</button></span></header>
      <div className="file-preview-body">
        {error && <p className="error" role="alert">{error}</p>}
        {!error && kind === "none" && <p className="hint">There is no preview for this kind of file. You can still save a copy.</p>}
        {!error && kind !== "none" && !url && <p role="status">Loading…</p>}
        {kind === "image" && url && <img src={url} alt={f.name} />}
        {kind === "pdf" && url && <iframe title={"PDF: " + f.name} src={url} />}
        {kind === "text" && bytes && <pre aria-label="File text">{text || "(empty file)"}</pre>}
      </div>
      <footer className="files-pages">{f.pages.length ? <><span className="hint">Used on</span>{f.pages.map(p => <button key={p.id} className="link-button" disabled={disabled} onClick={() => onOpenPage(p.id)}>{p.title || "Untitled"}</button>)}</>
        : f.trashed_pages ? <em>Only on {f.trashed_pages} page{f.trashed_pages === 1 ? "" : "s"} in the trash</em> : <em className="files-unused">Not used by any page</em>}</footer>
    </div>
  </div>;
}

/**
 * Every file stored with your notes, as a gallery (pictures where there are pictures) or a list. Click one to preview it: images, PDFs and text files
 * open right here. Files no page uses are flagged so you can see what is taking space. This screen only reads; it cannot delete or change a file.
 */
export default function FileTracker({ onOpen, disabled }: { onOpen: (id: string) => void; disabled?: boolean }) {
  const [files, setFiles] = useState<TrackedFile[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState<SortBy>("newest");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [view, setView] = useState<"gallery" | "list">(() => { try { return localStorage.getItem("nou-files-view") === "list" ? "list" : "gallery"; } catch { return "gallery"; } });
  const [preview, setPreview] = useState<number | null>(null);
  const chooseView = (v: "gallery" | "list") => { setView(v); try { localStorage.setItem("nou-files-view", v); } catch { /* a preference only */ } };

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
    <div className="files-top"><h1>Files</h1>
      <div className="seg" role="group" aria-label="View">
        <button aria-pressed={view === "gallery"} onClick={() => chooseView("gallery")}>Gallery</button>
        <button aria-pressed={view === "list"} onClick={() => chooseView("list")}>List</button></div></div>
    <p className="hint">Everything stored with your notes. Click a file to preview it. This screen only shows files; it never deletes or changes one.</p>
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
        : view === "gallery"
          ? <ul className="files-gallery" aria-label="Files">{shown.map((f, i) => <Tile key={f.id} f={f} onOpen={() => setPreview(i)} />)}</ul>
          : <ul className="files-list" aria-label="Files">{shown.map((f, i) => <li key={f.id} className={isUnused(f) ? "unused" : undefined}>
            <div className="files-main"><button className="link-button" aria-label={"Preview " + f.name} onClick={() => setPreview(i)}><strong title={f.name}>{f.name}</strong></button><span className="hint">{kindOf(f.mime) === "image" ? "Image" : kindOf(f.mime) === "pdf" ? "PDF" : f.mime || "File"} · {formatBytes(f.bytes)}</span></div>
            <div className="files-pages">{f.pages.length ? f.pages.map(p => <button key={p.id} className="link-button" disabled={disabled} onClick={() => onOpen(p.id)}>{p.title || "Untitled"}</button>)
              : f.trashed_pages ? <em>Only on {f.trashed_pages} page{f.trashed_pages === 1 ? "" : "s"} in the trash</em> : <em className="files-unused">Not used by any page</em>}</div>
            <button onClick={() => void copy(f)} aria-label={"Save a copy of " + f.name}>Save a copy</button>
          </li>)}</ul>}
    </>}
    {preview !== null && shown[preview] && <PreviewDialog files={shown} index={preview} setIndex={setPreview} onClose={() => setPreview(null)} onOpenPage={id => { setPreview(null); onOpen(id); }} onCopy={f => void copy(f)} disabled={disabled} />}
  </div>;
}
