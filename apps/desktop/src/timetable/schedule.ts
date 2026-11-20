// Pure timing logic for the Life Timetable. Nothing here reads the clock: callers pass `now`, so every rule can be tested with fixed dates.
// Time is always the device's local wall-clock time. A week is 7 days x 48 half-hour slots, Monday first; slot 0 is 00:00-00:30.
// There are two alternating weeks, A and B. ISO week number odd = A, even = B, unless the swap setting flips it.
export const SLOTS_PER_DAY = 48;
export const WEEK_SLOTS = SLOTS_PER_DAY * 7;
export const CATEGORIES = ["Work", "Training", "Leisure", "Health", "Travel", "Chores", "Rest"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Variant = "A" | "B";
export interface Activity { id: string; name: string; category: Category; colour: string | null; remind: boolean; sort_order: number }
export interface SlotRow { variant: Variant; weekday: number; slot_index: number; activity_id: string }
/** One sorted list of activity ids per slot, indexed weekday * 48 + slot. */
export type Grid = string[][];
export type Grids = Record<Variant, Grid>;
/** What the resolver needs: both weeks, and whether the A/B assignment is swapped. */
export interface Timeline { grids: Grids; swap: boolean }

function gridFrom(rows: SlotRow[]): Grid {
  const grid: Grid = Array.from({ length: WEEK_SLOTS }, () => []);
  for (const r of rows) {
    if (!Number.isInteger(r.weekday) || !Number.isInteger(r.slot_index) || r.weekday < 0 || r.weekday > 6 || r.slot_index < 0 || r.slot_index >= SLOTS_PER_DAY) continue;
    const cell = grid[r.weekday * SLOTS_PER_DAY + r.slot_index];
    if (!cell.includes(r.activity_id)) cell.push(r.activity_id);
  }
  for (const cell of grid) cell.sort();
  return grid;
}
export function buildGrids(rows: SlotRow[]): Grids {
  return { A: gridFrom(rows.filter(r => r.variant === "A")), B: gridFrom(rows.filter(r => r.variant === "B")) };
}

/** ISO 8601 week number (1-53) of a local date. */
export function isoWeek(d: Date): number {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  const y0 = Date.UTC(x.getUTCFullYear(), 0, 1);
  return Math.ceil(((x.getTime() - y0) / 86400000 + 1) / 7);
}
/** Which week's timetable applies on a date: odd ISO week = A, even = B; `swap` flips it. */
export function variantFor(d: Date, swap: boolean): Variant { return (isoWeek(d) % 2 === 1) !== swap ? "A" : "B"; }
export const otherVariant = (v: Variant): Variant => (v === "A" ? "B" : "A");

/** Monday = 0 ... Sunday = 6, from a local date. */
export const weekdayOf = (d: Date) => (d.getDay() + 6) % 7;
/** The slot of the week the local time falls in, 0-335. */
export function slotOf(d: Date): number { return weekdayOf(d) * SLOTS_PER_DAY + Math.floor((d.getHours() * 60 + d.getMinutes()) / 30); }
const signature = (cell: string[]) => cell.join("|");
/** A local Date `minutes` after local midnight of `base` (wall-clock arithmetic, so a clock change cannot shift it). */
function atMinutes(base: Date, minutes: number): Date { return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minutes, 0, 0); }

export interface ScheduleEvent {
  /** Activity ids sharing the run (empty = nothing planned). */
  ids: string[];
  start: Date;
  end: Date;
  /** How many slots the run spans (capped: a run that fills the whole search window reports the cap). */
  slots: number;
}
const WINDOW = WEEK_SLOTS * 2;

/**
 * The event around `now`: consecutive slots with the same set of activities, across midnight and across the week boundary.
 * Each slot is read from the week it really belongs to, so on Sunday night the slots after midnight come from the NEXT week's variant.
 */
