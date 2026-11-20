// Pure timing logic for the Life Timetable. Nothing here reads the clock: callers pass `now`, so every rule can be tested with fixed dates.
// Time is always the device's local wall-clock time. A week is 7 days x 48 half-hour slots, Monday first; slot 0 is 00:00-00:30.
export const SLOTS_PER_DAY = 48;
export const WEEK_SLOTS = SLOTS_PER_DAY * 7;
export const CATEGORIES = ["Work", "Rest", "Leisure", "Travel", "Chores", "Training", "Health"] as const;
export type Category = (typeof CATEGORIES)[number];
export interface Activity { id: string; name: string; category: Category; colour: string | null; remind: boolean; sort_order: number }
export interface SlotRow { weekday: number; slot_index: number; activity_id: string }
/** One sorted list of activity ids per slot, indexed weekday * 48 + slot. */
export type Grid = string[][];

export function buildGrid(rows: SlotRow[]): Grid {
  const grid: Grid = Array.from({ length: WEEK_SLOTS }, () => []);
  for (const r of rows) {
    if (!Number.isInteger(r.weekday) || !Number.isInteger(r.slot_index) || r.weekday < 0 || r.weekday > 6 || r.slot_index < 0 || r.slot_index >= SLOTS_PER_DAY) continue;
    const cell = grid[r.weekday * SLOTS_PER_DAY + r.slot_index];
    if (!cell.includes(r.activity_id)) cell.push(r.activity_id);
  }
  for (const cell of grid) cell.sort();
  return grid;
}

/** Monday = 0 ... Sunday = 6, from a local date. */
export const weekdayOf = (d: Date) => (d.getDay() + 6) % 7;
/** The slot the local time falls in, 0-335. */
export function slotOf(d: Date): number { return weekdayOf(d) * SLOTS_PER_DAY + Math.floor((d.getHours() * 60 + d.getMinutes()) / 30); }
const signature = (cell: string[]) => cell.join("|");
/** A local Date `minutes` after local midnight of `base` (wall-clock arithmetic, so a clock change cannot shift it). */
function atMinutes(base: Date, minutes: number): Date { return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minutes, 0, 0); }

export interface ScheduleEvent {
  /** Activity ids sharing the run (empty = nothing planned). */
  ids: string[];
  start: Date;
  end: Date;
  /** Global slot (0-335) of the first slot of the run, and how many slots it spans. */
  firstSlot: number;
  slots: number;
}

/** The run around a slot: consecutive slots with the same set of activities, wrapping across midnight and from Sunday into Monday. */
function runAround(grid: Grid, slot: number, anchorMinutes: number, base: Date): ScheduleEvent {
  const sig = signature(grid[slot]);
  let back = 0; while (back < WEEK_SLOTS - 1 && signature(grid[(slot - back - 1 + WEEK_SLOTS) % WEEK_SLOTS]) === sig) back++;
  let fwd = 0; while (back + fwd < WEEK_SLOTS - 1 && signature(grid[(slot + fwd + 1) % WEEK_SLOTS]) === sig) fwd++;
  return { ids: grid[slot], start: atMinutes(base, anchorMinutes - back * 30), end: atMinutes(base, anchorMinutes + (fwd + 1) * 30), firstSlot: (slot - back + WEEK_SLOTS) % WEEK_SLOTS, slots: back + fwd + 1 };
}

/** The event happening at `now`, with its real start and end. */
export function eventAt(grid: Grid, now: Date): ScheduleEvent | null {
  if (grid.length !== WEEK_SLOTS) return null;
  const slot = slotOf(now);
  return runAround(grid, slot, (slot % SLOTS_PER_DAY) * 30, now);
}

/** The event that follows `current`, or null when the whole week is one event. */
export function eventAfter(grid: Grid, current: ScheduleEvent, now: Date): ScheduleEvent | null {
  if (current.slots >= WEEK_SLOTS) return null;
  const slot = slotOf(now);
  const offset = (slot - current.firstSlot + WEEK_SLOTS) % WEEK_SLOTS; // slots from the run's first slot to now's slot
  const next = (current.firstSlot + current.slots) % WEEK_SLOTS;
  const anchor = (slot % SLOTS_PER_DAY) * 30 + (current.slots - offset) * 30; // start of `next`, in minutes after now's midnight
  return runAround(grid, next, anchor, now);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const names = (ids: string[], activities: Activity[]) => ids.map(id => activities.find(a => a.id === id)?.name).filter(Boolean).join(" + ");
/** Whole seconds left, as HH:MM:SS (hours may pass 24 for a long run). */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(pad).join(":");
}
export function progress(ev: ScheduleEvent, now: Date): number {
  const total = ev.end.getTime() - ev.start.getTime();
  return total > 0 ? Math.min(1, Math.max(0, (now.getTime() - ev.start.getTime()) / total)) : 0;
}

export interface Reminder { key: string; text: string; start: Date; event: ScheduleEvent }
/**
 * The reminder to show now, or null. It is due while the next event starts within `leadMinutes` and has not been announced yet:
 * waking inside the window fires immediately, an event that has already started is never announced late, and the key
 * (date + weekday + slot of the next start) lets the caller remember the last one so a transition fires only once.
 */
export function reminderFor(grid: Grid, activities: Activity[], now: Date, leadMinutes: number, lastKey: string | null): Reminder | null {
  const current = eventAt(grid, now); if (!current) return null;
  const next = eventAfter(grid, current, now); if (!next) return null;
  const ms = next.start.getTime() - now.getTime();
  if (ms <= 0 || ms > leadMinutes * 60000) return null;
  const mine = next.ids.map(id => activities.find(a => a.id === id)).filter((a): a is Activity => !!a);
  if (!mine.some(a => a.remind)) return null;
  const key = `${next.start.getFullYear()}-${pad(next.start.getMonth() + 1)}-${pad(next.start.getDate())} ${weekdayOf(next.start)}:${next.firstSlot % SLOTS_PER_DAY}`;
  if (key === lastKey) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return { key, start: next.start, event: next, text: `In ${minutes} min: ${names(next.ids, activities)} · ${clock(next.start)}–${clock(next.end)}` };
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

/** Hours per category per day and per week. A slot with several activities counts each of them, as the Notion rollups did. */
export function totals(grid: Grid, activities: Activity[]): { perDay: Record<string, number[]>; perWeek: Record<string, number> } {
  const cat = new Map(activities.map(a => [a.id, a.category]));
  const perDay: Record<string, number[]> = Object.fromEntries(CATEGORIES.map(c => [c, Array(7).fill(0)]));
  for (let s = 0; s < WEEK_SLOTS; s++) for (const id of grid[s]) { const c = cat.get(id); if (c) perDay[c][Math.floor(s / SLOTS_PER_DAY)] += 0.5; }
  return { perDay, perWeek: Object.fromEntries(CATEGORIES.map(c => [c, perDay[c].reduce((a, b) => a + b, 0)])) };
}
