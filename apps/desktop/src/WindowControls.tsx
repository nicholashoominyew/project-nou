import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** True inside the desktop app (the native title bar is switched off there, so the app draws its own). */
export const inDesktopApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Minimise, maximise or restore, and close, drawn in the top bar so the bar and the window frame look like one piece.
 * Close goes through the window's normal close request, so the app's "wait for unsaved work" guard still applies.
 * Hidden in fullscreen and outside the desktop app (a browser has its own).
 */
export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!inDesktopApp()) return;
    let off: (() => void) | undefined; let gone = false;
    const sync = async () => {
      try { const w = getCurrentWindow(); const [m, f] = await Promise.all([w.isMaximized?.() ?? false, w.isFullscreen?.() ?? false]); if (!gone) { setMaximized(!!m); setFullscreen(!!f); } } catch { /* the buttons still work */ }
    };
    void sync();
    try { Promise.resolve(getCurrentWindow().onResized?.(() => void sync())).then(u => { if (gone) u?.(); else off = u; }).catch(() => undefined); } catch { /* no resize events */ }
    return () => { gone = true; off?.(); };
  }, []);
  if (!inDesktopApp() || fullscreen) return null;
  const act = (f: (w: ReturnType<typeof getCurrentWindow>) => unknown) => () => { try { void f(getCurrentWindow()); } catch { /* ignore */ } };
  const icon = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1, "aria-hidden": true } as const;
  return <div className="win-controls" role="group" aria-label="Window controls">
    <button type="button" aria-label="Minimise" title="Minimise" onClick={act(w => w.minimize())}><svg {...icon}><path d="M0 5h10" /></svg></button>
    <button type="button" aria-label={maximized ? "Restore" : "Maximise"} title={maximized ? "Restore" : "Maximise"} onClick={act(w => w.toggleMaximize())}>
      {maximized ? <svg {...icon}><path d="M2.5 2.5h7v7h-7zM0.5 7.5v-7h7" /></svg> : <svg {...icon}><path d="M0.5 0.5h9v9h-9z" /></svg>}
    </button>
    <button type="button" className="close" aria-label="Close" title="Close" onClick={act(w => w.close())}><svg {...icon}><path d="M0 0l10 10M10 0L0 10" /></svg></button>
  </div>;
}
