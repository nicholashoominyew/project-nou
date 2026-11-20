import type { Activity, Category } from "./schedule";

/** Colours for a category come from CSS variables (--tt-work, --tt-work-ink, ...) defined per theme in theme.css, so they follow the app's light/dark switch. */
export const catFill = (c: Category | string) => `var(--tt-${c.toLowerCase()})`;
export const catInk = (c: Category | string) => `var(--tt-${c.toLowerCase()}-ink)`;

/** Black or white, whichever reads better on a hex colour (WCAG relative luminance). */
export function inkFor(hex: string): "#000000" | "#ffffff" {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) return "#000000";
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.179 ? "#000000" : "#ffffff"; // above this the black text has the higher contrast
}
/** Fill and text colour for one activity: its own colour when it has one, otherwise its category's. */
export function colours(a: Pick<Activity, "category" | "colour"> | undefined): { fill: string; ink: string } {
  if (!a) return { fill: catFill("Rest"), ink: catInk("Rest") };
  return a.colour ? { fill: a.colour, ink: inkFor(a.colour) } : { fill: catFill(a.category), ink: catInk(a.category) };
}
