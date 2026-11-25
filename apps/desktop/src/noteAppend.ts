import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { invoke } from "@tauri-apps/api/core";
import { blocksToPlainText, FRAGMENT, noteSchema } from "./blockModel";
import { blockAttachmentIds } from "./noteTransfer";

type Loaded = { updates: number[][]; format: string; legacy_text: string | null; seq: number; epoch: number };
/** `raw` is a whole block (any type, with its props and children) as the editor holds it, used to move a block to another page. */
export type NewBlock = { type: "paragraph"; text: string } | { type: "bulletListItem"; text: string } | { type: "checkListItem"; text: string; checked?: boolean } | { type: "raw"; block: unknown };
export type AppendResult = { changed: boolean; message: string };
/** A block that was added, and its text as saved, so exactly that can be taken out again. */
export type AddedBlock = { id: string; text: string };

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
export async function appendBlocksToNote(pageId: string, blocks: NewBlock[], added?: AddedBlock[]): Promise<AppendResult> {
  if (!blocks.length) return { changed: false, message: "Nothing to add" };
  return withNote<AppendResult>(pageId, async ed => {
    const existing = new Set<string>();
    for (const b of walk(ed.document as readonly AnyBlock[])) if (b.type === "checkListItem") existing.add(normal(blocksToPlainText([b])));
    const embedded = new Set<string>();
    for (const b of walk(ed.document as readonly AnyBlock[])) if (b.type === "nouEmbed" && typeof b.props?.url === "string" && b.props.url) embedded.add(b.props.url);
    const isEmbed = (b: NewBlock) => b.type === "raw" && (b.block as AnyBlock)?.type === "nouEmbed";
    const fresh = blocks.filter(b => isEmbed(b) ? !embedded.has(String(((b as { block: AnyBlock }).block.props ?? {}).url ?? "") || "\u0000") : b.type === "raw" || b.type !== "checkListItem" || !existing.has(normal(b.text)));
    if (!fresh.length) return { save: false, out: { changed: false, message: blocks.some(isEmbed) ? "That page is already embedded here, so nothing was added" : "That to-do is already on the page, so nothing was added" } };

    const partial = fresh.map(b => b.type === "raw" ? b.block : b.type === "checkListItem"
      ? { type: "checkListItem", props: { checked: !!b.checked }, content: [{ type: "text", text: b.text, styles: {} }] }
      : { type: b.type === "bulletListItem" ? "bulletListItem" : "paragraph", content: [{ type: "text", text: b.text, styles: {} }] });
    const top = ed.document as readonly AnyBlock[];
    const last = top[top.length - 1] as { id: string; type?: string; content?: unknown } | undefined;
    const lastIsEmptyParagraph = !!last && last.type === "paragraph" && blocksToPlainText([last]).trim() === "";
    // Keep the trailing empty line the editor leaves for typing: new blocks go in front of it.
    const inserted = (last ? ed.insertBlocks(partial as never, last.id, lastIsEmptyParagraph ? "before" : "after") : ed.replaceBlocks(ed.document, partial as never).insertedBlocks) as unknown as (AnyBlock & { id: string })[];
    added?.push(...inserted.map(b => ({ id: b.id, text: blocksToPlainText([b]) })));
    return { save: true, out: { changed: true, message: fresh.length === 1 ? "Added 1 block" : `Added ${fresh.length} blocks` } };
  });
}

/** Take out blocks that were added earlier, only if every one is still there and says what it said then. Otherwise nothing changes. */
export async function removeAddedBlocks(pageId: string, added: AddedBlock[]): Promise<void> {
  await withNote<void>(pageId, async ed => {
    const found = added.map(a => ed.getBlock(a.id) as unknown as (AnyBlock & { id: string }) | undefined);
    if (found.some((b, i) => !b || b.children?.length || blocksToPlainText([b]) !== added[i].text)) throw new Error("You or someone else changed it since, so it was left as it is.");
    ed.removeBlocks(added.map(a => a.id) as never);
    return { save: true, out: undefined };
  });
}

/** Replace everything in a saved note with these blocks (used when a transcript is fetched again). */
export async function replaceNoteBlocks(pageId: string, blocks: NewBlock[]): Promise<void> {
  await withNote<void>(pageId, async ed => {
    const partial = blocks.map(b => b.type === "raw" ? b.block : { type: b.type === "checkListItem" || b.type === "bulletListItem" ? b.type : "paragraph", content: [{ type: "text", text: b.text, styles: {} }] });
    ed.replaceBlocks(ed.document, partial as never);
    return { save: true, out: undefined };
  });
}

/** The ids of the database blocks in a saved note. Reads only. */
export async function databaseBlocks(pageId: string): Promise<string[]> {
  return withNote<string[]>(pageId, async ed => {
    const found: string[] = [];
    for (const b of walk(ed.document as readonly AnyBlock[])) if (b.type === "nouDatabase" && typeof b.props?.databaseId === "string" && b.props.databaseId) found.push(b.props.databaseId);
    return { save: false, out: found };
  });
}

/** Load a saved note into a headless editor, let `change` edit it, and save it through the normal save command. */
async function withNote<T>(pageId: string, change: (ed: BlockNoteEditor<any, any, any>) => Promise<{ save: boolean; out: T }>): Promise<T> {
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
    const { save, out } = await change(ed);
    if (!save) return out;
    const all = ed.document as readonly AnyBlock[];
    await invoke<number>("save_note", {
      pageId, update: Array.from(Y.encodeStateAsUpdate(doc)), plainText: blocksToPlainText(all), format: loaded.format, epoch: loaded.epoch,
      attachmentIds: blockAttachmentIds(all),
    });
    return out;
  } finally {
    try { editor?._tiptapEditor?.destroy?.(); } catch { /* the editor is discarded either way */ }
    doc.destroy();
  }
}
