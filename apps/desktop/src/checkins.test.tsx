import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckinPopups, resetNotificationSetup, useCheckinPopups } from "./checkins";
import { testCheckin } from "./habitsApi";

const h = vi.hoisted(() => ({
  calls: [] as { command: string; args: any }[], pending: [] as any[], shown: [] as any[], onAction: null as null | ((e: any) => void), sent: [] as any[], granted: true,
  checkins: [] as any[], failShow: false, swept: 0, rename: "",
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => h.granted, requestPermission: async () => (h.granted ? "granted" : "denied"), registerActionTypes: async () => {},
  onAction: async (cb: (e: any) => void) => { h.onAction = cb; return { unregister: async () => {} }; }, sendNotification: (o: any) => { h.sent.push(o); },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  h.calls.push({ command, args });
  if (command === "timetable_get") return { system_page_id: null, swap_ab: false, activities: [{ id: "w", name: h.rename || "Shower + Breakfast", category: "Chores", colour: null, remind: true, sort_order: 0 }, { id: "x", name: "Side projects", category: "Work", colour: null, remind: true, sort_order: 1 }],
    slots: [{ variant: "B", weekday: 0, slot_index: 10, activity_id: "w" }, { variant: "B", weekday: 0, slot_index: 11, activity_id: "x" }], edited: { a: false, b: false } };
  if (command === "habits_list_cmd") return [{ id: "h1", name: "Exercise", days: 127, sort_order: 0, created_at: new Date(2026, 0, 1, 12).toISOString(), category: "Training" }, { id: "h2", name: "Anki", days: 127, sort_order: 1, created_at: new Date(2026, 0, 1, 12).toISOString(), category: "Health" }];
  if (command === "checkin_list_cmd") return [...h.checkins];
  if (command === "checkin_events_sweep_cmd") return h.swept;
  if (command === "checkin_event_show_cmd") {
    if (h.failShow) throw new Error("db busy");
    const k = h.checkins.find(c => c.id === args.checkinId); if (h.shown.some(e => e.checkin_id === args.checkinId && e.day === args.day)) return null;
    const ev = { checkin_id: args.checkinId, day: args.day, habit_id: k.habit_id, habit: k.habit_id === "h1" ? "Exercise" : "Anki", block: args.block, start_slot: k.start_slot, end_slot: k.end_slot, shown_at: args.now, expires_at: args.now + 7200, state: "shown" };
    h.shown.push(ev); h.pending.push(ev); return ev;
  }
  if (command === "checkin_events_pending_cmd") return [...h.pending]; // a new list each time, as the real backend returns
  if (command === "checkin_event_answer_cmd") { h.pending = h.pending.filter(e => !(e.checkin_id === args.checkinId && e.day === args.day)); return {}; }
  return null;
} }));

