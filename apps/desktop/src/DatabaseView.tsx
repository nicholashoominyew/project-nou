import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useDismiss } from "./Dismissible";
import { newRichUpdate } from "./richUpdate";
import { BoardView, CalendarView, GalleryView, ListView, TimelineView } from "./DatabaseViews";
import { Chip, VIEW_TYPES, defaultConfig, isSelectLike, type Act, type DatabaseData, type Kind, type Property, type Row, type View, type ViewConfig, type ViewContext, type ViewType } from "./dbShared";

const NoteEditor = lazy(() => import("./NoteEditor"));
const KINDS: { type: Kind; label: string }[] = [
  { type: "text", label: "Text" }, { type: "number", label: "Number" }, { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" }, { type: "status", label: "Status" }, { type: "date", label: "Date" },
  { type: "checkbox", label: "Checkbox" }, { type: "url", label: "URL" },
];
const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/**
 * A disclosure whose menu is positioned against the window (not the table), so the table's own scrolling
 * can never clip it. Closes on outside click, Escape or scroll.
 */
function Popover({ className, summary, summaryLabel, menuClass, children }: { className?: string; summary: ReactNode; summaryLabel: string; menuClass?: string; children: ReactNode }) {
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
      setAt({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)), top: below > 260 ? rect.bottom + 4 : Math.max(8, rect.top - 264) });
    }
  }
  return <details ref={ref} className={className} onToggle={toggled}>
    <summary aria-label={summaryLabel}>{summary}</summary>
    <div className={"db-menu " + (menuClass ?? "")} style={{ left: at.left, top: at.top }}>{children}</div>
  </details>;
}
const closeOf = (event: React.MouseEvent) => { const details = (event.currentTarget as HTMLElement).closest("details"); if (details) details.open = false; };

export default function Database({ databaseId, readOnly, onError }: { databaseId: string; readOnly: boolean; onError: (e: unknown) => void }) {
  const [data, setData] = useState<DatabaseData | null>(null);
  const [failed, setFailed] = useState("");
  const [activeId, setActiveId] = useState("");
  const [peek, setPeek] = useState<Row | null>(null);
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
  const ctx: ViewContext = { data, view, readOnly, open: setPeek, setValue, addRow };

  return <div className="db">
    <input className="db-name" aria-label="Database title" defaultValue={data.title} readOnly={readOnly} key={data.title}
      onBlur={e => { const title = e.target.value.trim(); if (title && title !== data.title) void act(() => invoke("rename_page", { pageId: databaseId, title })); else e.target.value = data.title; }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    <ViewTabs data={data} active={view} select={setActiveId} readOnly={readOnly} act={act} databaseId={databaseId} />
    <ViewSettings data={data} view={view} readOnly={readOnly} act={act} />
    {view.type === "table" && <TableView ctx={ctx} act={act} databaseId={databaseId} />}
    {view.type === "board" && <BoardView ctx={ctx} />}
    {view.type === "list" && <ListView ctx={ctx} />}
    {view.type === "gallery" && <GalleryView ctx={ctx} />}
    {view.type === "calendar" && <CalendarView ctx={ctx} />}
    {view.type === "timeline" && <TimelineView ctx={ctx} />}
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
      {VIEW_TYPES.map(t => <button key={t.type} disabled={readOnly} onClick={e => { closeOf(e); void act(async () => { const view = await invoke<View>("add_view", { databaseId, name: t.label, kind: t.type, config: defaultConfig(t.type, data.properties) }); select(view.id); }); }}>{t.label}</button>)}
    </Popover>
    <Popover className="db-tab-more" summaryLabel="View options" summary={<span title="View options">⋯</span>} menuClass="db-column-menu">
      <label>Rename view<input value={name} placeholder={active.name} disabled={readOnly} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && name.trim()) { void act(() => invoke("update_view", { viewId: active.id, name })); setName(""); } }} /></label>
      <button className="danger" disabled={readOnly || data.views.length < 2} onClick={() => { if (window.confirm("Remove the “" + active.name + "” view? Your rows are not affected.")) void act(async () => { await invoke("delete_view", { viewId: active.id }); select(""); }); }}>Remove view</button>
    </Popover>
  </div>;
}

