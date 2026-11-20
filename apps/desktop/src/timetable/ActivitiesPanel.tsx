import { useState } from "react";
import { CATEGORIES, type Activity, type Category } from "./schedule";
import { addActivity, deleteActivity, updateActivity } from "./useTimetable";

/** The activities manager: add, rename, recolour, change category, toggle reminders, and delete (a used activity needs another to take its slots). */
export default function ActivitiesPanel({ activities, usedBy, disabled, run }: { activities: Activity[]; usedBy: (id: string) => number; disabled: boolean; run: (job: () => Promise<unknown>) => Promise<void> }) {
  const [adding, setAdding] = useState({ name: "", category: "Training" as Category });
  const [deleting, setDeleting] = useState<{ id: string; to: string } | null>(null);
  const edit = (a: Activity, patch: Partial<Pick<Activity, "name" | "category" | "colour" | "remind">>) => run(() => updateActivity({ id: a.id, name: a.name, category: a.category, colour: a.colour, remind: a.remind, ...patch }));
  return <section className="tt-card tt-acts" aria-label="Activities">
    <h2>Activities</h2>
    <ul>
      {activities.map(a => <li key={a.id} className="tt-act">
        <input aria-label={"Name of " + a.name} defaultValue={a.name} disabled={disabled} onBlur={e => { const v = e.target.value.trim(); if (v && v !== a.name) void edit(a, { name: v }); else e.target.value = a.name; }} />
        <select aria-label={"Category of " + a.name} value={a.category} disabled={disabled} onChange={e => void edit(a, { category: e.target.value as Category })}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        <input type="color" aria-label={"Colour of " + a.name} value={a.colour ?? "#1f4fd8"} disabled={disabled} onChange={e => void edit(a, { colour: e.target.value })} />
        {a.colour && <button type="button" className="tt-text-btn" disabled={disabled} onClick={() => void edit(a, { colour: null })}>Reset colour</button>}
        <label className="tt-check"><input type="checkbox" checked={a.remind} disabled={disabled} onChange={e => void edit(a, { remind: e.target.checked })} /> Remind</label>
        {deleting?.id === a.id
          ? <span className="tt-del">{usedBy(a.id) > 0 && <label>Move its {usedBy(a.id)} slots to <select aria-label="Reassign slots to" value={deleting.to} onChange={e => setDeleting({ id: a.id, to: e.target.value })}><option value="">Choose…</option>{activities.filter(o => o.id !== a.id).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
            <button type="button" className="tt-btn danger" disabled={disabled || (usedBy(a.id) > 0 && !deleting.to)} onClick={() => void run(() => deleteActivity(a.id, deleting.to || null)).then(() => setDeleting(null))}>Delete {a.name}</button>
            <button type="button" className="tt-btn" onClick={() => setDeleting(null)}>Cancel</button></span>
          : <button type="button" className="tt-btn danger" disabled={disabled} aria-label={"Delete " + a.name} onClick={() => setDeleting({ id: a.id, to: "" })}>Delete</button>}
      </li>)}
    </ul>
    <form className="tt-add" onSubmit={e => { e.preventDefault(); if (!adding.name.trim()) return; void run(() => addActivity(adding.name.trim(), adding.category)).then(() => setAdding({ ...adding, name: "" })); }}>
      <input aria-label="New activity name" placeholder="New activity" value={adding.name} disabled={disabled} onChange={e => setAdding({ ...adding, name: e.target.value })} />
      <select aria-label="New activity category" value={adding.category} onChange={e => setAdding({ ...adding, category: e.target.value as Category })}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
      <button type="submit" className="tt-btn primary" disabled={disabled || !adding.name.trim()}>Add activity</button>
    </form>
  </section>;
}
