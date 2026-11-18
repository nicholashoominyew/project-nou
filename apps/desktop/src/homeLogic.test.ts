import { describe, expect, it } from "vitest";
import { activityLevel, editsPerDay, pickForDay, rangePosition, staleFraction, sunPosition, sunTimes, writingDays } from "./homeLogic";

describe("sunTimes", () => {
  it("gives London's mid-November daylight to within a few minutes", () => {
    const t = sunTimes(new Date("2026-11-18T12:00:00Z"), 51.5074, -0.1278)!;
    const mins = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
    expect(Math.abs(mins(t.rise) - (7 * 60 + 25))).toBeLessThanOrEqual(8);
    expect(Math.abs(mins(t.set) - (16 * 60 + 5))).toBeLessThanOrEqual(8);
  });
  it("gives the equator about twelve hours all year, and nothing in polar night or midnight sun", () => {
    const t = sunTimes(new Date("2026-06-21T12:00:00Z"), 0, 0)!;
    expect((t.set.getTime() - t.rise.getTime()) / 3600000).toBeCloseTo(12.1, 0);
    expect(sunTimes(new Date("2026-12-21T12:00:00Z"), 80, 0)).toBeNull();
    expect(sunTimes(new Date("2026-06-21T12:00:00Z"), 80, 0)).toBeNull();
    expect(sunTimes(new Date(), 91, 0)).toBeNull();
  });
  it("places the sun on its arc and says when it is night", () => {
    const t = { rise: new Date("2026-11-18T07:00:00Z"), set: new Date("2026-11-18T17:00:00Z") };
    expect(sunPosition(new Date("2026-11-18T12:00:00Z"), t)).toEqual({ fraction: 0.5, up: true, leftMinutes: 300 });
    expect(sunPosition(new Date("2026-11-18T20:00:00Z"), t)).toMatchObject({ fraction: 1, up: false, leftMinutes: 0 });
    expect(sunPosition(new Date("2026-11-18T03:00:00Z"), t)).toMatchObject({ fraction: 0, up: false });
  });
});

describe("writing streak", () => {
  const today = new Date(2026, 10, 18, 9, 0);
  it("marks the last 14 days with a daily page and counts the run ending today", () => {
    const r = writingDays(["2026-11-18", "2026-11-17", "2026-11-16", "2026-11-14", " 2026-11-10 ", "Plain page", "2026-13-01"], today);
    expect(r.days.length).toBe(14);
    expect(r.days[13]).toEqual({ date: "2026-11-18", written: true });
    expect(r.days[0].date).toBe("2026-11-05");
    expect(r.days.filter(d => d.written).length).toBe(5);
    expect(r.streak).toBe(3);
  });
  it("keeps yesterday's run alive while today is not written yet, and is zero otherwise", () => {
    expect(writingDays(["2026-11-17", "2026-11-16"], today).streak).toBe(2);
    expect(writingDays(["2026-11-10"], today).streak).toBe(0);
  });
});

describe("small helpers", () => {
  it("shades a day by how many items it has", () => { expect([0, 1, 2, 3, 9].map(activityLevel)).toEqual([0, 1, 2, 3, 3]); });
  it("counts edits per day with today last and ignores old or broken dates", () => {
    const today = new Date(2026, 10, 18, 12, 0);
    const bars = editsPerDay([new Date(2026, 10, 18, 8).toISOString(), new Date(2026, 10, 18, 9).toISOString(), new Date(2026, 10, 5, 8).toISOString(), new Date(2026, 10, 4, 8).toISOString(), "nope"], today);
    expect(bars.length).toBe(14);
    expect(bars[13]).toBe(2);
    expect(bars[0]).toBe(1);
    expect(bars.reduce((a, b) => a + b, 0)).toBe(3);
  });
  it("places a temperature in its range, and a note's age against a year", () => {
    expect(rangePosition(15, 10, 20)).toBe(0.5);
    expect(rangePosition(30, 10, 20)).toBe(1);
    expect(rangePosition(5, 10, 10)).toBe(0.5);
    expect(staleFraction(73)).toBeCloseTo(0.2, 5);
    expect(staleFraction(1000)).toBe(1);
    expect(staleFraction(null)).toBe(0);
  });
  it("picks the same five all day and moves on tomorrow", () => {
    const list = Array.from({ length: 20 }, (_, i) => i);
    const a = pickForDay(list, "2026-11-18"), b = pickForDay(list, "2026-11-18"), c = pickForDay(list, "2026-11-19");
    expect(a).toEqual(b);
    expect(a.length).toBe(5);
    expect(new Set(a).size).toBe(5);
    expect(c).not.toEqual(a);
    expect(pickForDay([1, 2], "x")).toEqual([1, 2]);
  });
});
