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
  it("adds bullet points as real bullet list items", async () => {
    const out = await appendBlocksToNote("p1", [{ type: "bulletListItem", text: "first point" }, { type: "bulletListItem", text: "second point" }]);
    expect(out.changed).toBe(true);
    const bullets = savedBlocks().filter(b => b.type === "bulletListItem");
    expect(bullets.map(textOf)).toEqual(["first point", "second point"]);
  });
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
  it("adds an embed block with all its fields to the real note schema, keeps it searchable, and does not add the same address twice", async () => {
    const block = { type: "nouEmbed", props: { url: "https://claude.ai/artifact/abc", title: "Chart", height: 600, mode: "live", fileId: "" } };
    const out = await appendBlocksToNote("p1", [{ type: "raw", block }]);
    expect(out).toEqual({ changed: true, message: "Added 1 block" });
    const embeds = savedBlocks().filter(b => b.type === "nouEmbed");
    expect(embeds).toHaveLength(1); expect(embeds[0].props).toEqual(block.props);
    expect(textOf(embeds[0])).toBe("Chart https://claude.ai/artifact/abc");
    const save = calls.filter(c => c.command === "save_note").at(-1)!; expect(save.args.attachmentIds).toEqual([]); expect(save.args.plainText).toContain("https://claude.ai/artifact/abc");
    const again = await appendBlocksToNote("p1", [{ type: "raw", block }]);
    expect(again).toEqual({ changed: false, message: "That page is already embedded here, so nothing was added" }); expect(savedBlocks().filter(b => b.type === "nouEmbed")).toHaveLength(1);
    const other = await appendBlocksToNote("p1", [{ type: "raw", block: { ...block, props: { ...block.props, url: "https://claude.ai/artifact/def" } } }]); expect(other.changed).toBe(true);
  });
  it("a snapshot embed keeps its stored file in the note's attachment list, so the file is not thrown away", async () => {
    const fileId = "e".repeat(64);
    await appendBlocksToNote("p1", [{ type: "raw", block: { type: "nouEmbed", props: { url: "", title: "Saved", height: 480, mode: "snapshot", fileId } } }]);
    expect(calls.filter(c => c.command === "save_note").at(-1)!.args.attachmentIds).toEqual([fileId]);
    const snap = savedBlocks().find(b => b.type === "nouEmbed")!; expect(snap.props).toMatchObject({ mode: "snapshot", fileId });
  });
});
