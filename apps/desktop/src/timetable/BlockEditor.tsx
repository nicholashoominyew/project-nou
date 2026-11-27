import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { colours } from "./palette";
import { CATEGORIES, fmtDuration, hm, SLOT_MINUTES, SLOTS_PER_DAY, type Activity, type Category, type Variant } from "./schedule";

/** `from` is the block being edited as it stood: slots it covered that the saved block no longer covers are emptied, so shrinking or moving a block really does that. */
export interface EditorState { isNew: boolean; days: number[]; start: number; end: number; acts: string[]; from?: { day: number; start: number; end: number; ids: string[] } }
const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const startOptions = Array.from({ length: SLOTS_PER_DAY }, (_, i) => i);
const endOptions = Array.from({ length: SLOTS_PER_DAY }, (_, i) => i + 1);

/** Why the block cannot be saved yet, or "" when it can. Used for the inline message and to disable Save. */
export function editorError(s: EditorState): string {
  if (s.end <= s.start) return "End time must be after the start.";
  if (!s.days.length) return "Pick at least one day.";
  if (!s.acts.length) return "Pick at least one activity.";
  return "";
}

/** The block editor: times in 10-minute steps, days, and activities. Esc and the backdrop close it, focus stays inside while it is open. */
export default function BlockEditor({ initial, variant, activities, usedBy, serverError, onSave, onClear, onCancel, onAddActivity, onDeleteActivity }: { initial: EditorState; variant: Variant; activities: Activity[]; usedBy: (id: string) => number; serverError?: string; onSave: (s: EditorState) => void; onClear?: (s: EditorState) => void; onCancel: () => void; onAddActivity: (name: string, category: Category) => Promise<Activity>; onDeleteActivity: (id: string, reassignTo: string | null) => Promise<void> }) {
  const [s, setS] = useState(initial);
  const box = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState({ name: "", category: "Leisure" as Category });
  const [removing, setRemoving] = useState(false);
  const [doomed, setDoomed] = useState<{ id: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState("");
  const change = async (job: () => Promise<void>) => {
    setBusy(true); setListError("");
    try { await job(); } catch (e) { setListError(String(e instanceof Error ? e.message : e).replace(/^Error: /, "")); } finally { setBusy(false); }
  };
  /** Make a new activity of the chosen type and put it on this block. */
  const addNew = () => {
    const name = adding.name.trim();
    if (!name || busy) return;
    void change(async () => { const made = await onAddActivity(name, adding.category); setS(old => ({ ...old, acts: [...old.acts, made.id] })); setAdding(a => ({ ...a, name: "" })); });
  };
  const askDelete = (id: string) => setDoomed({ id, to: usedBy(id) ? activities.find(a => a.id !== id && a.name.toLowerCase() === "free time")?.id ?? "" : "" });
  const reallyDelete = () => {
    if (!doomed) return;
    const { id, to } = doomed;
    void change(async () => {
      await onDeleteActivity(id, to || null);
      const gone = (ids: string[]) => ids.filter(x => x !== id);
      setS(old => ({ ...old, acts: gone(old.acts), from: old.from ? { ...old.from, ids: gone(old.from.ids) } : undefined }));
      setDoomed(null);
    });
  };
  const target = doomed ? activities.find(a => a.id === doomed.id) : undefined;
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
  // Habits come first, in their own section; every other activity is under its category.
  const habitList = activities.filter(a => a.habit_id);
  const groups = [...(habitList.length ? [{ c: "Habits", list: habitList }] : []), ...CATEGORIES.map(c => ({ c: c as string, list: activities.filter(a => !a.habit_id && a.category === c) })).filter(g => g.list.length)];
  return createPortal(<div className="tt-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
    <div ref={box} className="tt-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
      <div className="tt-dialog-head">
        <h2>{title}</h2>
        <button type="button" className="tt-icon-btn" aria-label="Close editor" onClick={onCancel}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
      </div>
      <div className="tt-times">
        <label>START
          <select value={s.start} onChange={e => { const v = Number(e.target.value); setS({ ...s, start: v, end: Math.max(s.end, v + 1) }); }}>{startOptions.map(v => <option key={v} value={v}>{hm(v * SLOT_MINUTES)}</option>)}</select>
        </label>
        <label>END
          <select value={s.end} onChange={e => setS({ ...s, end: Number(e.target.value) })}>{endOptions.map(v => <option key={v} value={v}>{hm(v * SLOT_MINUTES)}</option>)}</select>
        </label>
      </div>
      <fieldset className="tt-fieldset"><legend>DAYS</legend>
        <div className="tt-wrap">{DAY_SHORT.map((d, i) => { const on = s.days.includes(i); return <button key={d} type="button" className={"tt-toggle" + (on ? " on" : "")} aria-pressed={on} onClick={() => setS({ ...s, days: on ? s.days.filter(x => x !== i) : [...s.days, i].sort() })}>{d}</button>; })}</div>
      </fieldset>
      <fieldset className="tt-fieldset"><legend>ACTIVITIES · {note}</legend>
        {groups.map(g => <div key={g.c} className="tt-group"><span className="tt-group-name">{g.c}</span>
          <div className="tt-wrap">{g.list.map(a => { const on = s.acts.includes(a.id); const c = colours(a);
            if (removing) return <button key={a.id} type="button" className="tt-pill tt-pill-remove" disabled={busy || !!a.habit_id} title={a.habit_id ? "A habit: delete it on the Habits page" : undefined} aria-label={"Delete " + a.name + " from the list"} onClick={() => askDelete(a.id)}>{a.name}{!a.habit_id && <span aria-hidden="true"> ×</span>}</button>;
            return <button key={a.id} type="button" className={"tt-pill" + (on ? " on" : "")} aria-pressed={on} style={on ? { background: c.fill, color: c.ink, borderColor: c.fill } : undefined} onClick={() => setS({ ...s, acts: on ? s.acts.filter(x => x !== a.id) : [...s.acts, a.id] })}>{a.name}</button>; })}</div>
        </div>)}
        {target && doomed && <div className="tt-confirm" role="group" aria-label={"Delete " + target.name}>
          {usedBy(target.id) > 0
            ? <label>“{target.name}” is on the timetable for {fmtDuration(usedBy(target.id) * SLOT_MINUTES)}. Give that time to <select aria-label="Give its time to" value={doomed.to} onChange={e => setDoomed({ id: doomed.id, to: e.target.value })}><option value="">Choose…</option>{activities.filter(a => a.id !== target.id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            : <span>Delete “{target.name}”? It is not on the timetable.</span>}
          <button type="button" className="tt-btn danger" disabled={busy || (usedBy(target.id) > 0 && !doomed.to)} onClick={reallyDelete}>Delete {target.name}</button>
          <button type="button" className="tt-btn" onClick={() => setDoomed(null)}>Keep</button>
        </div>}
        <div className="tt-newact">
          <input aria-label="New activity name" placeholder="New activity" value={adding.name} maxLength={60} onChange={e => setAdding({ ...adding, name: e.target.value })} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addNew(); } }} />
          <select aria-label="Type of the new activity" value={adding.category} onChange={e => setAdding({ ...adding, category: e.target.value as Category })}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
          <button type="button" className="tt-btn" disabled={busy || !adding.name.trim()} onClick={addNew}>Add to list</button>
          <button type="button" className="tt-text-btn" aria-pressed={removing} onClick={() => { setRemoving(r => !r); setDoomed(null); setListError(""); }}>{removing ? "Done removing" : "Remove from list"}</button>
        </div>
        {listError && <span role="alert" className="tt-error">{listError}</span>}
        {habitList.length > 0 && <p className="tt-checkin-note">A habit on a block gets a check-in pop-up when the block starts. It stays up for the whole block until you tick it. Add or manage habits on the Habits page.</p>}
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
