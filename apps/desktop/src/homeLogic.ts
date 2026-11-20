/** Pure helpers for the Home screen: daylight, the writing streak, activity shading and the small bar charts. No screen, no network. */
import { dayKey, parseDay } from "./timeLogic";

const RAD = Math.PI / 180;

/** Sunrise and sunset (as instants) for a place, from the standard "sunrise equation". Null in polar day or night. Good to a few minutes. */
function sunCore(now: Date, lat: number, lng: number): { rise: Date; set: Date } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const jd = now.getTime() / 86400000 + 2440587.5;
  const n = Math.ceil(jd - 2451545.0 + 0.0008), jStar = n - lng / 360; // east longitude is positive: solar noon comes earlier in UTC the further east you are
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinD = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD), cosD = Math.cos(Math.asin(sinD));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinD) / (Math.cos(lat * RAD) * cosD);
  if (!Number.isFinite(cosW) || cosW < -1 || cosW > 1) return null;
  const w = Math.acos(cosW) / RAD, toDate = (j: number) => new Date((j - 2440587.5) * 86400000);
  return { rise: toDate(transit - w / 360), set: toDate(transit + w / 360) };
}

/** The calendar date (YYYY-MM-DD) at a place: by its IANA time zone when known, otherwise by longitude (15 degrees per hour). */
export function placeDate(at: Date, lng: number, tz?: string): string {
  if (tz) { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at); } catch { /* fall through to longitude */ } }
  return new Date(at.getTime() + (lng / 15) * 3600000).toISOString().slice(0, 10);
}
/**
 * Sunrise and sunset on the place's own calendar day containing `now`. (The raw formula returns the next solar day's events when it is
 * evening in one time zone and already tomorrow in another, so the neighbouring days are tried and the one that belongs to today is used.)
 */
export function sunTimes(now: Date, lat: number, lng: number, tz?: string): { rise: Date; set: Date } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const today = placeDate(now, lng, tz);
  let fallback: { rise: Date; set: Date } | null = null;
  for (const k of [0, -1, 1]) {
    const t = sunCore(new Date(now.getTime() + k * 86400000), lat, lng);
    if (!t) continue;
    fallback = fallback ?? t;
    if (placeDate(new Date((t.rise.getTime() + t.set.getTime()) / 2), lng, tz) === today) return t;
  }
  return fallback;
}

/** Which weather place the daylight arc should describe: the one in the device's own time zone, otherwise the first. */
export function pickSunPlace(zones: (string | null | undefined)[], deviceZone: string, choice: "auto" | number = "auto", present: boolean[] = [true, true]): number {
  if (typeof choice === "number" && present[choice]) return choice; // the place picked by hand wins
  const i = zones.findIndex((z, k) => !!z && z === deviceZone && present[k] !== false);
  return i >= 0 ? i : Math.max(0, present.findIndex(Boolean));
}

/** Where the sun is on its arc: 0 at sunrise to 1 at sunset, `up` false at night (the position then stays at the nearer end). */
export function sunPosition(now: Date, t: { rise: Date; set: Date }): { fraction: number; up: boolean; leftMinutes: number } {
  const f = (now.getTime() - t.rise.getTime()) / (t.set.getTime() - t.rise.getTime());
  return { fraction: Math.min(1, Math.max(0, f)), up: f >= 0 && f <= 1, leftMinutes: Math.max(0, Math.round((t.set.getTime() - now.getTime()) / 60000)) };
}

/** The last `count` days (today last) and whether a daily page exists for each, plus the run of days ending today (or yesterday, if today is not written yet). */
export function writingDays(titles: string[], today: Date, count = 14): { days: { date: string; written: boolean }[]; streak: number } {
  const have = new Set(titles.map(t => t.trim()).filter(t => parseDay(t)));
  const days = Array.from({ length: count }, (_, i) => { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - i)); return { date: dayKey(d), written: have.has(dayKey(d)) }; });
  let streak = 0, i = days.length - 1;
  if (!days[i].written) i--;
  while (i >= 0 && days[i].written) { streak++; i--; }
  return { days, streak };
}

/** 0 to 3: how busy a day is, for the calendar shading. */
export const activityLevel = (items: number) => (items <= 0 ? 0 : items === 1 ? 1 : items === 2 ? 2 : 3);

/** Number of pages last edited on each of the last `count` days (today last), for the little bars on Recently edited. */
export function editsPerDay(stamps: string[], today: Date, count = 14): number[] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1)).getTime();
  const out = Array.from({ length: count }, () => 0);
  for (const s of stamps) {
    const t = Date.parse(s);
    if (Number.isNaN(t) || t < start) continue;
    const d = new Date(t), idx = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - start) / 86400000);
    if (idx >= 0 && idx < count) out[idx]++;
  }
  return out;
}

/** Position of `value` between `low` and `high` (0 to 1), for the temperature range bar. */
export function rangePosition(value: number, low: number, high: number): number {
  return high <= low ? 0.5 : Math.min(1, Math.max(0, (value - low) / (high - low)));
}

/** How far a note has drifted: its age against a year, for the bar on Worth revisiting. */
export const staleFraction = (days: number | null | undefined) => Math.min(1, Math.max(0, (days ?? 0) / 365));

/** Picks up to `count` items for a given day, the same ones all day and different ones tomorrow. */
export function pickForDay<T>(items: T[], day: string, count = 5): T[] {
  if (items.length <= count) return items;
  let h = 0;
  for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const start = h % items.length;
  return Array.from({ length: count }, (_, i) => items[(start + i) % items.length]);
}

/** Hour of day in a zone, as a fraction of 24 (for the day band and the sun or moon icon). */
export function dayFraction(hour: number, minute: number): number { return (hour * 60 + minute) / 1440; }
export const isDaytime = (hour: number) => hour >= 6 && hour < 18;
