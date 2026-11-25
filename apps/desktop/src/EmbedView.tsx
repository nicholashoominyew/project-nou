import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { allowedHosts, clampHeight, embedLabel, EMBED_HOSTS_EVENT, hostAllowed, knownUnframable, LIVE_SANDBOX, parseEmbedUrl, readExtraHosts, snapshotDocument, SNAPSHOT_SANDBOX, MAX_HEIGHT, MIN_HEIGHT } from "./embed";

const LOAD_WAIT_MS = 10000;
export type EmbedProps = {
  url: string; title: string; height: number; mode: "live" | "snapshot"; fileId: string; editable: boolean;
  onChange?: (patch: Partial<{ url: string; title: string; height: number; mode: "live" | "snapshot"; fileId: string }>) => void;
  /** Store a chosen .html file with the page's files and point the block at it. */
  onAttach?: (file: File) => Promise<void>;
  onError?: (e: unknown) => void;
  /** Show this page instead of reading the attached file (used by the approval card, before anything is stored). */
  html?: string;
};

function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => { const on = () => setOnline(true), off = () => setOnline(false); window.addEventListener("online", on); window.addEventListener("offline", off); return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); }; }, []);
  return online;
}
function useExtraHosts() {
  const [hosts, setHosts] = useState(readExtraHosts);
  useEffect(() => { const f = () => setHosts(readExtraHosts()); window.addEventListener(EMBED_HOSTS_EVENT, f); return () => window.removeEventListener(EMBED_HOSTS_EVENT, f); }, []);
  return hosts;
}
/** The text of an attached file, or why it cannot be shown. */
function useAttachedHtml(fileId: string, override: string | undefined) {
  const [state, setState] = useState<{ html: string; error: string; loading: boolean }>({ html: override ?? "", error: "", loading: !!fileId && override === undefined });
  useEffect(() => {
    if (override !== undefined) { setState({ html: override, error: "", loading: false }); return; }
    if (!fileId) { setState({ html: "", error: "", loading: false }); return; }
    let off = false; setState({ html: "", error: "", loading: true });
    invoke<{ data: number[] }>("read_attachment", { id: fileId })
      .then(f => { if (!off) setState({ html: new TextDecoder().decode(Uint8Array.from(f.data)), error: "", loading: false }); })
      .catch(e => { if (!off) setState({ html: "", error: String(e instanceof Error ? e.message : e), loading: false }); });
    return () => { off = true; };
  }, [fileId, override]);
  return state;
}

/** A card with the page's name and address. It is what is shown whenever a page cannot (or should not) be shown inside NOU. */
function Card({ title, url, why, children }: { title: string; url: string; why: string; children?: React.ReactNode }) {
  return <div className="embed-card" role="group" aria-label={"Embedded page: " + title}>
    <strong>{title}</strong>{url && <code className="embed-url">{url}</code>}<p>{why}</p><div className="embed-actions">{children}</div>
  </div>;
}

/**
 * An embedded page. Live: a sandboxed frame of an allowed https page (it cannot navigate NOU), loaded lazily; if the host forbids framing, the page does not load in time, the
 * host is not on the list, or the computer is offline, a card is shown instead (never a blank frame), with a button to open the page in the browser. Snapshot: a copy of an .html file
 * stored with the page, shown in a frame with no network and no access to NOU. The frame is never given more permissions to make a page load.
 */
