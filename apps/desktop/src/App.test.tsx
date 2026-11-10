import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
const {isFullscreen,setFullscreen,calls}=vi.hoisted(()=>({isFullscreen:vi.fn(),setFullscreen:vi.fn(),calls:[] as string[]}));
beforeEach(()=>{localStorage.clear();calls.length=0;isFullscreen.mockReset().mockResolvedValue(false);setFullscreen.mockReset().mockResolvedValue(undefined)});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {},isFullscreen,setFullscreen }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => {
  calls.push(command);
  if (command === "create_page") return { id: "created", title: "Untitled", parent_id: null, sort_key: "3", icon: "document" };
  if (command === "search_notes") return [{ id: "page", title: "Test note", parent_id: null }];
  if (command === "list_pages") return [{ id: "page", title: "Test note", parent_id: null, sort_key: "1" },{ id:"second",title:"Second note",parent_id:null,sort_key:"2"},{ id:"child",title:"Child note",parent_id:"page",sort_key:"1"}];
  if (command === "list_trashed_pages") return [];
  if (command === "list_tags") return [{ name: "research", count: 2 }];
  if (command === "list_backlinks") return [{ id: "second", title: "Linker page" }];
  if (command === "list_recent_pages") return [];
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

it("Ctrl+Q opens Quick find, filters pages and opens the chosen one with Enter",async()=>{
 render(<App/>);await screen.findByText("Test note");
 const press=(init:KeyboardEventInit)=>{const event=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,...init});window.dispatchEvent(event);return event};
 expect(press({key:"q",ctrlKey:true}).defaultPrevented).toBe(true);
 const box=await screen.findByLabelText("Find a page");expect(screen.getByRole("dialog",{name:"Quick find"})).toBeTruthy();
 fireEvent.change(box,{target:{value:"second"}});
 await waitFor(()=>expect(screen.getAllByRole("option")).toHaveLength(1));
 fireEvent.keyDown(box,{key:"Enter"});
 await waitFor(()=>expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull());
 expect(screen.getAllByRole("tab")).toHaveLength(1);expect(screen.getByRole("tab",{name:"Second note"})).toBeTruthy();
 press({key:"q",ctrlKey:true});fireEvent.keyDown(await screen.findByLabelText("Find a page"),{key:"Escape"});
 await waitFor(()=>expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull());
});
it("Quick find does not open while a save is pending",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));fireEvent.click(await screen.findByText("Simulate pending save"));
 window.dispatchEvent(new KeyboardEvent("keydown",{key:"q",ctrlKey:true,bubbles:true,cancelable:true}));
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
it("Ctrl+1 and Ctrl+9 jump between tabs, Ctrl+[ and Ctrl+] walk back and forward, Ctrl+Shift+T reopens a closed tab",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 fireEvent.click(screen.getByText("Second note"));
 const selected=()=>screen.getAllByRole("tab").find(t=>t.getAttribute("aria-selected")==="true")?.textContent;
 expect(selected()).toBe("Second note");
 fireEvent.keyDown(window,{key:"1",ctrlKey:true});expect(selected()).toBe("Test note");
 fireEvent.keyDown(window,{key:"9",ctrlKey:true});expect(selected()).toBe("Second note");
 fireEvent.keyDown(window,{key:"[",ctrlKey:true});expect(selected()).toBe("Test note");
 fireEvent.keyDown(window,{key:"]",ctrlKey:true});expect(selected()).toBe("Second note");
 fireEvent.keyDown(window,{key:"w",ctrlKey:true});expect(screen.getAllByRole("tab")).toHaveLength(1);
 fireEvent.keyDown(window,{key:"T",ctrlKey:true,shiftKey:true});expect(screen.getAllByRole("tab")).toHaveLength(2);expect(selected()).toBe("Second note");
});
it("Ctrl+Shift+L toggles dark mode, Ctrl+= zooms, and Ctrl+/ opens the shortcuts list",async()=>{
 render(<App/>);await screen.findByText("Test note");
 expect(document.documentElement.dataset.theme).toBe("light");
 fireEvent.keyDown(window,{key:"L",ctrlKey:true,shiftKey:true});expect(document.documentElement.dataset.theme).toBe("dark");
 fireEvent.keyDown(window,{key:"=",ctrlKey:true});expect(localStorage.getItem("nou-zoom")).toBe("1.1");
 fireEvent.keyDown(window,{key:"0",ctrlKey:true});expect(localStorage.getItem("nou-zoom")).toBe("1");
 fireEvent.keyDown(window,{key:"/",ctrlKey:true});expect(screen.getByRole("dialog",{name:"Keyboard shortcuts"})).toBeTruthy();
 fireEvent.keyDown(document,{key:"Escape"});expect(screen.queryByRole("dialog",{name:"Keyboard shortcuts"})).toBeNull();
});
it("breadcrumb shows every ancestor as a link and navigates to it",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Child note"));await screen.findByText("Simulate pending save");
 const crumbs=screen.getByRole("navigation",{name:"Breadcrumb"});
 expect(crumbs.textContent).toContain("Workspace");expect(crumbs.textContent).toContain("Test note");expect(crumbs.textContent).toContain("Child note");
 fireEvent.click(within(crumbs).getByText("Test note"));
 const selected=()=>screen.getAllByRole("tab").find(t=>t.getAttribute("aria-selected")==="true")?.textContent;
 expect(selected()).toBe("Test note");
 expect(within(screen.getByRole("navigation",{name:"Breadcrumb"})).queryByRole("button",{name:"Test note"})).toBeNull(); // the current page is plain text
 fireEvent.click(within(screen.getByRole("navigation",{name:"Breadcrumb"})).getByText("Workspace"));
 expect(screen.queryByRole("navigation",{name:"Breadcrumb"})).toBeNull();
});
it("Ctrl+Shift+F enters focus mode, Esc leaves it, and the Exit button always works",async()=>{
 const {container}=render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 const shell=()=>container.querySelector("main.shell")!;
 expect(shell().classList.contains("focus")).toBe(false);
 fireEvent.keyDown(window,{key:"F",ctrlKey:true,shiftKey:true});expect(shell().classList.contains("focus")).toBe(true);
 fireEvent.keyDown(window,{key:"Escape"});expect(shell().classList.contains("focus")).toBe(false);
 fireEvent.click(screen.getByLabelText("Focus mode"));expect(shell().classList.contains("focus")).toBe(true);
 fireEvent.click(screen.getByText("Exit focus mode"));expect(shell().classList.contains("focus")).toBe(false);
});
it("shows Home when no page is open, a tag there opens Quick find pre-filled, and the sidebar Home row returns to it",async()=>{
 render(<App/>);
 expect(await screen.findByLabelText("Home")).toBeTruthy();
 fireEvent.click(await screen.findByText("#research"));
 const dialog=await screen.findByRole("dialog",{name:"Quick find"});
 expect((within(dialog).getByLabelText("Find a page") as HTMLInputElement).value).toBe("#research");
 fireEvent.keyDown(document,{key:"Escape"});
 fireEvent.click(screen.getByText("Test note",{selector:".tree-page span"}));await screen.findByText("Simulate pending save");
 expect(screen.queryByLabelText("Home")).toBeNull();
 fireEvent.click(screen.getByText("Home",{selector:".sb-item span"}));
 expect(await screen.findByLabelText("Home")).toBeTruthy();
});
it("typing does not make the tag row or the Linked-from panel vanish and reappear (layout jitter)",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 const panel=await screen.findByLabelText("Linked from");const tags=await screen.findByLabelText("Add a tag");
 const backlinkCalls=()=>calls.filter(c=>c==="list_backlinks").length;
 const before=backlinkCalls();
 // the editor reports "saving" on every pause while typing, then "saved"
 fireEvent.click(screen.getByText("Simulate pending save"));
 expect(screen.getByLabelText("Linked from")).toBe(panel);
 expect(screen.getByLabelText("Add a tag")).toBe(tags);
 expect((screen.getByLabelText("Add a tag") as HTMLInputElement).disabled).toBe(false);
 expect(backlinkCalls()).toBe(before);
});
it("ignores shortcuts while an input method is composing",async()=>{
 render(<App/>);await screen.findByText("Test note");
 const event=new KeyboardEvent("keydown",{key:"q",ctrlKey:true,isComposing:true,bubbles:true,cancelable:true});window.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(false);expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull();
});
it("Ctrl+P prints the page instead of opening Quick find",async()=>{
 const print=vi.fn();vi.stubGlobal("print",print);
 render(<App/>);await screen.findByText("Test note");
 const event=new KeyboardEvent("keydown",{key:"p",ctrlKey:true,bubbles:true,cancelable:true});window.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(true);expect(print).toHaveBeenCalledTimes(1);expect(screen.queryByRole("dialog",{name:"Quick find"})).toBeNull();
 vi.unstubAllGlobals();
});
it("closes the icon picker and the page menu when you click elsewhere or press Escape",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 fireEvent.click(screen.getByLabelText("Assign page icon"));expect(screen.getByRole("group",{name:"Monochrome page icons"})).toBeTruthy();
 fireEvent.pointerDown(screen.getByText("Test note",{selector:".tree-page span"}));expect(screen.queryByRole("group",{name:"Monochrome page icons"})).toBeNull();
 fireEvent.click(screen.getByLabelText("Assign page icon"));expect(screen.getByRole("group",{name:"Monochrome page icons"})).toBeTruthy();
 fireEvent.keyDown(document,{key:"Escape"});expect(screen.queryByRole("group",{name:"Monochrome page icons"})).toBeNull();
 fireEvent.click(screen.getByLabelText("More options for Test note"));expect(screen.getByRole("menu")).toBeTruthy();
 fireEvent.pointerDown(document.body);expect(screen.queryByRole("menu")).toBeNull();
 fireEvent.contextMenu(screen.getByText("Test note",{selector:".tree-page span"}));expect(screen.getByRole("menu")).toBeTruthy();
 fireEvent.keyDown(document,{key:"Escape"});expect(screen.queryByRole("menu")).toBeNull();
});
it("favorites a page from its menu, renames it inline and collapses the sidebar with Ctrl+\\",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 fireEvent.click(screen.getByLabelText("More options for Test note"));fireEvent.click(screen.getByRole("menuitem",{name:"Add to Favorites"}));
 await waitFor(()=>expect(calls).toContain("set_page_favorite"));
 fireEvent.click(screen.getByLabelText("More options for Test note"));fireEvent.click(screen.getByRole("menuitem",{name:"Rename"}));
 const box=await screen.findByLabelText("Rename Test note");fireEvent.change(box,{target:{value:"Renamed"}});fireEvent.keyDown(box,{key:"Enter"});
 await waitFor(()=>expect(calls).toContain("rename_page"));
 expect(screen.getByLabelText("Sidebar")).toBeTruthy();fireEvent.keyDown(window,{key:"\\",ctrlKey:true});expect(screen.queryByLabelText("Sidebar")).toBeNull();
 fireEvent.click(screen.getByLabelText("Open sidebar"));expect(screen.getByLabelText("Sidebar")).toBeTruthy();
});
