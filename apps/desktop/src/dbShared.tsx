import type { ReactNode } from "react";

export type Option = { id: string; name: string; color: string };
export type Kind = "text" | "number" | "select" | "multi_select" | "status" | "date" | "checkbox" | "url";
export type Property = { id: string; name: string; type: Kind; options: Option[] };
export type Row = { id: string; title: string; values: Record<string, unknown> };
export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline";
export type ViewConfig = { groupBy?: string; dateBy?: string; endBy?: string };
export type View = { id: string; name: string; type: ViewType; config: ViewConfig };
export type DatabaseData = { title: string; properties: Property[]; rows: Row[]; views: View[] };
export type Act = (work: () => Promise<unknown>) => Promise<void>;
/** What every view needs: the data plus the few things it may do to it. */
export type ViewContext = {
  data: DatabaseData; view: View; readOnly: boolean;
  open: (row: Row) => void;
  setValue: (row: Row, property: Property, value: unknown) => Promise<void>;
  addRow: (values?: Record<string, unknown>) => Promise<void>;
};

export const VIEW_TYPES: { type: ViewType; label: string }[] = [
  { type: "table", label: "Table" }, { type: "board", label: "Board" }, { type: "list", label: "List" },
  { type: "gallery", label: "Gallery" }, { type: "calendar", label: "Calendar" }, { type: "timeline", label: "Timeline" },
];
export const isSelectLike = (kind: Kind) => kind === "select" || kind === "status" || kind === "multi_select";

export function Chip({ option }: { option: Option }) { return <span className="db-chip" data-color={option.color}>{option.name}</span>; }

/** `YYYY-MM-DD` part of a stored date, or null. */
export function dateOf(value: unknown): string | null { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null; }
export const dayNumber = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
export const fromDay = (day: number) => new Date(day * 864e5).toISOString().slice(0, 10);

/** Read-only rendering of a cell value for cards and list rows. */
export function Summary({ property, value }: { property: Property; value: unknown }): ReactNode {
  if (value === undefined || value === null || value === "") return null;
  if (property.type === "select" || property.type === "status") { const o = property.options.find(x => x.id === value); return o ? <Chip option={o} /> : null; }
  if (property.type === "multi_select") { const ids = Array.isArray(value) ? value : []; return <>{property.options.filter(o => ids.includes(o.id)).map(o => <Chip key={o.id} option={o} />)}</>; }
  if (property.type === "checkbox") return <span>{value === true ? "☑" : "☐"} {property.name}</span>;
  return <span className="db-plain">{String(value)}</span>;
}

/** Properties worth showing on a card: everything except the one that already places the card. */
export function cardProperties(ctx: ViewContext, row: Row, skip: (string | undefined)[] = []) {
  return ctx.data.properties.filter(p => !skip.includes(p.id) && row.values[p.id] !== undefined && row.values[p.id] !== null && row.values[p.id] !== "" && !(Array.isArray(row.values[p.id]) && (row.values[p.id] as unknown[]).length === 0));
}

/** Sensible starting settings when a view of this type is created. */
export function defaultConfig(type: ViewType, properties: Property[]): ViewConfig {
  if (type === "board") { const p = properties.find(x => x.type === "status") ?? properties.find(x => x.type === "select"); return p ? { groupBy: p.id } : {}; }
  if (type === "calendar" || type === "timeline") { const p = properties.find(x => x.type === "date"); return p ? { dateBy: p.id } : {}; }
  return {};
}
