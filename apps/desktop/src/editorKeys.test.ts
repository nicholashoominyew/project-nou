import { describe, expect, it } from "vitest";
import { wantsExistingDatabases, hasHighlight, highlightToApply, isHighlightShortcut, rememberHighlight, shouldTrapTab, type TabEvent } from "./editorKeys";
// Node's fs is only used by this test; the app's tsconfig has no Node types, hence the ignore.
// @ts-ignore
import { readFileSync } from "node:fs";
declare const process: { cwd(): string };
const styles: string = readFileSync(process.cwd() + "/src/styles.css", "utf8");

const textTarget = { isContentEditable: true, closest: () => null };
const event = (extra: Partial<TabEvent> = {}): TabEvent => ({ key: "Tab", defaultPrevented: false, ctrlKey: false, altKey: false, metaKey: false, target: textTarget, ...extra });

describe("shouldTrapTab", () => {
  it("keeps Tab and Shift+Tab inside the note text when the editor did not handle them", () => {
    expect(shouldTrapTab(event())).toBe(true);
  });
  it("does nothing when the editor already handled the key, or for other keys and shortcuts", () => {
    expect(shouldTrapTab(event({ defaultPrevented: true }))).toBe(false);
    expect(shouldTrapTab(event({ key: "Enter" }))).toBe(false);
    expect(shouldTrapTab(event({ ctrlKey: true }))).toBe(false);
    expect(shouldTrapTab(event({ altKey: true }))).toBe(false);
    expect(shouldTrapTab(event({ metaKey: true }))).toBe(false);
  });
  it("leaves normal Tab navigation for form controls inside blocks and for non-editable targets", () => {
    expect(shouldTrapTab(event({ target: { isContentEditable: false, closest: () => null } }))).toBe(false);
    expect(shouldTrapTab(event({ target: { isContentEditable: true, closest: () => ({}) } }))).toBe(false);
    expect(shouldTrapTab(event({ target: null }))).toBe(false);
    expect(shouldTrapTab(event({ target: {} }))).toBe(false);
  });
});

describe("no flicker while typing (stylesheet rules)", () => {
  it("does not dim disabled buttons while the shell is in the typing state, and keeps the expand arrow rule out of the way", () => {
    expect(styles).toContain("button:disabled:not(:where(.shell.typing *))");
    expect(styles).not.toContain("button:disabled{opacity:.45;cursor:not-allowed}");
    expect(styles).not.toContain("button:disabled { opacity: .5; cursor: not-allowed; }");
    expect(styles).not.toContain(".tree-toggle:disabled{opacity:0}");
  });
  it("databases span the page: the block fills the text column and extends into the margins", () => {
    expect(styles).toContain('.bn-block-content[data-content-type="nouDatabase"]{display:block;width:100%;max-width:none}');
    expect(styles).toContain(".db-block{width:calc(100% + 2*(var(--doc-pad,52px) - 16px));margin-inline:calc(16px - var(--doc-pad,52px))");
    expect(styles).toMatch(/\.db-scroll,\.db-board,\.db-tl-scroll\{overflow-x:auto/);
  });
  it("hides the save status text while all is well, but not an error", () => {
    expect(styles).toMatch(/\.save-status\.save-quiet\{[^}]*clip:rect/);
    expect(styles).toMatch(/\.save-status\.save-failed\{/);
  });
});

describe("Ctrl+Shift+H highlight", () => {
  const key = (extra: object = {}) => ({ key: "H", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, ...extra });
  it("is recognised only as Ctrl (or Cmd) + Shift + H", () => {
    expect(isHighlightShortcut(key())).toBe(true);
    expect(isHighlightShortcut(key({ key: "h" }))).toBe(true);
    expect(isHighlightShortcut(key({ ctrlKey: false }))).toBe(false);
    expect(isHighlightShortcut(key({ shiftKey: false }))).toBe(false);
    expect(isHighlightShortcut(key({ altKey: true }))).toBe(false);
    expect(isHighlightShortcut(key({ key: "g" }))).toBe(false);
  });
  it("remembers the last non-default colour and falls back to yellow the first time", () => {
    expect(highlightToApply({})).toEqual({ backgroundColor: "yellow" });
    const used = rememberHighlight({ backgroundColor: "blue" }, {});
    expect(used).toEqual({ backgroundColor: "blue" });
    expect(highlightToApply(used)).toEqual({ backgroundColor: "blue" });
    expect(rememberHighlight({ backgroundColor: "default", textColor: "red" }, used)).toEqual({ textColor: "red" });
    expect(rememberHighlight({ backgroundColor: "default" }, used)).toBe(used);
    expect(rememberHighlight({}, used)).toBe(used);
  });
  it("pressing it on text that already has the colour means remove", () => {
    expect(hasHighlight({ backgroundColor: "blue" }, { backgroundColor: "blue" })).toBe(true);
    expect(hasHighlight({ backgroundColor: "red" }, { backgroundColor: "blue" })).toBe(false);
    expect(hasHighlight({ textColor: "red" }, { textColor: "red" })).toBe(true);
    expect(hasHighlight({}, { backgroundColor: "yellow" })).toBe(false);
  });
});

describe("slash menu", () => {
  it("lists existing databases only when asked for with /linked or /existing", () => {
    expect(wantsExistingDatabases("data")).toBe(false);
    expect(wantsExistingDatabases("database")).toBe(false);
    expect(wantsExistingDatabases("")).toBe(false);
    expect(wantsExistingDatabases("linked")).toBe(true);
    expect(wantsExistingDatabases("  Existing db")).toBe(true);
  });
});
