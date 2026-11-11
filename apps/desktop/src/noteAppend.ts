import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { invoke } from "@tauri-apps/api/core";
import { blocksToPlainText, FRAGMENT, noteSchema } from "./blockModel";
import { blockAttachmentIds } from "./noteTransfer";

type Loaded = { updates: number[][]; format: string; legacy_text: string | null; seq: number; epoch: number };
export type NewBlock = { type: "paragraph"; text: string } | { type: "checkListItem"; text: string; checked?: boolean };
export type AppendResult = { changed: boolean; message: string };

const normal = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
type AnyBlock = { type?: string; props?: Record<string, unknown>; content?: unknown; children?: readonly AnyBlock[] };
function* walk(blocks: readonly AnyBlock[]): Generator<AnyBlock> { for (const b of blocks) { yield b; if (b.children?.length) yield* walk(b.children); } }

/**
 * Add blocks to the end of a saved note, the way the editor itself would: load the note's Yjs state, bind an editor to it with the
 * same collaboration setup the visible editor uses, insert the blocks, and save the resulting state through the normal save command
 * (so validation, search indexing, the restore barrier and backups all apply). Used for changes a person has approved.
 *
 * A to-do whose text already exists on the page as a to-do is not added again.
 */
export async function appendBlocksToNote(pageId: string, blocks: NewBlock[]): Promise<AppendResult> {
  if (!blocks.length) return { changed: false, message: "Nothing to add" };
  const loaded = await invoke<Loaded>("load_note", { pageId });
  if (loaded.format !== "blocknote-v1") throw new Error("This note is in the old plain-text format. Open it and convert it to rich text first.");
  const doc = new Y.Doc();
  let editor: BlockNoteEditor<any, any, any> | undefined;
  const host = document.createElement("div");
  try {
    for (const update of loaded.updates) Y.applyUpdate(doc, Uint8Array.from(update));
    if (!doc.getXmlFragment(FRAGMENT).length) throw new Error("The note's rich-text content is missing, so nothing was changed");
    const ed = BlockNoteEditor.create(withCollaboration({ schema: noteSchema, collaboration: { fragment: doc.getXmlFragment(FRAGMENT), user: { name: "Approved request", color: "#52675a" } } }) as never) as unknown as BlockNoteEditor<any, any, any>;
    editor = ed;
    ed.mount(host);

    const existing = new Set<string>();
    for (const b of walk(ed.document as readonly AnyBlock[])) if (b.type === "checkListItem") existing.add(normal(blocksToPlainText([b])));
    const fresh = blocks.filter(b => b.type !== "checkListItem" || !existing.has(normal(b.text)));
    if (!fresh.length) return { changed: false, message: "That to-do is already on the page, so nothing was added" };

    const partial = fresh.map(b => b.type === "checkListItem"
      ? { type: "checkListItem", props: { checked: !!b.checked }, content: [{ type: "text", text: b.text, styles: {} }] }
      : { type: "paragraph", content: [{ type: "text", text: b.text, styles: {} }] });
    const top = ed.document as readonly AnyBlock[];
    const last = top[top.length - 1] as { id: string; type?: string; content?: unknown } | undefined;
    const lastIsEmptyParagraph = !!last && last.type === "paragraph" && blocksToPlainText([last]).trim() === "";
    // Keep the trailing empty line the editor leaves for typing: new blocks go in front of it.
    if (last) ed.insertBlocks(partial as never, last.id, lastIsEmptyParagraph ? "before" : "after"); else ed.replaceBlocks(ed.document, partial as never);

    const all = ed.document as readonly AnyBlock[];
    await invoke<number>("save_note", {
      pageId, update: Array.from(Y.encodeStateAsUpdate(doc)), plainText: blocksToPlainText(all), format: loaded.format, epoch: loaded.epoch,
      attachmentIds: blockAttachmentIds(all),
    });
    return { changed: true, message: fresh.length === 1 ? "Added 1 block" : `Added ${fresh.length} blocks` };
  } finally {
    try { editor?._tiptapEditor?.destroy?.(); } catch { /* the editor is discarded either way */ }
    doc.destroy();
  }
}
