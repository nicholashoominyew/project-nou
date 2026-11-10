import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useDismiss } from "./Dismissible";
import { newRichUpdate } from "./richUpdate";
import { BoardView, CalendarView, GalleryView, ListView, MapView, TimelineView } from "./DatabaseViews";
import { CALC_LABELS, OPS, calcOptions, computeCalc, groupRows, groupable, needsValue, visibleRows, type CalcFn, type Filter, type FilterOp, type Sort } from "./dbLogic";
import * as Y from "yjs";
import { Chip, KIND_ICON, VIEW_TYPES, defaultConfig, formatPlace, formatStamp, isComputedKind, isDateLike, isSelectLike, parsePlace, type Act, type DatabaseData, type Kind, type Property, type Row, type View, type ViewConfig, type ViewContext, type ViewType } from "./dbShared";

const NoteEditor = lazy(() => import("./NoteEditor"));
export const KINDS: { type: Kind; label: string }[] = [
  { type: "text", label: "Text" }, { type: "number", label: "Number" }, { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" }, { type: "status", label: "Status" }, { type: "date", label: "Date" },
  { type: "checkbox", label: "Checkbox" }, { type: "url", label: "URL" }, { type: "email", label: "Email" }, { type: "phone", label: "Phone" }, { type: "place", label: "Place" },
  { type: "created_time", label: "Created time" }, { type: "last_edited_time", label: "Last edited time" },
];
const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const TITLE_W = 240, COL_W = 170;
const clampWidth = (w: number) => Math.min(800, Math.max(60, Math.round(w)));
type Patch = (change: Partial<ViewConfig>) => Promise<void>;

/**
 * A disclosure whose menu is positioned against the window (not the table), so the table's own scrolling
 * can never clip it. Closes on outside click, Escape or scroll.
 */
function Popover({ className, summary, summaryLabel, menuClass, lazy, children }: { className?: string; summary: ReactNode; summaryLabel: string; menuClass?: string; lazy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const close = useCallback(() => { if (ref.current) ref.current.open = false; }, []);
  useDismiss(open, close, ref);
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && ref.current?.contains(event.target))) close(); };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open, close]);
  function toggled(event: React.SyntheticEvent<HTMLDetailsElement>) {
    const details = event.currentTarget;
    setOpen(details.open);
    if (details.open) {
      const rect = details.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      setAt({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)), top: below > 300 ? rect.bottom + 4 : Math.max(8, rect.top - 304) });
    }
  }
  return <details ref={ref} className={className} onToggle={toggled}>
    <summary aria-label={summaryLabel}>{summary}</summary>
    <div className={"db-menu " + (menuClass ?? "")} style={{ left: at.left, top: at.top }}>{(!lazy || open) && children}</div>
  </details>;
}
const closeOf = (event: React.SyntheticEvent) => { const details = (event.currentTarget as HTMLElement).closest("details"); if (details) details.open = false; };

