import { describe, expect, it } from "vitest";
import { heatCells, heatLayout, habitRate, rangeStats, weekBlocks, addDays, answerSplit, appliesOn, activeCheckins, blockRunning, indexLog, localDay, maskLabel, maskToggle, monthGrid, parseDay, progressOn, slotRange, streaks, totalsPerHabit, weekdayOfDay, weeklyTrend, type Checkin, type Habit, type LogEntry, type LogState } from "./habitsLogic";

const habit = (id: string, over: Partial<Habit> = {}): Habit => ({ id, name: id, days: 127, sort_order: 0, created_at: new Date(2026, 0, 1, 12).toISOString(), category: "Health", ...over });
const entry = (day: string, habit_id: string, state: LogState = "done"): LogEntry => ({ day, habit_id, state, answered_at: null, source: "manual" });
const log = (...e: LogEntry[]) => indexLog(e);

describe("days", () => {
  it("are local calendar days, counted without time-zone surprises", () => {
    expect(localDay(new Date(2026, 10, 24, 23, 59))).toBe("2026-11-24"); expect(addDays("2026-11-30", 1)).toBe("2026-12-01"); expect(addDays("2027-01-01", -1)).toBe("2026-12-31"); expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect([weekdayOfDay("2026-11-23"), weekdayOfDay("2026-11-29"), weekdayOfDay("2026-11-28")]).toEqual([0, 6, 5]); expect(parseDay("2026-11-24").getDate()).toBe(24);
    expect(slotRange(10, 11)).toBe("05:00–05:30"); expect(slotRange(47, 48)).toBe("23:30–24:00");
  });
  it("a habit counts from its start day and only on its weekdays", () => {
    const h = habit("a", { days: 0b0011111, created_at: new Date(2026, 10, 10, 12).toISOString() }); // Mon-Fri, from 10 Nov 2026
    expect([appliesOn(h, "2026-11-09"), appliesOn(h, "2026-11-10"), appliesOn(h, "2026-11-14"), appliesOn(h, "2026-11-16")]).toEqual([false, true, false, true]);
    expect(maskLabel(127)).toBe("every day"); expect(maskLabel(31)).toBe("weekdays"); expect(maskLabel(96)).toBe("weekends"); expect(maskLabel(0b1000101)).toBe("Mon, Wed, Sun"); expect(maskToggle(127, 6)).toBe(63);
  });
});

describe("progress", () => {
  it("is done out of the habits that count that day, and empty when none count", () => {
    const hs = [habit("a"), habit("b"), habit("c", { days: 0b0000001 })]; // c is Mondays only
    const l = log(entry("2026-11-24", "a"), entry("2026-11-24", "b", "skipped"), entry("2026-11-23", "c"));
    expect(progressOn(hs, l, "2026-11-24")).toEqual({ done: 1, total: 2, pct: 50 }); // a Tuesday: c does not count, a skipped habit is not done
    expect(progressOn(hs, l, "2026-11-23")).toEqual({ done: 1, total: 3, pct: 33 });
    expect(progressOn([habit("z", { created_at: new Date(2027, 0, 1, 12).toISOString() })], l, "2026-11-24")).toEqual({ done: 0, total: 0, pct: null });
  });
});

describe("streaks", () => {
  it("count consecutive done days; skipped, no answer and empty days break them; days that do not apply are passed over", () => {
    const h = habit("a", { days: 0b0011111, created_at: new Date(2026, 10, 2, 12).toISOString() }); // Mon-Fri
    const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", /* weekend */ "2026-11-09", "2026-11-10"];
    expect(streaks(h, log(...days.map(d => entry(d, "a"))), "2026-11-10")).toEqual({ current: 7, best: 7 });
    expect(streaks(h, log(...days.filter(d => d !== "2026-11-09").map(d => entry(d, "a")), entry("2026-11-09", "a", "skipped")), "2026-11-10")).toEqual({ current: 1, best: 5 }); // broken by a skip on the 9th
    expect(streaks(h, log(...days.slice(0, 5).map(d => entry(d, "a"))), "2026-11-10")).toEqual({ current: 0, best: 5 }); // the 9th is empty and the day is over
  });
  it("today does not break a run until it is over", () => {
    const h = habit("a", { created_at: new Date(2026, 10, 1, 12).toISOString() });
    const l = log(entry("2026-11-01", "a"), entry("2026-11-02", "a"), entry("2026-11-03", "a"));
    expect(streaks(h, l, "2026-11-04")).toEqual({ current: 3, best: 3 }); // today empty: the run so far stands
    expect(streaks(h, log(...[...l.values()], entry("2026-11-04", "a", "skipped")), "2026-11-04")).toEqual({ current: 0, best: 3 });
    expect(streaks(h, log(...[...l.values()], entry("2026-11-04", "a")), "2026-11-04")).toEqual({ current: 4, best: 4 });
    expect(streaks(habit("n", { created_at: new Date(2026, 10, 4, 12).toISOString() }), log(), "2026-11-04")).toEqual({ current: 0, best: 0 });
  });
});

