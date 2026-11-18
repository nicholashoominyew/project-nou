import { describe, expect, it, vi } from "vitest";
import { clockParts, countdownState, groupByDay, monthGrid, normalizeCountdowns, parseDay, periods, validZone, zoneCity, type Countdown } from "./timeLogic";
import { fetchWeather, normalizePlaces, weatherLabel } from "./weather";

describe("clocks", () => {
  it("shows the same moment in different zones", () => {
    const at = new Date("2026-07-01T12:00:00Z");
    expect(clockParts(at, "UTC").time).toBe("12:00");
    expect(clockParts(at, "Asia/Tokyo").time).toBe("21:00");
    expect(clockParts(at, "America/New_York").time).toBe("08:00");
  });
  it("accepts real zones only, and falls back to UTC for a bad one", () => {
    expect(validZone("Europe/London")).toBe(true);
    for (const bad of ["", "Mars/Base", 5, null, "x".repeat(80)]) expect(validZone(bad)).toBe(false);
    expect(clockParts(new Date("2026-07-01T12:00:00Z"), "Mars/Base").time).toBe("12:00");
    expect(zoneCity("America/New_York")).toBe("New York");
  });
});

describe("progress through the year, quarter, month and day", () => {
  it("measures each period from its own start to its own end", () => {
    const [y, q, m, d] = periods(new Date(2026, 6, 1, 12, 0));
    expect(y.fraction).toBeCloseTo(181.5 / 365, 3); expect(y.label).toBe("2026");
    expect(q.label).toBe("Q3 2026"); expect(q.fraction).toBeCloseTo(0.5 / 92, 3);
    expect(m.label).toBe("July"); expect(m.fraction).toBeCloseTo(0.5 / 31, 3);
    expect(d.fraction).toBeCloseTo(0.5, 5); expect(d.left).toBe("12 h 0 min left");
  });
  it("starts at zero and always stays between 0 and 1", () => {
    for (const p of periods(new Date(2026, 0, 1, 0, 0))) { expect(p.fraction).toBe(0); }
    for (const p of periods(new Date(2026, 11, 31, 23, 59))) { expect(p.fraction).toBeGreaterThan(0.99); expect(p.fraction).toBeLessThanOrEqual(1); }
  });
});

describe("countdowns", () => {
  const cd = (end: string, unit: Countdown["unit"] = "day", start = "2026-01-01"): Countdown => ({ id: "a", label: "Launch", start, end, unit });
  const now = new Date(2026, 5, 10, 15, 0);
  it("counts days, weeks (with leftover days) and months (with leftover days)", () => {
    expect(countdownState(cd("2026-06-20"), now).text).toBe("10 days left");
    expect(countdownState(cd("2026-06-20", "week"), now).text).toBe("1 week 3 days left");
    expect(countdownState(cd("2026-06-17", "week"), now).text).toBe("1 week left");
    expect(countdownState(cd("2026-09-25", "month"), now).text).toBe("3 months 15 days left");
    expect(countdownState(cd("2026-06-11", "month"), now).text).toBe("1 day left");
  });
  it("fills the bar from the start date to the end date", () => {
    expect(countdownState(cd("2026-06-20", "day", "2026-06-10"), now).fraction).toBe(0);
    expect(countdownState(cd("2026-06-20", "day", "2026-05-31"), now).fraction).toBeCloseTo(10 / 20, 5);
  });
  it("says Today on the day and how long ago once it has passed, with a full bar", () => {
    expect(countdownState(cd("2026-06-10"), now)).toMatchObject({ text: "Today", done: true, fraction: 1 });
    expect(countdownState(cd("2026-06-08"), now)).toMatchObject({ text: "Finished 2 days ago", done: true });
  });
  it("cleans stored data: bad dates, empty names, duplicates, odd units and too many are dropped", () => {
    const good = { id: "a", label: " Trip ", start: "2026-01-01", end: "2026-02-01", unit: "week" };
    const list = normalizeCountdowns([good, good, { ...good, id: "b", end: "2026-02-31" }, { ...good, id: "c", label: " " }, { ...good, id: "d", end: "2025-12-01" }, { ...good, id: "e", unit: "year" }, null, "x"]);
    expect(list.map(c => [c.id, c.label, c.unit])).toEqual([["a", "Trip", "week"], ["e", "Trip", "day"]]);
    expect(normalizeCountdowns("nope")).toEqual([]);
    expect(normalizeCountdowns(Array.from({ length: 50 }, (_, i) => ({ ...good, id: "i" + i }))).length).toBe(30);
  });
});

