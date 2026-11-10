import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Token = { id: string; name: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Created = { info: Token; secret: string };
type ApiStatus = { enabled: boolean; running: boolean; port: number; address: string };
type Audit = { id: number; at: string; actor: string; action: string; detail: Record<string, unknown> };

const SCOPES: { id: string; label: string; help: string }[] = [
  { id: "notes:read", label: "Read notes", help: "Search and read page content" },
  { id: "databases:read", label: "Read databases", help: "Query database rows" },
  { id: "notes:write", label: "Propose note changes", help: "Ask to create pages, rename pages or add text. You approve each one." },
  { id: "databases:write", label: "Propose database changes", help: "Ask to add rows or change cells. You approve each one." },
];

/** Create and revoke the tokens outside tools use, and see the audit trail. A token can only ask; it can never apply a change. */
export default function GatewayPanel({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["notes:read"]);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [api, setApi] = useState<ApiStatus | null>(null);
  const load = useCallback(async () => {
    const [t, a, status] = await Promise.all([invoke<Token[]>("gateway_list_tokens"), invoke<Audit[]>("gateway_audit", { limit: 50 }), invoke<ApiStatus>("gateway_api_status")]);
    setTokens(Array.isArray(t) ? t : []); setAudit(Array.isArray(a) ? a : []); setApi(status && typeof status === "object" ? status : null);
  }, []);
  useEffect(() => { void load().catch(e => setError(String(e))); }, [load]);

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

    <section className="recovery-card" aria-label="Create a token"><h2>Create a token</h2>
      <label>Name<input aria-label="Token name" value={name} maxLength={60} placeholder="For example: Claude desktop" onChange={e => setName(e.target.value)} /></label>
      <fieldset><legend>What it may do</legend>
        {SCOPES.map(s => <label key={s.id} className="scope-row"><input type="checkbox" checked={scopes.includes(s.id)} onChange={e => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter(x => x !== s.id))} /><span><strong>{s.label}</strong><em>{s.help}</em></span></label>)}
      </fieldset>
      <button disabled={!name.trim() || !scopes.length} onClick={() => void create()}>Create token</button>
    </section>

    <section className="recovery-card" aria-label="Tokens"><h2>Tokens</h2>
      {!tokens.length && <p className="hint">No tokens yet.</p>}
      {tokens.map(t => <div key={t.id} className="token-row">
        <div><strong>{t.name}</strong>{t.revoked_at && <span className="token-revoked"> revoked</span>}
          <div className="hint">{t.scopes.join(", ")} · created {t.created_at.slice(0, 10)} · {t.last_used_at ? "last used " + t.last_used_at.slice(0, 16).replace("T", " ") : "never used"}</div></div>
        {!t.revoked_at && <button className="danger" aria-label={"Revoke " + t.name} onClick={() => void revoke(t)}>Revoke</button>}
      </div>)}
    </section>

    <section className="recovery-card" aria-label="Activity"><h2>Recent activity</h2>
      {!audit.length && <p className="hint">Nothing yet.</p>}
      <ul className="audit-list">{audit.map(a => <li key={a.id}><span className="hint">{a.at.slice(0, 19).replace("T", " ")}</span> <strong>{a.action}</strong> <span className="hint">by {a.actor}</span></li>)}</ul>
    </section>
  </main>;
}
