import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
type Backup = { path: string; pages: number; manifest: { id: string; created_at: number; sha256: string; bytes: number; schema: number } };
export default function EncryptedBackup({ onPrepared, onBusyChange }: { onBusyChange?: (busy: boolean) => void; onPrepared: (preview: { token: string; backup: Backup }) => void }) {
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  async function run(mode: "export" | "restore") {
    setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try {
      if (mode === "export") {
        const path = await save({ defaultPath: `NOU-notes-${new Date().toISOString().slice(0,10)}.noubackup`, filters: [{ name: "Encrypted NOU backup", extensions: ["noubackup"] }] });
        if (!path) return;
        const result = await invoke<{ path: string; sha256: string }>("create_encrypted_backup", { path, password });
        setMessage(`Encrypted backup written and decrypted for verification: ${result.path}. SHA-256 ${result.sha256}. Test restoring it before relying on it.`);
      } else {
        const path = await open({ multiple: false, filters: [{ name: "Encrypted NOU backup", extensions: ["noubackup"] }] });
        if (typeof path !== "string") return;
        onPrepared(await invoke("prepare_encrypted_restore", { path, password }));
        setMessage("Passphrase accepted and Notes database verified. Review the replacement below; no notes have been replaced yet.");
      }
    } catch (e) { setError(String(e)); }
    finally { setPassword(""); setConfirm(""); setBusy(false); onBusyChange?.(false); }
  }
  return <section className="recovery-card"><h2>Password-encrypted backup</h2>
    <p>Create a portable encrypted copy of the complete Notes database (up to 64 MB). Use a long unique passphrase and save it separately in your password manager. NOU does not store it and cannot reset or recover it.</p>
    <p>This encrypts the exported file. Your working database, local rollback/staging copies and regular scheduled backup packages remain unencrypted by NOU. Use an encrypted drive for those. Decryption stages a local plaintext copy for the normal restore review.</p>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    <fieldset disabled={busy}>
      <label>Backup passphrase<input aria-label="Backup passphrase" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <label>Confirm passphrase for a new encrypted backup<input aria-label="Confirm backup passphrase" type="password" autoComplete="off" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
      <button disabled={Array.from(password).length < 12 || password !== confirm} onClick={() => void run("export")}>Export encrypted backup…</button>
      <button disabled={!password} onClick={() => void run("restore")}>Open encrypted backup for review…</button>
    </fieldset>
    {busy && <p role="status">Encrypting or verifying… Keep NOU open.</p>}
  </section>;
}
