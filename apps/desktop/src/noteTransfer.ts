import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { blocksToPlainText, FRAGMENT, noteSchema } from "./blockModel";
export const RECOVERY_FORMAT = "nou-note-recovery-v1";
export type Transfer = { format: typeof RECOVERY_FORMAT; pageId: string; title?: string; editorFormat: "text-v1" | "blocknote-v1"; plainText: string; legacyText?: string | null; update: number[]; files?:{id:string;name:string;data:number[]}[] };
export function inspectDocument(doc: Y.Doc, format: string) {
  if (format === "text-v1") {
    if (doc.getXmlFragment(FRAGMENT).length) throw new Error("Plain-text file also contains rich blocks; choose the correct original recovery file.");
    return { plainText: doc.getText("body").toString(), blocks: undefined, editor: undefined };
  }
  if (format !== "blocknote-v1" || !doc.getXmlFragment(FRAGMENT).length) throw new Error("Missing or unsupported rich-text state.");
  const editor = BlockNoteEditor.create({ schema: noteSchema });
  const blocks = yXmlFragmentToBlocks(editor, doc.getXmlFragment(FRAGMENT));
  let count = 0;
  const check = (items: typeof blocks, depth = 0) => {
    if (depth > 64) throw new Error("Recovery nesting exceeds supported depth.");
    for (const block of items) {
      if (++count > 100000 || !(block.type in noteSchema.blockSchema)) throw new Error("Recovery contains unsupported blocks.");
      if (block.children?.length) check(block.children, depth + 1);
    }
  };
  check(blocks);
  return { plainText: blocksToPlainText(blocks), blocks, editor };
}
export function recoveryData(doc: Y.Doc, format: "text-v1" | "blocknote-v1", pageId: string, title?: string, legacyText?: string | null): Transfer {
  const { plainText } = inspectDocument(doc, format);
  return { format: RECOVERY_FORMAT, pageId, title, editorFormat: format, plainText, legacyText, update: Array.from(Y.encodeStateAsUpdate(doc)) };
}
/** Never trust the text cache or original page ID supplied by an imported file. */
export function parseRecovery(json: string): Transfer {
  if (json.length > 40*1024*1024) throw new Error("Recovery file exceeds 40 MB.");
  const value = JSON.parse(json);
  if (!value || value.format !== RECOVERY_FORMAT || !["text-v1", "blocknote-v1"].includes(value.editorFormat) ||
      !Array.isArray(value.update) || !value.update.length || value.update.length > 8*1024*1024 ||
      value.update.some((n: unknown) => typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) ||
      (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 1000)) ||
      (value.legacyText != null && (typeof value.legacyText !== "string" || value.legacyText.length > 5_000_000))) throw new Error("Unsupported or malformed NOU note recovery file.");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Uint8Array.from(value.update));
    // A delta with missing dependencies is not a complete recovery state.
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error("Recovery file is incomplete; a complete note state is required.");
    const result = recoveryData(doc, value.editorFormat, typeof value.pageId === "string" ? value.pageId : "", value.title, value.legacyText);
    if (result.plainText.length > 5_000_000) throw new Error("Recovered note exceeds supported text size.");
    if(value.files!==undefined){
      if(!Array.isArray(value.files)||value.files.length>100)throw Error("Invalid recovery file collection");let total=0;
      for(const f of value.files){if(!f||typeof f.name!=="string"||f.name.length>1000||typeof f.id!=="string"||!/^[a-f0-9]{64}$/.test(f.id)||!Array.isArray(f.data)||f.data.length>20*1024*1024||f.data.some((n:unknown)=>typeof n!=="number"||!Number.isInteger(n)||n<0||n>255))throw Error("Invalid recovery attachment");total+=f.data.length;}
      if(total>20*1024*1024)throw Error("Use a complete backup for note files larger than 20 MB.");result.files=value.files;
    }
    return result;
  } finally { doc.destroy(); }
}
export function exportNote(doc: Y.Doc, format: "text-v1" | "blocknote-v1", pageId: string, title: string, kind: "txt" | "md" | "html" | "json", legacyText?: string | null): string {
  const { plainText, blocks, editor } = inspectDocument(doc, format);
  if (kind === "json") return JSON.stringify(recoveryData(doc, format, pageId, title, legacyText), null, 2);
  if (kind === "txt") return plainText;
  if (kind === "md") return editor && blocks ? editor.blocksToMarkdownLossy(blocks) : plainText;
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = editor && blocks ? editor.blocksToHTMLLossy(blocks) : `<pre>${escape(plainText)}</pre>`;
  // Exports cannot run scripts or load external resources when opened locally.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

export function blockAttachmentIds(blocks:readonly {type?:string;props?:Record<string,unknown>;children?:readonly any[]}[]):string[]{
 const ids=new Set<string>();const walk=(items:typeof blocks)=>{for(const b of items){if(b.type==="nouImage"||b.type==="nouPdf"){const id=b.props?.fileId;if(typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id))throw Error("Invalid attachment reference");ids.add(id)}if(b.children)walk(b.children)}};walk(blocks);return [...ids];
}
export function documentAttachmentIds(doc:Y.Doc,format:string):string[]{const data=inspectDocument(doc,format);return data.blocks?blockAttachmentIds(data.blocks):[];}
