// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Daily from "./Daily";
import { parseHistoryFile, parseMarkdown } from "./importHistory";
import { londonDay, monthStats, sectionsOn, sixWeeks, type Summary } from "./logic";

const back = vi.hoisted(() => ({ calls: [] as [string, any][], entries: [] as any[], journal: {} as Record<string, string[]>, summaries: [] as any[], failSave: false }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    back.calls.push([cmd, args]);
    if (cmd === "daily_get_cmd") return { day: args.day, exists: true, notion_page_id: null, entries: back.entries.map(e => ({ ...e })), journal: back.journal };
    if (cmd === "daily_summaries_cmd") return back.summaries;
    if (cmd === "daily_journal_save_cmd") { if (back.failSave) throw new Error("disk full"); back.journal = args.journal; return; }
    if (cmd === "daily_todo_set_cmd") { back.entries.find(e => e.id === args.id).done = args.done; return; }
    return [];
  }),
}));
const entry = (id: string, section: string, text: string, extra: object = {}) => ({ id, section, text, time: "", source: "", topic: "", link: "", done: false, ...extra });
beforeEach(() => { back.calls = []; back.entries = []; back.journal = {}; back.summaries = []; back.failSave = false; });
afterEach(cleanup);

function Screen({ start }: { start: string | null }) {
  const [day, setDay] = useState(start), [focused, setFocused] = useState(false);
  return <Daily day={day} disabled={false} focused={focused} onDay={setDay} onFocusMode={setFocused} onState={() => {}} />;
}
const card = (name: string) => screen.queryByRole("region", { name });

