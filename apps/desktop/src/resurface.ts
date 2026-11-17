export type Resurfaced = { id: string; title: string; updated_at: string; created_at: string; reason: "stale" | "anniversary" | string; years_ago: number | null };
export const SNOOZE_KEY = "nou-resurface-snoozed";
export const SNOOZE_DAYS = 14;

/** The local date as YYYY-MM-DD (not the UTC date, so "today" matches the person's clock). */
export function localDate(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}
/** Page id -> the date until which it is hidden. Anything malformed in storage is dropped; expired entries are pruned. */
export function readSnoozed(raw: unknown, today: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, until] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(until) && until > today && /^[0-9a-zA-Z-]{1,64}$/.test(id)) out[id] = until;
  }
  return out;
}
export const snooze = (snoozed: Record<string, string>, id: string, today: string, days = SNOOZE_DAYS): Record<string, string> => ({ ...snoozed, [id]: addDays(today, days) });
export const visible = (items: Resurfaced[], snoozed: Record<string, string>, today: string): Resurfaced[] => items.filter(p => !(snoozed[p.id] && snoozed[p.id] > today));

/** "5 months ago" style wording for how long a page has been left alone. */
export function untouched(updated: string, now = new Date()): string {
  const then = Date.parse(updated);
  if (Number.isNaN(then)) return "";
  const days = Math.max(0, Math.floor((now.getTime() - then) / 86400000));
  if (days < 45) return `${days} days`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  const years = Math.round(days / 365 * 10) / 10;
  return years === 1 ? "1 year" : `${years} years`;
}
export const reasonText = (p: Resurfaced, now = new Date()): string =>
  p.reason === "anniversary" ? (p.years_ago === 1 ? "Written a year ago today" : `Written ${p.years_ago ?? "some"} years ago today`) : `Not edited for ${untouched(p.updated_at, now)}`;
