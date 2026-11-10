import { useMemo, useState } from "react";
import { Chip, Summary, cardProperties, dateOf, dayNumber, fromDay, type Row, type ViewContext } from "./dbShared";

function Notice({ children }: { children: React.ReactNode }) { return <p className="hint db-notice">{children}</p>; }

function CardBody({ ctx, row, skip }: { ctx: ViewContext; row: Row; skip?: (string | undefined)[] }) {
  return <>
    <strong className="db-card-title">{row.title}</strong>
    <div className="db-card-props">{cardProperties(ctx, row, skip).slice(0, 4).map(p => <span key={p.id} className="db-card-prop"><Summary property={p} value={row.values[p.id]} /></span>)}</div>
  </>;
}

export function BoardView({ ctx }: { ctx: ViewContext }) {
  const group = ctx.data.properties.find(p => p.id === ctx.view.config.groupBy && (p.type === "select" || p.type === "status"));
  const [over, setOver] = useState<string | null>(null);
  if (!group) return <Notice>Choose a Select or Status property to group this board by. Add one with the + button in the Table view.</Notice>;
  const columns = [...group.options.map(o => ({ key: o.id, option: o as typeof o | null })), { key: "", option: null }];
  const move = (rowId: string, key: string) => { const row = ctx.data.rows.find(r => r.id === rowId); if (row && (row.values[group.id] ?? "") !== key) void ctx.setValue(row, group, key || null); };
  return <div className="db-board">
    {columns.map(({ key, option }) => {
      const rows = ctx.data.rows.filter(r => (r.values[group.id] ?? "") === key);
      return <section key={key || "none"} className={"db-column" + (over === key ? " over" : "")} aria-label={option ? option.name : "No " + group.name}
        onDragOver={e => { if (!ctx.readOnly) { e.preventDefault(); setOver(key); } }} onDragLeave={() => setOver(null)}
        onDrop={e => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id && !ctx.readOnly) move(id, key); }}>
        <header>{option ? <Chip option={option} /> : <span className="db-empty-cell">No {group.name}</span>}<span className="db-count">{rows.length}</span></header>
        {rows.map(row => <article key={row.id} className="db-card" draggable={!ctx.readOnly} onDragStart={e => e.dataTransfer.setData("text/plain", row.id)} onClick={() => ctx.open(row)} tabIndex={0}
          onKeyDown={e => { if (e.key === "Enter") ctx.open(row); }}><CardBody ctx={ctx} row={row} skip={[group.id]} /></article>)}
        <button className="db-new-row" disabled={ctx.readOnly} onClick={() => void ctx.addRow(key ? { [group.id]: key } : {})}>+ New</button>
      </section>;
    })}
  </div>;
}

export function ListView({ ctx }: { ctx: ViewContext }) {
  if (!ctx.data.rows.length) return <Notice>No rows yet.</Notice>;
  return <ul className="db-list">{ctx.data.rows.map(row => <li key={row.id}><button onClick={() => ctx.open(row)}>
    <strong>{row.title}</strong><span className="db-card-props">{cardProperties(ctx, row).slice(0, 5).map(p => <span key={p.id} className="db-card-prop"><Summary property={p} value={row.values[p.id]} /></span>)}</span>
  </button></li>)}</ul>;
}

