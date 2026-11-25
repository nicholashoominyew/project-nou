import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyProposal, canApply, describeProposal, parseHabitAdd, parseHabitTick, parseTodoOrder } from "./gatewayApply";

const { calls } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "habits_list_cmd") return [{ id: "h1", name: "Exercise", days: 127, sort_order: 0, created_at: "2020-01-01T00:00:00.000Z", category: "Training" }];
  if (command === "habit_add_cmd") return { id: "new", name: args.name, days: args.days ?? 127, sort_order: 1, created_at: "2020-01-01T00:00:00.000Z", category: args.category ?? "Health" };
  if (command === "linked_todo_list") return [{ id: "a", text: "Call Sam", checked: false, pages: 0 }, { id: "b", text: "Water  plants", checked: false, pages: 0 }, { id: "c", text: "Pay rent", checked: true, pages: 0 }];
  return null;
} }));
beforeEach(() => { calls.length = 0; });
const writes = () => calls.filter(c => !["habits_list_cmd", "linked_todo_list"].includes(c.command));

describe("a request to add a habit", () => {
  it("is checked field by field: name, type (default Health) and day names (default every day)", () => {
    expect(parseHabitAdd({ name: " Reading  list ", category: "Leisure", days: ["Mon", "friday"] })).toEqual({ name: "Reading list", category: "Leisure", days: 1 | 16 });
    expect(parseHabitAdd({ name: "Anki" })).toEqual({ name: "Anki", category: "Health", days: 127 });
    for (const bad of [{}, { name: "" }, { name: "x".repeat(61) }, { name: "a\u0007" }, { name: "A", category: "Nope" }, { name: "A", days: [] }, { name: "A", days: ["Funday"] }, { name: "A", days: ["Mon", "mon"] }, { name: "A", days: "Mon" }]) expect(() => parseHabitAdd(bad as any), JSON.stringify(bad)).toThrow();
  });
  it("is described in one sentence and applied through the habit command, with its type and days", async () => {
    expect(describeProposal("habit_add", { name: "Reading", category: "Leisure", days: ["Mon", "Tue"] })).toMatch(/“Reading” \(Leisure, Mon, Tue\).*Life Timetable/);
    const out = await applyProposal({ op: "habit_add", payload: { name: "Reading", category: "Leisure", days: ["Mon", "Tue"] } });
    expect(out).toEqual({ ok: true, result: "Added the habit Reading" });
    expect(writes()).toEqual([{ command: "habit_add_cmd", args: { name: "Reading", days: 3, category: "Leisure" } }]);
    expect(canApply("habit_add")).toBe(true);
  });
});

describe("a request to tick a habit", () => {
  it("needs a habit, a real day and true or false", () => {
    expect(parseHabitTick({ habit: " Exercise ", day: "2026-11-20", done: true })).toEqual({ habit: "Exercise", day: "2026-11-20", done: true });
    for (const bad of [{ day: "2026-11-20", done: true }, { habit: "E", day: "2026-02-30", done: true }, { habit: "E", day: "26-11-20", done: true }, { habit: "E", day: "2026-11-20" }, { habit: "E", day: "2026-11-20", done: "yes" }]) expect(() => parseHabitTick(bad as any), JSON.stringify(bad)).toThrow();
  });
  it("ticks or clears the named habit for that day, finds it ignoring case, and refuses a future day or an unknown habit", async () => {
    expect(await applyProposal({ op: "habit_tick", payload: { habit: "exercise", day: "2020-02-03", done: true } })).toEqual({ ok: true, result: "Exercise ticked on 2020-02-03" });
    expect(writes()[0].command).toBe("habit_log_set_cmd"); expect(writes()[0].args).toMatchObject({ day: "2020-02-03", habitId: "h1", state: "done" });
    expect((await applyProposal({ op: "habit_tick", payload: { habit: "Exercise", day: "2020-02-03", done: false } })).result).toBe("Exercise cleared on 2020-02-03");
    expect(writes()[1].args).toMatchObject({ state: null });
    calls.length = 0;
    expect(await applyProposal({ op: "habit_tick", payload: { habit: "Exercise", day: "2999-01-01", done: true } })).toEqual({ ok: false, result: "A day that has not happened yet cannot be logged" });
    expect((await applyProposal({ op: "habit_tick", payload: { habit: "Swimming", day: "2020-02-03", done: true } })).result).toMatch(/no habit called “Swimming”/);
    expect(writes()).toEqual([]);
    expect(describeProposal("habit_tick", { habit: "Exercise", day: "2026-11-20", done: true })).toBe("“Exercise” will be marked done on 2026-11-20.");
  });
});

describe("a request to reorder Today's tasks", () => {
  it("lists task texts, each once", () => {
    expect(parseTodoOrder({ order: ["Pay rent", "Call Sam"] }).order).toEqual(["Pay rent", "Call Sam"]);
    for (const bad of [{}, { order: [] }, { order: ["A", "a "] }, { order: [""] }, { order: [3] }, { order: "A" }]) expect(() => parseTodoOrder(bad as any), JSON.stringify(bad)).toThrow();
  });
  it("matches the texts the owner sees (ignoring case and spacing), puts them first in that order, and changes nothing if one is unknown", async () => {
    const out = await applyProposal({ op: "todo_reorder", payload: { order: ["pay rent", "WATER PLANTS"] } });
    expect(out).toEqual({ ok: true, result: "Put 2 tasks first, in the order asked" });
    expect(writes()).toEqual([{ command: "linked_todo_reorder", args: { ids: ["c", "b"] } }]);
    calls.length = 0;
    expect((await applyProposal({ op: "todo_reorder", payload: { order: ["Call Sam", "Feed the cat"] } })).result).toMatch(/no task “Feed the cat”/);
    expect(writes()).toEqual([]);
    expect(describeProposal("todo_reorder", { order: ["Pay rent"] })).toMatch(/start with, in this order: “Pay rent”/);
  });
});
