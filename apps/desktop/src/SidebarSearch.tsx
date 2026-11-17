import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icons";
import type { PageInfo } from "./EditorContext";
import { formatBytes, type TrackedFile } from "./fileList";

type LineHit = { id: string; title: string; snippet: string };
const HIT_START = "\u0001", HIT_END = "\u0002";

/** An excerpt from the search index as plain text pieces, the matched words flagged. Anything else in it is shown as text, never as markup. */
export function splitSnippet(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let hit = false, buffer = "";
  for (const ch of snippet) {
    if (ch === HIT_START || ch === HIT_END) { if (buffer) out.push({ text: buffer, hit }); buffer = ""; hit = ch === HIT_START; } else buffer += ch;
  }
  if (buffer) out.push({ text: buffer, hit });
  return out;
}

export function SidebarSearchBox({ query, onQuery, disabled }: { query: string; onQuery: (q: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return <div className="sb-search">
    <Icon name="search" size={15} />
    <input ref={ref} type="search" aria-label="Search pages, lines and files" placeholder="Search pages, lines, files" value={query} disabled={disabled}
      onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { onQuery(""); ref.current?.blur(); } }} />
  </div>;
}

/**
 * What the sidebar shows while something is typed in the search box: pages whose title matches (instant), lines inside notes that match
 * (from the local search index), and files by name (each listing the pages that use it). Everything is read-only and stays on this computer.
 */
export function SidebarResults({ query, pages, onOpen, disabled }: { query: string; pages: PageInfo[]; onOpen: (id: string) => void; disabled?: boolean }) {
  const needle = query.trim();
  const lower = needle.toLowerCase();
  const [lines, setLines] = useState<LineHit[]>([]);
  const [files, setFiles] = useState<TrackedFile[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setLines([]); setError("");
    if (!needle) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<LineHit[]>("search_lines", { query: needle }).then(r => { if (!cancelled && Array.isArray(r)) setLines(r); }).catch(e => { if (!cancelled) setError(String(e)); });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [needle]);
  // The file list is fetched once, the first time something is typed, and kept while the sidebar is open.
  const asked = useRef(false), alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (!needle || asked.current) return;
    asked.current = true;
    void invoke<TrackedFile[]>("list_files").then(r => { if (alive.current) setFiles(Array.isArray(r) ? r : []); }).catch(() => { if (alive.current) setFiles([]); });
  }, [needle]);

  const pageHits = useMemo(() => pages.filter(p => p.title.toLowerCase().includes(lower)).slice(0, 30), [pages, lower]);
  const fileHits = useMemo(() => (files ?? []).filter(f => f.name.toLowerCase().includes(lower)).slice(0, 20), [files, lower]);
  if (!needle) return null;
  const nothing = !pageHits.length && !lines.length && !fileHits.length;
  const first = pageHits[0]?.id ?? lines[0]?.id ?? fileHits[0]?.pages[0]?.id;

  return <div className="sb-results" role="region" aria-label="Search results" data-first={first}>
    {error && <p className="error" role="alert">{error}</p>}
    {pageHits.length > 0 && <section aria-label="Pages"><h3>Pages</h3>
      {pageHits.map(p => <button key={p.id} className="sb-result" disabled={disabled} onClick={() => onOpen(p.id)}><Icon name={p.icon} size={15} /><span>{p.title || "Untitled"}</span></button>)}</section>}
    {lines.length > 0 && <section aria-label="Lines"><h3>Lines in notes</h3>
      {lines.map(l => <button key={l.id} className="sb-result sb-line" disabled={disabled} onClick={() => onOpen(l.id)}>
        <strong>{l.title || "Untitled"}</strong>
        <span>{splitSnippet(l.snippet).map((p, i) => p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</span></button>)}</section>}
    {fileHits.length > 0 && <section aria-label="Files"><h3>Files</h3>
      {fileHits.map(f => <div key={f.id} className="sb-file">
        <div><strong title={f.name}>{f.name}</strong><em>{formatBytes(f.bytes)}</em></div>
        {f.pages.length ? f.pages.slice(0, 4).map(p => <button key={p.id} className="sb-result sb-file-page" disabled={disabled} onClick={() => onOpen(p.id)}><Icon name="document" size={13} /><span>{p.title || "Untitled"}</span></button>)
          : <em className="sb-unused">Not used by any page</em>}</div>)}</section>}
    {nothing && <p className="hint">{files === null ? "Searching…" : "Nothing found."}</p>}
  </div>;
}
