import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import * as Y from "yjs";

// Attachments belong to the future independent Files system, not unbacked external media.
const { image: _image, video: _video, audio: _audio, file: _file, ...textBlocks } = defaultBlockSpecs;
export const noteSchema = BlockNoteSchema.create({ blockSpecs: textBlocks });
export const FRAGMENT = "nou-blocks-v1";
/** Convert a copy only; commit its bytes and format marker in one SQLite transaction. */
export function migrateLegacy(source: Y.Doc): Y.Doc {
  const migrated = new Y.Doc();
  Y.applyUpdate(migrated, Y.encodeStateAsUpdate(source));
  if (migrated.getXmlFragment(FRAGMENT).length) { migrated.destroy(); throw new Error("This note already contains rich blocks; refusing to overwrite them."); }
  const original = source.getText("body").toString();
  const importer = BlockNoteEditor.create({ schema: noteSchema, initialContent: original.split(/\r\n|\r|\n/).map(text => ({ type: "paragraph" as const, content: text })) });
  blocksToYXmlFragment(importer, importer.document, migrated.getXmlFragment(FRAGMENT));
  return migrated;
}
function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(inlineText).join("");
  if (!content || typeof content !== "object") return "";
  const item = content as { text?: string; content?: unknown; rows?: { cells: unknown[] }[] };
  if (typeof item.text === "string") return item.text;
  if (item.rows) return item.rows.map(row => row.cells.map(inlineText).join("\t")).join("\n");
  return inlineText(item.content);
}
export function blocksToPlainText(blocks: readonly { content?: unknown; children?: readonly any[] }[]): string {
  return blocks.map(b => inlineText(b.content) + (b.children?.length ? "\n" + blocksToPlainText(b.children) : "")).join("\n");
}
/** Failed writes stop later saves until an explicit complete-state retry. */
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  enqueue<T>(write: () => Promise<T>): Promise<T> {
    const next = this.tail.then(write); this.tail = next;
    void next.catch(() => undefined); return next;
  }
  reset() { this.tail = Promise.resolve(); }
  settled() { return this.tail.catch(() => undefined); }
}
