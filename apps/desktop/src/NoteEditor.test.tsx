import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import NoteEditor from "./NoteEditor";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@blocknote/react", async importOriginal => ({ ...await importOriginal<typeof import("@blocknote/react")>(), useCreateBlockNote: vi.fn() }));
vi.mock("@blocknote/mantine", () => ({ BlockNoteView: () => null }));
beforeEach(() => {
  invoke.mockReset();
  const doc = new Y.Doc(); doc.getText("body").insert(0, "Original");
  const updates = [Array.from(Y.encodeStateAsUpdate(doc))]; doc.destroy();
  invoke.mockImplementation(async command => {
    if (command === "load_note") return { updates, format: "text-v1", legacy_text: null, seq: 1, epoch: 4 };
    if (command === "save_note") throw new Error("disk full");
  });
});
async function failSave() {
  const input = await screen.findByLabelText("Note content");
  fireEvent.change(input, { target: { value: "Unsaved 脳 content" } });
  await screen.findByText(/Saving failed:/);
  return input;
}
it("retains failed content and retries the complete Yjs state before reporting saved", async () => {
  const onStatus = vi.fn(); render(<NoteEditor pageId="page-1" onStatus={onStatus} />);
  await failSave();
  expect(onStatus).toHaveBeenLastCalledWith("failed");
  expect(screen.getByLabelText("Recovery text")).toHaveProperty("value", "Unsaved 脳 content");
  invoke.mockImplementation(async command => { if (command === "save_note") return 2; });
  fireEvent.click(screen.getByText("Retry saving all current content"));
  await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("saved"));
  const [, args] = invoke.mock.calls.filter(([command]) => command === "save_note").at(-1)!;
  expect(args).toMatchObject({ pageId: "page-1", plainText: "Unsaved 脳 content", epoch: 4, format: "text-v1" });
  const reopened = new Y.Doc(); Y.applyUpdate(reopened, Uint8Array.from(args.update));
  expect(reopened.getText("body").toString()).toBe("Unsaved 脳 content"); reopened.destroy();
});
it("downloads exact recovery text and a reopenable complete-state JSON without another write", async () => {
  const blobs: Blob[] = [];
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { blobs.push(blob as Blob); return "blob:recovery"; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    render(<NoteEditor pageId="page-1" onStatus={() => {}} />); await failSave();
    fireEvent.click(screen.getByText("Download recovery text"));
    fireEvent.click(screen.getByText("Download recovery data with formatting"));
    expect(blobs).toHaveLength(2);
    const read = (blob: Blob) => new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    expect(await read(blobs[0])).toBe("Unsaved 脳 content");
    const data = JSON.parse(await read(blobs[1]));
    expect(data).toMatchObject({ format: "nou-note-recovery-v1", pageId: "page-1", editorFormat: "text-v1", plainText: "Unsaved 脳 content" });
    const reopened = new Y.Doc(); Y.applyUpdate(reopened, Uint8Array.from(data.update));
    expect(reopened.getText("body").toString()).toBe(data.plainText); reopened.destroy();
    expect(invoke.mock.calls.filter(([c]) => c === "save_note")).toHaveLength(1);
    expect(click.mock.instances.map(a => (a as HTMLAnchorElement).download)).toEqual(["nou-note-page-1.txt", "nou-note-page-1.json"]);
  } finally { create.mockRestore(); click.mockRestore(); }
});
it("keeps failed content and disables retry when recovery makes the note read-only", async () => {
  const onStatus = vi.fn(); const view = render(<NoteEditor pageId="page-1" onStatus={onStatus} />);
  await failSave(); view.rerender(<NoteEditor pageId="page-1" onStatus={onStatus} readOnly />);
  expect(screen.getByText("Retry saving all current content")).toHaveProperty("disabled", true);
  expect(screen.getByText("Download recovery text")).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Recovery text")).toHaveProperty("value", "Unsaved 脳 content");
});
it("ignores a previous note load that finishes after switching pages", async () => {
  const baseline = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((command, args) => args?.pageId === "slow" ? new Promise(resolve => { finish = resolve; }) : baseline(command, args));
  const view = render(<NoteEditor pageId="slow" onStatus={() => {}} />);
  view.rerender(<NoteEditor pageId="current" onStatus={() => {}} />);
  await screen.findByLabelText("Note content");
  finish({ updates: [], format: "unsupported", seq: 0, epoch: 0 });
  await waitFor(() => expect(screen.getByLabelText("Note content")).toHaveProperty("value", "Original"));
  expect(screen.queryByRole("alert")).toBeNull();
});
