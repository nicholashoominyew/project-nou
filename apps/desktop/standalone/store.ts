// The standalone page has no database: this keeps the same data the desktop app keeps (activities, the two alternating weeks, the swap
// setting) in the browser's localStorage, and answers the same commands the Rust side answers, with the same rules and messages.
import seedFile from "../src-tauri/seed/life_timetable.json";

type Runs = [string, string, string[]][];
interface Seed { activities: { name: string; category: string; remind: boolean }[]; days: Record<string, Runs>; variants?: Record<string, Record<string, Runs>> }
const seed = seedFile as unknown as Seed;
interface Act { id: string; name: string; category: string; colour: string | null; remind: boolean; sort_order: number }
interface Slot { variant: string; weekday: number; slot_index: number; activity_id: string }
interface Cell { weekday: number; slot_index: number; activity_ids: string[] }
interface Store { activities: Act[]; slots: Slot[]; swap: boolean }

const KEY = "nou-standalone-timetable-v1";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const CATEGORIES = ["Work", "Rest", "Leisure", "Travel", "Chores", "Training", "Health"];
const MAX_PER_SLOT = 12, MAX_ACTIVITIES = 200;
const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : "a" + Math.random().toString(36).slice(2) + Date.now().toString(36));

function minutes(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
/** The shipped plan of one week as "weekday|slot|activity name (lower case)". */
function plan(variant: string): Set<string> {
  const out = new Set<string>();
  DAYS.forEach((day, d) => {
    const runs = seed.variants?.[variant]?.[day] ?? seed.days[day] ?? [];
    for (const [start, end, names] of runs) for (let s = minutes(start) / 30; s < minutes(end) / 30; s++) for (const n of names) out.add(`${d}|${s}|${n.toLowerCase()}`);
  });
  return out;
}
function fresh(): Store {
  const activities: Act[] = seed.activities.map((a, i) => ({ id: newId(), name: a.name, category: a.category, colour: null, remind: a.remind, sort_order: i }));
  const byName = new Map(activities.map(a => [a.name.toLowerCase(), a.id]));
  const slots: Slot[] = [];
  for (const variant of ["A", "B"]) for (const key of plan(variant)) {
    const [d, s, name] = key.split("|"); const id = byName.get(name); if (id) slots.push({ variant, weekday: Number(d), slot_index: Number(s), activity_id: id });
  }
  return { activities, slots, swap: false };
}

let state: Store | null = null;
function load(): Store {
  if (state) return state;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null") as Store | null;
    if (v && Array.isArray(v.activities) && Array.isArray(v.slots)) return (state = { activities: v.activities, slots: v.slots, swap: !!v.swap });
  } catch { /* start from the plan */ }
  return (state = fresh());
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* kept in memory for this visit */ } }

const variantOk = (v: string) => { if (v !== "A" && v !== "B") throw "Variant must be A or B"; };
const cellOf = (s: Store, variant: string, weekday: number, slot: number): Cell =>
  ({ weekday, slot_index: slot, activity_ids: s.slots.filter(x => x.variant === variant && x.weekday === weekday && x.slot_index === slot).map(x => x.activity_id).sort() });
const known = (s: Store, ids: string[]) => { for (const id of ids) if (!s.activities.some(a => a.id === id)) throw "Unknown activity"; };
const writeCell = (s: Store, variant: string, weekday: number, slot: number, ids: string[]) => {
  s.slots = s.slots.filter(x => !(x.variant === variant && x.weekday === weekday && x.slot_index === slot));
  for (const id of new Set(ids)) s.slots.push({ variant, weekday, slot_index: slot, activity_id: id });
};
const edited = (s: Store, variant: string) => {
  const names = new Map(s.activities.map(a => [a.id, a.name.toLowerCase()]));
  const actual = new Set(s.slots.filter(x => x.variant === variant).map(x => `${x.weekday}|${x.slot_index}|${names.get(x.activity_id)}`));
  const want = plan(variant);
  return actual.size !== want.size || [...actual].some(k => !want.has(k));
};
function cleanName(name: string) { const n = String(name ?? "").trim(); if (!n || [...n].length > 80 || /[\u0000-\u001f\u007f]/.test(n)) throw "An activity name is 1 to 80 characters"; return n; }
const taken = (s: Store, name: string, except?: string) => s.activities.some(a => a.id !== except && a.name.toLowerCase() === name.toLowerCase());

