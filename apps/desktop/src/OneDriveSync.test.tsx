import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BackupPanel from "./BackupPanel";
import OneDriveSync from "./OneDriveSync";

const { calls, state, open } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], open: vi.fn(), state: { status: null as any, fail: {} as Record<string, string>, suggestion: "C:\\Users\\nicho\\OneDrive\\NOU Sync" as string | null } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
const file = (name: string, over: Record<string, unknown> = {}) => ({ name, at: 1_800_000_000, device: "3fa9c1d2", mine: false, prev: false, bytes: 2_500_000, ...over });
const status = (over: Record<string, unknown> = {}) => ({ folder: "C:\\Users\\nicho\\OneDrive\\NOU Sync", folder_ok: true, in_onedrive: true, device: "aaaaaaaa", last_sync_at: null, files: [], newer: null, pages_changed: 0, pages: 12, ...over });
const backup = { path: "stage/backup-1", pages: 9, manifest: { id: "backup-1", created_at: 1_800_000_000, bytes: 1200, sha256: "abc", schema: 15 } };
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (state.fail[command]) throw new Error(state.fail[command]);
  if (command === "sync_status") return state.status;
  if (command === "sync_suggest_folder") return state.suggestion;
  if (command === "sync_set_folder") { state.status = status({ folder: args.path }); return state.status; }
  if (command === "sync_push") return { name: "NOU-20270115-080000-aaaaaaaa.noubackup", bytes: 1_300_000, removed: 0 };
  if (command === "sync_prepare_pull") return { token: "tok", backup };
  if (command === "sync_mark_pulled") { state.status = status({ last_sync_at: 1_800_000_500 }); return state.status; }
  if (command === "backup_status") return { destination: null, interrupted: [], rollback: [] };
  if (command === "backup_schedule_status") return null;
  if (command === "execute_restore") return { id: "done", rollback: "local/rollback" };
} }));
const card = async () => screen.findByRole("region", { name: "Backup and sync with OneDrive" });
const typePass = (c: HTMLElement, value = "a long shared passphrase") => fireEvent.change(within(c).getByLabelText("Sync passphrase"), { target: { value } });
const sent = (command: string) => calls.filter(c => c.command === command);
beforeEach(() => { calls.length = 0; open.mockReset(); state.status = status(); state.fail = {}; state.suggestion = "C:\\Users\\nicho\\OneDrive\\NOU Sync"; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("OneDrive sync card", () => {
  it("first asks for a folder, offers the OneDrive suggestion, and remembers the choice", async () => {
    state.status = status({ folder: null, folder_ok: false, in_onedrive: false });
    render(<OneDriveSync onPrepared={() => {}} />);
    const c = await card();
    fireEvent.click(await within(c).findByRole("button", { name: /Use C:\\Users\\nicho\\OneDrive\\NOU Sync/ }));
    await waitFor(() => expect(sent("sync_set_folder")[0].args).toEqual({ path: "C:\\Users\\nicho\\OneDrive\\NOU Sync" }));
    expect(await within(c).findByText(/Folder:/)).toBeTruthy();
    cleanup(); calls.length = 0; state.status = status({ folder: null }); state.suggestion = null; open.mockResolvedValue("D:\\Shared\\NOU");
    render(<OneDriveSync onPrepared={() => {}} />);
    const c2 = await card(); expect(within(c2).queryByRole("button", { name: /^Use / })).toBeNull();
    fireEvent.click(await within(c2).findByRole("button", { name: "Choose another folder…" }));
    await waitFor(() => expect(sent("sync_set_folder")[0].args).toEqual({ path: "D:\\Shared\\NOU" }));
  });
  it("needs a 12-character passphrase, and a confirmation the first time, before it saves; then it saves with overwrite off and clears the passphrase", async () => {
    render(<OneDriveSync onPrepared={() => {}} />);
    const c = await card(); const sync = within(c).getByRole("button", { name: "Sync now" }) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    typePass(c, "short"); expect(sync.disabled).toBe(true); expect(within(c).getByText("Use at least 12 characters.")).toBeTruthy();
    typePass(c); expect(sync.disabled).toBe(true); expect(within(c).getByText(/first save in this folder/)).toBeTruthy();
    fireEvent.change(within(c).getByLabelText("Confirm sync passphrase"), { target: { value: "something else entirely" } }); expect(sync.disabled).toBe(true); expect(within(c).getByText(/two passphrases are different/)).toBeTruthy();
    fireEvent.change(within(c).getByLabelText("Confirm sync passphrase"), { target: { value: "a long shared passphrase" } }); expect(sync.disabled).toBe(false);
    fireEvent.click(sync);
    await waitFor(() => expect(sent("sync_push")[0].args).toEqual({ password: "a long shared passphrase", overwrite: false }));
    expect(await within(c).findByText(/Saved NOU-20270115-080000-aaaaaaaa.noubackup \(1.2 MB\) to the folder. Wait until OneDrive shows it has finished uploading/)).toBeTruthy();
    expect((within(c).getByLabelText("Sync passphrase") as HTMLInputElement).value).toBe("");
  });
  it("does not ask to confirm the passphrase when the folder already has files, and can keep it while the screen is open", async () => {
    state.status = status({ files: [file("NOU-20261124-100000-3fa9c1d2.noubackup")] });
    render(<OneDriveSync onPrepared={() => {}} />);
    const c = await card(); expect(within(c).queryByLabelText("Confirm sync passphrase")).toBeNull();
    fireEvent.click(within(c).getByLabelText(/Keep the passphrase while this screen is open/)); typePass(c);
    fireEvent.click(within(c).getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sent("sync_push")).toHaveLength(1));
    await waitFor(() => expect((within(c).getByLabelText("Sync passphrase") as HTMLInputElement).value).toBe("a long shared passphrase"));
  });
  it("shows an error from the folder (a wrong passphrase, a refused save) and keeps the card usable", async () => {
    state.status = status({ files: [file("NOU-20261124-100000-3fa9c1d2.noubackup")] }); state.fail = { sync_push: "Wrong passphrase or damaged encrypted backup; no notes were replaced" };
    render(<OneDriveSync onPrepared={() => {}} />);
    const c = await card(); typePass(c); fireEvent.click(within(c).getByRole("button", { name: "Sync now" }));
    expect((await within(c).findByRole("alert")).textContent).toMatch(/Wrong passphrase/);
    expect((within(c).getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true); // the passphrase was cleared
  });
  it("lists what is in the folder, marking this device, other devices and safety copies, and warns about a folder that is missing or not in OneDrive", async () => {
    state.status = status({ in_onedrive: false, files: [file("a.noubackup", { device: "aaaaaaaa", mine: true }), file("b.noubackup", { prev: true, mine: true }), file("c.noubackup")] });
    render(<OneDriveSync onPrepared={() => {}} />);
    const c = await card();
    const items = within(within(c).getByLabelText("Files in the sync folder")).getAllByRole("listitem").map(li => li.textContent);
    expect(items[0]).toMatch(/this device · 2.4 MB$/); expect(items[1]).toMatch(/this device · 2.4 MB · safety copy$/); expect(items[2]).toMatch(/another device \(3fa9c1d2\)/);
    expect(within(c).getByText(/does not look like it is inside OneDrive/)).toBeTruthy(); cleanup();
    state.status = status({ folder_ok: false }); render(<OneDriveSync onPrepared={() => {}} />);
    expect((await within(await card()).findByRole("alert")).textContent).toMatch(/cannot be found right now/);
    expect((within(await card()).getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("never saves over a newer copy from another device: 'Sync now' asks, and Cancel does nothing", async () => {
    state.status = status({ newer: file("NOU-20261124-100000-3fa9c1d2.noubackup"), files: [file("NOU-20261124-100000-3fa9c1d2.noubackup")], pages_changed: 4, last_sync_at: 1_799_000_000 });
    render(<OneDriveSync onPrepared={() => {}} />);
    const c = await card(); expect(within(c).getByText(/Another device saved a newer copy on/)).toBeTruthy();
    typePass(c); fireEvent.click(within(c).getByRole("button", { name: "Sync now" }));
    const ask = await within(c).findByRole("region", { name: "A newer copy is in the folder" });
    expect(sent("sync_push")).toHaveLength(0);
    expect(within(ask).getByText(/This device has 4 pages edited since its last sync/)).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(within(c).queryByRole("region", { name: "A newer copy is in the folder" })).toBeNull(); expect(calls.some(x => x.command === "sync_push" || x.command === "sync_prepare_pull")).toBe(false);
  });
  it("'Keep this device's notes' asks first, then saves with overwrite on", async () => {
    state.status = status({ newer: file("NOU-20261124-100000-3fa9c1d2.noubackup"), files: [file("NOU-20261124-100000-3fa9c1d2.noubackup")] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<OneDriveSync onPrepared={() => {}} />);
    const c = await card(); typePass(c); fireEvent.click(within(c).getByRole("button", { name: "Sync now" }));
    const keep = await within(c).findByRole("button", { name: "Keep this device's notes and save them" });
    fireEvent.click(keep); expect(sent("sync_push")).toHaveLength(0);
    fireEvent.click(keep); await waitFor(() => expect(sent("sync_push")[0].args).toEqual({ password: "a long shared passphrase", overwrite: true }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("using the other device's copy goes through the normal review", () => {
  const panel = async () => { render(<BackupPanel onClose={() => {}} />); return await card(); };
  it("stages the copy, shows the restore review, needs the word RESTORE, and only then marks this device as up to date", async () => {
    state.status = status({ newer: file("NOU-20261124-100000-3fa9c1d2.noubackup"), files: [file("NOU-20261124-100000-3fa9c1d2.noubackup")], pages_changed: 2, last_sync_at: 1_799_000_000 });
    const c = await panel(); typePass(c); fireEvent.click(within(c).getByRole("button", { name: "Sync now" }));
    fireEvent.click(await within(c).findByRole("button", { name: "Use the other device's copy…" }));
    await waitFor(() => expect(sent("sync_prepare_pull")[0].args).toEqual({ file: "NOU-20261124-100000-3fa9c1d2.noubackup", password: "a long shared passphrase" }));
    const review = await screen.findByRole("region", { name: "Restore review" });
    expect(within(c).getByText(/saved to the folder first/)).toBeTruthy(); expect(sent("sync_mark_pulled")).toHaveLength(0);
    const go = within(review).getByRole("button", { name: "Restore all notes" }) as HTMLButtonElement; expect(go.disabled).toBe(true);
    fireEvent.change(within(review).getByLabelText("Restore confirmation"), { target: { value: "RESTORE" } }); fireEvent.click(go);
    await waitFor(() => expect(sent("execute_restore")[0].args).toEqual({ token: "tok", confirmation: "RESTORE" }));
    await waitFor(() => expect(sent("sync_mark_pulled")[0].args).toEqual({ file: "NOU-20261124-100000-3fa9c1d2.noubackup" }));
  });
  it("does not mark anything as synced when the review is cancelled", async () => {
    state.status = status({ newer: file("NOU-20261124-100000-3fa9c1d2.noubackup"), files: [file("NOU-20261124-100000-3fa9c1d2.noubackup")] });
    const c = await panel(); typePass(c); fireEvent.click(within(c).getByRole("button", { name: "Sync now" }));
    fireEvent.click(await within(c).findByRole("button", { name: "Use the other device's copy…" }));
    const review = await screen.findByRole("region", { name: "Restore review" });
    fireEvent.click(within(review).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Restore review" })).toBeNull(); expect(sent("sync_mark_pulled")).toHaveLength(0); expect(sent("execute_restore")).toHaveLength(0);
  });
  it("shows the error and stages nothing when the copy cannot be used (wrong passphrase, or this device's notes could not be saved first)", async () => {
    state.status = status({ newer: file("NOU-20261124-100000-3fa9c1d2.noubackup"), files: [file("NOU-20261124-100000-3fa9c1d2.noubackup")] });
    state.fail = { sync_prepare_pull: "This device's notes could not be saved to the folder first, so nothing was changed: Could not write to the sync folder" };
    const c = await panel(); typePass(c); fireEvent.click(within(c).getByRole("button", { name: "Sync now" }));
    fireEvent.click(await within(c).findByRole("button", { name: "Use the other device's copy…" }));
    expect((await within(c).findByRole("alert")).textContent).toMatch(/nothing was changed/);
    expect(screen.queryByRole("region", { name: "Restore review" })).toBeNull();
  });
});
