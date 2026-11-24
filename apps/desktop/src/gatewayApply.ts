import { invoke } from "@tauri-apps/api/core";
import { newRichUpdate } from "./richUpdate";
import { appendBlocksToNote } from "./noteAppend";
import { DEFAULT_LAYOUT_KEY, HOME_LAYOUT_EVENT, HOME_NEVER_HIDDEN, HOME_WIDGET_IDS, HOME_WIDGET_INFO, normalizeLayout, setWidgetHidden } from "./homeLayout";
import { addActivity, restoreCells, saveRange } from "./timetable/useTimetable";

/** One request from an outside client, as the gateway stores it. Never trust its shape: every field is re-checked here. */
export type Proposal = {
  id: string; token_id: string; token_name: string; op: string; payload: Record<string, unknown>; summary: string;
  status: string; created_at: string; decided_at: string | null; applied_at: string | null; result: string | null;
};

const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const id = (v: unknown) => typeof v === "string" && /^[0-9a-zA-Z-]{1,64}$/.test(v);

export const OP_LABELS: Record<string, string> = {
  create_page: "Create a page", rename_page: "Rename a page", set_value: "Change a database cell", create_row: "Add a database row",
  append_text: "Add text to a page", add_checklist_item: "Add a checklist item",
  timetable_set_block: "Change the Life Timetable", timetable_add_activity: "Add a timetable activity", home_set_widgets: "Show or hide Home sections",
};
/** Operations the app can apply today. The others can be viewed and rejected but not approved. */
export const APPLICABLE_OPS = ["create_page", "rename_page", "set_value", "create_row", "append_text", "add_checklist_item", "timetable_set_block", "timetable_add_activity", "home_set_widgets"] as const;
/** An open copy of the page reloads itself, so an approved change shows up without reopening the page. */
function announceNoteChanged(pageId: string) { try { window.dispatchEvent(new CustomEvent("nou:note-changed", { detail: pageId })); } catch { /* only a refresh hint */ } }
export const canApply = (op: string) => (APPLICABLE_OPS as readonly string[]).includes(op);

