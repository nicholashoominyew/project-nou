import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarWidget, ClocksWidget, CountdownWidget, DailyWidget, PeriodsWidget, TasksWidget, TeachingWidget, WeatherWidget } from "./HomePanels";
import { Flip } from "./HomeBits";
import { dayKey } from "./timeLogic";

const { search, db, todos } = vi.hoisted(() => ({ search: { results: [] as any[], fail: "" }, db: { list: [] as any[], data: {} as Record<string, any> }, todos: { list: [] as any[], calls: [] as any[] } }));
vi.mock("./geocode", () => ({ searchPlaces: async () => { if (search.fail) throw new Error(search.fail); return search.results; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  if (command === "list_databases") return db.list;
  if (command === "get_database") return db.data[args.pageId] ?? null;
  if (command === "linked_todo_list") return todos.list;
  if (command === "linked_todo_set") { todos.calls.push({ command, args }); return {}; }
  if (command === "linked_todo_create") { todos.calls.push({ command, args }); todos.list = [...todos.list, { id: "new", text: args.text, checked: false, pages: 0 }]; return todos.list[todos.list.length - 1]; }
} }));
beforeEach(() => { todos.list = []; todos.calls.length = 0; localStorage.clear(); search.results = []; search.fail = ""; db.list = []; db.data = {}; });

