import type { PageInfo } from "./EditorContext";
import type { NewBlock } from "./noteAppend";

export const INBOX_KEY = "nou-inbox-page";
export const MAX_CAPTURE_LINES = 50, MAX_CAPTURE_LINE = 2000, MAX_CAPTURE_TOTAL = 20000;

/**
 * Turns what was typed into blocks. Each non-empty line is a paragraph; a line that starts with `- `, `* ` or `• ` is a bullet point; one that starts
 * with `[]`, `[ ]`, `- [ ]` is a to-do and `[x]` is a ticked one. Control characters are dropped and nothing is read as markup.
 */
export function parseCapture(text: string): NewBlock[] {
  if (text.length > MAX_CAPTURE_TOTAL) throw new Error(`That is too long to capture at once (limit ${MAX_CAPTURE_TOTAL.toLocaleString("en")} characters)`);
  const lines = text.split(/\r?\n/).map(l => l.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()).filter(Boolean);
  if (lines.length > MAX_CAPTURE_LINES || lines.some(l => l.length > MAX_CAPTURE_LINE)) throw new Error(`Too many lines (${MAX_CAPTURE_LINES}) or a line over ${MAX_CAPTURE_LINE} characters`);
  return lines.map((line): NewBlock => {
    const todo = /^(?:[-*•]\s*)?\[([ xX]?)\]\s+(.+)$/.exec(line);
    if (todo) return { type: "checkListItem", text: todo[2].trim(), checked: todo[1].toLowerCase() === "x" };
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    return bullet ? { type: "bulletListItem", text: bullet[1].trim() } : { type: "paragraph", text: line };
  });
}

/** The page captures go to: the remembered one if it still exists, else a top-level page called Inbox, else none yet. */
export function pickInbox(pages: PageInfo[], remembered: string | null): string | null {
  if (remembered && pages.some(p => p.id === remembered)) return remembered;
  return pages.find(p => !p.parent_id && p.title.trim().toLowerCase() === "inbox")?.id ?? null;
}

export const BULLET = "• ";
/** While typing: a "- " at the start of a line shows as a bullet point straight away. A dash inside a line, or "-5", is left alone. */
export const showBullets = (text: string): string => text.replace(/(^|\n)- /g, "$1" + BULLET);
/**
 * Shift+Enter inside a bullet line starts the next bullet; on an empty bullet it ends the list. `at` is the caret position.
 * Returns the new text and caret, or null when the line is not a bullet (so a normal new line is used).
 */
export function continueBullet(text: string, at: number): { text: string; caret: number } | null {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at) === -1 ? text.length : text.indexOf("\n", at);
  const line = text.slice(start, end);
  if (!line.startsWith(BULLET)) return null;
  if (line.trim() === BULLET.trim()) return { text: text.slice(0, start) + text.slice(end), caret: start }; // an empty bullet ends the list
  const insert = "\n" + BULLET;
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length };
}
