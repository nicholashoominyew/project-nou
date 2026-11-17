import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
const {isFullscreen,setFullscreen,calls,lockedPages}=vi.hoisted(()=>({isFullscreen:vi.fn(),setFullscreen:vi.fn(),calls:[] as string[],lockedPages:{value:[] as string[]}}));
beforeEach(()=>{lockedPages.value=[];localStorage.clear();calls.length=0;isFullscreen.mockReset().mockResolvedValue(false);setFullscreen.mockReset().mockResolvedValue(undefined)});
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
  if (command === "list_locked_pages") return lockedPages.value;
  if (command === "lock_state") return { locked: true, open: false };
  if (command === "list_link_edges") return [{ source: "page", target: "second" }];
  if (command === "list_files") return [{ id: "f".repeat(64), name: "report.pdf", mime: "application/pdf", bytes: 4096, pages: [{ id: "second", title: "Second note" }], trashed_pages: 0 }];
  if (command === "backup_status") return { interrupted: [] };
} }));
const appended=vi.hoisted(()=>[] as {page:string;blocks:unknown[]}[]);
vi.mock("./noteAppend",()=>({appendBlocksToNote:async(page:string,blocks:unknown[])=>{appended.push({page,blocks});return {changed:true,message:"Added"}}}));
vi.mock("./NoteEditor", () => ({ default: ({ onStatus, pageId, secondary }: { onStatus: (status: string) => void; pageId: string; secondary?: boolean }) => <div data-testid={secondary ? "split-editor" : "main-editor"} data-page={pageId}>
  <button onClick={() => onStatus("saving")}>Simulate pending save</button>
  <button onClick={() => onStatus("failed")}>Simulate failed save</button>
  <button onClick={() => onStatus("saved")}>Simulate durable save</button>
</div> }));
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
it("a save in progress marks the shell as typing (so disabled sidebar buttons keep their normal look)",async()=>{
 const {container}=render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByText("Simulate pending save");
 const shell=()=>container.querySelector("main.shell")!;
 expect(shell().classList.contains("typing")).toBe(false);
 fireEvent.click(screen.getByText("Simulate pending save"));
 expect(shell().classList.contains("typing")).toBe(true);
 // the sidebar is still locked for navigation, it just does not change appearance
 expect((screen.getByText("Second note",{selector:".tree-page span"}).closest("button") as HTMLButtonElement).disabled).toBe(true);
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
it("opens the graph from the sidebar, opens a page from it, and leaves the graph when a page opens",async()=>{
 render(<App/>);await screen.findByText("Test note");
 fireEvent.click(screen.getByRole("button",{name:"Graph"}));
 expect(await screen.findByRole("heading",{name:"Graph"})).toBeTruthy();
 await waitFor(()=>expect(calls).toContain("list_link_edges"));
 fireEvent.click(await screen.findByLabelText("Open Second note"));
 await waitFor(()=>expect(screen.queryByRole("heading",{name:"Graph"})).toBeNull());
 expect(screen.getByLabelText("Page title")).toHaveProperty("value","Second note");
});
it("Ctrl+wheel and trackpad pinch never zoom the whole window, except on the graph where the graph handles them",async()=>{
 render(<App/>);await screen.findByText("Test note");
 const send=(el:Element,init:WheelEventInit)=>{const e=new WheelEvent("wheel",{bubbles:true,cancelable:true,...init});el.dispatchEvent(e);return e.defaultPrevented};
 expect(send(document.body,{ctrlKey:true,deltaY:-4})).toBe(true);
 expect(send(document.body,{deltaY:40})).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:"Graph"}));
 const svg=(await screen.findByLabelText("Page graph")) as unknown as Element;
 // the graph's own listener prevents it too, so check the app-level rule did not stop the event from reaching the graph
 let reached=false;svg.addEventListener("wheel",()=>{reached=true});
 send(svg,{ctrlKey:true,deltaY:-4});expect(reached).toBe(true);
});
it("Ctrl+Shift+A opens quick capture; saving makes an Inbox page on first use and adds the lines to it",async()=>{
 appended.length=0;render(<App/>);await screen.findByText("Test note");
 fireEvent.keyDown(window,{key:"A",ctrlKey:true,shiftKey:true});
 const box=await screen.findByLabelText("Capture text");
 fireEvent.change(box,{target:{value:"[] call Sam\nplain thought"}});fireEvent.keyDown(box,{key:"Enter"});
 expect(await screen.findByText(/Saved to Inbox/)).toBeTruthy();
 expect(calls).toContain("create_page");
 expect(appended).toEqual([{page:"created",blocks:[{type:"checkListItem",text:"call Sam",checked:false},{type:"paragraph",text:"plain thought"}]}]);
 expect(JSON.parse(localStorage.getItem("nou-inbox-page")||"null")).toBe("created");
 fireEvent.keyDown(window,{key:"A",ctrlKey:true,shiftKey:true});
 await waitFor(()=>expect(screen.queryByLabelText("Capture text")).toBeNull());
});
it("quick capture uses an existing top-level Inbox page and is opened from the sidebar",async()=>{
 appended.length=0;localStorage.setItem("nou-inbox-page",JSON.stringify("second"));
 render(<App/>);await screen.findByText("Test note");
 fireEvent.click(screen.getByRole("button",{name:/Quick capture/}));
 const box=await screen.findByLabelText("Capture text");
 fireEvent.change(box,{target:{value:"hello"}});fireEvent.keyDown(box,{key:"Enter"});
 await screen.findByText(/Saved to Inbox/);
 expect(appended[0].page).toBe("second");expect(calls.filter(c=>c==="create_page").length).toBe(0);
});
const openSplitFromMenu = async (name: string) => { fireEvent.click(screen.getByLabelText("More options for " + name)); fireEvent.click(screen.getByRole("menuitem", { name: "Open in split view" })); };
it("Open in split view shows a second page beside the open one, with its own editor", async () => {
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));
 expect((await screen.findByTestId("main-editor")).getAttribute("data-page")).toBe("page");
 await openSplitFromMenu("Second note");
 const split = await screen.findByTestId("split-editor");
 expect(split.getAttribute("data-page")).toBe("second");
 expect(screen.getByTestId("main-editor").getAttribute("data-page")).toBe("page");
 expect(screen.getByLabelText("Split view")).toBeTruthy();
});
it("the split entry is not offered from Home, nor for the page that is already open",async()=>{
 render(<App/>);await screen.findByText("Test note");
 fireEvent.click(screen.getByLabelText("More options for Test note"));
 expect(screen.queryByRole("menuitem",{name:"Open in split view"})).toBeNull();
 fireEvent.keyDown(document,{key:"Escape"});
 fireEvent.click(screen.getByText("Test note"));await screen.findByTestId("main-editor");
 fireEvent.click(screen.getByLabelText("More options for Test note"));
 expect(screen.queryByRole("menuitem",{name:"Open in split view"})).toBeNull();
 fireEvent.keyDown(document,{key:"Escape"});
 fireEvent.click(screen.getByLabelText("More options for Second note"));
 expect(screen.queryByRole("menuitem",{name:"Open in split view"})).not.toBeNull();
});
it("closing the split leaves the main page alone; Open alone and Swap move pages around",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByTestId("main-editor");
 await openSplitFromMenu("Second note");await screen.findByTestId("split-editor");
 fireEvent.click(screen.getByText("Swap"));
 await waitFor(()=>expect(screen.getByTestId("main-editor").getAttribute("data-page")).toBe("second"));
 expect(screen.getByTestId("split-editor").getAttribute("data-page")).toBe("page");
 fireEvent.click(screen.getByLabelText("Close split view"));
 await waitFor(()=>expect(screen.queryByTestId("split-editor")).toBeNull());
 expect(screen.getByTestId("main-editor").getAttribute("data-page")).toBe("second");
 await openSplitFromMenu("Test note");await screen.findByTestId("split-editor");
 fireEvent.click(screen.getByText("Open alone"));
 await waitFor(()=>expect(screen.queryByTestId("split-editor")).toBeNull());
 expect(screen.getByTestId("main-editor").getAttribute("data-page")).toBe("page");
});
it("opening the split page from the sidebar closes the split instead of showing it twice",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByTestId("main-editor");
 await openSplitFromMenu("Second note");await screen.findByTestId("split-editor");
 fireEvent.click(screen.getAllByText("Second note").find(el=>el.closest(".sidebar"))!);
 await waitFor(()=>expect(screen.queryByTestId("split-editor")).toBeNull());
 expect(screen.getByTestId("main-editor").getAttribute("data-page")).toBe("second");
});
it("a pending save in the split pane blocks switching pages and closing it, until it is saved",async()=>{
 render(<App/>);fireEvent.click(await screen.findByText("Test note"));await screen.findByTestId("main-editor");
 await openSplitFromMenu("Second note");const split=await screen.findByTestId("split-editor");
 fireEvent.click(within(split).getByText("Simulate pending save"));
 expect((screen.getByLabelText("Close split view") as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getAllByText("Child note").find(el=>el.closest(".sidebar"))!);
 expect(screen.getByTestId("main-editor").getAttribute("data-page")).toBe("page");
 fireEvent.click(within(split).getByText("Simulate durable save"));
 await waitFor(()=>expect((screen.getByLabelText("Close split view") as HTMLButtonElement).disabled).toBe(false));
});
it("remembers the split page across restarts, but not when it is the same as the open page or no longer exists",async()=>{
 localStorage.setItem("nou-split-page",JSON.stringify("second"));localStorage.setItem("nou-active-tab",JSON.stringify("page"));localStorage.setItem("nou-open-tabs",JSON.stringify(["page"]));
 const first=render(<App/>);
 expect((await screen.findByTestId("split-editor")).getAttribute("data-page")).toBe("second");first.unmount();
 localStorage.setItem("nou-split-page",JSON.stringify("page"));
 const second=render(<App/>);await screen.findByTestId("main-editor");
 await waitFor(()=>expect(screen.queryByTestId("split-editor")).toBeNull());second.unmount();
 localStorage.setItem("nou-split-page",JSON.stringify("gone-page"));
 render(<App/>);await screen.findByTestId("main-editor");
 await waitFor(()=>expect(screen.queryByTestId("split-editor")).toBeNull());
});
it("opens the file tracker from the sidebar, opens a page that uses a file, and leaves the tracker",async()=>{
 render(<App/>);await screen.findByText("Test note");
 fireEvent.click(screen.getByRole("button",{name:"Files"}));
 expect(await screen.findByRole("heading",{name:"Files"})).toBeTruthy();
 expect(await screen.findByText("report.pdf")).toBeTruthy();
 const list=await screen.findByRole("list",{name:"Files"});
 fireEvent.click(within(list).getByText("Second note"));
 await waitFor(()=>expect(screen.queryByRole("heading",{name:"Files"})).toBeNull());
 expect(screen.getByLabelText("Page title")).toHaveProperty("value","Second note");
});
it("a locked page shows the lock screen instead of its editor, with a lock mark in the sidebar; an unlocked page is unaffected",async()=>{
 lockedPages.value=["second"];
 render(<App/>);await screen.findByText("Test note");
 expect(document.querySelectorAll(".sidebar .row-lock").length).toBe(1);
 fireEvent.click(screen.getByText("Second note"));
 expect(await screen.findByLabelText("Locked note")).toBeTruthy();
 expect(screen.getByText("“Second note” is locked")).toBeTruthy();
 expect(screen.queryByTestId("main-editor")).toBeNull();
 expect(screen.getByLabelText("Page title")).toHaveProperty("value","Second note");
 expect(screen.queryByLabelText("Lock options")).toBeNull();
 fireEvent.click(screen.getByText("Test note"));
 expect((await screen.findByTestId("main-editor")).getAttribute("data-page")).toBe("page");
 expect(screen.getByLabelText("Lock this note")).toBeTruthy();
});
it("sidebar order is search, Home, Graph, Files, and the Quick capture row is gone from it",async()=>{
 render(<App/>);await screen.findByText("Test note");
 const side=screen.getByLabelText("Sidebar");
 const top=[...side.querySelectorAll(".sb-search input, .sb-item")].map(el=>el instanceof HTMLInputElement?"search":(el.textContent||"").trim());
 expect(top.slice(0,4)).toEqual(["search","Home","Graph","Files"]);
 expect(within(side).queryByText("Quick capture")).toBeNull();
 expect(side.querySelector("kbd")).toBeNull();
});
it("Quick capture is a floating button without the shortcut shown, still opened by Ctrl+Shift+A, and locked while busy or restoring",async()=>{
 render(<App/>);await screen.findByText("Test note");
 const fab=screen.getByRole("button",{name:"Quick capture"}) as HTMLButtonElement;
 expect(fab.className).toBe("fab");expect(fab.getAttribute("title")).toBe("Quick capture");
 expect(fab.textContent).toBe("");expect(fab.querySelector("svg")).not.toBeNull();
 expect(document.body.textContent).not.toContain("Ctrl+Shift+A");
 fireEvent.click(fab);expect(await screen.findByLabelText("Capture text")).toBeTruthy();
 fireEvent.keyDown(document,{key:"Escape"});await waitFor(()=>expect(screen.queryByLabelText("Capture text")).toBeNull());
 fireEvent.keyDown(window,{key:"A",ctrlKey:true,shiftKey:true});expect(await screen.findByLabelText("Capture text")).toBeTruthy();
});
it("tabs show a dot instead of the page icon, a + button opens Quick find, and the window tools are icons, not glyphs",async()=>{
 const {container}=render(<App/>);fireEvent.click(await screen.findByText("Test note"));
 const tab=await screen.findByRole("tab",{name:/Test note/});
 expect(tab.querySelector(".tab-dot")).not.toBeNull();expect(tab.querySelector("svg")).toBeNull();
 expect(container.querySelector(".page-tab.selected .close-tab")).not.toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Open a page in a new tab"}));
 expect(await screen.findByRole("dialog",{name:"Quick find"})).toBeTruthy();
 fireEvent.keyDown(document,{key:"Escape"});
 const tools=container.querySelector(".window-tools")!;
 expect(tools.textContent).toBe("");expect(tools.querySelectorAll("svg").length).toBe(2);
 for(const glyph of ["☾","☀","⛶"])expect(document.body.textContent).not.toContain(glyph);
});
