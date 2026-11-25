// Rules for embedded pages. Pure functions: nothing here reads the network. The same rules exist in the backend (embeds.rs) for requests from assistants.
export const DEFAULT_EMBED_HOSTS = ["claude.ai"] as const;
export const EMBED_HOSTS_KEY = "nou-embed-hosts";
export const EMBED_HOSTS_EVENT = "nou-embed-hosts-changed";
export const MIN_HEIGHT = 200, MAX_HEIGHT = 1600, DEFAULT_HEIGHT = 480;
export const MAX_URL = 2048, MAX_HTML = 48_000;
/** The sandbox of a live embed: it may run its own scripts, keep its own origin and open pop-ups, but it cannot navigate NOU (no allow-top-navigation). */
export const LIVE_SANDBOX = "allow-scripts allow-same-origin allow-popups";
/** The sandbox of a snapshot: scripts may run, but it has no origin of its own to reach, so no access to NOU or its storage. */
export const SNAPSHOT_SANDBOX = "allow-scripts";
/** Hosts known to forbid being shown inside another app, checked when this was built. A page there is shown as a card first, with a button to try anyway. */
export const KNOWN_UNFRAMABLE: Record<string, string> = {
  "claude.ai": "claude.ai sends “frame-ancestors 'self'” for artifact pages, so it refuses to be shown inside NOU.",
};

/** The host of an acceptable embed address (https only, no user name, no odd port, a real host name), lower-cased. Throws a plain message otherwise. */
export function parseEmbedUrl(value: string): { href: string; host: string } {
  const text = value.trim();
  if (!text || text.length > MAX_URL || /[\u0000- \u007f]/.test(text)) throw new Error("Enter a web address without spaces.");
  let u: URL; try { u = new URL(text); } catch { throw new Error("That is not a web address."); }
  if (u.protocol !== "https:") throw new Error("Only https:// addresses can be embedded.");
  if (u.username || u.password) throw new Error("Addresses with a user name or password are not allowed.");
  if (u.port && u.port !== "443") throw new Error("Only the standard https port is allowed.");
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.startsWith("-") || host.endsWith(".") || host.endsWith("-") || host.includes("..") || !host.includes(".") || /^[0-9.]+$/.test(host)) throw new Error("Use a host name, not an IP address or a local name.");
  return { href: u.href, host };
}
/** Is the host listed, or a subdomain of a listed one? (`claude.ai` allows `www.claude.ai`, never `evilclaude.ai` or `claude.ai.evil.com`.) */
export const hostAllowed = (host: string, allowed: readonly string[]) => allowed.some(a => host === a || host.endsWith("." + a));
/** The hosts the owner added in Settings, cleaned: valid, lower-case, no duplicates, none of the built-in ones. */
export function cleanHosts(raw: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    if (typeof v !== "string") continue;
    const h = v.trim().toLowerCase(); let ok = false; try { ok = parseEmbedUrl("https://" + h + "/").host === h; } catch { ok = false; }
    if (ok && !out.includes(h) && !(DEFAULT_EMBED_HOSTS as readonly string[]).includes(h)) out.push(h);
  }
  return out;
}
export function readExtraHosts(): string[] { try { return cleanHosts(JSON.parse(localStorage.getItem(EMBED_HOSTS_KEY) || "[]")); } catch { return []; } }
export function writeExtraHosts(hosts: string[]): string[] {
  const clean = cleanHosts(hosts);
  try { localStorage.setItem(EMBED_HOSTS_KEY, JSON.stringify(clean)); window.dispatchEvent(new Event(EMBED_HOSTS_EVENT)); } catch { /* not saved: the list stays as it was */ }
  return clean;
}
export const allowedHosts = (extra: readonly string[] = readExtraHosts()) => [...DEFAULT_EMBED_HOSTS, ...extra];
/** Can this text be embedded right now? Returns the clean address, or null. */
export function embeddableUrl(value: string, hosts: readonly string[] = allowedHosts()): string | null {
  try { const u = parseEmbedUrl(value); return hostAllowed(u.host, hosts) ? u.href : null; } catch { return null; }
}
export const clampHeight = (h: unknown) => { const n = typeof h === "number" && Number.isFinite(h) ? Math.round(h) : DEFAULT_HEIGHT; return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, n)); };
export function knownUnframable(host: string): string | null {
  for (const [h, why] of Object.entries(KNOWN_UNFRAMABLE)) if (host === h || host.endsWith("." + h)) return why;
  return null;
}
/** A readable name for a block with no title. */
export const embedLabel = (title: string, url: string) => title.trim() || (() => { try { return new URL(url).hostname; } catch { return "Embedded page"; } })();

/**
 * The page of a snapshot as it is given to the frame: a strict policy first (no network of any kind, no forms, no nested frames, nothing but inline styles and scripts and
 * data: images and fonts), then the page itself. Any doctype of the page is dropped so ours comes first. NOU's own policy still applies on top of this.
 */
export function snapshotDocument(html: string): string {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` + html.replace(/^\s*<!doctype[^>]*>/i, "");
}
