// Pure rules for the Habits page and the timetable check-in pop-ups. Days are the device's local calendar days written "2026-11-24"; nothing here reads the clock.
export type Habit = { id: string; name: string; days: number; sort_order: number; created_at: string };
export type LogState = "done" | "skipped" | "no_answer";
export type LogEntry = { day: string; habit_id: string; state: LogState; answered_at: string | null; source: string };
export type Checkin = { id: string; habit_id: string; weekday: number; start_slot: number; end_slot: number; variant: "A" | "B" };
export type CheckinEvent = { checkin_id: string; day: string; habit_id: string; habit: string; block: string; start_slot: number; end_slot: number; shown_at: number; expires_at: number; state: string };
export type LogMap = Map<string, LogEntry>;

const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (day: string, n: number) => { const [y, m, d] = day.split("-").map(Number); return localDay(new Date(y, m - 1, d + n)); };
/** Monday is 0 ... Sunday is 6. */
export const weekdayOfDay = (day: string) => (parseDay(day).getDay() + 6) % 7;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const slotTime = (slot: number) => `${pad(Math.floor(slot / 2))}:${slot % 2 ? "30" : "00"}`;
export const slotRange = (start: number, end: number) => `${slotTime(start)}–${slotTime(end)}`;
export const logKey = (day: string, habit: string) => `${day}|${habit}`;
export const indexLog = (entries: LogEntry[]): LogMap => new Map(entries.map(e => [logKey(e.day, e.habit_id), e]));

/** The day a habit starts counting: when it was added (or the first day of the history it was imported with). */
export const startDay = (h: Habit) => { const d = new Date(h.created_at); return Number.isNaN(d.getTime()) ? "0000-01-01" : localDay(d); };
/** Does the habit count on this day? It must have started, and the day's weekday must be one it applies to. */
export const appliesOn = (h: Habit, day: string) => startDay(h) <= day && (h.days & (1 << weekdayOfDay(day))) !== 0;

export function progressOn(habits: Habit[], log: LogMap, day: string): { done: number; total: number; pct: number | null } {
  const list = habits.filter(h => appliesOn(h, day));
  const done = list.filter(h => log.get(logKey(day, h.id))?.state === "done").length;
  return { done, total: list.length, pct: list.length ? Math.round((done / list.length) * 100) : null };
}

/**
 * Current and best run of days a habit was done. A day the habit does not apply to neither breaks nor adds to a run. Skipped, no answer and empty days break it, except
 * today while it is still empty (the day is not over). Counting stops at the day the habit started.
 */
export function streaks(h: Habit, log: LogMap, today: string): { current: number; best: number } {
  const first = startDay(h);
  let best = 0, run = 0, current = 0, open = true;
  for (let day = first, guard = 0; day <= today && guard < 4000; day = addDays(day, 1), guard++) {
    if (!appliesOn(h, day)) continue;
    const state = log.get(logKey(day, h.id))?.state;
    if (state === "done") { run++; best = Math.max(best, run); }
    else if (day === today && state === undefined) { /* today is not over: neither adds nor breaks */ }
    else run = 0;
  }
  current = run;
  void open;
  return { current, best };
}

/** For each of the last `weeks` weeks (Monday to Sunday, the latest being this week up to today): how many habit-days were done of how many applied. */
export function weeklyTrend(habits: Habit[], log: LogMap, today: string, weeks: number): { start: string; done: number; total: number; pct: number | null }[] {
  const monday = addDays(today, -weekdayOfDay(today));
  const out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = addDays(monday, -7 * w); let done = 0, total = 0;
    for (let i = 0; i < 7; i++) { const day = addDays(start, i); if (day > today) break; const p = progressOn(habits, log, day); done += p.done; total += p.total; }
    out.push({ start, done, total, pct: total ? Math.round((done / total) * 100) : null });
  }
  return out;
}
/** Per habit, over a range of days: days done, days it applied, and the percentage. */
export function totalsPerHabit(habits: Habit[], log: LogMap, from: string, to: string): { habit: Habit; done: number; total: number; pct: number | null }[] {
  return habits.map(habit => {
    let done = 0, total = 0;
    for (let day = from, guard = 0; day <= to && guard < 4000; day = addDays(day, 1), guard++) { if (!appliesOn(habit, day)) continue; total++; if (log.get(logKey(day, habit.id))?.state === "done") done++; }
    return { habit, done, total, pct: total ? Math.round((done / total) * 100) : null };
  });
}
/** How the answers split between checked in, skipping and no answer, over a range of days and the given habits. */
export function answerSplit(entries: LogEntry[], from: string, to: string, habitIds: Set<string>): Record<LogState, number> {
  const out: Record<LogState, number> = { done: 0, skipped: 0, no_answer: 0 };
  for (const e of entries) if (e.day >= from && e.day <= to && habitIds.has(e.habit_id)) out[e.state]++;
  return out;
}
/** A calendar month as weeks of seven days starting on Monday (`month` is 0 to 11). */
export function monthGrid(year: number, month: number): { day: string; inMonth: boolean }[][] {
  const first = new Date(year, month, 1), lead = (first.getDay() + 6) % 7, days = new Date(year, month + 1, 0).getDate();
  const cells: { day: string; inMonth: boolean }[] = [];
  for (let i = 0; i < Math.ceil((lead + days) / 7) * 7; i++) { const d = new Date(year, month, 1 - lead + i); cells.push({ day: localDay(d), inMonth: d.getMonth() === month }); }
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** Check-ins whose block has just started, as seen by a page that kept running: the start instant is after the previous look and not after now, and the two looks are close together (a longer gap means NOU was asleep or closed, and that start is ignored). */
export const MAX_GAP_MS = 2 * 60 * 1000;
export function dueCheckins(checkins: Checkin[], prevMs: number | null, nowMs: number, variant: "A" | "B"): (Checkin & { day: string })[] {
  if (prevMs === null || nowMs <= prevMs || nowMs - prevMs > MAX_GAP_MS) return [];
  const now = new Date(nowMs), day = localDay(now), weekday = weekdayOfDay(day);
  return checkins.filter(k => k.variant === variant && k.weekday === weekday).filter(k => {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, k.start_slot * 30).getTime();
    return prevMs < at && at <= nowMs;
  }).map(k => ({ ...k, day }));
}
export const WEEK_MASK_ALL = 127;
export const maskHas = (mask: number, weekday: number) => (mask & (1 << weekday)) !== 0;
export const maskToggle = (mask: number, weekday: number) => mask ^ (1 << weekday);
export const maskLabel = (mask: number) => (mask === 127 ? "every day" : mask === 31 ? "weekdays" : mask === 96 ? "weekends" : WEEKDAYS.filter((_, i) => maskHas(mask, i)).join(", "));
