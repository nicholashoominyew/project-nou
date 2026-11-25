// A link to one block of one page. It is an https address so the editor, exports and other apps treat it as a link, on a host that can never
// exist (".invalid" is reserved), so outside NOU it leads nowhere and nothing about the note is sent anywhere. Inside NOU a click opens the page at the block.
const PREFIX = "https://nou.invalid/page/";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const blockLink = (pageId: string, blockId: string): string => `${PREFIX}${pageId}#${blockId}`;

export function parseBlockLink(href: string): { pageId: string; blockId: string } | null {
  const text = href.trim();
  if (!text.startsWith(PREFIX)) return null;
  const [pageId, blockId, ...rest] = text.slice(PREFIX.length).split("#");
  return !rest.length && ID.test(pageId ?? "") && ID.test(blockId ?? "") ? { pageId, blockId } : null;
}

export const copyBlockLink = (pageId: string, blockId: string): Promise<void> => navigator.clipboard.writeText(blockLink(pageId, blockId));

/** Scroll to a block and outline it for a moment. The page may still be opening, so it is looked for for a few seconds. */
export function revealBlock(blockId: string, tries = 40): void {
  if (!ID.test(blockId)) return;
  const selector = `.bn-editor .bn-block-outer[data-id="${blockId}"]>.bn-block>.bn-block-content`;
  const target = document.querySelector(selector);
  if (!target) { if (tries > 0) setTimeout(() => revealBlock(blockId, tries - 1), 100); return; }
  target.scrollIntoView?.({ block: "center" });
  // A style rule rather than a class, so nothing inside the editor's own page is touched.
  const style = document.createElement("style");
  style.textContent = `${selector}{outline:1px solid color-mix(in srgb,var(--muted) 55%,transparent);outline-offset:3px;border-radius:6px}`;
  document.head.append(style);
  setTimeout(() => style.remove(), 2000);
}