// ---- the Life Timetable and the Home page ----
const DAYS: Record<string, number> = { mon: 0, monday: 0, tue: 1, tuesday: 1, wed: 2, wednesday: 2, thu: 3, thursday: 3, fri: 4, friday: 4, sat: 5, saturday: 5, sun: 6, sunday: 6 };
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CATEGORIES = ["Work", "Rest", "Leisure", "Travel", "Chores", "Training", "Health"];
const list = (v: unknown, what: string, max: number): unknown[] => { if (!Array.isArray(v) || v.length > max) throw new Error(`${what} must be a list of at most ${max}`); return v; };
const timeToSlot = (v: unknown, what: string, allow24: boolean): number => {
  const m = typeof v === "string" ? /^(\d\d):(00|30)$/.exec(v) : null;
  const h = m ? Number(m[1]) : -1;
  if (!m || (h > 23 && !(allow24 && h === 24 && m[2] === "00"))) throw new Error(`${what} must be a time on the hour or half hour, like 09:00`);
  return h * 2 + (m[2] === "30" ? 1 : 0);
};
const slotTime = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
export type TimetableBlock = { weeks: ("A" | "B")[]; days: number[]; start: number; end: number; names: string[] };
/** Check a "change a stretch of the timetable" request and turn it into slots. Throws a plain message when anything is wrong; nothing is trusted. */
export function parseTimetableBlock(d: Record<string, unknown>): TimetableBlock {
  const weeks = list(d.weeks, "weeks", 2); if (!weeks.length || weeks.some(w => w !== "A" && w !== "B") || new Set(weeks).size !== weeks.length) throw new Error("weeks must be A, B or both");
  const days = list(d.days, "days", 7).map(x => (typeof x === "string" ? DAYS[x.trim().toLowerCase()] : undefined));
  if (!days.length || days.some(x => x === undefined) || new Set(days).size !== days.length) throw new Error("days must be day names such as Mon, Tue");
  const start = timeToSlot(d.start, "start", false), end = timeToSlot(d.end, "end", true);
  if (end <= start) throw new Error("The end must be after the start");
  const names = list(d.activities, "activities", 12);
  if (names.some(n => typeof n !== "string" || !n.trim() || n.length > 80) || new Set(names.map(n => (n as string).trim().toLowerCase())).size !== names.length) throw new Error("activities must be different names of 1 to 80 characters (or none, to leave the stretch empty)");
  return { weeks: weeks as ("A" | "B")[], days: (days as number[]).sort((a, b) => a - b), start, end, names: (names as string[]).map(n => n.trim()) };
}
export type HomeWidgetChange = { show: string[]; hide: string[] };
/** Check a "show or hide Home sections" request. The approvals section can be shown but never hidden by a request. */
export function parseHomeWidgets(d: Record<string, unknown>): HomeWidgetChange {
  const ids = (v: unknown, what: string) => { const a = v === undefined ? [] : list(v, what, 20); if (a.some(x => typeof x !== "string" || !HOME_WIDGET_IDS.includes(x)) || new Set(a).size !== a.length) throw new Error(`${what} must name sections of the Home page`); return a as string[]; };
  const show = ids(d.show, "show"), hide = ids(d.hide, "hide");
  if (!show.length && !hide.length) throw new Error("Name at least one section to show or hide");
  if (show.some(s => hide.includes(s))) throw new Error("A section cannot be both shown and hidden");
  if (hide.includes(HOME_NEVER_HIDDEN)) throw new Error("The “Waiting for approval” section cannot be hidden by a request");
  return { show, hide };
}
const titleOf = (id: string) => HOME_WIDGET_INFO.find(w => w.id === id)?.title ?? id;
/** One plain sentence about what approving would do, for the approval card. Null when the request is not one of these or is badly shaped (the card then shows the raw fields). */
export function describeProposal(op: string, d: Record<string, unknown>): string | null {
  try {
    if (op === "timetable_set_block") {
      const b = parseTimetableBlock(d);
      return `In week ${b.weeks.join(" and ")}, on ${b.days.map(x => DAY_SHORT[x]).join(", ")}, ${slotTime(b.start)}–${slotTime(b.end)} will be ${b.names.length ? "set to " + b.names.join(" + ") : "emptied"}, replacing what is there now.`;
    }
    if (op === "timetable_add_activity") return text(d.name, 80) && CATEGORIES.includes(d.category as string) ? `A new activity “${(d.name as string).trim()}” (${d.category}) will be added to your list. It is not placed on any day.` : null;
    if (op === "home_set_widgets") { const c = parseHomeWidgets(d); return [c.show.length ? "Show: " + c.show.map(titleOf).join(", ") : "", c.hide.length ? "Hide: " + c.hide.map(titleOf).join(", ") : ""].filter(Boolean).join(". ") + ". Nothing else on the Home page changes."; }
  } catch { return null; }
  return null;
}

/**
 * Apply an approved proposal through the app's own commands (the same ones a person's edits use), so validation,
 * the restore barrier and backups all still apply. Returns a short result for the audit log; never throws.
 */
