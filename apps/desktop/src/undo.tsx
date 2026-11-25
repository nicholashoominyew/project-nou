import { useEffect, useState } from "react";

// One shared Undo and Redo for the whole app. A feature that changes something calls pushUndo(label, undo, redo): Ctrl+Z (when you are not typing in a box) runs the newest undo,
// Ctrl+Y (or Ctrl+Shift+Z) puts it back. Making a new change clears what could be redone. Typing keeps its own Undo: inside a text box or the note editor, both keys are left alone.
type Fn = () => Promise<unknown> | unknown;
type Entry = { id: number; label: string; undo: Fn; redo?: Fn };
const MAX = 50;
let stack: Entry[] = []; let redoStack: Entry[] = []; let next = 1;
export const UNDONE = "nou-undone";
const say = (detail: { label: string; failed?: string; redo?: boolean }) => { try { window.dispatchEvent(new CustomEvent(UNDONE, { detail })); } catch { /* only a hint for the toast */ } };

/** Remember how to take a change back (and, if given, how to do it again). Returns an id so the feature's own Undo button can undo exactly this change. */
export function pushUndo(label: string, undo: Fn, redo?: Fn): number {
  const id = next++; stack.push({ id, label, undo, redo }); if (stack.length > MAX) stack = stack.slice(-MAX); redoStack = []; return id;
}
async function runUndo(e: Entry): Promise<boolean> {
  try { await e.undo(); if (e.redo) redoStack.push(e); say({ label: e.label }); return true; } catch (x) { say({ label: e.label, failed: String(x instanceof Error ? x.message : x) }); return false; }
}
/** Undo the newest change. Returns its label, or null when there is nothing to undo. */
export async function undoLatest(): Promise<string | null> { const e = stack.pop(); if (!e) return null; await runUndo(e); return e.label; }
/** Undo one particular change (and forget it, so Ctrl+Z does not undo it a second time). */
export async function undoEntry(id: number): Promise<boolean> { const i = stack.findIndex(e => e.id === id); if (i < 0) return false; const [e] = stack.splice(i, 1); return runUndo(e); }
/** Do the change that was last undone again. Returns its label, or null when there is nothing to redo. */
export async function redoLatest(): Promise<string | null> {
  const e = redoStack.pop(); if (!e?.redo) return null;
  try { await e.redo(); stack.push(e); say({ label: e.label, redo: true }); } catch (x) { say({ label: e.label, redo: true, failed: String(x instanceof Error ? x.message : x) }); }
  return e.label;
}
export const undoCount = () => stack.length;
export const redoCount = () => redoStack.length;
export function clearUndo() { stack = []; redoStack = []; }

const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest?.("[contenteditable=true],.bn-editor")); };
/** Ctrl+Z (Cmd+Z) outside text fields. */
export function isUndoKey(e: KeyboardEvent): boolean { return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && !typing(e); }
/** Ctrl+Y, or Ctrl+Shift+Z, outside text fields. */
export function isRedoKey(e: KeyboardEvent): boolean { return (e.ctrlKey || e.metaKey) && !e.altKey && ((!e.shiftKey && e.key.toLowerCase() === "y") || (e.shiftKey && e.key.toLowerCase() === "z")) && !typing(e); }

/** Listens for Ctrl+Z and Ctrl+Y and shows a short "Undid …" / "Redid …" note. Mounted once in the app. */
export function UndoHost() {
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (isUndoKey(e) && undoCount() > 0) { e.preventDefault(); void undoLatest(); }
      else if (isRedoKey(e) && redoCount() > 0) { e.preventDefault(); void redoLatest(); }
    };
    const heard = (e: Event) => { const d = (e as CustomEvent<{ label: string; failed?: string; redo?: boolean }>).detail, verb = d.redo ? "redo" : "undo"; setNote(d.failed ? { text: `Could not ${verb} “${d.label}”: ${d.failed}`, bad: true } : { text: `${d.redo ? "Redid" : "Undid"}: ${d.label}` }); };
    window.addEventListener("keydown", key); window.addEventListener(UNDONE, heard);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener(UNDONE, heard); };
  }, []);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 4000); return () => clearTimeout(id); }, [note]);
  return note ? <div className={"undo-note" + (note.bad ? " bad" : "")} role="status">{note.text}</div> : null;
}
