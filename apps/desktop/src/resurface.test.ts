import { describe, expect, it } from "vitest";
import { localDate, readSnoozed, snooze, visible, untouched, reasonText, SNOOZE_DAYS, type Resurfaced } from "./resurface";

const item = (id: string, extra: Partial<Resurfaced> = {}): Resurfaced => ({ id, title: id, updated_at: "2025-01-01T00:00:00.000Z", created_at: "2024-01-01T00:00:00.000Z", reason: "stale", years_ago: null, ...extra });

describe("resurfacing helpers", () => {
  it("uses the local date, padded", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDate(new Date(2026, 10, 17, 0, 1))).toBe("2026-11-17");
  });
  it("snoozing hides a note until the date and not beyond it", () => {
    const snoozed = snooze({}, "a", "2026-11-17");
    expect(snoozed.a).toBe("2026-12-01");
    expect(SNOOZE_DAYS).toBe(14);
    expect(visible([item("a"), item("b")], snoozed, "2026-11-17").map(p => p.id)).toEqual(["b"]);
    expect(visible([item("a")], snoozed, "2026-12-01").map(p => p.id)).toEqual(["a"]);
    expect(snooze({}, "a", "2026-12-25").a).toBe("2027-01-08");
  });
  it("a month-end snooze rolls into the next month correctly", () => {
    expect(snooze({}, "x", "2026-02-20").x).toBe("2026-03-06");
  });
  it("reads stored snoozes defensively: junk, expired entries and bad ids are dropped", () => {
    expect(readSnoozed({ ok: "2026-12-01", old: "2026-11-01", bad: "tomorrow", "../x": "2026-12-01", n: 5 }, "2026-11-17")).toEqual({ ok: "2026-12-01" });
    for (const junk of [null, undefined, 5, "x", [], [1, 2]]) expect(readSnoozed(junk, "2026-11-17")).toEqual({});
  });
  it("describes how long a note has been left alone", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(untouched("2026-11-07T12:00:00Z", now)).toBe("10 days");
    expect(untouched("2026-06-17T12:00:00Z", now)).toBe("5 months");
    expect(untouched("2025-11-17T12:00:00Z", now)).toBe("1 year");
    expect(untouched("2023-11-17T12:00:00Z", now)).toBe("3 years");
    expect(untouched("nonsense", now)).toBe("");
    expect(untouched("2030-01-01T00:00:00Z", now)).toBe("0 days");
  });
  it("words the reason for each kind", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(reasonText(item("a", { reason: "anniversary", years_ago: 1 }), now)).toBe("Written a year ago today");
    expect(reasonText(item("a", { reason: "anniversary", years_ago: 4 }), now)).toBe("Written 4 years ago today");
    expect(reasonText(item("a", { updated_at: "2026-06-17T12:00:00Z" }), now)).toBe("Not edited for 5 months");
  });
});
