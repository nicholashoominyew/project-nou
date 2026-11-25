import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearUndo, isUndoKey, pushUndo, UndoHost, undoCount, undoEntry, undoLatest } from "./undo";

beforeEach(() => clearUndo()); afterEach(cleanup);
const key = (init: KeyboardEventInit, target?: Element) => { const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }); (target ?? document.body).dispatchEvent(e); return e; };

describe("the shared undo", () => {
  it("undoes the newest change first, once each, and says when there is nothing", async () => {
    const log: string[] = []; pushUndo("one", () => { log.push("one"); }); pushUndo("two", async () => { log.push("two"); });
    expect(await undoLatest()).toBe("two"); expect(await undoLatest()).toBe("one"); expect(await undoLatest()).toBeNull();
    expect(log).toEqual(["two", "one"]);
  });
  it("undoes one particular change and forgets it, and keeps only the latest 50", async () => {
    const log: string[] = []; const a = pushUndo("a", () => { log.push("a"); }); pushUndo("b", () => { log.push("b"); });
    expect(await undoEntry(a)).toBe(true); expect(await undoEntry(a)).toBe(false); expect(undoCount()).toBe(1);
    clearUndo(); for (let i = 0; i < 60; i++) pushUndo("x" + i, () => {}); expect(undoCount()).toBe(50);
  });
  it("only reacts to Ctrl+Z (or Cmd+Z) and leaves typing boxes and the editor alone", () => {
    const input = document.createElement("input"); const edit = document.createElement("div"); edit.setAttribute("contenteditable", "true"); Object.defineProperty(edit, "isContentEditable", { value: true }); document.body.append(input, edit);
    const ev = (init: KeyboardEventInit, target: HTMLElement) => { let seen = false; const f = (e: Event) => { seen = isUndoKey(e as KeyboardEvent); }; target.addEventListener("keydown", f, { once: true }); target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); return seen; };
    expect(ev({ key: "z", ctrlKey: true }, document.body)).toBe(true); expect(ev({ key: "Z", metaKey: true }, document.body)).toBe(true);
    expect(ev({ key: "z", ctrlKey: true, shiftKey: true }, document.body)).toBe(false); expect(ev({ key: "z" }, document.body)).toBe(false); expect(ev({ key: "y", ctrlKey: true }, document.body)).toBe(false);
    expect(ev({ key: "z", ctrlKey: true }, input)).toBe(false); expect(ev({ key: "z", ctrlKey: true }, edit)).toBe(false);
    input.remove(); edit.remove();
  });
  it("Ctrl+Z runs the newest change and shows a note; a failure is reported, not swallowed", async () => {
    render(<UndoHost />);
    let ran = 0; pushUndo("Ticked Exercise", () => { ran++; });
    const e = key({ key: "z", ctrlKey: true }); expect(e.defaultPrevented).toBe(true);
    expect(await screen.findByText("Undid: Ticked Exercise")).toBeTruthy(); expect(ran).toBe(1);
    pushUndo("Deleted Anki", () => { throw new Error("db busy"); });
    await act(async () => { key({ key: "z", ctrlKey: true }); });
    expect(await screen.findByText(/Could not undo “Deleted Anki”: db busy/)).toBeTruthy();
    const nothing = key({ key: "z", ctrlKey: true }); expect(nothing.defaultPrevented).toBe(false); // nothing to undo: the key is left alone
    fireEvent.keyDown(window, { key: "z" });
  });
});
