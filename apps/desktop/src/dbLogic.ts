import { dateOf, dayNumber, formatPlace, isPlace, type Kind, type Property, type Row, type ViewConfig } from "./dbShared";

export type FilterOp = "contains" | "not_contains" | "is" | "is_not" | "empty" | "not_empty" | "gt" | "lt" | "gte" | "lte" | "before" | "after" | "checked" | "unchecked";
export type CalcFn = "count" | "count_values" | "count_empty" | "count_not_empty" | "percent_empty" | "percent_not_empty" | "sum" | "average" | "min" | "max" | "median" | "range" | "earliest" | "latest" | "checked" | "unchecked" | "percent_checked";
export type Sort = { p: string; dir: "asc" | "desc" };
export type Filter = { p: string; op: FilterOp; v?: unknown };

const L = (op: FilterOp, label: string) => ({ op, label });
export const OPS: Record<Kind, { op: FilterOp; label: string }[]> = {
  text: [L("contains", "contains"), L("not_contains", "does not contain"), L("is", "is"), L("is_not", "is not"), L("empty", "is empty"), L("not_empty", "is not empty")],
  url: [L("contains", "contains"), L("not_contains", "does not contain"), L("is", "is"), L("is_not", "is not"), L("empty", "is empty"), L("not_empty", "is not empty")],
  number: [L("is", "="), L("is_not", "≠"), L("gt", ">"), L("lt", "<"), L("gte", "≥"), L("lte", "≤"), L("empty", "is empty"), L("not_empty", "is not empty")],
  select: [L("is", "is"), L("is_not", "is not"), L("empty", "is empty"), L("not_empty", "is not empty")],
  status: [L("is", "is"), L("is_not", "is not"), L("empty", "is empty"), L("not_empty", "is not empty")],
  multi_select: [L("contains", "contains"), L("not_contains", "does not contain"), L("empty", "is empty"), L("not_empty", "is not empty")],
  date: [L("is", "is"), L("before", "is before"), L("after", "is after"), L("empty", "is empty"), L("not_empty", "is not empty")],
  checkbox: [L("checked", "is checked"), L("unchecked", "is unchecked")],
  place: [L("empty", "is empty"), L("not_empty", "is not empty")],
  email: [L("contains", "contains"), L("not_contains", "does not contain"), L("is", "is"), L("is_not", "is not"), L("empty", "is empty"), L("not_empty", "is not empty")],
  phone: [L("contains", "contains"), L("not_contains", "does not contain"), L("is", "is"), L("is_not", "is not"), L("empty", "is empty"), L("not_empty", "is not empty")],
  relation: [L("empty", "is empty"), L("not_empty", "is not empty")],
  rollup: [L("contains", "contains"), L("is", "is"), L("is_not", "is not"), L("empty", "is empty"), L("not_empty", "is not empty")],
  created_time: [L("is", "is"), L("before", "is before"), L("after", "is after")],
  last_edited_time: [L("is", "is"), L("before", "is before"), L("after", "is after")],
};
export const needsValue = (op: FilterOp) => !["empty", "not_empty", "checked", "unchecked"].includes(op);

export function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

export function matches(row: Row, property: Property, filter: Filter): boolean {
  const value = row.values[property.id];
  const op = filter.op;
  if (op === "empty") return isEmpty(value);
  if (op === "not_empty") return !isEmpty(value);
  if (op === "checked") return value === true;
  if (op === "unchecked") return value !== true;
  const want = filter.v;
  // An unfinished filter (no value chosen yet) hides nothing.
  if (want === undefined || want === null || want === "") return true;
  switch (property.type) {
    case "text": case "url": case "email": case "phone": case "rollup": {
      const have = String(value ?? "").toLowerCase(), needle = String(want).toLowerCase();
      return op === "contains" ? have.includes(needle) : op === "not_contains" ? !have.includes(needle) : op === "is" ? have === needle : have !== needle;
    }
    case "number": {
      const have = typeof value === "number" ? value : NaN, n = Number(want);
      if (Number.isNaN(have)) return op === "is_not";
      return op === "is" ? have === n : op === "is_not" ? have !== n : op === "gt" ? have > n : op === "lt" ? have < n : op === "gte" ? have >= n : have <= n;
    }
    case "select": case "status":
      return op === "is" ? value === want : value !== want;
    case "multi_select": {
      const has = Array.isArray(value) && value.includes(want);
      return op === "contains" ? has : !has;
    }
    case "date": case "created_time": case "last_edited_time": {
      const have = dateOf(value), day = dateOf(want);
      if (!have || !day) return false;
      const a = dayNumber(have), b = dayNumber(day);
      return op === "is" ? a === b : op === "before" ? a < b : a > b;
    }
    default: return true;
  }
}

function sortKey(row: Row, property: Property): string | number | null {
  const value = row.values[property.id];
  if (isEmpty(value)) return null;
  switch (property.type) {
    case "number": return typeof value === "number" ? value : null;
    case "checkbox": return value === true ? 1 : 0;
    case "select": case "status": { const i = property.options.findIndex(o => o.id === value); return i < 0 ? null : i; }
    case "multi_select": return Array.isArray(value) ? property.options.filter(o => value.includes(o.id)).map(o => o.name.toLowerCase()).join(",") : null;
    case "place": return isPlace(value) ? formatPlace(value).toLowerCase() : null;
    case "relation": return null;
    case "rollup": { const n = Number(value); return String(value) !== "" && !Number.isNaN(n) ? n : String(value).toLowerCase(); }
    default: return String(value).toLowerCase();
  }
}

