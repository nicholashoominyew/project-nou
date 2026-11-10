import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import PageBody from "./DatabaseView";

const { calls, view } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], view: { current: null as unknown } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => { calls.push({ command, args }); if (command === "get_database") return view.current; } }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));

const data = {
  properties: [
    { id: "done", name: "Finished", type: "checkbox", options: [] },
    { id: "hours", name: "Hours", type: "number", options: [] },
    { id: "state", name: "State", type: "status", options: [{ id: "o1", name: "Not started", color: "gray" }, { id: "o2", name: "Done", color: "green" }] },
  ],
  rows: [{ id: "r1", title: "Write ADR", values: { hours: 3, state: "o1" } }],
};
const renderNote = (id: string) => <div data-testid="note">{id}</div>;
const show = (readOnly = false) => render(<PageBody pageId="db" readOnly={readOnly} onError={() => {}} renderNote={renderNote} />);

beforeEach(() => { calls.length = 0; view.current = data; });

describe("PageBody", () => {
  it("falls back to the normal note editor when the page is not a database", async () => {
    view.current = null; show();
    expect((await screen.findByTestId("note")).textContent).toBe("db");
  });
  it("shows rows with typed cells and saves a checkbox through set_value", async () => {
    show();
    expect(await screen.findByDisplayValue("Write ADR")).toBeTruthy();
    expect(screen.getByDisplayValue("3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Finished"));
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r1", propertyId: "done", value: true } }));
  });
  it("picks a status option and adds a row", async () => {
    show();
    await screen.findByDisplayValue("Write ADR");
    fireEvent.click(within(screen.getByRole("listbox", { name: "State" })).getByText("Done"));
    await waitFor(() => expect(calls).toContainEqual({ command: "set_value", args: { rowId: "r1", propertyId: "state", value: "o2" } }));
    fireEvent.click(screen.getByText("+ New row"));
    await waitFor(() => expect(calls.some(c => c.command === "add_row" && c.args.databaseId === "db")).toBe(true));
  });
  it("opens a row's page body in the peek panel", async () => {
    show();
    fireEvent.click(await screen.findByLabelText("Open Write ADR"));
    expect((await screen.findByTestId("note")).textContent).toBe("r1");
  });
  it("cannot edit while the profile is read-only", async () => {
    show(true);
    await screen.findByDisplayValue("Write ADR");
    expect((screen.getByLabelText("Finished") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText("+ New row") as HTMLButtonElement).disabled).toBe(true);
  });
});
