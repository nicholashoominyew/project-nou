import EncryptedBackup from "./EncryptedBackup";
import BackupSchedule from "./BackupSchedule";
import OneDriveSync from "./OneDriveSync";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Backup = { path: string; pages: number; manifest: { id: string; created_at: number; sha256: string; bytes: number; schema: number; files?:{bytes:number;sha256:string} } };
type Record = { id: string; source: string; rollback: string };
type Status = { destination: { path: string; protection: string } | null; interrupted: Record[]; rollback: Backup[] };
type Preview = { token: string; backup: Backup };
type Retention = { token: string; remove: Backup[]; retained: number; skipped: number };
const date = (b: Backup) => new Date(b.manifest.created_at * 1000).toLocaleString();

export default function BackupPanel({ onClose, onBusyChange }: { onClose: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = useState<Status>();
  const [versions, setVersions] = useState<Backup[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [confirmation, setConfirmation] = useState("");
  const [retention, setRetention] = useState<Retention>();
  const [keep, setKeep] = useState(10);
  const [keepCurrent, setKeepCurrent] = useState("");
  // Set when the review below was opened by the OneDrive sync: run after a successful restore so the sync remembers it is up to date.
  const afterRestore = useRef<(() => Promise<void>) | undefined>(undefined);
  // The review opens far below the button that asked for it (several screens, from the sync), so it is brought into view; otherwise it looks as if nothing happened.
  const review = useRef<HTMLDivElement>(null);
  useEffect(() => { if (preview) review.current?.scrollIntoView?.({ block: "center" }); }, [preview]);

  async function refresh() {
    const s = await invoke<Status>("backup_status"); setStatus(s);
    if (s.destination) {
      const [items, ignored] = await invoke<[Backup[], number]>("list_backups");
      setVersions(items); setSkipped(ignored);
    }
  }
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
  function markBusy(value: boolean) { setBusy(value); onBusyChange?.(value); }
  async function run(action: () => Promise<void>) {
    markBusy(true); setError(""); setMessage("");
    try { await action(); await refresh(); }
    catch (e) { setError(String(e)); try { setStatus(await invoke<Status>("backup_status")); } catch { /* Keep the actionable first error. */ } }
    finally { markBusy(false); }
  }
  async function prepare(path: string) {
    setPreview(undefined); setConfirmation(""); afterRestore.current = undefined;
    const p = await invoke<Preview>("prepare_restore", { path });
    setPreview(p); setRetention(undefined);
  }
  return <main className="recovery-screen">
    <header><div><small>NOU / Notes</small><h1>Backups & restore</h1></div>
      <button disabled={busy} onClick={onClose}>Back to notes</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    <fieldset disabled={busy}>
      {!!status?.interrupted.length && <section className="recovery-card warning">
        <h2>A restore needs review</h2>
        <p>Editing is paused. A restore was interrupted or could not finish. Inspect your current notes, then keep them or restore a preserved rollback below. NOU will not guess which version you want.</p>
        {status.interrupted.map(r => <p key={r.id}>Rollback: <code>{r.rollback}</code>
          <button onClick={() => void run(() => prepare(r.rollback))}>Review this rollback</button></p>)}
        <label>After inspecting the notes, type KEEP CURRENT DATABASE<input value={keepCurrent} onChange={e => setKeepCurrent(e.target.value)} /></label>
        <button disabled={keepCurrent !== "KEEP CURRENT DATABASE"} onClick={() => void run(async () => {
          await invoke("review_restore", { confirmation: keepCurrent }); setKeepCurrent(""); setMessage("Current database verified and preserved. Editing is enabled.");
        })}>Keep the current database</button>
      </section>}
      <OneDriveSync disabled={busy} onBusyChange={markBusy} onPrepared={(p, after) => { setPreview(p); setConfirmation(""); setRetention(undefined); afterRestore.current = after; }} />
      <section className="recovery-card">
        <h2>Backup copies</h2>
        <p>Keep verified copies of everything in NOU in a folder. For real protection, choose a folder on another drive or in the cloud: NOU cannot tell whether a folder is truly separate, and these copies are not encrypted (the OneDrive sync above is). Backups include notes, databases, tasks, the timetable, habits and uploaded files.</p>
        <button onClick={() => void run(async () => {
          const path = await open({ directory: true, multiple: false, title: "Choose an existing dedicated backup folder" });
          if (typeof path === "string") { await invoke("set_backup_destination", { path, protection: "local-or-unknown" }); setRetention(undefined); }
        })}>{status?.destination ? "Change backup folder" : "Choose backup folder"}</button>
        <p>Folder: <code>{status?.destination?.path ?? "Not chosen yet"}</code></p>
        <button disabled={!status?.destination} onClick={() => void run(async () => {
          const b = await invoke<Backup>("create_backup"); setMessage(`Backup verified: ${b.path}. ${b.pages} pages including Trash. SHA-256 ${b.manifest.sha256}`);
        })}>Create verified backup now</button>
      </section>
      <BackupSchedule hasDestination={!!status?.destination} onBusyChange={markBusy} />
      <section className="recovery-card">
        <h2>Restore</h2>
        <p>Restore replaces <strong>all current notes and Trash</strong>. A verified rollback copy is kept locally first. The selected package is copied into staging and checked again before replacement.</p>
        <button onClick={() => void run(async () => {
          const path = await open({ directory: true, multiple: false, title: "Choose a backup-… folder containing manifest.json and notes.sqlite3" });
          if (typeof path === "string") await prepare(path);
        })}>Choose a backup package…</button>

        <details className="backup-more"><summary>Other ways to restore</summary>
                  <button onClick={() => void run(async () => {
            const path = await open({ directory: false, multiple: false, title: "Import an old standalone NOU snapshot", filters: [{ name: "SQLite snapshot", extensions: ["sqlite3"] }] });
            if (typeof path === "string") {
              setPreview(undefined); setConfirmation(""); setRetention(undefined); afterRestore.current = undefined;
              setPreview(await invoke<Preview>("prepare_legacy_restore", { path }));
              setMessage(`Imported a separate copy of ${path}. The review date is the import time, not the original snapshot date. Original file unchanged.`);
            }
          })}>Import an old .sqlite3 snapshot…</button>
          <EncryptedBackup onBusyChange={markBusy} onReviewStart={() => { setPreview(undefined); setConfirmation(""); setRetention(undefined); afterRestore.current = undefined; }} onPrepared={p => { setPreview(p); setConfirmation(""); setRetention(undefined); afterRestore.current = undefined; }} />
        </details>
        {skipped > 0 && <p role="status">{skipped} incomplete or invalid package(s) excluded and left untouched.</p>}
        {versions.map(b => <div className="backup-version" key={b.path}><span>{date(b)} · {b.pages} pages · {Math.ceil((b.manifest.bytes+(b.manifest.files?.bytes??0)) / 1024)} KB<small>{b.manifest.id}</small></span><button onClick={() => void run(() => prepare(b.path))}>Verify & review</button></div>)}
        {!!status?.rollback.length && <div><h3>Undo a restore</h3><p className="hint">These copies stay on this PC. NOU saves one just before every restore and before a database upgrade; review one to go back.</p>
          {status.rollback.map(b => <div className="backup-version" key={b.path}><span>{date(b)} · {b.pages} pages<small>{b.path}</small></span><button onClick={() => void run(() => prepare(b.path))}>Review rollback</button></div>)}</div>}
        {preview && <div ref={review} className="restore-preview" role="region" aria-label="Restore review">
          <h3>Review the replacement</h3><p>{date(preview.backup)} · {preview.backup.pages} pages including Trash · schema {preview.backup.manifest.schema}</p>
          <p>Verified staged package: <code>{preview.backup.path}</code></p><p>SHA-256: <code>{preview.backup.manifest.sha256}</code></p><p>{preview.backup.manifest.files?"Notes + uploaded files":"Notes only — legacy package"}</p>
          <p>Your current database will be preserved in local rollback storage. Neither your original backup nor its older versions will be deleted.</p>
          <label>Type RESTORE to replace all notes<input aria-label="Restore confirmation" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
          <button className="danger" disabled={confirmation !== "RESTORE"} onClick={() => void run(async () => {
            const r = await invoke<Record>("execute_restore", { token: preview.token, confirmation });
            setPreview(undefined); setConfirmation("");
            try { await afterRestore.current?.(); } catch { /* the restore itself succeeded; the sync state is refreshed next time */ } finally { afterRestore.current = undefined; }
            setMessage(`Restore completed and verified. Return to notes to inspect it. Rollback preserved at ${r.rollback}`);
          })}>Restore all notes</button><button onClick={() => { setPreview(undefined); setConfirmation(""); afterRestore.current = undefined; }}>Cancel</button>
        </div>}
      </section>
      <details className="recovery-card backup-more"><summary>Clean up old backups</summary><p>Cleanup is manual. Always retain at least three verified versions and every version younger than seven days. Corrupt, incomplete, unknown and rollback files are never automatically removed.</p>
        <label>Minimum versions to keep<input type="number" min={3} max={10000} value={keep} onChange={e => { setKeep(Number(e.target.value)); setRetention(undefined); }} /></label>
        <button disabled={!status?.destination || !Number.isInteger(keep) || keep < 3} onClick={() => void run(async () => { setRetention(await invoke<Retention>("preview_retention", { keep })); })}>Preview cleanup</button>
        {retention && <div><p>{retention.retained} verified versions kept; {retention.skipped} invalid packages left untouched. {retention.remove.length} old versions proposed for deletion:</p>
          <ul>{retention.remove.map(b => <li key={b.path}>{b.manifest.id} · {date(b)}</li>)}</ul>
          <button disabled={!retention.remove.length} onClick={() => void run(async () => {
            const count = await invoke<number>("apply_retention", { token: retention.token, confirmation: "DELETE OLD BACKUPS" });
            setRetention(undefined); setMessage(`Deleted ${count} reviewed old backup versions.`);
          })}>Delete only these listed old versions</button></div>}
      </details>
    </fieldset>
    {busy && <p role="status">Working… Keep NOU open until this operation finishes.</p>}
  </main>;
}
