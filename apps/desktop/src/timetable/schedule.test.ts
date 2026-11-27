// The test process runs in London time so the clock-change days (BST/GMT) are real.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/London";
import { describe, expect, it, vi } from "vitest";
import seedText from "../../src-tauri/seed/life_timetable.json?raw";
import { buildGrids, countdown, countdownParts, dayBlocks, distribution, eventAfter, eventAt, fmtDuration, fmtHours, isoWeek, progress, reminderFor, slotOf, variantFor, weekdayOf, type Activity, type Grid, type SlotRow, type Timeline, type Variant } from "./schedule";

type Runs = [string, string, string[]][];
interface Seed { activities: { name: string; category: Activity["category"]; remind: boolean }[]; days: Record<string, Runs>; variants: Record<string, Record<string, Runs>> }
const seed = JSON.parse(seedText) as Seed;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const activities: Activity[] = seed.activities.map((a, i) => ({ id: "a:" + a.name, name: a.name, category: a.category, colour: null, remind: a.remind, sort_order: i }));
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
function rowsFromSeed(): SlotRow[] {
  const rows: SlotRow[] = [];
  for (const variant of ["A", "B"] as Variant[]) DAYS.forEach((d, weekday) => (seed.variants[variant]?.[d] ?? seed.days[d]).forEach(([s, e, who]) => { for (let i = mins(s) / 10; i < mins(e) / 10; i++) who.forEach(n => rows.push({ variant, weekday, slot_index: i, activity_id: "a:" + n })); }));
  return rows;
}
const grids = buildGrids(rowsFromSeed());
const tl = (swap = false): Timeline => ({ grids, swap });
// 2026-11-16 is a Monday and in ISO week 47 (odd = A).
const at = (iso: string) => { const [d, t] = iso.split(" "); const [y, m, day] = d.split("-").map(Number); const [h, mi, s] = t.split(":").map(Number); return new Date(y, m - 1, day, h, mi, s ?? 0); };
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const nm = (ev: { ids: string[] } | null) => (ev ? ev.ids.map(i => i.slice(2)).join(" + ") : "none");

describe("which week is this: A or B", () => {
  it("is A in odd ISO weeks and B in even ones: week 47 of 2026 (16-22 Nov) is A", () => {
    expect(isoWeek(at("2026-11-16 00:00:00"))).toBe(47); expect(isoWeek(at("2026-11-22 23:59:00"))).toBe(47);
    expect(variantFor(at("2026-11-16 08:00:00"), false)).toBe("A"); expect(variantFor(at("2026-11-22 23:59:00"), false)).toBe("A");
    expect(isoWeek(at("2026-11-23 00:00:00"))).toBe(48); expect(variantFor(at("2026-11-23 00:00:00"), false)).toBe("B");
  });
  it("the swap setting flips it", () => {
    expect(variantFor(at("2026-11-16 08:00:00"), true)).toBe("B"); expect(variantFor(at("2026-11-23 08:00:00"), true)).toBe("A");
  });
  it("uses ISO weeks, so early January can belong to the old year's last week (53 weeks in 2026)", () => {
    expect(isoWeek(at("2027-01-01 12:00:00"))).toBe(53); expect(variantFor(at("2027-01-01 12:00:00"), false)).toBe("A");
    expect(isoWeek(at("2027-01-04 12:00:00"))).toBe(1);
  });
});

describe("the seed", () => {
  it("fills all 144 slots of every day in both weeks, and only the Saturday differs", () => {
    for (const v of ["A", "B"] as Variant[]) for (let d = 0; d < 7; d++) expect(grids[v].slice(d * 144, d * 144 + 144).every(c => c.length > 0)).toBe(true);
    const diff = grids.A.map((c, i) => (c.join() !== grids.B[i].join() ? i : -1)).filter(i => i >= 0);
    expect(diff.length).toBe(45); expect(diff.every(i => Math.floor(i / 144) === 5 && i % 144 >= 69 && i % 144 < 114)).toBe(true);
    expect(grids.A[5 * 144 + 69]).toEqual(["a:Dark Sphere"]); expect(grids.B[5 * 144 + 69]).toEqual(["a:Deep learning (library)"]);
  });
});

