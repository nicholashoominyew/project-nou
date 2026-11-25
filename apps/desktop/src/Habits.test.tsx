import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Habits, { nextState } from "./Habits";
import { clearUndo, redoLatest, undoLatest } from "./undo";

const { calls, db } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], db: { checkins: [] as any[], activities: [] as any[], habits: [] as any[], log: [] as any[], pending: [] as any[], fail: {} as Record<string, string>, importResult: { habits_added: 1, entries_added: 3, entries_kept: 0 } } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (db.fail[command]) throw new Error(db.fail[command]);
  if (command === "habits_list_cmd") return db.habits;
  if (command === "checkin_list_cmd") return db.checkins;
  if (command === "timetable_get") return { system_page_id: null, swap_ab: false, activities: db.activities, slots: [], edited: { a: false, b: false } };
  if (command === "habit_link_activity_cmd") return null;
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
beforeEach(() => { localStorage.clear(); clearUndo(); db.checkins = []; db.activities = []; calls.length = 0; db.habits = [habit("h1", "Exercise"), habit("h2", "Anki")]; db.log = []; db.pending = []; db.fail = {}; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = async () => { render(<Habits />); await screen.findByRole("region", { name: "Today" }); await screen.findByRole("region", { name: "Streaks" }); };
const openHistory = async () => { fireEvent.click(screen.getByRole("button", { name: /^History/ })); return await screen.findByRole("group", { name: "View" }); };
const openManage = () => { fireEvent.click(screen.getByRole("button", { name: /^Your habits/ })); return screen.getByRole("region", { name: "Manage habits" }); };

describe("clicking a day", () => {
  it("ticks an empty or no-answer day, and clears a done day (or an older skip)", () => { expect([nextState(undefined), nextState("no_answer"), nextState("done"), nextState("skipped")]).toEqual(["done", "done", null, null]); });
});

describe("the page's layout", () => {
  it("has a header with Import history, then Today, Streaks, and History and Your habits closed; no Skip anywhere and no separate Charts or Goals", async () => {
    await page();
    expect(screen.getByRole("heading", { name: "Habits", level: 1 })).toBeTruthy(); expect(screen.getByRole("button", { name: "Import history…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^History/ }).getAttribute("aria-expanded")).toBe("false"); expect(screen.getByRole("button", { name: /^Your habits/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("table")).toBeNull(); expect(screen.queryByLabelText("New habit name")).toBeNull();
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull(); expect(screen.queryByRole("region", { name: "Charts" })).toBeNull(); expect(screen.queryByText(/JLPT|Teaching of the day/)).toBeNull();
  });
  it("History and Your habits open and close with the keyboard (Enter on the button) and say so with aria-expanded", async () => {
    await page();
    const hist = screen.getByRole("button", { name: /^History/ }); hist.focus(); fireEvent.click(hist); expect(hist.getAttribute("aria-expanded")).toBe("true"); expect(hist.textContent).toMatch(/HIDE/);
    fireEvent.click(hist); expect(hist.getAttribute("aria-expanded")).toBe("false"); expect(hist.textContent).toMatch(/SHOW/);
    const edit = screen.getByRole("button", { name: /^Your habits/ }); fireEvent.click(edit); expect(edit.getAttribute("aria-expanded")).toBe("true"); expect(edit.textContent).toMatch(/CLOSE/);
  });
});

describe("Today", () => {
  it("shows a ring with done out of the habits that count today, and one circle per habit with no letter inside; ticking writes today's log and updates the ring", async () => {
    await page();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getByRole("img", { name: "0 of 2 habits done today" })).toBeTruthy(); expect(within(today).getByText("0/2")).toBeTruthy();
    const circle = within(today).getByRole("button", { name: "Mark done: Exercise" }); expect(circle.getAttribute("aria-pressed")).toBe("false"); expect(circle.textContent).toBe("Exercise"); // the name only, no letter or icon in the circle
    fireEvent.click(circle);
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(), habitId: "h1", state: "done", today: day() }));
    const on = await within(today).findByRole("button", { name: "Mark not done: Exercise" }); expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(within(today).getByRole("img", { name: "1 of 2 habits done today" })).toBeTruthy(); expect(within(today).queryByText("ALL DONE")).toBeNull();
    fireEvent.click(within(today).getByRole("button", { name: "Mark done: Anki" }));
    expect(await within(today).findByText("ALL DONE")).toBeTruthy();
    fireEvent.click(on); await waitFor(() => expect(sent("habit_log_set_cmd").at(-1)!.args).toMatchObject({ habitId: "h1", state: null })); // a second tap clears it
  });
  it("only shows the habits whose weekday chip for today is on", async () => {
    const mask = 127 & ~(1 << ((new Date().getDay() + 6) % 7)); db.habits = [habit("h1", "Exercise"), habit("h2", "Anki", { days: mask })];
    await page(); const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getByRole("button", { name: "Mark done: Exercise" })).toBeTruthy(); expect(within(today).queryByRole("button", { name: /Anki/ })).toBeNull(); expect(within(today).getByText("0/1")).toBeTruthy();
  });
  it("starts with a hint when there are no habits", async () => {
    db.habits = []; render(<Habits />); expect(await screen.findByText(/No habits yet/)).toBeTruthy();
  });
});

