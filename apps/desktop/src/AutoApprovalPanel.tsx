import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OP_LABELS } from "./gatewayApply";
import { AUTO_CHANGED, AUTO_OPS, announceAuto, undoAuto, type AutoOverview, type AutoRecent, type AutoRule } from "./autoApprove";
import type { PageInfo } from "./EditorContext";

const ANY_PAGE = "", ANY_BOT = "*";
type Draft = { id: string; name: string; page: string; include_subtree: boolean; ops: string[]; source: string; enabled: boolean; per_hour: number };
const blank: Draft = { id: "", name: "", page: ANY_PAGE, include_subtree: true, ops: [], source: "", enabled: true, per_hour: 100 };
const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
const when = (iso: string) => new Date(iso).toLocaleString();

/** "Bots / Inbox" for every page, in the order the tree shows them. */
export function pagePaths(pages: PageInfo[]): { id: string; path: string }[] {
  const byId = new Map(pages.map(p => [p.id, p]));
  const path = (p: PageInfo) => { const parts = [p.title || "Untitled"]; let up = p.parent_id; for (let i = 0; up && i < 50; i++) { const q = byId.get(up); if (!q) break; parts.unshift(q.title || "Untitled"); up = q.parent_id; } return parts.join(" / "); };
  return pages.map(p => ({ id: p.id, path: path(p) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Rules, the two switches, and what was approved automatically (with Undo). Only this screen can change rules: bots have no way to. */
export default function AutoApprovalPanel({ pages, onClose, onOpenPage, refresh }: { pages: PageInfo[]; onClose: () => void; onOpenPage: (id: string) => void; refresh: () => Promise<void> | void }) {
  const [data, setData] = useState<AutoOverview | null>(null);
  const [recent, setRecent] = useState<AutoRecent[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const paths = useMemo(() => pagePaths(pages), [pages]);
  const pathOf = (id: string | null) => (id === null ? "Any page" : paths.find(p => p.id === id)?.path ?? "A page in Trash");

  const load = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([invoke<AutoOverview>("auto_overview"), invoke<AutoRecent[]>("auto_recent", { limit: 100 })]);
      if (o && Array.isArray(o.rules)) setData(o);
      setRecent(Array.isArray(r) ? r : []);
    } catch (e) { setError(msg(e)); }
  }, []);
  useEffect(() => {
    void load().then(() => invoke("auto_seen", { pageId: null })).then(announceAuto).catch(() => { /* badges stay until next time */ });
    window.addEventListener(AUTO_CHANGED, load); return () => window.removeEventListener(AUTO_CHANGED, load);
  }, [load]);

  async function run(job: () => Promise<unknown>, done = "") {
    if (busy) return;
    setBusy(true); setError(""); setNote("");
    try { await job(); setNote(done); announceAuto(); } catch (e) { setError(msg(e)); }
    finally { setBusy(false); await load(); }
  }
  const switches = (featureOn: boolean, paused: boolean) => run(() => invoke("auto_set_switches", { featureOn, paused }));
  const ruleOf = (d: Draft): AutoRule => ({ id: d.id, name: d.name, page_id: d.page || null, include_subtree: d.include_subtree, ops: d.ops, source: d.source === ANY_BOT ? null : d.source, enabled: d.enabled, per_hour: d.per_hour });
  const edit = (r: AutoRule) => setDraft({ id: r.id, name: r.name, page: r.page_id ?? ANY_PAGE, include_subtree: r.include_subtree, ops: r.ops, source: r.source ?? ANY_BOT, enabled: r.enabled, per_hour: r.per_hour });

  return <div className="auto-screen document">
    <div className="auto-head"><h1>Auto-approval</h1><button onClick={onClose}>Back</button></div>
    <p className="hint">Rules let small changes from bots apply by themselves. Anything no rule covers still waits for you. Deleting is never automatic, and neither is anything that would replace what you wrote.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {note && <p className="notice" role="status">{note}</p>}
    {!data ? <p className="hint">Loading…</p> : <>
      <section className="auto-card" aria-label="Switches">
        <label className="auto-switch"><input type="checkbox" checked={data.feature_on} disabled={busy} onChange={e => void switches(e.target.checked, data.paused)} /> <strong>Turn on auto-approval</strong></label>
        <label className="auto-switch"><input type="checkbox" checked={data.paused} disabled={busy || !data.feature_on} onChange={e => void switches(data.feature_on, e.target.checked)} /> Pause all auto-approval</label>
        <p className="hint">{!data.feature_on ? "Off: every request waits for you." : data.paused ? "Paused: every request waits for you." : data.rules.some(r => r.enabled) ? "On." : "On, but there are no rules yet, so every request still waits for you."}</p>
      </section>

      <section className="auto-card" aria-label="Rules">
        <h2>Rules</h2>
        {!data.rules.length && <p className="hint">No rules yet.</p>}
        <ul className="auto-rules">{data.rules.map(r => <li key={r.id}>
          <label className="auto-switch"><input type="checkbox" aria-label={"Rule " + r.name + " is on"} checked={r.enabled} disabled={busy} onChange={e => void run(() => invoke("auto_rule_save", { rule: { ...r, enabled: e.target.checked } }))} /> <strong>{r.name}</strong></label>
          <div className="auto-meta">{pathOf(r.page_id)}{r.page_id && r.include_subtree ? " and everything under it" : ""} · {r.source ?? "Any bot"} · up to {r.per_hour} an hour</div>
          <div className="auto-meta">{r.ops.map(o => OP_LABELS[o] ?? o).join(", ")}</div>
          <div className="auto-actions"><button disabled={busy} onClick={() => edit(r)}>Edit</button>
            <button disabled={busy} onClick={() => { if (window.confirm(`Delete the rule “${r.name}”?`)) void run(() => invoke("auto_rule_delete", { id: r.id })); }}>Delete rule</button></div>
        </li>)}</ul>
        {!draft && <button className="auto-primary" onClick={() => setDraft(blank)}>Add a rule</button>}
        {draft && <form className="auto-form" aria-label={draft.id ? "Edit rule" : "New rule"} onSubmit={e => { e.preventDefault(); void run(async () => { await invoke("auto_rule_save", { rule: ruleOf(draft) }); setDraft(null); }, "Rule saved."); }}>
          <label>Name<input aria-label="Rule name" value={draft.name} maxLength={60} placeholder="For example: Bots inbox" onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>Where<select aria-label="Where" value={draft.page} onChange={e => setDraft({ ...draft, page: e.target.value })}><option value={ANY_PAGE}>Any page</option>{paths.map(p => <option key={p.id} value={p.id}>{p.path}</option>)}</select></label>
          {draft.page && <label className="auto-switch"><input type="checkbox" checked={draft.include_subtree} onChange={e => setDraft({ ...draft, include_subtree: e.target.checked })} /> Include everything under it</label>}
          <fieldset><legend>What may happen by itself</legend>{AUTO_OPS.map(o => <label key={o} className="auto-switch"><input type="checkbox" checked={draft.ops.includes(o)} onChange={e => setDraft({ ...draft, ops: e.target.checked ? [...draft.ops, o] : draft.ops.filter(x => x !== o) })} /> {OP_LABELS[o]}
            {o === "set_value" && <small> (only into an empty cell)</small>}{o === "rename_page" && <small> (only a page that bot made, still untouched)</small>}</label>)}</fieldset>
          <label>Which bot<select aria-label="Which bot" value={draft.source} onChange={e => setDraft({ ...draft, source: e.target.value })}><option value="" disabled>Choose…</option>{data.sources.map(s => <option key={s} value={s}>{s}</option>)}
            {draft.source && draft.source !== ANY_BOT && !data.sources.includes(draft.source) && <option value={draft.source}>{draft.source} (no active token)</option>}<option value={ANY_BOT}>Any bot</option></select></label>
          {draft.source === ANY_BOT && <p className="warning" role="alert">Any bot means every token, including one reached from another device through the MCP gateway.</p>}
          <label>At most this many an hour<input aria-label="Limit per hour" type="number" min={1} max={1000} value={draft.per_hour} onChange={e => setDraft({ ...draft, per_hour: Math.round(Number(e.target.value)) })} /></label>
          <div className="auto-actions"><button type="submit" className="auto-primary" disabled={busy || !draft.name.trim() || !draft.ops.length || !draft.source}>Save rule</button><button type="button" onClick={() => setDraft(null)}>Cancel</button></div>
        </form>}
      </section>

      <section className="auto-card" aria-label="Recently auto-approved">
        <h2>Recently auto-approved</h2>
        {!recent.length && <p className="hint">Nothing has been approved automatically.</p>}
        <ul className="auto-recent">{recent.map(r => <li key={r.proposal_id}>
          <div className="auto-meta">{when(r.at)} · {r.source} · rule “{r.rule_name}”</div>
          <strong>{r.change_text}</strong>
          <div className="auto-meta">Their description (not verified): {r.summary}</div>
          <div className="auto-actions">
            {r.page_id && r.page_title !== null && <button className="link-button" onClick={() => onOpenPage(r.page_id!)}>{r.page_title || "Untitled"}</button>}
            <span className="auto-state">{r.undone_at ? "Undone" : r.status === "applied" ? "Done" : r.status === "failed" ? "Failed: " + (r.result ?? "") : r.status === "approved" ? "Applying…" : r.status}</span>
            {r.status === "applied" && !r.undone_at && <button disabled={busy} aria-label={"Undo: " + r.change_text} onClick={() => void run(async () => { await undoAuto(r.proposal_id); await refresh(); }, "Undone.")}>Undo</button>}
          </div>
        </li>)}</ul>
      </section>
    </>}
  </div>;
}
