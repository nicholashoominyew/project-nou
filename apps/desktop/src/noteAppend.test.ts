import * as Y from "yjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendBlocksToNote } from "./noteAppend";
import { blocksToPlainText, migrateLegacy } from "./blockModel";
import { inspectDocument } from "./noteTransfer";

const { calls, state } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], state: { updates: [] as number[][], format: "blocknote-v1" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "load_note") return { updates: state.updates, format: state.format, legacy_text: null, seq: state.updates.length, epoch: 3 };
  if (command === "save_note") { state.updates = [...state.updates, args.update]; return state.updates.length; }
} }));

/** Decode what was saved the way opening the note would, and return its blocks. */
function savedBlocks() {
  const doc = new Y.Doc();
  for (const u of state.updates) Y.applyUpdate(doc, Uint8Array.from(u));
  return inspectDocument(doc, "blocknote-v1").blocks as any[];
}
const textOf = (b: any) => blocksToPlainText([b]).trim();
function startWith(...paragraphs: string[]) {
  const seed = migrateLegacy(new Y.Doc());
  state.updates = [Array.from(Y.encodeStateAsUpdate(seed))];
  state.format = "blocknote-v1";
  return paragraphs;
}
beforeEach(() => { calls.length = 0; startWith(); });

describe("appendBlocksToNote", () => {
  it("adds paragraphs to a note through the normal save command, keeping the trailing empty line last", async () => {
    const out = await appendBlocksToNote("p1", [{ type: "paragraph", text: "First added line" }, { type: "paragraph", text: "Second added line" }]);
    expect(out).toEqual({ changed: true, message: "Added 2 blocks" });
    const blocks = savedBlocks();
    const texts = blocks.map(textOf);
    expect(texts).toContain("First added line");
    expect(texts.indexOf("First added line")).toBeLessThan(texts.indexOf("Second added line"));
    expect(texts[texts.length - 1]).toBe("");
    const save = calls.find(c => c.command === "save_note")!.args;
    expect(save).toMatchObject({ pageId: "p1", format: "blocknote-v1", epoch: 3 });
    expect(save.plainText).toContain("First added line");
    expect(Array.isArray(save.attachmentIds)).toBe(true);
  });
  it("adds a to-do as a real checklist item, checked or not", async () => {
    await appendBlocksToNote("p1", [{ type: "checkListItem", text: "Call Sam" }, { type: "checkListItem", text: "Done already", checked: true }]);
    const items = savedBlocks().filter(b => b.type === "checkListItem");
    expect(items.map(textOf)).toEqual(["Call Sam", "Done already"]);
    expect(items.map(b => b.props.checked)).toEqual([false, true]);
  });
  it("does not add a to-do that is already on the page (case and spacing ignored), and does not save", async () => {
    await appendBlocksToNote("p1", [{ type: "checkListItem", text: "Call Sam" }]);
    calls.length = 0;
    const again = await appendBlocksToNote("p1", [{ type: "checkListItem", text: "  call   SAM " }]);
    expect(again.changed).toBe(false);
    expect(again.message).toMatch(/already on the page/);
    expect(calls.some(c => c.command === "save_note")).toBe(false);
    expect(savedBlocks().filter(b => b.type === "checkListItem").length).toBe(1);
  });
  it("adds only the new to-dos when some already exist", async () => {
    await appendBlocksToNote("p1", [{ type: "checkListItem", text: "One" }]);
    const out = await appendBlocksToNote("p1", [{ type: "checkListItem", text: "One" }, { type: "checkListItem", text: "Two" }]);
    expect(out).toEqual({ changed: true, message: "Added 1 block" });
    expect(savedBlocks().filter(b => b.type === "checkListItem").map(textOf)).toEqual(["One", "Two"]);
  });
  it("keeps what was already in the note", async () => {
    await appendBlocksToNote("p1", [{ type: "paragraph", text: "Original line" }]);
    await appendBlocksToNote("p1", [{ type: "paragraph", text: "Later line" }]);
    const texts = savedBlocks().map(textOf);
    expect(texts.indexOf("Original line")).toBeLessThan(texts.indexOf("Later line"));
  });
  it("treats the text as plain text, never as markup", async () => {
    await appendBlocksToNote("p1", [{ type: "paragraph", text: "<img src=x onerror=alert(1)> **not bold** [[link]]" }]);
    const added = savedBlocks().find(b => textOf(b).startsWith("<img"));
    expect(added).toBeTruthy();
    expect(textOf(added)).toBe("<img src=x onerror=alert(1)> **not bold** [[link]]");
    expect(added.type).toBe("paragraph");
  });
  it("refuses an old plain-text note without changing it", async () => {
    state.format = "text-v1";
    await expect(appendBlocksToNote("p1", [{ type: "paragraph", text: "x" }])).rejects.toThrow(/plain-text format/);
    expect(calls.some(c => c.command === "save_note")).toBe(false);
  });
  it("does nothing for an empty request", async () => {
    expect(await appendBlocksToNote("p1", [])).toEqual({ changed: false, message: "Nothing to add" });
    expect(calls.length).toBe(0);
  });
});
