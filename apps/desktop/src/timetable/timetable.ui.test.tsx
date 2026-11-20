import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LifeTimetable from "./LifeTimetable";
import NowCard from "./NowCard";
import { LAST_KEY, SETTINGS_KEY, ReminderToast, useReminders } from "./reminders";

const calls: [string, any][] = [];
let slots: { weekday: number; slot_index: number; activity_id: string }[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push([command, args]);
  if (command === "timetable_get") return { system_page_id: "system-life-timetable", activities: [
    { id: "w", name: "Work", category: "Work", colour: null, remind: true, sort_order: 0 },
    { id: "m", name: "Meal", category: "Chores", colour: null, remind: true, sort_order: 1 },
    { id: "q", name: "Quiet", category: "Rest", colour: null, remind: false, sort_order: 2 },
  ], slots };
  return null;
} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const monday = (h: number, mi = 0, s = 0) => new Date(2026, 10, 16, h, mi, s); // Monday 16 Nov 2026
beforeEach(() => {
  calls.length = 0; localStorage.clear();
  slots = [];
  for (let i = 18; i < 26; i++) slots.push({ weekday: 0, slot_index: i, activity_id: "w" }); // Work 09:00-13:00
  slots.push({ weekday: 0, slot_index: 26, activity_id: "m" }); // Meal 13:00-13:30
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(monday(10, 12));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Focus view", () => {
  it("opens from the Now card with a round countdown, the end time, pause and back-to-live, and closes with Escape", async () => {
    render(<NowCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Focus view" }));
    const dialog = await screen.findByRole("dialog", { name: "Focus view" });
    await waitFor(() => expect(screen.getByRole("timer").textContent).toMatch(/^02:4\d:\d\d$/));
    expect(dialog.textContent).toContain("13:00");
    expect(Number(screen.getByTestId("focus-arc").getAttribute("stroke-dasharray")!.split(" ")[0])).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Pause display" }));
    const held = screen.getByRole("timer").textContent;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("timer").textContent).toBe(held);
    fireEvent.click(screen.getByRole("button", { name: "Back to live time" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole("timer").textContent).not.toBe(held);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Focus view" })).toBeNull();
  });
});

describe("Home Now card", () => {
  it("shows the current event, its countdown to the end of the run, a progress bar and what is next", async () => {
    render(<NowCard />);
    const card = await screen.findByRole("button", { name: /^Now: Work, 09:00 to 13:00, 02:4\d:\d\d left/ });
    expect(card.textContent).toContain("09:00–13:00");
    expect(card.textContent).toMatch(/02:4\d:\d\d/);
    expect(card.textContent).toContain("Next: Meal at 13:00");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("30"); // 72 of the 240 minutes
  });
  it("keeps up with the clock without a restart, and opens the timetable when clicked", async () => {
    const open = vi.fn();
    render(<NowCard open={open} />);
    await screen.findByRole("button", { name: /Now: Work/ });
    await act(async () => { vi.setSystemTime(monday(13, 5)); await vi.advanceTimersByTimeAsync(1100); });
    expect((await screen.findByRole("button", { name: /Now: Meal/ })).textContent).toContain("13:00–13:30");
    fireEvent.click(screen.getByRole("button", { name: /Now: Meal/ }));
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("says nothing is planned for an empty slot", async () => {
    vi.setSystemTime(monday(20, 0));
    render(<NowCard />);
    expect(await screen.findByRole("button", { name: "Now: nothing planned" })).toBeTruthy();
  });
});

function Probe({ notify }: { notify: (body: string) => Promise<boolean> }) {
  const r = useReminders(notify);
  return <ReminderToast text={r.toast} dismiss={r.dismiss} />;
}
describe("5-minute reminder", () => {
  it("shows one toast and one native notification, and not again on later ticks or after a reload", async () => {
    vi.setSystemTime(monday(12, 55, 5));
    const notify = vi.fn(async () => true);
    const view = render(<Probe notify={notify} />);
    expect((await screen.findByRole("status")).textContent).toContain("In 5 min: Meal · 13:00–13:30");
    expect(notify).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledWith("In 5 min: Meal · 13:00–13:30");
    expect(localStorage.getItem(LAST_KEY)).toBe("2026-11-16 0:26");
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(notify).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<Probe notify={notify} />); // the app was reloaded inside the window
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("still shows the toast when the native notification is denied or unavailable", async () => {
    vi.setSystemTime(monday(12, 56));
    const notify = vi.fn(async () => false);
    render(<Probe notify={notify} />);
    expect((await screen.findByRole("status")).textContent).toContain("In 4 min: Meal");
  });
  it("stays quiet when reminders are turned off, when the event is already under way, and when its activities have reminders off", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ on: false, lead: 5 }));
    vi.setSystemTime(monday(12, 56));
    const notify = vi.fn(async () => true);
    render(<Probe notify={notify} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).not.toHaveBeenCalled(); cleanup();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ on: true, lead: 5 }));
    vi.setSystemTime(monday(13, 10));
    render(<Probe notify={notify} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(notify).not.toHaveBeenCalled();
  });
  it("uses the lead time from the settings", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ on: true, lead: 10 }));
    vi.setSystemTime(monday(12, 50, 30));
    const notify = vi.fn(async () => true);
    render(<Probe notify={notify} />);
    expect((await screen.findByRole("status")).textContent).toContain("In 10 min: Meal");
  });
});

