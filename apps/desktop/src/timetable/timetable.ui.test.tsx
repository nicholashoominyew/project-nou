import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LifeTimetable from "./LifeTimetable";
import NowCard from "./NowCard";
import NowPanel from "./NowPanel";
import { LAST_KEY, SETTINGS_KEY, ReminderToast, useReminders } from "./reminders";

const calls: [string, any][] = [];
let slots: { variant: string; weekday: number; slot_index: number; activity_id: string }[] = [];
let edited = { a: false, b: false };
let swapAb = false;
let failSave = false;
const acts = [
  { id: "w", name: "Work", category: "Work", colour: null, remind: true, sort_order: 0 },
  { id: "m", name: "Meal", category: "Chores", colour: null, remind: true, sort_order: 1 },
  { id: "q", name: "Quiet", category: "Rest", colour: null, remind: false, sort_order: 2 },
  { id: "f", name: "Free time", category: "Leisure", colour: null, remind: true, sort_order: 3 },
  { id: "b", name: "Bed time", category: "Rest", colour: null, remind: true, sort_order: 4 },
];
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push([command, args]);
  if (command === "timetable_get") return { system_page_id: "system-life-timetable", swap_ab: swapAb, activities: acts, slots, edited };
  if (command === "timetable_save_range") { if (failSave) throw "Unknown activity"; return [{ weekday: 0, slot_index: 18, activity_ids: ["w"] }]; }
  if (command === "timetable_add_activity") return { id: "new", name: args.name, category: args.category, colour: null, remind: true, sort_order: 9 };
  return null;
} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const monday = (h: number, mi = 0, s = 0) => new Date(2026, 10, 16, h, mi, s); // Monday 16 Nov 2026, ISO week 47 = Week A
const fill = (variant: string, ids: string[], from: number, to: number, day = 0) => { for (let i = from; i < to; i++) for (const id of ids) slots.push({ variant, weekday: day, slot_index: i, activity_id: id }); };
beforeEach(() => {
  calls.length = 0; localStorage.clear(); slots = []; edited = { a: false, b: false }; swapAb = false; failSave = false;
  for (const v of ["A", "B"]) {
    fill(v, ["b"], 0, 18); fill(v, ["w"], 18, 26); fill(v, ["m"], 26, 27); fill(v, ["m", "q"], 27, 29); fill(v, ["f"], 29, 44); fill(v, ["b"], 44, 48); // Monday
    for (let d = 1; d < 7; d++) fill(v, ["f"], 0, 48, d);
  }
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(monday(10, 12));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("current event panel", () => {
  it("shows only the current event: kicker, range, category chip, name and a live h/m/s countdown in a progress ring, with no next row", async () => {
    render(<NowPanel />);
    const panel = await screen.findByRole("region", { name: "Current event" });
    expect(panel.textContent).toContain("NOW · 10:12"); expect(panel.textContent).toContain("09:00–13:00");
    expect(within(panel).getByText("Work", { selector: ".tt-chip" })).toBeTruthy();
    expect(panel.querySelector(".tt-now-name")!.textContent).toBe("Work");
    expect(screen.getByRole("timer").getAttribute("aria-label")).toMatch(/^2h 4[78]m \d+s left$/);
    expect(panel.querySelector(".cd-h")!.textContent).toBe("2");
    expect(panel.textContent).not.toMatch(/Next|left of|%/);
    expect(screen.getByTestId("ring-arc").getAttribute("d")).toMatch(/^M150 18 A132 132 0 1 1/); // starts at 12 o clock; 10:12 of 09:00-13:00 leaves about 74%, so the arc is the long way round
    expect(screen.queryByText("LIVE")).toBeNull(); expect(screen.queryByRole("slider")).toBeNull();
  });
  it("hides the hours under an hour and keeps up with the clock", async () => {
    vi.setSystemTime(monday(12, 20, 0));
    render(<NowPanel />);
    await screen.findByRole("timer");
    expect(document.querySelector(".cd-h")).toBeNull();
    expect(screen.getByRole("timer").getAttribute("aria-label")).toMatch(/^(39|40)m \d+s left$/);
    await act(async () => { vi.setSystemTime(monday(13, 5)); await vi.advanceTimersByTimeAsync(1100); });
    expect(document.querySelector(".tt-now-name")!.textContent).toBe("Meal");
  });
  it("shows the (+1) marker when the event runs past midnight", async () => {
    slots = slots.filter(s => !(s.weekday === 0 && s.slot_index >= 44) && !(s.weekday === 1 && s.slot_index < 4));
    fill("A", ["b"], 44, 48); fill("A", ["b"], 0, 4, 1);
    vi.setSystemTime(monday(23, 0));
    render(<NowPanel />);
    await screen.findByRole("timer");
    expect(document.querySelector(".tt-now-head")!.textContent).toContain("22:00–02:00 (+1)");
  });
  it("on Home it is the same panel with Focus, and no link to the page", async () => {
    render(<NowCard />);
    expect(await screen.findByRole("button", { name: "Enter focus mode" })).toBeTruthy();
    expect(screen.queryByText("Open the Life Timetable")).toBeNull();
  });
});

describe("focus mode", () => {
  it("is a full-window overlay with only the event name and the timer ring, and Esc or the corner button exits", async () => {
    render(<NowPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Enter focus mode" }));
    const dialog = await screen.findByRole("dialog", { name: "Focus mode" });
    await waitFor(() => expect(dialog.querySelector(".tt-focus-name")!.textContent).toBe("Work"));
    expect(within(dialog).getByRole("timer").getAttribute("aria-label")).toMatch(/^2h 4[78]m/);
    expect(within(dialog).getAllByRole("button").map(b => b.getAttribute("aria-label"))).toEqual(["Exit focus mode"]);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Exit focus mode" })));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Focus mode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    fireEvent.click(await screen.findByRole("button", { name: "Exit focus mode" }));
    expect(screen.queryByRole("dialog", { name: "Focus mode" })).toBeNull();
  });
});

function Probe({ notify }: { notify: (body: string) => Promise<boolean> }) {
  const r = useReminders(notify);
  return <ReminderToast reminder={r.toast} dismiss={r.dismiss} />;
}
describe("5-minute reminder", () => {
  it("shows UP NEXT IN m:ss with the next event and range, one native notification, and never again after ticks or a reload", async () => {
    vi.setSystemTime(monday(12, 55, 5));
    const notify = vi.fn(async () => true);
    const view = render(<Probe notify={notify} />);
    const toast = await screen.findByRole("status");
    expect(toast.textContent).toMatch(/UP NEXT IN 4:5\d/); expect(toast.textContent).toContain("Meal"); expect(toast.textContent).toContain("13:00–13:30");
    expect(notify).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledWith("In 5 min: Meal · 13:00–13:30");
    expect(localStorage.getItem(LAST_KEY)).toBe("2026-11-16 0:26");
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(notify).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<Probe notify={notify} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("can be dismissed, and still shows when the native notification is denied", async () => {
    vi.setSystemTime(monday(12, 56));
    render(<Probe notify={vi.fn(async () => false)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss reminder" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("stays quiet when off and when the event is under way, and uses the lead time from the settings", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ on: false, lead: 5 }));
    vi.setSystemTime(monday(12, 56));
    const notify = vi.fn(async () => true);
    render(<Probe notify={notify} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).not.toHaveBeenCalled(); cleanup();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ on: true, lead: 5 })); vi.setSystemTime(monday(13, 10));
    render(<Probe notify={notify} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).not.toHaveBeenCalled(); cleanup();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ on: true, lead: 10 })); vi.setSystemTime(monday(12, 50, 30));
    render(<Probe notify={notify} />);
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^In 10 min: Meal/)));
  });
  it("clamps a stored lead time to 30 minutes", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ on: true, lead: 90 })); vi.setSystemTime(monday(12, 25));
    const notify = vi.fn(async () => true);
    render(<Probe notify={notify} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).not.toHaveBeenCalled(); // 35 minutes before: outside the clamped 30
    await act(async () => { vi.setSystemTime(monday(12, 31)); await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^In 29 min: Meal/));
  });
});

