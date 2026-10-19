import { describe, it, expect, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks, withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { blocksToPlainText, migrateLegacy, FRAGMENT, noteSchema, SaveQueue } from "./blockModel";

describe("explicit legacy migration", () => {
  for (const text of ["", "脳 🧠 café\r\n\r\n# literal Markdown\r\n  spaces  \r\n", "one\ntwo\n", "<script>alert(1)</script>"]) {
    it(`preserves original and roundtrips ${JSON.stringify(text)}`, () => {
      const source = new Y.Doc(); source.getText("body").insert(0, text);
      const before = Y.encodeStateAsUpdate(source);
      const migrated = migrateLegacy(source);
      expect(Y.encodeStateAsUpdate(source)).toEqual(before);
      expect(source.getXmlFragment(FRAGMENT).length).toBe(0);
      const reopened = new Y.Doc(); Y.applyUpdate(reopened, Y.encodeStateAsUpdate(migrated));
      expect(reopened.getText("body").toString()).toBe(text);
      const editor = BlockNoteEditor.create({ schema: noteSchema });
      const blocks = yXmlFragmentToBlocks(editor, reopened.getXmlFragment(FRAGMENT));
      expect(blocksToPlainText(blocks)).toBe(text.replace(/\r\n|\r/g, "\n"));
      expect(blocks.every(b => b.type === "paragraph")).toBe(true);
      expect(() => migrateLegacy(migrated)).toThrow("already contains");
      source.destroy(); migrated.destroy(); reopened.destroy();
    });
  }
  it("reopens bold, headings, nested lists and table cells from persisted Yjs bytes", () => {
    const doc = migrateLegacy(new Y.Doc());
    const editor = BlockNoteEditor.create(withCollaboration({ schema: noteSchema, collaboration: { fragment: doc.getXmlFragment(FRAGMENT), user: { name: "test", color: "#000000" } } }));
    const container = document.createElement("div"); document.body.append(container); editor.mount(container);
    let saved: Uint8Array | undefined;
    editor.onChange(() => { saved = Y.encodeStateAsUpdate(doc); });
    editor.replaceBlocks(editor.document, [
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Heading", styles: { bold: true } }] },
      { type: "bulletListItem", content: "parent", children: [{ type: "checkListItem", props: { checked: true }, content: "child" }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["left", "right"] }] } },
    ]);
    const expected = editor.document;
    expect(saved).toBeDefined();
    const reopened = new Y.Doc(); Y.applyUpdate(reopened, saved!);
    const reader = BlockNoteEditor.create({ schema: noteSchema });
    const actual = yXmlFragmentToBlocks(reader, reopened.getXmlFragment(FRAGMENT));
    expect(actual).toEqual(expected);
    expect(blocksToPlainText(actual)).toBe("Heading\nparent\nchild\nleft\tright");
    editor.unmount(); container.remove(); doc.destroy(); reopened.destroy();
  });
  it("does not expose media blocks that cannot be backed up", () => {
    for (const name of ["image", "video", "audio", "file"]) expect(name in noteSchema.blockSchema).toBe(false);
  });
});

describe("save sequencing", () => {
  it("waits for the prior durable save before sending the next update", async () => {
    const q = new SaveQueue(); const calls: number[] = [];
    let finish!: () => void;
    const first = q.enqueue(() => new Promise<void>(resolve => { calls.push(1); finish = resolve; }));
    const second = q.enqueue(async () => { calls.push(2); });
    await Promise.resolve(); expect(calls).toEqual([1]); finish();
    await Promise.all([first, second]); expect(calls).toEqual([1,2]);
  });
  it("stops after failed persistence and allows explicit complete-state retry", async () => {
    const q = new SaveQueue(); const write = vi.fn(async () => 2);
    const a = q.enqueue(async () => { throw new Error("disk full"); });
    const b = q.enqueue(write);
    await expect(a).rejects.toThrow("disk full"); await expect(b).rejects.toThrow("disk full");
    expect(write).not.toHaveBeenCalled(); q.reset();
    await expect(q.enqueue(write)).resolves.toBe(2);
  });
});
