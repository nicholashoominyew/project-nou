import { useCallback, useEffect, useRef, useState } from "react";
import { now } from "./clock";
import { reminderFor, type Reminder } from "./schedule";
import { useTick, useTimetable } from "./useTimetable";

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
    return { on: v?.on !== false, lead: Number.isFinite(lead) ? Math.min(30, Math.max(1, Math.round(lead))) : DEFAULT_SETTINGS.lead };
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
  const { timeline, activities } = useTimetable();
  const [toast, setToast] = useState<Reminder | null>(null);
  const latest = useRef({ timeline, activities, notify });
  latest.current = { timeline, activities, notify };
  const check = useCallback(() => {
    const s = readReminderSettings(); if (!s.on) return;
    const r = reminderFor(latest.current.timeline, latest.current.activities, now(), s.lead, readLast());
    if (!r) return;
    writeLast(r.key); // remembered before anything is shown, so a second tick, a reload or a tab switch can never repeat it
    setToast(r);
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
  }, [check, timeline, activities]);
  return { toast, dismiss: () => setToast(null) };
}

/** UP NEXT IN m:ss, the next event and its time range. Stays above focus mode. It counts down to the start and goes away by itself then. */
export function ReminderToast({ reminder, dismiss }: { reminder: Reminder | null; dismiss: () => void }) {
  const t = useTick(1000, now);
  const left = reminder ? reminder.start.getTime() - t.getTime() : 0;
  useEffect(() => { if (reminder && left <= 0) dismiss(); }, [reminder, left, dismiss]);
  if (!reminder || left <= 0) return null;
  const secs = Math.ceil(left / 1000);
  return <div className="tt-toast" role="status" aria-live="polite">
    <span className="tt-toast-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg></span>
    <span className="tt-toast-text">
      <span className="tt-toast-kicker">UP NEXT IN {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>
      <span className="tt-toast-name">{reminder.names}</span>
      <span className="tt-toast-range">{reminder.range}</span>
    </span>
    <button type="button" aria-label="Dismiss reminder" onClick={dismiss}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
  </div>;
}