export default function Database({ databaseId, readOnly, onError }: { databaseId: string; readOnly: boolean; onError: (e: unknown) => void }) {
  const [data, setData] = useState<DatabaseData | null>(null);
  const [failed, setFailed] = useState("");
  const [activeId, setActiveId] = useState("");
  const [peek, setPeek] = useState<Row | null>(null);
  const [search, setSearch] = useState("");
  const load = useCallback(async () => {
    const view = await invoke<DatabaseData | null>("get_database", { pageId: databaseId });
    if (!view) throw new Error("This database no longer exists.");
    setData(view); setFailed("");
  }, [databaseId]);
  useEffect(() => { void load().catch(e => setFailed(String(e instanceof Error ? e.message : e))); }, [load]);
  // Run a write, then refresh from the database so every view shows what was actually saved.
  const act: Act = useCallback(async work => {
    try { await work(); await load(); } catch (e) { onError(e); await load().catch(() => undefined); }
  }, [load, onError]);

  if (failed) return <p role="alert" className="db-error">{failed}</p>;
  if (!data) return <p role="status" className="hint">Opening database…</p>;
  const view = data.views.find(v => v.id === activeId) ?? data.views[0];
  if (!view) return <p role="alert" className="db-error">This database has no views.</p>;
  const setValue = (row: Row, property: Property, value: unknown) => act(() => invoke("set_value", { rowId: row.id, propertyId: property.id, value }));
  const addRow = (values: Record<string, unknown> = {}) => act(async () => {
    const row = await invoke<Row>("add_row", { databaseId, initialUpdate: await newRichUpdate() });
    for (const [propertyId, value] of Object.entries(values)) await invoke("set_value", { rowId: row.id, propertyId, value });
  });
  // Every view setting is saved as one complete, validated object (the server rejects unknown ids and operators).
  const patch: Patch = change => act(() => {
    const merged: Record<string, unknown> = { ...view.config, ...change };
    for (const key of Object.keys(merged)) { const v = merged[key]; if (v === undefined || (Array.isArray(v) && v.length === 0) || (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)) delete merged[key]; }
    return invoke("update_view", { viewId: view.id, config: merged });
  });
  const needle = search.trim().toLowerCase();
  const searched = needle ? visibleRows(data.rows, data.properties, view.config).filter(r => r.title.toLowerCase().includes(needle) || Object.values(r.values).some(v => typeof v === "string" && v.toLowerCase().includes(needle))) : visibleRows(data.rows, data.properties, view.config);
  const shown: DatabaseData = { ...data, rows: searched };
  const ctx: ViewContext = { data: shown, view, readOnly, open: setPeek, setValue, addRow, onError };

  return <div className="db">
    <input className="db-name" aria-label="Database title" defaultValue={data.title} readOnly={readOnly} key={data.title}
      onBlur={e => { const title = e.target.value.trim(); if (title && title !== data.title) void act(() => invoke("rename_page", { pageId: databaseId, title })); else e.target.value = data.title; }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    <ViewTabs data={data} active={view} select={setActiveId} readOnly={readOnly} act={act} databaseId={databaseId} />
    <ViewSettings data={data} view={view} readOnly={readOnly} patch={patch} />
    <ViewToolbar data={data} view={view} readOnly={readOnly} patch={patch} shown={shown.rows.length} search={search} setSearch={setSearch} />
    {view.type === "table" && <TableView ctx={ctx} act={act} patch={patch} databaseId={databaseId} />}
    {view.type === "board" && <BoardView ctx={ctx} />}
    {view.type === "list" && <ListView ctx={ctx} />}
    {view.type === "gallery" && <GalleryView ctx={ctx} />}
    {view.type === "calendar" && <CalendarView ctx={ctx} />}
    {view.type === "timeline" && <TimelineView ctx={ctx} />}
    {view.type === "map" && <MapView ctx={ctx} />}
    {view.type !== "board" && view.type !== "calendar" && <button className="db-new-row" disabled={readOnly} onClick={() => void addRow()}>+ New row</button>}
    {peek && <RowPeek row={peek} onClose={() => { setPeek(null); void load().catch(() => undefined); }} />}
  </div>;
}

function RowPeek({ row, onClose }: { row: Row; onClose: () => void }) {
  const [status, setStatus] = useState("saved");
  const busy = status !== "saved";
  return createPortal(<div className="db-peek" role="dialog" aria-label={"Page " + row.title}>
    <div className="db-peek-bar"><strong>{row.title}</strong><span className="hint">{busy ? "Saving…" : ""}</span><button disabled={busy} onClick={onClose}>Close</button></div>
    <div className="db-peek-body"><Suspense fallback={<p role="status">Opening page…</p>}><NoteEditor pageId={row.id} title={row.title} onStatus={s => setStatus(String(s))} readOnly={false} /></Suspense></div>
  </div>, document.body);
}

function ViewTabs({ data, active, select, readOnly, act, databaseId }: { data: DatabaseData; active: View; select: (id: string) => void; readOnly: boolean; act: Act; databaseId: string }) {
  const [name, setName] = useState("");
  return <div className="db-tabs" role="tablist" aria-label="Views">
    {data.views.map(v => <button key={v.id} role="tab" aria-selected={v.id === active.id} className={v.id === active.id ? "active" : ""} onClick={() => select(v.id)}>{v.name}</button>)}
    <Popover className="db-tab-add" summaryLabel="Add a view" summary={<span title="Add a view">+</span>} menuClass="db-add-menu">
      <p className="db-menu-title">Add a view</p>
      {VIEW_TYPES.map(t => <button key={t.type} disabled={readOnly} onClick={e => { closeOf(e); void act(async () => {
        // A calendar, timeline or map needs a Date/Place column; create one so the new view works straight away.
        let properties = data.properties;
        const needs = t.type === "calendar" || t.type === "timeline" ? { kind: "date", name: "Date" } : t.type === "map" ? { kind: "place", name: "Place" } : null;
        if (needs && !properties.some(p => (needs.kind === "date" ? isDateLike(p.type) : p.type === needs.kind))) { const created = await invoke<Property>("add_property", { databaseId, name: needs.name, kind: needs.kind }); properties = [...properties, created]; }
        const view = await invoke<View>("add_view", { databaseId, name: t.label, kind: t.type, config: defaultConfig(t.type, properties) }); select(view.id);
      }); }}>{t.label}</button>)}
    </Popover>
    <Popover className="db-tab-more" summaryLabel="View options" summary={<span title="View options">⋯</span>} menuClass="db-column-menu">
      <label>Rename view<input value={name} placeholder={active.name} disabled={readOnly} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && name.trim()) { void act(() => invoke("update_view", { viewId: active.id, name })); setName(""); } }} /></label>
      <button className="danger" disabled={readOnly || data.views.length < 2} onClick={() => { if (window.confirm("Remove the “" + active.name + "” view? Your rows are not affected.")) void act(async () => { await invoke("delete_view", { viewId: active.id }); select(""); }); }}>Remove view</button>
    </Popover>
  </div>;
}

