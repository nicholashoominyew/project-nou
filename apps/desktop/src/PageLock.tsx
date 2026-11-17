import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import { Icon } from "./Icons";
import { useDismiss } from "./Dismissible";
import { inspectDocument } from "./noteTransfer";

export const MIN_PASSWORD = 8;
/** Tells every lock control that a page was locked, unlocked or re-locked. */
export const announceLockChange = (pageId: string) => { try { window.dispatchEvent(new CustomEvent("nou:lock-changed", { detail: pageId })); } catch { /* only a refresh hint */ } };
const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

/** For a locked page: is the key currently in memory (unlocked for this session)? null while checking. */
export function useLockOpen(pageId: string, locked: boolean): boolean | null {
  const [open, setOpen] = useState<boolean | null>(locked ? null : false);
  const check = useCallback(() => {
    if (!locked) { setOpen(false); return; }
    invoke<{ locked: boolean; open: boolean }>("lock_state", { pageId }).then(s => setOpen(!!s?.open)).catch(() => setOpen(false));
  }, [pageId, locked]);
  useEffect(() => {
    setOpen(locked ? null : false); check();
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === pageId) check(); };
    window.addEventListener("nou:lock-changed", on);
    return () => window.removeEventListener("nou:lock-changed", on);
  }, [pageId, locked, check]);
  return open;
}

/** Shows the page content only when it is not locked, or when it has been unlocked in this session. */
export function LockGate({ pageId, locked, title, children }: { pageId: string; locked: boolean; title?: string; children: ReactNode }) {
  const open = useLockOpen(pageId, locked);
  if (!locked) return <>{children}</>;
  if (open === null) return <p role="status">Checking the lock…</p>;
  return open ? <>{children}</> : <LockScreen pageId={pageId} title={title} />;
}

export function LockScreen({ pageId, title }: { pageId: string; title?: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function unlock() {
    if (busy || !password) return;
    setBusy(true); setError("");
    try { await invoke("lock_unlock", { pageId, password }); setPassword(""); announceLockChange(pageId); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <section className="lock-screen" aria-label="Locked note">
    <Icon name="lock" size={34} />
    <h2>{title ? "“" + title + "” is locked" : "This note is locked"}</h2>
    <p className="hint">Its text is encrypted on this computer. Enter the password to read and edit it.</p>
    <form onSubmit={e => { e.preventDefault(); void unlock(); }}>
      <input type="password" aria-label="Password" autoFocus autoComplete="off" value={password} onChange={e => { setPassword(e.target.value); setError(""); }} />
      <button type="submit" disabled={busy || !password}>{busy ? "Unlocking…" : "Unlock"}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <p className="hint">There is no way to recover a forgotten password.</p>
  </section>;
}

type Mode = null | "set" | "menu" | "change" | "remove";

/** The single lock icon in the page toolbar. */
export function LockButton({ pageId, locked, disabled, onChanged }: { pageId: string; locked: boolean; disabled?: boolean; onChanged: () => void }) {
  const open = useLockOpen(pageId, locked);
  const [mode, setMode] = useState<Mode>(null);
  const [a, setA] = useState(""), [b, setB] = useState(""), [c, setC] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { setMode(null); setA(""); setB(""); setC(""); setError(""); };
  useDismiss(mode !== null, close, ref);
  useEffect(close, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (locked && !open) return null; // the lock screen takes over; nothing to do from the toolbar

  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); announceLockChange(pageId); onChanged(); close(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const tooShort = a.length < MIN_PASSWORD, mismatch = a !== b;
  const setIt = () => run(() => invoke("lock_set", { pageId, password: a }));
  const lockNow = () => run(() => invoke("lock_relock", { pageId }));
  const change = () => run(() => invoke("lock_change_password", { pageId, oldPassword: a, newPassword: b }));
  const remove = () => run(async () => {
    // The note's text goes back into the search index, so it is read once while it is still readable.
    const note = await invoke<{ updates: number[][]; format: string }>("load_note", { pageId });
    const doc = new Y.Doc();
    try { for (const u of note.updates) Y.applyUpdate(doc, Uint8Array.from(u)); await invoke("lock_remove", { pageId, password: a, plainText: inspectDocument(doc, note.format).plainText }); }
    finally { doc.destroy(); }
  });

  return <div className="page-lock" ref={ref}>
    <button aria-label={locked ? "Lock options" : "Lock this note"} aria-haspopup="dialog" aria-expanded={mode !== null} title={locked ? "This note is locked with a password" : "Lock this note with a password"} disabled={disabled}
      onClick={() => setMode(m => (m ? null : locked ? "menu" : "set"))}><Icon name={locked ? "lock" : "unlock"} size={16} /></button>
    {mode && <div className="page-lock-popover" role="dialog" aria-label="Lock">
      {mode === "set" && <form onSubmit={e => { e.preventDefault(); if (!tooShort && !mismatch) void setIt(); }}>
        <strong>Lock this note</strong>
        <p className="hint">Encrypts the text of this note with a password. The title, tags and any attached files are not encrypted. <b>If you forget the password, the note cannot be recovered.</b></p>
        <input type="password" aria-label="New password" placeholder={`Password (${MIN_PASSWORD}+ characters)`} autoComplete="off" autoFocus value={a} onChange={e => setA(e.target.value)} />
        <input type="password" aria-label="Repeat password" placeholder="Repeat the password" autoComplete="off" value={b} onChange={e => setB(e.target.value)} />
        {a && tooShort && <p className="hint">At least {MIN_PASSWORD} characters.</p>}{b && !tooShort && mismatch && <p className="hint">The two passwords differ.</p>}
        <button type="submit" disabled={busy || tooShort || mismatch}>{busy ? "Locking…" : "Lock this note"}</button>
      </form>}
      {mode === "menu" && <div className="page-lock-menu">
        <button onClick={() => void lockNow()} disabled={busy}>Lock now</button>
        <button onClick={() => setMode("change")}>Change password…</button>
        <button onClick={() => setMode("remove")}>Remove lock…</button>
      </div>}
      {mode === "change" && <form onSubmit={e => { e.preventDefault(); if (a && !(b.length < MIN_PASSWORD) && b === c) void change(); }}>
        <strong>Change password</strong>
        <input type="password" aria-label="Current password" autoComplete="off" autoFocus placeholder="Current password" value={a} onChange={e => setA(e.target.value)} />
        <input type="password" aria-label="New password" autoComplete="off" placeholder={`New password (${MIN_PASSWORD}+ characters)`} value={b} onChange={e => setB(e.target.value)} />
        <input type="password" aria-label="Repeat new password" autoComplete="off" placeholder="Repeat the new password" value={c} onChange={e => setC(e.target.value)} />
        {b && b.length < MIN_PASSWORD && <p className="hint">At least {MIN_PASSWORD} characters.</p>}{c && b !== c && <p className="hint">The two passwords differ.</p>}
        <button type="submit" disabled={busy || !a || b.length < MIN_PASSWORD || b !== c}>{busy ? "Changing…" : "Change password"}</button>
      </form>}
      {mode === "remove" && <form onSubmit={e => { e.preventDefault(); if (a) void remove(); }}>
        <strong>Remove the lock</strong>
        <p className="hint">The note's text will be stored unencrypted again and searchable.</p>
        <input type="password" aria-label="Current password" autoComplete="off" autoFocus placeholder="Current password" value={a} onChange={e => setA(e.target.value)} />
        <button type="submit" disabled={busy || !a}>{busy ? "Removing…" : "Remove lock"}</button>
      </form>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>}
  </div>;
}
