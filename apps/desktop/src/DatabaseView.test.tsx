import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "./DatabaseView";
import { EditorFeatures } from "./EditorContext";

const { calls, view } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], view: { current: null as any } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "get_database" && args.pageId === "db2") return { title: "Tasks", properties: [{ id: "eff", name: "Effort", type: "number", options: [] }, { id: "stat", name: "Stage", type: "status", options: [] }], rows: [], views: [], linked: {} };
  if (command === "get_database") return view.current;
  if (command === "add_row") return { id: "new-row", title: "Untitled", values: {} };
  if (command === "load_note") return { updates: [] };
  if (command === "list_databases") return [{ id: "db", title: "Projects" }, { id: "db2", title: "Tasks" }];
  if (command === "list_rows") return [{ id: "t1", title: "Write" }, { id: "t2", title: "Ship" }];
  if (command === "add_relation") return { id: "rel-new", name: args.name, type: "relation", options: [], config: { target: args.targetId, reverse: null } };
  if (command === "add_rollup") return { id: "roll-new", name: args.name, type: "rollup", options: [], config: {} };
  if (command === "add_property") return { id: "new-prop", name: args.name, type: args.kind, options: [] };
  if (command === "add_view") return { id: "v-new", name: args.name, type: args.kind, config: args.config };
} }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));
const { search } = vi.hoisted(() => ({ search: { calls: [] as string[], results: [{ name: "Tokyo Station", address: "Tokyo Station, Chiyoda, Tokyo, Japan", lat: 35.6812, lng: 139.7671 }] as any[] } }));
vi.mock("./geocode", () => ({ searchPlaces: async (q: string) => { search.calls.push(q); return search.results; } }));
vi.mock("./NoteEditor", () => ({ default: ({ pageId, onStatus }: { pageId: string; onStatus: (s: string) => void }) => <div><span data-testid="note">{pageId}</span><button onClick={() => onStatus("saving")}>make busy</button><button onClick={() => onStatus("saved")}>make saved</button></div> }));

const base = () => ({
  title: "Projects",
  properties: [
    { id: "done", name: "Finished", type: "checkbox", options: [] },
    { id: "hours", name: "Hours", type: "number", options: [] },
    { id: "state", name: "State", type: "status", options: [{ id: "o1", name: "Not started", color: "gray" }, { id: "o2", name: "Shipped", color: "green" }] },
    { id: "due", name: "Due", type: "date", options: [] },
    { id: "where", name: "Where", type: "place", options: [] },
  ],
  rows: [{ id: "r1", title: "Write ADR", values: { hours: 3, state: "o1", due: "2026-11-10", where: { lat: 35.68, lng: 139.69, name: "Tokyo" } } }, { id: "r2", title: "Loose end", values: {} }],
  views: [{ id: "v1", name: "Table", type: "table", config: {} }],
});
const show = (readOnly = false) => render(<Database databaseId="db" readOnly={readOnly} onError={() => {}} />);
const withView = (type: string, config: object) => { view.current = { ...base(), views: [{ id: "v1", name: "View", type, config }] }; };
beforeEach(() => { calls.length = 0; search.calls.length = 0; view.current = base(); });