export async function applyProposal(p: Pick<Proposal, "op" | "payload">): Promise<{ ok: boolean; result: string }> {
  const d = p.payload;
  try {
    switch (p.op) {
      case "create_page": {
        if (!text(d.title, 200)) throw new Error("The title is missing or too long");
        if (d.parent !== undefined && !id(d.parent)) throw new Error("The parent page id is invalid");
        const page = await invoke<{ id: string }>("create_page", { parentId: (d.parent as string | undefined) ?? null, title: (d.title as string).trim(), initialUpdate: await newRichUpdate() });
        return { ok: true, result: "Created page " + page.id };
      }
      case "rename_page": {
        if (!id(d.page) || !text(d.title, 200)) throw new Error("The page or title is invalid");
        await invoke("rename_page", { pageId: d.page, title: (d.title as string).trim() });
        return { ok: true, result: "Renamed page " + d.page };
      }
      case "set_value": {
        if (!id(d.row) || !id(d.property) || !("value" in d)) throw new Error("The row, property or value is missing");
        await invoke("set_value", { rowId: d.row, propertyId: d.property, value: d.value });
        return { ok: true, result: "Updated a cell" };
      }
      case "create_row": {
        if (!id(d.database)) throw new Error("The database id is invalid");
        if (d.title !== undefined && !text(d.title, 200)) throw new Error("The title is invalid");
        const values = d.values === undefined ? {} : d.values;
        if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("The values must be an object");
        const row = await invoke<{ id: string }>("add_row", { databaseId: d.database, initialUpdate: await newRichUpdate() });
        if (typeof d.title === "string") await invoke("rename_page", { pageId: row.id, title: d.title.trim() });
        for (const [property, value] of Object.entries(values as Record<string, unknown>)) await invoke("set_value", { rowId: row.id, propertyId: property, value });
        return { ok: true, result: "Added row " + row.id };
      }
      case "append_text": {
        if (!id(d.page)) throw new Error("The page id is invalid");
        if (typeof d.text !== "string" || !d.text.trim() || d.text.length > 20000) throw new Error("The text is missing or longer than 20,000 characters");
        // Each non-empty line becomes a plain paragraph. Control characters are dropped; nothing is interpreted as markup.
        const lines = d.text.split(/\r?\n/).map(l => l.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim()).filter(Boolean);
        if (!lines.length) throw new Error("There is no text to add");
        if (lines.length > 200 || lines.some(l => l.length > 2000)) throw new Error("The text has too many lines (200) or a line over 2,000 characters");
        const out = await appendBlocksToNote(d.page as string, lines.map(text => ({ type: "paragraph" as const, text })));
        if (out.changed) announceNoteChanged(d.page as string);
        return { ok: true, result: out.message };
      }
      case "add_checklist_item": {
        if (!id(d.page)) throw new Error("The page id is invalid");
        if (!text(d.text, 500) || /[\r\n]/.test(d.text as string)) throw new Error("A to-do must be one line of up to 500 characters");
        if (d.checked !== undefined && typeof d.checked !== "boolean") throw new Error("checked must be true or false");
        const out = await appendBlocksToNote(d.page as string, [{ type: "checkListItem", text: (d.text as string).trim(), checked: d.checked === true }]);
        if (out.changed) announceNoteChanged(d.page as string);
        return { ok: true, result: out.message };
      }
      case "timetable_set_block": {
        const b = parseTimetableBlock(d);
        const known = (await invoke<{ activities: { id: string; name: string }[] }>("timetable_get"))?.activities ?? [];
        const byName = new Map(known.map(a => [a.name.trim().toLowerCase(), a.id]));
        const missing = b.names.filter(n => !byName.has(n.toLowerCase()));
        if (missing.length) throw new Error(`There is no activity called “${missing[0]}”. Ask for it to be added first.`);
        const ids = b.names.map(n => byName.get(n.toLowerCase())!);
        for (const week of b.weeks) {
          if (ids.length) await saveRange(week, b.days, b.start, b.end, ids);
          else await restoreCells(week, b.days.flatMap(day => Array.from({ length: b.end - b.start }, (_, i) => ({ weekday: day, slot_index: b.start + i, activity_ids: [] as string[] }))));
        }
        return { ok: true, result: `Set week ${b.weeks.join(" and ")} ${b.days.map(x => DAY_SHORT[x]).join(", ")} ${slotTime(b.start)}-${slotTime(b.end)} to ${b.names.length ? b.names.join(" + ") : "nothing planned"}` };
      }
      case "timetable_add_activity": {
        if (!text(d.name, 80) || !CATEGORIES.includes(d.category as string)) throw new Error("The name or category is invalid");
        const made = await addActivity((d.name as string).trim(), d.category as string);
        return { ok: true, result: "Added the activity " + made.name };
      }
      case "home_set_widgets": {
        const c = parseHomeWidgets(d);
        let raw: unknown = null; try { raw = JSON.parse(localStorage.getItem(DEFAULT_LAYOUT_KEY) || "null"); } catch { /* start from the default */ }
        let layout = normalizeLayout(raw, HOME_WIDGET_IDS);
        for (const id of c.show) layout = setWidgetHidden(layout, id, false);
        for (const id of c.hide) layout = setWidgetHidden(layout, id, true);
        localStorage.setItem(DEFAULT_LAYOUT_KEY, JSON.stringify(layout));
        try { window.dispatchEvent(new Event(HOME_LAYOUT_EVENT)); } catch { /* only a refresh hint */ }
        return { ok: true, result: `Home: ${[c.show.length ? "showed " + c.show.join(", ") : "", c.hide.length ? "hid " + c.hide.join(", ") : ""].filter(Boolean).join("; ")}` };
      }
      default:
        return { ok: false, result: "This kind of request cannot be applied yet" };
    }
  } catch (e) {
    return { ok: false, result: String(e instanceof Error ? e.message : e).slice(0, 500) };
  }
}