describe("calendar maths", () => {
  it("parses only real days", () => {
    expect(parseDay("2026-02-28")).toBeTruthy(); expect(parseDay("2026-02-30")).toBeNull(); expect(parseDay("26-1-1")).toBeNull(); expect(parseDay(5)).toBeNull();
  });
  it("draws whole Monday-first weeks around the month", () => {
    const weeks = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(weeks.length).toBe(6); expect(weeks.every(w => w.length === 7)).toBe(true);
    expect(weeks[0][0].date).toBe("2026-10-26"); expect(weeks[0][6]).toEqual({ date: "2026-11-01", inMonth: true });
    expect(weeks.flat().filter(c => c.inMonth).length).toBe(30);
    expect(monthGrid(2027, 1).length).toBe(4); // February 2027 starts on a Monday and has 28 days
  });
  it("groups events by day and ignores events with a bad date", () => {
    const map = groupByDay([{ date: "2026-11-18", title: "a", kind: "row" }, { date: "2026-11-18", title: "b", kind: "daily" }, { date: "nope", title: "c", kind: "row" }]);
    expect(map.get("2026-11-18")?.length).toBe(2); expect(map.size).toBe(1);
  });
});

describe("weather", () => {
  const ok = { current: { temperature_2m: 21.6, weather_code: 2, wind_speed_10m: 9.4 }, daily: { temperature_2m_max: [24.2], temperature_2m_min: [15.1] } };
  const reply = (body: unknown, status = 200) => (async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch;
  it("reads a good answer and sends only the coordinates", async () => {
    let url = "";
    const w = await fetchWeather({ name: "Paris", lat: 48.85661, lng: 2.35222 }, undefined, (async (u: string) => { url = u; return { ok: true, status: 200, json: async () => ok }; }) as unknown as typeof fetch);
    expect(w).toEqual({ timezone: null, temp: 22, high: 24, low: 15, wind: 9, label: "Partly cloudy", code: 2 });
    expect(url).toContain("latitude=48.857&longitude=2.352"); expect(url).not.toContain("Paris");
  });
  it("refuses an answer it cannot read and reports a failing service", async () => {
    await expect(fetchWeather({ name: "x", lat: 1, lng: 1 }, undefined, reply({ current: { temperature_2m: "hot" } }))).rejects.toThrow(/could not read/);
    await expect(fetchWeather({ name: "x", lat: 1, lng: 1 }, undefined, reply({}, 500))).rejects.toThrow(/returned 500/);
  });
  it("stops waiting after ten seconds and says the service did not answer, and says so when it cannot be reached at all", async () => {
    vi.useFakeTimers();
    try {
      const hang = ((_u: string, o: { signal: AbortSignal }) => new Promise((_res, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
      const pending = expect(fetchWeather({ name: "x", lat: 1, lng: 1 }, undefined, hang)).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(10001);
      await pending;
    } finally { vi.useRealTimers(); }
    const down = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(fetchWeather({ name: "x", lat: 1, lng: 1 }, undefined, down)).rejects.toThrow(/Could not reach/);
  });
  it("keeps two valid places and labels the weather codes", () => {
    expect(normalizePlaces([{ name: "A", lat: 1, lng: 2 }, { name: "B", lat: 200, lng: 0 }, { name: "C", lat: 3, lng: 4 }])).toEqual([{ name: "A", lat: 1, lng: 2 }, null]);
    expect(normalizePlaces("x")).toEqual([null, null]);
    expect([0, 3, 45, 63, 73, 81, 95, 999].map(weatherLabel)).toEqual(["Clear", "Overcast", "Fog", "Rain", "Snow", "Showers", "Thunderstorm", "Unknown"]);
  });
});
