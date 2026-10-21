import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
type Schedule = { enabled: boolean; auto_keep: number | null; last_attempt: number | null; last_success: { at: number; path: string; sha256: string; destination: string } | null; error: string | null };
const time = (value: number | null | undefined) => value ? new Date(value * 1000).toLocaleString() : "Never";
export default function BackupSchedule({ hasDestination, onBusyChange }: { hasDestination: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [state, setState] = useState<Schedule>(); const [enabled, setEnabled] = useState(false);
  const [cleanup, setCleanup] = useState(false); const [keep, setKeep] = useState(10);
  const [task, setTask] = useState<boolean>(); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    void invoke<Schedule>("backup_schedule_status").then(s => {
      if (cancelled || !s) return; setState(s); setEnabled(s.enabled); setCleanup(s.auto_keep !== null); setKeep(s.auto_keep ?? 10);
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);
  async function save() {
    setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try { const s = await invoke<Schedule>("configure_backup_schedule", { enabled, autoKeep: cleanup ? keep : null }); setState(s); setMessage(enabled ? "Weekly backups enabled. Due copies run within a minute while NOU is open; missed weeks produce one catch-up copy." : "Weekly backups disabled."); }
    catch (e) { setError(String(e)); } finally { setBusy(false); onBusyChange?.(false); }
  }
  async function resetUnreadable() {
    setBusy(true); onBusyChange?.(true); setError("");
    try { const s = await invoke<Schedule>("reset_backup_schedule"); setState(s); setEnabled(false); setCleanup(false); setMessage("Previous settings preserved. Schedule and automatic cleanup are disabled; configure them again when ready."); }
    catch (e) { setError(String(e)); } finally { setBusy(false); onBusyChange?.(false); }
  }
  async function background(value: boolean | null) {
    setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try { const registered = await invoke<boolean>("background_backup_task", { enabled: value }); setTask(registered); setMessage(registered ? "Windows task is installed. It checks hourly and at sign-in, even with NOU closed. Weekly backups must also be enabled." : "Windows background task is not installed."); }
    catch (e) { setError(String(e)); } finally { setBusy(false); onBusyChange?.(false); }
  }
  return <section className="recovery-card"><h2>Weekly backups & catch-up</h2>
    <p>One verified copy every seven days. An unavailable destination is retried every 15 minutes while NOU is open. Missed weeks create one catch-up copy. Nothing runs while this PC is powered off.</p>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    {state?.error && <p className="error" role="alert">Last scheduled attempt: {state.error}</p>}
    <p>Last verified backup: {time(state?.last_success?.at)}. Last attempt: {time(state?.last_attempt)}.</p>
    {state?.last_success && <p><code>{state.last_success.path}</code></p>}
    {!state && error && <button disabled={busy} onClick={() => void resetUnreadable()}>Reset unreadable schedule (preserve original)</button>}
    <fieldset disabled={busy || !state}>
      <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable weekly backups to the chosen destination</label>
      <label><input type="checkbox" checked={cleanup} onChange={e => setCleanup(e.target.checked)} /> After a successful scheduled backup, automatically delete eligible old versions</label>
      {cleanup && <><label>Minimum verified versions to retain<input aria-label="Automatic versions to keep" type="number" min={3} max={10000} value={keep} onChange={e => setKeep(Number(e.target.value))} /></label><p>At least three verified versions and all copies younger than seven days remain. Invalid packages and local rollback copies stay untouched.</p></>}
      <button disabled={(enabled && !hasDestination) || (cleanup && (!Number.isInteger(keep) || keep < 3 || keep > 10000))} onClick={() => void save()}>Save backup schedule</button>
      <h3>Run while NOU is closed (Windows)</h3>
      <p>Install a per-user Windows task to check hourly and at sign-in. It runs while you are signed in, needs no administrator password, and uses the same database lock. Reinstall the task if you move NOU. A locked/encrypted destination must already be unlocked.</p>
      <button onClick={() => void background(true)}>Install or repair Windows backup task</button>
      <button onClick={() => void background(null)}>Check Windows task</button>
      <button onClick={() => void background(false)}>Remove Windows backup task</button>
      {task !== undefined && <p>Windows task: {task ? "installed" : "not installed"}.</p>}
    </fieldset>
  </section>;
}
