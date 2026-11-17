import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { noteSchema } from "./blockModel";
import { nextPageStyle } from "./NouSideMenu";
import { EditorFeatures } from "./EditorContext";

const features = (open: (id: string) => void = () => {}) => ({ pages: [{ id: "child", title: "Gateway sub", parent_id: null, sort_key: "1", icon: "document" }], theme: "light" as const, canNavigate: true, open, create: async () => { throw Error("x"); }, upload: async () => null, uploadFile: async () => { throw Error("x"); }, onError: () => {}, setPeekBusy: () => {} });
function Doc({ blocks }: { blocks: unknown[] }) {
  const editor = useCreateBlockNote({ schema: noteSchema, initialContent: blocks as never });
  return <BlockNoteView editor={editor} sideMenu={false} />;
}

describe("page link style", () => {
  it("toggles between a line and a box", () => {
    expect(nextPageStyle("line")).toBe("box");
    expect(nextPageStyle("box")).toBe("line");
    expect(nextPageStyle(undefined)).toBe("line"); // an older link has no style and shows as a box, so the first toggle makes it a line
  });
  it("a page link keeps its style, and one saved without a style is a box", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    editor.insertBlocks([
      { type: "nouPage", props: { pageId: "a", label: "A", style: "line" } },
      { type: "nouPage", props: { pageId: "b", label: "B" } },
    ] as never, editor.document[0], "after");
    const links = editor.document.filter(b => b.type === ("nouPage" as never)) as unknown as { props: { style: string } }[];
    expect(links.map(b => b.props.style)).toEqual(["line", "box"]);
  });
  it("draws a line or a bordered box, with no size buttons, and the link still opens the page", async () => {
    const opened: string[] = [];
    const { container } = render(<EditorFeatures.Provider value={features(id => opened.push(id))}>
      <Doc blocks={[{ type: "nouPage", props: { pageId: "child", label: "Gateway sub", style: "line" } }, { type: "nouPage", props: { pageId: "child", label: "Gateway sub", style: "box" } }]} />
    </EditorFeatures.Provider>);
    await waitFor(() => expect(container.querySelectorAll(".page-link").length).toBe(2));
    expect(container.querySelectorAll(".page-link-line").length).toBe(1);
    expect(container.querySelectorAll(".page-link-box").length).toBe(1);
    expect(screen.queryByText("small")).toBeNull();
    expect(screen.queryByText("medium")).toBeNull();
    expect(screen.queryByText("big")).toBeNull();
    (container.querySelector(".page-link-box .page-link-open") as HTMLButtonElement).click();
    expect(opened).toEqual(["child"]);
  });
  it("a link to a page that is gone says so instead of failing", async () => {
    const { container } = render(<EditorFeatures.Provider value={{ ...features(), pages: [] }}>
      <Doc blocks={[{ type: "nouPage", props: { pageId: "missing", label: "Old title", style: "line" } }]} />
    </EditorFeatures.Provider>);
    await waitFor(() => expect(container.textContent).toContain("Old title (unavailable)"));
    expect((container.querySelector(".page-link-open") as HTMLButtonElement).disabled).toBe(true);
  });
});
