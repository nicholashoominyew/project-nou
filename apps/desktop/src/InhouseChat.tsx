import { useEffect, useRef, useState } from "react";
import { MAX_BODY } from "./chatModel";
import { inhouseWord, type InhouseMessage } from "./hubModel";

export const INHOUSE_NAME = "Kura";

/** A private one-to-one chat with the local model. It is not the room: no other bot reads it and nothing here reaches the collaboration chat. */
export default function InhouseChat({ state, messages, error, disabled, onSend }: { state: string; messages: InhouseMessage[] | null; error: string; disabled?: boolean; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  async function send() {
    const t = text.trim();
    if (!t || sending || disabled) return;
    setSending(true);
    try { await onSend(t); setText(""); } finally { setSending(false); }
  }
  return <section className="hub-panel hub-inhouse" aria-label="In-house bot chat">
    <header className="hub-small-head">
      <div className="hub-avatar boxed" aria-hidden="true">KU</div>
      <div className="grow">
        <h2>In-house bot · {INHOUSE_NAME}</h2>
        <div className="hub-eyebrow tight">LOCAL MODEL · PRIVATE TO YOU</div>
      </div>
      <span className="hub-state" role="status" aria-label={"Status: " + inhouseWord(state)}><i className={"hub-dot " + (state === "running" ? "live" : state === "sleeping" ? "muted" : "hollow")} aria-hidden="true" />{inhouseWord(state)}</span>
    </header>
    <div className="hub-dm" ref={list} role="log" aria-label={"Chat with " + INHOUSE_NAME} aria-live="polite">
      {error && <p className="error" role="alert">{error}</p>}
      {messages && !messages.length && <p className="hub-empty small">Ask {INHOUSE_NAME} something. It answers from the local model on this computer, and only you see this chat.</p>}
      {messages?.map(m => <div key={m.id} className={"hub-bubble-row " + (m.author === "owner" ? "mine" : "theirs")}><div className="hub-bubble">{m.body}</div></div>)}
      {state === "offline" && !!messages?.length && <p className="hub-empty small">{INHOUSE_NAME} is offline, so it will answer when it is running again.</p>}
    </div>
    <form className="hub-dm-input" onSubmit={e => { e.preventDefault(); void send(); }}>
      <label><span className="sr-only">Ask {INHOUSE_NAME}</span>
        <input type="text" value={text} maxLength={MAX_BODY} disabled={disabled} placeholder={`Ask ${INHOUSE_NAME}…`} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      </label>
      <button type="submit" className="hub-iconbtn" aria-label={"Send to " + INHOUSE_NAME} disabled={disabled || sending || !text.trim()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-2-7-8-1z" /></svg>
      </button>
    </form>
  </section>;
}