/** Filters, then sorts (stable; empty values always last). Rows keep their stored order when no sort applies. */
export function visibleRows(rows: Row[], properties: Property[], config: ViewConfig): Row[] {
  const byId = new Map(properties.map(p => [p.id, p]));
  let out = rows;
  const active = (config.filters ?? []).filter(f => byId.has(f.p));
  // "and" (default): every filter must match. "or": any one filter may match.
  if (active.length) out = config.filterMode === "or" ? out.filter(row => active.some(f => matches(row, byId.get(f.p)!, f))) : out.filter(row => active.every(f => matches(row, byId.get(f.p)!, f)));
  const sorts = (config.sorts ?? []).filter(s => byId.has(s.p));
  if (sorts.length) {
    out = [...out].sort((a, b) => {
      for (const sort of sorts) {
        const property = byId.get(sort.p)!;
        const x = sortKey(a, property), y = sortKey(b, property);
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        const c = x < y ? -1 : 1;
        return sort.dir === "asc" ? c : -c;
      }
      return 0;
    });
  }
  return out;
}

export type Group = { key: string; label: string; rows: Row[]; color?: string };
/** Split rows by one property's value (select/status/checkbox/text/number/date). Empty values form the last group. */
export function groupRows(rows: Row[], property: Property): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, label: string, row: Row, color?: string) => { const g = groups.get(key) ?? { key, label, rows: [], color }; g.rows.push(row); groups.set(key, g); };
  if (property.type === "select" || property.type === "status") property.options.forEach(o => groups.set(o.id, { key: o.id, label: o.name, rows: [], color: o.color }));
  if (property.type === "checkbox") { groups.set("true", { key: "true", label: "Checked", rows: [] }); groups.set("false", { key: "false", label: "Unchecked", rows: [] }); }
  for (const row of rows) {
    const value = row.values[property.id];
    if (property.type === "checkbox") add(String(value === true), value === true ? "Checked" : "Unchecked", row);
    else if (isEmpty(value)) add("", "No " + property.name, row);
    else if (property.type === "select" || property.type === "status") { const o = property.options.find(x => x.id === value); if (o) add(o.id, o.name, row, o.color); else add("", "No " + property.name, row); }
    else add(String(value), String(value), row);
  }
  const list = [...groups.values()];
  const rank = (g: Group) => (g.key === "" ? 1 : 0);
  const keepOrder = property.type === "select" || property.type === "status" || property.type === "checkbox";
  return list.filter(g => g.rows.length || keepOrder).sort((a, b) => rank(a) - rank(b) || (keepOrder ? 0 : a.label.localeCompare(b.label, undefined, { numeric: true })));
}
export const groupable = (kind: Kind) => ["select", "status", "checkbox", "text", "number", "date"].includes(kind);

export const CALC_LABELS: Record<CalcFn, string> = {
  count: "Count all", count_values: "Count values", count_empty: "Count empty", count_not_empty: "Count not empty",
  percent_empty: "Percent empty", percent_not_empty: "Percent not empty", sum: "Sum", average: "Average", min: "Min", max: "Max", median: "Median", range: "Range",
  earliest: "Earliest date", latest: "Latest date", checked: "Checked", unchecked: "Unchecked", percent_checked: "Percent checked",
};
export function calcOptions(kind: Kind): CalcFn[] {
  const common: CalcFn[] = ["count", "count_values", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"];
  if (kind === "number") return [...common, "sum", "average", "median", "min", "max", "range"];
  if (kind === "date" || kind === "created_time" || kind === "last_edited_time") return [...common, "earliest", "latest", "range"];
  if (kind === "checkbox") return ["count", "checked", "unchecked", "percent_checked"];
  return common;
}
const fmt = (n: number) => String(+n.toFixed(2));
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) + "%" : "0%");

export function computeCalc(fn: CalcFn, rows: Row[], property: Property): string {
  const values = rows.map(r => r.values[property.id]);
  const filled = values.filter(v => !isEmpty(v));
  const numbers = filled.filter((v): v is number => typeof v === "number");
  const days = filled.map(dateOf).filter((d): d is string => !!d).map(dayNumber);
  switch (fn) {
    case "count": return String(rows.length);
    case "count_values": case "count_not_empty": return String(filled.length);
    case "count_empty": return String(rows.length - filled.length);
    case "percent_empty": return pct(rows.length - filled.length, rows.length);
    case "percent_not_empty": return pct(filled.length, rows.length);
    case "sum": return fmt(numbers.reduce((a, b) => a + b, 0));
    case "average": return numbers.length ? fmt(numbers.reduce((a, b) => a + b, 0) / numbers.length) : "";
    case "min": return numbers.length ? fmt(Math.min(...numbers)) : "";
    case "max": return numbers.length ? fmt(Math.max(...numbers)) : "";
    case "median": { if (!numbers.length) return ""; const s = [...numbers].sort((a, b) => a - b), m = Math.floor(s.length / 2); return fmt(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); }
    case "range": if (property.type === "date" || property.type === "created_time" || property.type === "last_edited_time") return days.length ? Math.max(...days) - Math.min(...days) + " days" : ""; return numbers.length ? fmt(Math.max(...numbers) - Math.min(...numbers)) : "";
    case "earliest": return days.length ? new Date(Math.min(...days) * 864e5).toISOString().slice(0, 10) : "";
    case "latest": return days.length ? new Date(Math.max(...days) * 864e5).toISOString().slice(0, 10) : "";
    case "checked": return String(values.filter(v => v === true).length);
    case "unchecked": return String(values.filter(v => v !== true).length);
    case "percent_checked": return pct(values.filter(v => v === true).length, rows.length);
  }
}
