import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "./Dismissible";
import { searchPlaces, type FoundPlace } from "./geocode";

type State = { status: "loading" } | { status: "done"; items: FoundPlace[] } | { status: "error"; message: string };

/** Results of one online place search, shown under the field it came from. Picking a result returns the place. */
export function PlaceResults({ query, anchor, onPick, onClose }: { query: string; anchor: HTMLElement | null; onPick: (place: FoundPlace) => void; onClose: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    setState({ status: "loading" });
    searchPlaces(query, controller.signal)
      .then(items => setState({ status: "done", items }))
      .catch(() => { if (!controller.signal.aborted || timer) setState({ status: "error", message: controller.signal.aborted ? "The place search took too long. Check your internet connection." : "Could not reach the place search. Are you offline?" }); })
      .finally(() => window.clearTimeout(timer));
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  const rect = anchor?.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 348));
  const top = rect ? Math.min(rect.bottom + 4, window.innerHeight - 280) : 80;
  return createPortal(<div className="db-menu db-place-results" role="listbox" aria-label="Place results" ref={ref} style={{ left, top }}>
    {state.status === "loading" && <p className="hint">Searching OpenStreetMap…</p>}
    {state.status === "error" && <p className="hint" role="alert">{state.message}</p>}
    {state.status === "done" && !state.items.length && <p className="hint">No places found for “{query}”.</p>}
    {state.status === "done" && state.items.map((p, i) => <button key={i} role="option" aria-selected={false} onClick={() => onPick(p)}>
      <strong>{p.name}</strong><span className="hint">{p.address}</span></button>)}
    <p className="hint db-place-note">Results from OpenStreetMap. Your search text was sent to nominatim.openstreetmap.org.</p>
  </div>, document.body);
}

/** A search box that finds a place by name or address when Enter is pressed (nothing is sent before that). */
export function PlaceSearchBox({ onPick, disabled, placeholder = "Search for a place or address…" }: { onPick: (place: FoundPlace) => void; disabled?: boolean; placeholder?: string }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  return <div className="db-place-search">
    <input ref={box} type="search" aria-label="Search for a place" placeholder={placeholder} value={text} disabled={disabled}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter" && text.trim().length >= 2) { e.preventDefault(); setQuery(text.trim()); } else if (e.key === "Escape") setQuery(null); }} />
    <button disabled={disabled || text.trim().length < 2} onClick={() => setQuery(text.trim())}>Search</button>
    {query !== null && <PlaceResults query={query} anchor={box.current} onClose={() => setQuery(null)} onPick={p => { setQuery(null); setText(""); onPick(p); }} />}
  </div>;
}
