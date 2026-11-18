import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./blockModel";
import { canLink, fromLinked, ownText, toLinked, FROM_LINKED, MAX_LINKED_TEXT } from "./linkedConvert";

const { calls, store } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], store: { todo: null as null | { id: string; text: string; checked: boolean }, failCreate: "" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === "linked_todo_create") { if (store.failCreate) throw new Error(store.failCreate); store.todo = { id: "todo-12345678", text: args.text, checked: false }; return store.todo; }
  if (command === "linked_todo_set") { store.todo = { ...store.todo!, checked: args.checked ?? store.todo!.checked }; return store.todo; }
  if (command === "linked_todo_get") return store.todo ? [store.todo] : [];
} }));
beforeEach(() => { calls.length = 0; store.todo = null; store.failCreate = ""; });

const make = (blocks: unknown[]) => { const ed = BlockNoteEditor.create({ schema: noteSchema }); ed.insertBlocks(blocks as never, ed.document[0], "after"); return ed; };
// the editor always starts with one empty paragraph, so a paragraph under test is the last one
const find = (ed: any, type: string) => [...ed.document].reverse().find((b: any) => b.type === type);

describe("turning a list item or checkbox into a linked to-do", () => {
  it("only plain text, bullets, numbered items and checkboxes can be linked", () => {
    for (const t of ["paragraph", "bulletListItem", "numberedListItem", "checkListItem"]) expect(canLink(t)).toBe(true);
    for (const t of ["heading", "quote", "codeBlock", "nouPage", "nouLinkedTodo", "nouFlowchart"]) expect(canLink(t)).toBe(false);
  });
  for (const [type, label] of [["checkListItem", "a checkbox"], ["bulletListItem", "a bullet"], ["numberedListItem", "a numbered item"], ["paragraph", "a plain line"]] as const) {
    it(`${label} becomes a linked to-do with the same text`, async () => {
      const ed = make([{ type, content: "Buy milk" }]);
      await toLinked(ed as never, find(ed, type));
      expect(ed.document.some((b: any) => b.type === type && ownText(b) === "Buy milk")).toBe(false);
      expect(find(ed, "nouLinkedTodo").props).toEqual({ todoId: "todo-12345678", text: "Buy milk", checked: false });
      expect(calls.map(c => c.command)).toEqual(["linked_todo_create"]);
      expect(calls[0].args).toEqual({ text: "Buy milk" });
    });
  }
  it("a ticked checkbox makes a ticked linked to-do", async () => {
    const ed = make([{ type: "checkListItem", props: { checked: true }, content: "Done thing" }]);
    await toLinked(ed as never, find(ed, "checkListItem"));
    expect(find(ed, "nouLinkedTodo").props.checked).toBe(true);
    expect(calls.map(c => c.command)).toEqual(["linked_todo_create", "linked_todo_set"]);
    expect(calls[1].args).toEqual({ id: "todo-12345678", checked: true, text: null });
  });
  it("keeps what is nested under the block, drops bold and other styling from the text, and joins the text of several pieces", async () => {
    const ed = make([{ type: "bulletListItem", content: [{ type: "text", text: "Call ", styles: { bold: true } }, { type: "text", text: "Sam", styles: {} }], children: [{ type: "paragraph", content: "about the visa" }] }]);
    await toLinked(ed as never, find(ed, "bulletListItem"));
    const linked = find(ed, "nouLinkedTodo");
    expect(linked.props.text).toBe("Call Sam");
    expect(linked.children.length).toBe(1);
    expect(JSON.stringify(linked.children[0].content)).toContain("about the visa");
  });
  it("refuses a line that is too long, and a block that cannot be linked, and changes nothing", async () => {
    const long = make([{ type: "paragraph", content: "x".repeat(MAX_LINKED_TEXT + 1) }]);
    await expect(toLinked(long as never, find(long, "paragraph"))).rejects.toThrow(/at most 500/);
    expect(find(long, "nouLinkedTodo")).toBeUndefined();
    const heading = make([{ type: "heading", content: "Title" }]);
    await expect(toLinked(heading as never, find(heading, "heading"))).rejects.toThrow(/cannot become/);
    expect(calls).toEqual([]);
  });
  it("if the shared to-do cannot be made, the block stays exactly as it was", async () => {
    store.failCreate = "The notes are read-only";
    const ed = make([{ type: "checkListItem", content: "Keep me" }]);
    await expect(toLinked(ed as never, find(ed, "checkListItem"))).rejects.toThrow("read-only");
    expect(ownText(find(ed, "checkListItem"))).toBe("Keep me");
    expect(find(ed, "nouLinkedTodo")).toBeUndefined();
  });
});

describe("turning a linked to-do back into an ordinary block", () => {
  const linked = () => make([{ type: "nouLinkedTodo", props: { todoId: "todo-12345678", text: "Old copy", checked: false } }]);
  it("offers text, bullets, numbered items and checkboxes", () => {
    expect(FROM_LINKED.map(t => t.label)).toEqual(["Text", "Bulleted list", "Numbered list", "To-do list"]);
  });
  it("uses the shared to-do's text and tick as they are now, not the older copy in the note", async () => {
    store.todo = { id: "todo-12345678", text: "Fresh text", checked: true };
    const ed = linked();
    await fromLinked(ed as never, find(ed, "nouLinkedTodo"), "checkListItem");
    expect(find(ed, "nouLinkedTodo")).toBeUndefined();
    const b = find(ed, "checkListItem");
    expect(b.props.checked).toBe(true);
    expect(ownText(b)).toBe("Fresh text");
  });
  for (const t of FROM_LINKED) {
    it(`becomes ${t.label.toLowerCase()}`, async () => {
      store.todo = { id: "todo-12345678", text: "Plan the trip", checked: false };
      const ed = linked();
      await fromLinked(ed as never, find(ed, "nouLinkedTodo"), t.type);
      expect(ownText(find(ed, t.type))).toBe("Plan the trip");
    });
  }
  it("falls back to the saved copy when the shared to-do is missing, and never deletes the shared record", async () => {
    store.todo = null;
    const ed = linked();
    await fromLinked(ed as never, find(ed, "nouLinkedTodo"), "bulletListItem");
    expect(ownText(find(ed, "bulletListItem"))).toBe("Old copy");
    expect(calls.map(c => c.command)).toEqual(["linked_todo_get"]);
  });
  it("round trip: a checkbox, linked and then unlinked, is the same checkbox", async () => {
    const ed = make([{ type: "checkListItem", props: { checked: true }, content: "Pay rent" }]);
    await toLinked(ed as never, find(ed, "checkListItem"));
    await fromLinked(ed as never, find(ed, "nouLinkedTodo"), "checkListItem");
    const b = find(ed, "checkListItem");
    expect(ownText(b)).toBe("Pay rent"); expect(b.props.checked).toBe(true);
  });
  it("refuses a block that is not a linked to-do", async () => {
    const ed = make([{ type: "paragraph", content: "x" }]);
    await expect(fromLinked(ed as never, find(ed, "paragraph"), "paragraph")).rejects.toThrow(/not a linked/);
  });
});
