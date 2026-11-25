import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarWidget, ClocksWidget, CountdownWidget, DailyWidget, PeriodsWidget, SunArc, TasksWidget, TeachingWidget, WeatherWidget, type WeatherStore } from "./HomePanels";
import { Flip } from "./HomeBits";
import { dayKey } from "./timeLogic";

const { search, db, todos, hab } = vi.hoisted(() => ({ hab: { habits: [] as any[], log: [] as any[] }, search: { results: [] as any[], fail: "" }, db: { list: [] as any[], data: {} as Record<string, any> }, todos: { list: [] as any[], calls: [] as any[] } }));
vi.mock("./geocode", () => ({ searchPlaces: async () => { if (search.fail) throw new Error(search.fail); return search.results; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  if (command === "list_databases") return db.list;
  if (command === "get_database") return db.data[args.pageId] ?? null;
  if (command === "habits_list_cmd") return hab.habits;
  if (command === "habit_log_list_cmd") return hab.log;
  if (command === "linked_todo_list") return todos.list;
  if (command === "linked_todo_set") { todos.calls.push({ command, args }); return {}; }
  if (command === "linked_todo_reorder") { todos.calls.push({ command, args }); todos.list = [...args.ids.map((id: string) => todos.list.find(t => t.id === id)), ...todos.list.filter(t => !args.ids.includes(t.id))]; return null; }
  if (command === "linked_todo_create") { todos.calls.push({ command, args }); todos.list = [...todos.list, { id: "new", text: args.text, checked: false, pages: 0 }]; return todos.list[todos.list.length - 1]; }
} }));
beforeEach(() => { hab.habits = []; hab.log = []; todos.list = []; todos.calls.length = 0; localStorage.clear(); search.results = []; search.fail = ""; db.list = []; db.data = {}; });

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
    expect(document.querySelector(".cd-ring")).toBeNull(); // no ring or progress bar, just the day count
    expect(document.querySelector(".cd-num")!.textContent).toBe("2weeks3days"); // the unit word follows each number
    fireEvent.click(screen.getByRole("button", { name: "Settings for Exam" })); // the unit and Remove sit behind one settings button
    fireEvent.change(screen.getByLabelText("Show Exam in"), { target: { value: "day" } });
    expect(screen.getByText("17 days left")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("nou-countdowns")!)[0]).toMatchObject({ label: "Exam", unit: "day" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Exam" }));
    expect(screen.getByText(/Nothing counting down/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("nou-countdowns")!)).toEqual([]);
  });
  it("loads saved countdowns and ignores damaged ones", () => {
    localStorage.setItem("nou-countdowns", JSON.stringify([{ id: "a", label: "Trip", start: future(-10), end: future(10), unit: "month" }, { id: "b", label: "", start: "x", end: "y" }]));
    render(<CountdownWidget />);
    expect(document.querySelectorAll(".cd-num").length).toBe(1); // one countdown row (the damaged one is dropped)
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
  it("colours each past day's bubble by the share of habits done, and shows a progress bar for the selected day", async () => {
    const t = new Date(); const day = (n: number) => { const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const h = (id: string) => ({ id, name: id, days: 127, sort_order: 0, created_at: new Date(2020, 0, 1, 12).toISOString(), category: "Health" });
    hab.habits = [h("a"), h("b")]; hab.log = [{ day: day(0), habit_id: "a", state: "done", answered_at: null, source: "manual" }, { day: day(1), habit_id: "a", state: "done", answered_at: null, source: "manual" }, { day: day(1), habit_id: "b", state: "done", answered_at: null, source: "manual" }];
    render(<CalendarWidget ctx={ctx()} />);
    const cell = (n: number) => screen.getAllByRole("gridcell").find(c => c.getAttribute("aria-label")?.startsWith(day(n)))!;
    await waitFor(() => expect(cell(1).getAttribute("aria-label")).toMatch(/habits 2 of 2, 100%/));
    expect(cell(1).style.getPropertyValue("--hp")).toBe("100"); expect(cell(1).className).toMatch(/\bhp\b/);
    expect(cell(0).getAttribute("aria-label")).toMatch(/habits 1 of 2, 50%/); expect(cell(0).style.getPropertyValue("--hp")).toBe("50");
    const bar = screen.getByRole("progressbar", { name: "Share of habits done" }); expect(bar.getAttribute("aria-valuenow")).toBe("50"); // today is selected
    fireEvent.click(cell(1)); expect(screen.getByRole("progressbar", { name: "Share of habits done" }).getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("2/2 · 100%")).toBeTruthy();
    expect(cell(2).style.getPropertyValue("--hp")).toBe("0"); // a day with habits and none done is the low (red) end
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
    expect(items.map(i => i.textContent?.replace("⠿", ""))).toEqual(["Call SamOn 2 pages", "Done thingOn 1 page"]);
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Call Sam"));
    await waitFor(() => expect(todos.calls).toContainEqual({ command: "linked_todo_set", args: { id: "b", checked: true, text: null } }));
    expect(screen.getByText("2/2")).toBeTruthy();
  });
  it("puts the list in your order when a task is moved with its six dots (or the arrow keys), and keeps that order", async () => {
    todos.list = [{ id: "a", text: "First", checked: false, pages: 0 }, { id: "b", text: "Second", checked: false, pages: 0 }, { id: "c", text: "Third", checked: false, pages: 0 }];
    render(<TasksWidget />);
    await screen.findByText("First");
    fireEvent.keyDown(screen.getByLabelText(/Drag Third to reorder/), { key: "ArrowUp" });
    await waitFor(() => expect(todos.calls).toContainEqual({ command: "linked_todo_reorder", args: { ids: ["a", "c", "b"] } }));
    expect(screen.getAllByRole("listitem").map(i => i.textContent?.replace("⠿", ""))).toEqual(["First", "Third", "Second"]);
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

describe("the daylight arc", () => {
  const wx = (timezone: string) => ({ timezone, temp: 20, high: 24, low: 15, wind: 5, label: "Clear", code: 0 });
  const store = (): WeatherStore => ({
    places: [{ name: "London", lat: 51.5074, lng: -0.1278 }, { name: "Kuala Lumpur", lat: 3.139, lng: 101.6869 }],
    slots: [{ weather: wx("Europe/London") }, { weather: wx("Asia/Kuala_Lumpur") }], setPlace() {}, refresh() {},
  });
  it("starts on the first place and lets you choose which place it describes, and remembers the choice", () => {
    const view = render(<SunArc store={store()} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Daylight in (London|Kuala Lumpur)/);
    fireEvent.click(screen.getByRole("button", { name: "Choose where the daylight arc is for" }));
    const menu = screen.getByRole("group", { name: "Daylight arc place" });
    expect(within(menu).getAllByRole("radio").length).toBe(3); // where I am, London, Kuala Lumpur
    fireEvent.click(within(menu).getByRole("radio", { name: /^Kuala Lumpur/ }));
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Daylight in Kuala Lumpur: sunrise (06|07):/);
    expect(JSON.parse(localStorage.getItem("nou-sun-place")!)).toBe(1);
    expect(screen.queryByRole("group", { name: "Daylight arc place" })).toBeNull(); // the menu closes after a choice
    view.unmount();
    render(<SunArc store={store()} />); // a new mount keeps it
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Daylight in Kuala Lumpur/);
    fireEvent.click(screen.getByRole("button", { name: "Choose where the daylight arc is for" }));
    fireEvent.click(screen.getByRole("radio", { name: /^London/ }));
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Daylight in London/);
  });
  it("lets you search for a city that is not a weather place, such as Tokyo, and uses it", async () => {
    search.results = [{ name: "Tokyo", address: "Tokyo, Japan", lat: 35.6762, lng: 139.6503 }];
    const tokyoWeather = (async () => ({ ok: true, status: 200, json: async () => ({ timezone: "Asia/Tokyo", current: { temperature_2m: 12, weather_code: 0, wind_speed_10m: 3 }, daily: { temperature_2m_max: [15], temperature_2m_min: [8] } }) })) as unknown as typeof fetch;
    render(<SunArc store={store()} fetchImpl={tokyoWeather} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose where the daylight arc is for" }));
    const menu = screen.getByRole("group", { name: "Daylight arc place" });
    fireEvent.change(within(menu).getByRole("searchbox", { name: "Search for a place" }), { target: { value: "Tokyo" } });
    fireEvent.keyDown(within(menu).getByRole("searchbox", { name: "Search for a place" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Tokyo/ }));
    await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Daylight in Tokyo: sunrise 0[56]:/));
    expect(JSON.parse(localStorage.getItem("nou-sun-place")!)).toBe(2);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("nou-sun-custom")!).timezone).toBe("Asia/Tokyo")); // learned from the weather service
    fireEvent.click(screen.getByRole("button", { name: "Choose where the daylight arc is for" }));
    expect((screen.getByRole("radio", { name: /^Tokyo/ }) as HTMLInputElement).checked).toBe(true);
  });
  it("says so when none of the places is in the device's time zone", () => {
    const s = store(); s.slots = [{ weather: wx("Europe/London") }, { weather: wx("Europe/London") }];
    render(<SunArc store={s} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose where the daylight arc is for" }));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone === "Europe/London") expect(screen.queryByText(/None of these is in/)).toBeNull(); else expect(screen.getByText(/None of these is in/)).toBeTruthy();
  });
  it("closes with Escape, and a chosen place that was removed falls back", () => {
    localStorage.setItem("nou-sun-place", "1");
    const s = store(); s.places[1] = null; s.slots[1] = {};
    render(<SunArc store={s} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Daylight in London/);
    fireEvent.click(screen.getByRole("button", { name: "Choose where the daylight arc is for" }));
    expect(screen.getAllByRole("radio").length).toBe(2); // no entry for the empty place
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Daylight arc place" })).toBeNull();
  });
});

