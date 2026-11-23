/** Pure date maths for the Home clocks, progress bars, countdowns and calendar. Nothing here touches the screen or the network. */

const DAY = 86400000;
const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
/** A real calendar day written YYYY-MM-DD (local), or null. */
export function parseDay(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
}
const dayNo = (d: Date) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);

// ---- clocks -------------------------------------------------------------------------------------------------------
export const FALLBACK_ZONES = ["UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul", "Australia/Sydney", "Pacific/Auckland"];
export function zoneList(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const all = f?.("timeZone");
    if (all?.length) return all.includes("UTC") ? all : ["UTC", ...all];
  } catch { /* use the short list */ }
  return FALLBACK_ZONES;
}
export function validZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 60) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
}
export const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
export function clockParts(now: Date, zone: string): { time: string; date: string; hour: number; minute: number } {
  const z = validZone(zone) ? zone : "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = +(parts.find(p => p.type === "hour")?.value ?? 0), minute = +(parts.find(p => p.type === "minute")?.value ?? 0);
  return { time: pad(hour) + ":" + pad(minute), date: new Intl.DateTimeFormat("en-GB", { timeZone: z, weekday: "short", day: "numeric", month: "short" }).format(now), hour, minute };
}
export const zoneCity = (zone: string) => zone.split("/").pop()!.replace(/_/g, " ");

// ---- progress through the year, quarter, month and day -------------------------------------------------------------
export type Period = { id: "year" | "quarter" | "month" | "day"; label: string; fraction: number; left: string };
export function periods(now: Date): Period[] {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate(), q = Math.floor(m / 3);
  const span = (id: Period["id"], label: string, start: Date, end: Date): Period => {
    const total = end.getTime() - start.getTime(), done = now.getTime() - start.getTime(), rest = end.getTime() - now.getTime();
    let left: string;
    if (id === "day") { const mins = Math.max(0, Math.ceil(rest / 60000)); left = Math.floor(mins / 60) + " h " + (mins % 60) + " min left"; }
    else { const days = Math.max(0, Math.ceil(rest / DAY)); left = days + (days === 1 ? " day left" : " days left"); }
    return { id, label, fraction: Math.min(1, Math.max(0, done / total)), left };
  };
  return [
    span("year", String(y), new Date(y, 0, 1), new Date(y + 1, 0, 1)),
    span("quarter", "Q" + (q + 1) + " " + y, new Date(y, q * 3, 1), new Date(y, q * 3 + 3, 1)),
    span("month", now.toLocaleDateString("en-GB", { month: "long" }), new Date(y, m, 1), new Date(y, m + 1, 1)),
    span("day", "Today", new Date(y, m, d), new Date(y, m, d + 1)),
  ];
}

// ---- countdowns ---------------------------------------------------------------------------------------------------
export type Unit = "day" | "week" | "month";
export type Countdown = { id: string; label: string; start: string; end: string; unit: Unit };
export const COUNTDOWNS_KEY = "nou-countdowns";
export const MAX_COUNTDOWNS = 30;
export function normalizeCountdowns(raw: unknown): Countdown[] {
  if (!Array.isArray(raw)) return [];
  const out: Countdown[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (out.length >= MAX_COUNTDOWNS || !r || typeof r !== "object") continue;
    const start = parseDay(r.start), end = parseDay(r.end);
    const label = typeof r.label === "string" ? r.label.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80) : "";
    const id = typeof r.id === "string" && r.id ? r.id.slice(0, 40) : "";
    if (!start || !end || !label || !id || end < start || out.some(c => c.id === id)) continue;
    out.push({ id, label, start: dayKey(start), end: dayKey(end), unit: r.unit === "week" || r.unit === "month" ? r.unit : "day" });
  }
  return out;
}
/** Whole months from `from` up to `to` (never past it), and the days left over. */
function monthsBetween(from: Date, to: Date): { months: number; days: number } {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth();
  const at = (n: number) => {
    const t = new Date(from.getFullYear(), from.getMonth() + n, 1);
    t.setDate(Math.min(from.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
    return t;
  };
  while (months > 0 && at(months) > to) months--;
  months = Math.max(0, months);
  return { months, days: Math.max(0, dayNo(to) - dayNo(at(months))) };
}
export type CountdownPart = { n: number; word: string };
/** The time left as the big number or numbers shown on a countdown, each with its unit word after it (Notion's format: 17 days, 2 weeks 3 days, 3 months 5 days). */
export function countdownState(c: Countdown, now: Date): { fraction: number; daysLeft: number; text: string; done: boolean; parts: CountdownPart[] } {
  const start = parseDay(c.start)!, end = parseDay(c.end)!, today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = dayNo(end) - dayNo(today), total = dayNo(end) - dayNo(start), passed = dayNo(today) - dayNo(start);
  const fraction = total <= 0 ? (daysLeft <= 0 ? 1 : 0) : Math.min(1, Math.max(0, passed / total));
  if (daysLeft < 0) return { fraction: 1, daysLeft, text: "Finished " + -daysLeft + (daysLeft === -1 ? " day ago" : " days ago"), done: true, parts: [{ n: -daysLeft, word: (daysLeft === -1 ? "day" : "days") + " ago" }] };
  if (daysLeft === 0) return { fraction: 1, daysLeft, text: "Today", done: true, parts: [] };
  const s = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");
  const w = (n: number, word: string): CountdownPart => ({ n, word: word + (n === 1 ? "" : "s") });
  let text: string, parts: CountdownPart[];
  if (c.unit === "week") { const wk = Math.floor(daysLeft / 7), d = daysLeft % 7; parts = [wk ? w(wk, "week") : null, d ? w(d, "day") : null].filter((x): x is CountdownPart => !!x); text = [wk ? s(wk, "week") : "", d ? s(d, "day") : ""].filter(Boolean).join(" ") + " left"; }
  else if (c.unit === "month") { const { months, days } = monthsBetween(today, end); parts = [months ? w(months, "month") : null, days ? w(days, "day") : null].filter((x): x is CountdownPart => !!x); text = [months ? s(months, "month") : "", days ? s(days, "day") : ""].filter(Boolean).join(" ") + " left"; }
  else { parts = [w(daysLeft, "day")]; text = s(daysLeft, "day") + " left"; }
  return { fraction, daysLeft, text, done: false, parts };
}

// ---- calendar -----------------------------------------------------------------------------------------------------
export type CalendarEvent = { date: string; title: string; kind: "daily" | "row" | "countdown"; pageId?: string; from?: string };
/** The weeks to draw for a month, Monday first. */
export function monthGrid(year: number, month: number): { date: string; inMonth: boolean }[][] {
  const first = new Date(year, month, 1), lead = (first.getDay() + 6) % 7, weeks: { date: string; inMonth: boolean }[][] = [];
  const count = Math.ceil((lead + new Date(year, month + 1, 0).getDate()) / 7);
  for (let w = 0; w < count; w++) weeks.push(Array.from({ length: 7 }, (_, i) => { const d = new Date(year, month, 1 - lead + w * 7 + i); return { date: dayKey(d), inMonth: d.getMonth() === month }; }));
  return weeks;
}
export function groupByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) { if (!parseDay(e.date)) continue; const list = map.get(e.date) ?? []; list.push(e); map.set(e.date, list); }
  return map;
}
