/**
 * Tab inside the note text should only ever indent or outdent. BlockNote declines to handle it when a block cannot be
 * indented any further (for example a second Tab on the first nested block), and then the browser moves keyboard focus
 * out of the editor to the next control, which is surprising while writing. This decides when to keep focus in place.
 *
 * Form controls inside blocks (database cells, bookmark fields) and other non-text targets keep normal Tab navigation.
 */
export type TabEvent = { key: string; defaultPrevented: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; target: unknown };

export function shouldTrapTab(event: TabEvent): boolean {
  if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return false;
  const target = event.target as { isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;
  if (!target || target.isContentEditable !== true) return false;
  return !target.closest?.("input,textarea,select,button,summary,a[href]");
}

// ---- Ctrl+Shift+H: apply the last used highlight colour (like Notion) ----
export const HIGHLIGHT_STORAGE_KEY = "nou-last-highlight";
export type Highlight = { backgroundColor?: string; textColor?: string };
export type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

export function isHighlightShortcut(e: KeyLike): boolean { return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h"; }

/** Remember the colour the person last used: whatever non-default colour the selection currently has. */
export function rememberHighlight(active: Record<string, unknown>, previous: Highlight): Highlight {
  const bg = active.backgroundColor, text = active.textColor;
  if (typeof bg === "string" && bg !== "default") return { backgroundColor: bg };
  if (typeof text === "string" && text !== "default") return { textColor: text };
  return previous;
}
/** The colour to apply: the last one used, or yellow background the first time. */
export function highlightToApply(last: Highlight): Highlight { return last.backgroundColor || last.textColor ? last : { backgroundColor: "yellow" }; }
/** Pressing the shortcut on text that already has that colour removes it. */
export function hasHighlight(active: Record<string, unknown>, h: Highlight): boolean {
  return (!!h.backgroundColor && active.backgroundColor === h.backgroundColor) || (!!h.textColor && active.textColor === h.textColor);
}
export function readHighlight(): Highlight {
  try { const v = JSON.parse(localStorage.getItem(HIGHLIGHT_STORAGE_KEY) || "null"); if (v && typeof v === "object") return { backgroundColor: typeof v.backgroundColor === "string" ? v.backgroundColor : undefined, textColor: typeof v.textColor === "string" ? v.textColor : undefined }; } catch { /* a preference only */ }
  return {};
}
export function writeHighlight(h: Highlight) { try { localStorage.setItem(HIGHLIGHT_STORAGE_KEY, JSON.stringify(h)); } catch { /* a preference only */ } }

/**
 * "/database" offers only *new* database. Existing databases (a linked view, or recovering an orphan) are listed only when
 * the person asks for them by typing "/linked" or "/existing", so the menu stays short.
 */
export function wantsExistingDatabases(slashQuery: string): boolean {
  const q = slashQuery.trim().toLowerCase();
  return q.startsWith("linked") || q.startsWith("existing");
}
