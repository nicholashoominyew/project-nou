import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import BackupPanel from "./BackupPanel";
const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
const backup = { path: "D:/backup-1", pages: 2, manifest: { id: "backup-1", created_at: 1, bytes: 1200, sha256: "abc", schema: 2 } };
beforeEach(() => {
  invoke.mockReset(); open.mockReset();
  invoke.mockImplementation(async command => {
    if (command === "backup_status") return { destination: { path: "D:/copies", protection: "local-or-unknown" }, interrupted: [], rollback: [] };
    if (command === "list_backups") return [[backup],0];
    if (command === "prepare_restore") return { token: "preview-token", backup };
    if (command === "execute_restore") return { id: "done", rollback: "local/rollback" };
  });
});
it("requires review and exact confirmation before replacing notes", async () => {
  render(<BackupPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByText("Verify & review"));
  const button = await screen.findByText("Restore all notes");
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Restore confirmation"), { target: { value: "restore" } });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Restore confirmation"), { target: { value: "RESTORE" } });
  fireEvent.click(button);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("execute_restore", { token: "preview-token", confirmation: "RESTORE" }));
  expect(await screen.findByText(/Restore completed and verified/)).toBeTruthy();
});
it("cancelling the folder picker never starts a restore", async () => {
  open.mockResolvedValue(null); render(<BackupPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByText("Choose a backup package…"));
  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(invoke.mock.calls.some(([c]) => c === "prepare_restore" || c === "execute_restore")).toBe(false);
});
it("displays failed verification and never offers a replacement", async () => {
  const impl = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) => { if (args[0] === "prepare_restore") throw new Error("checksum mismatch"); return impl(...args); });
  render(<BackupPanel onClose={() => {}} />); fireEvent.click(await screen.findByText("Verify & review"));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Error: checksum mismatch");
  expect(screen.queryByText("Restore all notes")).toBeNull();
});