describe("daily rules", () => {
  it("keys days to Europe/London, whatever the device's zone", () => {
    expect(londonDay(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02"); // summer time
    expect(londonDay(new Date("2026-11-27T23:30:00Z"))).toBe("2026-11-27");
  });
  it("takes each day's cards from the registry and never shows hidden or retired ones", () => {
    const ids = (d: string) => sectionsOn(d).map(s => s.id);
    expect(ids("2026-11-27")).toContain("wecs_digest"); // Friday
    expect(ids("2026-11-27")).not.toContain("sunday_routine");
    expect(ids("2026-11-29")).toEqual(expect.arrayContaining(["sunday_routine", "meals"])); // Sunday
    expect(ids("2026-11-29")).not.toContain("aec_ai_news");
    expect(ids("2026-11-24")).toContain("xgrok_card_reveals"); // Tuesday
    for (let i = 23; i <= 29; i++) expect(ids(`2026-11-${i}`).filter(x => x === "grokbot_updates" || x === "draftbot_findings" || x === "journal")).toEqual([]);
  });
  it("draws six Monday-first weeks and counts the month from the small records", () => {
    const cells = sixWeeks(2026, 10);
    expect(cells.length).toBe(42); expect(cells[0].day).toBe("2026-10-26");
    const full = (day: string): [string, Summary] => [day, { day, journal: "full", goals: 3, win: true, learn: true, open_todos: 0, sections: 0 }];
    const stats = monthStats(2026, 10, "2026-11-27", new Map([full("2026-11-25"), full("2026-11-26"), full("2026-11-02")]), [], new Map());
    expect(stats).toEqual({ journalDays: 3, daysSoFar: 27, streak: 2, habitsAverage: 0 });
  });
});

describe("importing a day", () => {
  const md = ["# Daily Habits", "Date: November 27, 2026", "", "## 3. To-do list", "- [ ] [Bills] Check the bill - https://example.com/a", "- [x] [Parcels] Collect it - no link",
    "## Daily updates", "- 07:05 · Claude: Harvest done", "  - 12 rows added", "## Journal", "### Goals For Today (minimum 3)", "- one", "- two", "### Notes", "plain words", "## Something else", "- ignored"].join("\n");
  it("matches headings to sections, reads to-dos and the journal, and says what it left out", () => {
    const got = parseMarkdown(md, "Daily Habits 0123456789abcdef0123456789abcdef.md");
    expect(got.unknownHeadings).toEqual(["Something else"]);
    const [d] = got.days;
    expect(d.day).toBe("2026-11-27"); expect(d.notion_page_id).toBe("0123456789abcdef0123456789abcdef");
    expect(d.entries[0]).toMatchObject({ section: "todo_list", topic: "Bills", text: "Check the bill", link: "https://example.com/a", done: false });
    expect(d.entries[1]).toMatchObject({ topic: "Parcels", text: "Collect it", done: true });
    expect(d.entries[2]).toMatchObject({ section: "daily_updates", time: "07:05", source: "Claude", text: "Harvest done · 12 rows added" });
    expect(d.entries.length).toBe(3);
    expect(d.journal).toEqual({ goals: ["one", "two"], notes: ["plain words"] });
  });
  it("takes a JSON file of days and refuses a file with no date", () => {
    const got = parseHistoryFile("h.json", JSON.stringify({ days: [{ date: "2026-11-02", notion_page_id: "n1", markdown: "## Daily summary\n- Fine" }] }));
    expect(got.days[0]).toMatchObject({ day: "2026-11-02", notion_page_id: "n1", entries: [{ section: "daily_summary", text: "Fine" }] });
    expect(() => parseHistoryFile("notes.md", "## Daily summary\n- x")).toThrow(/No date/);
  });
});

describe("the day page", () => {
  it("shows ordinary and day-specific cards by weekday, with to-dos that tick", async () => {
    back.entries = [entry("a", "todo_list", "Pay", { topic: "Bills" }), entry("b", "todo_list", "Post")];
    render(<Screen start="2026-11-27" />);
    await screen.findByRole("region", { name: "To-do list" });
    expect(card("WECS digest")).toBeTruthy(); expect(card("Sunday routine")).toBeNull(); expect(screen.queryByText(/DAY-SPECIFIC/)).toBeNull();
    expect(screen.getByText("Startup Product Building")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Mark done: Pay" }));
    await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1"));
    fireEvent.click(screen.getByRole("button", { name: "Next day" })); fireEvent.click(await screen.findByRole("button", { name: "Next day" }));
    await screen.findByRole("region", { name: "Sunday routine" });
    expect(card("WECS digest")).toBeNull();
  });
  it("saves the journal as it is typed, counts goals and words, and adds lines", async () => {
    render(<Screen start="2026-11-27" />);
    fireEvent.change(await screen.findByLabelText("Goals For Today, line 1"), { target: { value: "ship it now" } });
    expect(screen.getByText("MIN 3 · 1/3")).toBeTruthy(); expect(screen.getByText("WORDS 3")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Goals For Today, line 1"), { key: "Enter" });
    fireEvent.change(await screen.findByLabelText("Goals For Today, line 2"), { target: { value: "two" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a line to Notes" }));
    expect(screen.getByLabelText("Notes, line 2")).toBeTruthy();
    await waitFor(() => expect(back.journal.goals).toEqual(["ship it now", "two"]));
    await waitFor(() => expect(screen.getByText("SAVED ON THIS DEVICE")).toBeTruthy());
  });
  it("keeps you on the day while the journal cannot be saved", async () => {
    back.failSave = true;
    render(<Screen start="2026-11-27" />);
    fireEvent.change(await screen.findByLabelText("Notes, line 1"), { target: { value: "keep me" } });
    await screen.findByText("NOT SAVED");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(screen.getByRole("alert").textContent).toMatch(/not saved/);
    expect((screen.getByLabelText("Notes, line 1") as HTMLInputElement).value).toBe("keep me");
    back.failSave = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(back.journal.notes).toEqual(["keep me"]));
  });
  it("focus mode makes everything but the journal unreachable, and Escape leaves it", async () => {
    const { container } = render(<Screen start="2026-11-27" />);
    const button = await screen.findByRole("button", { name: "Focus" });
    fireEvent.click(button);
    const off = [...container.querySelectorAll(".dy-dim")];
    expect(off.length).toBe(2); expect(off.every(el => el.classList.contains("off") && el.hasAttribute("inert"))).toBe(true);
    expect(screen.getByText("FOCUS · JOURNAL")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit focus" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".dy-dim.off")).toBeNull();
  });
});

describe("the calendar", () => {
  it("reads only the day records, previews a day and opens it", async () => {
    render(<Screen start={null} />);
    const today = londonDay(new Date());
    await waitFor(() => expect(back.calls.some(c => c[0] === "daily_summaries_cmd")).toBe(true));
    expect(back.calls.some(c => c[0] === "daily_get_cmd")).toBe(false);
    const cell = document.querySelector('[aria-current="date"]') as HTMLButtonElement;
    expect(within(cell).getByText("TODAY")).toBeTruthy();
    fireEvent.focus(cell);
    fireEvent.click(screen.getByRole("button", { name: "Open day" }));
    await screen.findByLabelText("Daily page " + today);
  });
});