export default function EmbedView(p: EmbedProps) {
  const online = useOnline(), extra = useExtraHosts();
  const height = clampHeight(p.height);
  const [tryAnyway, setTryAnyway] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const shot = useAttachedHtml(p.mode === "snapshot" ? p.fileId : "", p.mode === "snapshot" ? p.html : undefined);
  useEffect(() => { setFailed(false); setTryAnyway(false); }, [p.url, p.mode]);

  let parsed: { href: string; host: string } | null = null, badUrl = "";
  if (p.mode === "live") { try { parsed = parseEmbedUrl(p.url); } catch (e) { badUrl = String(e instanceof Error ? e.message : e); } }
  const label = embedLabel(p.title, p.url);
  const open = () => { if (parsed) void invoke("open_bookmark", { url: parsed.href }).catch(e => p.onError?.(e)); };
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = p.mode === "live" && parsed && hostAllowed(parsed.host, allowedHosts(extra)) && online && (!knownUnframable(parsed.host) || tryAnyway) && !failed;
  useEffect(() => {
    clearTimeout(watchdog.current);
    if (live) watchdog.current = setTimeout(() => setFailed(true), LOAD_WAIT_MS); // a frame that never reports loading is treated as blocked (browsers raise no error event for a frame, and a page refused by X-Frame-Options still reports loading, which is why a known refusal is checked first)
    return () => clearTimeout(watchdog.current);
  }, [live, attempt, p.url]);

  function startDrag(e: React.PointerEvent) {
    e.preventDefault(); const y0 = e.clientY, h0 = height;
    const move = (m: PointerEvent) => setDrag(clampHeight(h0 + m.clientY - y0));
    const up = (m: PointerEvent) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setDrag(null); p.onChange?.({ height: clampHeight(h0 + m.clientY - y0) }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  const shownHeight = drag ?? height;

  let body: React.ReactNode;
  if (p.mode === "snapshot") {
    body = shot.loading ? <p className="hint embed-note">Opening the saved copy…</p>
      : shot.error ? <Card title={label} url="" why={"The saved copy could not be opened: " + shot.error} />
      : !shot.html ? <Card title={label} url="" why="No page is attached yet. Choose an .html file to keep a copy of the page inside this note.">{p.editable && <button type="button" onClick={() => file.current?.click()}>Attach an .html file…</button>}</Card>
      : <iframe className="embed-frame" title={label} sandbox={SNAPSHOT_SANDBOX} srcDoc={snapshotDocument(shot.html)} referrerPolicy="no-referrer" loading="lazy" style={{ height: shownHeight }} />;
  } else if (!parsed) {
    body = <Card title={label} url={p.url} why={p.url.trim() ? badUrl : "Add the page's address (https://…) to embed it."} />;
  } else if (!hostAllowed(parsed.host, allowedHosts(extra))) {
    body = <Card title={label} url={parsed.href} why={`${parsed.host} is not on your list of embeddable sites, so it is shown as a link. You can add it in Settings, Embedded pages.`}><button type="button" onClick={open}>Open in new tab</button></Card>;
  } else if (!online) {
    body = <Card title={label} url={parsed.href} why="You are offline. A live embed needs a connection; it will show again when you are back online. A snapshot works offline."><button type="button" onClick={open} disabled>Open in new tab</button></Card>;
  } else if (failed) {
    body = <Card title={label} url={parsed.href} why="This page did not load inside NOU. The site may not allow being shown in another app, or it is slow. NOU does not loosen the frame to force it."><button type="button" onClick={open}>Open in new tab</button><button type="button" onClick={() => { setFailed(false); setAttempt(a => a + 1); }}>Try again</button></Card>;
  } else if (!live) {
    body = <Card title={label} url={parsed.href} why={knownUnframable(parsed.host) ?? "This page cannot be shown here."}><button type="button" onClick={open}>Open in new tab</button><button type="button" onClick={() => setTryAnyway(true)}>Try live view anyway</button>{p.editable && <button type="button" onClick={() => p.onChange?.({ mode: "snapshot" })}>Use a snapshot instead</button>}</Card>;
  } else {
    body = <iframe key={attempt} className="embed-frame" title={label} src={parsed.href} sandbox={LIVE_SANDBOX} loading="lazy" referrerPolicy="no-referrer" style={{ height: shownHeight }} onLoad={() => clearTimeout(watchdog.current)} />;
  }
  const framed = p.mode === "snapshot" ? !!shot.html && !shot.error : !!live;
  return <div className="embed-block" contentEditable={false} data-mode={p.mode}>
    {p.editable && <div className="embed-bar">
      <input aria-label="Embed title" placeholder="Title" value={p.title} onChange={e => p.onChange?.({ title: e.target.value })} />
      {p.mode === "live" && <input aria-label="Embed address" placeholder="https://claude.ai/artifact/…" value={p.url} onChange={e => p.onChange?.({ url: e.target.value })} />}
      <div role="group" aria-label="How to show it" className="embed-mode"><button type="button" aria-pressed={p.mode === "live"} className={p.mode === "live" ? "on" : ""} onClick={() => p.onChange?.({ mode: "live" })}>Live</button><button type="button" aria-pressed={p.mode === "snapshot"} className={p.mode === "snapshot" ? "on" : ""} onClick={() => p.onChange?.({ mode: "snapshot" })}>Snapshot</button></div>
      {p.mode === "snapshot" && <button type="button" onClick={() => file.current?.click()}>{p.fileId ? "Replace the .html file…" : "Attach an .html file…"}</button>}
      <input ref={file} type="file" accept=".html,.htm,text/html" hidden aria-label="Choose an .html file" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void p.onAttach?.(f).catch(x => p.onError?.(x)); }} />
    </div>}
    {body}
    {framed && <div className="embed-foot">
      {p.mode === "live" ? <>Not showing? <button type="button" className="embed-link" onClick={open}>Open in new tab</button></> : <span>A saved copy: it will not update, and its scripts do not run.</span>}
      {p.editable && <button type="button" className="embed-grip" role="slider" aria-label="Embed height" aria-orientation="vertical" aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={shownHeight} title="Drag to resize"
        onPointerDown={startDrag} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); p.onChange?.({ height: clampHeight(height + (e.key === "ArrowDown" ? 40 : -40)) }); } }}>⠿</button>}
    </div>}
  </div>;
}
