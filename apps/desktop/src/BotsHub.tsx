import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Approvals from "./Approvals";
import CollabRoom from "./CollabRoom";
import QueuePanel from "./QueuePanel";
import { mergeById, type HubMessage, type QueueItem, type Summary } from "./hubModel";
import type { PageInfo } from "./EditorContext";

const POLL_MS = 3000;
const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

/**
 * The Bots Hub: three panels at once. The collaboration room (rooms, hand-offs, approval cards) is the big one; beside it a private chat with the
 * bot queue. Bots read and post through the local API with their own tokens, and nothing said here changes a note.
 */
export default function BotsHub({ disabled, pages = [], openPage = () => {}, onTokens, onWaiting = () => {}, refresh = async () => {}, pollMs = POLL_MS }: {
  disabled?: boolean; pages?: PageInfo[]; openPage?: (id: string) => void; onTokens?: () => void; onWaiting?: (n: number) => void; refresh?: () => Promise<void>; pollMs?: number;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [slug, setSlug] = useState("general");
  const [messages, setMessages] = useState<HubMessage[] | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [full, setFull] = useState(false);
  const [apiNote, setApiNote] = useState(false);
  const [api, setApi] = useState<{ enabled: boolean; address: string } | null>(null);
  const lastMsg = useRef(0);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const loadSummary = useCallback(async () => {
    try { const s = await invoke<Summary>("hub_summary"); if (s && Array.isArray(s.rooms)) { setSummary(s); onWaiting(s.waiting); if (!s.rooms.some(r => r.slug === slugRef.current)) setSlug("general"); } } catch { /* the page still works without it */ }
  }, [onWaiting]);
  const loadQueue = useCallback(async () => { try { const q = await invoke<QueueItem[]>("queue_items", {}); if (Array.isArray(q)) setQueue(q); } catch { /* shown empty */ } }, []);
  const loadMessages = useCallback(async () => {
    const mine = slugRef.current;
    try {
      const got = await invoke<HubMessage[]>("chat_list", lastMsg.current ? { after: lastMsg.current, limit: 200, room: mine } : { limit: 100, room: mine });
      if (slugRef.current !== mine || !Array.isArray(got)) return;
      setMessages(old => (lastMsg.current === 0 && !got.length ? [] : mergeById(old ?? [], got)));
      if (got.length) lastMsg.current = Math.max(lastMsg.current, ...got.map(m => m.id));
      setError("");
    } catch (e) { setError(msg(e)); setMessages(old => old ?? []); }
  }, []);

  useEffect(() => { lastMsg.current = 0; setMessages(null); void loadMessages(); }, [slug, loadMessages]);
  useEffect(() => {
    void loadSummary(); void loadQueue();
    const t = window.setInterval(() => { void loadSummary(); void loadQueue(); void loadMessages(); }, pollMs);
    return () => window.clearInterval(t);
  }, [loadSummary, loadQueue, loadMessages, pollMs]);
  useEffect(() => { if (apiNote && !api) invoke<{ enabled: boolean; address: string }>("gateway_api_status").then(s => setApi(s && typeof s.address === "string" ? s : { enabled: false, address: "" })).catch(() => setApi({ enabled: false, address: "" })); }, [apiNote, api]);

  async function send(text: string) {
    try { const m = await invoke<HubMessage>("chat_post", { body: text, room: slug }); setMessages(old => mergeById(old ?? [], [m])); lastMsg.current = Math.max(lastMsg.current, m.id); setError(""); }
    catch (e) { setError(msg(e)); throw e; }
  }
  async function approve(m: HubMessage) {
    try {
      const done = await invoke<HubMessage>("chat_decide_approval", { id: m.id, approve: true });
      setMessages(old => mergeById(old ?? [], [done])); setError("");
      await Promise.all([loadQueue(), loadSummary()]); // the queue row turns Done and the sidebar count drops, without a reload
    } catch (e) { setError(msg(e)); }
  }
  function openSpec(m: HubMessage) {
    const ref = (m.task_ref ?? "").trim().toLowerCase();
    const page = pages.find(p => p.id === m.task_ref || p.title.trim().toLowerCase() === ref);
    if (page) { setNote(""); openPage(page.id); } else setNote(`No page called “${m.task_ref}” was found in your notes.`);
  }
  async function newRoom(name: string) {
    try { const r = await invoke<{ slug: string }>("chat_room_create", { name }); await loadSummary(); setSlug(r.slug); setError(""); }
    catch (e) { setError(msg(e)); throw e; }
  }
  async function loadSample() { try { await invoke("hub_seed_demo"); lastMsg.current = 0; setMessages(null); await Promise.all([loadSummary(), loadQueue(), loadMessages()]); } catch (e) { setNote(msg(e)); } }

  if (full) return <div className="document bot-screen hub-page">
    <button type="button" className="hub-back" onClick={() => setFull(false)}>← Bots Hub</button>
    <h1 className="hub-title">Full queue</h1>
    <p className="hub-sub">What AI tools have asked to change in your notes. Each request shows exactly what it would do; only you can approve it.</p>
    <section className="hub-fullqueue" aria-label="Full queue"><Approvals disabled={!!disabled} refresh={refresh} /></section>
  </div>;

  const room = summary?.rooms.find(r => r.slug === slug);
  const online = summary?.bots_online ?? 0;
  return <div className="document bot-screen hub-page" aria-label="Bots Hub">
    <header className="hub-head">
      <div className="hub-head-text">
        <div className="hub-eyebrow live"><i className="hub-dot live" aria-hidden="true" /><span>{online} {online === 1 ? "BOT" : "BOTS"} ONLINE</span></div>
        <h1 className="hub-title">Bots Hub</h1>
        <p className="hub-sub">Where your assistants work together. Bots read and post with their own tokens; nothing said here changes your notes.</p>
      </div>
      <div className="hub-head-actions">
        {import.meta.env.DEV && <button type="button" className="hub-ghost" onClick={() => void loadSample()} title="Development builds only">Load sample data</button>}
        <button type="button" className="hub-ghost" onClick={onTokens} disabled={!onTokens}>Tokens &amp; scopes</button>
        <button type="button" className="hub-ghost" aria-expanded={apiNote} onClick={() => setApiNote(v => !v)}>API: POST /v1/chat</button>
      </div>
    </header>
    {apiNote && <p className="hub-apinote" role="note">Bots post with <code>POST /v1/chat</code> to the local API{api?.address ? <> at <code>{api.address}</code></> : null}, signing with their token (turn on the chat and queue scopes under Settings, then AI access). {api && !api.enabled ? "The local API is switched off at the moment. Turn it on under Settings, then AI access." : ""}</p>}
    {note && <p className="notice" role="status">{note} <button type="button" className="link-button" onClick={() => setNote("")}>Dismiss</button></p>}
    <div className="hub-body">
      <CollabRoom room={room ?? (summary ? undefined : { id: 1, name: "General", slug: "general" })} rooms={summary?.rooms ?? [{ id: 1, name: "General", slug: "general" }]} onRoom={s => { if (s !== slug) setSlug(s); }}
        participants={summary?.participants ?? []} messages={messages} loading={messages === null} error={error} disabled={disabled} onSend={send} onApprove={approve} onOpenSpec={openSpec} onNewRoom={newRoom} />
      <div className="hub-side">
        <QueuePanel items={queue} onOpenFull={() => setFull(true)} />
      </div>
    </div>
  </div>;
}