describe("Life Timetable page", () => {
  it("has the header, no subtitle and no theme toggle, and the three cards", async () => {
    render(<LifeTimetable />);
    await screen.findByRole("button", { name: "Jump to now" });
    expect(screen.getByRole("heading", { name: "Life Timetable", level: 1 })).toBeTruthy();
    expect(document.querySelector(".tt-kicker-mono")!.textContent).toBe("PROJECT NOU · 脳 · MONDAY · 10:12");
    expect(screen.getByRole("button", { name: "Jump to now" })).toBeTruthy(); expect(screen.getByRole("button", { name: "Activities" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /dark mode|light mode/i })).toBeNull();
    expect(document.querySelector(".tt-head .hint")).toBeNull();
    expect(await screen.findByRole("region", { name: "Current event" })).toBeTruthy(); expect(screen.getByRole("region", { name: "Time distribution" })).toBeTruthy(); expect(screen.getByRole("region", { name: "Timetable" })).toBeTruthy();
  });
  it("blocks are buttons with accessible names, merged, with a ring on the current one and a now line", async () => {
    render(<LifeTimetable />);
    const work = await screen.findByRole("button", { name: "Edit Work · 09:00–13:00" });
    expect(work.tagName).toBe("BUTTON"); expect(work.className).toContain("current"); expect(work.getAttribute("aria-current")).toBe("time");
    expect(document.querySelectorAll(".tt-block.current").length).toBe(1); // only today's block, not the same hour on other days
    for (const b of document.querySelectorAll<HTMLElement>(".tt-block")) { expect(b.style.boxShadow).toBe(""); expect(b.style.border).toBe(""); expect(b.style.outline).toBe(""); } // no strokes on any block
    expect(screen.getByRole("button", { name: "Edit Meal + Quiet · 13:30–14:30 · split equally" })).toBeTruthy();
    expect(screen.getByTestId("now-line")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Edit Bed time/ }).length).toBeGreaterThan(0);
  });
  it("the week toggle flips A/B, and swap flips which week is this week", async () => {
    render(<LifeTimetable />);
    const flip = await screen.findByRole("button", { name: /^Showing Week A \(this week\)/ });
    expect(screen.getByTestId("dist-title").textContent).toBe("WHOLE WEEK · 168H · WEEK A");
    expect(screen.getByRole("button", { name: /This week is A · swap/ })).toBeTruthy();
    fireEvent.click(flip);
    expect(screen.getByRole("button", { name: "Showing Week B. Switch to Week A" })).toBeTruthy();
    expect(screen.getByTestId("dist-title").textContent).toBe("WHOLE WEEK · 168H · WEEK B");
    expect(screen.queryByTestId("now-line")).toBeNull(); // the now line and the ring only show on this week's variant
    expect(screen.getByRole("button", { name: "Edit Work · 09:00–13:00" }).className).not.toContain("current");
    fireEvent.click(screen.getByRole("button", { name: /This week is A · swap/ }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_set_swap")?.[1]).toEqual({ swap: true }));
  });
  it("with swap on, this week is B", async () => {
    swapAb = true;
    render(<LifeTimetable />);
    expect(await screen.findByRole("button", { name: /^Showing Week B \(this week\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /This week is B · swap/ })).toBeTruthy();
  });
  it("the Week/Day toggle drives the one distribution ring and table, and hovering a category shows its hours", async () => {
    render(<LifeTimetable />);
    await screen.findByTestId("dist-title");
    expect(screen.getByTestId("donut-big").textContent).toBe("168h");
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByTestId("dist-title").textContent).toBe("MONDAY · 24H · WEEK A");
    expect(screen.getByTestId("donut-big").textContent).toBe("24h");
    expect(screen.getByRole("tablist", { name: "Day" })).toBeTruthy();
    const work = screen.getByRole("button", { name: /^Work\s*4h/ });
    fireEvent.mouseEnter(work);
    expect(screen.getByTestId("donut-big").textContent).toBe("4h");
    fireEvent.mouseLeave(work);
    expect(screen.getByTestId("donut-big").textContent).toBe("24h");
    fireEvent.click(screen.getByRole("tab", { name: "TUE" }));
    expect(screen.getByTestId("dist-title").textContent).toBe("TUESDAY · 24H · WEEK A");
    expect(screen.getByTestId("donut-big").textContent).toBe("24h");
    expect(screen.getAllByRole("button", { name: /^Edit Free time/ }).length).toBe(1); // Day view shows only the selected day
  });
  it("Reset to plan shows only for a week that differs from the plan, and asks first", async () => {
    render(<LifeTimetable />);
    await screen.findByRole("button", { name: "Add block" });
    expect(screen.queryByRole("button", { name: "Reset to plan" })).toBeNull(); cleanup();
    edited = { a: true, b: false };
    render(<LifeTimetable />);
    const btn = await screen.findByRole("button", { name: "Reset to plan" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(btn); expect(calls.some(c => c[0] === "timetable_reset_variant")).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_reset_variant")?.[1]).toEqual({ variant: "A" }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("block editor", () => {
  const open = async () => { render(<LifeTimetable />); const b = await screen.findByRole("button", { name: "Edit Work · 09:00–13:00" }); fireEvent.click(b); return { b, dialog: await screen.findByRole("dialog", { name: "Edit block · Week A" }) }; };
  it("opens with the block's times, day and activities; Save writes the range for the chosen days in the viewed week only, then Undo restores", async () => {
    const { dialog } = await open();
    const [start, end] = within(dialog).getAllByRole("combobox") as HTMLSelectElement[];
    expect([start.value, end.value]).toEqual(["18", "26"]);
    expect(within(dialog).getByRole("button", { name: "MON" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Work" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "TUE" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Meal" }));
    expect(dialog.textContent).toContain("2 SELECTED · TIME SPLIT EQUALLY");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_save_range")?.[1]).toEqual({ variant: "A", weekdays: [0, 1], start: 18, end: 26, activityIds: ["w", "m"] }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit block/ })).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_restore_cells")?.[1]).toEqual({ variant: "A", cells: [{ weekday: 0, slot_index: 18, activity_ids: ["w"] }] }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
  it("shows why Save is disabled: no activity, no day, end not after start; Start pushes End forward", async () => {
    const { dialog } = await open();
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Work" }));
    expect(save.disabled).toBe(true); expect(within(dialog).getByRole("alert").textContent).toBe("Pick at least one activity.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Work" })); fireEvent.click(within(dialog).getByRole("button", { name: "MON" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("Pick at least one day.");
    fireEvent.click(within(dialog).getByRole("button", { name: "MON" }));
    const [start, end] = within(dialog).getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(end, { target: { value: "10" } });
    expect(within(dialog).getByRole("alert").textContent).toBe("End time must be after the start.");
    fireEvent.change(start, { target: { value: "5" } });
    expect(end.value).toBe("10"); expect(within(dialog).queryByRole("alert")).toBeNull();
    fireEvent.change(start, { target: { value: "12" } });
    expect(end.value).toBe("13");
  });
  it("Esc, the backdrop and Cancel close it with focus back on the block, and Tab stays inside", async () => {
    const { b, dialog } = await open();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit block/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(b));
    fireEvent.click(b); const d2 = await screen.findByRole("dialog", { name: /Edit block/ });
    fireEvent.mouseDown(d2.parentElement!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit block/ })).toBeNull());
    fireEvent.click(b); const d3 = await screen.findByRole("dialog", { name: /Edit block/ });
    const focusables = [...d3.querySelectorAll<HTMLElement>("button:not([disabled]),select")];
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(d3, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);
    focusables[0].focus(); fireEvent.keyDown(d3, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
    fireEvent.click(within(d3).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit block/ })).toBeNull());
  });
  it("Add block starts on the selected day at 12:00-13:00 with nothing chosen, and has no Clear button", async () => {
    render(<LifeTimetable />);
    fireEvent.click(await screen.findByRole("button", { name: "Add block" }));
    const dialog = await screen.findByRole("dialog", { name: "Add block · Week A" });
    const [start, end] = within(dialog).getAllByRole("combobox") as HTMLSelectElement[];
    expect([start.value, end.value]).toEqual(["24", "26"]);
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Clear to free time" })).toBeNull();
  });
  it("Clear to free time writes the Free time activity into the block", async () => {
    const { dialog } = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear to free time" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_save_range")?.[1]).toEqual({ variant: "A", weekdays: [0], start: 18, end: 26, activityIds: ["f"] }));
  });
  it("keeps the editor open and shows the reason when the save is refused", async () => {
    failSave = true;
    const { dialog } = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("Unknown activity"));
    expect(screen.getByRole("dialog", { name: "Edit block · Week A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("activities", () => {
  it("manages activities: add, remind toggle, and delete needs a reassignment while the activity is used", async () => {
    render(<LifeTimetable />);
    fireEvent.click(await screen.findByRole("button", { name: "Activities" }));
    fireEvent.change(screen.getByLabelText("New activity name"), { target: { value: "Piano" } });
    fireEvent.click(screen.getByRole("button", { name: "Add activity" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_add_activity")?.[1]).toEqual({ name: "Piano", category: "Training" }));
    fireEvent.click(screen.getAllByRole("checkbox", { name: /Remind/ })[0]);
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_update_activity")?.[1].activity.remind).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    expect((screen.getByRole("button", { name: "Delete Work" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reassign slots to"), { target: { value: "m" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_delete_activity")?.[1]).toEqual({ id: "w", reassignTo: "m" }));
  });
});
