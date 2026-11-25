import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Home, { HOME_WIDGETS, type HomeWidget } from "./Home";

const { calls, resurfaced } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], resurfaced: { items: [] as any[] } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "list_resurfaced_pages") return resurfaced.items;
  if (command === "list_recent_pages") return [{ id: "a", title: "Alpha", updated_at: new Date(Date.now() - 5 * 60000).toISOString() }, { id: "b", title: "Beta", updated_at: "2020-01-01T00:00:00.000Z" }];
} }));
const pages = [
  { id: "a", title: "Alpha", parent_id: null, sort_key: "1", icon: "document", is_favorite: true },
  { id: "b", title: "Beta", parent_id: null, sort_key: "2", icon: "document", is_favorite: false },
] as any;
const show = (extra: Partial<React.ComponentProps<typeof Home>> = {}) => render(<Home pages={pages} open={() => {}} openDaily={() => {}} newPage={() => {}} disabled={false} {...extra} />);
beforeEach(() => { localStorage.clear(); calls.length = 0; resurfaced.items = []; });

describe("Home", () => {
  it("shows the built-in widgets: daily page, recent pages and favorites, and no tags", async () => {
    show();
    expect(await screen.findByText("5 min ago")).toBeTruthy();
    expect(within(screen.getByLabelText("Favorites")).getByText("Alpha")).toBeTruthy();
    expect(screen.getByLabelText("Daily page")).toBeTruthy();
    expect(screen.queryByLabelText("Tags")).toBeNull();
    expect(calls.some(c => c.command === "list_tags")).toBe(false);
  });
  it("opens a page from a widget, and today's page from the daily widget", async () => {
    const open = vi.fn(), daily = vi.fn();
    show({ open, openDaily: daily });
    fireEvent.click((await screen.findAllByText("Beta"))[0]);
    expect(open).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByText("Open today's page"));
    expect(daily).toHaveBeenCalledTimes(1);
  });
  it("offers New page, or Create your first page when the workspace is empty", () => {
    const newPage = vi.fn();
    const { unmount } = show({ newPage });
    fireEvent.click(screen.getByText("New page"));
    expect(newPage).toHaveBeenCalledTimes(1);
    unmount();
    show({ pages: [] });
    expect(screen.getByText("Create your first page")).toBeTruthy();
  });
  it("is disabled while saving: widget links and New page cannot be used", async () => {
    show({ disabled: true });
    await screen.findByText("5 min ago");
    expect((screen.getByText("New page") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByText("Alpha")[0].closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
  it("customize: hide and show sections, and remember the layout (the arrangement itself is fixed)", async () => {
    const { unmount } = show();
    fireEvent.click(screen.getByLabelText("Customize"));
    expect(screen.queryByLabelText("Move Favorites up")).toBeNull();
    fireEvent.click(screen.getByLabelText("Hide Favorites"));
    expect(screen.queryByLabelText("Favorites")).toBeNull();
    fireEvent.click(screen.getByLabelText("Hide Calendar"));
    expect(screen.queryByLabelText("Calendar")).toBeNull();
    unmount();
    show(); // a fresh mount reads the saved layout
    expect(screen.queryByLabelText("Favorites")).toBeNull();
    expect(screen.queryByLabelText("Calendar")).toBeNull();
    fireEvent.click(screen.getByLabelText("Customize"));
    fireEvent.click(screen.getByText("Show Favorites"));
    expect(screen.getByLabelText("Favorites")).toBeTruthy();
  });
  it("lays the sections out as the brief says: the daily strip, the calendar column beside the clocks column, then two rows", () => {
    const { container } = show();
    expect(container.querySelector(".home-card.strip.w-daily")).toBeTruthy();
    const cols = container.querySelectorAll(".home-grid > .home-col");
    expect(cols.length).toBe(2);
    expect(cols[0].classList.contains("span2")).toBe(true);
    expect([...cols[0].querySelectorAll(".home-card")].map(c => c.getAttribute("aria-label"))).toEqual(["Calendar", "Teaching of the day"]);
    expect([...cols[1].querySelectorAll(".home-card")].map(c => c.getAttribute("aria-label"))).toEqual(["Clocks", "Today's tasks", "Weather"]);
    const rows = container.querySelectorAll(".home-row");
    expect([...rows[0].querySelectorAll(".home-card")].map(c => c.getAttribute("aria-label"))).toEqual(["Year, quarter, month and day", "Countdowns", "Goals", "Waiting for approval"]);
    expect([...rows[1].querySelectorAll(".home-card")].map(c => c.getAttribute("aria-label"))).toEqual(["Recently edited", "Favorites", "Worth revisiting"]);
  });
  it("the gear opens a panel that holds AI access, and Done closes it", () => {
    const access = vi.fn();
    show({ onManageAccess: access });
    expect(screen.queryByText("AI access")).toBeNull();
    fireEvent.click(screen.getByLabelText("Customize"));
    fireEvent.click(screen.getByText("AI access"));
    expect(access).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Done"));
    expect(screen.queryByText("AI access")).toBeNull();
  });
  it("shows a message when every widget is hidden", () => {
    localStorage.setItem("nou-home-layout", JSON.stringify({ order: HOME_WIDGETS.map(w => w.id), hidden: HOME_WIDGETS.map(w => w.id) }));
    show();
    expect(screen.getByText(/All widgets are hidden/)).toBeTruthy();
  });
  it("an approved request to hide or show sections updates an open Home page at once", async () => {
    show();
    expect(screen.getByLabelText("Favorites")).toBeTruthy();
    localStorage.setItem("nou-home-layout", JSON.stringify({ order: HOME_WIDGETS.map(w => w.id), hidden: ["favorites"] }));
    window.dispatchEvent(new Event("nou:home-layout-changed"));
    await waitFor(() => expect(screen.queryByLabelText("Favorites")).toBeNull());
    localStorage.setItem("nou-home-layout", JSON.stringify({ order: HOME_WIDGETS.map(w => w.id), hidden: [] }));
    window.dispatchEvent(new Event("nou:home-layout-changed"));
    expect(await screen.findByLabelText("Favorites")).toBeTruthy();
  });
  it("a later feature can plug in a widget through the registry", async () => {
    const extra: HomeWidget = { id: "inbox", title: "Inbox", render: () => <p>captured thought</p> };
    show({ widgets: [extra] });
    expect(within(screen.getByLabelText("Inbox")).getByText("captured thought")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Favorites")).toBeNull());
  });
  describe("Worth revisiting", () => {
    const item = (id: string, title: string, reason: string, extra: object = {}) => ({ id, title, updated_at: "2025-01-01T00:00:00.000Z", created_at: "2024-11-17T00:00:00.000Z", reason, years_ago: null, ...extra });
    it("asks for today's local date and shows anniversaries first, then old notes, with why each is shown", async () => {
      resurfaced.items = [item("s1", "Old plan", "stale"), item("a1", "Trip notes", "anniversary", { years_ago: 2 }), item("a2", "Last year", "anniversary", { years_ago: 1 })];
      show();
      const box = await screen.findByLabelText("Worth revisiting");
      const titles = within(box).getAllByRole("listitem").map(li => li.querySelector("span")!.textContent);
      expect(titles).toEqual(["Trip notes", "Last year", "Old plan"]);
      expect(within(box).getByText("Written 2 years ago today")).toBeTruthy();
      expect(within(box).getByText("Written a year ago today")).toBeTruthy();
      expect(within(box).getByText(/Not edited for/)).toBeTruthy();
      const asked = calls.find(c => c.command === "list_resurfaced_pages")!;
      expect(asked.args.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    it("opens the note when clicked", async () => {
      resurfaced.items = [item("s1", "Old plan", "stale")];
      const open = vi.fn();
      show({ open });
      fireEvent.click(await screen.findByText("Old plan"));
      expect(open).toHaveBeenCalledWith("s1");
    });
    it("Not now hides a note, remembers it for next time, and the next suggestion fills in", async () => {
      resurfaced.items = [item("s1", "Old plan", "stale"), item("s2", "Another", "stale")];
      const { unmount } = show();
      fireEvent.click(await screen.findByLabelText("Not now: Old plan"));
      expect(screen.queryByText("Old plan")).toBeNull();
      expect(screen.getByText("Another")).toBeTruthy();
      unmount();
      show(); // a fresh mount reads the saved snooze
      expect(await screen.findByText("Another")).toBeTruthy();
      expect(screen.queryByText("Old plan")).toBeNull();
    });
    it("says what is going on when nothing is suggested, and when everything is snoozed", async () => {
      const { unmount } = show();
      expect(await screen.findByText(/No old notes to bring back yet/)).toBeTruthy();
      unmount();
      resurfaced.items = [item("s1", "Old plan", "stale")];
      show();
      fireEvent.click(await screen.findByLabelText("Not now: Old plan"));
      expect(screen.getByText("Nothing else to revisit today.")).toBeTruthy();
    });
    it("shows at most three of each kind", async () => {
      resurfaced.items = Array.from({ length: 6 }, (_, i) => item("s" + i, "Stale " + i, "stale")).concat(Array.from({ length: 5 }, (_, i) => item("a" + i, "Anniv " + i, "anniversary", { years_ago: 1 })));
      show();
      const box = await screen.findByLabelText("Worth revisiting");
      expect(within(box).getAllByRole("listitem").length).toBe(6);
    });
  });
  it("each card header shows a state dot: an accent dot with a ring when the card is live, a muted dot when idle", async () => {
    const { container } = show();
    await screen.findByLabelText("Favorites");
    const dot = (title: string) => within(screen.getByLabelText(title)).getByRole("heading", { level: 2 }).querySelector(".state-dot")!;
    for (const live of ["Waiting for approval", "Recently edited", "Favorites", "Clocks", "Today's tasks", "Year, quarter, month and day"]) expect(dot(live).className).toContain("live");
    for (const idle of ["Worth revisiting", "Daily page", "Weather", "Countdowns", "Goals", "Calendar", "Teaching of the day"]) expect(dot(idle).className).not.toContain("live");
    expect(container.querySelectorAll(".state-dot").length).toBe(13);
  });
});