export function GalleryView({ ctx }: { ctx: ViewContext }) {
  if (!ctx.data.rows.length) return <Notice>No rows yet.</Notice>;
  return <div className="db-gallery">{ctx.data.rows.map(row => <article key={row.id} className="db-card db-gallery-card" tabIndex={0} onClick={() => ctx.open(row)} onKeyDown={e => { if (e.key === "Enter") ctx.open(row); }}><CardBody ctx={ctx} row={row} /></article>)}</div>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function CalendarView({ ctx }: { ctx: ViewContext }) {
  const date = ctx.data.properties.find(p => p.id === ctx.view.config.dateBy && p.type === "date");
  const today = new Date();
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    if (date) for (const row of ctx.data.rows) { const d = dateOf(row.values[date.id]); if (d) map.set(d, [...(map.get(d) ?? []), row]); }
    return map;
  }, [ctx.data.rows, date]);
  if (!date) return <Notice>Choose a Date property to place rows on the calendar. Add one with the + button in the Table view.</Notice>;
  const first = new Date(Date.UTC(cursor.year, cursor.month, 1));
  const lead = first.getUTCDay();
  const days = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate();
  const cells = Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => (i < lead || i >= lead + days ? null : i - lead + 1));
  const ymd = (day: number) => `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const shift = (by: number) => setCursor(c => { const d = new Date(Date.UTC(c.year, c.month + by, 1)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() }; });
  const undated = ctx.data.rows.filter(r => !dateOf(r.values[date.id]));
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return <div className="db-calendar">
    <div className="db-cal-bar">
      <button aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
      <strong>{first.toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</strong>
      <button aria-label="Next month" onClick={() => shift(1)}>›</button>
      <button onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}>Today</button>
    </div>
    <div className="db-cal-grid" role="grid">
      {WEEKDAYS.map(d => <div key={d} className="db-cal-head" role="columnheader">{d}</div>)}
      {cells.map((day, i) => day === null ? <div key={i} className="db-cal-cell blank" /> :
        <div key={i} className={"db-cal-cell" + (ymd(day) === todayKey ? " today" : "")} role="gridcell" aria-label={ymd(day)}>
          <div className="db-cal-day"><span>{day}</span><button aria-label={"Add a row on " + ymd(day)} disabled={ctx.readOnly} onClick={() => void ctx.addRow({ [date.id]: ymd(day) })}>+</button></div>
          {(byDay.get(ymd(day)) ?? []).map(row => <button key={row.id} className="db-cal-item" onClick={() => ctx.open(row)}>{row.title}</button>)}
        </div>)}
    </div>
    {undated.length > 0 && <details className="db-undated"><summary>No date ({undated.length})</summary>{undated.map(row => <button key={row.id} className="db-cal-item" onClick={() => ctx.open(row)}>{row.title}</button>)}</details>}
  </div>;
}

export function TimelineView({ ctx }: { ctx: ViewContext }) {
  const start = ctx.data.properties.find(p => p.id === ctx.view.config.dateBy && p.type === "date");
  const end = ctx.data.properties.find(p => p.id === ctx.view.config.endBy && p.type === "date");
  const items = useMemo(() => {
    if (!start) return [];
    return ctx.data.rows.flatMap(row => {
      const s = dateOf(row.values[start.id]); if (!s) return [];
      const e = (end && dateOf(row.values[end.id])) || s;
      const a = dayNumber(s), b = Math.max(a, dayNumber(e));
      return [{ row, a, b }];
    });
  }, [ctx.data.rows, start, end]);
  if (!start) return <Notice>Choose a Date property for the start of each item (and optionally an end date) to build the timeline.</Notice>;
  const undated = ctx.data.rows.filter(r => !dateOf(r.values[start.id]));
  if (!items.length) return <><Notice>No dated rows yet. Give a row a date in the Table view.</Notice>{undated.length > 0 && <p className="hint">{undated.length} row(s) have no date.</p>}</>;
  const min = Math.min(...items.map(i => i.a)) - 2, max = Math.max(...items.map(i => i.b)) + 2;
  const span = max - min + 1;
  const dayW = span <= 60 ? 32 : span <= 200 ? 14 : 5;
  const ticks = Array.from({ length: span }, (_, i) => min + i);
  const label = (n: number) => { const d = new Date(n * 864e5); return d.getUTCDate() === 1 || n === min ? d.toLocaleString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }) : ""; };
  const sorted = [...items].sort((x, y) => x.a - y.a || x.b - y.b);
  return <div className="db-timeline"><div className="db-tl-scroll"><div style={{ width: span * dayW + 200 }}>
    <div className="db-tl-head"><div className="db-tl-name" />
      <div className="db-tl-scale" style={{ width: span * dayW }}>{ticks.map(n => <span key={n} className={"db-tl-tick" + (new Date(n * 864e5).getUTCDay() % 6 === 0 ? " weekend" : "")} style={{ width: dayW }}>{dayW >= 14 ? new Date(n * 864e5).getUTCDate() : ""}<em>{label(n)}</em></span>)}</div></div>
    {sorted.map(({ row, a, b }) => <div key={row.id} className="db-tl-row">
      <button className="db-tl-name" onClick={() => ctx.open(row)} title={row.title}>{row.title}</button>
      <div className="db-tl-lane" style={{ width: span * dayW }}>
        <button className="db-tl-bar" onClick={() => ctx.open(row)} title={`${row.title}: ${fromDay(a)}${b > a ? " → " + fromDay(b) : ""}`} style={{ left: (a - min) * dayW, width: (b - a + 1) * dayW - 2 }}>{(b - a + 1) * dayW > 60 ? row.title : ""}</button>
      </div></div>)}
  </div></div>{undated.length > 0 && <details className="db-undated"><summary>No date ({undated.length})</summary>{undated.map(row => <button key={row.id} className="db-cal-item" onClick={() => ctx.open(row)}>{row.title}</button>)}</details>}</div>;
}
