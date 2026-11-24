import { describe, expect, it } from "vitest";
import { addDays, answerSplit, appliesOn, dueCheckins, indexLog, localDay, maskLabel, maskToggle, monthGrid, parseDay, progressOn, slotRange, streaks, totalsPerHabit, weekdayOfDay, weeklyTrend, type Checkin, type Habit, type LogEntry, type LogState } from "./habitsLogic";

const habit = (id: string, over: Partial<Habit> = {}): Habit => ({ id, name: id, days: 127, sort_order: 0, created_at: new Date(2026, 0, 1, 12).toISOString(), ...over });
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

describe("which check-ins are due", () => {
  const monday = new Date(2026, 10, 23); // Monday 23 Nov 2026
  const at = (h: number, m = 0, s = 0) => new Date(2026, 10, 23, h, m, s).getTime();
  const k = (id: string, over: Partial<Checkin> = {}): Checkin => ({ id, habit_id: "h", weekday: 0, start_slot: 10, end_slot: 11, variant: "A", ...over });
  void monday;
  it("a block that starts between two looks is due once, and both habits of one block are due together", () => {
    const list = [k("workout"), k("anki"), k("late", { start_slot: 12 })];
    expect(dueCheckins(list, at(4, 59, 58), at(5, 0, 3), "A").map(x => x.id)).toEqual(["workout", "anki"]);
    expect(dueCheckins(list, at(5, 0, 3), at(5, 0, 8), "A")).toEqual([]); // the next look: already past
    expect(dueCheckins(list, at(4, 59, 58), at(5, 0, 3), "A")[0].day).toBe("2026-11-23");
  });
  it("only the right weekday and week count, and never the end of a block", () => {
    expect(dueCheckins([k("a", { weekday: 1 })], at(4, 59, 58), at(5, 0, 3), "A")).toEqual([]); expect(dueCheckins([k("a", { variant: "B" })], at(4, 59, 58), at(5, 0, 3), "A")).toEqual([]);
    expect(dueCheckins([k("a")], at(5, 29, 58), at(5, 30, 3), "A")).toEqual([]); // 05:30 is the end of this block: nothing happens there
  });
  it("a start while NOU was closed or asleep is ignored: the two looks must be close together", () => {
    expect(dueCheckins([k("a")], null, at(5, 0, 3), "A")).toEqual([]); // first look after starting
    expect(dueCheckins([k("a")], at(4, 50), at(5, 5), "A")).toEqual([]); // a 15-minute gap
    expect(dueCheckins([k("a")], at(4, 59, 0), at(5, 0, 50), "A").length).toBe(1); // a short gap is fine
    expect(dueCheckins([k("a")], at(5, 0, 3), at(4, 59), "A")).toEqual([]); // the clock went backwards
  });
  it("a block at midnight starts the new day", () => {
    const list = [k("m", { weekday: 1, start_slot: 0, end_slot: 2 })];
    const r = dueCheckins(list, new Date(2026, 10, 23, 23, 59, 58).getTime(), new Date(2026, 10, 24, 0, 0, 2).getTime(), "A"); expect(r.map(x => [x.id, x.day])).toEqual([["m", "2026-11-24"]]);
  });
});