describe("Database", () => {
  it("shows the title and typed cells and saves a checkbox through set_value", async () => {
    show();
    expect(await screen.findByDisplayValue("Projects")).toBeTruthy();
    expect(screen.getByDisplayValue("Write ADR")).toBeTruthy();
    expect(screen.getByDisplayValue("3")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Finished")[0]);
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r1", propertyId: "done", value: true } }));
  });
  it("picks a status option and adds a row", async () => {
    show();
    await screen.findByDisplayValue("Write ADR");
    fireEvent.click(within(screen.getAllByRole("listbox", { name: "State" })[0]).getByText("Shipped"));
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r1", propertyId: "state", value: "o2" } }));
    fireEvent.click(screen.getByText("+ New row"));
    await waitFor(() => expect(calls.some(c => c.command === "add_row" && c.args.databaseId === "db")).toBe(true));
  });
  it("opens a row's page in the side panel", async () => {
    show();
    fireEvent.click(await screen.findByLabelText("Open Write ADR"));
    expect((await screen.findByTestId("note")).textContent).toBe("r1");
  });
  it("cannot edit while the profile is read-only", async () => {
    show(true);
    await screen.findByDisplayValue("Write ADR");
    expect((screen.getAllByLabelText("Finished")[0] as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText("+ New row") as HTMLButtonElement).disabled).toBe(true);
  });
  it("board groups rows by status and moving a card writes the new value", async () => {
    withView("board", { groupBy: "state" }); show();
    const column = await screen.findByLabelText("Shipped");
    const card = screen.getByText("Write ADR").closest("article")!;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => {}, getData: () => "r1" } });
    fireEvent.drop(column, { dataTransfer: { getData: () => "r1" } });
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r1", propertyId: "state", value: "o2" } }));
    expect(within(screen.getByLabelText("No State")).getByText("Loose end")).toBeTruthy();
  });
  it("calendar places a dated row on its day and adds a row for a day", async () => {
    withView("calendar", { dateBy: "due" }); show();
    const day = await screen.findByLabelText("2026-11-10").catch(() => null);
    // The calendar opens on the current month; jump back to the data's month by navigating until the cell exists.
    if (!day) { const now = new Date(); const months = (now.getFullYear() - 2026) * 12 + now.getMonth() - 10; for (let i = 0; i < months; i++) fireEvent.click(screen.getByLabelText("Previous month")); }
    const cell = await screen.findByLabelText("2026-11-10");
    expect(within(cell).getByText("Write ADR")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Add a row on 2026-11-12"));
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "new-row", propertyId: "due", value: "2026-11-12" } }));
  });
  it("timeline shows dated rows as bars and lists undated rows separately", async () => {
    withView("timeline", { dateBy: "due" }); show();
    expect((await screen.findAllByText("Write ADR")).length).toBeGreaterThan(0);
    expect(screen.getByText("No date (1)")).toBeTruthy();
  });
  it("calendar with no setting uses the database's first Date property", async () => {
    withView("calendar", {}); show();
    expect((await screen.findAllByRole("gridcell")).length).toBeGreaterThan(27);
    expect(screen.queryByText(/Choose a Date property/)).toBeNull();
  });
  it("asks for a Date property only when the database has none", async () => {
    view.current = { ...base(), properties: base().properties.filter(p => p.type !== "date"), views: [{ id: "v1", name: "Calendar", type: "calendar", config: {} }] };
    show();
    expect((await screen.findByText(/Choose a Date property/)).textContent).toBeTruthy();
  });
  it("adding a Calendar view to a database without a date column creates the Date column first", async () => {
    view.current = { ...base(), properties: base().properties.filter(p => p.type !== "date"), views: [{ id: "v1", name: "Table", type: "table", config: {} }] };
    show();
    await screen.findByDisplayValue("Projects");
    fireEvent.click(screen.getByText("Calendar"));
    await waitFor(() => expect(calls.some(c => c.command === "add_property" && c.args.kind === "date" && c.args.name === "Date")).toBe(true));
    await waitFor(() => expect(calls.some(c => c.command === "add_view" && c.args.kind === "calendar")).toBe(true));
  });
  it("adds a view of the chosen type with sensible default settings", async () => {
    show();
    await screen.findByDisplayValue("Projects");
    fireEvent.click(screen.getByText("Board"));
    await waitFor(() => expect(calls).toContainEqual({ command: "add_view", args: { databaseId: "db", name: "Board", kind: "board", config: { groupBy: "state" } } }));
  });
  it("map plots rows with a place as pins and lists rows without one", async () => {
    withView("map", { placeBy: "where" }); show();
    const pin = await screen.findByRole("button", { name: "Write ADR at 35.68, 139.69" });
    expect(pin).toBeTruthy();
    expect(screen.getByText("No place (1)")).toBeTruthy();
    fireEvent.click(pin);
    expect((await screen.findByTestId("note")).textContent).toBe("r1");
  });
  it("place cells accept 'lat, lng, name' and reject nonsense without writing", async () => {
    const errors: unknown[] = [];
    render(<Database databaseId="db" readOnly={false} onError={e => errors.push(e)} />);
    const cells = await screen.findAllByLabelText("Where");
    const empty = cells[1] as HTMLInputElement;
    fireEvent.change(empty, { target: { value: "91, 10" } }); fireEvent.blur(empty);
    await waitFor(() => expect(errors.length).toBe(1));
    expect(calls.some(c => c.command === "set_value" && c.args.propertyId === "where")).toBe(false);
    fireEvent.change(empty, { target: { value: "48.8566, 2.3522, Paris" } }); fireEvent.blur(empty);
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r2", propertyId: "where", value: { lat: 48.8566, lng: 2.3522, name: "Paris" } } }));
  });
  it("map asks for a Place property only when the database has none", async () => {
    view.current = { ...base(), properties: base().properties.filter(p => p.type !== "place"), views: [{ id: "v1", name: "Map", type: "map", config: {} }] };
    show();
    expect((await screen.findByText(/Choose a Place property/)).textContent).toBeTruthy();
  });
  const menuItem = async (column: string, label: string | RegExp) => {
    await screen.findByDisplayValue("Projects");
    const summary = screen.getAllByLabelText("Column " + column)[0];
    fireEvent.click(summary);
    fireEvent.click(within(summary.parentElement!).getByText(label));
  };
  it("column menu: insert right asks the server to add a property beside this one", async () => {
    show(); await menuItem("Hours", "Insert right");
    await waitFor(() => expect(calls).toContainEqual({ command: "add_property", args: { databaseId: "db", name: "Property", kind: "text", near: "hours", side: "right" } }));
  });
  it("column menu: duplicate and change type go to the server", async () => {
    show(); await menuItem("Hours", "Duplicate property");
    await waitFor(() => expect(calls).toContainEqual({ command: "duplicate_property", args: { propertyId: "hours" } }));
    calls.length = 0; await menuItem("Hours", "Change type");
    fireEvent.click(screen.getAllByText("Text").find(el => el.closest(".db-column-menu") !== null)!);
    await waitFor(() => expect(calls).toContainEqual({ command: "change_property_type", args: { propertyId: "hours", kind: "text" } }));
  });
  it("column menu: sort, hide and freeze save one complete view config", async () => {
    show(); await menuItem("Hours", "Sort");
    fireEvent.click(screen.getAllByText("Descending")[0]);
    await waitFor(() => expect(calls).toContainEqual({ command: "update_view", args: { viewId: "v1", config: { sorts: [{ p: "hours", dir: "desc" }] } } }));
    calls.length = 0; await menuItem("Hours", "Freeze up to here");
    await waitFor(() => expect(calls).toContainEqual({ command: "update_view", args: { viewId: "v1", config: { frozen: "hours" } } }));
    calls.length = 0; await menuItem("Hours", "Hide");
    await waitFor(() => expect(calls).toContainEqual({ command: "update_view", args: { viewId: "v1", config: { hidden: ["hours"] } } }));
  });
  it("a saved filter hides rows, shows a chip, and removing it saves the config", async () => {
    view.current = { ...base(), views: [{ id: "v1", name: "Table", type: "table", config: { filters: [{ p: "state", op: "is", v: "o1" }] } }] };
    show();
    await screen.findByDisplayValue("Write ADR");
    expect(screen.queryByDisplayValue("Loose end")).toBeNull();
    expect(screen.getByText("1 row shown")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove filter on State"));
    await waitFor(() => expect(calls).toContainEqual({ command: "update_view", args: { viewId: "v1", config: {} } }));
  });
  it("hidden columns disappear from the table and can be shown again", async () => {
    view.current = { ...base(), views: [{ id: "v1", name: "Table", type: "table", config: { hidden: ["hours"] } }] };
    show();
    await screen.findByDisplayValue("Write ADR");
    expect(screen.queryByLabelText("Column Hours")).toBeNull();
    fireEvent.click(screen.getByText("Show all"));
    await waitFor(() => expect(calls).toContainEqual({ command: "update_view", args: { viewId: "v1", config: {} } }));
  });
  it("calculate shows the result under the column", async () => {
    view.current = { ...base(), views: [{ id: "v1", name: "Table", type: "table", config: { calc: { hours: "sum" } } }] };
    show();
    await screen.findByDisplayValue("Write ADR");
    expect(document.querySelector(".db-calc-value")!.textContent).toContain("3");
  });
  it("grouping a table by status shows group headers with counts", async () => {
    view.current = { ...base(), views: [{ id: "v1", name: "Table", type: "table", config: { groupBy: "state" } }] };
    show();
    await screen.findByDisplayValue("Write ADR");
    expect(screen.getAllByRole("button", { expanded: true }).some(b => b.textContent?.includes("Not started"))).toBe(true);
  });
  it("search narrows the rows in every view", async () => {
    show();
    await screen.findByDisplayValue("Write ADR");
    fireEvent.change(screen.getByLabelText("Search rows"), { target: { value: "loose" } });
    expect(screen.queryByDisplayValue("Write ADR")).toBeNull();
    expect(screen.getByDisplayValue("Loose end")).toBeTruthy();
    expect(screen.getByText("1 row shown")).toBeTruthy();
  });
  it("two filters show a match-mode switch that saves 'or'", async () => {
    view.current = { ...base(), views: [{ id: "v1", name: "Table", type: "table", config: { filters: [{ p: "state", op: "is", v: "o1" }, { p: "hours", op: "gt", v: 100 }] } }] };
    show();
    await screen.findByLabelText("Filter match mode");
    expect(screen.queryByDisplayValue("Write ADR")).toBeNull(); // "and": nothing satisfies both
    fireEvent.change(screen.getByLabelText("Filter match mode"), { target: { value: "or" } });
    await waitFor(() => expect(calls.some(c => c.command === "update_view" && c.args.config.filterMode === "or")).toBe(true));
  });
  it("row menu duplicates a row's values and page body", async () => {
    show();
    await screen.findByDisplayValue("Write ADR");
    fireEvent.click(screen.getByLabelText("Row options for Write ADR"));
    fireEvent.click(within(screen.getByLabelText("Row options for Write ADR").parentElement!).getByText("Duplicate"));
    await waitFor(() => expect(calls.some(c => c.command === "set_value" && c.args.rowId === "new-row" && c.args.propertyId === "hours" && c.args.value === 3)).toBe(true));
    expect(calls.some(c => c.command === "load_note" && c.args.pageId === "r1")).toBe(true);
    expect(calls.some(c => c.command === "rename_page" && c.args.pageId === "new-row" && c.args.title === "Write ADR")).toBe(true);
  });
  it("edits select options: rename, recolour and delete", async () => {
    show();
    await screen.findByDisplayValue("Write ADR");
    fireEvent.click(screen.getAllByLabelText("Column State")[0]);
    const menu = screen.getAllByLabelText("Column State")[0].parentElement!;
    fireEvent.click(within(menu).getByText("Edit options"));
    fireEvent.change(within(menu).getByLabelText("Colour of Shipped"), { target: { value: "purple" } });
    await waitFor(() => expect(calls).toContainEqual({ command: "update_select_option", args: { optionId: "o2", color: "purple" } }));
    const name = within(menu).getByLabelText("Name of option Shipped");
    fireEvent.change(name, { target: { value: "Launched" } }); fireEvent.blur(name);
    await waitFor(() => expect(calls).toContainEqual({ command: "update_select_option", args: { optionId: "o2", name: "Launched" } }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(menu).getByLabelText("Delete option Shipped"));
    await waitFor(() => expect(calls).toContainEqual({ command: "delete_select_option", args: { optionId: "o2" } }));
  });
  it("shows the new property types with their glyph and fills automatic columns in read-only", async () => {
    view.current = { ...base(), properties: [...base().properties, { id: "made", name: "Created", type: "created_time", options: [] }, { id: "mail", name: "Mail", type: "email", options: [] }],
      rows: [{ id: "r1", title: "Write ADR", values: { made: "2026-11-09T20:30:00.000Z", mail: "ann@example.com" } }], views: [{ id: "v1", name: "Table", type: "table", config: {} }] };
    show();
    await screen.findByDisplayValue("Write ADR");
    expect(screen.getByDisplayValue("ann@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Created").getAttribute("title")).toBe("Filled in automatically");
    expect(screen.getByLabelText("Column Created").textContent).toContain("◷");
  });
  const withRelation = (extra: object = {}) => ({
    ...base(), properties: [...base().properties, { id: "rel", name: "Tasks", type: "relation", options: [], config: { target: "db2", reverse: "back" } }, ...(extra as any).properties ?? []],
    rows: [{ id: "r1", title: "Write ADR", values: { rel: ["t1"], ...((extra as any).values ?? {}) } }, { id: "r2", title: "Loose end", values: {} }],
    linked: { t1: "Write", t2: "Ship" }, views: [{ id: "v1", name: "Table", type: "table", config: {} }],
  });
  it("relation cells show the linked page titles and the picker saves the chosen page ids", async () => {
    view.current = withRelation(); show();
    await screen.findByDisplayValue("Write ADR");
    expect(within(screen.getAllByLabelText("Tasks")[0]).getByText("Write")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Tasks")[0]);
    const picker = await screen.findByRole("group", { name: "Linked pages" });
    fireEvent.click(await within(picker).findByLabelText("Ship"));
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r1", propertyId: "rel", value: ["t1", "t2"] } }));
    expect(calls).toContainEqual({ command: "list_rows", args: { databaseId: "db2" } });
  });
  it("rollup cells are read-only and show the calculated text", async () => {
    view.current = withRelation({ properties: [{ id: "sum", name: "Total effort", type: "rollup", options: [], config: { relation: "rel", property: "eff", fn: "sum" } }], values: { sum: "16" } }); show();
    await screen.findByDisplayValue("Write ADR");
    const cell = screen.getAllByLabelText("Total effort")[0];
    expect(cell.textContent).toBe("16");
    expect(cell.getAttribute("title")).toBe("Calculated from linked rows");
  });
  it("adding a relation column asks for the related database and whether it is two-way", async () => {
    show();
    await screen.findByDisplayValue("Projects");
    fireEvent.click(screen.getByLabelText("Add a property"));
    const menu = screen.getByLabelText("Add a property").parentElement!;
    fireEvent.change(within(menu).getByLabelText("Property name"), { target: { value: "Tasks" } });
    fireEvent.change(within(menu).getByLabelText("Property type"), { target: { value: "relation" } });
    await waitFor(() => expect((within(menu).getByLabelText("Related database") as HTMLSelectElement).value).toBe("db2"));
    fireEvent.click(within(menu).getByText("Add property"));
    await waitFor(() => expect(calls).toContainEqual({ command: "add_relation", args: { databaseId: "db", name: "Tasks", targetId: "db2", twoWay: true } }));
  });
  it("adding a rollup picks a relation, a property of the related database and a calculation", async () => {
    view.current = withRelation(); show();
    await screen.findByDisplayValue("Write ADR");
    fireEvent.click(screen.getByLabelText("Add a property"));
    const menu = screen.getByLabelText("Add a property").parentElement!;
    fireEvent.change(within(menu).getByLabelText("Property name"), { target: { value: "Effort sum" } });
    fireEvent.change(within(menu).getByLabelText("Property type"), { target: { value: "rollup" } });
    await waitFor(() => expect(within(menu).getByLabelText("Property to roll up").textContent).toContain("Effort"));
    fireEvent.change(within(menu).getByLabelText("Property to roll up"), { target: { value: "eff" } });
    fireEvent.change(within(menu).getByLabelText("Calculation"), { target: { value: "sum" } });
    fireEvent.click(within(menu).getByText("Add property"));
    await waitFor(() => expect(calls).toContainEqual({ command: "add_rollup", args: { databaseId: "db", name: "Effort sum", relationId: "rel", property: "eff", function: "sum" } }));
  });
  it("a rollup needs a relation column first", async () => {
    show();
    await screen.findByDisplayValue("Projects");
    fireEvent.click(screen.getByLabelText("Add a property"));
    const menu = screen.getByLabelText("Add a property").parentElement!;
    fireEvent.change(within(menu).getByLabelText("Property type"), { target: { value: "rollup" } });
    expect(within(menu).getByText(/Add a relation column first/)).toBeTruthy();
  });
  it("duplicating a row copies its relation links but not rollups", async () => {
    view.current = withRelation({ properties: [{ id: "sum", name: "Total", type: "rollup", options: [], config: {} }], values: { sum: "3" } }); show();
    await screen.findByDisplayValue("Write ADR");
    fireEvent.click(screen.getByLabelText("Row options for Write ADR"));
    fireEvent.click(within(screen.getByLabelText("Row options for Write ADR").parentElement!).getByText("Duplicate"));
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "new-row", propertyId: "rel", value: ["t1"] } }));
    expect(calls.some(c => c.command === "set_value" && c.args.propertyId === "sum")).toBe(false);
  });
  it("the row panel tells the app while it is saving, and cannot be closed until it is saved", async () => {
    const busy: boolean[] = [];
    render(<EditorFeatures.Provider value={{ pages: [], theme: "light", canNavigate: true, open: () => {}, create: async () => { throw Error("n/a"); }, upload: async () => null, uploadFile: async () => { throw Error("n/a"); }, onError: () => {}, setPeekBusy: b => busy.push(b) }}>
      <Database databaseId="db" readOnly={false} onError={() => {}} /></EditorFeatures.Provider>);
    fireEvent.click(await screen.findByLabelText("Open Write ADR"));
    fireEvent.click(await screen.findByText("make busy"));
    await waitFor(() => expect(busy[busy.length - 1]).toBe(true));
    expect((screen.getByText("Close") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("make saved"));
    await waitFor(() => expect(busy[busy.length - 1]).toBe(false));
    expect((screen.getByText("Close") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a new empty table is just the header and + New row: no 'No rows' message and no empty calculation row", async () => {
    view.current = { ...base(), rows: [], views: [{ id: "v1", name: "Table", type: "table", config: {} }] };
    const { container } = show();
    await screen.findByDisplayValue("Projects");
    expect(screen.queryByText(/No rows/)).toBeNull();
    expect(container.querySelector("tfoot")).toBeNull();
    expect(screen.getByText("+ New row")).toBeTruthy();
  });
  it("a configured calculation still shows its row", async () => {
    view.current = { ...base(), views: [{ id: "v1", name: "Table", type: "table", config: { calc: { hours: "sum" } } }] };
    const { container } = show();
    await screen.findByDisplayValue("Write ADR");
    expect(container.querySelector("tfoot")).toBeTruthy();
  });

  describe("row page", () => {
    const openRow = async () => { show(); fireEvent.click(await screen.findByLabelText("Open Write ADR")); return await screen.findByRole("dialog", { name: "Page Write ADR" }); };
    it("opens as a page with an editable title, every property as a field, and the body", async () => {
      const dialog = await openRow();
      expect((within(dialog).getByLabelText("Page title") as HTMLInputElement).value).toBe("Write ADR");
      const props = within(dialog).getByLabelText("Properties");
      for (const name of ["Finished", "Hours", "State", "Due", "Where"]) expect(within(props).getByText(name)).toBeTruthy();
      expect(within(dialog).getByTestId("note").textContent).toBe("r1");
    });
    it("renaming the page and changing a property save through the normal commands", async () => {
      const dialog = await openRow();
      const title = within(dialog).getByLabelText("Page title");
      fireEvent.change(title, { target: { value: "Write the ADR" } }); fireEvent.blur(title);
      await waitFor(() => expect(calls).toContainEqual({ command: "rename_page", args: { pageId: "r1", title: "Write the ADR" } }));
      const hours = within(within(dialog).getByLabelText("Properties")).getByLabelText("Hours");
      fireEvent.change(hours, { target: { value: "8" } }); fireEvent.blur(hours);
      await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r1", propertyId: "hours", value: 8 } }));
    });
    it("can expand to full width and shrink back", async () => {
      const dialog = await openRow();
      expect(dialog.classList.contains("wide")).toBe(false);
      fireEvent.click(within(dialog).getByText("Expand"));
      expect(dialog.classList.contains("wide")).toBe(true);
      fireEvent.click(within(dialog).getByText("Shrink"));
      expect(dialog.classList.contains("wide")).toBe(false);
    });
    it("is read-only when the profile is", async () => {
      show(true);
      fireEvent.click(await screen.findByLabelText("Open Write ADR"));
      const dialog = await screen.findByRole("dialog", { name: "Page Write ADR" });
      expect((within(dialog).getByLabelText("Page title") as HTMLInputElement).readOnly).toBe(true);
      expect((within(within(dialog).getByLabelText("Properties")).getByLabelText("Finished") as HTMLInputElement).disabled).toBe(true);
    });
    it("a board card opens the same full page", async () => {
      withView("board", { groupBy: "state" }); show();
      fireEvent.click((await screen.findByText("Write ADR")).closest("article")!);
      expect(await screen.findByRole("dialog", { name: "Page Write ADR" })).toBeTruthy();
    });
  });

  describe("row handles", () => {
    const row = (title: string) => screen.getByLabelText("Title of " + title).closest("tr") as HTMLElement;
    const drag = (data: Record<string, string> = {}) => ({ dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, getData: (k: string) => data[k] ?? "", effectAllowed: "" } });
    it("+ adds a row directly below the one it belongs to", async () => {
      show();
      fireEvent.click(await screen.findByLabelText("Add a row below Write ADR"));
      await waitFor(() => expect(calls).toContainEqual({ command: "relocate_page", args: { pageId: "new-row", parentId: "db", beforeId: "r2" } }));
      expect(calls.some(c => c.command === "add_row")).toBe(true);
    });
    it("+ on the last row just adds a row at the end", async () => {
      show();
      fireEvent.click(await screen.findByLabelText("Add a row below Loose end"));
      await waitFor(() => expect(calls.some(c => c.command === "add_row")).toBe(true));
      expect(calls.some(c => c.command === "relocate_page")).toBe(false);
    });
    it("dragging a row's grip onto another row moves it before that row", async () => {
      show();
      await screen.findByDisplayValue("Write ADR");
      const payload: Record<string, string> = {};
      fireEvent.dragStart(screen.getByLabelText("Drag Write ADR to reorder"), drag(payload));
      expect(payload["application/x-nou-row"]).toBe("r1");
      fireEvent.dragOver(row("Loose end"), drag(payload));
      expect(row("Loose end").className).toContain("db-drop-target");
      fireEvent.drop(row("Loose end"), drag(payload));
      await waitFor(() => expect(calls).toContainEqual({ command: "relocate_page", args: { pageId: "r1", parentId: "db", beforeId: "r2" } }));
    });
    it("dropping on 'Move to the end' puts the row last", async () => {
      show();
      await screen.findByDisplayValue("Write ADR");
      const payload: Record<string, string> = {};
      fireEvent.dragStart(screen.getByLabelText("Drag Write ADR to reorder"), drag(payload));
      fireEvent.drop(await screen.findByText("Move to the end"), drag(payload));
      await waitFor(() => expect(calls).toContainEqual({ command: "relocate_page", args: { pageId: "r1", parentId: "db", beforeId: null } }));
    });
    it("dropping a row on itself does nothing", async () => {
      show();
      await screen.findByDisplayValue("Write ADR");
      const payload: Record<string, string> = {};
      fireEvent.dragStart(screen.getByLabelText("Drag Write ADR to reorder"), drag(payload));
      fireEvent.drop(row("Write ADR"), drag(payload));
      expect(calls.some(c => c.command === "relocate_page")).toBe(false);
    });
    it("reordering is switched off while the view is sorted or grouped, and when read-only", async () => {
      view.current = { ...base(), views: [{ id: "v1", name: "Table", type: "table", config: { sorts: [{ p: "hours", dir: "asc" }] } }] };
      const first = show();
      expect((await screen.findByLabelText("Drag Write ADR to reorder") as HTMLButtonElement).disabled).toBe(true);
      first.unmount();
      view.current = base();
      show(true);
      expect((await screen.findByLabelText("Drag Write ADR to reorder") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText("Add a row below Write ADR") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("place search", () => {
    it("typing coordinates saves them without contacting any search service", async () => {
      show();
      const cells = await screen.findAllByLabelText("Where", {}, { timeout: 5000 });
      const empty = cells[1] as HTMLInputElement;
      fireEvent.change(empty, { target: { value: "48.8566, 2.3522" } });
      fireEvent.keyDown(empty, { key: "Enter" });
      await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r2", propertyId: "where", value: { lat: 48.8566, lng: 2.3522 } } }), { timeout: 5000 });
      expect(search.calls).toEqual([]);
    });
    it("a name or address is only looked up when Enter is pressed, then a chosen result is saved with its address", async () => {
      show();
      const empty = (await screen.findAllByLabelText("Where"))[1] as HTMLInputElement;
      fireEvent.change(empty, { target: { value: "Tokyo Station" } });
      expect(screen.getByText("Enter: search online")).toBeTruthy();
      expect(search.calls).toEqual([]);
      fireEvent.blur(empty);
      expect(search.calls).toEqual([]);
      fireEvent.change(empty, { target: { value: "Tokyo Station" } });
      fireEvent.keyDown(empty, { key: "Enter" });
      const results = await screen.findByRole("listbox", { name: "Place results" }, { timeout: 5000 });
      expect(search.calls).toEqual(["Tokyo Station"]);
      expect(within(results).getByText(/sent to nominatim.openstreetmap.org/)).toBeTruthy();
      fireEvent.click(await within(results).findByText("Tokyo Station", {}, { timeout: 5000 }));
      await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r2", propertyId: "where", value: { lat: 35.6812, lng: 139.7671, name: "Tokyo Station", address: "Tokyo Station, Chiyoda, Tokyo, Japan" } } }));
    });
    it("out-of-range numbers are reported, never searched or saved", async () => {
      const errors: unknown[] = [];
      render(<Database databaseId="db" readOnly={false} onError={e => errors.push(e)} />);
      const empty = (await screen.findAllByLabelText("Where"))[1] as HTMLInputElement;
      fireEvent.change(empty, { target: { value: "91, 10" } });
      fireEvent.keyDown(empty, { key: "Enter" });
      await waitFor(() => expect(errors.length).toBe(1));
      expect(search.calls).toEqual([]);
      expect(calls.some(c => c.command === "set_value" && c.args.propertyId === "where")).toBe(false);
    });
    it("shows 'no places found' and keeps the cell unchanged when nothing matches", async () => {
      search.results = [];
      show();
      const empty = (await screen.findAllByLabelText("Where"))[1] as HTMLInputElement;
      fireEvent.change(empty, { target: { value: "zzzzqq" } });
      fireEvent.keyDown(empty, { key: "Enter" });
      expect(await screen.findByText(/No places found/, {}, { timeout: 5000 })).toBeTruthy();
      expect(calls.some(c => c.command === "set_value" && c.args.propertyId === "where")).toBe(false);
      search.results = [{ name: "Tokyo Station", address: "Tokyo Station, Chiyoda, Tokyo, Japan", lat: 35.6812, lng: 139.7671 }];
    });
    it("a saved place shows its name, with the coordinates and address in the tooltip", async () => {
      view.current = { ...base(), rows: [{ id: "r1", title: "Trip", values: { where: { lat: 35.6812, lng: 139.7671, name: "Tokyo Station", address: "Tokyo Station, Chiyoda, Tokyo, Japan" } } }] };
      show();
      const cell = (await screen.findAllByLabelText("Where"))[0] as HTMLInputElement;
      expect(cell.value).toBe("Tokyo Station");
      expect(cell.title).toContain("35.6812, 139.7671");
      expect(cell.title).toContain("Chiyoda");
    });
    it("the map has a search box: pick a result to add a row with that place and title", async () => {
      withView("map", { placeBy: "where" }); show();
      const box = await screen.findByLabelText("Search for a place");
      fireEvent.change(box, { target: { value: "Tokyo Station" } });
      fireEvent.keyDown(box, { key: "Enter" });
      fireEvent.click(await screen.findByText("Tokyo Station", { selector: "strong" }, { timeout: 5000 }));
      const place = { lat: 35.6812, lng: 139.7671, name: "Tokyo Station", address: "Tokyo Station, Chiyoda, Tokyo, Japan" };
      await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "new-row", propertyId: "where", value: place } }));
      expect(calls).toContainEqual({ command: "rename_page", args: { pageId: "new-row", title: "Tokyo Station" } });
    });
    it("the map's search box is hidden when the profile is read-only", async () => {
      withView("map", { placeBy: "where" }); show(true);
      await screen.findByLabelText("Map of places");
      expect(screen.queryByLabelText("Search for a place")).toBeNull();
    });
  });
});
