import type { PageInfo } from "./EditorContext";
import type { NewBlock } from "./noteAppend";

export const INBOX_KEY = "nou-inbox-page";
export const MAX_CAPTURE_LINES = 50, MAX_CAPTURE_LINE = 2000, MAX_CAPTURE_TOTAL = 20000;

/**
 * Turns what was typed into blocks. Each non-empty line is a paragraph; a line that starts with `[]`, `[ ]`, `- [ ]` is a to-do and `[x]` is a
 * ticked one. Control characters are dropped and nothing is read as markup.
 */
export function parseCapture(text: string): NewBlock[] {
  if (text.length > MAX_CAPTURE_TOTAL) throw new Error(`That is too long to capture at once (limit ${MAX_CAPTURE_TOTAL.toLocaleString("en")} characters)`);
  const lines = text.split(/\r?\n/).map(l => l.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()).filter(Boolean);
  if (lines.length > MAX_CAPTURE_LINES || lines.some(l => l.length > MAX_CAPTURE_LINE)) throw new Error(`Too many lines (${MAX_CAPTURE_LINES}) or a line over ${MAX_CAPTURE_LINE} characters`);
  return lines.map((line): NewBlock => {
    const m = /^(?:[-*]\s*)?\[([ xX]?)\]\s+(.+)$/.exec(line);
    return m ? { type: "checkListItem", text: m[2].trim(), checked: m[1].toLowerCase() === "x" } : { type: "paragraph", text: line };
  });
}

/** The page captures go to: the remembered one if it still exists, else a top-level page called Inbox, else none yet. */
export function pickInbox(pages: PageInfo[], remembered: string | null): string | null {
  if (remembered && pages.some(p => p.id === remembered)) return remembered;
  return pages.find(p => !p.parent_id && p.title.trim().toLowerCase() === "inbox")?.id ?? null;
}
