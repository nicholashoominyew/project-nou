import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import EncryptedBackup from "./EncryptedBackup";
const {invoke,open,save}=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn(),save:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));vi.mock("@tauri-apps/plugin-dialog",()=>({open,save}));
beforeEach(()=>{invoke.mockReset();open.mockReset();save.mockReset();});
it("only opens existing encrypted files for review: there is no export any more (the OneDrive sync makes encrypted copies)",async()=>{
  render(<EncryptedBackup onPrepared={()=>{}}/>);
  expect(screen.queryByText(/Export encrypted backup/)).toBeNull();expect(screen.queryByLabelText("Confirm backup password")).toBeNull();
  expect(screen.getByText("Open encrypted backup for review…")).toHaveProperty("disabled",true); // needs the password first
  open.mockResolvedValue("D:/old.noubackup");invoke.mockResolvedValue({token:"t",backup:{path:"p",pages:1,manifest:{id:"backup-1",created_at:1,sha256:"h",bytes:1,schema:17}}});const prepared=vi.fn();
  render(<EncryptedBackup onPrepared={prepared}/>);fireEvent.change(screen.getAllByLabelText("Backup password")[1],{target:{value:"long unique password"}});
  fireEvent.click(screen.getAllByText("Open encrypted backup for review…")[1]);
  await waitFor(()=>expect(prepared).toHaveBeenCalled());expect(invoke).toHaveBeenCalledWith("prepare_encrypted_restore",{path:"D:/old.noubackup",password:"long unique password"});
  expect(invoke.mock.calls.some(([c])=>c==="create_encrypted_backup")).toBe(false);
});
it("wrong passwords cannot trigger restoration and are cleared",async()=>{
  open.mockResolvedValue("D:/notes.noubackup");invoke.mockRejectedValue(new Error("Wrong password"));const prepared=vi.fn();
  render(<EncryptedBackup onPrepared={prepared}/>);fireEvent.change(screen.getByLabelText("Backup password"),{target:{value:"wrong password"}});
  fireEvent.click(screen.getByText("Open encrypted backup for review…"));await screen.findByRole("alert");
  expect(prepared).not.toHaveBeenCalled();expect(screen.getByLabelText("Backup password")).toHaveProperty("value","");
  expect(invoke.mock.calls.some(([c])=>c==="execute_restore")).toBe(false);
});