export function invoke(command: string, args: any = {}): unknown {
  const s = load();
  switch (command) {
    case "timetable_get":
      return { system_page_id: null, swap_ab: s.swap, activities: [...s.activities].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
        slots: [...s.slots].sort((a, b) => a.variant.localeCompare(b.variant) || a.weekday - b.weekday || a.slot_index - b.slot_index || a.activity_id.localeCompare(b.activity_id)),
        edited: { a: edited(s, "A"), b: edited(s, "B") } };
    case "timetable_save_range": {
      const { variant, weekdays, start, end, activityIds } = args as { variant: string; weekdays: number[]; start: number; end: number; activityIds: string[] };
      variantOk(variant);
      const days = [...new Set(weekdays)];
      if (!days.length || days.some(d => !(d >= 0 && d <= 6))) throw "Pick at least one day, Monday to Sunday";
      if (!(start >= 0 && start < 48) || !(end >= 1 && end <= 48) || end <= start) throw "The end must be after the start, within one day";
      const ids = [...new Set(activityIds)];
      if (!ids.length) throw "Pick at least one activity";
      if (ids.length > MAX_PER_SLOT) throw `A slot can hold at most ${MAX_PER_SLOT} activities`;
      known(s, ids);
      const before: Cell[] = [];
      for (const d of days.sort()) for (let i = start; i < end; i++) { before.push(cellOf(s, variant, d, i)); writeCell(s, variant, d, i, ids); }
      save(); return before;
    }
    case "timetable_restore_cells": {
      const { variant, cells } = args as { variant: string; cells: Cell[] };
      variantOk(variant);
      if (cells.length > 7 * 48) throw "Too many slots";
      for (const c of cells) { if (!(c.weekday >= 0 && c.weekday <= 6) || !(c.slot_index >= 0 && c.slot_index < 48) || c.activity_ids.length > MAX_PER_SLOT) throw "Invalid slot"; known(s, c.activity_ids); }
      for (const c of cells) writeCell(s, variant, c.weekday, c.slot_index, c.activity_ids);
      save(); return null;
    }
    case "timetable_reset_variant": {
      const { variant } = args as { variant: string }; variantOk(variant);
      for (const a of seed.activities) if (!taken(s, a.name)) s.activities.push({ id: newId(), name: a.name, category: a.category, colour: null, remind: true, sort_order: Math.max(-1, ...s.activities.map(x => x.sort_order)) + 1 });
      const byName = new Map(s.activities.map(a => [a.name.toLowerCase(), a.id]));
      s.slots = s.slots.filter(x => x.variant !== variant);
      for (const key of plan(variant)) { const [d, i, name] = key.split("|"); const id = byName.get(name); if (id) s.slots.push({ variant, weekday: Number(d), slot_index: Number(i), activity_id: id }); }
      save(); return null;
    }
    case "timetable_set_swap": s.swap = !!(args as { swap: boolean }).swap; save(); return null;
    case "timetable_add_activity": {
      const name = cleanName(args.name); if (!CATEGORIES.includes(args.category)) throw "Unknown category";
      if (s.activities.length >= MAX_ACTIVITIES) throw "Too many activities";
      if (taken(s, name)) throw "An activity with that name already exists";
      const a: Act = { id: newId(), name, category: args.category, colour: null, remind: true, sort_order: Math.max(-1, ...s.activities.map(x => x.sort_order)) + 1 };
      s.activities.push(a); save(); return a;
    }
    case "timetable_update_activity": {
      const a = args.activity as { id: string; name: string; category: string; colour: string | null; remind: boolean };
      const name = cleanName(a.name); if (!CATEGORIES.includes(a.category)) throw "Unknown category";
      const colour = (a.colour ?? "").trim(); if (colour && !/^#[0-9a-fA-F]{6}$/.test(colour)) throw "A colour looks like #1a2b3c";
      const row = s.activities.find(x => x.id === a.id); if (!row) throw "Activity not found";
      if (taken(s, name, a.id)) throw "An activity with that name already exists";
      Object.assign(row, { name, category: a.category, colour: colour ? colour.toLowerCase() : null, remind: !!a.remind }); save(); return null;
    }
    case "timetable_delete_activity": {
      const { id, reassignTo } = args as { id: string; reassignTo: string | null };
      const used = s.slots.filter(x => x.activity_id === id);
      if (used.length) {
        const to = reassignTo && reassignTo !== id ? reassignTo : null;
        if (!to) throw `This activity is used in ${used.length} slots. Pick another activity to take them over, or clear them first`;
        if (!s.activities.some(a => a.id === to)) throw "The activity to reassign to does not exist";
        for (const x of used) if (!s.slots.some(y => y.variant === x.variant && y.weekday === x.weekday && y.slot_index === x.slot_index && y.activity_id === to)) s.slots.push({ ...x, activity_id: to });
        s.slots = s.slots.filter(x => x.activity_id !== id);
      }
      if (!s.activities.some(a => a.id === id)) throw "Activity not found";
      s.activities = s.activities.filter(a => a.id !== id); save(); return null;
    }
    default: return null;
  }
}

/** The whole timetable as text, for a backup file. */
export const exportData = () => JSON.stringify({ app: "project-nou-life-timetable", version: 1, ...load() }, null, 1);
/** Replace the timetable with a backup made by exportData. Throws a readable message when the file is not one. */
export function importData(text: string) {
  let v: any; try { v = JSON.parse(text); } catch { throw "That file is not a timetable backup"; }
  if (v?.app !== "project-nou-life-timetable" || !Array.isArray(v.activities) || !Array.isArray(v.slots)) throw "That file is not a timetable backup";
  state = { activities: v.activities, slots: v.slots, swap: !!v.swap }; save();
  window.dispatchEvent(new Event("nou-timetable-changed"));
}
