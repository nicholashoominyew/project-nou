import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import EncryptedBackup from "./EncryptedBackup";
const {invoke,open,save}=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn(),save:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));vi.mock("@tauri-apps/plugin-dialog",()=>({open,save}));
beforeEach(()=>{invoke.mockReset();open.mockReset();save.mockReset();});
it("requires matching passphrases for export and clears them after writing",async()=>{
  save.mockResolvedValue("D:/notes.noubackup"); invoke.mockResolvedValue({path:"D:/notes.noubackup",sha256:"hash"});
  render(<EncryptedBackup onPrepared={()=>{}}/>);const button=screen.getByText("Export encrypted backup…");expect(button).toHaveProperty("disabled",true);
  fireEvent.change(screen.getByLabelText("Backup passphrase"),{target:{value:"long unique passphrase"}});expect(button).toHaveProperty("disabled",true);
  fireEvent.change(screen.getByLabelText("Confirm backup passphrase"),{target:{value:"long unique passphrase"}});fireEvent.click(button);
  await screen.findByRole("status"); await waitFor(()=>expect(screen.getByLabelText("Backup passphrase")).toHaveProperty("value",""));
  expect(invoke).toHaveBeenCalledWith("create_encrypted_backup",{path:"D:/notes.noubackup",password:"long unique passphrase"});
});
it("wrong passphrases cannot trigger restoration and are cleared",async()=>{
  open.mockResolvedValue("D:/notes.noubackup");invoke.mockRejectedValue(new Error("Wrong passphrase"));const prepared=vi.fn();
  render(<EncryptedBackup onPrepared={prepared}/>);fireEvent.change(screen.getByLabelText("Backup passphrase"),{target:{value:"wrong passphrase"}});
  fireEvent.click(screen.getByText("Open encrypted backup for review…"));await screen.findByRole("alert");
  expect(prepared).not.toHaveBeenCalled();expect(screen.getByLabelText("Backup passphrase")).toHaveProperty("value","");
  expect(invoke.mock.calls.some(([c])=>c==="execute_restore")).toBe(false);
});
