import { useEffect, useRef, useState } from "react";
import { BLOCKS, filled, wordCount, type BlockId, type Journal } from "./logic";

export type SaveState = "saved" | "saving" | "failed";

/**
 * Saves the journal as it is typed: one write at a time, always ending on the latest text. Nothing waits on a timer, so leaving the page cannot drop words.
 */
export function useJournal(day: string, initial: Journal, save: (day: string, j: Journal) => Promise<void>, onState: (s: SaveState) => void) {
  const [journal, setJournal] = useState(initial);
  const [state, setState] = useState<SaveState>("saved");
  const latest = useRef(initial), dirty = useRef(false), busy = useRef(false);
  const report = (s: SaveState) => { setState(s); onState(s); };
  const flush = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (dirty.current) { dirty.current = false; await save(day, latest.current); }
      report("saved");
    } catch { dirty.current = true; report("failed"); }
    finally { busy.current = false; }
  };
  const change = (next: Journal) => { latest.current = next; dirty.current = true; setJournal(next); report("saving"); void flush(); };
  return { journal, state, change, retry: () => { report("saving"); void flush(); } };
}

export default function JournalCard({ journal, state, change, retry, readOnly, focused, onFocusMode }: {
  journal: Journal; state: SaveState; change: (j: Journal) => void; retry: () => void; readOnly: boolean; focused: boolean; onFocusMode: (on: boolean) => void;
}) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [want, setWant] = useState<string | null>(null);
  useEffect(() => { if (want) { inputs.current.get(want)?.focus(); setWant(null); } }, [want]);
  const setLines = (id: BlockId, lines: string[]) => change({ ...journal, [id]: lines });
  const addLine = (id: BlockId, after = journal[id].length - 1) => {
    const lines = [...journal[id]]; lines.splice(after + 1, 0, ""); setLines(id, lines); setWant(`${id}:${after + 1}`);
  };
  const goals = filled(journal.goals);
  const label = state === "saving" ? "SAVING…" : state === "failed" ? "NOT SAVED" : "SAVED ON THIS DEVICE";

  return <section className="dy-journal" aria-label="Journal">
    <div className="dy-journal-head">
      <div><h2>Journal</h2><div className="dy-mono">TEMPLATE · {BLOCKS.length} BLOCKS</div></div>
      <button type="button" className={"dy-focus-btn" + (focused ? " on" : "")} aria-pressed={focused} onClick={() => onFocusMode(!focused)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>{focused ? "Exit focus" : "Focus"}</button>
    </div>
    <div className="dy-blocks">
      {BLOCKS.map(b => <div key={b.id} className="dy-block">
        <div className="dy-block-head"><h3>{b.title}</h3>
          {b.id === "goals" && <span className={"dy-tag" + (goals >= 3 ? " on" : "")}>MIN 3 · {Math.min(goals, 3)}/3</span>}
          {b.id === "learn" && <span className="dy-tag">EOD</span>}</div>
        {journal[b.id].map((text, i) => <div key={i} className="dy-line"><i aria-hidden="true" />
          <input ref={el => { if (el) inputs.current.set(`${b.id}:${i}`, el); else inputs.current.delete(`${b.id}:${i}`); }} value={text} readOnly={readOnly} placeholder="List" maxLength={2000}
            aria-label={`${b.title}, line ${i + 1}`}
            onChange={e => setLines(b.id, journal[b.id].map((l, n) => (n === i ? e.target.value : l)))}
            onKeyDown={e => {
              if (readOnly || e.nativeEvent.isComposing) return;
              if (e.key === "Enter") { e.preventDefault(); addLine(b.id, i); }
              else if (e.key === "Backspace" && !text && journal[b.id].length > 1) { e.preventDefault(); setLines(b.id, journal[b.id].filter((_, n) => n !== i)); setWant(`${b.id}:${Math.max(0, i - 1)}`); }
            }} /></div>)}
        <button type="button" className="dy-add" disabled={readOnly} aria-label={"Add a line to " + b.title} onClick={() => addLine(b.id)}>+ Add line</button>
      </div>)}
    </div>
    <div className="dy-journal-foot dy-mono"><span>WORDS {wordCount(journal)}</span>
      <span role="status">{label}{state === "failed" && <button type="button" className="dy-retry" onClick={retry}>Try again</button>}</span></div>
  </section>;
}