describe("totals for the charts", () => {
  const hs = [habit("a"), habit("b")]; const l = log(entry("2026-11-23", "a"), entry("2026-11-24", "a"), entry("2026-11-24", "b"), entry("2026-11-25", "a", "no_answer"), entry("2026-11-17", "b"));
  it("weekly trend: the last weeks, Monday to Sunday, up to today", () => {
    const t = weeklyTrend(hs, l, "2026-11-25", 2); // Wednesday 25 Nov: this week Mon 23-Wed 25, last week from Mon 16
    expect(t.map(w => w.start)).toEqual(["2026-11-16", "2026-11-23"]);
    expect(t[1]).toEqual({ start: "2026-11-23", done: 3, total: 6, pct: 50 }); expect(t[0]).toEqual({ start: "2026-11-16", done: 1, total: 14, pct: 7 });
    expect(weeklyTrend([], l, "2026-11-25", 1)[0].pct).toBeNull();
  });
  it("per habit: days done of days it applied", () => {
    const r = totalsPerHabit(hs, l, "2026-11-23", "2026-11-25"); expect(r.map(x => [x.habit.id, x.done, x.total, x.pct])).toEqual([["a", 2, 3, 67], ["b", 1, 3, 33]]);
  });
  it("answers split three ways, for the chosen habits and days", () => {
    const entries = [...l.values()]; expect(answerSplit(entries, "2026-11-23", "2026-11-25", new Set(["a", "b"]))).toEqual({ done: 3, skipped: 0, no_answer: 1 }); expect(answerSplit(entries, "2026-11-23", "2026-11-25", new Set(["b"]))).toEqual({ done: 1, skipped: 0, no_answer: 0 });
  });
});

describe("the month calendar", () => {
  it("starts on Monday and pads to whole weeks", () => {
    const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(g.length).toBe(6); expect(g[0][0]).toEqual({ day: "2026-10-26", inMonth: false }); expect(g[0][6]).toEqual({ day: "2026-11-01", inMonth: true }); expect(g[5][1]).toEqual({ day: "2026-12-01", inMonth: false });
    expect(g.flat().filter(c => c.inMonth).length).toBe(30);
    expect(monthGrid(2026, 1).length).toBe(5); // February 2026 starts on a Sunday and has 28 days
    expect(monthGrid(2027, 1).length).toBe(4); // February 2027 starts on a Monday: exactly four weeks
  });
});

describe("which check-ins are running", () => {
  const at = (h: number, m = 0, s = 0) => new Date(2026, 10, 23, h, m, s).getTime(); // Monday 23 Nov 2026
  const k = (id: string, over: Partial<Checkin> = {}): Checkin => ({ id, habit_id: "h", weekday: 0, start_slot: 10, end_slot: 11, variant: "A", ...over });
  it("is on from the start of the block until just before its end, and both habits of one block are on together", () => {
    const list = [k("workout"), k("anki")];
    expect(activeCheckins(list, at(4, 59, 59), "A")).toEqual([]);
    expect(activeCheckins(list, at(5, 0, 0), "A").map(x => x.id)).toEqual(["workout", "anki"]);
    expect(activeCheckins(list, at(5, 29, 59), "A").length).toBe(2); // still on for the whole block
    expect(activeCheckins(list, at(5, 30, 0), "A")).toEqual([]); // 05:30 is the end: nothing at the end
    expect(activeCheckins(list, at(5, 10), "A")[0].day).toBe("2026-11-23");
  });
  it("opening NOU in the middle of a block still shows it, but only the right weekday and week count", () => {
    expect(activeCheckins([k("a")], at(5, 20), "A").length).toBe(1);
    expect(activeCheckins([k("a", { weekday: 1 })], at(5, 20), "A")).toEqual([]);
    expect(activeCheckins([k("a", { variant: "B" })], at(5, 20), "A")).toEqual([]);
  });
  it("a long block stays on across its whole length", () => {
    const long = [k("l", { start_slot: 10, end_slot: 16 })]; // 05:00-08:00
    expect(activeCheckins(long, at(7, 59), "A").length).toBe(1); expect(activeCheckins(long, at(8, 0), "A")).toEqual([]);
  });
  it("a shown pop-up is visible only while its block is running, on its own day", () => {
    const ev = { day: "2026-11-23", start_slot: 10, end_slot: 11 };
    expect(blockRunning(ev, at(5, 0))).toBe(true); expect(blockRunning(ev, at(5, 30))).toBe(false); expect(blockRunning(ev, at(4, 59))).toBe(false);
    expect(blockRunning(ev, new Date(2026, 10, 24, 5, 10).getTime())).toBe(false);
  });
});