describe("the current event", () => {
  it("is a run of identical slots, ending at the end of the run and not the slot", () => {
    const now = at("2026-11-16 10:12:00");
    const ev = eventAt(tl(), now)!; // Monday: Work 09:00-13:00
    expect(nm(ev)).toBe("Work"); expect([hhmm(ev.start), hhmm(ev.end)]).toEqual(["09:00", "13:00"]);
    expect(countdown(ev.end.getTime() - now.getTime())).toBe("02:48:00");
    expect(progress(ev, at("2026-11-16 11:00:00"))).toBeCloseTo(0.5, 5);
  });
  it("keeps slots with several activities together", () => {
    const ev = eventAt(tl(), at("2026-11-16 05:10:00"))!;
    expect(ev.ids.length).toBe(4); expect(ev.ids).toContain("a:Walk"); expect(ev.slots).toBe(3);
    expect(nm(eventAt(tl(), at("2026-11-17 05:10:00")))).toContain("Exercise");
  });
  it("two runs that share a name are separate events: Work before and after the meal", () => {
    const morning = eventAt(tl(), at("2026-11-16 12:59:00"))!; expect(hhmm(morning.end)).toBe("13:00");
    const after = eventAfter(tl(), morning)!; expect(nm(after)).toBe("Meal"); expect([hhmm(after.start), hhmm(after.end)]).toEqual(["13:00", "13:30"]);
  });
  it("follows the week's variant: Saturday 12:00 is Dark Sphere in week A and Deep learning in week B", () => {
    expect(nm(eventAt(tl(), at("2026-11-21 12:00:00")))).toBe("Dark Sphere");
    expect(nm(eventAt(tl(), at("2026-11-28 12:00:00")))).toBe("Deep learning (library)");
    expect(nm(eventAt(tl(true), at("2026-11-21 12:00:00")))).toBe("Deep learning (library)");
    const ev = eventAt(tl(), at("2026-11-21 12:00:00"))!; expect([hhmm(ev.start), hhmm(ev.end)]).toEqual(["11:30", "19:00"]);
  });
  it("wraps across midnight and from Sunday into Monday as one event", () => {
    const sundayNight = at("2026-11-22 22:30:00"); expect(weekdayOf(sundayNight)).toBe(6);
    const ev = eventAt(tl(), sundayNight)!; expect(nm(ev)).toBe("Bed time");
    expect(ev.start.getTime()).toBe(at("2026-11-22 22:00:00").getTime()); expect(ev.end.getTime()).toBe(at("2026-11-23 05:00:00").getTime());
    expect(eventAt(tl(), at("2026-11-23 01:00:00"))!.start.getTime()).toBe(at("2026-11-22 22:00:00").getTime());
    expect(nm(eventAfter(tl(), ev))).toContain("Shower + Breakfast");
  });
  it("reads each side of the Sunday boundary from its own week's variant", () => {
    const fill = (id: string): Grid => Array.from({ length: 1008 }, () => [id]);
    const a = fill("a:Bed time"), b = fill("a:Bed time");
    for (let i = 0; i < 30; i++) b[i] = ["a:Night shift"]; // Monday 00:00-05:00 differs only in week B
    const mixed: Timeline = { grids: { A: a, B: b }, swap: false };
    // Sunday 22 Nov 2026 is in week 47 (A); the Monday after is in week 48 (B): the night shift starts at midnight.
    const ev = eventAt(mixed, at("2026-11-22 23:00:00"))!; expect(nm(ev)).toBe("Bed time"); expect(ev.end.getTime()).toBe(at("2026-11-23 00:00:00").getTime());
    const next = eventAfter(mixed, ev)!; expect(nm(next)).toBe("Night shift"); expect([hhmm(next.start), hhmm(next.end)]).toEqual(["00:00", "05:00"]);
    // The other way round: Sunday 29 Nov is in week 48 (B), the Monday after is week 49 (A): no night shift, Bed time carries on.
    const later = eventAt(mixed, at("2026-11-29 23:00:00"))!; expect(nm(later)).toBe("Bed time"); expect(later.end.getTime()).toBeGreaterThan(at("2026-11-30 06:00:00").getTime());
    // After midnight, the slots before it come from the earlier week and the event is in the later week's variant.
    const early = eventAt(mixed, at("2026-11-23 01:00:00"))!; expect(nm(early)).toBe("Night shift"); expect(hhmm(early.start)).toBe("00:00");
  });
  it("is not confused when nothing is planned", () => {
    const t: Timeline = { grids: buildGrids([]), swap: false };
    const ev = eventAt(t, at("2026-11-16 10:00:00"))!;
    expect(ev.ids).toEqual([]); expect(eventAfter(t, ev)).toBeNull();
    expect(reminderFor(t, activities, at("2026-11-16 10:00:00"), 5, null)).toBeNull();
  });
});

