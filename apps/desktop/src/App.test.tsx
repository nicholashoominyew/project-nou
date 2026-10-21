import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import App from "./App";
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => {
  if (command === "list_pages") return [{ id: "page", title: "Test note", parent_id: null, sort_key: "1" }];
  if (command === "list_trashed_pages") return [];
  if (command === "backup_status") return { interrupted: [] };
} }));
vi.mock("./NoteEditor", () => ({ default: ({ onStatus }: { onStatus: (status: string) => void }) => <>
  <button onClick={() => onStatus("saving")}>Simulate pending save</button>
  <button onClick={() => onStatus("failed")}>Simulate failed save</button>
  <button onClick={() => onStatus("saved")}>Simulate durable save</button>
</> }));
it("guards reload during pending and failed saves, then permits it after persistence and cleans up", async () => {
  const view = render(<App />);
  fireEvent.click(await screen.findByText("Test note"));
  const reload = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  expect(reload()).toBe(false);
  fireEvent.click(screen.getByText("Simulate pending save")); expect(reload()).toBe(true);
  fireEvent.click(screen.getByText("Simulate failed save")); expect(reload()).toBe(true);
  fireEvent.click(screen.getByText("Simulate durable save")); expect(reload()).toBe(false);
  fireEvent.click(screen.getByText("Simulate failed save")); view.unmount(); expect(reload()).toBe(false);
});
