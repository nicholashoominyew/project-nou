import type { ReactNode } from "react";

export type Option = { id: string; name: string; color: string };
export type Kind = "text" | "number" | "select" | "multi_select" | "status" | "date" | "checkbox" | "url" | "place" | "email" | "phone" | "created_time" | "last_edited_time" | "relation" | "rollup";
export type PropertyConfig = { target?: string; reverse?: string | null; relation?: string; property?: string; fn?: string };
export type Property = { id: string; name: string; type: Kind; options: Option[]; config?: PropertyConfig };
export type Row = { id: string; title: string; values: Record<string, unknown> };
export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "map";
import type { CalcFn, Filter, Sort } from "./dbLogic";
export type ViewConfig = {
  groupBy?: string; dateBy?: string; endBy?: string; placeBy?: string; frozen?: string; filterMode?: "and" | "or"; widths?: Record<string, number>;
  sorts?: Sort[]; filters?: Filter[]; hidden?: string[]; wrap?: string[]; calc?: Record<string, CalcFn>;
};
export type View = { id: string; name: string; type: ViewType; config: ViewConfig };
export type DatabaseData = { title: string; properties: Property[]; rows: Row[]; views: View[]; linked?: Record<string, string> };
export type Act = (work: () => Promise<unknown>) => Promise<void>;
/** What every view needs: the data plus the few things it may do to it. */
export type ViewContext = {
  data: DatabaseData; view: View; readOnly: boolean;
  open: (row: Row) => void;
  setValue: (row: Row, property: Property, value: unknown) => Promise<void>;
  addRow: (values?: Record<string, unknown>, title?: string) => Promise<void>;
  onError: (e: unknown) => void;
};

export const VIEW_TYPES: { type: ViewType; label: string }[] = [
  { type: "table", label: "Table" }, { type: "board", label: "Board" }, { type: "list", label: "List" },
  { type: "gallery", label: "Gallery" }, { type: "calendar", label: "Calendar" }, { type: "timeline", label: "Timeline" }, { type: "map", label: "Map" },
];
/** Properties that hold a date a calendar or timeline can use. */
export const isDateLike = (kind: Kind) => kind === "date" || kind === "created_time" || kind === "last_edited_time";
export const isAutomatic = (kind: Kind) => kind === "created_time" || kind === "last_edited_time";
/** Values the app computes itself (times, rollups): shown read-only and never copied or written. */
export const isComputedKind = (kind: Kind) => isAutomatic(kind) || kind === "rollup";
/** Short glyph shown before a column name, like Notion's property-type icons. */
export const KIND_ICON: Record<Kind, string> = {
  text: "Aa", number: "#", select: "◉", multi_select: "☷", status: "◔", date: "▦", checkbox: "☑", url: "↗", place: "⌖",
  email: "@", phone: "✆", created_time: "◷", last_edited_time: "◶", relation: "↔", rollup: "Σ",
};
export function formatStamp(value: unknown): string { const d = typeof value === "string" ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""; }
export const isSelectLike = (kind: Kind) => kind === "select" || kind === "status" || kind === "multi_select";

export function Chip({ option }: { option: Option }) { return <span className="db-chip" data-color={option.color}>{option.name}</span>; }

/** `YYYY-MM-DD` part of a stored date, or null. */
export function dateOf(value: unknown): string | null { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null; }
export const dayNumber = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
export const fromDay = (day: number) => new Date(day * 864e5).toISOString().slice(0, 10);

/** Read-only rendering of a cell value for cards and list rows. */
export function Summary({ property, value, linked }: { property: Property; value: unknown; linked?: Record<string, string> }): ReactNode {
  if (value === undefined || value === null || value === "") return null;
  if (property.type === "relation") { const ids = Array.isArray(value) ? (value as string[]) : []; return ids.length ? <span className="db-plain">{ids.map(id => linked?.[id] ?? "Untitled").join(", ")}</span> : null; }
  if (property.type === "select" || property.type === "status") { const o = property.options.find(x => x.id === value); return o ? <Chip option={o} /> : null; }
  if (property.type === "multi_select") { const ids = Array.isArray(value) ? value : []; return <>{property.options.filter(o => ids.includes(o.id)).map(o => <Chip key={o.id} option={o} />)}</>; }
  if (property.type === "checkbox") return <span>{value === true ? "☑" : "☐"} {property.name}</span>;
  if (property.type === "place") return <span className="db-plain">{formatPlace(value)}</span>;
  if (isAutomatic(property.type)) return <span className="db-plain">{formatStamp(value)}</span>;
  return <span className="db-plain">{String(value)}</span>;
}

/** Properties worth showing on a card: everything except the one that already places the card. */
export function cardProperties(ctx: ViewContext, row: Row, skip: (string | undefined)[] = []) {
  return ctx.data.properties.filter(p => !skip.includes(p.id) && row.values[p.id] !== undefined && row.values[p.id] !== null && row.values[p.id] !== "" && !(Array.isArray(row.values[p.id]) && (row.values[p.id] as unknown[]).length === 0));
}

/** Sensible starting settings when a view of this type is created. */
export function defaultConfig(type: ViewType, properties: Property[]): ViewConfig {
  if (type === "board") { const p = properties.find(x => x.type === "status") ?? properties.find(x => x.type === "select"); return p ? { groupBy: p.id } : {}; }
  if (type === "calendar" || type === "timeline") { const p = properties.find(x => x.type === "date") ?? properties.find(x => isDateLike(x.type)); return p ? { dateBy: p.id } : {}; }
  if (type === "map") { const p = properties.find(x => x.type === "place"); return p ? { placeBy: p.id } : {}; }
  return {};
}

export type Place = { lat: number; lng: number; name?: string; address?: string };
export const isPlace = (value: unknown): value is Place => !!value && typeof value === "object" && typeof (value as Place).lat === "number" && typeof (value as Place).lng === "number";
export function formatPlace(value: unknown): string {
  if (!isPlace(value)) return "";
  const coords = `${+value.lat.toFixed(5)}, ${+value.lng.toFixed(5)}`;
  // A place found by name shows its name; a bare coordinate shows the numbers. Coordinates are always in the tooltip.
  return value.name || value.address?.split(",")[0]?.trim() || coords;
}
/** Accepts "35.68, 139.69" (as copied from most map apps) with an optional ", Name". Returns null when it is not a valid coordinate. */
export function parsePlace(text: string): Place | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)(?:\s*[,;]\s*(.+))?$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const name = m[3]?.trim();
  return name ? { lat, lng, name: name.slice(0, 100) } : { lat, lng };
}
