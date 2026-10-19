import NoteEditor from "./NoteEditor";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Page = { id: string; title: string; parent_id: string | null; sort_key: string };
type Row = { page: Page; depth: number };

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
  const reload = useCallback(async () => {
    setPages(await invoke<Page[]>("list_pages"));
  }, []);

  useEffect(() => {
    void reload().catch(e => setError(String(e)));
  }, [reload]);

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
      <nav aria-label="Pages">
        {rows.map(({ page, depth }) => <button key={page.id}
          className={"page-item " + (selected === page.id ? "active" : "")}
          style={{ paddingLeft: 16 + depth * 16 }}
          onClick={() => setSelected(page.id)}>
          <span>▤</span><span className="page-title">{page.title}</span>
        </button>)}
      </nav>
      {pages.length === 0 && <p className="hint">Create your first note to begin.</p>}
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
