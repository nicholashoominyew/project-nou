import { useEffect, useState } from "react";

// One shared Undo for the whole app. A feature that changes something calls pushUndo(label, undoFunction); Ctrl+Z (when you are not typing in a box) runs the newest one.
// Typing keeps its own Undo: inside a text box or the note editor, Ctrl+Z is left alone.
type Entry = { id: number; label: string; undo: () => Promise<unknown> | unknown };
const MAX = 50;
let stack: Entry[] = []; let next = 1;
export const UNDONE = "nou-undone";
const say = (detail: { label: string; failed?: string }) => { try { window.dispatchEvent(new CustomEvent(UNDONE, { detail })); } catch { /* only a hint for the toast */ } };

/** Remember how to take a change back. Returns an id so the feature's own Undo button can undo exactly this change. */
export function pushUndo(label: string, undo: Entry["undo"]): number {
  const id = next++; stack.push({ id, label, undo }); if (stack.length > MAX) stack = stack.slice(-MAX); return id;
}
async function run(e: Entry): Promise<boolean> {
  try { await e.undo(); say({ label: e.label }); return true; } catch (x) { say({ label: e.label, failed: String(x instanceof Error ? x.message : x) }); return false; }
}
/** Undo the newest change. Returns its label, or null when there is nothing to undo. */
export async function undoLatest(): Promise<string | null> { const e = stack.pop(); if (!e) return null; await run(e); return e.label; }
/** Undo one particular change (and forget it, so Ctrl+Z does not undo it a second time). */
export async function undoEntry(id: number): Promise<boolean> { const i = stack.findIndex(e => e.id === id); if (i < 0) return false; const [e] = stack.splice(i, 1); return run(e); }
export const undoCount = () => stack.length;
export function clearUndo() { stack = []; }

/** Ctrl+Z (Cmd+Z) outside text fields. */
export function isUndoKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return false;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest?.("[contenteditable=true],.bn-editor"))) return false;
  return true;
}

/** Listens for Ctrl+Z and shows a short "Undid …" note. Mounted once in the app. */
export function UndoHost() {
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (isUndoKey(e) && undoCount() > 0) { e.preventDefault(); void undoLatest(); } };
    const heard = (e: Event) => { const d = (e as CustomEvent<{ label: string; failed?: string }>).detail; setNote(d.failed ? { text: `Could not undo “${d.label}”: ${d.failed}`, bad: true } : { text: `Undid: ${d.label}` }); };
    window.addEventListener("keydown", key); window.addEventListener(UNDONE, heard);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener(UNDONE, heard); };
  }, []);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 4000); return () => clearTimeout(id); }, [note]);
  return note ? <div className={"undo-note" + (note.bad ? " bad" : "")} role="status">{note.text}</div> : null;
}
