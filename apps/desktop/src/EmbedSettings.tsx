import { useState } from "react";
import { DEFAULT_EMBED_HOSTS, parseEmbedUrl, readExtraHosts, writeExtraHosts } from "./embed";
import { saveSettingsSnapshot } from "./syncSettings";

/** Which sites can be shown inside a note as an embed. claude.ai is always on the list; add others here. Anything else is shown as a plain link. */
export default function EmbedSettings() {
  const [hosts, setHosts] = useState(readExtraHosts);
  const [text, setText] = useState(""); const [error, setError] = useState("");
  // The list is also copied into the database, so a request from an assistant for a site you just added is accepted, and a request for any other site is refused when it is made.
  const save = (next: string[]) => { const clean = writeExtraHosts(next); setHosts(clean); void saveSettingsSnapshot().catch(() => 0); };
  function add() {
    setError("");
    const raw = text.trim().replace(/^https:\/\//i, "").replace(/\/.*$/, "");
    try { const { host } = parseEmbedUrl("https://" + raw + "/"); if ((DEFAULT_EMBED_HOSTS as readonly string[]).includes(host) || hosts.includes(host)) { setError("That site is already on the list."); return; } save([...hosts, host]); setText(""); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  return <section className="settings-card embed-settings" aria-label="Embedded pages">
    <span className="settings-icon" aria-hidden="true">🔗</span>
    <div className="settings-text">
      <h2>Embedded pages</h2>
      <p>Pages from these sites can be shown inside a note (type /embed, or paste an address onto an empty line). Other sites are shown as a link. A site can still refuse to be shown inside NOU; then you get a card with “Open in new tab”.</p>
      <ul className="embed-hosts" aria-label="Sites that can be embedded">
        {DEFAULT_EMBED_HOSTS.map(h => <li key={h}><code>{h}</code> <span className="hint">built in</span></li>)}
        {hosts.map(h => <li key={h}><code>{h}</code> <button type="button" aria-label={"Remove " + h} onClick={() => save(hosts.filter(x => x !== h))}>Remove</button></li>)}
      </ul>
      <form onSubmit={e => { e.preventDefault(); add(); }}>
        <input aria-label="Site to allow" placeholder="example.com" value={text} onChange={e => setText(e.target.value)} />
        <button type="submit" disabled={!text.trim()}>Add site</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  </section>;
}