function Harness() { const state = useCheckinPopups(); return <CheckinPopups state={state} />; }
const at = (hh: number, mm = 0, ss = 0) => new Date(2026, 10, 23, hh, mm, ss); // Monday 23 Nov 2026: ISO week 48, so week B
const k = (id: string, habit: string, over: Record<string, unknown> = {}) => ({ id, habit_id: habit, weekday: 0, start_slot: 10, end_slot: 11, variant: "B", ...over });
const sent = (command: string) => h.calls.filter(c => c.command === command);
let clock = 0; const setTime = (d: Date) => { clock = d.getTime(); };
// Only the clock is faked (Date.now); a window "focus" makes the page look at the clock at once, so the tests do not wait for its 5-second timer.
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const mount = async (time: Date) => { setTime(time); await act(async () => { render(<Harness />); await wait(80); }); };
const look = async (time: Date) => { setTime(time); await act(async () => { fireEvent(window, new Event("focus")); await wait(80); }); };
beforeEach(() => {
  resetNotificationSetup(); clock = 0; vi.spyOn(Date, "now").mockImplementation(() => clock);
  Object.assign(h, { calls: [], pending: [], shown: [], onAction: null, sent: [], granted: true, checkins: [k("k1", "h1"), k("k2", "h2")], failShow: false, swept: 0, rename: "" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("check-in pop-ups", () => {
  it("name the block from the database even when this window's copy of the timetable is still the old one", async () => {
    await mount(at(4, 59, 58));
    h.rename = "Reading"; // the block was just edited; no change event has reached this window yet
    await look(at(5, 0, 3));
    await waitFor(() => expect(sent("checkin_event_show_cmd")).toHaveLength(2));
    expect(sent("checkin_event_show_cmd")[0].args.block).toBe("Reading");
  });
  it("appear when a block is running: Workout and Anki each get their own, once, with the block's name and times", async () => {
    await mount(at(4, 59, 58));
    expect(sent("checkin_event_show_cmd")).toHaveLength(0); // not before the block starts
    await look(at(5, 0, 3));
    await waitFor(() => expect(sent("checkin_event_show_cmd")).toHaveLength(2));
    expect(sent("checkin_event_show_cmd").map(c => [c.args.checkinId, c.args.day, c.args.block])).toEqual([["k1", "2026-11-23", "Shower + Breakfast"], ["k2", "2026-11-23", "Shower + Breakfast"]]);
    expect(sent("checkin_event_show_cmd")[0].args.until).toBe(Math.floor(at(5, 30).getTime() / 1000)); // it lasts at least until the block ends
    const exercise = await screen.findByRole("alertdialog", { name: "Check-in: Exercise" }); const anki = await screen.findByRole("alertdialog", { name: "Check-in: Anki" });
    expect(within(exercise).getByText("Shower + Breakfast")).toBeTruthy(); expect(within(anki).getByText("CHECK-IN · 05:00")).toBeTruthy();
    expect(within(exercise).getByText("Did you start Exercise?")).toBeTruthy(); expect(within(exercise).getByText("START ONLY · NO CHECK-OUT")).toBeTruthy(); expect(within(exercise).getByText("NEXT · 05:30 SIDE PROJECTS")).toBeTruthy();
    await waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent.map(n => [n.title, n.actionTypeId, n.extra])).toEqual([["Check-in: Exercise", "nou-checkin", { checkinId: "k1", day: "2026-11-23" }], ["Check-in: Anki", "nou-checkin", { checkinId: "k2", day: "2026-11-23" }]]);
    expect(h.sent[0].body).toBe("Shower + Breakfast · 05:00–05:30. Did you do it?");
    await look(at(5, 0, 20)); await look(at(5, 0, 40));
    expect(h.sent).toHaveLength(2); // later looks do not send the notification again
  });
  it("stay up for the whole block until ticked, go when the block ends, and never show on another weekday or in the other week", async () => {
    await mount(at(5, 0, 5));
    await screen.findByRole("alertdialog", { name: "Check-in: Exercise" });
    await look(at(5, 15, 0)); expect(screen.getByRole("alertdialog", { name: "Check-in: Exercise" })).toBeTruthy();
    await look(at(5, 29, 59)); expect(screen.getByRole("alertdialog", { name: "Check-in: Exercise" })).toBeTruthy(); // still there at the very end of the block
    await look(at(5, 30, 0)); await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()); // the end of the block: gone (still open on the Habits page)
    expect(h.pending.length).toBe(2); expect(h.sent).toHaveLength(2); // nothing new happens at the end
    cleanup(); h.calls.length = 0; h.shown = []; h.pending = []; h.checkins = [k("other-day", "h1", { weekday: 1 }), k("other-week", "h1", { variant: "A" })];
    await mount(at(5, 10)); expect(sent("checkin_event_show_cmd")).toHaveLength(0);
  });
  it("one tap on Yes, started answers it, and the card goes; there is no Skip", async () => {
    await mount(at(5, 0, 3));
    const exercise = await screen.findByRole("alertdialog", { name: "Check-in: Exercise" });
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
    fireEvent.click(within(exercise).getByRole("button", { name: "Yes, started" }));
    await waitFor(() => expect(sent("checkin_event_answer_cmd")[0].args).toMatchObject({ checkinId: "k1", day: "2026-11-23", answer: "done" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Check-in: Exercise" })).toBeNull());
    expect(screen.getByRole("alertdialog", { name: "Check-in: Anki" })).toBeTruthy(); // the other habit still waits
  });
  it("an X hides a pop-up for now without answering it (the other stays, and it is still open on the Habits page)", async () => {
    await mount(at(5, 0, 3));
    fireEvent.click(await screen.findByRole("button", { name: "Hide the Exercise check-in for now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Check-in: Exercise" })).toBeNull());
    expect(screen.getByRole("alertdialog", { name: "Check-in: Anki" })).toBeTruthy(); expect(sent("checkin_event_answer_cmd")).toHaveLength(0); expect(h.pending.length).toBe(2);
    await look(at(5, 10, 0)); expect(screen.queryByRole("alertdialog", { name: "Check-in: Exercise" })).toBeNull(); // it does not come back by itself while this block runs
  });
  it("a test pop-up can be shown for a habit at any time, sends the notification, and answering it ticks the habit for today without touching the check-in records", async () => {
    h.checkins = []; await mount(at(9, 0, 0));
    act(() => { testCheckin({ id: "h1", name: "Exercise" }); });
    const card = await screen.findByRole("alertdialog", { name: "Check-in: Exercise" }); expect(within(card).getByText("Test pop-up")).toBeTruthy();
    await waitFor(() => expect(h.sent.map(n => n.title)).toEqual(["Check-in: Exercise"]));
    fireEvent.click(within(card).getByRole("button", { name: "Yes, started" }));
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ habitId: "h1", state: "done" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()); expect(sent("checkin_event_answer_cmd")).toHaveLength(0); expect(sent("checkin_event_show_cmd")).toHaveLength(0);
  });
  it("opening NOU in the middle of a block shows its pop-up straight away", async () => {
    await mount(at(5, 20, 0));
    expect(await screen.findByRole("alertdialog", { name: "Check-in: Exercise" })).toBeTruthy();
    expect(sent("checkin_event_show_cmd")).toHaveLength(2);
  });
  it("on start, pop-ups whose two hours ran out while NOU was closed are only lapsed (closed: true); while running they are swept as no answer (closed: false)", async () => {
    await mount(at(9, 0, 0));
    expect(sent("checkin_events_sweep_cmd")[0].args).toMatchObject({ closed: true });
    await look(at(9, 0, 6));
    expect(sent("checkin_events_sweep_cmd").some(c => c.args.closed === false)).toBe(true);
    expect(sent("checkin_events_sweep_cmd")[0].args.now).toBe(Math.floor(at(9, 0, 0).getTime() / 1000));
  });
  it("an open pop-up from before a restart is shown again while its block is running", async () => {
    h.checkins = []; h.pending = [{ checkin_id: "k1", day: "2026-11-23", habit_id: "h1", habit: "Exercise", block: "x", start_slot: 10, end_slot: 11, shown_at: 1, expires_at: 2, state: "shown" }];
    await mount(at(5, 10, 0)); expect(await screen.findByRole("alertdialog", { name: "Check-in: Exercise" })).toBeTruthy();
  });
  it("a failed record does not stop the others, and is tried again at the next look", async () => {
    h.failShow = true; await mount(at(5, 0, 3));
    expect(screen.queryByRole("alertdialog")).toBeNull(); h.failShow = false; await look(at(5, 0, 8));
    expect(await screen.findByRole("alertdialog", { name: "Check-in: Exercise" })).toBeTruthy();
  });
});

describe("the system notification", () => {
  it("is not shown when notifications are refused, but the in-app pop-up still is", async () => {
    h.granted = false; await mount(at(5, 0, 3));
    expect(h.sent).toHaveLength(0); expect(await screen.findByRole("alertdialog", { name: "Check-in: Exercise" })).toBeTruthy();
  });
  it("its button answers the check-in it belongs to, and a tap on a notification that cannot be matched does nothing", async () => {
    await mount(at(5, 0, 3)); await waitFor(() => expect(h.onAction).not.toBeNull());
    await act(async () => { h.onAction!({ actionId: "done", inputValue: null, notification: { extra: { checkinId: "k2", day: "2026-11-23" } } }); });
    await waitFor(() => expect(sent("checkin_event_answer_cmd")[0].args).toMatchObject({ checkinId: "k2", day: "2026-11-23", answer: "done" }));
    await act(async () => { h.onAction!({ actionId: "done", inputValue: null, notification: null }); h.onAction!({ actionId: "tap", inputValue: null, notification: { extra: { checkinId: "k1", day: "2026-11-23" } } }); });
    expect(sent("checkin_event_answer_cmd")).toHaveLength(1);
  });
});
