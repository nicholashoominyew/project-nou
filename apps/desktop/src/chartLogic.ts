import { dateOf, dayNumber, fromDay, type Property, type Row, type ViewConfig } from "./dbShared";
import { isEmpty } from "./dbLogic";

/** Solid colours for chart marks, keyed by the option colour names a Select or Status property uses. */
export const SERIES_COLORS: Record<string, string> = {
  gray: "#9b9a97", brown: "#a1735a", orange: "#e0852f", yellow: "#d9a81f", green: "#4f9d69", blue: "#3f8fd0", purple: "#8f6ac2", pink: "#d0679a", red: "#d1453b",
};
const ORDER = ["blue", "orange", "green", "purple", "red", "yellow", "pink", "brown", "gray"];
export const paletteColor = (i: number) => SERIES_COLORS[ORDER[i % ORDER.length]];

export type Bucket = { key: string; label: string; color?: string; values: number[]; total: number };
export type Series = { key: string; label: string; color: string };
export type ChartData = { buckets: Bucket[]; series: Series[]; yLabel: string; xLabel: string; max: number; grandTotal: number };

const YFN_LABEL: Record<string, string> = { count: "Count", sum: "Sum", average: "Average", min: "Min", max: "Max", median: "Median" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isDate = (p: Property) => p.type === "date" || p.type === "created_time" || p.type === "last_edited_time";

/** Every bucket label an X-axis property can put one row into (a multi-select row lands in several). Empty means "No value". */
function keysOf(row: Row, p: Property, group: NonNullable<ViewConfig["xGroup"]>, linked?: Record<string, string>): { key: string; label: string; color?: string }[] {
  const value = row.values[p.id];
  const none = [{ key: "", label: "No " + p.name }];
  if (p.type === "checkbox") return [{ key: String(value === true), label: value === true ? "Checked" : "Unchecked" }];
  if (isEmpty(value)) return none;
  if (p.type === "select" || p.type === "status") { const o = p.options.find(x => x.id === value); return o ? [{ key: o.id, label: o.name, color: o.color }] : none; }
  if (p.type === "multi_select") { const ids = Array.isArray(value) ? value : []; const hit = p.options.filter(o => ids.includes(o.id)); return hit.length ? hit.map(o => ({ key: o.id, label: o.name, color: o.color })) : none; }
  if (p.type === "relation") { const ids = Array.isArray(value) ? (value as string[]) : []; return ids.length ? ids.map(id => ({ key: id, label: linked?.[id] ?? "Untitled" })) : none; }
  if (isDate(p)) {
    const d = dateOf(value); if (!d) return none;
    if (group === "day") return [{ key: d, label: new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) }];
    if (group === "week") { const n = dayNumber(d); const monday = n - ((new Date(n * 864e5).getUTCDay() + 6) % 7); return [{ key: fromDay(monday), label: "Week of " + new Date(monday * 864e5).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) }]; }
    if (group === "year") return [{ key: d.slice(0, 4), label: d.slice(0, 4) }];
    return [{ key: d.slice(0, 7), label: MONTHS[Number(d.slice(5, 7)) - 1] + " " + d.slice(0, 4) }];
  }
  if (p.type === "place") return none;
  return [{ key: String(value), label: String(value) }];
}

