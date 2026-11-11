import { useMemo, useState } from "react";
import { PlaceSearchBox } from "./PlaceSearch";
import { Chip, Summary, cardProperties, dateOf, dayNumber, fromDay, isDateLike, isPlace, type Place, type Row, type ViewContext } from "./dbShared";

function Notice({ children }: { children: React.ReactNode }) { return <p className="hint db-notice">{children}</p>; }

function CardBody({ ctx, row, skip }: { ctx: ViewContext; row: Row; skip?: (string | undefined)[] }) {
  return <>
    <strong className="db-card-title">{row.title}</strong>
    <div className="db-card-props">{cardProperties(ctx, row, skip).slice(0, 4).map(p => <span key={p.id} className="db-card-prop"><Summary property={p} value={row.values[p.id]} linked={ctx.data.linked} /></span>)}</div>
  </>;
}

export function BoardView({ ctx }: { ctx: ViewContext }) {
  const isGroup = (p: { type: string }) => p.type === "select" || p.type === "status";
  // With no group chosen yet, use the first Status/Select property so the board works immediately.
  const group = ctx.data.properties.find(p => p.id === ctx.view.config.groupBy && isGroup(p)) ?? ctx.data.properties.find(p => p.type === "status") ?? ctx.data.properties.find(isGroup);
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
    <strong>{row.title}</strong><span className="db-card-props">{cardProperties(ctx, row).slice(0, 5).map(p => <span key={p.id} className="db-card-prop"><Summary property={p} value={row.values[p.id]} linked={ctx.data.linked} /></span>)}</span>
  </button></li>)}</ul>;
}

export function GalleryView({ ctx }: { ctx: ViewContext }) {
  if (!ctx.data.rows.length) return <Notice>No rows yet.</Notice>;
  return <div className="db-gallery">{ctx.data.rows.map(row => <article key={row.id} className="db-card db-gallery-card" tabIndex={0} onClick={() => ctx.open(row)} onKeyDown={e => { if (e.key === "Enter") ctx.open(row); }}><CardBody ctx={ctx} row={row} /></article>)}</div>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function CalendarView({ ctx }: { ctx: ViewContext }) {
  const date = ctx.data.properties.find(p => p.id === ctx.view.config.dateBy && isDateLike(p.type)) ?? ctx.data.properties.find(p => p.type === "date") ?? ctx.data.properties.find(p => isDateLike(p.type));
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
          <div className="db-cal-day"><span>{day}</span><button aria-label={"Add a row on " + ymd(day)} disabled={ctx.readOnly || date.type !== "date"} onClick={() => void ctx.addRow({ [date.id]: ymd(day) })}>+</button></div>
          {(byDay.get(ymd(day)) ?? []).map(row => <button key={row.id} className="db-cal-item" onClick={() => ctx.open(row)}>{row.title}</button>)}
        </div>)}
    </div>
    {undated.length > 0 && <details className="db-undated"><summary>No date ({undated.length})</summary>{undated.map(row => <button key={row.id} className="db-cal-item" onClick={() => ctx.open(row)}>{row.title}</button>)}</details>}
  </div>;
}

export function TimelineView({ ctx }: { ctx: ViewContext }) {
  const start = ctx.data.properties.find(p => p.id === ctx.view.config.dateBy && isDateLike(p.type)) ?? ctx.data.properties.find(p => p.type === "date") ?? ctx.data.properties.find(p => isDateLike(p.type));
  const end = ctx.data.properties.find(p => p.id === ctx.view.config.endBy && isDateLike(p.type));
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

/** Pick a grid step that gives roughly 4 to 8 lines across the visible span. */
function niceStep(span: number) { const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 15, 30, 45]; return steps.find(s => span / s <= 8) ?? 45; }

