import { invoke } from "@tauri-apps/api/core";

/**
 * The preferences kept in this window that should be the same on every device: look and layout, places, reminders, countdowns. They are copied into the database just before a
 * sync (so they travel in the same encrypted file as the notes) and put back after another device's copy is restored. Things that belong to one screen or one moment
 * (open tabs, the split view, sidebar width, the simulated clock, the last reminder shown) are left out on purpose.
 */
export const SHARED_SETTINGS = [
  "nou-theme", "nou-swatch", "nou-tile", "nou-home-layout", "nou-countdowns", "nou-clocks", "nou-zones", "nou-weather-places", "nou-sun-place", "nou-sun-custom",
  "nou-files-view", "nou-timetable-reminders", "nou-menu-hint", "nou-menu-icon", "nou-menu-row", "nou-menu-search", "nou-inbox-page", "nou-resurface-snoozed", "nou-collapsed",
  "nou-last-highlight", "nou-chat-seen", "nou-embed-hosts", "nou-habit-target",
] as const;

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
/** Copy this window's shared preferences into the database. Returns how many were saved. */
export async function saveSettingsSnapshot(): Promise<number> {
  const entries: { key: string; value: string }[] = [];
  for (const key of SHARED_SETTINGS) { const value = read(key); if (value !== null && value.length <= 60000) entries.push({ key, value }); }
  return (await invoke<number>("app_settings_save_cmd", { entries })) ?? entries.length;
}
/** Put the preferences stored in the (just restored) database back into this window. Returns how many were applied. */
export async function applySettingsSnapshot(): Promise<number> {
  const entries = await invoke<{ key: string; value: string }[]>("app_settings_get_cmd");
  let n = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!(SHARED_SETTINGS as readonly string[]).includes(e.key) || typeof e.value !== "string") continue;
    try { localStorage.setItem(e.key, e.value); n++; } catch { /* storage full or blocked: skip this one */ }
  }
  return n;
}
