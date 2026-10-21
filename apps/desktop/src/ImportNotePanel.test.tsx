import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import ImportNotePanel from "./ImportNotePanel";
import { recoveryData } from "./noteTransfer";
const { invoke, open } = vi.hoisted(() => ({ invoke:vi.fn(), open:vi.fn() }));
vi.mock("@tauri-apps/api/core",()=>({invoke})); vi.mock("@tauri-apps/plugin-dialog",()=>({open}));
beforeEach(()=>{ invoke.mockReset(); open.mockReset(); });
it("reviews then imports an additive copy with a new identity and a derived text cache",async()=>{
  const doc=new Y.Doc(); doc.getText("body").insert(0,"Recovered 脳"); const data=recoveryData(doc,"text-v1","source-id","Source"); doc.destroy();
  open.mockResolvedValue("C:/copy.json"); invoke.mockImplementation(async c=>c==="read_note_import"?JSON.stringify({...data,plainText:"wrong cache"}):{id:"new-id"});
  const done=vi.fn(); render(<ImportNotePanel onClose={()=>{}} onImported={done}/>);
  fireEvent.click(screen.getByText("Choose recovery JSON…")); await screen.findByText("Review the recovered copy");
  expect(invoke.mock.calls.some(([c])=>c==="import_note")).toBe(false);
  fireEvent.click(screen.getByText("Import as a new page")); await waitFor(()=>expect(done).toHaveBeenCalledWith("new-id"));
  expect(invoke).toHaveBeenCalledWith("import_note",expect.objectContaining({title:"Source (imported)",plainText:"Recovered 脳",format:"text-v1"}));
  expect(invoke.mock.calls.find(([c])=>c==="import_note")![1]).not.toHaveProperty("pageId");
});
it("cancelled and malformed imports never write notes",async()=>{
  open.mockResolvedValueOnce(null).mockResolvedValueOnce("bad.json"); invoke.mockResolvedValue("{}");
  render(<ImportNotePanel onClose={()=>{}} onImported={()=>{}}/>);
  fireEvent.click(screen.getByText("Choose recovery JSON…")); await waitFor(()=>expect(screen.getByText("Choose recovery JSON…")).toHaveProperty("disabled",false));
  expect(invoke).not.toHaveBeenCalled(); fireEvent.click(screen.getByText("Choose recovery JSON…"));
  await screen.findByRole("alert"); expect(screen.queryByText("Import as a new page")).toBeNull();
});
