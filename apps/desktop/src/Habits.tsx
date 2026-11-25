import { useEffect, useMemo, useRef, useState } from "react";
import HabitCharts from "./HabitCharts";
import { announceHabits, habitsApi, type ImportRow } from "./habitsApi";
import HabitDetail from "./HabitDetail";
import { pushUndo } from "./undo";
import { GRIP, useReorder } from "./Reorder";
import { addDays, HABIT_TYPES, indexLog, logKey, localDay, maskHas, maskLabel, maskToggle, monthGrid, parseDay, progressOn, appliesOn, WEEKDAYS, slotRange, type CheckinEvent, type Habit, type LogMap, type LogState } from "./habitsLogic";
import { useHabits } from "./useHabits";

const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
const WORD: Record<string, string> = { done: "done", skipped: "skipped", no_answer: "no answer" };
const GLYPH: Record<string, string> = { done: "✓", skipped: "–", no_answer: "?" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayLabel = (day: string) => parseDay(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
/** The next state when a cell is clicked: empty or no answer becomes done; done (or an older skip) clears. */
export const nextState = (s: LogState | undefined): "done" | null => (s === "done" || s === "skipped" ? null : "done");

/** One habit on one day: a button that shows done, skipped, no answer or empty, and changes by clicking. */
function Cell({ habit, day, log, today, disabled, onSet }: { habit: Habit; day: string; log: LogMap; today: string; disabled?: boolean; onSet: (day: string, habit: Habit, state: "done" | null) => void }) {
  const entry = log.get(logKey(day, habit.id));
  const counts = appliesOn(habit, day);
  const state = entry?.state;
  const words = state ? WORD[state] + (entry?.source === "popup" ? " (pop-up)" : entry?.source === "timeout" ? " (no answer in 2 hours)" : entry?.source === "import" ? " (imported)" : "") : counts ? "empty" : "not a day for this habit";
  return <button type="button" className={"hb-cell" + (state ? " " + state : "") + (!counts && !state ? " off" : "")} disabled={disabled || day > today}
    aria-label={`${habit.name} on ${dayLabel(day)}: ${words}`} title={`${habit.name}, ${dayLabel(day)}: ${words}. Click to tick or clear it.`}
    onClick={() => onSet(day, habit, nextState(state))}>{state ? GLYPH[state] : ""}</button>;
}

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <span className="hb-progress" role="img" aria-label={total ? `${done} of ${total}, ${pct}%` : "no habits count this day"}><span className="hb-bar"><i style={{ width: pct + "%" }} /></span><span className="hb-pct">{total ? `${done}/${total} · ${pct}%` : "–"}</span></span>;
}

/**
 * The Habits page: tick today's habits, see the daily table and the month, manage habits, and look at the charts. A tick, a skip or no answer comes from a timetable
 * check-in pop-up or from here by hand, and any day can be changed later. It is meant as a better version of a table with one checkbox per habit per day.
 */
export default function Habits({ disabled }: { disabled?: boolean }) {
  const { habits, entries, log, pending, today, error, reload, setError } = useHabits();
  const [view, setView] = useState<"table" | "month">("table");
  const [rows, setRows] = useState(30);
  const [month, setMonth] = useState(() => { const d = parseDay(today); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [name, setName] = useState(""); const [mask, setMask] = useState(127); const [type, setType] = useState<string>("Health");
  const [open, setOpen] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const list = habits ?? [];
  const ids = useMemo(() => list.map(h => h.id), [list]);
  const reorder = useReorder(ids, order => void run(async () => { const was = ids; await habitsApi.reorder(order); pushUndo("Order of habits", async () => { await habitsApi.reorder(was); announceHabits(); }); }), disabled);

  async function run(job: () => Promise<unknown>, done?: string) {
    setError(""); setNotice("");
    try { await job(); if (done) setNotice(done); announceHabits(); await reload(); } catch (e) { setError(msg(e)); }
  }
  const setCell = (day: string, habit: Habit, state: "done" | null) => {
    const before = log.get(logKey(day, habit.id))?.state; const restore = before === "done" || before === "skipped" ? before : null; // "no answer" can only be written by a timed-out pop-up, so undo clears it
    void run(async () => { await habitsApi.set(day, habit.id, state); pushUndo(`${state ? "Ticked" : "Cleared"} ${habit.name} on ${dayLabel(day)}`, async () => { await habitsApi.set(day, habit.id, restore); announceHabits(); }); });
  };
  const answer = (ev: CheckinEvent) => void run(() => habitsApi.answer(ev.checkin_id, ev.day, "done"));
  const addHabit = () => void run(async () => {
    const made = await habitsApi.add(name, mask, type); setName(""); setMask(127);
    pushUndo(`New habit “${made.name}”`, async () => { await habitsApi.remove(made.id); announceHabits(); });
  }, "Habit added. It is now an activity in the Life Timetable.");
  const remove = (h: Habit) => { if (window.confirm(`Delete “${h.name}”?\n\nIt leaves this page and the timetable's check-ins (its blocks stay in the timetable as an ordinary activity). Its history is kept, and comes back if you add a habit with the same name again.`)) void run(() => habitsApi.remove(h.id), `“${h.name}” deleted.`); };
  const days = Array.from({ length: rows }, (_, i) => addDays(today, -i));
  const grid = monthGrid(month.y, month.m);
  const todays = list.filter(h => appliesOn(h, today));
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    await run(async () => {
      let data: unknown; try { data = JSON.parse(await f.text()); } catch { throw new Error("That file is not a habit history file (it should be JSON)."); }
      const rowsIn = Array.isArray(data) ? data : (data as { rows?: unknown })?.rows;
      if (!Array.isArray(rowsIn) || rowsIn.some(r => !r || typeof r.day !== "string" || typeof r.habit !== "string" || typeof r.done !== "boolean")) throw new Error("That file does not look like a habit history: each entry needs day, habit and done.");
      const out = await habitsApi.import(rowsIn as ImportRow[]);
      setNotice(`Imported ${out.entries_added} tick${out.entries_added === 1 ? "" : "s"} and ${out.habits_added} new habit${out.habits_added === 1 ? "" : "s"}. ${out.entries_kept} day${out.entries_kept === 1 ? "" : "s"} you had already logged were kept as they were.`);
    });
    if (file.current) file.current.value = "";
  };
  const dayPanel = picked && <section className="hb-card" aria-label={"Habits on " + dayLabel(picked)}>
    <h3>{dayLabel(picked)}</h3>
    <div className="hb-today">{list.filter(h => appliesOn(h, picked)).map(h => <div key={h.id} className="hb-today-row"><span>{h.name}</span><Cell habit={h} day={picked} log={log} today={today} disabled={disabled} onSet={setCell} /></div>)}</div>
    {!list.some(h => appliesOn(h, picked)) && <p className="hint">No habit counts on this day.</p>}
  </section>;

  return <div className="document hb-screen" aria-label="Habits">
    <header className="hb-head"><div><span className="tt-kicker-mono">NOU · 脳 · HABITS</span><h1 className="tt-title">Habits</h1></div>
      <div className="hb-head-tools"><input ref={file} type="file" accept="application/json,.json" hidden onChange={e => void importFile(e.target.files?.[0])} />
        <button type="button" className="tt-btn" disabled={disabled} onClick={() => file.current?.click()} title="Bring in earlier days from a history file">Import history…</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}

    {!!pending.length && <section className="hb-card hb-waiting" aria-label="Waiting for your answer"><h2>Waiting for your answer</h2>
      {pending.map(ev => <div key={ev.checkin_id + ev.day} className="hb-wait-row"><span><strong>{ev.habit}</strong> <span className="hint">{ev.block ? ev.block + " · " : ""}{slotRange(ev.start_slot, ev.end_slot)}</span></span>
        <span><button type="button" className="tt-btn primary" disabled={disabled} onClick={() => answer(ev)}>Checked in</button></span></div>)}
    </section>}

    <section className="hb-card" aria-label="Today"><div className="hb-card-head"><h2>Today · {dayLabel(today)}</h2>{!!list.length && <Bar {...progressOn(list, log, today)} />}</div>
      {!list.length && habits !== null && <p className="hint">No habits yet. Add one below, such as Exercise, Anki or Reading.</p>}
      {habits === null && <p className="hint">Loading…</p>}
      <div className="hb-today">{todays.map(h => { const s = log.get(logKey(today, h.id))?.state; return <div key={h.id} className="hb-today-row"><button type="button" className="hb-name" onClick={() => setOpen(h.id)} title="Open this habit">{h.name}</button>
        <span className="hb-today-actions"><button type="button" className={"hb-tick" + (s === "done" ? " on" : "")} disabled={disabled} aria-pressed={s === "done"} aria-label={`${h.name}: done today`} onClick={() => setCell(today, h, s === "done" ? null : "done")}>{s === "done" ? "✓ Done" : "Tick"}</button>
          {s === "no_answer" && <span className="hint"> no answer to the pop-up</span>}</span></div>; })}</div>
      {!!list.length && !todays.length && <p className="hint">None of your habits count today.</p>}
    </section>

    <section className="hb-card" aria-label="History"><div className="hb-card-head"><h2>History</h2>
      <div role="group" aria-label="View" className="tt-seg-toggle"><button type="button" aria-pressed={view === "table"} className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Table</button><button type="button" aria-pressed={view === "month"} className={view === "month" ? "on" : ""} onClick={() => setView("month")}>Month</button></div></div>
      {view === "table" && <div className="hb-scroll"><table className="hb-table" aria-label="Daily habit table"><thead><tr><th>Day</th>{list.map(h => <th key={h.id} scope="col">{h.name}</th>)}<th>Progress</th></tr></thead>
        <tbody>{days.map(day => <tr key={day} className={day === today ? "today" : ""}><th scope="row">{dayLabel(day)}</th>{list.map(h => <td key={h.id}><Cell habit={h} day={day} log={log} today={today} disabled={disabled} onSet={setCell} /></td>)}<td><Bar {...progressOn(list, log, day)} /></td></tr>)}</tbody></table>
        <button type="button" className="tt-text-btn" onClick={() => setRows(r => r + 30)}>Show 30 more days</button></div>}
      {view === "month" && <div>
        <div className="hb-month-nav"><button type="button" className="tt-btn small" aria-label="Previous month" onClick={() => setMonth(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}>‹</button><strong>{MONTHS[month.m]} {month.y}</strong><button type="button" className="tt-btn small" aria-label="Next month" onClick={() => setMonth(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}>›</button></div>
        <div className="hb-month" role="grid" aria-label={`${MONTHS[month.m]} ${month.y}`}>{WEEKDAYS.map(d => <div key={d} className="hb-month-head" role="columnheader">{d}</div>)}
          {grid.flat().map(c => { const p = progressOn(list, log, c.day); return <button key={c.day} type="button" role="gridcell" className={"hb-day" + (c.inMonth ? "" : " out") + (c.day === today ? " today" : "") + (picked === c.day ? " picked" : "")} disabled={c.day > today} aria-label={`${dayLabel(c.day)}: ${p.total ? `${p.done} of ${p.total} done` : "no habits count"}`} onClick={() => setPicked(c.day)}>
            <span>{parseDay(c.day).getDate()}</span>{p.total > 0 && <span className="hb-day-bar"><i style={{ height: (p.pct ?? 0) + "%" }} /></span>}{p.total > 0 && <small>{p.done}/{p.total}</small>}</button>; })}</div>
        {dayPanel}</div>}
    </section>

    <HabitCharts habits={list} entries={entries} log={log} today={today} />

    <section className="hb-card" aria-label="Manage habits"><h2>Your habits</h2>
      {!list.length && <p className="hint">Nothing here yet.</p>}
      <ul className="hb-manage" aria-label="Habits">{list.map(h => <li key={h.id} {...reorder.rowProps(h.id)}>
        <button {...reorder.gripProps(h.id, h.name)}>{GRIP}</button>
        <button type="button" className="hb-name" onClick={() => setOpen(h.id)} aria-label={`Open ${h.name}`}><strong>{h.name}</strong></button>
        <span className="chip">{h.category}</span>
        <span className="hint"> {maskLabel(h.days)} · from {dayLabel(localDay(new Date(h.created_at)))}</span></li>)}</ul>
      <form className="hb-add" aria-label="Add a habit" onSubmit={e => { e.preventDefault(); if (name.trim()) addHabit(); }}>
        <label>New habit<input aria-label="New habit name" value={name} maxLength={60} placeholder="For example: Reading" onChange={e => setName(e.target.value)} /></label>
        <label>Type<select aria-label="Type of the new habit" value={type} onChange={e => setType(e.target.value)}>{HABIT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <span className="hb-days" role="group" aria-label="Days for the new habit">{WEEKDAYS.map((d, i) => <button key={d} type="button" className={"tt-toggle" + (maskHas(mask, i) ? " on" : "")} aria-pressed={maskHas(mask, i)} onClick={() => { const next = maskToggle(mask, i); if (next > 0) setMask(next); }}>{d}</button>)}</span>
        <button type="submit" className="tt-btn primary" disabled={disabled || !name.trim()}>Add habit</button></form>
      <p className="hint">Drag the six dots to put your habits in order. Click a habit to see its streaks, rename it or change its type and days. Every habit is also an activity in the Life Timetable: put it on a block there, and its check-in pop-up comes when that block starts.</p>
    </section>
    {open && (() => { const h = list.find(x => x.id === open); return h ? <HabitDetail habit={h} log={log} today={today} disabled={disabled} onClose={() => setOpen(null)}
      onChange={patch => void run(async () => { const was = { name: h.name, days: h.days, category: h.category }; await habitsApi.update(h.id, patch); pushUndo(`Change to habit “${h.name}”`, async () => { await habitsApi.update(h.id, was); announceHabits(); }); })} onDelete={() => { remove(h); setOpen(null); }} /> : null; })()}
  </div>;
}
void indexLog;