/** Offline map: rows are plotted by latitude/longitude on a degree grid. No map tiles, no network. */
export function MapView({ ctx }: { ctx: ViewContext }) {
  const place = ctx.data.properties.find(p => p.id === ctx.view.config.placeBy && p.type === "place") ?? ctx.data.properties.find(p => p.type === "place");
  const [mode, setMode] = useState<"fit" | "world">("fit");
  const [zoom, setZoom] = useState(1);
  const points = useMemo(() => (place ? ctx.data.rows.flatMap(row => { const v = row.values[place.id]; return isPlace(v) ? [{ row, at: v as Place }] : []; }) : []), [ctx.data.rows, place]);
  if (!place) return <Notice>Choose a Place property to plot rows on the map. Add one with the + button in the Table view.</Notice>;
  const missing = ctx.data.rows.filter(r => !isPlace(r.values[place.id]));
  const W = 900, H = 520;
  let minLng = -180, maxLng = 180, minLat = -90, maxLat = 90;
  if (mode === "fit" && points.length) {
    const lats = points.map(p => p.at.lat), lngs = points.map(p => p.at.lng);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2, cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const cos = Math.max(Math.cos(cLat * Math.PI / 180), 0.05);
    // Equal scale on both axes: a degree of longitude is drawn cos(lat) as wide as a degree of latitude.
    const needLat = Math.max(...lats) - Math.min(...lats);
    const needLng = (Math.max(...lngs) - Math.min(...lngs)) * cos;
    const spanLat = Math.max(needLat, needLng * (H / W), 0.01) * 1.4 / zoom;
    const spanLng = (spanLat * (W / H)) / cos;
    minLat = cLat - spanLat / 2; maxLat = cLat + spanLat / 2; minLng = cLng - spanLng / 2; maxLng = cLng + spanLng / 2;
  }
  const x = (lng: number) => ((lng - minLng) / (maxLng - minLng)) * W;
  const y = (lat: number) => ((maxLat - lat) / (maxLat - minLat)) * H;
  const step = niceStep(Math.max(maxLat - minLat, 1e-6));
  const lines = (lo: number, hi: number, limit: number) => { const out: number[] = []; for (let v = Math.ceil(Math.max(lo, -limit) / step) * step; v <= Math.min(hi, limit) + 1e-9 && out.length < 60; v += step) out.push(+v.toFixed(6)); return out; };
  return <div className="db-map">
    {!ctx.readOnly && <div className="db-map-add"><PlaceSearchBox onPick={p => void ctx.addRow({ [place.id]: { lat: p.lat, lng: p.lng, name: p.name, address: p.address } }, p.name)} placeholder="Search a place or address to add a pin…" /></div>}
    <div className="db-map-bar">
      <button className={mode === "fit" ? "active" : ""} onClick={() => { setMode("fit"); setZoom(1); }}>Fit pins</button>
      <button className={mode === "world" ? "active" : ""} onClick={() => setMode("world")}>World</button>
      <button aria-label="Zoom in" disabled={mode === "world"} onClick={() => setZoom(z => Math.min(z * 1.6, 5000))}>+</button>
      <button aria-label="Zoom out" disabled={mode === "world"} onClick={() => setZoom(z => Math.max(z / 1.6, 0.05))}>−</button>
      <span className="hint">Offline plot on a degree grid, no map tiles.</span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of places" className="db-map-svg">
      <rect width={W} height={H} className="db-map-bg" />
      {lines(minLng, maxLng, 180).map(v => <g key={"x" + v}><line x1={x(v)} x2={x(v)} y1={0} y2={H} className={v === 0 ? "db-map-axis" : "db-map-grid"} /><text x={x(v) + 3} y={H - 4} className="db-map-label">{v}°</text></g>)}
      {lines(minLat, maxLat, 90).map(v => <g key={"y" + v}><line y1={y(v)} y2={y(v)} x1={0} x2={W} className={v === 0 ? "db-map-axis" : "db-map-grid"} /><text x={4} y={y(v) - 3} className="db-map-label">{v}°</text></g>)}
      {points.map(({ row, at }) => {
        const cx = x(at.lng), cy = y(at.lat);
        if (cx < -10 || cx > W + 10 || cy < -10 || cy > H + 10) return null;
        return <g key={row.id} className="db-map-pin" tabIndex={0} role="button" aria-label={`${row.title} at ${at.lat}, ${at.lng}`} onClick={() => ctx.open(row)} onKeyDown={e => { if (e.key === "Enter") ctx.open(row); }}>
          <circle cx={cx} cy={cy} r={7} /><text x={cx + 11} y={cy + 4}>{row.title}</text><title>{row.title}{at.name ? " · " + at.name : ""}</title>
        </g>;
      })}
    </svg>
    {!points.length && <Notice>No pins yet. Search for a place or address above (press Enter), or type coordinates such as 35.68, 139.69 into the {place.name} column in the Table view.</Notice>}
    {missing.length > 0 && points.length > 0 && <details className="db-undated"><summary>No place ({missing.length})</summary>{missing.map(row => <button key={row.id} className="db-cal-item" onClick={() => ctx.open(row)}>{row.title}</button>)}</details>}
  </div>;
}
