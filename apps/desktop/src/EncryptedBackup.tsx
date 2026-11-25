import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
type Backup = { path: string; pages: number; manifest: { id: string; created_at: number; sha256: string; bytes: number; schema: number } };
export default function EncryptedBackup({ onPrepared, onBusyChange, onReviewStart }: { onReviewStart?: () => void; onBusyChange?: (busy: boolean) => void; onPrepared: (preview: { token: string; backup: Backup }) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  async function run() {
    setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try {
      {
        const path = await open({ multiple: false, filters: [{ name: "Encrypted NOU backup", extensions: ["noubackup"] }] });
        if (typeof path !== "string") return;
        onReviewStart?.();
        onPrepared(await invoke("prepare_encrypted_restore", { path, password }));
        setMessage("Password accepted and Notes database verified. Review the replacement below; no notes have been replaced yet.");
      }
    } catch (e) { setError(String(e)); }
    finally { setPassword(""); setBusy(false); onBusyChange?.(false); }
  }
  return <div className="encrypted-restore"><h3>A password-encrypted backup file (.noubackup)</h3>
    <p className="hint">For files made earlier with the old encrypted export. New encrypted copies are made by the OneDrive sync above. NOU does not store the password and cannot reset it.</p>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    <fieldset disabled={busy}>
      <label>Backup password<input aria-label="Backup password" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button disabled={!password} onClick={() => void run()}>Open encrypted backup for review…</button>
    </fieldset>
    {busy && <p role="status">Verifying… Keep NOU open.</p>}
  </div>;
}
