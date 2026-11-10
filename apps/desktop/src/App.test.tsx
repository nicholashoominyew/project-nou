import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
const {isFullscreen,setFullscreen,calls}=vi.hoisted(()=>({isFullscreen:vi.fn(),setFullscreen:vi.fn(),calls:[] as string[]}));
beforeEach(()=>{localStorage.clear();calls.length=0;isFullscreen.mockReset().mockResolvedValue(false);setFullscreen.mockReset().mockResolvedValue(undefined)});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {},isFullscreen,setFullscreen }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => {
  calls.push(command);
  if (command === "create_page") return { id: "created", title: "Untitled", parent_id: null, sort_key: "3", icon: "document" };
  if (command === "search_notes") return [{ id: "page", title: "Test note", parent_id: null }];
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

it("Ctrl+P opens Quick find instead of the print dialog, filters pages and opens the chosen one with Enter",async()=>{
 render(<App/>);await screen.findByText("Test note");
 const press=(init:KeyboardEventInit)=>{const event=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,...init});window.dispatchEvent(event);return event};
 expect(press({key:"p",ctrlKey:true}).defaultPrevented).toBe(true);
 const box=await screen.findByLabelText("Find a page");expect(screen.getByRole("dialog",{name:"Quick find"})).toBeTruthy();
 fireEvent.change(box,{target:{value:"second"}});
 await waitFor(()=>expect(screen.getAllByRole("option")).toHaveLength(1));
 fireEvent.keyDown(box,{key:"Enter"});
 await waitFor(()=>expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull());
 expect(screen.getAllByRole("tab")).toHaveLength(1);expect(screen.getByRole("tab",{name:"Second note"})).toBeTruthy();
 press({key:"p",ctrlKey:true});fireEvent.keyDown(await screen.findByLabelText("Find a page"),{key:"Escape"});
 await waitFor(()=>expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull());
});
it("Quick find does not open while a save is pending",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));fireEvent.click(await screen.findByText("Simulate pending save"));
 window.dispatchEvent(new KeyboardEvent("keydown",{key:"p",ctrlKey:true,bubbles:true,cancelable:true}));
 expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull();
});
it("Ctrl+N creates a page, Ctrl+Tab cycles tabs and Ctrl+W closes the current tab",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 fireEvent.click(screen.getByText("Second note"));expect(screen.getAllByRole("tab")).toHaveLength(2);
 const selected=()=>screen.getAllByRole("tab").find(t=>t.getAttribute("aria-selected")==="true")?.textContent;
 expect(selected()).toBe("Second note");
 fireEvent.keyDown(window,{key:"Tab",ctrlKey:true});expect(selected()).toBe("Test note");
 fireEvent.keyDown(window,{key:"Tab",ctrlKey:true,shiftKey:true});expect(selected()).toBe("Second note");
 fireEvent.keyDown(window,{key:"w",ctrlKey:true});expect(screen.getAllByRole("tab")).toHaveLength(1);
 fireEvent.keyDown(window,{key:"n",ctrlKey:true});
 // Creating a page lazily loads the heavy editor schema, which is slow under jsdom.
 await waitFor(()=>expect(calls).toContain("create_page"),{timeout:20000});
},30000);
it("ignores shortcuts while an input method is composing",async()=>{
 render(<App/>);await screen.findByText("Test note");
 const event=new KeyboardEvent("keydown",{key:"p",ctrlKey:true,isComposing:true,bubbles:true,cancelable:true});window.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(false);expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull();
});
