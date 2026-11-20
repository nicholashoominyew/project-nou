import { useEffect, useRef, useState } from "react";
import { addMention, approvalWord, clockOf, codeOf, dayLabel, handoffLine, type HubMessage, type Participant, type Room } from "./hubModel";
import { MAX_BODY } from "./chatModel";

function Dot({ tone }: { tone: "live" | "ask" | "muted" | "hollow" }) { return <i className={"hub-dot " + tone} aria-hidden="true" />; }

/** The big panel: room tabs, who is here, the feed (messages, hand-off lines, approval cards) and the composer. Its Send button is the page's only accent fill. */
export default function CollabRoom({ room, rooms, onRoom, participants, messages, loading, error, disabled, onSend, onApprove, onOpenSpec, onNewRoom }: {
  room: Room | undefined; rooms: Room[]; onRoom: (slug: string) => void; participants: Participant[]; messages: HubMessage[] | null; loading: boolean; error: string; disabled?: boolean;
  onSend: (text: string) => Promise<void>; onApprove: (m: HubMessage) => Promise<void>; onOpenSpec: (m: HubMessage) => void; onNewRoom: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<number | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const mentionable = participants.filter(p => !p.you);
  useEffect(() => { const el = feed.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages, room?.slug]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    try { await onSend(text); setDraft(""); stick.current = true; } finally { setSending(false); }
  }
  async function approve(m: HubMessage) { setDeciding(m.id); try { await onApprove(m); } finally { setDeciding(null); } }
  const slug = room?.slug ?? "general";

  return <section className="hub-panel hub-room" aria-label="Bot collaboration room">
    <header className="hub-room-head">
      <div className="hub-room-title">
        <div className="hub-eyebrow">COLLABORATION ROOM</div>
        <h2># {slug}</h2>
      </div>
      <div className="hub-tabs hub-roomtabs" role="tablist" aria-label="Rooms">
        {rooms.map(r => <button key={r.slug} type="button" role="tab" aria-selected={r.slug === slug} className={r.slug === slug ? "on" : ""} onClick={() => onRoom(r.slug)}>{r.name}</button>)}
        {adding === null
          ? <button type="button" className="hub-newroom" aria-label="Add a room" title="Add a room" disabled={disabled} onClick={() => setAdding("")}>+</button>
          : <form className="hub-newroom-form" onSubmit={e => { e.preventDefault(); const n = adding.trim(); if (n) void onNewRoom(n).then(() => setAdding(null)).catch(() => undefined); else setAdding(null); }}>
              <input aria-label="New room name" autoFocus maxLength={40} value={adding} placeholder="Room name" onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setAdding(null); }} onBlur={() => { if (!adding.trim()) setAdding(null); }} />
            </form>}
      </div>
      <div className="hub-people" role="list" aria-label="Participants">
        {participants.map(p => <div key={p.name} role="listitem" className="hub-avatar round" title={p.you ? "You" : p.name + (p.online ? " · online" : " · idle")} aria-label={(p.you ? "You" : p.name) + (p.online ? ", online" : ", idle")}>{p.code}<i className={"hub-presence" + (p.online ? " on" : "")} aria-hidden="true" /></div>)}
      </div>
    </header>

    <div className="hub-feed" ref={feed} role="log" aria-label={"Messages in " + slug} aria-live="polite" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && <p className="hint" role="status">Loading…</p>}
      {messages && !messages.length && !loading && <p className="hub-empty">Nothing in this room yet. A bot posts with <code>POST /v1/chat</code>, or write below and @mention one.</p>}
      {messages?.map((m, i) => {
        const prev = messages[i - 1]; const divider = !prev || dayLabel(prev.at) !== dayLabel(m.at);
        return <div key={m.id} className="hub-item">
          {divider && <div className="hub-divider" role="separator"><span />{dayLabel(m.at)}<span /></div>}
          {m.type === "handoff"
            ? <div className="hub-handoff"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h14" /><path d="M13 6l6 6-6 6" /></svg><span>{handoffLine(m)}</span><span className="grow" /><time dateTime={m.at}>{clockOf(m.at)}</time></div>
            : m.type === "approval"
              ? <div className="hub-ask" role="group" aria-label={"Approval from " + m.author}>
                  <div className="hub-ask-text">
                    <div className={"hub-ask-status " + (m.approval === "open" ? "open" : "")}><Dot tone={m.approval === "open" ? "ask" : "muted"} />{approvalWord(m.approval)} · FROM {m.author.toUpperCase()}</div>
                    <p>{m.body}</p>
                  </div>
                  {m.approval === "open" && <div className="hub-ask-actions">
                    <button type="button" className="hub-approve" disabled={disabled || deciding === m.id} onClick={() => void approve(m)}>Approve</button>
                    {m.task_ref && <button type="button" className="hub-ghost" onClick={() => onOpenSpec(m)}>Open spec</button>}
                  </div>}
                </div>
              : <article className="hub-msg">
                  <div className="hub-avatar" aria-hidden="true">{m.kind === "owner" ? "YO" : codeOf(m.author)}</div>
                  <div className="hub-msg-body">
                    <div className="hub-msg-head"><strong>{m.kind === "owner" ? "You" : m.author}</strong>{m.role && <span className="hub-role">{m.role}</span>}<time dateTime={m.at}>{clockOf(m.at)}</time></div>
                    <p>{m.body}</p>
                  </div>
                </article>}
        </div>;
      })}
    </div>

    <form className="hub-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      <div className="hub-mentions" aria-label="Mention a bot">
        {mentionable.map(p => <button key={p.name} type="button" onClick={() => setDraft(d => addMention(d, p.name))}>@{p.name}</button>)}
      </div>
      <div className="hub-compose-row">
        <label><span className="sr-only">Message the room</span>
          <textarea rows={2} maxLength={MAX_BODY} value={draft} disabled={disabled} placeholder="Message the room. @mention a bot to hand it work. Enter sends."
            onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        </label>
        <button type="submit" className="hub-send" disabled={disabled || sending || !draft.trim()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-2-7-8-1z" /></svg>{sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  </section>;
}
