// The one place the app asks "what time is it?" for the Life Timetable. It is the device's wall clock, read fresh on every call.
// In a development build (or one made with VITE_NOU_SIM_TIME=1) a simulated offset can be set to test reminders without waiting.
const KEY = "nou-sim-offset";
export const simulationAllowed = Boolean(import.meta.env?.DEV) || import.meta.env?.VITE_NOU_SIM_TIME === "1";

function offset(): number {
  if (!simulationAllowed) return 0;
  try { const v = Number(localStorage.getItem(KEY)); return Number.isFinite(v) ? v : 0; } catch { return 0; }
}
/** The current local time (plus the simulated offset, when one is set in a development build). */
export const now = (): Date => new Date(Date.now() + offset());
export const isSimulated = (): boolean => offset() !== 0;
/** Make "now" read as `target` from here on (it keeps moving). Pass null to go back to the real time. */
export function simulate(target: Date | null): void {
  if (!simulationAllowed) return;
  try { if (target === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(target.getTime() - Date.now())); } catch { /* a testing aid only */ }
  window.dispatchEvent(new Event("nou-sim-changed"));
}
