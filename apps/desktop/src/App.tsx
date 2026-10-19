import NoteEditor, { type SaveStatus } from "./NoteEditor";
import BackupPanel from "./BackupPanel";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Page = { id: string; title: string; parent_id: string | null; sort_key: string };
type Row = { page: Page; depth: number };
type SearchHit = { id: string; title: string; parent_id: string | null };


function flatten(pages: Page[], parent: string | null = null, depth = 0, visited = new Set<string>()): Row[] {
  const rows: Row[] = [];
  for (const page of pages.filter(p => p.parent_id === parent).sort((a, b) =>
    a.sort_key.localeCompare(b.sort_key) || a.id.localeCompare(b.id))) {
    if (visited.has(page.id)) continue;
    visited.add(page.id);
    rows.push({ page, depth });
    rows.push(...flatten(pages, page.id, depth + 1, visited));
  }
  return rows;
}

export default function App() {
  const [pages, setPages] = useState<Page[]>([]);
  const [trashedPages, setTrashedPages] = useState<Page[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [editorStatus, setEditorStatus] = useState<SaveStatus>("saved");
  const saveStatusRef = useRef<SaveStatus>("saved");
  const onEditorStatus = useCallback((status: SaveStatus) => { saveStatusRef.current = status; setEditorStatus(status); }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(event => {
      if (saveStatusRef.current !== "saved") {
        event.preventDefault(); setError("Wait for saving to finish, or retry/copy unsaved content before closing NOU.");
      }
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const reload = useCallback(async () => {
    const [active, trashed] = await Promise.all([
      invoke<Page[]>("list_pages"),
      invoke<Page[]>("list_trashed_pages")
    ]);
    setPages(active);
    setTrashedPages(trashed);
    const recovery = await invoke<{ interrupted: unknown[] }>("backup_status");
    setRecoveryBlocked(recovery.interrupted.length > 0);
  }, []);

  useEffect(() => {
    void reload().catch(e => setError(String(e)));
  }, [reload]);

  useEffect(() => {
    if (!search.trim()) { setHits([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void invoke<SearchHit[]>("search_notes", { query: search })
        .then(result => { if (!cancelled) { setHits(result); setError(""); } })
        .catch(reason => { if (!cancelled) setError(String(reason)); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [search, pages]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await reload(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  const current = pages.find(p => p.id === selected);
  const rows = flatten(pages);
  if (showRecovery) return <BackupPanel onClose={() => {
    setShowRecovery(false); setSelected(null); setSearch(""); onEditorStatus("saved");
    void reload().catch(e => setError(String(e)));
  }} />;
  return <main className="shell">
    <aside className="sidebar" inert={editorStatus !== "saved" || busy}>
      <div className="brand"><span className="mark">脳</span><div><strong>Project NOU</strong><small>Offline Notes · Alpha</small></div></div>
      <div className="sidebar-heading"><span>Pages</span>
        <button disabled={busy || editorStatus !== "saved" || recoveryBlocked} aria-label="New root page" title="New root page" onClick={() => void run(async () => {
          const page = await invoke<Page>("create_page", { parentId: null, title: "Untitled" });
          setSelected(page.id);
          setShowTrash(false);
        })}>＋</button>
      </div>
      {!showTrash && <input className="search-input" aria-label="Search notes" placeholder="Search notes…" value={search} onChange={e => setSearch(e.target.value)} /> }
      {!showTrash && search.trim() && <div className="search-caption">{searching ? "Searching…" : `${hits.length} match(es)`}</div>}
      {!showTrash && <nav aria-label={search.trim() ? "Search results" : "Pages"}>
        {search.trim() && hits.map(hit => <button key={hit.id} className={"page-item " + (selected === hit.id ? "active" : "")} onClick={() => setSelected(hit.id)}><span>⌕</span><span className="page-title">{hit.title}</span></button>)}
        {!search.trim() && <>
        {rows.map(({ page, depth }) => <button key={page.id}
          className={"page-item " + (selected === page.id ? "active" : "")}
          style={{ paddingLeft: 16 + depth * 16 }}
          onClick={() => setSelected(page.id)}>
          <span>▤</span><span className="page-title">{page.title}</span>
        </button>)}
        </>}
      </nav>}
      <button className={"trash-toggle " + (showTrash ? "active" : "")} onClick={() => { setShowTrash(v => !v); setSearch(""); }}>
        Trash ({trashedPages.length})
      </button>
      {pages.length === 0 && !showTrash && <p className="hint">Create your first note to begin.</p>}
      <div className="backup-panel">
        <button disabled={busy || editorStatus !== "saved"} onClick={() => setShowRecovery(true)}>Backups & restore</button>
        <small>Verified versions, guided restore and preserved rollback.</small>
      </div>
      <div className="sidebar-footer">Stored locally in SQLite · No account needed</div>
    </aside>
    <section className="workspace">
      {recoveryBlocked && <p className="notice">A restore needs review. Notes are read-only until you review Backups & restore.</p>}
      {error && <div role="alert" className="error">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {showTrash ? <div className="document trash-screen">
        <div className="toolbar">Knowledge / Trash</div>
        <h1>Recently deleted pages</h1>
        <p>Restoring a page also restores its subpages deleted in the same operation.</p>
        {trashedPages.length === 0 && <p>Trash is empty.</p>}
        {trashedPages.map(page => <div className="trash-row" key={page.id}>
          <span>{page.title}</span>
          <button disabled={busy || editorStatus !== "saved" || recoveryBlocked} onClick={() => void run(() => invoke("restore_page", { pageId: page.id }))}>Restore</button>
        </div>)}
      </div> : current ? <div className="document" key={current.id}>
        <div className="toolbar">
          <span>Knowledge / Notes</span>
          <div className="actions">
            <button disabled={busy || editorStatus !== "saved" || recoveryBlocked} onClick={() => void run(async () => {
              const p = await invoke<Page>("create_page", { parentId: current.id, title: "Untitled" });
              setSelected(p.id);
            })}>+ Subpage</button>
            <button disabled={busy || editorStatus !== "saved" || recoveryBlocked} onClick={() => void run(() => invoke("move_page", { pageId: current.id, direction: "up" }))}>↑</button>
            <button disabled={busy || editorStatus !== "saved" || recoveryBlocked} onClick={() => void run(() => invoke("move_page", { pageId: current.id, direction: "down" }))}>↓</button>
            <button disabled={busy || editorStatus !== "saved" || recoveryBlocked} className="danger" onClick={() => {
              if (window.confirm("Move this page to trash? Its subpages will not be permanently erased.")) {
                void run(async () => { await invoke("trash_page", { pageId: current.id }); setSelected(null); });
              }
            }}>Trash</button>
          </div>
        </div>
        <input readOnly={recoveryBlocked || editorStatus !== "saved"} className="title-input" aria-label="Page title" defaultValue={current.title}
          onBlur={e => { const title = e.target.value.trim() || "Untitled";
            if (!recoveryBlocked && title !== current.title) void run(() => invoke("rename_page", { pageId: current.id, title }));
          }}
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <NoteEditor pageId={current.id} onStatus={onEditorStatus} readOnly={recoveryBlocked} />
      </div> : <div className="empty"><span className="big-mark">脳</span><h1>Your knowledge, your device.</h1>
        <p>Select a page or create a new one. Everything stays offline on this computer.</p>
        <button disabled={busy || editorStatus !== "saved" || recoveryBlocked} onClick={() => void run(async () => {
          const p = await invoke<Page>("create_page", { parentId: null, title: "My first page" });
          setSelected(p.id);
        })}>Create a page</button></div>}
    </section>
  </main>;
}
