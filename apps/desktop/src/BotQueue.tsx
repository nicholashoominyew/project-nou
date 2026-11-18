import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Approvals from "./Approvals";
import { authorTone, clock, continues, lastId, mergeMessages, MAX_BODY, type ChatMessage } from "./chatModel";

const POLL_MS = 3000;

/**
 * The Bots Hub: a Chat tab, one shared chat for you and your AI assistants. An assistant reads and posts through the local API with a token that has the chat
 * scopes, and signs with its token's name. Everything here is plain text, and nothing said in the chat changes a note.
 * A Queue tab lists what assistants have asked to change, for you to approve or reject.
 */
export default function BotQueue({ disabled, onSeen, refresh = async () => {}, pollMs = POLL_MS }: { disabled?: boolean; onSeen: (lastId: number) => void; refresh?: () => Promise<void>; pollMs?: number }) {
  const [tab, setTab] = useState<"chat" | "queue">("chat");
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSeen = useRef(0);

  const load = useCallback(async () => {
    try {
      const got = await invoke<ChatMessage[]>("chat_list", lastSeen.current ? { after: lastSeen.current, limit: 200 } : { limit: 100 });
      if (!Array.isArray(got)) return;
      setMessages(old => (lastSeen.current === 0 && !got.length ? [] : mergeMessages(old ?? [], got)));
      if (got.length) lastSeen.current = Math.max(lastSeen.current, lastId(got));
      setError("");
    } catch (e) { setError(String(e)); setMessages(old => old ?? []); }
  }, []);
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), pollMs); return () => window.clearInterval(t); }, [load, pollMs]);
  useEffect(() => { if (tab === "chat" && messages?.length) onSeen(lastId(messages)); }, [messages, onSeen, tab]);
  useEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages]);

  async function send() {
    const body = text.trim();
    if (!body || sending || disabled) return;
    setSending(true); setError("");
    try {
      const m = await invoke<ChatMessage>("chat_post", { body });
      setText(""); stick.current = true;
      setMessages(old => mergeMessages(old ?? [], [m])); lastSeen.current = Math.max(lastSeen.current, m.id);
    } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error: /, "")); }
    finally { setSending(false); }
  }
  async function clear() {
    setConfirmClear(false);
    try { await invoke("chat_clear"); lastSeen.current = 0; setMessages([]); } catch (e) { setError(String(e)); }
  }

  return <div className="document bot-screen">
    <div className="bot-top"><h1>Bots Hub</h1>
      {tab === "chat" && (confirmClear
        ? <span className="bot-confirm" role="group" aria-label="Confirm clearing the chat">Clear every message? <button className="danger" onClick={() => void clear()}>Clear</button><button onClick={() => setConfirmClear(false)}>Keep</button></span>
        : <button className="bot-clear" disabled={disabled || !messages?.length} onClick={() => setConfirmClear(true)}>Clear chat</button>)}
    </div>
    <div className="bot-tabs" role="tablist" aria-label="Bots Hub">
      <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Chat</button>
      <button role="tab" aria-selected={tab === "queue"} onClick={() => setTab("queue")}>Queue</button>
    </div>
    {tab === "queue" && <section className="bot-queue" aria-label="Queue"><p className="hint">What AI tools have asked to change. Each request shows exactly what it would do; only you can approve it.</p><Approvals disabled={!!disabled} refresh={refresh} /></section>}
    {tab === "chat" && <>
    <p className="hint">A shared chat for you and your AI assistants. An assistant reads and posts with its token (turn on the chat scopes under Settings, then AI access) and signs with the token's name. Nothing said here changes your notes.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="bot-list" ref={list} role="log" aria-label="Messages" aria-live="polite"
      onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {messages === null && <p className="hint" role="status">Loading…</p>}
      {messages?.length === 0 && <p className="bot-empty">No messages yet. Say hello below, or let an assistant post: it sends <code>POST /v1/chat</code> to the local API with its token.</p>}
      {messages?.map((m, i) => {
        const mine = m.kind === "owner";
        return <article key={m.id} className={"bot-msg " + (mine ? "mine" : "theirs tone-" + authorTone(m.author)) + (continues(messages[i - 1], m) ? " cont" : "")}>
          {!continues(messages[i - 1], m) && <header><strong>{mine ? "You" : m.author}</strong>{!mine && <span className="bot-badge">assistant</span>}<time dateTime={m.at}>{clock(m.at)}</time></header>}
          <p>{m.body}</p>
        </article>;
      })}
    </div>
    <form className="bot-compose" onSubmit={e => { e.preventDefault(); void send(); }}>
      <textarea aria-label="Message" rows={2} maxLength={MAX_BODY} placeholder="Write to your assistants. Enter sends, Shift+Enter starts a new line." value={text} disabled={disabled}
        onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <button type="submit" disabled={disabled || sending || !text.trim()}>{sending ? "Sending…" : "Send"}</button>
    </form></>}
  </div>;
}
