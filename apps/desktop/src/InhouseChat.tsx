import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_BODY } from "./chatModel";
import InhouseHarness from "./InhouseHarness";
import { inhouseWord, mergeById, type Harness, type InhouseChatInfo, type InhouseMessage } from "./hubModel";

export const INHOUSE_NAME = "Kura";
const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

/**
 * A private chat with the local model, like an ordinary AI chat app: several chats you can switch between, start, rename, clear and delete, and harnesses
 * (named extra instructions written for NOU) that you can give to all chats or to chosen ones. It is not the room: no other bot reads it and nothing here
 * reaches the collaboration chat. It keeps its own polling so the Bots Hub only has to tell it the runner's state.
 */
export default function InhouseChat({ state, disabled, pollMs = 3000 }: { state: string; disabled?: boolean; pollMs?: number }) {
  const [chats, setChats] = useState<InhouseChatInfo[] | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [messages, setMessages] = useState<InhouseMessage[] | null>(null);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [view, setView] = useState<"chat" | "harness">("chat");
  const [renaming, setRenaming] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const activeRef = useRef<number | null>(null);
  activeRef.current = active;
  // Without a chat list (the first look, or an older backend) the first chat is used, so typing always works.
  const chatId = active ?? 1;
  const current = chats?.find(c => c.id === chatId);

  const loadChats = useCallback(async () => {
    try {
      const got = await invoke<InhouseChatInfo[]>("inhouse_chats");
      if (!Array.isArray(got)) return;
      setChats(got);
      if (got.length && !got.some(c => c.id === activeRef.current)) { last.current = 0; setMessages(null); setActive(got[0].id); }
    } catch (e) { setError(msg(e)); }
  }, []);
  const loadHarnesses = useCallback(async () => {
    try { const got = await invoke<Harness[]>("inhouse_harnesses"); if (Array.isArray(got)) setHarnesses(got); } catch { /* the chat still works without them */ }
  }, []);
  const loadMessages = useCallback(async () => {
    const mine = activeRef.current ?? 1;
    try {
      const got = await invoke<InhouseMessage[]>("inhouse_messages", last.current ? { chatId: mine, after: last.current, limit: 200 } : { chatId: mine, limit: 100 });
      if ((activeRef.current ?? 1) !== mine || !Array.isArray(got)) return;
      setMessages(old => (last.current === 0 && !got.length ? [] : mergeById(old ?? [], got)));
      if (got.length) last.current = Math.max(last.current, ...got.map(m => m.id));
      setError("");
    } catch (e) { setError(msg(e)); setMessages(old => old ?? []); }
  }, []);

  useEffect(() => { void loadChats(); void loadHarnesses(); }, [loadChats, loadHarnesses]);
  useEffect(() => { last.current = 0; setMessages(null); setRenaming(null); void loadMessages(); }, [chatId, loadMessages]);
  useEffect(() => {
    const t = window.setInterval(() => { void loadMessages(); void loadChats(); }, pollMs);
    return () => window.clearInterval(t);
  }, [loadMessages, loadChats, pollMs]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, view]);

  /** Run a change, show a refusal as the panel's error, and refresh the list of chats afterwards. */
  async function change<T>(job: () => Promise<T>): Promise<T | undefined> {
    try { const r = await job(); setError(""); await loadChats(); return r; } catch (e) { setError(msg(e)); return undefined; }
  }
  async function send() {
    const t = text.trim();
    if (!t || sending || disabled) return;
    setSending(true);
    try {
      const m = await invoke<InhouseMessage>("inhouse_send", { chatId, body: t });
      setMessages(old => mergeById(old ?? [], [m])); last.current = Math.max(last.current, m.id); setText(""); setError(""); void loadChats();
    } catch (e) { setError(msg(e)); } finally { setSending(false); }
  }
  const switchTo = (id: number) => { if (id === chatId) return; setView("chat"); setActive(id); };
  async function newChat() {
    const c = await change(() => invoke<InhouseChatInfo>("inhouse_chat_create", {}));
    if (c) { setView("chat"); setActive(c.id); }
  }
  async function clearChat() {
    if (!window.confirm(`Clear “${current?.title ?? "this chat"}”? Its messages are deleted. The chat and its harnesses stay.`)) return;
    const done = await change(() => invoke("inhouse_clear_chat", { chatId }));
    if (done !== undefined) { last.current = 0; setMessages([]); }
  }
  async function deleteChat() {
    if (!window.confirm(`Delete “${current?.title ?? "this chat"}” and its messages?`)) return;
    await change(() => invoke("inhouse_chat_delete", { chatId }));
    last.current = 0; setMessages(null); setActive(null); // loadChats picks the most recent chat that is left
  }
  async function rename() {
    const title = (renaming ?? "").trim();
    if (!title || title === current?.title) { setRenaming(null); return; }
    const done = await change(() => invoke("inhouse_chat_rename", { chatId, title }));
    if (done !== undefined) setRenaming(null);
  }
  const used = (current?.harnesses.length ?? 0) + harnesses.filter(h => h.always && !current?.harnesses.includes(h.id)).length;

  return <section className="hub-panel hub-inhouse" aria-label="In-house bot chat">
    <header className="hub-small-head">
      <div className="hub-avatar boxed" aria-hidden="true">KU</div>
      <div className="grow">
        <h2>In-house bot · {INHOUSE_NAME}</h2>
        <div className="hub-eyebrow tight">LOCAL MODEL · PRIVATE TO YOU</div>
      </div>
      <span className="hub-state" role="status" aria-label={"Status: " + inhouseWord(state)}><i className={"hub-dot " + (state === "running" ? "live" : state === "sleeping" ? "muted" : "hollow")} aria-hidden="true" />{inhouseWord(state)}</span>
    </header>
    <div className="hub-chatbar">
      {renaming === null
        ? <label className="hub-chatpick"><span className="sr-only">Chat</span>
            <select value={chatId} onChange={e => switchTo(Number(e.target.value))} aria-label="Chat">
              {(chats ?? [{ id: 1, title: "New chat" } as InhouseChatInfo]).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select></label>
        : <input className="hub-chatname" aria-label="Chat name" autoFocus maxLength={80} value={renaming} onChange={e => setRenaming(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void rename(); } else if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }} onBlur={() => void rename()} />}
      <button type="button" className="hub-ghost" aria-label="New chat" title="Start a new chat" disabled={disabled} onClick={() => void newChat()}>+ New</button>
    </div>
    <div className="hub-chattools" role="toolbar" aria-label="Chat actions">
      <button type="button" className="hub-ghost" disabled={disabled || renaming !== null} onClick={() => setRenaming(current?.title ?? "")}>Rename</button>
      <button type="button" className="hub-ghost" disabled={disabled || !messages?.length} onClick={() => void clearChat()}>Clear chat</button>
      <button type="button" className="hub-ghost danger" disabled={disabled} onClick={() => void deleteChat()}>Delete</button>
      <button type="button" className="hub-ghost" aria-expanded={view === "harness"} onClick={() => setView(v => (v === "harness" ? "chat" : "harness"))}>Harness{used ? ` · ${used}` : ""}</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {view === "harness"
      ? <InhouseHarness chatId={chatId} chat={current} harnesses={harnesses} disabled={disabled} onChanged={async () => { await Promise.all([loadHarnesses(), loadChats()]); }} onClose={() => setView("chat")} />
      : <>
        <div className="hub-dm" ref={list} role="log" aria-label={"Chat with " + INHOUSE_NAME} aria-live="polite">
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
      </>}
  </section>;
}