describe("compact widgets", () => {
  it("a countdown shows only its title; the time left stays for screen readers, and the settings button holds the unit and Remove", () => {
    const inDays = (n: number) => dayKey(new Date(Date.now() + n * 86400000));
    localStorage.setItem("nou-countdowns", JSON.stringify([{ id: "a", label: "Christmas", start: inDays(-10), end: inDays(10), unit: "day" }]));
    render(<CountdownWidget />);
    const row = screen.getByText("Christmas").closest("li")!;
    expect(row.querySelector(".cd-text strong")!.textContent).toBe("Christmas");
    expect(row.querySelectorAll(".cd-text .sr-only").length).toBe(2); // "10 days left" and "Ends ..." are hidden visually
    expect(row.querySelector("select")).toBeNull(); expect(screen.queryByRole("button", { name: "Remove Christmas" })).toBeNull();
    const gear = screen.getByRole("button", { name: "Settings for Christmas" });
    fireEvent.click(gear); expect(gear.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Show Christmas in")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Show Christmas in")).toBeNull();
  });
  it("the seconds bar fills, then flashes out once at the top of the minute instead of sliding back", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 21, 7, 2, 58));
      const { container } = render(<ClocksWidget />);
      const bar = () => container.querySelector(".sec-line i") as HTMLElement;
      expect(bar().style.width).toMatch(/^96\.6/); expect(bar().className).toBe("");
      act(() => { vi.advanceTimersByTime(1000); }); // 07:02:59
      expect(parseFloat(bar().style.width)).toBeGreaterThan(98);
      act(() => { vi.advanceTimersByTime(1000); }); // 07:03:00 - the counter wraps
      expect(bar().className).toBe("flash"); expect(bar().style.width).toBe("100%");
      act(() => { vi.advanceTimersByTime(1000); }); // 07:03:01 - a new bar starts from the beginning
      expect(bar().className).toBe(""); expect(parseFloat(bar().style.width)).toBeLessThan(2);
    } finally { vi.useRealTimers(); }
  });
});