describe("Streaks", () => {
  const d = (n: number, id = "h1") => ({ day: day(n), habit_id: id, state: "done", answered_at: null, source: "manual" });
  it("shows completion, full days and days with a tick for the range, switching between 7D, 30D and 90D", async () => {
    db.log = [d(0), d(-1), d(-1, "h2")]; await page();
    const card = screen.getByRole("region", { name: "Streaks" });
    expect(within(card).getByText("LAST 30 DAYS · TAP A HABIT TO FOCUS")).toBeTruthy(); expect(within(card).getByRole("button", { name: "30D" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(card).getByText("2 / 30")).toBeTruthy(); // days with a tick
    fireEvent.click(within(card).getByRole("button", { name: "7D" })); expect(within(card).getByText("LAST 7 DAYS · TAP A HABIT TO FOCUS")).toBeTruthy(); expect(within(card).getByText("1 / 7")).toBeTruthy(); // one full day
    fireEvent.click(within(card).getByRole("button", { name: "90D" })); expect(within(card).getByText("LAST 90 DAYS · TAP A HABIT TO FOCUS")).toBeTruthy();
  });
  it("draws the heatmap to the range: one row of big squares for 7D, a weekday grid for 30D and 90D, with a tooltip on each day", async () => {
    db.log = [d(0)]; await page(); const card = screen.getByRole("region", { name: "Streaks" });
    const cells = () => [...card.querySelectorAll(".hx-map")][0].querySelectorAll(".hx-cell:not(.pad)");
    const grid = () => ([...card.querySelectorAll(".hx-grid")][0] as HTMLElement);
    expect(cells()).toHaveLength(30); expect(grid().style.gridTemplateRows).toBe("repeat(7, 24px)");
    fireEvent.click(within(card).getByRole("button", { name: "7D" })); expect(cells()).toHaveLength(7); expect(grid().style.gridTemplateRows).toBe("repeat(1, 44px)"); expect((cells()[0] as HTMLElement).style.borderRadius).toBe("12px");
    fireEvent.click(within(card).getByRole("button", { name: "90D" })); expect(cells()).toHaveLength(90); expect(grid().style.gridTemplateRows).toBe("repeat(7, 14px)"); expect((cells()[0] as HTMLElement).style.borderRadius).toBe("3px");
    const last = cells()[89] as HTMLElement; expect(last.title).toMatch(/· done$/); expect(last.className).toMatch(/\bdone\b/); expect((cells()[88] as HTMLElement).title).toMatch(/· missed$/);
  });
  it("shows each habit's rate, its streak (an open day does not break it), and focuses one on tap, dimming the others", async () => {
    db.log = [d(-1), d(-2), d(-3)]; await page(); // today is still empty: the streak counts back from yesterday
    const card = screen.getByRole("region", { name: "Streaks" });
    const ex = within(card).getByRole("button", { name: /Exercise/ }); expect(ex.textContent).toMatch(/3D STREAK/); expect(ex.textContent).toMatch(/10%/);
    const anki = within(card).getByRole("button", { name: /Anki/ }); expect(anki.textContent).toMatch(/0D STREAK/);
    fireEvent.click(ex); expect(ex.getAttribute("aria-pressed")).toBe("true"); expect(ex.style.opacity).toBe("1"); expect(anki.style.opacity).toBe("0.3");
    fireEvent.click(ex); expect(anki.style.opacity).toBe("1"); expect(ex.getAttribute("aria-pressed")).toBe("false");
  });
  it("draws eight weekly bars, the newest labelled NOW", async () => {
    await page(); const bars = screen.getByRole("img", { name: /^Completion of the last 8 weeks/ });
    expect(bars.querySelectorAll(".hx-bar")).toHaveLength(8); expect(bars.querySelector(".hx-bar.now")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Streaks" }).querySelector(".hx-bar-labels")!.textContent).toBe("W-7W-6W-5W-4W-3W-2W-1NOW");
  });
  it("a habit's weekday chips change its rate: days it does not count on are not missed days", async () => {
    const mask = 127 & ~(1 << ((new Date().getDay() + 6) % 7)); db.habits = [habit("h1", "Exercise", { days: mask })]; db.log = [d(-1)]; await page();
    expect(within(screen.getByRole("region", { name: "Streaks" })).getByRole("button", { name: /Exercise/ }).textContent).toMatch(/\d+%/);
  });
});

describe("History", () => {
  it("lists days newest first with 14 rows to start, a tick square per habit in the habit order and a progress bar; and 30 more days on request", async () => {
    db.log = [{ day: day(-1), habit_id: "h2", state: "done", answered_at: null, source: "manual" }]; await page(); await openHistory();
    const table = await screen.findByRole("table", { name: "Daily habit table" }).catch(() => null);
    void table; const rows = document.querySelectorAll(".hx-trow:not(.hx-thead)"); expect(rows).toHaveLength(14);
    expect(document.querySelector(".hx-thead")!.textContent).toBe("DAYExerciseAnkiPROGRESS"); expect(rows[0].classList.contains("today")).toBe(true);
    const yesterday = rows[1] as HTMLElement; expect(within(yesterday).getByRole("img", { name: "1 of 2, 50%" })).toBeTruthy(); expect(yesterday.textContent).toMatch(/1\/2 · 50%/);
    fireEvent.click(screen.getByRole("button", { name: "Show 30 more days" })); expect(document.querySelectorAll(".hx-trow:not(.hx-thead)")).toHaveLength(44);
  });
  it("lets a missed day be ticked by hand in the table", async () => {
    await page(); await openHistory();
    const rows = document.querySelectorAll(".hx-trow:not(.hx-thead)"); const cell = within(rows[2] as HTMLElement).getByRole("button", { name: /Exercise on .*: not done/ });
    fireEvent.click(cell); await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(-2), habitId: "h1", state: "done" }));
    expect(await within(document.querySelectorAll(".hx-trow:not(.hx-thead)")[2] as HTMLElement).findByRole("button", { name: /Exercise on .*: done$/ })).toBeTruthy();
  });
  it("shows no answer as not done but marked, and a click turns it into done", async () => {
    db.log = [{ day: day(-1), habit_id: "h1", state: "no_answer", answered_at: "x", source: "timeout" }]; await page(); await openHistory();
    const cell = within(document.querySelectorAll(".hx-trow:not(.hx-thead)")[1] as HTMLElement).getByRole("button", { name: /Exercise on .*: no answer/ }); fireEvent.click(cell);
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(-1), state: "done" }));
  });
  it("switches to the month, fills each day by its completion, dashes future days, and a day can be edited from it", async () => {
    db.log = [{ day: day(), habit_id: "h1", state: "done", answered_at: null, source: "manual" }]; await page(); await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    const grid = await screen.findByRole("grid"); const todayCell = within(grid).getByRole("gridcell", { name: /: 1 of 2 done/ }); expect(todayCell.className).toMatch(/today/);
    expect((todayCell.querySelector(".hx-mfill") as HTMLElement).style.height).toBe("50%");
    fireEvent.click(todayCell); const panel = await screen.findByRole("group", { name: /^Habits on / });
    fireEvent.click(within(panel).getByRole("button", { name: /Anki on .*: not done/ }));
    await waitFor(() => expect(sent("habit_log_set_cmd")[0].args).toMatchObject({ day: day(), habitId: "h2", state: "done" }));
    expect(await within(grid).findByRole("gridcell", { name: /: 2 of 2 done/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" })); fireEvent.click(screen.getByRole("button", { name: "Next month" })); expect(grid.querySelectorAll("[role=gridcell]").length % 7).toBe(0);
  });
});

describe("Your habits", () => {
  it("lists each habit with weekday chips, adds one with a type and days, and deletes one only after confirming", async () => {
    await page(); const manage = openManage();
    expect(within(manage).getByRole("group", { name: "Days for Exercise" }).querySelectorAll("button")).toHaveLength(7);
    fireEvent.change(within(manage).getByLabelText("New habit name"), { target: { value: "  Reading " } }); fireEvent.change(within(manage).getByLabelText("Type of the new habit"), { target: { value: "Leisure" } });
    const newDays = within(manage).getByRole("group", { name: "Days for the new habit" }); fireEvent.click(within(newDays).getByRole("button", { name: "SAT on" })); fireEvent.click(within(newDays).getByRole("button", { name: "SUN on" }));
    fireEvent.click(within(manage).getByRole("button", { name: "Add habit" }));
    await waitFor(() => expect(sent("habit_add_cmd")[0].args).toEqual({ name: "  Reading ", days: 31, category: "Leisure" }));
    expect(await within(manage).findByRole("button", { name: "Open Reading" })).toBeTruthy();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(within(manage).getByRole("button", { name: "Delete Anki" })); expect(sent("habit_delete_cmd")).toHaveLength(0);
    fireEvent.click(within(manage).getByRole("button", { name: "Delete Anki" })); await waitFor(() => expect(sent("habit_delete_cmd")[0].args).toEqual({ id: "h2" })); expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("“Anki” deleted.")).toBeTruthy();
  });
  it("a weekday chip changes the days a habit counts (and the last one cannot be switched off)", async () => {
    db.habits = [habit("h1", "Exercise", { days: 3 })]; await page(); const manage = openManage(); const chips = within(manage).getByRole("group", { name: "Days for Exercise" });
    expect(within(chips).getByRole("button", { name: "MON on" }).getAttribute("aria-pressed")).toBe("true"); expect(within(chips).getByRole("button", { name: "WED off" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(chips).getByRole("button", { name: "WED off" })); await waitFor(() => expect(sent("habit_update_cmd")[0].args).toMatchObject({ id: "h1", days: 7 }));
    cleanup(); db.habits = [habit("h1", "Exercise", { days: 1 })]; calls.length = 0; await page(); const m2 = openManage();
    fireEvent.click(within(within(m2).getByRole("group", { name: "Days for Exercise" })).getByRole("button", { name: "MON on" })); expect(sent("habit_update_cmd")).toHaveLength(0);
  });
  it("opens a habit in a window with its streaks, and renames it and changes its type there", async () => {
    const d = (n: number) => ({ day: day(n), habit_id: "h1", state: "done", answered_at: null, source: "manual" });
    db.log = [d(0), d(-1), d(-2), d(-4), d(-5), d(-6), d(-7)]; await page(); const manage = openManage();
    fireEvent.click(within(manage).getByRole("button", { name: "Open Exercise" })); const win = await screen.findByRole("dialog", { name: "Exercise details" });
    const stat = (label: string) => within(win).getByText(label).parentElement!.querySelector("b")!.textContent; expect(stat("Current streak")).toBe("3"); expect(stat("Longest streak")).toBe("4");
    const name = within(win).getByLabelText("Habit name"); fireEvent.change(name, { target: { value: "Workout" } }); fireEvent.blur(name);
    await waitFor(() => expect(sent("habit_update_cmd")[0].args).toEqual({ id: "h1", name: "Workout", days: null, category: null }));
    fireEvent.change(within(win).getByLabelText("Type"), { target: { value: "Training" } }); await waitFor(() => expect(sent("habit_update_cmd")[1].args).toEqual({ id: "h1", name: null, days: null, category: "Training" }));
    fireEvent.keyDown(window, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("puts habits in your order with the six dots (or the arrow keys), and the page follows", async () => {
    await page(); openManage(); fireEvent.keyDown(screen.getByLabelText(/Drag Anki to reorder/), { key: "ArrowUp" });
    await waitFor(() => expect(sent("habits_reorder_cmd")[0].args).toEqual({ ids: ["h2", "h1"] }));
    await waitFor(() => expect([...document.querySelectorAll(".hx-circle-name")].map(n => n.textContent)).toEqual(["Anki", "Exercise"]));
  });
  it("shows an error from the backend", async () => {
    db.fail = { habit_add_cmd: "A habit with that name already exists" }; await page(); const manage = openManage();
    fireEvent.change(within(manage).getByLabelText("New habit name"), { target: { value: "exercise" } }); fireEvent.click(within(manage).getByRole("button", { name: "Add habit" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A habit with that name already exists");
  });
});

describe("pop-ups and the timetable", () => {
  it("says which habits are not on the timetable yet (so they cannot pop up) and offers the timetable", async () => {
    db.checkins = [{ id: "k1", habit_id: "h1", weekday: 0, start_slot: 10, end_slot: 11, variant: "A" }];
    const open = vi.fn(); render(<Habits onOpenTimetable={open} />); await screen.findByRole("region", { name: "Streaks" });
    const manage = openManage();
    const ex = within(manage).getByRole("button", { name: "Open Exercise" }).closest("li")!, anki = within(manage).getByRole("button", { name: "Open Anki" }).closest("li")!;
    expect(within(ex as HTMLElement).getByText(/On the timetable: 1 block$/)).toBeTruthy();
    expect(within(anki as HTMLElement).getByText(/Not on the timetable yet, so it will not pop up/)).toBeTruthy();
    fireEvent.click(within(anki as HTMLElement).getByRole("button", { name: "Open the Life Timetable" })); expect(open).toHaveBeenCalled();
  });
  it("a Test pop-up button asks for a pop-up for that habit", async () => {
    const seen: any[] = []; const f = (e: Event) => seen.push((e as CustomEvent).detail); window.addEventListener("nou-test-checkin", f);
    await page(); const manage = openManage(); fireEvent.click(within(within(manage).getByRole("button", { name: "Open Anki" }).closest("li") as HTMLElement).getByRole("button", { name: "Test pop-up" }));
    window.removeEventListener("nou-test-checkin", f); expect(seen).toEqual([{ id: "h2", name: "Anki" }]);
  });
  it("lets a habit take over an activity already on the timetable, so its blocks start to check in", async () => {
    db.activities = [{ id: "jp", name: "JP Anki", category: "Leisure", colour: null, remind: true, sort_order: 1, habit_id: null }, { id: "mine", name: "Anki", category: "Health", colour: null, remind: false, sort_order: 2, habit_id: "h2" }];
    await page(); fireEvent.click(within(openManage()).getByRole("button", { name: "Open Anki" })); const win = await screen.findByRole("dialog", { name: "Anki details" });
    const select = await within(win).findByLabelText("Use an existing timetable activity"); expect([...(select as HTMLSelectElement).options].map(o => o.text)).toEqual(["Use an existing activity…", "JP Anki"]); // activities that belong to a habit are not offered
    expect((within(win).getByRole("button", { name: "Use it" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "jp" } }); fireEvent.click(within(win).getByRole("button", { name: "Use it" }));
    await waitFor(() => expect(sent("habit_link_activity_cmd")[0].args).toEqual({ habitId: "h2", activityId: "jp" }));
  });
});

describe("Undo and import", () => {
  it("takes back a tick, a new habit and a new order with the shared Undo (Ctrl+Z)", async () => {
    await page(); fireEvent.click(within(screen.getByRole("region", { name: "Today" })).getByRole("button", { name: "Mark done: Exercise" })); await waitFor(() => expect(sent("habit_log_set_cmd")).toHaveLength(1));
    expect(await undoLatest()).toMatch(/Ticked Exercise/); await waitFor(() => expect(sent("habit_log_set_cmd")[1].args).toMatchObject({ habitId: "h1", state: null }));
    const manage = openManage(); fireEvent.keyDown(screen.getByLabelText(/Drag Anki to reorder/), { key: "ArrowUp" }); await waitFor(() => expect(sent("habits_reorder_cmd")).toHaveLength(1));
    expect(await undoLatest()).toBe("Order of habits"); await waitFor(() => expect(sent("habits_reorder_cmd")[1].args).toEqual({ ids: ["h1", "h2"] }));
    fireEvent.change(within(manage).getByLabelText("New habit name"), { target: { value: "Reading" } }); fireEvent.click(within(manage).getByRole("button", { name: "Add habit" })); await waitFor(() => expect(sent("habit_add_cmd")).toHaveLength(1));
    expect(await undoLatest()).toBe("New habit “Reading”"); await waitFor(() => expect(sent("habit_delete_cmd")[0].args).toEqual({ id: "h3" })); expect(await undoLatest()).toBeNull();
    expect(await redoLatest()).toBe("New habit “Reading”"); await waitFor(() => expect(sent("habit_add_cmd")).toHaveLength(2)); expect(sent("habit_add_cmd")[1].args).toEqual({ name: "Reading", days: 127, category: "Health" }); // redo adds it again with the same details
    expect(await redoLatest()).toBeNull(); // nothing else was undone
  });
  it("imports a history file, and refuses a file that is not one", async () => {
    await page(); const input = document.querySelector("input[type=file]") as HTMLInputElement;
    const send = (text: string) => fireEvent.change(input, { target: { files: [new File([text], "history.json", { type: "application/json" })] } });
    send(JSON.stringify({ rows: [{ day: "2026-01-01", habit: "Anki", done: true }] })); await waitFor(() => expect(sent("habit_import_cmd")[0].args).toEqual({ rows: [{ day: "2026-01-01", habit: "Anki", done: true }] }));
    expect(await screen.findByText(/Imported 3 ticks and 1 new habit. 0 days you had already logged were kept/)).toBeTruthy();
    send("not json"); expect((await screen.findByRole("alert")).textContent).toMatch(/not a habit history file/);
    send(JSON.stringify([{ day: "2026-01-01" }])); await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/needs day, habit and done/)); expect(sent("habit_import_cmd")).toHaveLength(1);
  });
});

describe("how many habits make 100%", () => {
  const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  it("uses the usual number, lets one day differ, and can go back", async () => {
    db.habits = ["a", "b", "c", "d", "e", "f"].map(n => habit(n, n.toUpperCase()));
    db.log = ["a", "b", "c", "d"].map(id => ({ day: day(), habit_id: id, state: "done", answered_at: null, source: "manual" }));
    await page();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getByText("4/6")).toBeTruthy();
    choose("Usually needed", "5"); expect(await within(today).findByText("4/5")).toBeTruthy(); expect(within(today).queryByText("TARGET MET")).toBeNull();
    choose("Needed today", "4"); expect(await within(today).findByText("4/4")).toBeTruthy(); expect(within(today).getByText("TARGET MET")).toBeTruthy();
    choose("Needed today", ""); expect(await within(today).findByText("4/5")).toBeTruthy();
    await undoLatest(); expect(await within(today).findByText("4/4")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("nou-habit-target")!)).toEqual({ usual: [{ from: day(), n: 5 }], days: { [day()]: 4 } });
  });
});
