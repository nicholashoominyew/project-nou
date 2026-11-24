import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyProposal, canApply, describeProposal, parseHomeWidgets, parseTimetableBlock } from "./gatewayApply";
import { HOME_WIDGET_IDS, HOME_WIDGET_INFO } from "./homeLayout";
import { HOME_WIDGETS } from "./Home";

const { calls } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "timetable_get") return { activities: [{ id: "w", name: "Work" }, { id: "m", name: "Meal" }, { id: "f", name: "Free time" }], slots: [], swap_ab: false };
  if (command === "timetable_save_range") return [];
  if (command === "timetable_add_activity") return { id: "new", name: args.name, category: args.category };
  return null;
} }));
const writes = () => calls.filter(c => c.command !== "timetable_get");
const block = { weeks: ["A"], days: ["Mon"], start: "09:00", end: "10:30", activities: ["Work"] };
beforeEach(() => { calls.length = 0; localStorage.clear(); });

describe("the Home sections list", () => {
  it("is the same as the sections the Home page really has", () => {
    expect(HOME_WIDGET_INFO).toEqual(HOME_WIDGETS.map(w => ({ id: w.id, title: w.title })));
    expect(HOME_WIDGET_IDS).toContain("approvals");
  });
});

describe("a request to change the Life Timetable", () => {
  it("is checked field by field and turned into half-hour slots", () => {
    expect(parseTimetableBlock({ weeks: ["B", "A"], days: ["tuesday", "Mon"], start: "09:00", end: "24:00", activities: [" Work ", "Meal"] })).toEqual({ weeks: ["B", "A"], days: [0, 1], start: 18, end: 48, names: ["Work", "Meal"] });
    expect(parseTimetableBlock({ ...block, activities: [] }).names).toEqual([]);
    const bad: Record<string, unknown>[] = [
      { ...block, weeks: [] }, { ...block, weeks: ["C"] }, { ...block, weeks: ["A", "A"] }, { ...block, weeks: "A" }, { ...block, days: [] }, { ...block, days: ["Funday"] }, { ...block, days: ["Mon", "monday"] }, { ...block, days: [1] },
      { ...block, start: "9:00" }, { ...block, start: "09:15" }, { ...block, start: "24:00" }, { ...block, end: "24:30" }, { ...block, end: "09:00" }, { ...block, start: "10:00", end: "09:30" },
      { ...block, activities: "Work" }, { ...block, activities: [""] }, { ...block, activities: [3] }, { ...block, activities: ["Work", "work"] }, { ...block, activities: Array.from({ length: 13 }, (_, i) => "A" + i) }, { ...block, activities: ["x".repeat(81)] },
    ];
    for (const b of bad) expect(() => parseTimetableBlock(b), JSON.stringify(b)).toThrow();
  });
  it("is applied through the timetable's own save command, once per week, with the activity ids found by name", async () => {
    const out = await applyProposal({ op: "timetable_set_block", payload: { weeks: ["A", "B"], days: ["Tue", "Mon"], start: "09:00", end: "10:30", activities: ["work", "MEAL"] } });
    expect(out.ok).toBe(true); expect(out.result).toBe("Set week A and B Mon, Tue 09:00-10:30 to work + MEAL");
    expect(writes()).toEqual([
      { command: "timetable_save_range", args: { variant: "A", weekdays: [0, 1], start: 18, end: 21, activityIds: ["w", "m"] } },
      { command: "timetable_save_range", args: { variant: "B", weekdays: [0, 1], start: 18, end: 21, activityIds: ["w", "m"] } },
    ]);
  });
  it("with no activities empties the stretch (so Undo-style cells go through restore), and handles an end of 24:00", async () => {
    const out = await applyProposal({ op: "timetable_set_block", payload: { weeks: ["A"], days: ["Sun", "Sat"], start: "23:00", end: "24:00", activities: [] } });
    expect(out).toEqual({ ok: true, result: "Set week A Sat, Sun 23:00-24:00 to nothing planned" });
    expect(writes()).toEqual([{ command: "timetable_restore_cells", args: { variant: "A", cells: [5, 6].flatMap(d => [46, 47].map(s => ({ weekday: d, slot_index: s, activity_ids: [] }))) } }]);
  });
  it("is refused, with nothing written, for an unknown activity or a badly shaped request", async () => {
    const unknown = await applyProposal({ op: "timetable_set_block", payload: { ...block, activities: ["Work", "Dancing"] } });
    expect(unknown.ok).toBe(false); expect(unknown.result).toMatch(/no activity called “Dancing”.*added first/);
    expect(writes()).toEqual([]);
    calls.length = 0;
    expect((await applyProposal({ op: "timetable_set_block", payload: { ...block, days: ["Mon", "Mon"] } })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it("adding an activity goes through the normal command and checks the name and category", async () => {
    expect(await applyProposal({ op: "timetable_add_activity", payload: { name: " Reading ", category: "Leisure" } })).toEqual({ ok: true, result: "Added the activity Reading" });
    expect(writes()).toEqual([{ command: "timetable_add_activity", args: { name: "Reading", category: "Leisure" } }]);
    calls.length = 0;
    for (const p of [{ name: "", category: "Leisure" }, { name: "x", category: "Everything" }, { name: "x".repeat(81), category: "Work" }, { name: "x" }]) expect((await applyProposal({ op: "timetable_add_activity", payload: p })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it("all three operations can be applied and have labels", () => { for (const op of ["timetable_set_block", "timetable_add_activity", "home_set_widgets"]) expect(canApply(op)).toBe(true); });
});

describe("a request to show or hide sections of the Home page", () => {
  it("changes only the stored layout, keeps what was already hidden, and tells an open Home page", async () => {
    localStorage.setItem("nou-home-layout", JSON.stringify({ order: HOME_WIDGET_IDS, hidden: ["weather", "clocks"] }));
    let heard = 0; const listen = () => { heard++; }; window.addEventListener("nou:home-layout-changed", listen);
    const out = await applyProposal({ op: "home_set_widgets", payload: { show: ["weather"], hide: ["tasks"] } });
    window.removeEventListener("nou:home-layout-changed", listen);
    expect(out).toEqual({ ok: true, result: "Home: showed weather; hid tasks" }); expect(heard).toBe(1);
    expect(JSON.parse(localStorage.getItem("nou-home-layout")!)).toEqual({ order: HOME_WIDGET_IDS, hidden: ["clocks", "tasks"] });
    expect(calls).toEqual([]);
  });
  it("starts from the default layout when none is stored, and can show the approvals section", async () => {
    expect((await applyProposal({ op: "home_set_widgets", payload: { hide: ["weather"] } })).ok).toBe(true);
    expect(JSON.parse(localStorage.getItem("nou-home-layout")!).hidden).toEqual(["weather"]);
    localStorage.setItem("nou-home-layout", JSON.stringify({ order: HOME_WIDGET_IDS, hidden: ["approvals"] }));
    expect((await applyProposal({ op: "home_set_widgets", payload: { show: ["approvals"] } })).ok).toBe(true);
    expect(JSON.parse(localStorage.getItem("nou-home-layout")!).hidden).toEqual([]);
  });
  it("can never hide the Waiting for approval section, and refuses unknown or conflicting sections without changing anything", async () => {
    localStorage.setItem("nou-home-layout", JSON.stringify({ order: HOME_WIDGET_IDS, hidden: [] }));
    const before = localStorage.getItem("nou-home-layout");
    for (const p of [{ hide: ["approvals"] }, { hide: ["weather", "approvals"] }, { show: ["nope"] }, { hide: "weather" }, {}, { show: [], hide: [] }, { show: ["weather"], hide: ["weather"] }, { hide: ["weather", "weather"] }, { show: [3] }]) {
      const out = await applyProposal({ op: "home_set_widgets", payload: p });
      expect(out.ok, JSON.stringify(p)).toBe(false);
    }
    expect((await applyProposal({ op: "home_set_widgets", payload: { hide: ["approvals"] } })).result).toMatch(/cannot be hidden by a request/);
    expect(localStorage.getItem("nou-home-layout")).toBe(before);
    expect(() => parseHomeWidgets({ hide: ["approvals"] })).toThrow();
  });
});

describe("the sentence on the approval card", () => {
  it("says exactly what approving would do, using the Home section titles", () => {
    expect(describeProposal("timetable_set_block", { weeks: ["A", "B"], days: ["Mon", "Wed"], start: "09:00", end: "10:30", activities: ["Work", "Meal"] })).toBe("In week A and B, on Mon, Wed, 09:00–10:30 will be set to Work + Meal, replacing what is there now.");
    expect(describeProposal("timetable_set_block", { ...block, activities: [] })).toBe("In week A, on Mon, 09:00–10:30 will be emptied, replacing what is there now.");
    expect(describeProposal("timetable_add_activity", { name: "Reading", category: "Leisure" })).toBe("A new activity “Reading” (Leisure) will be added to your list. It is not placed on any day.");
    expect(describeProposal("home_set_widgets", { show: ["weather", "tasks"], hide: ["clocks"] })).toBe("Show: Weather, Today's tasks. Hide: Clocks. Nothing else on the Home page changes.");
  });
  it("is absent for other operations and for a badly shaped request, so the raw fields are shown instead", () => {
    expect(describeProposal("create_page", { title: "x" })).toBeNull();
    expect(describeProposal("timetable_set_block", { weeks: "A" })).toBeNull(); expect(describeProposal("home_set_widgets", { hide: ["approvals"] })).toBeNull(); expect(describeProposal("timetable_add_activity", {})).toBeNull();
  });
});
