import { useEffect, useRef, useState } from "react";
import { useDismiss } from "./Dismissible";
import { parseCapture } from "./captureParse";

/**
 * Ctrl+Shift+A: jot something down without leaving the page you are on. What you type is added to the end of your Inbox page.
 * Enter saves, Shift+Enter starts a new line, Esc closes. Start a line with [] to make it a to-do.
 */
export default function QuickCapture({ save, onOpenInbox, onClose, disabled }: { save: (text: string) => Promise<string>; onOpenInbox: () => void; onClose: () => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useDismiss(true, onClose, ref);
  useEffect(() => { box.current?.focus(); }, []);

  async function submit() {
    if (busy || disabled) return;
    setError(""); setNote("");
    try { parseCapture(text); } catch (e) { setError(String(e instanceof Error ? e.message : e)); return; }
    if (!text.trim()) { setError("Type something to capture."); return; }
    setBusy(true);
    try { setNote(await save(text)); setText(""); box.current?.focus(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  return <div className="quick-find-backdrop">
    <div className="quick-capture" role="dialog" aria-modal="true" aria-label="Quick capture" ref={ref}>
      <header><h2>Quick capture</h2><button onClick={onClose} aria-label="Close quick capture">Close</button></header>
      <textarea ref={box} aria-label="Capture text" rows={4} value={text} placeholder="Type a thought. Start a line with [] for a to-do." disabled={disabled}
        onChange={e => { setText(e.target.value); setNote(""); setError(""); }}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
      <div className="quick-capture-bar">
        <span className="hint">Enter saves to your Inbox · Shift+Enter new line · Esc closes</span>
        <button onClick={() => void submit()} disabled={busy || disabled || !text.trim()}>{busy ? "Saving…" : "Save"}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="hint" role="status">{note} <button className="link-button" onClick={onOpenInbox}>Open Inbox</button></p>}
    </div>
  </div>;
}