function reduce(fn: NonNullable<ViewConfig["yFn"]>, rows: Row[], y?: Property): number {
  if (fn === "count" || !y) return rows.length;
  const nums = rows.map(r => r.values[y.id]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return 0;
  if (fn === "sum") return nums.reduce((a, b) => a + b, 0);
  if (fn === "average") return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (fn === "min") return Math.min(...nums);
  if (fn === "max") return Math.max(...nums);
  const s = [...nums].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Turn the rows of a database into what a chart draws. Pure: same rows and settings always give the same chart. */
export function buildChart(rows: Row[], properties: Property[], config: ViewConfig, linked?: Record<string, string>): ChartData | null {
  const x = properties.find(p => p.id === config.xBy);
  if (!x) return null;
  const fn = config.yFn ?? "count";
  const y = fn === "count" ? undefined : properties.find(p => p.id === config.yBy && p.type === "number");
  const colour = properties.find(p => p.id === config.colorBy && p.id !== x.id);
  const group = config.xGroup ?? "month";

  // 1. series: one per value of the colour property, or a single one for the whole chart
  let series: Series[];
  const seriesOf = (row: Row) => (colour ? keysOf(row, colour, "month", linked).map(k => k.key) : ["all"]);
  if (colour) {
    const seen = new Map<string, Series>();
    if (colour.type === "select" || colour.type === "status" || colour.type === "multi_select") colour.options.forEach((o, i) => seen.set(o.id, { key: o.id, label: o.name, color: SERIES_COLORS[o.color] ?? paletteColor(i) }));
    if (colour.type === "checkbox") { seen.set("true", { key: "true", label: "Checked", color: SERIES_COLORS.green }); seen.set("false", { key: "false", label: "Unchecked", color: SERIES_COLORS.gray }); }
    for (const row of rows) for (const k of keysOf(row, colour, "month", linked)) if (!seen.has(k.key)) seen.set(k.key, { key: k.key, label: k.label, color: k.key === "" ? SERIES_COLORS.gray : paletteColor(seen.size) });
    const used = new Set(rows.flatMap(seriesOf));
    series = [...seen.values()].filter(s => used.has(s.key));
  } else series = [{ key: "all", label: YFN_LABEL[fn] + (y ? " of " + y.name : ""), color: paletteColor(0) }];

  // 2. buckets along X, in the property's natural order
  const buckets = new Map<string, { key: string; label: string; color?: string; rows: Row[] }>();
  if (x.type === "select" || x.type === "status" || x.type === "multi_select") x.options.forEach(o => buckets.set(o.id, { key: o.id, label: o.name, color: o.color, rows: [] }));
  if (x.type === "checkbox") { buckets.set("true", { key: "true", label: "Checked", rows: [] }); buckets.set("false", { key: "false", label: "Unchecked", rows: [] }); }
  for (const row of rows) for (const k of keysOf(row, x, group, linked)) { const b = buckets.get(k.key) ?? { ...k, rows: [] }; b.rows.push(row); buckets.set(k.key, b); }
  const natural = [...buckets.values()];
  const rank = (k: string) => (k === "" ? 1 : 0);
  const ordered = x.type === "select" || x.type === "status" || x.type === "multi_select" || x.type === "checkbox"
    ? natural
    : isDate(x) ? natural.sort((a, b) => rank(a.key) - rank(b.key) || (a.key < b.key ? -1 : 1))
    : x.type === "number" ? natural.sort((a, b) => rank(a.key) - rank(b.key) || Number(a.key) - Number(b.key))
    : natural.sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label, undefined, { numeric: true }));

  let out: Bucket[] = ordered.map(b => {
    const values = series.map(s => reduce(fn, colour ? b.rows.filter(r => seriesOf(r).includes(s.key)) : b.rows, y));
    return { key: b.key, label: b.label, color: b.color ? SERIES_COLORS[b.color] : undefined, values, total: values.reduce((a, v) => a + v, 0) };
  });
  if (config.hideEmpty) out = out.filter(b => b.key !== "");
  if (config.xSort === "x_asc") out = [...out].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (config.xSort === "x_desc") out = [...out].sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
  if (config.xSort === "y_asc") out = [...out].sort((a, b) => a.total - b.total);
  if (config.xSort === "y_desc") out = [...out].sort((a, b) => b.total - a.total);
  if (config.cumulative) { const run = series.map(() => 0); out = out.map(b => { const values = b.values.map((v, i) => (run[i] += v)); return { ...b, values, total: values.reduce((a, v) => a + v, 0) }; }); }
  if (config.hideZero) out = out.filter(b => b.total !== 0);
  const percent = config.barStyle === "percent";
  if (percent) out = out.map(b => { const values = b.values.map(v => (b.total ? (v / b.total) * 100 : 0)); return { ...b, values, total: b.total ? 100 : 0 }; });
  const stacked = config.barStyle === "stacked" || percent;
  const max = Math.max(0, ...out.map(b => (stacked ? b.total : Math.max(0, ...b.values))));
  return { buckets: out, series, yLabel: percent ? "Percent" : YFN_LABEL[fn] + (y ? " of " + y.name : ""), xLabel: x.name, max, grandTotal: out.reduce((a, b) => a + b.total, 0) };
}

/** A tidy axis: about five round steps from 0 up to at least `max`. */
export function niceScale(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / 5, pow = 10 ** Math.floor(Math.log10(raw)), f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { top, ticks };
}

export const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