export function eventAt(tl: Timeline, now: Date): ScheduleEvent | null {
  if (tl.grids.A.length !== WEEK_SLOTS || tl.grids.B.length !== WEEK_SLOTS) return null;
  const g0 = slotOf(now);
  const variants = new Map<number, Variant>();
  const cell = (k: number): string[] => {
    const g = g0 + k; const w = Math.floor(g / WEEK_SLOTS);
    let v = variants.get(w);
    if (!v) { v = variantFor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7 * w), tl.swap); variants.set(w, v); }
    return tl.grids[v][g - w * WEEK_SLOTS];
  };
  const sig = signature(cell(0));
  let back = 0; while (back < WINDOW && signature(cell(-back - 1)) === sig) back++;
  let fwd = 0; while (back + fwd < WINDOW && signature(cell(fwd + 1)) === sig) fwd++;
  const anchor = (g0 % SLOTS_PER_DAY) * 30;
  return { ids: cell(0), start: atMinutes(now, anchor - back * 30), end: atMinutes(now, anchor + (fwd + 1) * 30), slots: back + fwd + 1 };
}
/** The event that follows `current`, or null when nothing ever changes. */
export function eventAfter(tl: Timeline, current: ScheduleEvent): ScheduleEvent | null {
  if (current.slots >= WINDOW) return null;
  return eventAt(tl, current.end);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Activity names in the order of the activity list (stable for the same set). */
export function names(ids: string[], activities: Activity[]): string {
  const list = ids.map(id => activities.findIndex(a => a.id === id)).filter(i => i >= 0).sort((a, b) => a - b);
  return list.map(i => activities[i].name).join(" + ");
}
/** The countdown to show in the ring: hours (hidden under one hour), minutes, seconds. */
export function countdownParts(ms: number): { showH: boolean; h: string; m: string; s: string; aria: string } {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return { showH: h > 0, h: String(h), m: h > 0 ? pad(m) : String(m), s: pad(s), aria: `${h ? h + "h " : ""}${m}m ${s}s left` };
}
/** Whole seconds left, as HH:MM:SS. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(pad).join(":");
}
export function progress(ev: ScheduleEvent, now: Date): number {
  const total = ev.end.getTime() - ev.start.getTime();
  return total > 0 ? Math.min(1, Math.max(0, (now.getTime() - ev.start.getTime()) / total)) : 0;
}
/** Hours to 2 decimals under 10, 1 decimal from 10, trailing zeros trimmed. */
export function fmtHours(h: number): string {
  const v = (h >= 10 ? h.toFixed(1) : h.toFixed(2)).replace(/\.?0+$/, "");
  return v === "" ? "0" : v;
}
export function fmtDuration(minutes: number): string {
  const secs = Math.max(0, Math.round(minutes * 60)), h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
}
export const hm = (minutes: number): string => {
  const m = Math.round(minutes); if (m === 1440) return "24:00";
  const x = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
};

export interface Reminder { key: string; text: string; names: string; range: string; start: Date; event: ScheduleEvent }
/**
 * The reminder to show now, or null. It is due while the next event starts within `leadMinutes` and has not been announced yet:
 * waking inside the window fires immediately, an event that has already started is never announced late, and the key
 * (date + weekday + slot of the next start) lets the caller remember the last one so a transition fires only once.
 * The next event is read from the right week on both sides of Sunday midnight.
 */
export function reminderFor(tl: Timeline, activities: Activity[], now: Date, leadMinutes: number, lastKey: string | null): Reminder | null {
  const current = eventAt(tl, now); if (!current) return null;
  const next = eventAfter(tl, current); if (!next) return null;
  const ms = next.start.getTime() - now.getTime();
  if (ms <= 0 || ms > leadMinutes * 60000) return null;
  const mine = next.ids.map(id => activities.find(a => a.id === id)).filter((a): a is Activity => !!a);
  if (!mine.some(a => a.remind)) return null;
  const key = `${next.start.getFullYear()}-${pad(next.start.getMonth() + 1)}-${pad(next.start.getDate())} ${weekdayOf(next.start)}:${Math.floor((next.start.getHours() * 60 + next.start.getMinutes()) / 30)}`;
  if (key === lastKey) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const nm = names(next.ids, activities), range = `${clock(next.start)}–${clock(next.end)}`;
  return { key, start: next.start, event: next, names: nm, range, text: `In ${minutes} min: ${nm} · ${range}` };
}

/** Merged blocks of one day for the grid: consecutive identical slots (not crossing midnight). */
export interface Block { ids: string[]; first: number; count: number }
export function dayBlocks(grid: Grid, weekday: number): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const ids = grid[weekday * SLOTS_PER_DAY + i];
    const last = out[out.length - 1];
    if (last && signature(last.ids) === signature(ids)) last.count++; else out.push({ ids, first: i, count: 1 });
  }
  return out;
}

/** The categories an activity counts toward (one today; the split rule below handles several). */
const categoriesOf = (a: Activity): string[] => [a.category];
/**
 * Hours per category for one day (`day` 0-6) or the whole week. One slot is 30 minutes; a slot with n activities gives each of them 30/n minutes,
 * and an activity with several categories splits its share equally across them. Every filled day therefore totals 24 h and a week 168 h.
 */
export function distribution(grid: Grid, activities: Activity[], day: number | null): { hours: Record<string, number>; total: number } {
  const byId = new Map(activities.map(a => [a.id, a]));
  const hours: Record<string, number> = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  const from = day === null ? 0 : day * SLOTS_PER_DAY, to = day === null ? WEEK_SLOTS : from + SLOTS_PER_DAY;
  for (let s = from; s < to; s++) {
    const cell = grid[s].filter(id => byId.has(id)); if (!cell.length) continue;
    for (const id of cell) {
      const cats = categoriesOf(byId.get(id)!);
      for (const c of cats) hours[c] += 30 / cell.length / cats.length / 60;
    }
  }
  return { hours, total: day === null ? 168 : 24 };
}
