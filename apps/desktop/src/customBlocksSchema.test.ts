import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema, blocksToPlainText } from "./blockModel";
import { serializeFlowchart, addNode, emptyChart, connect } from "./flowchart";
import { blockLinkedTodoIds } from "./noteTransfer";

/** The new blocks must be real members of the note schema: they survive being inserted into an editor and read back. */
describe("custom blocks in the real note schema", () => {
  it("a flowchart block keeps its data and is searchable", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    let c = addNode(emptyChart(), "Start", "terminal", "a").chart;
    c = connect(addNode(c, "Check the file", "decision", "b").chart, "a", "b");
    const data = serializeFlowchart(c);
    editor.insertBlocks([{ type: "nouFlowchart", props: { data } } as never], editor.document[0], "after");
    const block = editor.document.find(b => b.type === ("nouFlowchart" as never)) as { props: { data: string } } | undefined;
    expect(block?.props.data).toBe(data);
    expect(blocksToPlainText(editor.document as never)).toContain("Start → Check the file");
  });
  it("a linked to-do block keeps its id, text and tick, and is found by the index and by search", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    editor.insertBlocks([{ type: "nouLinkedTodo", props: { todoId: "todo-12345678", text: "Buy milk", checked: true } } as never], editor.document[0], "after");
    const block = editor.document.find(b => b.type === ("nouLinkedTodo" as never)) as { props: Record<string, unknown> } | undefined;
    expect(block?.props).toEqual({ todoId: "todo-12345678", text: "Buy milk", checked: true });
    expect(blockLinkedTodoIds(editor.document as never)).toEqual(["todo-12345678"]);
    expect(blocksToPlainText(editor.document as never)).toContain("Buy milk");
  });
});
