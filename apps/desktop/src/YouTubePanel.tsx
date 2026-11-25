import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { cancelJob, findDatabase, getJob, loadSettings, MODELS, requestJob, saveSettings, setupDatabase, subscribe, type Settings } from "./youtube";

type Check = { ok: boolean; python: string | null; version?: string; packages?: Record<string, string | null>; missing: string[]; ffmpeg?: boolean; javascript?: string | null; install: string[] };
const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

/** Get transcripts of YouTube videos into the transcripts database. Everything runs on this PC. A job carries on if you leave this screen. */
export default function YouTubePanel({ onClose, onOpenPage, refresh }: { onClose: () => void; onOpenPage: (id: string) => void; refresh: () => Promise<void> | void }) {
  const [s, setS] = useState<Settings>(loadSettings);
  const [urls, setUrls] = useState("");
  const [reextract, setReextract] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [where, setWhere] = useState<{ pageId: string | null; databaseId: string | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const job = useSyncExternalStore(subscribe, getJob);
  const log = useRef<HTMLPreElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Settings>) => setS(old => { const next = { ...old, ...patch }; saveSettings(next); return next; });

  const lookForDatabase = useCallback(async () => { try { setWhere(await findDatabase()); } catch (e) { setError(msg(e)); } }, []);
  const runCheck = useCallback(async (python: string) => {
    setChecking(true);
    try { setCheck(await invoke<Check>("yt_check", { python })); } catch (e) { setError(msg(e)); } finally { setChecking(false); }
  }, []);
  useEffect(() => { void lookForDatabase(); void runCheck(loadSettings().python); }, [lookForDatabase, runCheck]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [job.log]);
  useEffect(() => { if (!job.running && job.summary) void refresh(); }, [job.running, job.summary, refresh]);

  const lines = urls.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ready = !!where?.databaseId && !!check?.ok;
  async function extract() {
    setError("");
    try { await requestJob({ targets: lines, settings: s, reextract }); } catch (e) { setError(msg(e)); }
  }
  async function setup() {
    setBusy(true); setError("");
    try { await setupDatabase(); await refresh(); } catch (e) { setError(msg(e)); } finally { setBusy(false); await lookForDatabase(); }
  }
  async function folder() { const d = await open({ directory: true, multiple: false, title: "Folder for transcript files" }).catch(e => { setError(msg(e)); return null; }); if (typeof d === "string") set({ outDir: d }); }
  async function cookies() { const p = await open({ directory: false, multiple: false, title: "Choose a cookies.txt file", filters: [{ name: "cookies.txt", extensions: ["txt"] }] }).catch(e => { setError(msg(e)); return null; }); if (typeof p === "string") set({ cookieFile: p }); }

  return <div className="yt-screen document">
    <div className="auto-head"><h1>YouTube Transcripts</h1><button onClick={onClose}>Back</button></div>
    <p className="hint">Captions come from YouTube; when there are none, Whisper transcribes the audio on this PC. Each video becomes a row in your Transcripts database.</p>
    {error && <p className="error" role="alert">{error}</p>}

    {where && !where.databaseId && <section className="auto-card" aria-label="Set up">
      <p>{where.pageId ? "The “YouTube Transcripts” page has no transcripts database yet." : "There is no “YouTube Transcripts” page yet."} Setting it up {where.pageId ? "" : "creates the page, "}adds a database with URL, Method, Minutes and Added columns inside it. Nothing already there is changed.</p>
      <button className="auto-primary" disabled={busy} onClick={() => void setup()}>Set up the database</button>
    </section>}

    <section className="auto-card" aria-label="What is needed">
      <div className="auto-actions"><strong>{checking ? "Checking Python…" : check?.ok ? "Ready" : "Something is missing"}</strong><button disabled={checking} onClick={() => void runCheck(s.python)}>Check again</button></div>
      {check && <p className="auto-meta">{check.python ? `Python ${check.version} · ${Object.entries(check.packages ?? {}).map(([k, v]) => `${k} ${v ?? "missing"}`).join(" · ")} · JavaScript runtime ${check.javascript ?? "none"} · ffmpeg ${check.ffmpeg ? "found" : "not found (not needed)"}` : "Python was not found."}</p>}
      {check && !check.ok && <>
        <p className="warning" role="alert">Missing: {check.missing.join(", ")}. To install into a folder of NOU's own, run these two lines in PowerShell, then Check again. Whisper models download on first use.</p>
        <pre className="yt-code">{check.install.join("\n")}</pre>
      </>}
      <label>Python to use (leave empty to find it)<input aria-label="Python path" value={s.python} placeholder="For example C:\Python312\python.exe" onChange={e => set({ python: e.target.value })} onBlur={() => void runCheck(s.python)} /></label>
    </section>

    <section className="auto-card" aria-label="Videos">
      <label>Video, playlist or channel addresses, one per line<textarea aria-label="Addresses" rows={5} value={urls} onChange={e => setUrls(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></label>
      <div className="auto-actions">
        <input ref={file} type="file" accept=".txt,text/plain" hidden aria-label="Choose a .txt file" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void f.text().then(t => setUrls(old => (old.trim() ? old.replace(/\s*$/, "\n") : "") + t.trim() + "\n")).catch(x => setError(msg(x))); }} />
        <button onClick={() => file.current?.click()}>Load from .txt</button>
        <label className="auto-switch"><input type="checkbox" checked={reextract} onChange={e => setReextract(e.target.checked)} /> Re-extract (overwrite videos already saved)</label>
      </div>
    </section>

    <section className="auto-card yt-options" aria-label="Options">
      <label>Languages, in order<input aria-label="Languages" value={s.langs} onChange={e => set({ langs: e.target.value })} /></label>
      <label className="auto-switch"><input type="checkbox" checked={s.timestamps} onChange={e => set({ timestamps: e.target.checked })} /> Timestamps</label>
      <label className="auto-switch"><input type="checkbox" checked={s.whisperFallback} onChange={e => set({ whisperFallback: e.target.checked })} /> Use Whisper when there are no captions</label>
      <label className="auto-switch"><input type="checkbox" checked={s.forceWhisper} onChange={e => set({ forceWhisper: e.target.checked })} /> Always use Whisper</label>
      <label>Whisper model<select aria-label="Whisper model" value={s.model} onChange={e => set({ model: e.target.value })}>{MODELS.map(m => <option key={m}>{m}</option>)}</select></label>
      <label>Device<select aria-label="Device" value={s.device} onChange={e => set({ device: e.target.value })}><option>auto</option><option>cuda</option><option>cpu</option></select></label>
      <label>YouTube cookies from<select aria-label="Cookies from browser" value={s.cookieBrowser} onChange={e => set({ cookieBrowser: e.target.value })}>{["none", "firefox", "edge", "chrome", "brave", "opera", "chromium"].map(b => <option key={b}>{b}</option>)}</select></label>
      <label>or a cookies.txt file<span className="yt-row"><input aria-label="Cookies file" value={s.cookieFile} onChange={e => set({ cookieFile: e.target.value })} /><button onClick={() => void cookies()}>Browse…</button></span></label>
      <label className="auto-switch"><input type="checkbox" checked={s.saveFiles} onChange={e => set({ saveFiles: e.target.checked })} /> Also save files</label>
      {s.saveFiles && <label>Folder and format<span className="yt-row"><input aria-label="Output folder" value={s.outDir} onChange={e => set({ outDir: e.target.value })} /><button onClick={() => void folder()}>Browse…</button>
        <select aria-label="File format" value={s.format} onChange={e => set({ format: e.target.value })}><option>txt</option><option>srt</option><option>json</option></select></span></label>}
      <p className="hint">Cookies help when YouTube says it thinks you are a bot, or blocks your address. Only the file's path is remembered. A browser may need to be closed before its cookies can be read.</p>
    </section>

    <section className="auto-card" aria-label="Run">
      <div className="auto-actions">
        <button className="auto-primary" disabled={job.running || !lines.length || !ready || (s.saveFiles && !s.outDir.trim())} onClick={() => void extract()}>Extract</button>
        <button disabled={!job.running || job.cancelling} onClick={() => void cancelJob().catch(e => setError(msg(e)))}>{job.cancelling ? "Cancelling…" : "Cancel"}</button>
        {where?.pageId && <button className="link-button" onClick={() => onOpenPage(where.pageId!)}>Open the page</button>}
      </div>
      <progress aria-label="Progress" max={Math.max(job.total, 1)} value={job.done} />
      <div className="auto-meta">{job.total ? `${job.done} of ${job.total}` : job.running ? "Starting…" : ""}</div>
      <pre ref={log} className="yt-code yt-log" role="log" aria-label="Log">{job.log.join("\n")}</pre>
    </section>
  </div>;
}