describe("clock changes", () => {
  it("counts real time to the end of a run on the night the clocks go back (25 Oct 2026, a 25-hour day)", () => {
    const now = at("2026-10-25 00:30:00"); const ev = eventAt(tl(), now)!;
    expect([hhmm(ev.start), hhmm(ev.end)]).toEqual(["23:30", "09:00"]);
    expect(ev.end.getTime() - now.getTime()).toBe(9.5 * 3600 * 1000);
  });
  it("counts real time on the night the clocks go forward (29 Mar 2026, a 23-hour day)", () => {
    const now = at("2026-03-29 00:30:00");
    const ev = eventAt(tl(), now)!; expect(hhmm(ev.end)).toBe("09:00");
    expect(ev.end.getTime() - now.getTime()).toBe(7.5 * 3600 * 1000);
  });
  it("finds the slot from wall-clock time", () => { expect(slotOf(at("2026-10-25 09:00:00"))).toBe(6 * 144 + 54); });
});

describe("sleep and resume", () => {
  it("is computed from the clock, so a long jump lands on the right event", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at("2026-11-16 08:10:00")); expect(nm(eventAt(tl(), new Date()))).toBe("Admin");
      vi.setSystemTime(at("2026-11-16 14:20:00"));
      const ev = eventAt(tl(), new Date())!; expect(nm(ev)).toBe("Work"); expect(hhmm(ev.start)).toBe("13:30");
    } finally { vi.useRealTimers(); }
  });
});

describe("countdown parts and number formats", () => {
  it("shows hours only from one hour up, minutes as a plain number under an hour, seconds always two digits", () => {
    expect(countdownParts((3600 + 23 * 60 + 45) * 1000)).toMatchObject({ showH: true, h: "1", m: "23", s: "45" });
    expect(countdownParts((23 * 60 + 45) * 1000)).toMatchObject({ showH: false, m: "23", s: "45" });
    expect(countdownParts(5 * 60000 + 7000)).toMatchObject({ showH: false, m: "5", s: "07" });
    expect(countdownParts(2 * 3600000 + 4 * 60000)).toMatchObject({ showH: true, h: "2", m: "04", s: "00" });
    expect(countdownParts(-5)).toMatchObject({ showH: false, m: "0", s: "00" });
    expect(countdownParts(3723000).aria).toBe("1h 2m 3s left");
  });
  it("formats hours to 2 decimals under 10 and 1 decimal from 10, trimming zeros", () => {
    expect([0, 0.5, 7.5, 8.3333, 9.999, 10, 12.34, 33.5, 168].map(fmtHours)).toEqual(["0", "0.5", "7.5", "8.33", "10", "10", "12.3", "33.5", "168"]);
    expect([fmtDuration(30), fmtDuration(90), fmtDuration(10), fmtDuration(240)]).toEqual(["30m", "1h 30m", "10m", "4h 00m"]);
  });
});

describe("time distribution: every day is 24 h and every week 168 h", () => {
  const sum = (h: Record<string, number>) => Object.values(h).reduce((a, b) => a + b, 0);
  it("adds up for every day and for the week, in both variants", () => {
    for (const v of ["A", "B"] as Variant[]) {
      for (let d = 0; d < 7; d++) { const r = distribution(grids[v], activities, d); expect(r.total).toBe(24); expect(sum(r.hours)).toBeCloseTo(24, 9); }
      const w = distribution(grids[v], activities, null); expect(w.total).toBe(168); expect(sum(w.hours)).toBeCloseTo(168, 9);
    }
  });
  it("splits a slot equally between its activities (10/n minutes each)", () => {
    const a = (id: string, category: Activity["category"]): Activity => ({ id, name: id, category, colour: null, remind: true, sort_order: 0 });
    const acts = [a("x", "Work"), a("y", "Rest"), a("z", "Rest")];
    const g: Grid = Array.from({ length: 1008 }, () => ["x"]); g[0] = ["x", "y", "z"];
    const r = distribution(g, acts, 0);
    expect(r.hours.Work).toBeCloseTo((143 * 10 + 10 / 3) / 60, 9); expect(r.hours.Rest).toBeCloseTo(20 / 3 / 60, 9); expect(sum(r.hours)).toBeCloseTo(24, 9);
  });
  it("follows the day or the whole week: Monday has 7.5 h of Work, the week 37.5 h", () => {
    expect(distribution(grids.A, activities, 0).hours.Work).toBeCloseTo(7.5, 9);
    expect(distribution(grids.A, activities, null).hours.Work).toBeCloseTo(37.5, 9);
    expect(distribution(grids.A, activities, 5).hours.Work).toBe(0);
    expect(distribution(grids.A, activities, 5).hours.Leisure).toBeGreaterThan(distribution(grids.B, activities, 5).hours.Leisure);
  });
});