describe("the redesigned page's numbers", () => {
  const T = "2026-11-25"; // a Wednesday
  const hs = [habit("a"), habit("b", { days: 31 })]; // b counts Monday to Friday only
  const days = (n: number) => Array.from({ length: n }, (_, i) => addDays(T, -i));
  it("a rate is days done out of days the habit counted, and none when it counted on no day", () => {
    const l = log(entry(T, "a"), entry(addDays(T, -1), "a"));
    expect(habitRate(hs[0], l, T, 4)).toBe(0.5); expect(habitRate(hs[0], l, T, 7)).toBeCloseTo(2 / 7);
    const weekend = habit("w", { days: 96 }); expect(habitRate(weekend, l, T, 2)).toBeNull(); // Tue and Wed are not weekend days
    expect(habitRate(habit("late", { created_at: new Date(2026, 10, 24, 12).toISOString() }), log(), T, 30)).toBe(0); // only 2 days counted, none done
  });
  it("completion, full days and days with a tick follow each habit's schedule", () => {
    const l = log(...days(3).flatMap(d => [entry(d, "a"), entry(d, "b")]), entry(addDays(T, -3), "a")); // Wed, Tue, Mon: both; Sun: a only (b does not count on Sunday)
    expect(rangeStats(hs, l, T, 4)).toEqual({ completion: 1, fullDays: 4, activeDays: 4, days: 4 });
    expect(rangeStats(hs, log(entry(T, "a")), T, 2)).toEqual({ completion: 0.25, fullDays: 0, activeDays: 1, days: 2 });
    expect(rangeStats([], log(), T, 7).completion).toBeNull();
  });
  it("the weekly chart is eight blocks of seven days ending today, labelled NOW and W-1 to W-7", () => {
    const l = log(...days(7).map(d => entry(d, "a")));
    const w = weekBlocks([hs[0]], l, T, 8); expect(w).toHaveLength(8); expect(w.map(x => x.label)).toEqual(["W-7", "W-6", "W-5", "W-4", "W-3", "W-2", "W-1", "NOW"]);
    expect(w[7].pct).toBe(1); expect(w[6].pct).toBe(0);
  });
  it("the heatmap layout changes with the range, and a weekday grid is padded so the first day is on its weekday row", () => {
    expect([7, 30, 90].map(n => heatLayout(n))).toEqual([{ size: 44, gap: 8, rows: 1, radius: 12 }, { size: 24, gap: 5, rows: 7, radius: 6 }, { size: 14, gap: 4, rows: 7, radius: 3 }]);
    const seven = heatCells(hs[0], log(entry(T, "a")), T, 7); expect(seven).toHaveLength(7); expect(seven.at(-1)).toMatchObject({ day: T, state: "done", today: true }); expect(seven[0].state).toBe("missed");
    const thirty = heatCells(hs[0], log(), T, 30); expect(thirty[0].state).toBe("pad"); // 2026-10-27 is a Tuesday: one blank above it (Monday)
    expect(thirty.filter(c => c.state === "pad")).toHaveLength(1); expect(thirty).toHaveLength(31); expect(thirty[1].day).toBe("2026-10-27");
    const b = heatCells(hs[1], log(), T, 7); expect(b.filter(c => c.state === "off").map(c => weekdayOfDay(c.day))).toEqual([5, 6]); // not a day for this habit
  });
});