function ViewSettings({ data, view, readOnly, act }: { data: DatabaseData; view: View; readOnly: boolean; act: Act }) {
  const pick = (key: keyof ViewConfig, kinds: Kind[], label: string, optional = false) => {
    const choices = data.properties.filter(p => kinds.includes(p.type));
    return <label className="db-setting">{label}
      <select value={view.config[key] ?? ""} disabled={readOnly} onChange={e => { const config: ViewConfig = { ...view.config, [key]: e.target.value || undefined }; void act(() => invoke("update_view", { viewId: view.id, config: { groupBy: config.groupBy ?? null, dateBy: config.dateBy ?? null, endBy: config.endBy ?? null } })); }}>
        <option value="">{optional ? "None" : "Choose…"}</option>{choices.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>;
  };
  if (view.type === "board") return <div className="db-settings">{pick("groupBy", ["select", "status"], "Group by")}</div>;
  if (view.type === "calendar") return <div className="db-settings">{pick("dateBy", ["date"], "Show by")}</div>;
  if (view.type === "timeline") return <div className="db-settings">{pick("dateBy", ["date"], "Start")}{pick("endBy", ["date"], "End", true)}</div>;
  return null;
}

function TableView({ ctx, act, databaseId }: { ctx: ViewContext; act: Act; databaseId: string }) {
  const { data, readOnly } = ctx;
  return <div className="db-scroll"><table className="db-table">
    <thead><tr>
      <th className="db-title-col">Name</th>
      {data.properties.map(property => <th key={property.id}><ColumnHeader property={property} readOnly={readOnly} act={act} /></th>)}
      <th className="db-add-col"><AddProperty databaseId={databaseId} readOnly={readOnly} act={act} /></th>
    </tr></thead>
    <tbody>
      {data.rows.map(row => <tr key={row.id}>
        <td className="db-title-col"><div className="db-title-cell">
          <input className="db-input db-title-input" aria-label={"Title of " + row.title} defaultValue={row.title} readOnly={readOnly} key={row.id + row.title}
            onBlur={e => { const title = e.target.value.trim(); if (title && title !== row.title) void act(() => invoke("rename_page", { pageId: row.id, title })); else e.target.value = row.title; }}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          <button className="db-open" aria-label={"Open " + row.title} title="Open page" onClick={() => ctx.open(row)}>Open</button>
        </div></td>
        {data.properties.map(property => <td key={property.id}><Cell property={property} value={row.values[property.id]} readOnly={readOnly} onChange={value => void ctx.setValue(row, property, value)} /></td>)}
        <td className="db-add-col"><button className="db-row-remove" aria-label={"Move " + row.title + " to Trash"} title="Move to Trash" disabled={readOnly} onClick={() => void act(() => invoke("trash_page", { pageId: row.id }))}>×</button></td>
      </tr>)}
    </tbody>
  </table>{!data.rows.length && <p className="hint db-empty">No rows yet.</p>}</div>;
}

function Cell({ property, value, readOnly, onChange }: { property: Property; value: unknown; readOnly: boolean; onChange: (value: unknown) => void }) {
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
    default:
      return <input type={property.type === "url" ? "url" : "text"} className="db-input" aria-label={label} defaultValue={typeof value === "string" ? value : ""} readOnly={readOnly} key={String(value)}
        onBlur={e => { const text = e.target.value; if (text !== (typeof value === "string" ? value : "")) onChange(text === "" ? null : text); }} />;
  }
}

function ColumnHeader({ property, readOnly, act }: { property: Property; readOnly: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [option, setOption] = useState("");
  return <Popover className="db-header" summaryLabel={"Column " + property.name} summary={property.name} menuClass="db-column-menu">
    <label>Rename<input value={name} placeholder={property.name} disabled={readOnly} onChange={e => setName(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter" && name.trim()) { void act(() => invoke("rename_property", { propertyId: property.id, name })); setName(""); } }} /></label>
    {isSelectLike(property.type) && <>
      <label>Add option<input value={option} placeholder="Option name" disabled={readOnly} onChange={e => setOption(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && option.trim()) { const color = COLORS[property.options.length % COLORS.length]; void act(() => invoke("add_select_option", { propertyId: property.id, name: option, color })); setOption(""); } }} /></label>
      <div className="db-chips">{property.options.map(o => <Chip key={o.id} option={o} />)}</div>
    </>}
    <button className="danger" disabled={readOnly} onClick={() => { if (window.confirm("Hide the “" + property.name + "” column? Its values stay in your file.")) void act(() => invoke("delete_property", { propertyId: property.id })); }}>Hide column</button>
  </Popover>;
}

function AddProperty({ databaseId, readOnly, act }: { databaseId: string; readOnly: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("text");
  const create = (event?: React.SyntheticEvent) => { const trimmed = name.trim(); if (!trimmed) return; if (event) closeOf(event as React.MouseEvent); void act(() => invoke("add_property", { databaseId, name: trimmed, kind })); setName(""); setKind("text"); };
  return <Popover className="db-add-property" summaryLabel="Add a property" summary={<span title="Add a property">+</span>} menuClass="db-add-menu">
    <input aria-label="Property name" placeholder="Property name" value={name} disabled={readOnly} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") create(e); }} />
    <select aria-label="Property type" value={kind} onChange={e => setKind(e.target.value as Kind)}>{KINDS.map(k => <option key={k.type} value={k.type}>{k.label}</option>)}</select>
    <button onClick={create} disabled={readOnly || !name.trim()}>Add property</button>
  </Popover>;
}

export type { ViewType };
