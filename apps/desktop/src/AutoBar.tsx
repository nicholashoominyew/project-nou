import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AUTO_CHANGED, announceAuto, openAutoScreen, type AutoOverview, type AutoUnseen } from "./autoApprove";

/** On Home, above what is waiting: the pause switch (it takes effect at once) and how many changes were approved automatically. */
export default function AutoBar({ disabled }: { disabled: boolean }) {
  const [data, setData] = useState<AutoOverview | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const o = await invoke<AutoOverview>("auto_overview"); setData(o && Array.isArray(o.rules) ? o : null);
      const u = await invoke<AutoUnseen>("auto_unseen"); setCount(u?.count ?? 0);
    } catch { setData(null); }
  }, []);
  useEffect(() => { void load(); window.addEventListener(AUTO_CHANGED, load); const timer = window.setInterval(() => void load(), 15000); return () => { window.removeEventListener(AUTO_CHANGED, load); window.clearInterval(timer); }; }, [load]);
  if (!data) return null;
  const pause = async (paused: boolean) => {
    setError("");
    try { await invoke("auto_set_switches", { featureOn: true, paused }); } catch (e) { setError(String(e)); }
    announceAuto(); await load();
  };
  return <div className="auto-bar" aria-label="Auto-approval">
    {data.feature_on
      ? <label className="auto-switch"><input type="checkbox" checked={data.paused} disabled={disabled} onChange={e => void pause(e.target.checked)} /> Pause all auto-approval</label>
      : <span className="hint">Auto-approval is off.</span>}
    <button onClick={openAutoScreen}>{count > 0 ? `${count} approved automatically · View` : data.feature_on ? "Rules and history" : "Set up"}</button>
    {error && <span className="error" role="alert">{error}</span>}
  </div>;
}
