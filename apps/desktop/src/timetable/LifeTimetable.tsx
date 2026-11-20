import { useEffect, useMemo, useRef, useState } from "react";
import { now } from "./clock";
import { CATEGORIES, SLOTS_PER_DAY, dayBlocks, names, totals, weekdayOf, type Activity, type Category } from "./schedule";
import { addActivity, copyDay, deleteActivity, saveSlots, updateActivity, useTick, useTimetable } from "./useTimetable";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ROW = 28; // px per half hour
const hhmm = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
const hours = (n: number) => (n === 0 ? "–" : Number.isInteger(n) ? String(n) : n.toFixed(1));
type Status = { state: "saved" | "saving" | "error"; message?: string };
type Selection = { day: number; anchor: number; focus: number } | null;
const colourStyle = (a?: Activity): React.CSSProperties | undefined => (a?.colour ? ({ "--cat-bar": a.colour, "--cat-bg": `color-mix(in srgb, ${a.colour} 22%, var(--card))` } as React.CSSProperties) : undefined);

export default function LifeTimetable({ disabled = false }: { disabled?: boolean }) {
  const { data, grid, activities, error } = useTimetable();
  const t = useTick(30000, now);
  const [status, setStatus] = useState<Status>({ state: "saved" });
  const [sel, setSel] = useState<Selection>(null);
  const [picker, setPicker] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [copyTo, setCopyTo] = useState<number[]>([]);
  const [showActs, setShowActs] = useState(false);
  const [focusCell, setFocusCell] = useState({ day: weekdayOf(now()), slot: 0 });
  const dragging = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const byId = useMemo(() => new Map(activities.map(a => [a.id, a])), [activities]);
  const sums = useMemo(() => totals(grid, activities), [grid, activities]);
  const today = weekdayOf(t);
  const nowSlotFloat = (t.getHours() * 60 + t.getMinutes()) / 30;

  useEffect(() => {
    if (!data || scrolled.current || !scroller.current) return;
    scrolled.current = true;
    scroller.current.scrollTop = Math.max(0, nowSlotFloat * ROW - 140);
  }, [data, nowSlotFloat]);

  const persist = async (job: () => Promise<void>) => {
    setStatus({ state: "saving" });
    try { await job(); setStatus({ state: "saved" }); } catch (e) { setStatus({ state: "error", message: String(e) }); }
  };
  const range = sel ? { first: Math.min(sel.anchor, sel.focus), last: Math.max(sel.anchor, sel.focus) } : null;
  const slotsOfSel = () => (sel && range ? Array.from({ length: range.last - range.first + 1 }, (_, i) => range.first + i) : []);
  const inSel = (day: number, slot: number) => !!sel && !!range && sel.day === day && slot >= range.first && slot <= range.last;

  function openPicker(next: Selection) {
    if (!next) return;
    const lo = Math.min(next.anchor, next.focus), hi = Math.max(next.anchor, next.focus);
    const cells = Array.from({ length: hi - lo + 1 }, (_, i) => grid[next.day * SLOTS_PER_DAY + lo + i]);
    setChecked(cells.length ? cells[0].filter(id => cells.every(c => c.includes(id))) : []);
    setCopyTo([]);
    setPicker(true);
  }
  const select = (next: Selection, open = false) => { setSel(next); if (next) setFocusCell({ day: next.day, slot: next.focus }); if (open) openPicker(next); else setPicker(false); };
  const apply = (ids: string[]) => { if (!sel) return; void persist(() => saveSlots(sel.day, slotsOfSel(), ids)).then(() => setPicker(false)); };

  function onKey(e: React.KeyboardEvent, day: number, slot: number) {
    const move = (dd: number, ds: number) => {
      e.preventDefault();
      const nd = Math.min(6, Math.max(0, day + dd)), ns = Math.min(SLOTS_PER_DAY - 1, Math.max(0, slot + ds));
      if (e.shiftKey && dd === 0) select({ day, anchor: sel && sel.day === day ? sel.anchor : slot, focus: ns });
      else select({ day: nd, anchor: ns, focus: ns });
      requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-cell="${nd}-${ns}"]`)?.focus());
    };
    if (e.key === "ArrowDown") move(0, 1); else if (e.key === "ArrowUp") move(0, -1);
    else if (e.key === "ArrowRight") move(1, 0); else if (e.key === "ArrowLeft") move(-1, 0);
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(sel && sel.day === day ? sel : { day, anchor: slot, focus: slot }); if (!sel || sel.day !== day) setSel({ day, anchor: slot, focus: slot }); }
    else if ((e.key === "Delete" || e.key === "Backspace") && !disabled) { e.preventDefault(); const s = sel && sel.day === day ? sel : { day, anchor: slot, focus: slot }; void persist(() => saveSlots(day, Array.from({ length: Math.abs(s.focus - s.anchor) + 1 }, (_, i) => Math.min(s.anchor, s.focus) + i), [])); }
    else if (e.key === "Escape") { setSel(null); setPicker(false); }
  }

  const [adding, setAdding] = useState({ name: "", category: "Training" as Category });
  const [deleting, setDeleting] = useState<{ id: string; to: string } | null>(null);
  const usedBy = (id: string) => (data?.slots ?? []).filter(s => s.activity_id === id).length;

  if (!data) return <div className="document tt-screen"><h1>Life Timetable</h1><p className={error ? "error" : "hint"} role={error ? "alert" : "status"}>{error || "Opening the timetable…"}</p></div>;
  const pickerTitle = sel && range ? `${DAYS[sel.day]} ${hhmm(range.first)}–${hhmm(range.last + 1)}` : "";
  const grouped = CATEGORIES.map(c => ({ c, list: activities.filter(a => a.category === c) })).filter(g => g.list.length);

  return <div className="document tt-screen" aria-label="Life Timetable">
    <header className="tt-head">
      <div><h1>Life Timetable</h1><p className="hint">Your week in half-hour slots. Click or drag to choose slots, then pick what happens in them.</p></div>
      <div className="tt-tools">
        <span className={"tt-status " + status.state} role="status">{status.state === "saving" ? "Saving…" : status.state === "error" ? "Not saved: " + status.message : "Saved"}</span>
        <button onClick={() => { if (scroller.current) scroller.current.scrollTop = Math.max(0, nowSlotFloat * ROW - 140); }}>Jump to now</button>
        <button aria-expanded={showActs} onClick={() => setShowActs(v => !v)}>Activities</button>
      </div>
    </header>

    {showActs && <section className="tt-acts" aria-label="Activities">
      <ul>
        {activities.map(a => <li key={a.id} className="tt-act">
          <input aria-label={"Name of " + a.name} defaultValue={a.name} disabled={disabled} onBlur={e => { const v = e.target.value.trim(); if (v && v !== a.name) void persist(() => updateActivity({ id: a.id, name: v, category: a.category, colour: a.colour, remind: a.remind })); else e.target.value = a.name; }} />
          <select aria-label={"Category of " + a.name} value={a.category} disabled={disabled} onChange={e => void persist(() => updateActivity({ id: a.id, name: a.name, category: e.target.value as Category, colour: a.colour, remind: a.remind }))}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
          <input type="color" aria-label={"Colour of " + a.name} value={a.colour ?? "#1d4ed8"} disabled={disabled} onChange={e => void persist(() => updateActivity({ id: a.id, name: a.name, category: a.category, colour: e.target.value, remind: a.remind }))} />
          {a.colour && <button className="link-button" disabled={disabled} onClick={() => void persist(() => updateActivity({ id: a.id, name: a.name, category: a.category, colour: null, remind: a.remind }))}>Reset colour</button>}
          <label className="tt-check"><input type="checkbox" checked={a.remind} disabled={disabled} onChange={e => void persist(() => updateActivity({ id: a.id, name: a.name, category: a.category, colour: a.colour, remind: e.target.checked }))} /> Remind</label>
          {deleting?.id === a.id
            ? <span className="tt-del">{usedBy(a.id) > 0 && <><label>Move its {usedBy(a.id)} slots to <select aria-label="Reassign slots to" value={deleting.to} onChange={e => setDeleting({ id: a.id, to: e.target.value })}><option value="">Choose…</option>{activities.filter(o => o.id !== a.id).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label></>}
              <button className="danger" disabled={disabled || (usedBy(a.id) > 0 && !deleting.to)} onClick={() => void persist(() => deleteActivity(a.id, deleting.to || null)).then(() => setDeleting(null))}>Delete {a.name}</button>
              <button onClick={() => setDeleting(null)}>Cancel</button></span>
            : <button className="danger" disabled={disabled} aria-label={"Delete " + a.name} onClick={() => setDeleting({ id: a.id, to: "" })}>Delete</button>}
        </li>)}
      </ul>
      <form className="tt-add" onSubmit={e => { e.preventDefault(); if (!adding.name.trim()) return; void persist(() => addActivity(adding.name.trim(), adding.category)).then(() => setAdding({ ...adding, name: "" })); }}>
        <input aria-label="New activity name" placeholder="New activity" value={adding.name} disabled={disabled} onChange={e => setAdding({ ...adding, name: e.target.value })} />
        <select aria-label="New activity category" value={adding.category} onChange={e => setAdding({ ...adding, category: e.target.value as Category })}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        <button className="primary" type="submit" disabled={disabled || !adding.name.trim()}>Add activity</button>
      </form>
    </section>}

    <div className="tt-scroll" ref={scroller} tabIndex={-1} onMouseUp={() => { if (dragging.current) { dragging.current = false; openPicker(sel); } }} onMouseLeave={() => { if (dragging.current) { dragging.current = false; openPicker(sel); } }}>
      <div className="tt-grid" role="grid" aria-label="Weekly timetable" aria-rowcount={SLOTS_PER_DAY} aria-colcount={7} style={{ ["--row" as string]: ROW + "px" }}>
        <div className="tt-corner" />
        {DAYS.map((d, i) => <div key={d} className={"tt-dayhead" + (i === today ? " today" : "")} role="columnheader" aria-current={i === today ? "date" : undefined}>{d.slice(0, 3)}</div>)}
        <div className="tt-gutter" aria-hidden="true">{Array.from({ length: SLOTS_PER_DAY }, (_, s) => <div key={s} className="tt-time">{s % 2 === 0 ? hhmm(s) : ""}</div>)}</div>
        {DAYS.map((d, day) => <div key={d} className={"tt-day" + (day === today ? " today" : "")} role="rowgroup" aria-label={d}>
          {dayBlocks(grid, day).map(b => {
            const first = byId.get(b.ids[0]);
            const label = b.ids.length ? names(b.ids, activities) : "";
            return <div key={b.first} className={"tt-block cat-" + (first?.category ?? "").toLowerCase() + (b.ids.length ? "" : " empty")} style={{ top: b.first * ROW, height: b.count * ROW, ...colourStyle(first) }}>
              {b.ids.length > 0 && <><span className="tt-name">{label}</span>{b.count > 1 && <span className="tt-range">{hhmm(b.first)}–{hhmm(b.first + b.count)}</span>}</>}
            </div>;
          })}
          {day === today && <div className="tt-nowline" data-testid="now-line" style={{ top: nowSlotFloat * ROW }} aria-hidden="true" />}
          <div className="tt-cells">
            {Array.from({ length: SLOTS_PER_DAY }, (_, slot) => {
              const ids = grid[day * SLOTS_PER_DAY + slot];
              return <button key={slot} type="button" role="gridcell" data-cell={day + "-" + slot} aria-selected={inSel(day, slot)} disabled={disabled}
                className={"tt-cell" + (inSel(day, slot) ? " selected" : "")}
                tabIndex={focusCell.day === day && focusCell.slot === slot ? 0 : -1}
                aria-label={`${d} ${hhmm(slot)}${ids.length ? ": " + names(ids, activities) : ", empty"}`}
                title={ids.length ? `${hhmm(slot)} ${names(ids, activities)}` : undefined}
                onMouseDown={e => { if (e.button !== 0) return; dragging.current = true; select({ day, anchor: slot, focus: slot }); }}
                onMouseEnter={() => { if (dragging.current && sel && sel.day === day) select({ day, anchor: sel.anchor, focus: slot }); }}
                onFocus={() => setFocusCell({ day, slot })}
                onKeyDown={e => onKey(e, day, slot)} />;
            })}
          </div>
        </div>)}
      </div>
    </div>

    {picker && sel && <aside className="tt-picker" role="dialog" aria-label="Choose activities">
      <h2>{pickerTitle}</h2>
      {grouped.map(g => <fieldset key={g.c}><legend>{g.c}</legend>
        {g.list.map(a => <label key={a.id} className="tt-check"><input type="checkbox" checked={checked.includes(a.id)} onChange={e => setChecked(e.target.checked ? [...checked, a.id] : checked.filter(x => x !== a.id))} /> {a.name}</label>)}</fieldset>)}
      <div className="tt-picker-actions">
        <button className="primary" disabled={disabled} onClick={() => apply(checked)}>Apply</button>
        <button disabled={disabled} onClick={() => apply([])}>Clear slots</button>
        <button onClick={() => setPicker(false)}>Close</button>
      </div>
      <fieldset><legend>Copy {DAYS[sel.day]} to…</legend>
        {DAYS.map((d, i) => i !== sel.day && <label key={d} className="tt-check"><input type="checkbox" checked={copyTo.includes(i)} onChange={e => setCopyTo(e.target.checked ? [...copyTo, i] : copyTo.filter(x => x !== i))} /> {d}</label>)}
        <button disabled={disabled || !copyTo.length} onClick={() => { if (window.confirm(`Replace ${copyTo.map(i => DAYS[i]).join(", ")} with a copy of ${DAYS[sel.day]}?`)) void persist(() => copyDay(sel.day, copyTo)).then(() => setPicker(false)); }}>Copy day</button>
      </fieldset>
    </aside>}

    <section className="tt-totals" aria-label="Hours per category">
      <h2>Hours per category</h2>
      <p className="hint">A slot with several activities counts each of them.</p>
      <div className="tt-totals-scroll"><table>
        <thead><tr><th scope="col">Category</th>{DAYS.map(d => <th key={d} scope="col">{d.slice(0, 3)}</th>)}<th scope="col">Week</th></tr></thead>
        <tbody>{CATEGORIES.map(c => <tr key={c}><th scope="row"><span className={"tt-dot cat-" + c.toLowerCase()} aria-hidden="true" />{c}</th>{sums.perDay[c].map((n, i) => <td key={i}>{hours(n)}</td>)}<td className="week">{hours(sums.perWeek[c])}</td></tr>)}</tbody>
      </table></div>
    </section>
  </div>;
}
