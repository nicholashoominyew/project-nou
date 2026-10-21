import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
const {isFullscreen,setFullscreen}=vi.hoisted(()=>({isFullscreen:vi.fn(),setFullscreen:vi.fn()}));
beforeEach(()=>{localStorage.clear();isFullscreen.mockReset().mockResolvedValue(false);setFullscreen.mockReset().mockResolvedValue(undefined)});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {},isFullscreen,setFullscreen }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => {
  if (command === "list_pages") return [{ id: "page", title: "Test note", parent_id: null, sort_key: "1" },{ id:"second",title:"Second note",parent_id:null,sort_key:"2"}];
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
  fireEvent.click(await screen.findByText("Simulate pending save")); expect(reload()).toBe(true);
  fireEvent.click(screen.getByText("Simulate failed save")); expect(reload()).toBe(true);
  fireEvent.click(screen.getByText("Simulate durable save")); expect(reload()).toBe(false);
  fireEvent.click(screen.getByText("Simulate failed save")); view.unmount(); expect(reload()).toBe(false);
});

it("toggles native fullscreen with F11 and persists theme selection",async()=>{
 const view=render(<App/>);await screen.findByText("Test note");
 fireEvent.keyDown(window,{key:"F11"});await waitFor(()=>expect(setFullscreen).toHaveBeenLastCalledWith(true));
 isFullscreen.mockResolvedValue(true);fireEvent.keyDown(window,{key:"F11"});await waitFor(()=>expect(setFullscreen).toHaveBeenLastCalledWith(false));
 fireEvent.click(screen.getByLabelText("Switch to dark mode"));expect(document.documentElement.dataset.theme).toBe("dark");view.unmount();
 render(<App/>);expect(screen.getByLabelText("Switch to light mode")).toBeTruthy();expect(document.documentElement.dataset.theme).toBe("dark");
});
it("keeps multiple page tabs open and closes tabs without deleting pages",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 fireEvent.click(screen.getByText("Second note"));expect(screen.getAllByRole("tab")).toHaveLength(2);
 fireEvent.click(screen.getByLabelText("Close Second note tab"));expect(screen.getAllByRole("tab")).toHaveLength(1);
 expect(screen.getByText("Second note")).toBeTruthy();
});
