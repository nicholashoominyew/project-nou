// The test process runs in London time so the clock-change days (BST/GMT) are real.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/London";
import { describe, expect, it, vi } from "vitest";
import seedText from "../../src-tauri/seed/life_timetable.json?raw";
import { buildGrid, countdown, dayBlocks, eventAfter, eventAt, progress, reminderFor, slotOf, totals, weekdayOf, type Activity, type Grid, type SlotRow } from "./schedule";

interface Seed { activities: { name: string; category: Activity["category"]; remind: boolean }[]; days: Record<string, [string, string, string[]][]> }
const seed = JSON.parse(seedText) as Seed;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const activities: Activity[] = seed.activities.map((a, i) => ({ id: "a:" + a.name, name: a.name, category: a.category, colour: null, remind: a.remind, sort_order: i }));
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
function rowsFromSeed(): SlotRow[] {
  const rows: SlotRow[] = [];
  DAYS.forEach((d, weekday) => seed.days[d].forEach(([s, e, who]) => { for (let i = mins(s) / 30; i < mins(e) / 30; i++) who.forEach(n => rows.push({ weekday, slot_index: i, activity_id: "a:" + n })); }));
  return rows;
}
const grid: Grid = buildGrid(rowsFromSeed());
// 2026-11-16 is a Monday.
const at = (iso: string) => { const [d, t] = iso.split(" "); const [y, m, day] = d.split("-").map(Number); const [h, mi, s] = t.split(":").map(Number); return new Date(y, m - 1, day, h, mi, s ?? 0); };
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const nm = (ev: { ids: string[] } | null) => (ev ? ev.ids.map(i => i.slice(2)).join(" + ") : "none");

describe("the seed", () => {
  it("fills all 48 slots of every day", () => {
    for (let d = 0; d < 7; d++) expect(grid.slice(d * 48, d * 48 + 48).every(c => c.length > 0)).toBe(true);
  });
});

describe("the current event", () => {
  it("is a run of identical slots, ending at the end of the run and not the slot", () => {
    const ev = eventAt(grid, at("2026-11-16 10:12:00"))!; // Monday: Work 09:00-13:00
    expect(nm(ev)).toBe("Work"); expect([hhmm(ev.start), hhmm(ev.end)]).toEqual(["09:00", "13:00"]);
    expect(countdown(ev.end.getTime() - at("2026-11-16 10:12:00").getTime())).toBe("02:48:00");
    expect(progress(ev, at("2026-11-16 11:00:00"))).toBeCloseTo(0.5, 5);
  });
  it("keeps slots with several activities together and names them all", () => {
    const ev = eventAt(grid, at("2026-11-16 05:10:00"))!; // Monday 05:00-05:30: Shower + Breakfast, Walk, Japanese Study, JP Anki
    expect(ev.ids.length).toBe(4); expect(ev.ids).toContain("a:Walk"); expect(ev.slots).toBe(1);
    expect(nm(eventAt(grid, at("2026-11-17 05:10:00")))).toContain("Exercise");
  });
  it("two different runs that share a name are separate events: Work before and after the meal", () => {
    const morning = eventAt(grid, at("2026-11-16 12:59:00"))!; expect(hhmm(morning.end)).toBe("13:00");
    const after = eventAfter(grid, morning, at("2026-11-16 12:59:00"))!; expect(nm(after)).toBe("Meal"); expect([hhmm(after.start), hhmm(after.end)]).toEqual(["13:00", "13:30"]);
  });
  it("wraps across midnight and from Sunday into Monday as one event", () => {
    const sundayNight = at("2026-11-22 22:30:00"); expect(weekdayOf(sundayNight)).toBe(6);
    const ev = eventAt(grid, sundayNight)!; expect(nm(ev)).toBe("Bed time");
    expect(ev.start.getTime()).toBe(at("2026-11-22 22:00:00").getTime()); expect(ev.end.getTime()).toBe(at("2026-11-23 05:00:00").getTime());
    expect(eventAt(grid, at("2026-11-23 01:00:00"))!.start.getTime()).toBe(at("2026-11-22 22:00:00").getTime());
    expect(nm(eventAfter(grid, ev, sundayNight))).toContain("Shower + Breakfast");
  });
  it("reports the next event with its start time", () => {
    const now = at("2026-11-16 17:40:00"); const ev = eventAt(grid, now)!; expect(nm(ev)).toBe("Meal + Unwind");
    const next = eventAfter(grid, ev, now)!; expect(nm(next)).toBe("Side projects"); expect(hhmm(next.start)).toBe("18:30");
  });
  it("is not confused when the whole week is one event, or empty", () => {
    const empty = buildGrid([]); const ev = eventAt(empty, at("2026-11-16 10:00:00"))!;
    expect(ev.ids).toEqual([]); expect(eventAfter(empty, ev, at("2026-11-16 10:00:00"))).toBeNull();
    expect(reminderFor(empty, activities, at("2026-11-16 10:00:00"), 5, null)).toBeNull();
  });
});

