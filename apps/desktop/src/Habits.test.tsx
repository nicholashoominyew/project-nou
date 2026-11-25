import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Habits, { nextState } from "./Habits";
import { clearUndo, undoLatest } from "./undo";

const { calls, db } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], db: { habits: [] as any[], log: [] as any[], pending: [] as any[], fail: {} as Record<string, string>, importResult: { habits_added: 1, entries_added: 3, entries_kept: 0 } } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (db.fail[command]) throw new Error(db.fail[command]);
  if (command === "habits_list_cmd") return db.habits;
  if (command === "habit_log_list_cmd") return db.log;
  if (command === "checkin_events_pending_cmd") return db.pending;
  if (command === "habit_add_cmd") { const h = { id: "h" + (db.habits.length + 1), name: args.name.trim(), days: args.days ?? 127, sort_order: db.habits.length, created_at: new Date(2026, 0, 1, 12).toISOString(), category: args.category ?? "Health" }; db.habits.push(h); return h; }
  if (command === "habit_update_cmd") { const h = db.habits.find(x => x.id === args.id); if (args.name) h.name = args.name; if (args.days) h.days = args.days; if (args.category) h.category = args.category; return h; }
  if (command === "habits_reorder_cmd") { db.habits = [...args.ids.map((id: string) => db.habits.find(h => h.id === id)), ...db.habits.filter(h => !args.ids.includes(h.id))]; return null; }
  if (command === "habit_delete_cmd") { db.habits = db.habits.filter(x => x.id !== args.id); return null; }
  if (command === "habit_log_set_cmd") { db.log = db.log.filter(l => !(l.day === args.day && l.habit_id === args.habitId)); if (args.state) db.log.push({ day: args.day, habit_id: args.habitId, state: args.state, answered_at: null, source: "manual" }); return null; }
  if (command === "checkin_event_answer_cmd") { db.pending = db.pending.filter(p => !(p.checkin_id === args.checkinId && p.day === args.day)); db.log.push({ day: args.day, habit_id: "h1", state: args.answer, answered_at: null, source: "popup" }); return {}; }
  if (command === "habit_import_cmd") return db.importResult;
  return null;
} }));
// jsdom has no Blob.text(); the real window does.
if (typeof Blob.prototype.text !== "function") Blob.prototype.text = function () { return new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsText(this); }); };
const TODAY = new Date(); const pad = (n: number) => String(n).padStart(2, "0"); const day = (offset = 0) => { const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const habit = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, days: 127, sort_order: 0, created_at: new Date(2026, 0, 1, 12).toISOString(), category: "Health", ...extra });
const sent = (command: string) => calls.filter(c => c.command === command);
beforeEach(() => { clearUndo(); calls.length = 0; db.habits = [habit("h1", "Exercise"), habit("h2", "Anki")]; db.log = []; db.pending = []; db.fail = {}; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = async () => { render(<Habits />); await screen.findByRole("region", { name: "Today" }); await waitFor(() => expect(screen.getByRole("table", { name: "Daily habit table" })).toBeTruthy()); };

describe("clicking a cell", () => {
  it("ticks an empty or no-answer day, and clears a done day (or an older skip)", () => { expect([nextState(undefined), nextState("no_answer"), nextState("done"), nextState("skipped")]).toEqual(["done", "done", null, null]); });
});

describe("Habits page", () => {
  it("shows today with a tick for each habit (and no skip), and ticking writes today's log", async () => {
    await page();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).queryByRole("button", { name: /skip/i })).toBeNull();
    fireEvent.click(within(today).getByRole("button", { name: "Exercise: done today" }));
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(), habitId: "h1", state: "done", today: day() }));
    expect((await within(today).findByRole("button", { name: "Exercise: done today" })).getAttribute("aria-pressed")).toBe("true");
    expect(within(today).getByText("✓ Done")).toBeTruthy();
    fireEvent.click(within(today).getByRole("button", { name: "Exercise: done today" })); // a second tap clears it
    await waitFor(() => expect(sent("habit_log_set_cmd")[1].args).toMatchObject({ habitId: "h1", state: null }));
  });
  it("takes back a tick, a new habit, a rename and a new order with the shared Undo (Ctrl+Z)", async () => {
    await page();
    const today = screen.getByRole("region", { name: "Today" });
    fireEvent.click(within(today).getByRole("button", { name: "Exercise: done today" }));
    await waitFor(() => expect(sent("habit_log_set_cmd")).toHaveLength(1));
    expect(await undoLatest()).toMatch(/Ticked Exercise/);
    await waitFor(() => expect(sent("habit_log_set_cmd")[1].args).toMatchObject({ habitId: "h1", state: null }));
    fireEvent.keyDown(screen.getByLabelText(/Drag Anki to reorder/), { key: "ArrowUp" });
    await waitFor(() => expect(sent("habits_reorder_cmd")).toHaveLength(1));
    expect(await undoLatest()).toBe("Order of habits");
    await waitFor(() => expect(sent("habits_reorder_cmd")[1].args).toEqual({ ids: ["h1", "h2"] }));
    fireEvent.change(screen.getByLabelText("New habit name"), { target: { value: "Reading" } }); fireEvent.click(screen.getByRole("button", { name: "Add habit" }));
    await waitFor(() => expect(sent("habit_add_cmd")).toHaveLength(1));
    expect(await undoLatest()).toBe("New habit “Reading”");
    await waitFor(() => expect(sent("habit_delete_cmd")[0].args).toEqual({ id: "h3" }));
    expect(await undoLatest()).toBeNull(); // nothing else was left to undo
  });
  it("lets a missed day be ticked by hand in the table, and shows each day's progress", async () => {
    db.log = [{ day: day(-1), habit_id: "h2", state: "done", answered_at: null, source: "manual" }];
    await page();
    const table = screen.getByRole("table", { name: "Daily habit table" });
    expect(within(table).getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Day", "Exercise", "Anki", "Progress"]);
    const yesterday = within(table).getAllByRole("row")[2]; // header, today, yesterday
    expect(within(yesterday).getByRole("img", { name: "1 of 2, 50%" })).toBeTruthy();
    const cell = within(yesterday).getByRole("button", { name: /Exercise on .*: empty/ });
    fireEvent.click(cell);
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(-1), habitId: "h1", state: "done" }));
    expect(await within(yesterday).findByRole("img", { name: "2 of 2, 100%" })).toBeTruthy();
    expect(within(yesterday).getByRole("button", { name: /Anki on .*: done$/ })).toBeTruthy();
  });
  it("shows pop-up answers as such, no answer as a question mark, and imported days as imported", async () => {
    db.log = [{ day: day(), habit_id: "h1", state: "done", answered_at: "x", source: "popup" }, { day: day(-1), habit_id: "h1", state: "no_answer", answered_at: "x", source: "timeout" }, { day: day(-2), habit_id: "h1", state: "done", answered_at: null, source: "import" }];
    await page();
    const table = screen.getByRole("table", { name: "Daily habit table" });
    expect(within(table).getByRole("button", { name: /Exercise on .*: done \(pop-up\)/ })).toBeTruthy();
    expect(within(table).getByRole("button", { name: /Exercise on .*: no answer \(no answer in 2 hours\)/ }).textContent).toBe("?");
    expect(within(table).getByRole("button", { name: /Exercise on .*: done \(imported\)/ })).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: /Exercise on .*: no answer/ })); // no answer is corrected to done
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(-1), state: "done" }));
  });
  it("answers an open pop-up from the waiting list", async () => {
    db.pending = [{ checkin_id: "k1", day: day(), habit_id: "h1", habit: "Exercise", block: "Shower + Breakfast", start_slot: 10, end_slot: 11, shown_at: 1, expires_at: 2, state: "shown" }];
    render(<Habits />);
    const waiting = await screen.findByRole("region", { name: "Waiting for your answer" });
    expect(within(waiting).getByText(/05:00–05:30/)).toBeTruthy();
    fireEvent.click(within(waiting).getByRole("button", { name: "Checked in" }));
    await waitFor(() => expect(sent("checkin_event_answer_cmd")[0].args).toMatchObject({ checkinId: "k1", day: day(), answer: "done" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Waiting for your answer" })).toBeNull());
  });
  it("adds a habit with chosen days and a type, and deletes it from its window only after confirming", async () => {
    await page();
    const manage = screen.getByRole("region", { name: "Manage habits" });
    fireEvent.change(within(manage).getByLabelText("New habit name"), { target: { value: "  Reading " } });
    fireEvent.change(within(manage).getByLabelText("Type of the new habit"), { target: { value: "Leisure" } });
    const newDays = within(manage).getByRole("group", { name: "Days for the new habit" });
    fireEvent.click(within(newDays).getByRole("button", { name: "Sat" })); fireEvent.click(within(newDays).getByRole("button", { name: "Sun" }));
    fireEvent.click(within(manage).getByRole("button", { name: "Add habit" }));
    await waitFor(() => expect(sent("habit_add_cmd")[0].args).toEqual({ name: "  Reading ", days: 31, category: "Leisure" }));
    expect(await within(manage).findByText("Reading")).toBeTruthy(); expect(within(manage).getByText(/weekdays/)).toBeTruthy(); expect(within(manage).getAllByText("Leisure").some(el => el.classList.contains("chip"))).toBe(true);
    expect(screen.getByRole("columnheader", { name: "Reading" })).toBeTruthy();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(within(manage).getByRole("button", { name: "Open Anki" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete habit" })); expect(sent("habit_delete_cmd")).toHaveLength(0);
    fireEvent.click(within(manage).getByRole("button", { name: "Open Anki" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete habit" }));
    await waitFor(() => expect(sent("habit_delete_cmd")[0].args).toEqual({ id: "h2" })); expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "Anki" })).toBeNull());
    expect(await screen.findByText("“Anki” deleted.")).toBeTruthy();
  });
  it("opens a habit in a window with its current and longest streak, and renames it, changes its type and days there", async () => {
    const d = (n: number) => ({ day: day(n), habit_id: "h1", state: "done", answered_at: null, source: "manual" });
    db.log = [d(0), d(-1), d(-2), d(-4), d(-5), d(-6), d(-7)]; // a run of 3 up to today, and a run of 4 before a gap
    await page();
    fireEvent.click(within(screen.getByRole("region", { name: "Manage habits" })).getByRole("button", { name: "Open Exercise" }));
    const win = await screen.findByRole("dialog", { name: "Exercise details" });
    const stat = (label: string) => within(win).getByText(label).parentElement!.querySelector("b")!.textContent;
    expect(stat("Current streak")).toBe("3"); expect(stat("Longest streak")).toBe("4");
    const name = within(win).getByLabelText("Habit name"); fireEvent.change(name, { target: { value: "Workout" } }); fireEvent.blur(name);
    await waitFor(() => expect(sent("habit_update_cmd")[0].args).toEqual({ id: "h1", name: "Workout", days: null, category: null }));
    fireEvent.change(within(win).getByLabelText("Type"), { target: { value: "Training" } });
    await waitFor(() => expect(sent("habit_update_cmd")[1].args).toEqual({ id: "h1", name: null, days: null, category: "Training" }));
    fireEvent.click(within(within(win).getByRole("group", { name: /Days for/ })).getByRole("button", { name: "Sun" }));
    await waitFor(() => expect(sent("habit_update_cmd")[2].args).toMatchObject({ id: "h1", days: 63 }));
    fireEvent.keyDown(window, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("puts habits in your order with the six dots (or the arrow keys)", async () => {
    await page();
    fireEvent.keyDown(screen.getByLabelText(/Drag Anki to reorder/), { key: "ArrowUp" });
    await waitFor(() => expect(sent("habits_reorder_cmd")[0].args).toEqual({ ids: ["h2", "h1"] }));
    await waitFor(() => expect(screen.getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Day", "Anki", "Exercise", "Progress"]));
  });
  it("cannot take the last weekday away from a habit, and shows an error from the backend", async () => {
    db.habits = [habit("h1", "Exercise", { days: 1 })]; db.fail = { habit_add_cmd: "A habit with that name already exists" };
    await page();
    const manage = screen.getByRole("region", { name: "Manage habits" });
    fireEvent.click(within(manage).getByRole("button", { name: "Open Exercise" }));
    fireEvent.click(within(within(await screen.findByRole("dialog")).getByRole("group", { name: "Days for Exercise" })).getByRole("button", { name: "Mon" }));
    expect(sent("habit_update_cmd")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.change(within(manage).getByLabelText("New habit name"), { target: { value: "exercise" } }); fireEvent.click(within(manage).getByRole("button", { name: "Add habit" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A habit with that name already exists");
  });
  it("switches to the month view, shows progress per day, and a day can be edited from it", async () => {
    db.log = [{ day: day(), habit_id: "h1", state: "done", answered_at: null, source: "manual" }];
    await page();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    const grid = await screen.findByRole("grid");
    const todayCell = within(grid).getByRole("gridcell", { name: new RegExp(": 1 of 2 done") });
    fireEvent.click(todayCell);
    const panel = await screen.findByRole("region", { name: /^Habits on / });
    fireEvent.click(within(panel).getByRole("button", { name: /Anki on .*: empty/ }));
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(), habitId: "h2", state: "done" }));
    expect(await within(grid).findByRole("gridcell", { name: /: 2 of 2 done/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" })); fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(within(grid).getAllByRole("gridcell").length % 7).toBe(0);
  });
  it("imports a history file, and refuses a file that is not one", async () => {
    await page();
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    const send = (text: string) => fireEvent.change(input, { target: { files: [new File([text], "history.json", { type: "application/json" })] } });
    send(JSON.stringify({ rows: [{ day: "2026-01-01", habit: "Anki", done: true }] }));
    await waitFor(() => expect(sent("habit_import_cmd")[0].args).toEqual({ rows: [{ day: "2026-01-01", habit: "Anki", done: true }] }));
    expect(await screen.findByText(/Imported 3 ticks and 1 new habit. 0 days you had already logged were kept/)).toBeTruthy();
    send("not json"); expect((await screen.findByRole("alert")).textContent).toMatch(/not a habit history file/);
    send(JSON.stringify([{ day: "2026-01-01" }])); await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/needs day, habit and done/));
    expect(sent("habit_import_cmd")).toHaveLength(1);
  });
  it("starts empty with a hint, and shows the charts section", async () => {
    db.habits = [];
    render(<Habits />);
    expect(await screen.findByText(/No habits yet. Add one below/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Charts" })).toBeTruthy();
  });
});
