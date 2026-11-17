import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { BOX_COLORS, TURN_INTO, boxColor, canTurnInto, copyBlock, matchesAction } from "./blockOps";
import { appendBlocksToNote } from "./noteAppend";
import { noteSchema, migrateLegacy } from "./blockModel";
import { inspectDocument } from "./noteTransfer";

const { state } = vi.hoisted(() => ({ state: { updates: [] as number[][] } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  if (command === "load_note") return { updates: state.updates, format: "blocknote-v1", legacy_text: null, seq: state.updates.length, epoch: 1 };
  if (command === "save_note") { state.updates = [...state.updates, args.update]; return state.updates.length; }
} }));

describe("menu helpers", () => {
  it("a copy of a block has no ids, keeps props and content, and copies children", () => {
    const original = { id: "x", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Hi", styles: {} }], children: [{ id: "y", type: "paragraph", props: {}, children: [] }] };
    const copy = copyBlock(original as never) as any;
    expect(copy.id).toBeUndefined(); expect(copy.children[0].id).toBeUndefined();
    expect(copy.props).toEqual({ level: 2 }); expect(copy.props).not.toBe(original.props);
    expect(copy.content).toEqual(original.content); expect(copy.children.length).toBe(1);
  });
  it("only text-like blocks can be turned into other text blocks", () => {
    for (const t of ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote", "codeBlock"]) expect(canTurnInto(t)).toBe(true);
    for (const t of ["nouPage", "nouImage", "nouDatabase", "nouFlowchart", "table"]) expect(canTurnInto(t)).toBe(false);
    expect(TURN_INTO.map(t => t.label)).toEqual(["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "To-do list", "Quote", "Code"]);
  });
  it("the menu search matches labels and keywords, ignoring case and spaces at the ends", () => {
    expect(matchesAction("  DUP ", "Duplicate")).toBe(true);
    expect(matchesAction("h2", "Heading 2", ["h2"])).toBe(true);
    expect(matchesAction("todo", "To-do list", ["todo", "check"])).toBe(true);
    expect(matchesAction("zzz", "Delete", ["remove"])).toBe(false);
    expect(matchesAction("", "anything")).toBe(true);
  });
  it("box colours are a fixed list; anything else is the default", () => {
    expect(BOX_COLORS[0]).toBe("default"); expect(boxColor("red")).toBe("red");
    for (const bad of ["#ff0000", "REDDISH", undefined, 5, "url(x)"]) expect(boxColor(bad)).toBe("default");
  });
});

describe("moving a block to another page", () => {
  it("adds the whole block, with its type, props and children, to the end of the other page", async () => {
    const seed = migrateLegacy(new Y.Doc());
    state.updates = [Array.from(Y.encodeStateAsUpdate(seed))];
    const source = BlockNoteEditor.create({ schema: noteSchema });
    source.insertBlocks([{ type: "nouPage", props: { pageId: "child", label: "Child", style: "box", boxBorder: "red", boxFill: "blue" } }, { type: "heading", props: { level: 2 }, content: "Moved heading", children: [{ type: "paragraph", content: "child line" }] }] as never, source.document[0], "after");
    const heading = source.document.find(b => b.type === "heading")!;
    const out = await appendBlocksToNote("other", [{ type: "raw", block: copyBlock(heading as never) }, { type: "raw", block: copyBlock(source.document.find(b => b.type === ("nouPage" as never)) as never) }]);
    expect(out.changed).toBe(true);
    const doc = new Y.Doc();
    for (const u of state.updates) Y.applyUpdate(doc, Uint8Array.from(u));
    const blocks = inspectDocument(doc, "blocknote-v1").blocks as any[];
    const h = blocks.find(b => b.type === "heading");
    expect(h.props.level).toBe(2);
    expect(JSON.stringify(h.content)).toContain("Moved heading");
    expect(JSON.stringify(h.children)).toContain("child line");
    const link = blocks.find(b => b.type === "nouPage");
    expect(link.props).toMatchObject({ pageId: "child", style: "box", boxBorder: "red", boxFill: "blue" });
  });
});