describe("clock changes", () => {
  it("counts real time to the end of a run on the night the clocks go back (25 Oct 2026, a 25-hour day)", () => {
    const now = at("2026-10-25 00:30:00"); const ev = eventAt(grid, now)!; // Sunday Bed time ends 09:00 local
    expect([hhmm(ev.start), hhmm(ev.end)]).toEqual(["23:30", "09:00"]);
    expect(ev.end.getTime() - now.getTime()).toBe(9.5 * 3600 * 1000);
  });
  it("counts real time on the night the clocks go forward (29 Mar 2026, a 23-hour day)", () => {
    const now = at("2026-03-29 00:30:00");
    const ev = eventAt(grid, now)!; expect(hhmm(ev.end)).toBe("09:00");
    expect(ev.end.getTime() - now.getTime()).toBe(7.5 * 3600 * 1000);
  });
  it("finds the slot from wall-clock time, so 09:00 after the change is still the 09:00 slot", () => {
    expect(slotOf(at("2026-10-25 09:00:00"))).toBe(6 * 48 + 18);
  });
});

describe("sleep and resume", () => {
  it("is computed from the clock, so a long jump lands on the right event", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at("2026-11-16 08:10:00")); expect(nm(eventAt(grid, new Date()))).toBe("Admin");
      vi.setSystemTime(at("2026-11-16 14:20:00")); // the laptop slept for six hours
      const ev = eventAt(grid, new Date())!; expect(nm(ev)).toBe("Work"); expect(hhmm(ev.start)).toBe("13:30");
    } finally { vi.useRealTimers(); }
  });
});

describe("the 5-minute reminder", () => {
  const lead = 5;
  it("fires inside the window with the next event name and times, and not before it", () => {
    expect(reminderFor(grid, activities, at("2026-11-16 12:54:00"), lead, null)).toBeNull();
    const r = reminderFor(grid, activities, at("2026-11-16 12:55:00"), lead, null)!;
    expect(r.text).toBe("In 5 min: Meal · 13:00–13:30");
    expect(r.key).toBe("2026-11-16 0:26");
  });
  it("fires once per transition: the stored key stops later ticks, a reload and tab switches", () => {
    const first = reminderFor(grid, activities, at("2026-11-16 12:56:10"), lead, null)!;
    for (const t of ["12:56:11", "12:57:00", "12:59:59"]) expect(reminderFor(grid, activities, at("2026-11-16 " + t), lead, first.key)).toBeNull();
    // The next transition has a different key and fires again, and so does the same slot a week later.
    const later = reminderFor(grid, activities, at("2026-11-16 13:25:00"), lead, first.key)!; expect(later.key).not.toBe(first.key);
    expect(reminderFor(grid, activities, at("2026-11-23 12:55:00"), lead, first.key)!.key).not.toBe(first.key);
  });
  it("fires immediately when the app wakes inside the window, but never after the event has started", () => {
    expect(reminderFor(grid, activities, at("2026-11-16 12:58:30"), lead, null)!.text).toBe("In 2 min: Meal · 13:00–13:30");
    expect(reminderFor(grid, activities, at("2026-11-16 13:00:00"), lead, null)).toBeNull(); // Meal has started: the next one is 13:30, 30 min away
    expect(reminderFor(grid, activities, at("2026-11-16 13:10:00"), lead, null)).toBeNull();
  });
  it("announces the 22:00 bed time at 21:55 on a weekday", () => {
    expect(reminderFor(grid, activities, at("2026-11-17 21:55:00"), lead, null)!.text).toBe("In 5 min: Bed time · 22:00–05:00");
  });
  it("is skipped when every activity of the next event has remind off, and still fires if one has it on", () => {
    const off = activities.map(a => (a.name === "Meal" ? { ...a, remind: false } : a));
    expect(reminderFor(grid, off, at("2026-11-16 12:55:00"), lead, null)).toBeNull();
    const mixed = activities.map(a => (a.name === "Unwind" ? { ...a, remind: false } : a)); // Unwind + Meal: Meal still reminds
    expect(reminderFor(grid, mixed, at("2026-11-16 17:25:00"), lead, null)!.text).toMatch(/Meal.*17:30–18:30/);
  });
  it("uses the lead time it is given", () => {
    expect(reminderFor(grid, activities, at("2026-11-16 12:50:00"), 10, null)!.text).toMatch(/^In 10 min/);
    expect(reminderFor(grid, activities, at("2026-11-16 12:50:00"), 5, null)).toBeNull();
  });
  it("follows an edit: the reminder uses the grid it is given", () => {
    const edited = buildGrid(rowsFromSeed().filter(r => !(r.weekday === 0 && r.slot_index === 26)).concat({ weekday: 0, slot_index: 26, activity_id: "a:Read" }));
    expect(reminderFor(edited, activities, at("2026-11-16 12:55:00"), 5, null)!.text).toBe("In 5 min: Read · 13:00–13:30");
  });
});

describe("blocks and totals", () => {
  it("merges identical consecutive slots in a day and counts hours per category", () => {
    const blocks = dayBlocks(grid, 0); expect(blocks[0]).toMatchObject({ first: 0, count: 10 }); expect(blocks.reduce((n, b) => n + b.count, 0)).toBe(48);
    const t = totals(grid, activities);
    expect(t.perDay.Work[0]).toBe(7.5); // 09:00-13:00 and 13:30-17:00
    expect(t.perWeek.Work).toBe(37.5);
    expect(t.perDay.Rest[0]).toBe(8); // 7 h of Bed time + 1 h of Unwind
  });
});
