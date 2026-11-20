import { useCallback, useEffect, useRef, useState } from "react";
import { now } from "./clock";
import { reminderFor } from "./schedule";
import { useTimetable } from "./useTimetable";

// Reminders for the next timetable event.
// WHERE THIS RUNS: the decision is made here, in the page, from the wall-clock time (one tested copy of the rules: schedule.ts).
// What the page cannot do is keep its own timers running while the window is hidden or minimised, so the Rust side runs a native thread
// that sends a "timetable-tick" event every 10 seconds. That event is not throttled, so the check runs on time in the background; an
// ordinary 5-second interval, and the focus / visibility events, cover everything else (including waking from sleep).
export const SETTINGS_KEY = "nou-timetable-reminders";
export const LAST_KEY = "nou-timetable-last-reminder";
export interface ReminderSettings { on: boolean; lead: number }
export const DEFAULT_SETTINGS: ReminderSettings = { on: true, lead: 5 };

export function readReminderSettings(): ReminderSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") as Partial<ReminderSettings> | null;
    const lead = Number(v?.lead);
    return { on: v?.on !== false, lead: Number.isFinite(lead) ? Math.min(60, Math.max(1, Math.round(lead))) : DEFAULT_SETTINGS.lead };
  } catch { return DEFAULT_SETTINGS; }
}
export function writeReminderSettings(s: ReminderSettings) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* the default is used */ } window.dispatchEvent(new Event("nou-reminders-changed")); }
const readLast = () => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };
const writeLast = (key: string) => { try { localStorage.setItem(LAST_KEY, key); } catch { /* may then repeat after a reload; harmless */ } };

let permissionAsked = false;
/** A Windows notification through the Tauri notification plugin. Resolves false (so the caller keeps the toast) when it is unavailable or denied. */
export async function notifyNative(body: string): Promise<boolean> {
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let granted = await n.isPermissionGranted();
    if (!granted && !permissionAsked) { permissionAsked = true; granted = (await n.requestPermission()) === "granted"; }
    if (!granted) return false;
    n.sendNotification({ title: "Project NOU", body });
    return true;
  } catch { return false; }
}

/** Mounted once for the whole app. Returns the in-app toast text and a way to dismiss it. */
export function useReminders(notify: (body: string) => Promise<boolean> = notifyNative) {
  const { grid, activities } = useTimetable();
  const [toast, setToast] = useState<string | null>(null);
  const latest = useRef({ grid, activities, notify });
  latest.current = { grid, activities, notify };
  const check = useCallback(() => {
    const s = readReminderSettings(); if (!s.on) return;
    const r = reminderFor(latest.current.grid, latest.current.activities, now(), s.lead, readLast());
    if (!r) return;
    writeLast(r.key); // remembered before anything is shown, so a second tick, a reload or a tab switch can never repeat it
    setToast(r.text);
    void latest.current.notify(r.text);
  }, []);
  useEffect(() => {
    check();
    const id = setInterval(check, 5000);
    const resume = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("focus", check); window.addEventListener("nou-sim-changed", check);
    let off: (() => void) | undefined; let gone = false;
    import("@tauri-apps/api/event").then(m => m.listen("timetable-tick", check)).then(u => { if (gone) u(); else off = u; }).catch(() => { /* not running inside Tauri */ });
    return () => { gone = true; clearInterval(id); off?.(); document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", check); window.removeEventListener("nou-sim-changed", check); };
  }, [check, grid, activities]);
  return { toast, dismiss: () => setToast(null) };
}

export function ReminderToast({ text, dismiss }: { text: string | null; dismiss: () => void }) {
  useEffect(() => { if (!text) return; const id = setTimeout(dismiss, 30000); return () => clearTimeout(id); }, [text, dismiss]);
  if (!text) return null;
  return <div className="tt-toast" role="status" aria-live="polite"><span>{text}</span><button aria-label="Dismiss reminder" onClick={dismiss}>×</button></div>;
}
