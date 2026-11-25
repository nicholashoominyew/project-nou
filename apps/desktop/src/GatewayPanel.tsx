import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Token = { id: string; name: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Created = { info: Token; secret: string };
type ApiStatus = { enabled: boolean; running: boolean; port: number; address: string };
type RunnerBot = { name: string; kind: string; note: string };
type RunnerStatus = { enabled: boolean; running: boolean; api_on: boolean; port: number; node_ok: boolean; claude_ok: boolean; bots: RunnerBot[]; log_tail: string; last_error: string | null };
type Audit = { id: number; at: string; actor: string; action: string; detail: Record<string, unknown> };

const SCOPES: { id: string; label: string; help: string }[] = [
  { id: "notes:read", label: "Read notes", help: "Search and read page content" },
  { id: "databases:read", label: "Read databases", help: "Query database rows" },
  { id: "notes:write", label: "Propose note changes", help: "Ask to create pages, rename pages or add text. You approve each one." },
  { id: "databases:write", label: "Propose database changes", help: "Ask to add rows or change cells. You approve each one." },
  { id: "chat:read", label: "Read the Bots Hub room", help: "Read the collaboration room where you and your assistants talk, in any room." },
  { id: "chat:write", label: "Post to the Bots Hub room", help: "Write messages and hand-off lines in a room under this token's name. Plain text; nothing changes in your notes." },
  { id: "queue:read", label: "Read the bot queue", help: "See what each assistant is working on." },
  { id: "queue:write", label: "Write to the bot queue", help: "Add and update this token's own queue items, and ask you for approval with a card (approvals need this scope too)." },
  { id: "timetable:read", label: "Read the Life Timetable", help: "See your activities and the blocks of both weeks (names and times only)." },
  { id: "timetable:write", label: "Propose timetable changes", help: "Ask to change a stretch of the timetable, add an activity, add a habit or tick one for a day. You see exactly what would change and approve each one." },
  { id: "home:write", label: "Propose Home page changes", help: "Ask to show or hide sections of the Home page. It can never hide the “Waiting for approval” section. You approve each one." },
];

/** The one word (and dot) that says what the bot runner is doing. The first thing that stops it wins. */
export function runnerWord(s: RunnerStatus): { word: string; tone: "live" | "warn" | "off" } {
  if (!s.enabled) return { word: "STOPPED", tone: "off" };
  if (!s.api_on) return { word: "NEEDS THE LOCAL API", tone: "warn" };
  if (!s.node_ok) return { word: "NODE MISSING", tone: "warn" };
  if (!s.claude_ok) return { word: "CLAUDE CLI MISSING", tone: "warn" };
  return s.running ? { word: "RUNNING", tone: "live" } : { word: "STOPPED", tone: "off" };
}

/** Bot runners: while NOU is open (and the Local API is on) a tag in the Bots Hub starts the bot that was tagged. Bots can still only post, queue and propose. */
function RunnerCard({ apiRunning }: { apiRunning: boolean }) {
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { const s = await invoke<RunnerStatus>("runner_status"); if (s && typeof s === "object") setStatus(s); } catch (e) { setError(String(e)); }
  }, []);
  // Look again when the Local API is switched (the runner follows it), and every few seconds while this screen is open.
  useEffect(() => { void refresh(); }, [refresh, apiRunning]);
  useEffect(() => { const id = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(id); }, [refresh]);
  async function toggle(enabled: boolean) {
    setError(""); setBusy(true);
    try { const s = await invoke<RunnerStatus>("runner_set_enabled", { enabled }); if (s && typeof s === "object") setStatus(s); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const shown = status ? runnerWord(status) : null;
  return <section className="recovery-card runner-card" aria-label="Bot runners"><h2>Bot runners</h2>
    <p>Tag a bot in the Bots Hub (for example <code>@Claude</code>) and NOU starts it for you, while NOU is open. A bot can only post, queue and <strong>propose</strong>; nothing changes in your notes until you approve it.</p>
    <label className="scope-row"><input type="checkbox" role="switch" aria-label="Start bots when tagged" checked={!!status?.enabled} disabled={!status || busy} onChange={e => void toggle(e.target.checked)} />
      <span><strong>Start bots when tagged</strong><em>Needs the Local API on, Node.js 18 or newer, and for Claude the Claude Code CLI signed in on this computer. It stops when NOU closes.</em></span></label>
    {shown && <p className="runner-state" role="status" aria-label={"Runner status: " + shown.word}><i className={"runner-dot " + shown.tone} aria-hidden="true" />{shown.word}</p>}
    {status && status.enabled && !status.api_on && <p className="hint">Turn on the Local API above. The runner starts as soon as it is on.</p>}
    {status && status.enabled && status.api_on && !status.node_ok && <p className="hint">Node.js 18 or newer was not found. Install it from nodejs.org, then switch this off and on.</p>}
    {status && status.enabled && status.api_on && status.node_ok && !status.claude_ok && <p className="hint">The Claude Code CLI (<code>claude</code>) was not found or is not signed in, so a tag of @Claude will fail. The other bots still work.</p>}
    {(error || status?.last_error) && <p className="error" role="alert">{error || status?.last_error}</p>}
    {!!status?.bots.length && <ul className="runner-bots" aria-label="Bots">{status.bots.map(b => <li key={b.name}><strong>{b.name}</strong><span className="hint"> {b.note}</span></li>)}</ul>}
    <p className="hint">The runner uses two tokens it makes itself, “Claude” and “NOU relay”. They appear in the list below like any other token; you do not need to copy them.</p>
    <details><summary>Log</summary>
      {status?.log_tail ? <pre className="runner-log" aria-label="Runner log">{status.log_tail}</pre> : <p className="hint">Nothing logged yet.</p>}
    </details>
  </section>;
}

/** Create and revoke the tokens outside tools use, and see the audit trail. A token can only ask; it can never apply a change. */
export default function GatewayPanel({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["notes:read"]);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [api, setApi] = useState<ApiStatus | null>(null);
  const load = useCallback(async () => {
    const [t, a, status] = await Promise.all([invoke<Token[]>("gateway_list_tokens"), invoke<Audit[]>("gateway_audit", { limit: 50 }), invoke<ApiStatus>("gateway_api_status")]);
    setTokens(Array.isArray(t) ? t : []); setAudit(Array.isArray(a) ? a : []); setApi(status && typeof status === "object" ? status : null);
  }, []);
  useEffect(() => { void load().catch(e => setError(String(e))); }, [load]);

  const active = tokens.filter(t => !t.revoked_at);
  const revokedCount = tokens.length - active.length;

  async function create() {
    setError("");
    try { const made = await invoke<Created>("gateway_create_token", { name, scopes }); setCreated(made); setName(""); setCopied(false); await load(); }
    catch (e) { setError(String(e)); }
  }
  async function revoke(token: Token) {
    if (!window.confirm("Revoke “" + token.name + "”? It stops working immediately and its waiting requests are cancelled.")) return;
    setError("");
    try { await invoke("gateway_revoke_token", { id: token.id }); await load(); } catch (e) { setError(String(e)); }
  }
  async function toggleApi(enabled: boolean) {
    setError("");
    try { setApi(await invoke<ApiStatus>("gateway_api_set_enabled", { enabled })); await load(); } catch (e) { setError(String(e)); }
  }
  async function copy() { try { await navigator.clipboard.writeText(created!.secret); setCopied(true); } catch { setError("Copy failed. Select the token and copy it by hand."); } }

  return <main className="recovery-screen gateway-panel"><header><h1>AI access</h1><button onClick={onClose}>Back to notes</button></header>
    <p>Give an AI tool or bot a token so it can read what you allow and <strong>ask</strong> for changes. Nothing it asks for happens until you approve it on the Home page. Anything it requests is logged.</p>
    {error && <p className="error" role="alert">{error}</p>}

    {created && <section className="recovery-card" aria-label="New token">
      <h2>Copy this token now</h2>
      <p>This is the only time it is shown. NOU keeps only a fingerprint, so a lost token must be replaced, not recovered.</p>
      <code className="token-secret" aria-label="Token value">{created.secret}</code>
      <div><button onClick={() => void copy()}>{copied ? "Copied" : "Copy token"}</button> <button onClick={() => setCreated(null)}>I have saved it</button></div>
    </section>}

    <section className="recovery-card" aria-label="Local API"><h2>Local API</h2>
      <p>Lets a tool on <strong>this computer</strong> use your tokens. It listens on 127.0.0.1 only, so other devices and web pages cannot reach it, and it is off until you turn it on.</p>
      <label className="scope-row"><input type="checkbox" role="switch" aria-label="Enable the local API" checked={!!api?.enabled} disabled={!api} onChange={e => void toggleApi(e.target.checked)} /><span><strong>{api?.running ? "On" : "Off"}</strong><em>{api?.running ? "Listening at " + api.address : "Nothing is listening."}</em></span></label>
      {api?.running && <details><summary>How a tool uses it</summary>
        <p>Send <code>Authorization: Bearer YOUR_TOKEN</code>. Reads: <code>GET /v1/search?q=…</code>, <code>GET /v1/pages/ID</code>, <code>GET /v1/databases/ID</code>. To ask for a change: <code>POST /v1/proposals</code> with <code>{"{"}"op","payload","summary"{"}"}</code>. A change only happens after you approve it on the Home page.</p></details>}
    </section>

    <RunnerCard apiRunning={!!api?.running} />

    <section className="recovery-card" aria-label="Create a token"><h2>Create a token</h2>
      <label>Name<input aria-label="Token name" value={name} maxLength={60} placeholder="For example: Claude desktop" onChange={e => setName(e.target.value)} /></label>
      <fieldset><legend>What it may do</legend>
        {SCOPES.map(s => <label key={s.id} className="scope-row"><input type="checkbox" checked={scopes.includes(s.id)} onChange={e => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter(x => x !== s.id))} /><span><strong>{s.label}</strong><em>{s.help}</em></span></label>)}
      </fieldset>
      <button disabled={!name.trim() || !scopes.length} onClick={() => void create()}>Create token</button>
    </section>

    <section className="recovery-card" aria-label="Tokens"><h2>Tokens</h2>
      {!tokens.length && <p className="hint">No tokens yet.</p>}
      {!!tokens.length && !active.length && <p className="hint">No active tokens.</p>}
      {(showRevoked ? tokens : active).map(t => <div key={t.id} className="token-row">
        <div><strong>{t.name}</strong>{t.revoked_at && <span className="token-revoked"> revoked</span>}
          <div className="hint">{t.scopes.join(", ")} · created {t.created_at.slice(0, 10)} · {t.last_used_at ? "last used " + t.last_used_at.slice(0, 16).replace("T", " ") : "never used"}</div></div>
        {!t.revoked_at && <button className="danger" aria-label={"Revoke " + t.name} onClick={() => void revoke(t)}>Revoke</button>}
      </div>)}
      {!!revokedCount && <button className="link-button" aria-expanded={showRevoked} onClick={() => setShowRevoked(v => !v)}>{showRevoked ? "Hide revoked tokens" : `Show ${revokedCount} revoked token${revokedCount === 1 ? "" : "s"}`}</button>}
      {!!revokedCount && <p className="hint">Revoked tokens stop working at once. They stay listed because the activity log refers to them.</p>}
    </section>

    <section className="recovery-card" aria-label="Activity"><h2>Recent activity</h2>
      {!audit.length && <p className="hint">Nothing yet.</p>}
      <ul className="audit-list">{audit.map(a => <li key={a.id}><span className="hint">{a.at.slice(0, 19).replace("T", " ")}</span> <strong>{a.action}</strong> <span className="hint">by {a.actor}</span></li>)}</ul>
    </section>
  </main>;
}