describe("two clocks", () => {
  it("start as London and Kuala Lumpur, and the zone can be changed and is remembered", () => {
    const { unmount } = render(<ClocksWidget />);
    expect(screen.getAllByRole("time").length).toBe(2);
    expect(screen.getByLabelText(/Change the time zone of clock 2, now Asia\/Kuala_Lumpur/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Change the time zone of clock 2/));
    const input = screen.getByLabelText("Time zone for clock 2");
    fireEvent.change(input, { target: { value: "Mars/Base" } });
    expect((screen.getByText("Set") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Europe/London" } });
    fireEvent.click(screen.getByText("Set"));
    expect(screen.getByLabelText(/clock 2, now Europe\/London/)).toBeTruthy();
    unmount();
    render(<ClocksWidget />);
    expect(screen.getByLabelText(/clock 2, now Europe\/London/)).toBeTruthy();
  });
});

describe("weather", () => {
  const body = { current: { temperature_2m: 18.4, weather_code: 61, wind_speed_10m: 12 }, daily: { temperature_2m_max: [20], temperature_2m_min: [11] } };
  const fetchOk = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
  it("asks for nothing until a location is set, then searches, chooses and shows the weather", async () => {
    let calls = 0;
    const counting = (async () => { calls++; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch;
    render(<WeatherWidget fetchImpl={counting} />);
    expect(screen.getAllByText("No location yet.").length).toBe(2);
    expect(calls).toBe(0);
    search.results = [{ name: "Oslo", address: "Oslo, Norway", lat: 59.91, lng: 10.75 }];
    fireEvent.click(screen.getByText("Set location 1"));
    fireEvent.change(screen.getByLabelText("Search for location 1"), { target: { value: "oslo" } });
    fireEvent.click(screen.getByText("Search"));
    fireEvent.click(await screen.findByText("Oslo, Norway"));
    const card = await screen.findByLabelText("Weather 1");
    await waitFor(() => expect(within(card).getByText("18°")).toBeTruthy());
    expect(within(card).getByText("Rain")).toBeTruthy();
    expect(within(card).getByLabelText("Low 11°, high 20°")).toBeTruthy();
    expect(calls).toBe(1);
    expect(screen.getByLabelText("Weather 2").textContent).toContain("No location yet.");
  });
  it("remembers both places, loads them on opening, and Refresh asks again", async () => {
    localStorage.setItem("nou-weather-places", JSON.stringify([{ name: "Oslo", lat: 59.9, lng: 10.7 }, { name: "Lima", lat: -12, lng: -77 }]));
    let calls = 0;
    const counting = (async () => { calls++; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch;
    render(<WeatherWidget fetchImpl={counting} />);
    await waitFor(() => expect(screen.getAllByText("18°").length).toBe(2));
    expect(calls).toBe(2);
    fireEvent.click(screen.getByLabelText("Refresh weather"));
    await waitFor(() => expect(calls).toBe(4));
  });
  it("shows a failed search and a failed forecast as plain messages, and a location can be removed", async () => {
    localStorage.setItem("nou-weather-places", JSON.stringify([{ name: "Oslo", lat: 59.9, lng: 10.7 }]));
    const bad = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    render(<WeatherWidget fetchImpl={bad} />);
    const note = await screen.findByText(/Weather unavailable\./);
    expect(note.getAttribute("title")).toBe("The weather service returned 503");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Change location 1"));
    search.fail = "The place search returned 429";
    fireEvent.change(screen.getByLabelText("Search for location 1"), { target: { value: "ber" } });
    fireEvent.click(screen.getByText("Search"));
    expect(await screen.findByText("The place search returned 429")).toBeTruthy();
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getAllByText("No location yet.").length).toBe(2);
    expect(JSON.parse(localStorage.getItem("nou-weather-places")!)).toEqual([null, null]);
    void fetchOk;
  });
});

describe("year, quarter, month and day bars", () => {
  it("shows four progress bars with their percentage", () => {
    render(<PeriodsWidget />);
    const bars = screen.getAllByRole("progressbar");
    expect(bars.length).toBe(4);
    expect(bars.map(b => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/ progress$/), expect.stringMatching(/^Q\d \d{4} progress$/), expect.stringMatching(/ progress$/), "Today progress"]);
    for (const b of bars) { const n = Number(b.getAttribute("aria-valuenow")); expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(100); }
  });
});

describe("countdowns", () => {
  const future = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return dayKey(d); };
  it("adds a countdown with a unit, shows time left in that unit, can switch unit, and removes it", () => {
    render(<CountdownWidget />);
    expect(screen.getByText(/Nothing counting down/)).toBeTruthy();
    fireEvent.click(screen.getByText("Add a countdown"));
    expect((screen.getByText("Add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Countdown name"), { target: { value: "Exam" } });
    fireEvent.change(screen.getByLabelText("Countdown date"), { target: { value: future(17) } });
    fireEvent.change(screen.getByLabelText("Count in"), { target: { value: "week" } });
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByText("2 weeks 3 days left")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Exam countdown" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Show Exam in"), { target: { value: "day" } });
    expect(screen.getByText("17 days left")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("nou-countdowns")!)[0]).toMatchObject({ label: "Exam", unit: "day" });
    fireEvent.click(screen.getByLabelText("Remove Exam"));
    expect(screen.getByText(/Nothing counting down/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("nou-countdowns")!)).toEqual([]);
  });
  it("loads saved countdowns and ignores damaged ones", () => {
    localStorage.setItem("nou-countdowns", JSON.stringify([{ id: "a", label: "Trip", start: future(-10), end: future(10), unit: "month" }, { id: "b", label: "", start: "x", end: "y" }]));
    render(<CountdownWidget />);
    expect(screen.getAllByRole("progressbar").length).toBe(1);
    expect(screen.getByText("10 days left")).toBeTruthy();
  });
});

describe("master calendar", () => {
  const today = dayKey(new Date());
  const pages = [{ id: "d1", title: today, parent_id: null, sort_key: "1", icon: "document" }, { id: "n1", title: "Plain", parent_id: null, sort_key: "2", icon: "document" }] as any;
  const ctx = (extra: object = {}) => ({ pages, open: () => {}, today, openDaily: () => {}, disabled: false, refresh: async () => {}, ...extra }) as any;
  it("marks days with daily pages, database dates and countdown deadlines, and lists them when a day is chosen", async () => {
    db.list = [{ id: "db1", title: "Projects" }];
    db.data.db1 = { title: "Projects", properties: [{ id: "due", type: "date" }, { id: "n", type: "text" }], rows: [{ id: "r1", title: "Ship it", values: { due: today + "T10:00" } }, { id: "r2", title: "No date", values: {} }] };
    localStorage.setItem("nou-countdowns", JSON.stringify([{ id: "a", label: "Launch", start: today, end: today, unit: "day" }]));
    const open = vi.fn();
    render(<CalendarWidget ctx={ctx({ open })} />);
    const cell = screen.getByLabelText(new RegExp("^" + today));
    await waitFor(() => expect(cell.getAttribute("aria-label")).toBe(today + ", 3 items"));
    fireEvent.click(cell);
    const list = screen.getByLabelText("Items on " + today);
    expect(within(list).getByText(/Ship it/)).toBeTruthy();
    expect(within(list).getByText(/Launch/)).toBeTruthy();
    fireEvent.click(within(list).getByText("Daily page"));
    expect(open).toHaveBeenCalledWith("d1");
    expect(screen.queryByText("Plain")).toBeNull();
  });
  it("moves between months and back to today", () => {
    render(<CalendarWidget ctx={ctx()} />);
    const title = () => screen.getByRole("grid").getAttribute("aria-label")!;
    const first = title();
    fireEvent.click(screen.getByLabelText("Next month"));
    expect(title()).not.toBe(first);
    fireEvent.click(screen.getByLabelText("Previous month")); fireEvent.click(screen.getByLabelText("Previous month"));
    expect(title()).not.toBe(first);
    fireEvent.click(screen.getByText("Today"));
    expect(title()).toBe(first);
    expect(screen.getAllByRole("gridcell").length % 7).toBe(0);
  });
  it("copes with no databases and with a database that cannot be read", async () => {
    db.list = [{ id: "gone", title: "Gone" }];
    render(<CalendarWidget ctx={ctx()} />);
    await waitFor(() => expect(screen.getByLabelText(new RegExp("^" + today)).getAttribute("aria-label")).toBe(today + ", 1 item"));
  });
});

describe("flip tiles", () => {
  it("show the digit at once and flip only when it changes afterwards", () => {
    const { container, rerender } = render(<Flip value="4" />);
    const tile = () => container.querySelector(".flip")!;
    expect(tile().textContent).toBe("4");
    expect(tile().classList.contains("go")).toBe(false);
    rerender(<Flip value="4" />);
    expect(tile().classList.contains("go")).toBe(false);
    rerender(<Flip value="5" />);
    expect(tile().textContent).toBe("5");
    expect(tile().classList.contains("go")).toBe(true);
  });
  it("the clocks show four flip tiles each plus the shared seconds", () => {
    const { container } = render(<ClocksWidget />);
    expect(container.querySelectorAll(".clock").length).toBe(2);
    expect(container.querySelectorAll(".clock .flip").length).toBe(8);
    expect(container.querySelectorAll(".sec .flip.small").length).toBe(2);
    expect(container.querySelectorAll(".day-band i").length).toBe(2);
  });
});

describe("daily strip", () => {
  it("shows today's date, the streak from daily pages, and opens today's page", () => {
    const today = dayKey(new Date());
    const open = vi.fn();
    const ctx = { pages: [{ id: "d", title: today, parent_id: null, sort_key: "1", icon: "document" }], open: () => {}, today, openDaily: open, disabled: false, refresh: async () => {} } as any;
    const { container } = render(<DailyWidget ctx={ctx} />);
    expect(screen.getByLabelText(/Writing streak, last 14 days: 1 day in a row/)).toBeTruthy();
    expect(container.querySelectorAll(".streak-day").length).toBe(14);
    expect(container.querySelector(".streak-day.today.on")).toBeTruthy();
    fireEvent.click(screen.getByText("Open today's page"));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("today's tasks", () => {
  it("lists the linked to-dos with open ones first, ticks one through the normal command, and counts progress", async () => {
    todos.list = [{ id: "a", text: "Done thing", checked: true, pages: 1 }, { id: "b", text: "Call Sam", checked: false, pages: 2 }];
    render(<TasksWidget />);
    const items = await screen.findAllByRole("listitem");
    expect(items.map(i => i.textContent)).toEqual(["Call SamOn 2 pages", "Done thingOn 1 page"]);
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Call Sam"));
    await waitFor(() => expect(todos.calls).toContainEqual({ command: "linked_todo_set", args: { id: "b", checked: true, text: null } }));
    expect(screen.getByText("2/2")).toBeTruthy();
  });
  it("adds a task with Enter, and says when there are none", async () => {
    render(<TasksWidget />);
    expect(await screen.findByText(/No to-dos yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Add a task"), { target: { value: "Water plants" } });
    fireEvent.submit(screen.getByLabelText("Add a task").closest("form")!);
    expect(await screen.findByText("Water plants")).toBeTruthy();
    expect(todos.calls).toContainEqual({ command: "linked_todo_create", args: { text: "Water plants" } });
  });
  it("cannot be used while the app is busy", async () => {
    todos.list = [{ id: "b", text: "Call Sam", checked: false, pages: 0 }];
    render(<TasksWidget disabled />);
    expect(((await screen.findByLabelText("Call Sam")) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Add a task") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("teaching of the day", () => {
  it("explains how to start when there is no Teachings database", async () => {
    render(<TeachingWidget today="2026-11-18" />);
    expect(await screen.findByText(/make a database called Teachings/i)).toBeTruthy();
  });
  it("shows one teaching from the Teachings database with its theme and book, and the dots switch between five", async () => {
    db.list = [{ id: "t", title: "Teachings" }];
    db.data.t = { title: "Teachings", properties: [{ id: "th", name: "Theme", type: "select", options: [{ id: "o1", name: "Patience" }] }, { id: "bk", name: "Book", type: "text" }],
      rows: Array.from({ length: 8 }, (_, i) => ({ id: "r" + i, title: "Teaching number " + i, values: { th: "o1", bk: "Book " + i } })) };
    render(<TeachingWidget today="2026-11-18" />);
    expect(await screen.findByText(/Teaching number/)).toBeTruthy();
    expect(screen.getByText("Patience")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Teaching \d of 5/ }).length).toBe(5);
    const first = screen.getByText(/Teaching number/).textContent;
    fireEvent.click(screen.getByLabelText("Teaching 2 of 5"));
    expect(screen.getByText(/Teaching number/).textContent).not.toBe(first);
    expect(screen.getByText(/2 OF 5/)).toBeTruthy();
  });
});