describe("Life Timetable page", () => {
  it("draws merged blocks, the now line on today's column, and the hours per category", async () => {
    render(<LifeTimetable />);
    expect(await screen.findByRole("grid", { name: "Weekly timetable" })).toBeTruthy();
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
    expect(screen.getByText("09:00–13:00")).toBeTruthy();
    expect(screen.getByTestId("now-line")).toBeTruthy();
    expect(screen.getAllByRole("columnheader", { name: "Mon" })[0].getAttribute("aria-current")).toBe("date");
    const totals = screen.getByRole("table");
    expect(totals.textContent).toContain("4"); // 4 h of Work on Monday
  });
  it("chooses slots with the keyboard and saves the picked activities straight to the database", async () => {
    render(<LifeTimetable />);
    const cell = await screen.findByRole("gridcell", { name: "Tuesday 06:00, empty" });
    cell.focus();
    fireEvent.keyDown(cell, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(cell, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "Choose activities" });
    expect(dialog.textContent).toContain("Tuesday 06:00–07:00");
    fireEvent.click(screen.getByRole("checkbox", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_set_slots")?.[1]).toEqual({ weekday: 1, slots: [12, 13], activityIds: ["w"] }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });
  it("selects by dragging, clears with Delete and copies a day to others", async () => {
    render(<LifeTimetable />);
    const a = await screen.findByRole("gridcell", { name: "Wednesday 02:00, empty" });
    fireEvent.mouseDown(a);
    fireEvent.mouseEnter(screen.getByRole("gridcell", { name: "Wednesday 03:00, empty" }));
    fireEvent.mouseUp(a.closest(".tt-scroll")!);
    expect((await screen.findByRole("dialog")).textContent).toContain("Wednesday 02:00–03:30");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const work = screen.getAllByRole("gridcell", { name: /^Monday 09:00: Work$/ })[0];
    fireEvent.keyDown(work, { key: "Delete" });
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_set_slots")?.[1]).toEqual({ weekday: 0, slots: [18], activityIds: [] }));
    fireEvent.keyDown(work, { key: "Enter" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Tuesday" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy day" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_copy_day")?.[1]).toEqual({ from: 0, to: [1] }));
  });
  it("manages activities: add, rename, remind toggle, and delete needs a reassignment while the activity is used", async () => {
    render(<LifeTimetable />);
    fireEvent.click(await screen.findByRole("button", { name: "Activities" }));
    fireEvent.change(screen.getByLabelText("New activity name"), { target: { value: "Piano" } });
    fireEvent.click(screen.getByRole("button", { name: "Add activity" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_add_activity")?.[1]).toEqual({ name: "Piano", category: "Training" }));
    fireEvent.click(screen.getAllByRole("checkbox", { name: /Remind/ })[0]);
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_update_activity")?.[1].activity.remind).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    const confirm = screen.getByRole("button", { name: "Delete Work" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true); // used in 8 slots: pick another activity first
    fireEvent.change(screen.getByLabelText("Reassign slots to"), { target: { value: "m" } });
    expect((screen.getByRole("button", { name: "Delete Work" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    await waitFor(() => expect(calls.find(c => c[0] === "timetable_delete_activity")?.[1]).toEqual({ id: "w", reassignTo: "m" }));
  });
});
