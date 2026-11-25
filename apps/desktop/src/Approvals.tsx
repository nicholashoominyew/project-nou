import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { keep } from "./stable";
import { OP_LABELS, applyProposal, canApply, describeProposal, parseAppendEmbed, parseAttachHtml, type Proposal } from "./gatewayApply";
import EmbedView from "./EmbedView";
import { AUTO_CHANGED } from "./autoApprove";
import { groupProposals, type PageRef, type ProposalGroup } from "./proposalGroups";

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
  // Pausing auto-approval sends requests back here, so a change to it is picked up at once.
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); const again = () => void load(); window.addEventListener(AUTO_CHANGED, again); return () => { window.clearInterval(timer); window.removeEventListener(AUTO_CHANGED, again); }; }, [load]);
  // Page names and parents are only needed to group several requests.
  const [pages, setPages] = useState<PageRef[]>([]);
  const several = (items?.length ?? 0) > 1;
  useEffect(() => { if (several) void invoke<PageRef[]>("list_pages").then(l => setPages(Array.isArray(l) ? l : [])).catch(() => setPages([])); }, [several, items]);

  /** One decision. Approving applies through the app's normal write path and records the result. */
  async function settle(p: Proposal, approve: boolean) {
    await invoke("gateway_decide", { id: p.id, approve });
    if (!approve) return null;
    const outcome = await applyProposal(p);
    await invoke("gateway_mark_applied", { id: p.id, ok: outcome.ok, result: outcome.result });
    return outcome;
  }
  async function decide(p: Proposal, approve: boolean) {
    if (busy) return;
    setBusy(p.id); setNote("");
    try {
      const outcome = await settle(p, approve);
      if (outcome) {
        setNote(outcome.ok ? "Approved and applied: " + outcome.result : "Approved, but it could not be applied: " + outcome.result);
        await refresh();
      } else setNote("Rejected.");
    } catch (e) { setNote(String(e)); }
    finally { setBusy(""); await load(); }
  }
  /** Several at once, one after another, in the order they were asked. One that fails does not stop the rest. */
  async function decideMany(list: Proposal[], approve: boolean, question: string) {
    const todo = approve ? list.filter(p => canApply(p.op)) : list;
    if (busy || !todo.length || !window.confirm(question)) return;
    setBusy("many"); setNote("");
    let done = 0, failed = 0;
    for (const p of [...todo].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
      try { const outcome = await settle(p, approve); if (outcome && !outcome.ok) failed++; else done++; } catch { failed++; }
    }
    setNote(`${approve ? "Approved" : "Rejected"} ${done}${failed ? `; ${failed} could not be ${approve ? "applied" : "rejected"}` : ""}.`);
    try { if (approve) await refresh(); } finally { setBusy(""); await load(); }
  }

  if (items === null) return <p className="hint">Loading…</p>;
  return <div className="approvals">
    {note && <p className="approvals-note" role="status">{note}</p>}
    {!items.length && <p className="hint">Nothing waiting. AI tools can only ask; nothing changes without you, or a rule you wrote.</p>}
    {items.length > 1 && <div className="approval-bulk">
      <button disabled={disabled || !!busy} onClick={() => void decideMany(items, true, `Approve and apply all ${items.filter(p => canApply(p.op)).length} waiting requests?`)}>Approve all</button>
      <button disabled={disabled || !!busy} onClick={() => void decideMany(items, false, `Reject all ${items.length} waiting requests?`)}>Reject all</button>
    </div>}
    {groupProposals(items, pages).map(g => g.items.length === 1 ? card(g.items[0]) : group(g))}
  </div>;

  function group(g: ProposalGroup): ReactNode {
    const label = `${g.items.length} × ${OP_LABELS[g.op] ?? g.op}`;
    return <article key={g.key} className="approval approval-group" aria-label={label + " from " + g.source}>
      <header><strong>{label}</strong><span className="hint">from {g.source}{g.where ? " · " + g.where : ""}</span></header>
      <blockquote className="approval-claim"><span className="hint">Their description (not verified):</span> {g.summary}</blockquote>
      <details><summary>Show each one</summary><div className="approvals">{g.items.map(p => card(p))}</div></details>
      <div className="approval-actions">
        <button disabled={disabled || !!busy || !canApply(g.op)} onClick={() => void decideMany(g.items, true, `Approve and apply these ${g.items.length} requests from ${g.source}?`)}>Approve these {g.items.length}</button>
        <button disabled={disabled || !!busy} onClick={() => void decideMany(g.items, false, `Reject these ${g.items.length} requests from ${g.source}?`)}>Reject these {g.items.length}</button>
      </div>
    </article>;
  }
  function card(p: Proposal): ReactNode {
    return <article key={p.id} className="approval" aria-label={OP_LABELS[p.op] ?? p.op}>
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
    </article>;
  }
}
