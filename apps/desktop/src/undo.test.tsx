import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearUndo, isRedoKey, isUndoKey, pushUndo, redoCount, redoLatest, UndoHost, undoCount, undoEntry, undoLatest } from "./undo";

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

describe("redo", () => {
  it("puts back what was undone, newest undo first, and goes round again", async () => {
    const log: string[] = [];
    pushUndo("one", () => { log.push("undo one"); }, () => { log.push("redo one"); }); pushUndo("two", () => { log.push("undo two"); }, () => { log.push("redo two"); });
    await undoLatest(); await undoLatest(); expect(redoCount()).toBe(2);
    expect(await redoLatest()).toBe("one"); expect(await redoLatest()).toBe("two"); expect(await redoLatest()).toBeNull();
    expect(log).toEqual(["undo two", "undo one", "redo one", "redo two"]);
    expect(await undoLatest()).toBe("two"); expect(log.at(-1)).toBe("undo two"); // a redone change can be undone again
  });
  it("a new change clears what could be redone, and a change with no redo function is simply not redoable", async () => {
    pushUndo("a", () => {}, () => {}); await undoLatest(); expect(redoCount()).toBe(1);
    pushUndo("b", () => {}, () => {}); expect(redoCount()).toBe(0);
    pushUndo("c", () => {}); await undoLatest(); expect(redoCount()).toBe(0);
  });
  it("recognises Ctrl+Y and Ctrl+Shift+Z outside text boxes only", () => {
    const ev = (init: KeyboardEventInit, target: HTMLElement = document.body) => { let seen = false; const f = (e: Event) => { seen = isRedoKey(e as KeyboardEvent); }; target.addEventListener("keydown", f, { once: true }); target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); return seen; };
    expect(ev({ key: "y", ctrlKey: true })).toBe(true); expect(ev({ key: "Y", metaKey: true })).toBe(true); expect(ev({ key: "z", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(ev({ key: "y" })).toBe(false); expect(ev({ key: "z", ctrlKey: true })).toBe(false); expect(ev({ key: "y", ctrlKey: true, shiftKey: true })).toBe(false);
    const input = document.createElement("input"); document.body.append(input); expect(ev({ key: "y", ctrlKey: true }, input)).toBe(false); input.remove();
    // Ctrl+Z is still only undo
    let undoSeen = false; const f = (e: Event) => { undoSeen = isUndoKey(e as KeyboardEvent) || isRedoKey(e as KeyboardEvent); }; document.body.addEventListener("keydown", f, { once: true }); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })); expect(undoSeen).toBe(true);
  });
  it("Ctrl+Z then Ctrl+Y undoes and redoes with a note each time, and leaves the key alone when there is nothing to redo", async () => {
    render(<UndoHost />); let n = 0; pushUndo("Ticked Exercise", () => { n--; }, () => { n++; });
    key({ key: "z", ctrlKey: true }); expect(await screen.findByText("Undid: Ticked Exercise")).toBeTruthy(); expect(n).toBe(-1);
    const redo = key({ key: "y", ctrlKey: true }); expect(redo.defaultPrevented).toBe(true); expect(await screen.findByText("Redid: Ticked Exercise")).toBeTruthy(); expect(n).toBe(0);
    expect(key({ key: "y", ctrlKey: true }).defaultPrevented).toBe(false);
    key({ key: "z", ctrlKey: true }); await screen.findByText("Undid: Ticked Exercise"); expect(key({ key: "Z", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true); // Ctrl+Shift+Z redoes too
  });
});
