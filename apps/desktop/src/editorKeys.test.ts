import { describe, expect, it } from "vitest";
import { shouldTrapTab, type TabEvent } from "./editorKeys";
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
  it("hides the save status text while all is well, but not an error", () => {
    expect(styles).toMatch(/\.save-status\.save-quiet\{[^}]*clip:rect/);
    expect(styles).toMatch(/\.save-status\.save-failed\{/);
  });
});
