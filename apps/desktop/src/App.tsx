import NoteEditor from "./NoteEditor";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Page = { id: string; title: string; parent_id: string | null; sort_key: string };
type Row = { page: Page; depth: number };
type SearchHit = { id: string; title: string; parent_id: string | null };
type Snapshot = { filename: string; path: string; bytes: number };

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
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [restoreCopy, setRestoreCopy] = useState<Snapshot | null>(null);
  const reload = useCallback(async () => {
    setPages(await invoke<Page[]>("list_pages"));
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
  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="mark">脳</span><div><strong>Project NOU</strong><small>Offline Notes · Alpha</small></div></div>
      <div className="sidebar-heading"><span>Pages</span>
        <button disabled={busy} aria-label="New root page" title="New root page" onClick={() => void run(async () => {
          const page = await invoke<Page>("create_page", { parentId: null, title: "Untitled" });
          setSelected(page.id);
        })}>＋</button>
      </div>
      <input className="search-input" aria-label="Search notes" placeholder="Search notes…" value={search} onChange={e => setSearch(e.target.value)} />
      {search.trim() && <div className="search-caption">{searching ? "Searching…" : `${hits.length} match(es)`}</div>}
      <nav aria-label={search.trim() ? "Search results" : "Pages"}>
        {search.trim() && hits.map(hit => <button key={hit.id} className={"page-item " + (selected === hit.id ? "active" : "")} onClick={() => setSelected(hit.id)}><span>⌕</span><span className="page-title">{hit.title}</span></button>)}
        {!search.trim() && <>
        {rows.map(({ page, depth }) => <button key={page.id}
          className={"page-item " + (selected === page.id ? "active" : "")}
          style={{ paddingLeft: 16 + depth * 16 }}
          onClick={() => setSelected(page.id)}>
          <span>▤</span><span className="page-title">{page.title}</span>
        </button>)}
        </>}
      </nav>
      {pages.length === 0 && <p className="hint">Create your first note to begin.</p>}
      <div className="backup-panel">
        <button disabled={busy} onClick={() => void run(async () => {
          const created = await invoke<Snapshot>("create_notes_snapshot");
          await invoke("verify_notes_snapshot", { filename: created.filename });
          setSnapshot(created);
          setRestoreCopy(null);
        })}>Create recovery snapshot</button>
        {snapshot && <p role="status">Verified: {snapshot.filename}<br />{Math.ceil(snapshot.bytes / 1024)} KB saved to:<br /><span className="snapshot-path">{snapshot.path}</span></p>}
        {snapshot && <button disabled={busy} onClick={() => void run(async () => {
          const copy = await invoke<Snapshot>("stage_notes_restore", { filename: snapshot.filename });
          setRestoreCopy(copy);
        })}>Verify a separate recovery copy</button>}
        {restoreCopy && <p role="status">Recovery copy ready; active database unchanged. <span className="snapshot-path">{restoreCopy.path}</span></p>}
        <small>Stored on this PC. Copy the snapshot to another device for real backup protection. Wait until note edits show “Saved” first.</small>
      </div>
      <div className="sidebar-footer">Stored locally in SQLite · No account needed</div>
    </aside>
    <section className="workspace">
      {error && <div role="alert" className="error">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {current ? <div className="document" key={current.id}>
        <div className="toolbar">
          <span>Knowledge / Notes</span>
          <div className="actions">
            <button disabled={busy} onClick={() => void run(async () => {
              const p = await invoke<Page>("create_page", { parentId: current.id, title: "Untitled" });
              setSelected(p.id);
            })}>+ Subpage</button>
            <button disabled={busy} onClick={() => void run(() => invoke("move_page", { pageId: current.id, direction: "up" }))}>↑</button>
            <button disabled={busy} onClick={() => void run(() => invoke("move_page", { pageId: current.id, direction: "down" }))}>↓</button>
            <button disabled={busy} className="danger" onClick={() => {
              if (window.confirm("Move this page to trash? Its subpages will not be permanently erased.")) {
                void run(async () => { await invoke("trash_page", { pageId: current.id }); setSelected(null); });
              }
            }}>Trash</button>
          </div>
        </div>
        <input className="title-input" aria-label="Page title" defaultValue={current.title}
          onBlur={e => { const title = e.target.value.trim() || "Untitled";
            if (title !== current.title) void run(() => invoke("rename_page", { pageId: current.id, title }));
          }}
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <NoteEditor pageId={current.id} />
      </div> : <div className="empty"><span className="big-mark">脳</span><h1>Your knowledge, your device.</h1>
        <p>Select a page or create a new one. Everything stays offline on this computer.</p>
        <button disabled={busy} onClick={() => void run(async () => {
          const p = await invoke<Page>("create_page", { parentId: null, title: "My first page" });
          setSelected(p.id);
        })}>Create a page</button></div>}
    </section>
  </main>;
}
