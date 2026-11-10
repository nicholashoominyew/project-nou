import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "./DatabaseView";

const { calls, view } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], view: { current: null as any } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "get_database") return view.current;
  if (command === "add_row") return { id: "new-row", title: "Untitled", values: {} };
  if (command === "add_view") return { id: "v-new", name: args.name, type: args.kind, config: args.config };
} }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));
vi.mock("./NoteEditor", () => ({ default: ({ pageId }: { pageId: string }) => <div data-testid="note">{pageId}</div> }));

const base = () => ({
  title: "Projects",
  properties: [
    { id: "done", name: "Finished", type: "checkbox", options: [] },
    { id: "hours", name: "Hours", type: "number", options: [] },
    { id: "state", name: "State", type: "status", options: [{ id: "o1", name: "Not started", color: "gray" }, { id: "o2", name: "Shipped", color: "green" }] },
    { id: "due", name: "Due", type: "date", options: [] },
  ],
  rows: [{ id: "r1", title: "Write ADR", values: { hours: 3, state: "o1", due: "2026-11-10" } }, { id: "r2", title: "Loose end", values: {} }],
  views: [{ id: "v1", name: "Table", type: "table", config: {} }],
});
const show = (readOnly = false) => render(<Database databaseId="db" readOnly={readOnly} onError={() => {}} />);
const withView = (type: string, config: object) => { view.current = { ...base(), views: [{ id: "v1", name: "View", type, config }] }; };
beforeEach(() => { calls.length = 0; view.current = base(); });

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
  it("asks for a property when a view has none to use", async () => {
    withView("calendar", {}); show();
    expect((await screen.findByText(/Choose a Date property/)).textContent).toBeTruthy();
  });
  it("adds a view of the chosen type with sensible default settings", async () => {
    show();
    await screen.findByDisplayValue("Projects");
    fireEvent.click(screen.getByText("Board"));
    await waitFor(() => expect(calls).toContainEqual({ command: "add_view", args: { databaseId: "db", name: "Board", kind: "board", config: { groupBy: "state" } } }));
  });
});
