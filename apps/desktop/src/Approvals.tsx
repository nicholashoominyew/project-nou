import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { keep } from "./stable";
import { OP_LABELS, applyProposal, canApply, describeProposal, parseAppendEmbed, parseAttachHtml, type Proposal } from "./gatewayApply";
import EmbedView from "./EmbedView";

/** Show a value exactly as the client sent it, truncated for display only. Nothing here is rendered as HTML. */
function shown(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 400 ? s.slice(0, 400) + "… (" + s.length + " characters)" : s;
}

/** What an embed request would add: a snapshot is shown (it has no network and no access to NOU); a live page is only loaded when you ask, never just because a request arrived. */
function EmbedPreview({ p }: { p: Proposal }) {
  const [live, setLive] = useState(false);
  try {
    if (p.op === "attach_html") { const a = parseAttachHtml(p.payload); return <div className="approval-embed" aria-label="Preview of the page"><EmbedView url="" title={a.title} height={Math.min(a.height, 360)} mode="snapshot" fileId="x" html={a.html} editable={false} /></div>; }
    if (p.op === "append_embed") { const e = parseAppendEmbed(p.payload); return <div className="approval-embed" aria-label="Preview of the embed">
      {live ? <EmbedView url={e.url} title={e.title} height={Math.min(e.height, 360)} mode="live" fileId="" editable={false} />
        : <div className="embed-card"><strong>{e.title || e.host}</strong><code className="embed-url">{e.url}</code><div className="embed-actions"><button type="button" onClick={() => setLive(true)}>Load a live preview</button></div></div>}</div>; }
  } catch { /* a badly shaped request shows only its raw fields below */ }
  return null;
}

/**
 * Pending requests from AI tools and bots. Each one shows the exact operation and fields; the client's own description
 * is shown separately and labelled as unverified. Approving applies the change through the app's normal write path.
 */
export default function Approvals({ disabled, refresh }: { disabled: boolean; refresh: () => Promise<void> }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    try { const list = await invoke<Proposal[]>("gateway_list_proposals", { status: "pending", limit: 50 }); setItems(old => keep(old, Array.isArray(list) ? list : [])); }
    catch { setItems(old => keep(old, [])); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer); }, [load]);

  async function decide(p: Proposal, approve: boolean) {
    if (busy) return;
    setBusy(p.id); setNote("");
    try {
      await invoke("gateway_decide", { id: p.id, approve });
      if (approve) {
        const outcome = await applyProposal(p);
        await invoke("gateway_mark_applied", { id: p.id, ok: outcome.ok, result: outcome.result });
        setNote(outcome.ok ? "Approved and applied: " + outcome.result : "Approved, but it could not be applied: " + outcome.result);
        await refresh();
      } else setNote("Rejected.");
    } catch (e) { setNote(String(e)); }
    finally { setBusy(""); await load(); }
  }

  if (items === null) return <p className="hint">Loading…</p>;
  return <div className="approvals">
    {note && <p className="approvals-note" role="status">{note}</p>}
    {!items.length && <p className="hint">Nothing waiting. AI tools can only ask; they can never change your notes without you.</p>}
    {items.map(p => <article key={p.id} className="approval" aria-label={OP_LABELS[p.op] ?? p.op}>
      <header><strong>{OP_LABELS[p.op] ?? p.op}</strong><span className="hint">from {p.token_name}</span></header>
      {describeProposal(p.op, p.payload) && <p className="approval-what"><strong>If you approve: </strong>{describeProposal(p.op, p.payload)}</p>}
      {(p.op === "append_embed" || p.op === "attach_html") && <EmbedPreview p={p} />}
      <dl className="approval-fields">{Object.entries(p.payload).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{shown(v)}</dd></div>)}</dl>
      <blockquote className="approval-claim"><span className="hint">Their description (not verified):</span> {p.summary}</blockquote>
      <div className="approval-actions">
        <button disabled={disabled || !!busy || !canApply(p.op)} onClick={() => void decide(p, true)} title={canApply(p.op) ? "" : "This kind of request cannot be applied yet"}>Approve and apply</button>
        <button disabled={disabled || !!busy} onClick={() => void decide(p, false)}>Reject</button>
        {!canApply(p.op) && <span className="hint">Can't be applied yet. You can reject it.</span>}
      </div>
    </article>)}
  </div>;
}
