import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import BackupSchedule from "./BackupSchedule";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke}));
const state={enabled:false,auto_keep:null,last_attempt:null,last_success:null,error:null};
beforeEach(()=>{invoke.mockReset();invoke.mockImplementation(async c=>c==="background_backup_task"?true:state);});
it("requires explicit schedule and deletion opt-in and rejects unsafe retention",async()=>{
  render(<BackupSchedule hasDestination/>); const save=await screen.findByText("Save backup schedule");
  await waitFor(()=>expect(save.closest("fieldset")).toHaveProperty("disabled",false));
  expect(invoke.mock.calls).toHaveLength(1);
  fireEvent.click(screen.getByLabelText("Enable weekly backups to the chosen destination")); fireEvent.click(save);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("configure_backup_schedule",{enabled:true,autoKeep:null}));
  await waitFor(()=>expect(save.closest("fieldset")).toHaveProperty("disabled",false));
  fireEvent.click(screen.getByLabelText("After a successful scheduled backup, automatically delete eligible old versions"));
  fireEvent.change(screen.getByLabelText("Automatic versions to keep"),{target:{value:"2"}});expect(save).toHaveProperty("disabled",true);
  fireEvent.change(screen.getByLabelText("Automatic versions to keep"),{target:{value:"10"}});fireEvent.click(save);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("configure_backup_schedule",{enabled:true,autoKeep:10}));
});
it("shows destination failures and registers a Windows task only after a click",async()=>{
  invoke.mockResolvedValueOnce({...state,enabled:true,error:"Destination unplugged"});
  render(<BackupSchedule hasDestination={false}/>);expect(await screen.findByRole("alert")).toHaveProperty("textContent","Last scheduled attempt: Destination unplugged");
  expect(screen.getByText("Save backup schedule")).toHaveProperty("disabled",true);
  expect(invoke.mock.calls.some(([c])=>c==="background_backup_task")).toBe(false);
  fireEvent.click(screen.getByText("Install or repair Windows backup task"));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("background_backup_task",{enabled:true}));
});
