import { render, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
// @ts-ignore node built-ins are available in the test runner
import { readFileSync } from "node:fs";
import { noteSchema } from "./blockModel";
import { EditorFeatures } from "./EditorContext";

const features = { pages: [], theme: "light" as const, canNavigate: true, open: () => {}, create: async () => { throw Error("x"); }, upload: async () => null, uploadFile: async () => { throw Error("x"); }, onError: () => {}, setPeekBusy: () => {} };
const doc = (n: number) => [{ type: "nouColumns", children: Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: "Column " + (i + 1) })) }];
function Doc({ blocks, editable = true }: { blocks: unknown[]; editable?: boolean }) {
  const editor = useCreateBlockNote({ schema: noteSchema, initialContent: blocks as never });
  return <BlockNoteView editor={editor} sideMenu={false} editable={editable} />;
}
// @ts-ignore process is available in the test runner
const css = readFileSync(process.cwd() + "/src/styles.css", "utf8") as string;

describe("columns block", () => {
  it("is part of the note schema and keeps its columns as children", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    editor.insertBlocks(doc(3) as never, editor.document[0], "after");
    const block = editor.document.find(b => b.type === ("nouColumns" as never))!;
    expect(block.children.map(c => (c.content as { text: string }[])[0].text)).toEqual(["Column 1", "Column 2", "Column 3"]);
  });
  it("renders the columns as sibling blocks under the columns block, which is what the stylesheet lays out side by side", async () => {
    const { container } = render(<EditorFeatures.Provider value={features}><Doc blocks={doc(2)} /></EditorFeatures.Provider>);
    await waitFor(() => expect(container.querySelector('[data-content-type="nouColumns"]')).not.toBeNull());
    const wrapper = container.querySelector(".bn-block > .node-nouColumns")!;
    const group = wrapper.parentElement!.querySelector(":scope > .bn-block-group")!;
    expect(group.querySelectorAll(":scope > .bn-block-outer").length).toBe(2);
    expect(container.textContent).toContain("2 columns");
  });
  it("the stylesheet lays the children of a columns block out in a row and stacks them on narrow windows", () => {
    expect(css).toMatch(/\.bn-block:has\(>\.node-nouColumns\)>\.bn-block-group\{display:flex;flex-direction:row/);
    expect(css).toMatch(/max-width:700px\)\{[^}]*node-nouColumns[^}]*flex-direction:column/);
  });
  it("Add column appends a column, up to five, and is hidden when the note is read-only", async () => {
    const { container, unmount } = render(<EditorFeatures.Provider value={features}><Doc blocks={doc(2)} /></EditorFeatures.Provider>);
    const add = await waitFor(() => { const b = container.querySelector('button[aria-label="Add a column"]') as HTMLButtonElement | null; if (!b) throw new Error("not yet"); return b; });
    fireEvent.click(add);
    await waitFor(() => expect(container.textContent).toContain("3 columns"));
    unmount();
    const ro = render(<EditorFeatures.Provider value={features}><Doc blocks={doc(2)} editable={false} /></EditorFeatures.Provider>);
    await waitFor(() => expect(ro.container.textContent).toContain("2 columns"));
    expect(ro.container.querySelector('button[aria-label="Add a column"]')).toBeNull();
  });
});
