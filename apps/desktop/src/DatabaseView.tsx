import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DismissibleDetails, useDismiss } from "./Dismissible";
import { newRichUpdate } from "./richUpdate";

type Option = { id: string; name: string; color: string };
type Kind = "text" | "number" | "select" | "multi_select" | "status" | "date" | "checkbox" | "url";
type Property = { id: string; name: string; type: Kind; options: Option[] };
type Row = { id: string; title: string; values: Record<string, unknown> };
export type DatabaseData = { properties: Property[]; rows: Row[] };

const KINDS: { type: Kind; label: string }[] = [
  { type: "text", label: "Text" }, { type: "number", label: "Number" }, { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" }, { type: "status", label: "Status" }, { type: "date", label: "Date" },
  { type: "checkbox", label: "Checkbox" }, { type: "url", label: "URL" },
];
const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/**
 * Opens a page as a database when it is one, otherwise renders `note` (the normal editor).
 * `renderNote` is also used for the row side-peek so each row keeps its full rich-text page.
 */
export default function PageBody({ pageId, readOnly, onError, renderNote }: { pageId: string; readOnly: boolean; onError: (e: unknown) => void; renderNote: (pageId: string, title: string) => ReactNode }) {
  const [state, setState] = useState<"loading" | "note" | DatabaseData>("loading");
  const load = useCallback(async () => {
    const view = await invoke<DatabaseData | null>("get_database", { pageId });
    setState(view ?? "note");
  }, [pageId]);
  useEffect(() => { setState("loading"); void load().catch(() => setState("note")); }, [load]);
  if (state === "loading") return <p role="status">Opening…</p>;
  if (state === "note") return <>{renderNote(pageId, "")}</>;
  return <DatabaseTable databaseId={pageId} data={state} readOnly={readOnly} reload={load} onError={onError} renderNote={renderNote} />;
}

function DatabaseTable({ databaseId, data, readOnly, reload, onError, renderNote }: { databaseId: string; data: DatabaseData; readOnly: boolean; reload: () => Promise<void>; onError: (e: unknown) => void; renderNote: (pageId: string, title: string) => ReactNode }) {
  const [peek, setPeek] = useState<Row | null>(null);
  // Run a write, then refresh from the database so the table always shows what was actually saved.
  const act = useCallback(async (work: () => Promise<unknown>) => {
    try { await work(); await reload(); } catch (e) { onError(e); await reload().catch(() => undefined); }
  }, [reload, onError]);
  const setValue = (row: Row, property: Property, value: unknown) => act(() => invoke("set_value", { rowId: row.id, propertyId: property.id, value }));

  return <div className="db">
    <div className="db-scroll"><table className="db-table">
      <thead><tr>
        <th className="db-title-col">Name</th>
        {data.properties.map(property => <th key={property.id}><ColumnHeader property={property} readOnly={readOnly} act={act} /></th>)}
        <th className="db-add-col"><AddProperty databaseId={databaseId} readOnly={readOnly} act={act} /></th>
      </tr></thead>
      <tbody>
        {data.rows.map(row => <tr key={row.id}>
          <td className="db-title-col"><div className="db-title-cell">
            <RowTitle row={row} readOnly={readOnly} act={act} />
            <button className="db-open" aria-label={"Open " + row.title} title="Open page" onClick={() => setPeek(row)}>Open</button>
          </div></td>
          {data.properties.map(property => <td key={property.id}><Cell property={property} value={row.values[property.id]} readOnly={readOnly} onChange={value => setValue(row, property, value)} /></td>)}
          <td className="db-add-col"><button className="db-row-remove" aria-label={"Move " + row.title + " to Trash"} title="Move to Trash" disabled={readOnly} onClick={() => void act(() => invoke("trash_page", { pageId: row.id }))}>×</button></td>
        </tr>)}
      </tbody>
    </table></div>
    {!data.rows.length && <p className="hint db-empty">No rows yet.</p>}
    <button className="db-new-row" disabled={readOnly} onClick={() => void act(async () => invoke("add_row", { databaseId, initialUpdate: await newRichUpdate() }))}>+ New row</button>
    {peek && <div className="db-peek" role="dialog" aria-label={"Page " + peek.title}>
      <div className="db-peek-bar"><strong>{peek.title}</strong><button onClick={() => { setPeek(null); void reload(); }}>Close</button></div>
      <div className="db-peek-body" key={peek.id}>{renderNote(peek.id, peek.title)}</div>
    </div>}
  </div>;
}

function RowTitle({ row, readOnly, act }: { row: Row; readOnly: boolean; act: (w: () => Promise<unknown>) => Promise<void> }) {
  return <input className="db-input db-title-input" aria-label={"Title of " + row.title} defaultValue={row.title} readOnly={readOnly} key={row.id + row.title}
    onBlur={e => { const title = e.target.value.trim(); if (title && title !== row.title) void act(() => invoke("rename_page", { pageId: row.id, title })); else e.target.value = row.title; }}
    onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}

function Chip({ option }: { option: Option }) { return <span className="db-chip" data-color={option.color}>{option.name}</span>; }

function Cell({ property, value, readOnly, onChange }: { property: Property; value: unknown; readOnly: boolean; onChange: (value: unknown) => void }) {
  const label = property.name;
  switch (property.type) {
    case "checkbox":
      return <input type="checkbox" className="db-check" aria-label={label} checked={value === true} disabled={readOnly} onChange={e => onChange(e.target.checked)} />;
    case "number":
      return <input type="number" className="db-input" aria-label={label} defaultValue={typeof value === "number" ? value : ""} readOnly={readOnly} key={String(value)}
        onBlur={e => { const text = e.target.value.trim(); const next = text === "" ? null : Number(text); if (next !== (typeof value === "number" ? value : null)) onChange(next); }} />;
    case "date":
      return <input type="date" className="db-input" aria-label={label} defaultValue={typeof value === "string" ? value : ""} readOnly={readOnly} key={String(value)}
        onChange={e => onChange(e.target.value || null)} />;
    case "select": case "status": {
      const selected = property.options.find(o => o.id === value);
      return <DismissibleDetails className="db-select" summaryLabel={label} summary={selected ? <Chip option={selected} /> : <span className="db-empty-cell">Empty</span>}>
        <div className="db-menu" role="listbox" aria-label={label}>
          {!readOnly && <button role="option" aria-selected={!selected} onClick={e => { onChange(null); close(e); }}>Empty</button>}
          {property.options.map(option => <button key={option.id} role="option" aria-selected={option.id === value} disabled={readOnly} onClick={e => { onChange(option.id); close(e); }}><Chip option={option} /></button>)}
        </div>
      </DismissibleDetails>;
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const chosen = property.options.filter(o => ids.includes(o.id));
      return <DismissibleDetails className="db-select" summaryLabel={label} summary={chosen.length ? <>{chosen.map(o => <Chip key={o.id} option={o} />)}</> : <span className="db-empty-cell">Empty</span>}>
        <div className="db-menu" role="group" aria-label={label}>
          {property.options.map(option => <label key={option.id}><input type="checkbox" disabled={readOnly} checked={ids.includes(option.id)}
            onChange={e => onChange(e.target.checked ? [...ids, option.id] : ids.filter(id => id !== option.id))} /><Chip option={option} /></label>)}
          {!property.options.length && <span className="hint">Add options from the column menu.</span>}
        </div>
      </DismissibleDetails>;
    }
    default:
      return <input type={property.type === "url" ? "url" : "text"} className="db-input" aria-label={label} defaultValue={typeof value === "string" ? value : ""} readOnly={readOnly} key={String(value)}
        onBlur={e => { const text = e.target.value; if (text !== (typeof value === "string" ? value : "")) onChange(text === "" ? null : text); }} />;
  }
}
function close(event: React.MouseEvent) { const details = (event.currentTarget as HTMLElement).closest("details"); if (details) details.open = false; }

function ColumnHeader({ property, readOnly, act }: { property: Property; readOnly: boolean; act: (w: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState("");
  const [option, setOption] = useState("");
  const hasOptions = property.type === "select" || property.type === "multi_select" || property.type === "status";
  return <DismissibleDetails className="db-header" summaryLabel={"Column " + property.name} summary={property.name}>
    <div className="db-menu db-column-menu">
      <label>Rename<input value={name} placeholder={property.name} disabled={readOnly} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && name.trim()) { void act(() => invoke("rename_property", { propertyId: property.id, name })); setName(""); } }} /></label>
      {hasOptions && <>
        <label>Add option<input value={option} placeholder="Option name" disabled={readOnly} onChange={e => setOption(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && option.trim()) { const color = COLORS[property.options.length % COLORS.length]; void act(() => invoke("add_select_option", { propertyId: property.id, name: option, color })); setOption(""); } }} /></label>
        <div className="db-chips">{property.options.map(o => <Chip key={o.id} option={o} />)}</div>
      </>}
      <button className="danger" disabled={readOnly} onClick={() => { if (window.confirm("Hide the “" + property.name + "” column? Its values stay in your file.")) void act(() => invoke("delete_property", { propertyId: property.id })); }}>Hide column</button>
    </div>
  </DismissibleDetails>;
}

function AddProperty({ databaseId, readOnly, act }: { databaseId: string; readOnly: boolean; act: (w: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("text");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const create = () => { const trimmed = name.trim(); if (!trimmed) return; void act(() => invoke("add_property", { databaseId, name: trimmed, kind })); setName(""); setKind("text"); setOpen(false); };
  return <div className="db-add-property" ref={ref}>
    <button aria-label="Add a property" title="Add a property" disabled={readOnly} onClick={() => setOpen(v => !v)}>+</button>
    {open && <div className="db-menu db-add-menu" role="dialog" aria-label="New property">
      <input autoFocus aria-label="Property name" placeholder="Property name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") create(); }} />
      <select aria-label="Property type" value={kind} onChange={e => setKind(e.target.value as Kind)}>{KINDS.map(k => <option key={k.type} value={k.type}>{k.label}</option>)}</select>
      <button onClick={create} disabled={!name.trim()}>Add property</button>
    </div>}
  </div>;
}