describe("the sun is the settings button", () => {
  const wx = (timezone: string) => ({ timezone, temp: 20, high: 24, low: 15, wind: 5, label: "Clear", code: 0 });
  const st = (): WeatherStore => ({ places: [{ name: "London", lat: 51.5074, lng: -0.1278 }, null], slots: [{ weather: wx("Europe/London") }, {}], setPlace() {}, refresh() {} });
  it("is a plain dot that names the time zone beside itself on hover and opens the menu on click", () => {
    const { container } = render(<SunArc store={st()} />);
    expect(container.querySelectorAll(".sun-pick").length).toBe(0); expect(container.querySelector("circle.sun-dot")).toBeNull();
    const dot = screen.getByRole("button", { name: "Choose where the daylight arc is for" });
    expect(dot.className).toContain("sun-dot-btn"); expect(dot.textContent).toBe(""); // a plain dot
    expect(dot.parentElement!.querySelector(".sun-zone")!.textContent).toBe("Europe/London"); // the label beside it appears on hover or focus
    expect(dot.getAttribute("title")).toBe("Daylight for London · Europe/London");
    const anchor = dot.parentElement as HTMLElement;
    expect(anchor.style.left).not.toBe(""); expect(anchor.style.top).not.toBe(""); // it sits on the sun's position on the arc
    expect(anchor.className).toMatch(/to-(left|right)/);
    fireEvent.click(dot);
    expect(screen.getByRole("group", { name: "Daylight arc place" }).className).toMatch(/sun-menu to-(left|right)/);
  });
});
