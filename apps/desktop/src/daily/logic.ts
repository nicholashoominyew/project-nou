// Pure rules for the Daily page. Days are Europe/London calendar days written "2026-11-27"; which sections a day has comes from section-registry.json.
import registry from "./section-registry.json";
import { addDays, appliesOn, localDay, logKey, parseDay, weekdayOfDay, type Habit, type LogMap } from "../habitsLogic";

export type Section = { id: string; title: string; order?: string; owner: string; days: number[]; ui: string; trust?: string; show_in_ui?: boolean };
export const SECTIONS = registry.sections as Section[];
export const THEMES = registry.weekday_themes as { day: number; theme: string; covers: string; code: string }[];
export const ZONE: string = registry.timezone;
export const themeOf = (day: string) => THEMES[weekdayOfDay(day)];

export const londonDay = (at: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** The cards a day has: shown in the UI, listed for that weekday, not the journal and not the focus line (which sits inside the summary). */
export const sectionsOn = (day: string): Section[] => SECTIONS.filter(s => s.id !== "journal" && s.id !== "focus" && s.show_in_ui !== false && s.days.includes(weekdayOfDay(day)));
/** Day-specific cards are drawn dashed, under the divider. */
export const isDaySpecific = (s: Section) => s.ui.startsWith("ghost");
export const daysLabel = (days: number[]): string => {
  const names = ["MONDAYS", "TUESDAYS", "WEDNESDAYS", "THURSDAYS", "FRIDAYS", "SATURDAYS", "SUNDAYS"];
  if (days.length === 7) return "EVERY DAY";
  if (days.join() === "0,1,2,3,4") return "WEEKDAYS";
  return days.map(d => names[d]).join(" AND ") + " ONLY";
};

// ---- journal ----
export const BLOCKS = [
  { id: "agenda", title: "Today’s Agenda" }, { id: "goals", title: "Goals For Today" }, { id: "win", title: "One small win" },
  { id: "quote", title: "Quote(s) of the day" }, { id: "learn", title: "Learnings Today" }, { id: "notes", title: "Notes" },
] as const;
export type BlockId = (typeof BLOCKS)[number]["id"];
export type Journal = Record<BlockId, string[]>;
export const toJournal = (raw: Partial<Record<string, string[]>> | null | undefined): Journal =>
  Object.fromEntries(BLOCKS.map(b => [b.id, raw?.[b.id]?.length ? [...raw[b.id]!] : [""]])) as Journal;
export const filled = (lines: string[]) => lines.filter(l => l.trim()).length;
export const wordCount = (j: Journal) => BLOCKS.flatMap(b => j[b.id]).join(" ").split(/\s+/).filter(Boolean).length;

// ---- calendar ----
export type Summary = { day: string; journal: "none" | "part" | "full"; goals: number; win: boolean; learn: boolean; open_todos: number; sections: number };
/** Six weeks from the Monday on or before the 1st (`month` is 0 to 11). */
export function sixWeeks(year: number, month: number): { day: string; inMonth: boolean }[] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(year, month, 1 - lead + i); return { day: localDay(d), inMonth: d.getMonth() === month }; });
}
/** The Monday to Sunday week a day is in. */
export const weekOf = (day: string) => Array.from({ length: 7 }, (_, i) => addDays(day, i - weekdayOfDay(day)));
export const habitsOn = (habits: Habit[], log: LogMap, day: string) =>
  habits.filter(h => appliesOn(h, day)).map(h => ({ id: h.id, name: h.name, done: log.get(logKey(day, h.id))?.state === "done" }));

export function monthStats(year: number, month: number, today: string, summaries: Map<string, Summary>, habits: Habit[], log: LogMap) {
  const days = sixWeeks(year, month).filter(c => c.inMonth && c.day <= today).map(c => c.day);
  const journalDays = days.filter(d => summaries.get(d)?.journal === "full").length;
  let done = 0, total = 0;
  for (const d of days) { const list = habitsOn(habits, log, d); done += list.filter(h => h.done).length; total += list.length; }
  // The streak runs up to today; today does not break it while it is still being written.
  let streak = 0, day = summaries.get(today)?.journal === "full" ? today : addDays(today, -1);
  while (summaries.get(day)?.journal === "full" && streak < 1000) { streak++; day = addDays(day, -1); }
  return { journalDays, daysSoFar: days.length, streak, habitsAverage: total ? Math.round((done / total) * 100) : 0 };
}
export const dayOfMonth = (day: string) => { const d = parseDay(day); return { n: d.getDate(), of: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() }; };
