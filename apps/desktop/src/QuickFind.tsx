import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icons";
import type { PageInfo } from "./EditorContext";

type Hit = { id: string; title: string };

/** Ctrl+P page switcher: instant title matches first, then note-body matches from the local search index. */
export default function QuickFind({ pages, onOpen, onClose }: { pages: PageInfo[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [bodyHits, setBodyHits] = useState<Hit[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const needle = query.trim().toLowerCase();

  const results = useMemo(() => {
    const byTitle = (needle ? pages.filter(p => p.title.toLowerCase().includes(needle)) : pages).slice(0, 50);
    const seen = new Set(byTitle.map(p => p.id));
    const byBody = bodyHits.filter(h => !seen.has(h.id)).map(h => pages.find(p => p.id === h.id)).filter((p): p is PageInfo => !!p);
    return [...byTitle, ...byBody];
  }, [pages, needle, bodyHits]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [needle]);
  useEffect(() => {
    setBodyHits([]);
    if (!needle) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<Hit[]>("search_notes", { query: query.trim() })
        .then(hits => { if (!cancelled && Array.isArray(hits)) setBodyHits(hits); })
        .catch(() => undefined);
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [needle]);
  useEffect(() => {
    (list.current?.children[index] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing) return; // never steal Enter/arrows from IME candidate selection
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setIndex(i => Math.min(i + 1, Math.max(results.length - 1, 0))); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const page = results[index]; if (page) onOpen(page.id); }
  }

  return <div className="quick-find-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="quick-find" role="dialog" aria-modal="true" aria-label="Quick find">
      <input ref={input} aria-label="Find a page" placeholder="Jump to a page…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown}
        role="combobox" aria-expanded="true" aria-controls="quick-find-results" aria-activedescendant={results[index] ? "quick-find-" + results[index].id : undefined} />
      <ul id="quick-find-results" role="listbox" aria-label="Pages" ref={list}>
        {results.map((page, i) => <li key={page.id} id={"quick-find-" + page.id} role="option" aria-selected={i === index} className={i === index ? "selected" : ""}
          onMouseMove={() => setIndex(i)} onMouseDown={event => { event.preventDefault(); onOpen(page.id); }}>
          <Icon name={page.icon} size={16} /><span>{page.title}</span>
        </li>)}
        {!results.length && <li className="quick-find-empty" role="presentation">No matching pages</li>}
      </ul>
      <p className="quick-find-help">↑↓ choose · Enter open · Esc close · Ctrl+Q find · Ctrl+\ sidebar · Ctrl+P print · Ctrl+N new page · Ctrl+W close tab · Ctrl+Tab next tab · F11 full screen · Ctrl+Z undo</p>
    </div>
  </div>;
}
