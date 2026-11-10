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