function ViewSettings({ data, view, readOnly, patch }: { data: DatabaseData; view: View; readOnly: boolean; patch: Patch }) {
  const pick = (key: "groupBy" | "dateBy" | "endBy" | "placeBy", kinds: Kind[], label: string, optional = false) => {
    const choices = data.properties.filter(p => kinds.includes(p.type));
    return <label className="db-setting">{label}
      <select value={view.config[key] ?? ""} disabled={readOnly} onChange={e => void patch({ [key]: e.target.value || undefined })}>
        <option value="">{optional ? "None" : "Choose…"}</option>{choices.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>;
  };
  if (view.type === "board") return <div className="db-settings">{pick("groupBy", ["select", "status"], "Group by")}</div>;
  if (view.type === "calendar") return <div className="db-settings">{pick("dateBy", ["date", "created_time", "last_edited_time"], "Show by")}</div>;
  if (view.type === "map") return <div className="db-settings">{pick("placeBy", ["place"], "Place")}</div>;
  if (view.type === "timeline") return <div className="db-settings">{pick("dateBy", ["date", "created_time", "last_edited_time"], "Start")}{pick("endBy", ["date", "created_time", "last_edited_time"], "End", true)}</div>;
  return null;
}

/** Filter / sort buttons plus chips for whatever is active. Works on every view type. */
function ViewToolbar({ data, view, readOnly, patch, shown, search, setSearch }: { data: DatabaseData; view: View; readOnly: boolean; patch: Patch; shown: number; search: string; setSearch: (s: string) => void }) {
  const { filters = [], sorts = [], hidden = [], groupBy } = view.config;
  const byId = new Map(data.properties.map(p => [p.id, p]));
  const sortable = data.properties.filter(p => p.type !== "multi_select");
  const setFilter = (index: number, next: Filter) => void patch({ filters: filters.map((f, i) => (i === index ? next : f)) });
  const addFilter = (property: Property) => void patch({ filters: [...filters, { p: property.id, op: OPS[property.type][0].op, v: undefined }] });
  const group = groupBy ? byId.get(groupBy) : undefined;
  return <div className="db-toolbar">
    <div className="db-toolbar-row">
      <Popover className="db-tool" summaryLabel="Add a filter" summary="Filter" menuClass="db-options">
        {data.properties.length === 0 && <span className="hint">Add a property first.</span>}
        {data.properties.map(p => <button key={p.id} disabled={readOnly || filters.length >= 10} onClick={e => { closeOf(e); addFilter(p); }}>{p.name}</button>)}
      </Popover>
      <Popover className="db-tool" summaryLabel="Add a sort" summary="Sort" menuClass="db-options">
        {sortable.map(p => <button key={p.id} disabled={readOnly || sorts.length >= 5} onClick={e => { closeOf(e); void patch({ sorts: [...sorts.filter(s => s.p !== p.id), { p: p.id, dir: "asc" }] }); }}>{p.name}</button>)}
      </Popover>
      {(filters.length > 0 || sorts.length > 0 || search.trim()) && <span className="db-count-note">{shown} row{shown === 1 ? "" : "s"} shown</span>}
      <input className="db-search" type="search" aria-label="Search rows" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} />
    </div>
    {filters.length > 1 && <div className="db-chip-row"><span className="db-pill">Match</span>
      <select aria-label="Filter match mode" value={view.config.filterMode ?? "and"} disabled={readOnly} onChange={e => void patch({ filterMode: e.target.value === "or" ? "or" : undefined })}><option value="and">all filters (And)</option><option value="or">any filter (Or)</option></select></div>}
    {filters.map((filter, i) => { const property = byId.get(filter.p); if (!property) return null; return <FilterRow key={i} filter={filter} property={property} readOnly={readOnly} onChange={next => setFilter(i, next)} onRemove={() => void patch({ filters: filters.filter((_, j) => j !== i) })} />; })}
    {sorts.map((sort, i) => { const property = byId.get(sort.p); if (!property) return null; return <div key={sort.p} className="db-chip-row"><span className="db-pill">Sort</span><strong>{property.name}</strong>
      <select aria-label={"Sort direction for " + property.name} value={sort.dir} disabled={readOnly} onChange={e => void patch({ sorts: sorts.map((s, j) => (j === i ? { ...s, dir: e.target.value as Sort["dir"] } : s)) })}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
      <button aria-label={"Remove sort on " + property.name} disabled={readOnly} onClick={() => void patch({ sorts: sorts.filter((_, j) => j !== i) })}>×</button></div>; })}
    {view.type === "table" && group && <div className="db-chip-row"><span className="db-pill">Group</span><strong>{group.name}</strong><button aria-label="Remove grouping" disabled={readOnly} onClick={() => void patch({ groupBy: undefined })}>×</button></div>}
    {view.type === "table" && hidden.some(id => byId.has(id)) && <div className="db-chip-row"><span className="db-pill">Hidden</span><span>{hidden.filter(id => byId.has(id)).map(id => byId.get(id)!.name).join(", ")}</span><button disabled={readOnly} onClick={() => void patch({ hidden: undefined })}>Show all</button></div>}
  </div>;
}

