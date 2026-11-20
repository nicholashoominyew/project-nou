import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { colours } from "./palette";
import { CATEGORIES, hm, type Activity, type Variant } from "./schedule";

export interface EditorState { isNew: boolean; days: number[]; start: number; end: number; acts: string[] }
const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const startOptions = Array.from({ length: 48 }, (_, i) => i);
const endOptions = Array.from({ length: 48 }, (_, i) => i + 1);

/** Why the block cannot be saved yet, or "" when it can. Used for the inline message and to disable Save. */
export function editorError(s: EditorState): string {
  if (s.end <= s.start) return "End time must be after the start.";
  if (!s.days.length) return "Pick at least one day.";
  if (!s.acts.length) return "Pick at least one activity.";
  return "";
}

/** The block editor: times in half-hour steps, days, and activities. Esc and the backdrop close it, focus stays inside while it is open. */
export default function BlockEditor({ initial, variant, activities, serverError, onSave, onClear, onCancel }: { initial: EditorState; variant: Variant; activities: Activity[]; serverError?: string; onSave: (s: EditorState) => void; onClear?: (s: EditorState) => void; onCancel: () => void }) {
  const [s, setS] = useState(initial);
  const box = useRef<HTMLDivElement>(null);
  const error = editorError(s);
  const title = (s.isNew ? "Add block" : "Edit block") + " · Week " + variant;
  useEffect(() => { box.current?.querySelector<HTMLElement>("select")?.focus(); }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onCancel(); return; }
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]),select,input,[href],[tabindex]:not([tabindex='-1'])")].filter(x => !x.hasAttribute("disabled"));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || !box.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !box.current.contains(active))) { e.preventDefault(); first.focus(); }
  };
  const note = s.acts.length > 1 ? `${s.acts.length} SELECTED · TIME SPLIT EQUALLY` : s.acts.length === 1 ? "1 SELECTED" : "PICK ONE OR MORE";
  const groups = CATEGORIES.map(c => ({ c, list: activities.filter(a => a.category === c) })).filter(g => g.list.length);
  return createPortal(<div className="tt-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
    <div ref={box} className="tt-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
      <div className="tt-dialog-head">
        <h2>{title}</h2>
        <button type="button" className="tt-icon-btn" aria-label="Close editor" onClick={onCancel}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
      </div>
      <div className="tt-times">
        <label>START
          <select value={s.start} onChange={e => { const v = Number(e.target.value); setS({ ...s, start: v, end: Math.max(s.end, v + 1) }); }}>{startOptions.map(v => <option key={v} value={v}>{hm(v * 30)}</option>)}</select>
        </label>
        <label>END
          <select value={s.end} onChange={e => setS({ ...s, end: Number(e.target.value) })}>{endOptions.map(v => <option key={v} value={v}>{hm(v * 30)}</option>)}</select>
        </label>
      </div>
      <fieldset className="tt-fieldset"><legend>DAYS</legend>
        <div className="tt-wrap">{DAY_SHORT.map((d, i) => { const on = s.days.includes(i); return <button key={d} type="button" className={"tt-toggle" + (on ? " on" : "")} aria-pressed={on} onClick={() => setS({ ...s, days: on ? s.days.filter(x => x !== i) : [...s.days, i].sort() })}>{d}</button>; })}</div>
      </fieldset>
      <fieldset className="tt-fieldset"><legend>ACTIVITIES · {note}</legend>
        {groups.map(g => <div key={g.c} className="tt-group"><span className="tt-group-name">{g.c}</span>
          <div className="tt-wrap">{g.list.map(a => { const on = s.acts.includes(a.id); const c = colours(a); return <button key={a.id} type="button" className={"tt-pill" + (on ? " on" : "")} aria-pressed={on} style={on ? { background: c.fill, color: c.ink, borderColor: c.fill } : undefined} onClick={() => setS({ ...s, acts: on ? s.acts.filter(x => x !== a.id) : [...s.acts, a.id] })}>{a.name}</button>; })}</div>
        </div>)}
      </fieldset>
      {(error || serverError) && <span role="alert" className="tt-error">{error || serverError}</span>}
      <div className="tt-dialog-foot">
        {onClear && !s.isNew && <button type="button" className="tt-text-btn" onClick={() => onClear(s)}>Clear to free time</button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="tt-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="tt-btn primary" disabled={!!error} aria-disabled={!!error} onClick={() => { if (!error) onSave(s); }}>Save</button>
      </div>
    </div>
  </div>, document.body);
}
