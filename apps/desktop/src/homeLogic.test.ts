import { describe, expect, it } from "vitest";
import { activityLevel, editsPerDay, pickForDay, pickSunPlace, placeDate, rangePosition, staleFraction, sunPosition, sunTimes } from "./homeLogic";

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

describe("sunrise and sunset belong to the place's own day", () => {
  const LONDON = { lat: 51.5074, lng: -0.1278, tz: "Europe/London" }, KL = { lat: 3.139, lng: 101.6869, tz: "Asia/Kuala_Lumpur" };
  const hm = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  // 07:43 on 21 Nov in Kuala Lumpur is 23:43 on 20 Nov in London.
  const now = new Date("2026-11-20T23:43:00Z");
  it("in Kuala Lumpur at 07:43 the sun is up, with sunrise before and sunset after", () => {
    const t = sunTimes(now, KL.lat, KL.lng, KL.tz)!;
    expect(placeDate(t.rise, KL.lng, KL.tz)).toBe("2026-11-21");
    expect(hm(t.rise, KL.tz) >= "06:50" && hm(t.rise, KL.tz) <= "07:20").toBe(true);
    expect(hm(t.set, KL.tz) >= "18:50" && hm(t.set, KL.tz) <= "19:20").toBe(true);
    expect(sunPosition(now, t).up).toBe(true);
  });
  it("in London at the same moment it is night, after today's sunset (20 Nov), not before tomorrow's sunrise", () => {
    const t = sunTimes(now, LONDON.lat, LONDON.lng, LONDON.tz)!;
    expect(placeDate(t.rise, LONDON.lng, LONDON.tz)).toBe("2026-11-20");
    expect(hm(t.rise, LONDON.tz)).toMatch(/^07:[0-4]/); expect(hm(t.set, LONDON.tz)).toMatch(/^16:/);
    const p = sunPosition(now, t); expect(p.up).toBe(false); expect(p.fraction).toBe(1);
  });
  it("works the same just after local midnight and just before sunrise", () => {
    const early = new Date("2026-11-21T00:30:00Z"); // London 00:30 on the 21st
    const t = sunTimes(early, LONDON.lat, LONDON.lng, LONDON.tz)!;
    expect(placeDate(t.rise, LONDON.lng, LONDON.tz)).toBe("2026-11-21");
    expect(sunPosition(early, t)).toMatchObject({ up: false, fraction: 0 });
  });
  it("falls back to longitude when no time zone is known, and refuses bad coordinates", () => {
    expect(sunTimes(now, KL.lat, KL.lng)).not.toBeNull(); expect(sunTimes(now, 99, 0)).toBeNull();
    expect(placeDate(new Date("2026-11-20T23:43:00Z"), 101.7)).toBe("2026-11-21");
  });
  it("describes the place in the device's time zone, otherwise the first one", () => {
    expect(pickSunPlace(["Europe/London", "Asia/Kuala_Lumpur"], "Asia/Kuala_Lumpur")).toBe(1);
    expect(pickSunPlace(["Europe/London", "Asia/Kuala_Lumpur"], "Europe/London")).toBe(0);
    expect(pickSunPlace([null, undefined], "Asia/Tokyo")).toBe(0);
    expect(pickSunPlace(["Europe/London", "Asia/Kuala_Lumpur"], "Asia/Kuala_Lumpur", 0)).toBe(0); // a place picked by hand wins
    expect(pickSunPlace(["Europe/London", "Asia/Kuala_Lumpur"], "Asia/Kuala_Lumpur", 1, [true, false])).toBe(0); // unless it is no longer set
    expect(pickSunPlace(["Europe/London", null], "Asia/Tokyo", "auto", [false, true])).toBe(1);
  });
});