function FilterRow({ filter, property, readOnly, onChange, onRemove }: { filter: Filter; property: Property; readOnly: boolean; onChange: (f: Filter) => void; onRemove: () => void }) {
  const ops = OPS[property.type];
  const value = needsValue(filter.op) ? <FilterValue property={property} value={filter.v} readOnly={readOnly} onChange={v => onChange({ ...filter, v })} /> : null;
  return <div className="db-chip-row"><span className="db-pill">Filter</span><strong>{property.name}</strong>
    <select aria-label={"Filter operator for " + property.name} value={filter.op} disabled={readOnly} onChange={e => onChange({ ...filter, op: e.target.value as FilterOp, v: needsValue(e.target.value as FilterOp) ? filter.v : undefined })}>{ops.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
    {value}
    <button aria-label={"Remove filter on " + property.name} disabled={readOnly} onClick={onRemove}>×</button></div>;
}
function FilterValue({ property, value, readOnly, onChange }: { property: Property; value: unknown; readOnly: boolean; onChange: (v: unknown) => void }) {
  const label = "Filter value for " + property.name;
  if (isSelectLike(property.type)) return <select aria-label={label} value={typeof value === "string" ? value : ""} disabled={readOnly} onChange={e => onChange(e.target.value || undefined)}><option value="">Choose…</option>{property.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
  if (property.type === "date") return <input type="date" aria-label={label} value={typeof value === "string" ? value : ""} disabled={readOnly} onChange={e => onChange(e.target.value || undefined)} />;
  if (property.type === "number") return <input type="number" aria-label={label} value={typeof value === "number" || typeof value === "string" ? String(value) : ""} disabled={readOnly} onChange={e => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
  return <input aria-label={label} value={typeof value === "string" ? value : ""} disabled={readOnly} onChange={e => onChange(e.target.value || undefined)} />;
}

function TableView({ ctx, act, patch, databaseId }: { ctx: ViewContext; act: Act; patch: Patch; databaseId: string }) {
  const { data, readOnly, view } = ctx;
  const config = view.config;
  const hidden = new Set(config.hidden ?? []);
  const wrap = new Set(config.wrap ?? []);
  const columns = data.properties.filter(p => !hidden.has(p.id));
  const frozenAt = config.frozen ? columns.findIndex(p => p.id === config.frozen) : -1;
  const widths = config.widths ?? {};
  const widthOf = (index: number) => (index < 0 ? widths.title ?? TITLE_W : widths[columns[index].id] ?? COL_W);
  const leftOf = (index: number) => (index < 0 ? 0 : widthOf(-1) + columns.slice(0, index).reduce((sum, _p, i) => sum + widthOf(i), 0));
  const frozenStyle = (index: number): CSSProperties => {
    const w = widthOf(index);
    const base: CSSProperties = { width: w, minWidth: w, maxWidth: w };
    return frozenAt >= 0 && index <= frozenAt ? { ...base, position: "sticky", left: leftOf(index), zIndex: 3, background: "var(--bg)" } : base;
  };
  const resize = (key: string, startWidth: number) => (event: React.PointerEvent) => {
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX;
    const th = (event.currentTarget as HTMLElement).closest("th");
    const move = (e: PointerEvent) => { if (th) th.style.width = th.style.minWidth = th.style.maxWidth = clampWidth(startWidth + e.clientX - startX) + "px"; };
    const up = (e: PointerEvent) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void patch({ widths: { ...widths, [key]: clampWidth(startWidth + e.clientX - startX) } }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const groupProperty = config.groupBy ? data.properties.find(p => p.id === config.groupBy && groupable(p.type)) : undefined;
  const groups = groupProperty ? groupRows(data.rows, groupProperty) : null;
  const span = columns.length + 2;
  const renderRow = (row: Row) => <tr key={row.id}>
    <td className="db-title-col" style={frozenStyle(-1)}><div className="db-title-cell">
      <input className="db-input db-title-input" aria-label={"Title of " + row.title} defaultValue={row.title} readOnly={readOnly} key={row.id + row.title}
        onBlur={e => { const title = e.target.value.trim(); if (title && title !== row.title) void act(() => invoke("rename_page", { pageId: row.id, title })); else e.target.value = row.title; }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <button className="db-open" aria-label={"Open " + row.title} title="Open page" onClick={() => ctx.open(row)}>Open</button>
    </div></td>
    {columns.map((property, i) => <td key={property.id} style={frozenStyle(i)}><Cell property={property} wrap={wrap.has(property.id)} value={row.values[property.id]} readOnly={readOnly} onChange={value => void ctx.setValue(row, property, value)} onError={ctx.onError} linked={data.linked} /></td>)}
    <td className="db-add-col"><Popover className="db-row-menu" summaryLabel={"Row options for " + row.title} summary={<span title="Row options">⋯</span>} menuClass="db-options">
      <button onClick={e => { closeOf(e); ctx.open(row); }}>Open</button>
      <button disabled={readOnly} onClick={e => { closeOf(e); void act(() => duplicateRow(databaseId, row, data.properties)); }}>Duplicate</button>
      <button className="danger" disabled={readOnly} onClick={e => { closeOf(e); void act(() => invoke("trash_page", { pageId: row.id })); }}>Delete</button>
    </Popover></td>
  </tr>;
  const calc = config.calc ?? {};
  const hasCalc = columns.some(p => calc[p.id]);
  return <div className="db-scroll"><table className="db-table">
    <thead><tr>
      <th className="db-title-col" style={frozenStyle(-1)}>Name<span className="db-resize" role="separator" aria-label="Resize Name column" onPointerDown={resize("title", widthOf(-1))} /></th>
      {columns.map((property, i) => <th key={property.id} style={frozenStyle(i)}><ColumnHeader property={property} ctx={ctx} act={act} patch={patch} databaseId={databaseId} /><span className="db-resize" role="separator" aria-label={"Resize " + property.name + " column"} onPointerDown={resize(property.id, widthOf(i))} /></th>)}
      <th className="db-add-col"><AddProperty databaseId={databaseId} properties={data.properties} readOnly={readOnly} act={act} /></th>
    </tr></thead>
    <tbody>
      {groups ? groups.map(group => <GroupBody key={group.key || "none"} group={group} span={span} render={renderRow} />) : data.rows.map(renderRow)}
    </tbody>
    <tfoot><tr className={hasCalc ? "has-calc" : ""}>
      <td className="db-title-col" style={frozenStyle(-1)} />
      {columns.map((property, i) => { const fn = calc[property.id]; return <td key={property.id} style={frozenStyle(i)}>
        <Popover className="db-calc" summaryLabel={"Calculate " + property.name} summary={fn ? <span className="db-calc-value"><em>{CALC_LABELS[fn]}</em> {computeCalc(fn, data.rows, property)}</span> : <span className="db-calc-empty">Calculate</span>} menuClass="db-options">
          {[undefined, ...calcOptions(property.type)].map(option => <button key={option ?? "none"} disabled={readOnly} aria-selected={option === fn} onClick={e => { closeOf(e); void patch({ calc: { ...calc, [property.id]: option } as Record<string, CalcFn> }); }}>{option ? CALC_LABELS[option] : "None"}</button>)}
        </Popover></td>; })}
      <td className="db-add-col" />
    </tr></tfoot>
  </table>{!data.rows.length && <p className="hint db-empty">No rows to show.</p>}</div>;
}

/** Copy a row: its values and its full page body. Automatic (time) columns are not copied; the copy gets its own. */
async function duplicateRow(databaseId: string, row: Row, properties: Property[]) {
  const note = await invoke<{ updates: number[][] }>("load_note", { pageId: row.id });
  const doc = new Y.Doc();
  try {
    for (const update of note.updates) Y.applyUpdate(doc, Uint8Array.from(update));
    const copy = await invoke<Row>("add_row", { databaseId, initialUpdate: Array.from(Y.encodeStateAsUpdate(doc)) });
    if (row.title !== "Untitled") await invoke("rename_page", { pageId: copy.id, title: row.title });
    for (const property of properties) {
      const value = row.values[property.id];
      if (isComputedKind(property.type) || value === undefined || value === null) continue;
      await invoke("set_value", { rowId: copy.id, propertyId: property.id, value });
    }
  } finally { doc.destroy(); }
}

function GroupBody({ group, span, render }: { group: { key: string; label: string; rows: Row[]; color?: string }; span: number; render: (row: Row) => ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return <>
    <tr className="db-group-row"><td colSpan={span}><button aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}>{collapsed ? "▸" : "▾"} {group.color ? <Chip option={{ id: group.key, name: group.label, color: group.color }} /> : <strong>{group.label}</strong>} <span className="db-count">{group.rows.length}</span></button></td></tr>
    {!collapsed && group.rows.map(render)}
  </>;
}

function Cell({ property, value, wrap, readOnly, onChange, onError, linked }: { property: Property; value: unknown; wrap: boolean; readOnly: boolean; onChange: (value: unknown) => void; onError: (e: unknown) => void; linked?: Record<string, string> }) {
  const label = property.name;
  switch (property.type) {
    case "checkbox":
      return <input type="checkbox" className="db-check" aria-label={label} checked={value === true} disabled={readOnly} onChange={e => onChange(e.target.checked)} />;
    case "number":
      return <input type="number" className="db-input" aria-label={label} defaultValue={typeof value === "number" ? value : ""} readOnly={readOnly} key={String(value)}
        onBlur={e => { const text = e.target.value.trim(); const next = text === "" ? null : Number(text); if (next !== (typeof value === "number" ? value : null)) onChange(next); }} />;
    case "date":
      return <input type="date" className="db-input" aria-label={label} defaultValue={typeof value === "string" ? value : ""} readOnly={readOnly} key={String(value)} onChange={e => onChange(e.target.value || null)} />;
    case "select": case "status": {
      const selected = property.options.find(o => o.id === value);
      return <Popover className="db-select" summaryLabel={label} summary={selected ? <Chip option={selected} /> : <span className="db-empty-cell">Empty</span>}>
        <div role="listbox" aria-label={label} className="db-options">
          {!readOnly && <button role="option" aria-selected={!selected} onClick={e => { onChange(null); closeOf(e); }}>Empty</button>}
          {property.options.map(option => <button key={option.id} role="option" aria-selected={option.id === value} disabled={readOnly} onClick={e => { onChange(option.id); closeOf(e); }}><Chip option={option} /></button>)}
        </div>
      </Popover>;
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const chosen = property.options.filter(o => ids.includes(o.id));
      return <Popover className="db-select" summaryLabel={label} summary={chosen.length ? <>{chosen.map(o => <Chip key={o.id} option={o} />)}</> : <span className="db-empty-cell">Empty</span>}>
        <div role="group" aria-label={label} className="db-options">
          {property.options.map(option => <label key={option.id}><input type="checkbox" disabled={readOnly} checked={ids.includes(option.id)} onChange={e => onChange(e.target.checked ? [...ids, option.id] : ids.filter(id => id !== option.id))} /><Chip option={option} /></label>)}
          {!property.options.length && <span className="hint">Add options from the column menu.</span>}
        </div>
      </Popover>;
    }
    case "rollup":
      return <span className="db-auto" aria-label={label} title="Calculated from linked rows">{typeof value === "string" ? value : ""}</span>;
    case "relation":
      return <RelationCell property={property} ids={Array.isArray(value) ? (value as string[]) : []} linked={linked ?? {}} readOnly={readOnly} onChange={onChange} />;
    case "created_time": case "last_edited_time":
      return <span className="db-auto" aria-label={label} title="Filled in automatically">{formatStamp(value)}</span>;
    case "place": {
      const text = formatPlace(value);
      const commit = (el: HTMLInputElement | HTMLTextAreaElement) => { const next = el.value.trim(); if (next === text) return; if (next === "") return onChange(null); const place = parsePlace(next); if (place) onChange(place); else { el.value = text; onError(new Error("Enter a place as latitude, longitude (for example 35.68, 139.69).")); } };
      const common = { className: "db-input" + (wrap ? " db-wrap" : ""), "aria-label": label, placeholder: "lat, lng", title: "Latitude, longitude and an optional name, e.g. 35.68, 139.69, Tokyo", defaultValue: text, readOnly, key: text };
      return wrap ? <textarea rows={1} {...common} onBlur={e => commit(e.target)} /> : <input {...common} onBlur={e => commit(e.target)} />;
    }
    default: {
      const text = typeof value === "string" ? value : "";
      const commit = (el: HTMLInputElement | HTMLTextAreaElement) => { if (el.value !== text) onChange(el.value === "" ? null : el.value); };
      return wrap && property.type === "text"
        ? <textarea rows={1} className="db-input db-wrap" aria-label={label} defaultValue={text} readOnly={readOnly} key={text} onBlur={e => commit(e.target)} />
        : <input type={property.type === "url" ? "url" : property.type === "email" ? "email" : property.type === "phone" ? "tel" : "text"} className="db-input" aria-label={label} defaultValue={text} readOnly={readOnly} key={text} onBlur={e => commit(e.target)} />;
    }
  }
}

type Panel = "main" | "type" | "sort" | "options";
/** The Notion-style column menu: rename, change type, filter, sort, group, calculate, freeze, hide, wrap, insert, duplicate, delete. */
function ColumnHeader({ property, ctx, act, patch, databaseId }: { property: Property; ctx: ViewContext; act: Act; patch: Patch; databaseId: string }) {
  const { readOnly, view } = ctx;
  const config = view.config;
  const [panel, setPanel] = useState<Panel>("main");
  const [option, setOption] = useState("");
  const wrapped = (config.wrap ?? []).includes(property.id);
  const frozen = config.frozen === property.id;
  const sorts = config.sorts ?? [];
  const insert = (side: "left" | "right") => (e: React.MouseEvent) => { closeOf(e); void act(() => invoke("add_property", { databaseId, name: "Property", kind: "text", near: property.id, side })); };
  const sortBy = (dir: Sort["dir"]) => (e: React.MouseEvent) => { closeOf(e); setPanel("main"); void patch({ sorts: [...sorts.filter(s => s.p !== property.id), { p: property.id, dir }] }); };
  const item = (label: string, onClick: (e: React.MouseEvent) => void, extra?: { danger?: boolean; disabled?: boolean; hint?: string }) =>
    <button className={extra?.danger ? "danger" : ""} disabled={readOnly || extra?.disabled} onClick={onClick}><span>{label}</span>{extra?.hint && <em>{extra.hint}</em>}</button>;
  return <Popover className="db-header" summaryLabel={"Column " + property.name} summary={<><span className="db-kind" aria-hidden="true">{KIND_ICON[property.type]}</span>{property.name}</>} menuClass="db-column-menu">
    {panel === "main" && <>
      <input className="db-rename" aria-label={"Rename " + property.name} defaultValue={property.name} disabled={readOnly} key={property.name}
        onBlur={e => { const name = e.target.value.trim(); if (name && name !== property.name) void act(() => invoke("rename_property", { propertyId: property.id, name })); else e.target.value = property.name; }}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      {isSelectLike(property.type) && <>
        <div className="db-chips">{property.options.map(o => <Chip key={o.id} option={o} />)}</div>
        {item("Edit options", () => setPanel("options"), { hint: property.options.length + " ›" })}
        <input aria-label="Add option" value={option} placeholder="Add option…" disabled={readOnly} onChange={e => setOption(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && option.trim()) { const color = COLORS[property.options.length % COLORS.length]; void act(() => invoke("add_select_option", { propertyId: property.id, name: option, color })); setOption(""); } }} />
      </>}
      <hr />
      {item("Change type", () => setPanel("type"), { hint: (KINDS.find(k => k.type === property.type)?.label ?? (property.type === "relation" ? "Relation" : "Rollup")) + " ›", disabled: property.type === "relation" || property.type === "rollup" })}
      {item("Filter", e => { closeOf(e); void patch({ filters: [...(config.filters ?? []), { p: property.id, op: OPS[property.type][0].op }] }); }, { disabled: (config.filters ?? []).length >= 10 })}
      {item("Sort", () => setPanel("sort"), { hint: "›", disabled: property.type === "multi_select" })}
      {item(config.groupBy === property.id ? "Remove grouping" : "Group", e => { closeOf(e); void patch({ groupBy: config.groupBy === property.id ? undefined : property.id }); }, { disabled: !groupable(property.type) })}
      {item("Calculate", e => { closeOf(e); void patch({ calc: { ...(config.calc ?? {}), [property.id]: config.calc?.[property.id] ?? calcOptions(property.type)[0] } as Record<string, CalcFn> }); })}
      {item(frozen ? "Unfreeze columns" : "Freeze up to here", e => { closeOf(e); void patch({ frozen: frozen ? undefined : property.id }); })}
      {item("Hide", e => { closeOf(e); void patch({ hidden: [...(config.hidden ?? []), property.id], frozen: frozen ? undefined : config.frozen }); })}
      {item(wrapped ? "Unwrap content" : "Wrap content", e => { closeOf(e); void patch({ wrap: wrapped ? (config.wrap ?? []).filter(id => id !== property.id) : [...(config.wrap ?? []), property.id] }); }, { disabled: !["text", "place"].includes(property.type) })}
      <hr />
      {item("Insert left", insert("left"))}
      {item("Insert right", insert("right"))}
      {item("Duplicate property", e => { closeOf(e); void act(() => invoke("duplicate_property", { propertyId: property.id })); }, { disabled: property.type === "relation" || property.type === "rollup" })}
      {item("Delete property", e => { if (window.confirm("Delete the “" + property.name + "” property? Its values stay in your file, but the column is removed.")) { closeOf(e); void act(() => invoke("delete_property", { propertyId: property.id })); } }, { danger: true })}
    </>}
    {panel === "type" && <>
      <button className="db-back" onClick={() => setPanel("main")}>‹ Change type</button>
      {KINDS.map(k => <button key={k.type} aria-selected={k.type === property.type} disabled={readOnly} onClick={e => { closeOf(e); setPanel("main"); void act(() => invoke("change_property_type", { propertyId: property.id, kind: k.type })); }}>{k.label}{k.type === property.type ? " ✓" : ""}</button>)}
      <p className="hint db-menu-note">Existing values are converted when nothing would be lost; otherwise the change is refused.</p>
    </>}
    {panel === "options" && <>
      <button className="db-back" onClick={() => setPanel("main")}>‹ Options</button>
      {property.options.map(o => <div key={o.id} className="db-option-row">
        <select aria-label={"Colour of " + o.name} value={o.color} disabled={readOnly} data-color={o.color} onChange={e => void act(() => invoke("update_select_option", { optionId: o.id, color: e.target.value }))}>{COLORS.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <input aria-label={"Name of option " + o.name} defaultValue={o.name} disabled={readOnly} key={o.name} onBlur={e => { const name = e.target.value.trim(); if (name && name !== o.name) void act(() => invoke("update_select_option", { optionId: o.id, name })); else e.target.value = o.name; }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <button aria-label={"Delete option " + o.name} disabled={readOnly} onClick={() => { if (window.confirm("Delete the “" + o.name + "” option? Rows using it will lose that value.")) void act(() => invoke("delete_select_option", { optionId: o.id })); }}>×</button>
      </div>)}
      {!property.options.length && <p className="hint db-menu-note">No options yet. Add one from the column menu.</p>}
    </>}
    {panel === "sort" && <>
      <button className="db-back" onClick={() => setPanel("main")}>‹ Sort</button>
      <button disabled={readOnly} onClick={sortBy("asc")}>Ascending</button>
      <button disabled={readOnly} onClick={sortBy("desc")}>Descending</button>
      {sorts.some(s => s.p === property.id) && <button disabled={readOnly} onClick={e => { closeOf(e); setPanel("main"); void patch({ sorts: sorts.filter(s => s.p !== property.id) }); }}>Remove sort</button>}
    </>}
  </Popover>;
}

type NewKind = Kind | "relation" | "rollup";
const ROLLUP_FNS: { fn: string; label: string }[] = [
  { fn: "count", label: "Count all" }, { fn: "count_values", label: "Count values" }, { fn: "count_empty", label: "Count empty" }, { fn: "count_not_empty", label: "Count not empty" },
  { fn: "percent_empty", label: "Percent empty" }, { fn: "percent_not_empty", label: "Percent not empty" }, { fn: "sum", label: "Sum" }, { fn: "average", label: "Average" },
  { fn: "median", label: "Median" }, { fn: "min", label: "Min" }, { fn: "max", label: "Max" }, { fn: "range", label: "Range" }, { fn: "earliest", label: "Earliest date" },
  { fn: "latest", label: "Latest date" }, { fn: "checked", label: "Checked" }, { fn: "unchecked", label: "Unchecked" }, { fn: "percent_checked", label: "Percent checked" }, { fn: "show_original", label: "Show original" },
];

/** New column form. Relation and rollup need a target, so they show extra pickers instead of just a name and type. */
function AddProperty({ databaseId, properties, readOnly, act }: { databaseId: string; properties: Property[]; readOnly: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NewKind>("text");
  const [databases, setDatabases] = useState<{ id: string; title: string }[]>([]);
  const [target, setTarget] = useState("");
  const [twoWay, setTwoWay] = useState(true);
  const [relationId, setRelationId] = useState("");
  const [targetProps, setTargetProps] = useState<{ id: string; name: string; type: Kind }[]>([]);
  const [rolled, setRolled] = useState("title");
  const [fn, setFn] = useState("count");
  const relations = useMemo(() => properties.filter(p => p.type === "relation"), [properties]);
  useEffect(() => { if (kind === "relation" && !databases.length) void invoke<{ id: string; title: string }[]>("list_databases").then(list => { setDatabases(list); setTarget(t => t || list.find(d => d.id !== databaseId)?.id || list[0]?.id || ""); }).catch(() => undefined); }, [kind, databases.length, databaseId]);
  useEffect(() => { if (kind === "rollup" && !relationId && relations[0]) setRelationId(relations[0].id); }, [kind, relationId, relations]);
  useEffect(() => {
    const related = relations.find(p => p.id === relationId)?.config?.target;
    if (kind !== "rollup" || !related) { setTargetProps(t => (t.length ? [] : t)); return; }
    let cancelled = false;
    void invoke<DatabaseData | null>("get_database", { pageId: related }).then(d => { if (!cancelled && d) setTargetProps(d.properties.filter(p => !["relation", "rollup", "created_time", "last_edited_time"].includes(p.type))); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [kind, relationId, relations]);
  const ready = name.trim() && (kind === "relation" ? !!target : kind === "rollup" ? !!relationId : true);
  const create = (event?: React.SyntheticEvent) => {
    if (!ready) return;
    if (event) closeOf(event);
    const trimmed = name.trim();
    void act(() => kind === "relation" ? invoke("add_relation", { databaseId, name: trimmed, targetId: target, twoWay })
      : kind === "rollup" ? invoke("add_rollup", { databaseId, name: trimmed, relationId, property: rolled, function: fn })
      : invoke("add_property", { databaseId, name: trimmed, kind }));
    setName(""); setKind("text");
  };
  return <Popover className="db-add-property" summaryLabel="Add a property" summary={<span title="Add a property">+</span>} menuClass="db-add-menu db-add-wide">
    <input aria-label="Property name" placeholder="Property name" value={name} disabled={readOnly} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") create(e); }} />
    <select aria-label="Property type" value={kind} onChange={e => setKind(e.target.value as NewKind)}>{[...KINDS, { type: "relation" as const, label: "Relation" }, { type: "rollup" as const, label: "Rollup" }].map(k => <option key={k.type} value={k.type}>{k.label}</option>)}</select>
    {kind === "relation" && <>
      <select aria-label="Related database" value={target} onChange={e => setTarget(e.target.value)}>{databases.map(d => <option key={d.id} value={d.id}>{d.title}{d.id === databaseId ? " (this database)" : ""}</option>)}</select>
      <label className="db-inline"><input type="checkbox" checked={twoWay} onChange={e => setTwoWay(e.target.checked)} /> Show on the related database too</label>
    </>}
    {kind === "rollup" && (relations.length === 0 ? <p className="hint db-menu-note">Add a relation column first; a rollup summarises the pages it links to.</p> : <>
      <select aria-label="Relation to roll up" value={relationId} onChange={e => { setRelationId(e.target.value); setRolled("title"); }}>{relations.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <select aria-label="Property to roll up" value={rolled} onChange={e => setRolled(e.target.value)}><option value="title">Name</option>{targetProps.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <select aria-label="Calculation" value={fn} onChange={e => setFn(e.target.value)}>{ROLLUP_FNS.map(f => <option key={f.fn} value={f.fn}>{f.label}</option>)}</select>
    </>)}
    <button onClick={create} disabled={readOnly || !ready}>Add property</button>
  </Popover>;
}

/** Linked pages shown as chips; the menu lists the related database's rows with check boxes. */
function RelationCell({ property, ids, linked, readOnly, onChange }: { property: Property; ids: string[]; linked: Record<string, string>; readOnly: boolean; onChange: (value: unknown) => void }) {
  const [rows, setRows] = useState<{ id: string; title: string }[] | null>(null);
  const [query, setQuery] = useState("");
  const target = property.config?.target;
  return <Popover className="db-select" lazy summaryLabel={property.name}
    summary={ids.length ? <>{ids.map(id => <span key={id} className="db-link-chip">{linked[id] ?? "Untitled"}</span>)}</> : <span className="db-empty-cell">Empty</span>}>
    <RelationPicker target={target} ids={ids} rows={rows} setRows={setRows} query={query} setQuery={setQuery} readOnly={readOnly} onChange={onChange} />
  </Popover>;
}
function RelationPicker({ target, ids, rows, setRows, query, setQuery, readOnly, onChange }: { target?: string; ids: string[]; rows: { id: string; title: string }[] | null; setRows: (r: { id: string; title: string }[]) => void; query: string; setQuery: (q: string) => void; readOnly: boolean; onChange: (value: unknown) => void }) {
  useEffect(() => { if (target) void invoke<{ id: string; title: string }[]>("list_rows", { databaseId: target }).then(setRows).catch(() => setRows([])); }, [target, setRows]);
  const needle = query.trim().toLowerCase();
  const shown = (rows ?? []).filter(r => !needle || r.title.toLowerCase().includes(needle));
  return <div className="db-options" role="group" aria-label="Linked pages">
    <input aria-label="Search linked pages" placeholder="Search pages…" value={query} onChange={e => setQuery(e.target.value)} />
    {rows === null && <span className="hint">Loading…</span>}
    {shown.map(r => <label key={r.id}><input type="checkbox" disabled={readOnly} checked={ids.includes(r.id)} onChange={e => onChange(e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id))} />{r.title}</label>)}
    {rows !== null && !shown.length && <span className="hint">No pages found.</span>}
  </div>;
}

export type { ViewType };
