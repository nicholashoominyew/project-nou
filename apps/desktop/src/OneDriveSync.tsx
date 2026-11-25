import { applySettingsSnapshot, saveSettingsSnapshot } from "./syncSettings";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type SyncFile = { name: string; at: number; device: string; mine: boolean; prev: boolean; bytes: number };
export type SyncStatus = { folder: string | null; folder_ok: boolean; in_onedrive: boolean; device: string; last_sync_at: number | null; files: SyncFile[]; newer: SyncFile | null; pages_changed: number; pages: number };
type Backup = { path: string; pages: number; manifest: { id: string; created_at: number; sha256: string; bytes: number; schema: number; files?: { bytes: number; sha256: string } } };
export type SyncPreview = { token: string; backup: Backup };
const when = (secs: number) => new Date(secs * 1000).toLocaleString();
const kb = (bytes: number) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB");
const message = (e: unknown) => String(e instanceof Error ? e.message : e);

/**
 * Backup & sync through a folder (for example inside OneDrive), by taking turns. NOU puts a password-encrypted copy of this device's notes in the folder; on another
 * device, "Sync now" offers that copy. Nothing is merged and nothing is replaced without the usual review and the word RESTORE; the password is never stored.
 */
export default function OneDriveSync({ disabled, onBusyChange, onPrepared }: { disabled?: boolean; onBusyChange?: (busy: boolean) => void; onPrepared: (preview: SyncPreview, afterRestore: () => Promise<void>) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deciding, setDeciding] = useState(false);

  const refresh = useCallback(async () => {
    try { const s = await invoke<SyncStatus>("sync_status"); if (s && typeof s === "object") setStatus(s); } catch (e) { setError(message(e)); }
  }, []);
  useEffect(() => { void refresh(); void invoke<string | null>("sync_suggest_folder").then(p => setSuggested(typeof p === "string" ? p : null)).catch(() => setSuggested(null)); }, [refresh]);

  async function run(job: () => Promise<void>) {
    setBusy(true); onBusyChange?.(true); setError(""); setNotice("");
    try { await job(); } catch (e) { setError(message(e)); } finally { if (!remember) { setPassword(""); setConfirm(""); } setBusy(false); onBusyChange?.(false); await refresh(); }
  }
  const chooseFolder = (path: string) => run(async () => { setStatus(await invoke<SyncStatus>("sync_set_folder", { path })); setDeciding(false); });
  const push = (overwrite: boolean) => run(async () => {
    await saveSettingsSnapshot().catch(() => 0); // your settings travel in the same file
    const out = await invoke<{ name: string; bytes: number; removed: number }>("sync_push", { password, overwrite });
    setDeciding(false);
    setNotice(`Saved ${out.name} (${kb(out.bytes)}) to the folder. Wait until OneDrive shows it has finished uploading before you use another device.${out.removed ? ` ${out.removed} older file${out.removed === 1 ? "" : "s"} from this device were removed.` : ""}`);
  });
  const pull = (file: string) => run(async () => {
    await saveSettingsSnapshot().catch(() => 0); // the safety copy of this device includes its settings
    const preview = await invoke<SyncPreview>("sync_prepare_pull", { file, password });
    setDeciding(false);
    setNotice("Password accepted and the other device's copy verified. This device's current notes were saved to the folder first. Review the replacement below; nothing has been replaced yet.");
    onPrepared(preview, async () => { await invoke("sync_mark_pulled", { file }); const n = await applySettingsSnapshot().catch(() => 0); await refresh(); if (n > 0 && "__TAURI_INTERNALS__" in window) setTimeout(() => window.location.reload(), 1200); /* so the theme, layout and places of the other device show */ });
  });
  function syncNow() {
    if (status?.newer) { setDeciding(true); return; } // another device saved something newer: the owner chooses, nothing is overwritten
    void push(false);
  }
  function keepMine() {
    if (!window.confirm("Save this device's notes to the folder anyway?\n\nThe other device's newer copy stays in the folder as an older version. Its edits will not be on this device, and the other device will be offered this copy next time.")) return;
    void push(true);
  }

  const first = !!status && status.files.length === 0;
  const longEnough = Array.from(password).length >= 12;
  const ready = longEnough && (!first || password === confirm);
  const s = status;
  return <section className="recovery-card onedrive-sync" aria-label="Backup and sync with OneDrive">
    <h2>Backup &amp; sync with OneDrive</h2>
    <p>Keeps an encrypted copy of everything in NOU (notes, databases, tasks, the timetable, habits, uploaded files and your settings) in a folder, such as one inside OneDrive, so another device can pick it up. It works by taking turns: use one device at a time. NOU never merges two devices' notes and never replaces anything without showing you first. Only encrypted files go in the folder, and the password is never stored: use the same one on every device, and keep a copy in your password manager.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {s && !s.folder && <div>
      <p>Choose the folder to sync through. It should be a folder that OneDrive keeps in step (for example <code>OneDrive\NOU Sync</code>) and that holds nothing else of yours.</p>
      {suggested && <button disabled={disabled || busy} onClick={() => void chooseFolder(suggested)}>Use {suggested}</button>}
      <button disabled={disabled || busy} onClick={() => void (async () => { const path = await open({ directory: true, multiple: false, title: "Choose the folder to sync through" }); if (typeof path === "string") await chooseFolder(path); })()}>Choose another folder…</button>
    </div>}
    {s?.folder && <fieldset disabled={disabled || busy}>
      <p>Folder: <code>{s.folder}</code> <button onClick={() => void (async () => { const path = await open({ directory: true, multiple: false, title: "Choose the folder to sync through", defaultPath: s.folder ?? undefined }); if (typeof path === "string") await chooseFolder(path); })()}>Change…</button></p>
      {!s.folder_ok && <p className="warning" role="alert">This folder cannot be found right now. Check that OneDrive is running and the folder still exists.</p>}
      {s.folder_ok && !s.in_onedrive && <p className="hint">This folder does not look like it is inside OneDrive, so nothing will be uploaded unless something else syncs it.</p>}
      <p className="hint">This device ({s.device}): {s.pages} pages{s.last_sync_at ? `, ${s.pages_changed} edited since the last sync at ${when(s.last_sync_at)}` : ", never synced"}. The page count is only a guide: every save holds everything.</p>
      <label>Sync password<input aria-label="Sync password" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} /></label>
      {first && <label>Confirm the password (this is the first save in this folder)<input aria-label="Confirm sync password" type="password" autoComplete="off" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>}
      <label className="tt-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Keep the password while this screen is open</label>
      {!ready && <p className="hint" role="status">{!password ? "Type your sync password (at least 12 characters) to turn on Sync now." : !longEnough ? "Use at least 12 characters." : "Type the same password again to confirm it."}</p>}
      {first && !!confirm && password !== confirm && <p className="hint">The two passwords are different.</p>}
      {!!s.files.length && !s.newer && s.last_sync_at && <p className="hint">Up to date: nothing newer from another device is waiting in the folder.</p>}
      {!deciding && <button disabled={!ready || !s.folder_ok} onClick={syncNow}>Sync now</button>}
      {s.newer && !deciding && <p role="status" className="hint">Another device saved a newer copy on {when(s.newer.at)}. “Sync now” will ask what to do.</p>}
      {deciding && s.newer && <div className="restore-preview" role="region" aria-label="A newer copy is in the folder">
        <h3>Another device saved a newer copy</h3>
        <p>{when(s.newer.at)} · from another device ({s.newer.device}) · {kb(s.newer.bytes)}. This device has {s.pages_changed} page{s.pages_changed === 1 ? "" : "s"} edited since its last sync{s.last_sync_at ? "" : " (it has never synced)"}. The counts only cover pages, but either copy replaces everything on the other device: notes, timetable, habits and settings.</p>
        <p><strong>Use the other device's copy</strong> first saves this device's notes into the folder as a safety copy, then lets you review the replacement. <strong>Keep this device's notes</strong> saves them as the new latest copy and leaves the other device's copy in the folder as an older version.</p>
        <button disabled={!ready} onClick={() => void pull(s.newer!.name)}>Use the other device's copy…</button>
        <button disabled={!ready} onClick={keepMine}>Keep this device's notes and save them</button>
        <button onClick={() => setDeciding(false)}>Cancel</button>
      </div>}
      <button onClick={() => void run(async () => { await refresh(); })}>Check the folder</button>
      <p className="hint">Each save is an encrypted file of up to 64 MB (notes and uploaded files together). If a save is refused for size, use a regular backup instead.</p>
      {!!s.files.length && <div><h3>In the folder</h3>
        <ul className="sync-files" aria-label="Files in the sync folder">{s.files.map(f => <li key={f.name}>{when(f.at)} · {f.mine ? "this device" : `another device (${f.device})`} · {kb(f.bytes)}{f.prev ? " · safety copy" : ""}</li>)}</ul></div>}
    </fieldset>}
    {!s && <p className="hint">Loading…</p>}
  </section>;
}
