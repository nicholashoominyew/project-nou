import { useMemo, useRef, useState } from "react";
import HabitDetail from "./HabitDetail";
import { announceHabits, habitsApi, type ImportRow } from "./habitsApi";
import { addDays, appliesOn, habitRate, HABIT_TYPES, heatCells, heatLayout, logKey, maskLabel, monthGrid, parseDay, progressOn, rangeStats, streaks, WEEKDAYS, weekBlocks, type Habit, type LogState } from "./habitsLogic";
import { GRIP, useReorder } from "./Reorder";
import { pushUndo } from "./undo";
import { useHabits } from "./useHabits";

const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayLabel = (day: string) => parseDay(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const pct = (v: number | null) => (v === null ? "–" : Math.round(v * 100) + "%");
/** The next state when a day is clicked: empty or no answer becomes done; done (or an older skip) clears. A day not done by its end simply counts as not done. */
export const nextState = (s: LogState | undefined): "done" | null => (s === "done" || s === "skipped" ? null : "done");
const Check = ({ size, stroke = 2.6, className }: { size: number; stroke?: number; className?: string }) => <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>;
const Chips = ({ mask, label, disabled, onToggle }: { mask: number; label: string; disabled?: boolean; onToggle: (i: number) => void }) =>
  <div className="hx-chips" role="group" aria-label={label}>{WEEKDAYS.map((d, i) => { const on = (mask & (1 << i)) !== 0; return <button key={d} type="button" className={"hx-chip" + (on ? " on" : "")} aria-pressed={on} aria-label={d.toUpperCase() + (on ? " on" : " off")} disabled={disabled} onClick={() => onToggle(i)}>{d.toUpperCase()}</button>; })}</div>;

/**
 * The Habits page: today's ring and one circle per habit, streaks with a heatmap per habit, a collapsed history (table and month, where any past day can be ticked by hand),
 * and a collapsed list of habits to manage. A circle ticks or clears the day; anything not done by the end of the day counts as not done.
 */
export default function Habits({ disabled }: { disabled?: boolean }) {
  const { habits, log, today, error, reload, setError } = useHabits();
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const [sweep, setSweep] = useState(0); // flips every time the range changes so the heatmap sweep plays again
  const [focus, setFocus] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState(false); const [editOpen, setEditOpen] = useState(false);
  const [tab, setTab] = useState<"table" | "month">("table");
  const [extra, setExtra] = useState(0);
  const [month, setMonth] = useState(() => { const d = parseDay(today); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [name, setName] = useState(""); const [mask, setMask] = useState(127); const [type, setType] = useState<string>("Health");
  const [open, setOpen] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const list: Habit[] = habits ?? [];
  const ids = useMemo(() => list.map(h => h.id), [list]);

  async function run(job: () => Promise<unknown>, done?: string) {
    setError(""); setNotice("");
    try { await job(); if (done) setNotice(done); announceHabits(); await reload(); } catch (e) { setError(msg(e)); }
  }
  const reorder = useReorder(ids, order => void run(async () => { const was = ids; await habitsApi.reorder(order); pushUndo("Order of habits", async () => { await habitsApi.reorder(was); announceHabits(); }); }), disabled);
  const setCell = (day: string, habit: Habit, state: "done" | null) => {
    const before = log.get(logKey(day, habit.id))?.state; const restore = before === "done" || before === "skipped" ? before : null; // "no answer" is only written by a timed-out pop-up, so undo clears it
    void run(async () => { await habitsApi.set(day, habit.id, state); pushUndo(`${state ? "Ticked" : "Cleared"} ${habit.name} on ${dayLabel(day)}`, async () => { await habitsApi.set(day, habit.id, restore); announceHabits(); }); });
  };
  const toggle = (day: string, h: Habit) => setCell(day, h, nextState(log.get(logKey(day, h.id))?.state));
  const addHabit = () => void run(async () => {
    const made = await habitsApi.add(name, mask, type); setName(""); setMask(127);
    pushUndo(`New habit “${made.name}”`, async () => { await habitsApi.remove(made.id); announceHabits(); });
  }, "Habit added. It is now an activity in the Life Timetable.");
  const setDays = (h: Habit, i: number) => { const next = h.days ^ (1 << i); if (next === 0) return; const was = h.days; void run(async () => { await habitsApi.update(h.id, { days: next }); pushUndo(`Days of “${h.name}”`, async () => { await habitsApi.update(h.id, { days: was }); announceHabits(); }); }); };
  const remove = (h: Habit) => {
    if (!window.confirm(`Delete “${h.name}”?\n\nIt leaves this page and the timetable's check-ins (its blocks stay in the timetable as an ordinary activity).\n\nIts history is kept, and comes back if you add a habit with the same name again.`)) return;
    const was = { name: h.name, days: h.days, category: h.category, order: ids };
    void run(async () => { await habitsApi.remove(h.id); pushUndo(`Deleted habit “${h.name}”`, async () => { const back = await habitsApi.add(was.name, was.days, was.category); await habitsApi.reorder(was.order.map(x => (x === h.id ? back.id : x))); announceHabits(); }); }, `“${h.name}” deleted.`);
  };
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

  // ---- numbers ----
  const scheduled = list.filter(h => appliesOn(h, today));
  const doneToday = scheduled.filter(h => log.get(logKey(today, h.id))?.state === "done").length;
  const share = scheduled.length ? doneToday / scheduled.length : 0;
  const circ = 2 * Math.PI * 40;
  const stats = rangeStats(list, log, today, range);
  const weeks = weekBlocks(list, log, today, 8);
  const lay = heatLayout(range);
  const shown = Math.min(31 * 12, 14 + 30 * extra);
  const tableDays = Array.from({ length: shown }, (_, i) => addDays(today, -i));
  const grid = monthGrid(month.y, month.m);

  return <div className="hx" aria-label="Habits">
    <header className="hx-rise hx-head"><div><div className="hx-mono hx-crumb">NOU · <span className="hx-mark">脳</span> · HABITS</div><h1>Habits</h1></div>
      <div><input ref={file} type="file" accept="application/json,.json" hidden aria-label="Choose a habit history file" onChange={e => void importFile(e.target.files?.[0])} />
        <button type="button" className="hx-btn" disabled={disabled} onClick={() => file.current?.click()} title="Bring in earlier days from a history file">Import history…</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}

    <section className="hx-rise hx-card hx-today" style={{ animationDelay: "120ms" }} aria-label="Today">
      <div className="hx-today-left">
        <div className="hx-ring"><svg width="96" height="96" viewBox="0 0 96 96" fill="none" role="img" aria-label={`${doneToday} of ${scheduled.length} habits done today`}><circle cx="48" cy="48" r="40" stroke="var(--line)" strokeWidth="8" /><circle cx="48" cy="48" r="40" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(share * circ).toFixed(1)} ${circ.toFixed(1)}`} transform="rotate(-90 48 48)" className="hx-ring-arc" /></svg>
          <div className="hx-num hx-ring-num">{doneToday}/{scheduled.length}</div></div>
        <div className="hx-today-text"><span className="hx-mono">TODAY</span><span className="hx-today-date">{dayLabel(today)}</span>
          {scheduled.length > 0 && doneToday === scheduled.length && <span className="hx-mono hx-alldone"><span className="hx-dot hx-ping" />ALL DONE</span>}</div>
      </div>
      <div className="hx-circles">
        {habits === null && <span className="hint">Loading…</span>}
        {habits !== null && !list.length && <span className="hint">No habits yet. Add one under Your habits.</span>}
        {habits !== null && list.length > 0 && !scheduled.length && <span className="hint">None of your habits count today.</span>}
        {scheduled.map(h => { const on = log.get(logKey(today, h.id))?.state === "done";
          return <button key={h.id} type="button" className="hx-circle-btn" aria-pressed={on} aria-label={(on ? "Mark not done: " : "Mark done: ") + h.name} disabled={disabled} onClick={() => setCell(today, h, on ? null : "done")}>
            <span className={"hx-circle" + (on ? " on" : "")}>{on && <Check size={22} className="hx-pop" />}</span><span className={"hx-circle-name" + (on ? " on" : "")}>{h.name}</span></button>; })}
      </div>
    </section>

    <section className="hx-rise hx-card hx-streaks" style={{ animationDelay: "210ms" }} aria-label="Streaks">
      <div className="hx-row-between"><h2>Streaks</h2>
        <div className="hx-row"><div className="hx-mono">LAST {range} DAYS · TAP A HABIT TO FOCUS</div>
          <div className="hx-seg" role="group" aria-label="Range">{([7, 30, 90] as const).map(v => <button key={v} type="button" className={range === v ? "on" : ""} aria-pressed={range === v} onClick={() => { setRange(v); setSweep(s => 1 - s); }}>{v}D</button>)}</div></div></div>
      <div className="hx-tiles">
        <div className="hx-tile hx-lift"><div className="hx-num hx-big">{pct(stats.completion)}</div><div className="hx-mono">COMPLETION · ALL HABITS</div></div>
        <div className="hx-tile hx-lift"><div className="hx-num hx-big">{stats.fullDays} / {range}</div><div className="hx-mono">FULL DAYS · EVERY HABIT</div></div>
        <div className="hx-tile hx-lift"><div className="hx-num hx-big">{stats.activeDays} / {range}</div><div className="hx-mono">DAYS WITH A TICK</div></div>
      </div>
      <div className="hx-weekly"><div className="hx-mono">WEEKLY COMPLETION · 8 WEEKS</div>
        <div className="hx-bars" role="img" aria-label={"Completion of the last 8 weeks: " + weeks.map(w => `${w.label} ${pct(w.pct)}`).join(", ")}>{weeks.map((w, i) => <div key={w.label} className="hx-bar-col"><span className="hx-bar-pct">{pct(w.pct)}</span>
          <span className={"hx-bar hx-gy" + (i === 7 ? " now" : "")} style={{ height: Math.max(3, Math.round((w.pct ?? 0) * 140)) + "px", animationDelay: i * 60 + "ms" }} /></div>)}</div>
        <div className="hx-bar-labels" aria-hidden="true">{weeks.map(w => <span key={w.label}>{w.label}</span>)}</div></div>
      <div className="hx-maps">
        {list.map((h, ri) => { const cells = heatCells(h, log, today, range), cols = Math.ceil(cells.length / lay.rows), focused = focus === h.id;
          return <button key={h.id} type="button" className={"hx-map" + (focused ? " focused" : "")} style={{ opacity: focus && !focused ? 0.3 : 1 }} aria-pressed={focused} onClick={() => setFocus(focused ? null : h.id)}>
            <span className="hx-map-text"><span className="hx-map-name">{h.name}</span><span className="hx-num hx-big">{pct(habitRate(h, log, today, range))}</span><span className="hx-mono">{streaks(h, log, today).current}D STREAK</span></span>
            <span className="hx-grid" style={{ gridTemplateRows: `repeat(${lay.rows}, ${lay.size}px)`, gridAutoColumns: lay.size + "px", gap: lay.gap }}>
              {cells.map((c, i) => { const col = Math.floor(i / lay.rows), row = i % lay.rows;
                const delay = Math.round((cols > 1 ? (col / (cols - 1)) * 600 + row * 15 : row * 90) + ri * 70);
                return <span key={i} className={"hx-cell " + c.state + (c.today ? " today" : "") + (c.state === "pad" ? "" : sweep ? " hx-pop2" : " hx-pop")} title={c.state === "pad" ? "" : `${dayLabel(c.day)} · ${c.state === "done" ? "done" : c.state === "off" ? "not a day for this habit" : "missed"}`} style={{ animationDelay: delay + "ms", borderRadius: lay.radius }} />; })}
            </span></button>; })}
      </div>
    </section>

    <section className="hx-rise hx-card hx-fold" style={{ animationDelay: "300ms" }} aria-label="History">
      <div className="hx-row-between"><button type="button" className="hx-fold-btn" aria-expanded={histOpen} onClick={() => setHistOpen(o => !o)}>History<span className="hx-mono">{histOpen ? "HIDE" : "SHOW"}</span></button>
        {histOpen && <div className="hx-seg" role="group" aria-label="View"><button type="button" className={tab === "table" ? "on" : ""} aria-pressed={tab === "table"} onClick={() => setTab("table")}>Table</button><button type="button" className={tab === "month" ? "on" : ""} aria-pressed={tab === "month"} onClick={() => setTab("month")}>Month</button></div>}</div>
      {histOpen && tab === "table" && <div className="hx-table-wrap">
        <div className="hx-trow hx-thead" role="row"><span className="hx-day-col">DAY</span>{list.map(h => <span key={h.id} className="hx-cellcol">{h.name}</span>)}<span className="hx-prog-col">PROGRESS</span></div>
        {tableDays.map(day => { const p = progressOn(list, log, day), isToday = day === today;
          return <div key={day} className={"hx-trow" + (isToday ? " today" : "")} role="row"><span className="hx-day-col"><b>{dayLabel(day)}</b></span>
            {list.map(h => { const s = log.get(logKey(day, h.id))?.state, on = s === "done";
              return <span key={h.id} className="hx-cellcol"><button type="button" className={"hx-tick" + (on ? " on" : "") + (s === "no_answer" ? " na" : "")} disabled={disabled} aria-pressed={on} aria-label={`${h.name} on ${dayLabel(day)}: ${on ? "done" : s === "no_answer" ? "no answer" : "not done"}`} title={s === "no_answer" ? "No answer to the pop-up. Click to mark it done." : "Click to tick or clear this day"} onClick={() => toggle(day, h)}>{on && <Check size={14} stroke={3} />}</button></span>; })}
            <span className="hx-prog-col"><span className="hx-track" role="img" aria-label={p.total ? `${p.done} of ${p.total}, ${Math.round((p.pct ?? 0))}%` : "no habits count this day"}><span style={{ width: (p.pct ?? 0) + "%" }} /></span><span className="hx-mono hx-frac">{p.total ? `${p.done}/${p.total} · ${p.pct}%` : "–"}</span></span></div>; })}
        {shown < 31 * 12 && <button type="button" className="hx-more" onClick={() => setExtra(e => e + 1)}>Show 30 more days</button>}
      </div>}
      {histOpen && tab === "month" && <div className="hx-month-wrap">
        <div className="hx-month-nav"><button type="button" className="hx-btn small" aria-label="Previous month" onClick={() => setMonth(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}>‹</button><strong>{MONTHS[month.m]} {month.y}</strong><button type="button" className="hx-btn small" aria-label="Next month" onClick={() => setMonth(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}>›</button></div>
        <div className="hx-month" role="grid" aria-label={`${MONTHS[month.m]} ${month.y}`}>{WEEKDAYS.map(d => <span key={d} className="hx-mono" role="columnheader">{d.toUpperCase()}</span>)}
          {grid.flat().map(c => { const future = c.day > today, p = progressOn(list, log, c.day);
            return c.inMonth ? <button key={c.day} type="button" role="gridcell" className={"hx-mcell" + (future ? " future" : "") + (c.day === today ? " today" : "") + (picked === c.day ? " picked" : "")} disabled={future} aria-label={`${dayLabel(c.day)}: ${p.total ? `${p.done} of ${p.total} done` : "no habits count"}`} onClick={() => setPicked(picked === c.day ? null : c.day)}>
              {!future && <span className="hx-mfill hx-gy" style={{ height: (p.pct ?? 0) + "%" }} />}<span className="hx-mday">{parseDay(c.day).getDate()}</span>{!future && p.total > 0 && <span className="hx-mono hx-mfrac">{p.done}/{p.total}</span>}</button> : <span key={c.day} role="gridcell" className="hx-mcell blank" aria-hidden="true" />; })}</div>
        {picked && <div className="hx-daypanel" role="group" aria-label={"Habits on " + dayLabel(picked)}><h3>{dayLabel(picked)}</h3>
          {list.filter(h => appliesOn(h, picked)).map(h => { const on = log.get(logKey(picked, h.id))?.state === "done";
            return <div key={h.id} className="hx-dayrow"><span>{h.name}</span><button type="button" className={"hx-tick" + (on ? " on" : "")} disabled={disabled} aria-pressed={on} aria-label={`${h.name} on ${dayLabel(picked)}: ${on ? "done" : "not done"}`} onClick={() => toggle(picked, h)}>{on && <Check size={14} stroke={3} />}</button></div>; })}
          {!list.some(h => appliesOn(h, picked)) && <p className="hint">No habit counts on this day.</p>}</div>}
      </div>}
    </section>

    <section className="hx-rise hx-card hx-fold" style={{ animationDelay: "480ms" }} aria-label="Manage habits">
      <button type="button" className="hx-fold-btn" aria-expanded={editOpen} onClick={() => setEditOpen(o => !o)}>Your habits<span className="hx-mono">{editOpen ? "CLOSE" : "EDIT"}</span></button>
      {editOpen && <>
        <ul className="hx-manage" aria-label="Habits">{list.map(h => <li key={h.id} {...reorder.rowProps(h.id)} className={"hx-manage-row hx-lift " + reorder.rowProps(h.id).className}>
          <button {...reorder.gripProps(h.id, h.name)}>{GRIP}</button>
          <div className="hx-manage-name"><button type="button" className="hx-name" onClick={() => setOpen(h.id)} aria-label={`Open ${h.name}`}>{h.name}</button><div className="hx-mono">{h.category} · {maskLabel(h.days)}</div></div>
          <Chips mask={h.days} label={`Days for ${h.name}`} disabled={disabled} onToggle={i => setDays(h, i)} />
          <button type="button" className="hx-x" disabled={disabled} aria-label={`Delete ${h.name}`} onClick={() => remove(h)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button></li>)}</ul>
        <form className="hx-new" aria-label="Add a habit" onSubmit={e => { e.preventDefault(); if (name.trim()) addHabit(); }}>
          <label htmlFor="hx-newhabit" className="hx-mono">NEW HABIT</label>
          <div className="hx-new-row"><input id="hx-newhabit" aria-label="New habit name" value={name} maxLength={60} placeholder="For example: Reading" onChange={e => setName(e.target.value)} />
            <select aria-label="Type of the new habit" value={type} onChange={e => setType(e.target.value)}>{HABIT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select>
            <Chips mask={mask} label="Days for the new habit" onToggle={i => { const next = mask ^ (1 << i); if (next > 0) setMask(next); }} />
            <button type="submit" className="hx-btn accent" disabled={disabled || !name.trim()}>Add habit</button></div></form>
        <p className="hint">Drag the six dots to put your habits in order. Click a name to see its streaks, rename it or change its type. Each habit is also an activity in the Life Timetable: put it on a block there, and its check-in comes when that block starts.</p>
      </>}
    </section>
    {open && (() => { const h = list.find(x => x.id === open); return h ? <HabitDetail habit={h} log={log} today={today} disabled={disabled} onClose={() => setOpen(null)}
      onChange={patch => void run(async () => { const was = { name: h.name, days: h.days, category: h.category }; await habitsApi.update(h.id, patch); pushUndo(`Change to habit “${h.name}”`, async () => { await habitsApi.update(h.id, was); announceHabits(); }); })} onDelete={() => { remove(h); setOpen(null); }} /> : null; })()}
  </div>;
}