describe("the 5-minute reminder", () => {
  const lead = 5;
  it("fires inside the window with the next event name and times, and not before it", () => {
    expect(reminderFor(tl(), activities, at("2026-11-16 12:54:00"), lead, null)).toBeNull();
    const r = reminderFor(tl(), activities, at("2026-11-16 12:55:00"), lead, null)!;
    expect(r.text).toBe("In 5 min: Meal · 13:00–13:30"); expect(r.key).toBe("2026-11-16 0:78"); expect(r.names).toBe("Meal"); expect(r.range).toBe("13:00–13:30");
  });
  it("fires once per transition: the stored key stops later ticks, a reload and tab switches", () => {
    const first = reminderFor(tl(), activities, at("2026-11-16 12:56:10"), lead, null)!;
    for (const t of ["12:56:11", "12:57:00", "12:59:59"]) expect(reminderFor(tl(), activities, at("2026-11-16 " + t), lead, first.key)).toBeNull();
    expect(reminderFor(tl(), activities, at("2026-11-16 13:25:00"), lead, first.key)!.key).not.toBe(first.key);
    expect(reminderFor(tl(), activities, at("2026-11-23 12:55:00"), lead, first.key)!.key).not.toBe(first.key);
  });
  it("fires immediately when the app wakes inside the window, but never after the event has started", () => {
    expect(reminderFor(tl(), activities, at("2026-11-16 12:58:30"), lead, null)!.text).toBe("In 2 min: Meal · 13:00–13:30");
    expect(reminderFor(tl(), activities, at("2026-11-16 13:00:00"), lead, null)).toBeNull();
    expect(reminderFor(tl(), activities, at("2026-11-16 13:10:00"), lead, null)).toBeNull();
  });
  it("announces the 22:00 bed time at 21:55 on a weekday", () => {
    expect(reminderFor(tl(), activities, at("2026-11-17 21:55:00"), lead, null)!.text).toBe("In 5 min: Bed time · 22:00–05:00");
  });
  it("uses this week's variant for the next event, also when it crosses from Sunday into the next week", () => {
    expect(reminderFor(tl(), activities, at("2026-11-21 11:25:00"), lead, null)!.text).toContain("Dark Sphere");
    expect(reminderFor(tl(), activities, at("2026-11-28 11:25:00"), lead, null)!.text).toContain("Deep learning (library)");
    const fill = (id: string): Grid => Array.from({ length: 1008 }, () => [id]);
    const b = fill("a:Bed time"); for (let i = 0; i < 30; i++) b[i] = ["a:Work"];
    const mixed: Timeline = { grids: { A: fill("a:Bed time"), B: b }, swap: false };
    expect(reminderFor(mixed, activities, at("2026-11-22 23:56:00"), 5, null)!.text).toBe("In 4 min: Work · 00:00–05:00");
    expect(reminderFor(mixed, activities, at("2026-11-29 23:56:00"), 5, null)).toBeNull();
  });
  it("is skipped when every activity of the next event has remind off, and still fires if one has it on", () => {
    const off = activities.map(a => (a.name === "Meal" ? { ...a, remind: false } : a));
    expect(reminderFor(tl(), off, at("2026-11-16 12:55:00"), lead, null)).toBeNull();
    const mixed = activities.map(a => (a.name === "Unwind" ? { ...a, remind: false } : a));
    expect(reminderFor(tl(), mixed, at("2026-11-16 17:25:00"), lead, null)!.text).toMatch(/Meal.*17:30–18:30/);
  });
  it("uses the lead time it is given, and follows an edit", () => {
    expect(reminderFor(tl(), activities, at("2026-11-16 12:50:00"), 10, null)!.text).toMatch(/^In 10 min/);
    expect(reminderFor(tl(), activities, at("2026-11-16 12:50:00"), 5, null)).toBeNull();
    const rows = rowsFromSeed().filter(r => !(r.variant === "A" && r.weekday === 0 && r.slot_index >= 78 && r.slot_index < 81)).concat([78, 79, 80].map(i => ({ variant: "A" as const, weekday: 0, slot_index: i, activity_id: "a:Read" })));
    expect(reminderFor({ grids: buildGrids(rows), swap: false }, activities, at("2026-11-16 12:55:00"), 5, null)!.text).toBe("In 5 min: Read · 13:00–13:30");
  });
});

describe("blocks", () => {
  it("merges identical consecutive slots within a day", () => {
    const blocks = dayBlocks(grids.A, 0); expect(blocks[0]).toMatchObject({ first: 0, count: 30 }); expect(blocks.reduce((n, b) => n + b.count, 0)).toBe(144);
  });
});
