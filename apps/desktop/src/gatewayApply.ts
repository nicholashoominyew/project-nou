import { invoke } from "@tauri-apps/api/core";
import { newRichUpdate } from "./richUpdate";
import { appendBlocksToNote, type AddedBlock } from "./noteAppend";
import { DEFAULT_LAYOUT_KEY, HOME_LAYOUT_EVENT, HOME_NEVER_HIDDEN, HOME_WIDGET_IDS, HOME_WIDGET_INFO, normalizeLayout, setWidgetHidden } from "./homeLayout";
import { addActivity, restoreCells, saveRange } from "./timetable/useTimetable";
import { announceHabits, habitsApi, todayLocal } from "./habitsApi";
import { HABIT_TYPES, WEEKDAYS } from "./habitsLogic";
import { allowedHosts, clampHeight, hostAllowed, MAX_HEIGHT, MAX_HTML, MIN_HEIGHT, parseEmbedUrl } from "./embed";

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
  habit_add: "Add a habit", habit_tick: "Tick a habit for a day", todo_reorder: "Reorder Today's tasks",
  append_embed: "Embed a page in a note", attach_html: "Attach an HTML page to a note",
};
/** Operations the app can apply today. The others can be viewed and rejected but not approved. */
export const APPLICABLE_OPS = ["create_page", "rename_page", "set_value", "create_row", "append_text", "add_checklist_item", "timetable_set_block", "timetable_add_activity", "home_set_widgets", "habit_add", "habit_tick", "todo_reorder", "append_embed", "attach_html"] as const;
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

// ---- habits and Today's tasks ----
export type HabitAdd = { name: string; category: string; days: number };
/** Check an "add a habit" request: a name, an optional type (default Health) and optional day names (default every day). */
export function parseHabitAdd(d: Record<string, unknown>): HabitAdd {
  if (!text(d.name, 60) || /[\u0000-\u001f]/.test(d.name as string)) throw new Error("The habit needs a name of 1 to 60 characters");
  const category = d.category === undefined ? "Health" : d.category;
  if (typeof category !== "string" || !(HABIT_TYPES as readonly string[]).includes(category)) throw new Error("The type must be one of " + HABIT_TYPES.join(", "));
  let days = 127;
  if (d.days !== undefined) {
    const names = list(d.days, "days", 7).map(x => (typeof x === "string" ? DAYS[x.trim().toLowerCase()] : undefined));
    if (!names.length || names.some(x => x === undefined) || new Set(names).size !== names.length) throw new Error("days must be day names such as Mon, Tue");
    days = (names as number[]).reduce((m, x) => m | (1 << x), 0);
  }
  return { name: (d.name as string).trim().replace(/\s+/g, " "), category, days };
}
export type HabitTick = { habit: string; day: string; done: boolean };
/** Check a "tick or clear a habit on a day" request. The day must be a real day that has already begun (the app checks again). */
export function parseHabitTick(d: Record<string, unknown>): HabitTick {
  if (!text(d.habit, 60)) throw new Error("Name the habit");
  if (typeof d.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.day) || Number.isNaN(new Date(d.day + "T12:00:00").getTime()) || new Date(d.day + "T12:00:00").toISOString().slice(0, 10) !== d.day) throw new Error("The day must be written like 2026-11-24");
  if (typeof d.done !== "boolean") throw new Error("done must be true or false");
  return { habit: (d.habit as string).trim(), day: d.day, done: d.done };
}
export type TodoOrder = { order: string[] };
const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
/** Check a "put Today's tasks in this order" request: task texts, each once, as the owner sees them. */
export function parseTodoOrder(d: Record<string, unknown>): TodoOrder {
  const order = list(d.order, "order", 100);
  if (!order.length || order.some(t => typeof t !== "string" || !t.trim() || t.length > 500) || new Set(order.map(t => norm(t as string))).size !== order.length) throw new Error("order must be different task texts, each once");
  return { order: order as string[] };
}

// ---- embedded pages ----
export type AppendEmbed = { page: string; url: string; host: string; title: string; height: number };
const optHeight = (v: unknown) => { if (v === undefined) return 480; if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_HEIGHT || v > MAX_HEIGHT) throw new Error(`The height must be a whole number from ${MIN_HEIGHT} to ${MAX_HEIGHT}`); return v; };
const optTitle = (v: unknown, required: boolean) => { if (v === undefined && !required) return ""; if (typeof v !== "string" || (required && !v.trim()) || v.length > 200 || /[\u0000-\u001f]/.test(v)) throw new Error(required ? "A title of 1 to 200 characters is required" : "The title must be text of at most 200 characters"); return v.trim(); };
/** Check an "embed a page" request: the note, an https address on the allowed list, an optional title and height. Nothing is trusted. */
export function parseAppendEmbed(d: Record<string, unknown>, hosts: readonly string[] = allowedHosts()): AppendEmbed {
  if (!id(d.page)) throw new Error("The page id is invalid");
  if (typeof d.url !== "string") throw new Error("The address is missing");
  const u = parseEmbedUrl(d.url);
  if (!hostAllowed(u.host, hosts)) throw new Error(`${u.host} is not on your list of embeddable sites. Add it in Settings, Embedded pages, then ask again.`);
  return { page: d.page as string, url: u.href, host: u.host, title: optTitle(d.title, false), height: optHeight(d.height) };
}
export type AttachHtml = { page: string; title: string; html: string; height: number };
/** Check an "attach an HTML page" request: the note, a title, and the page's HTML (kept as a static copy, never run with network access). */
export function parseAttachHtml(d: Record<string, unknown>): AttachHtml {
  if (!id(d.page)) throw new Error("The page id is invalid");
  const title = optTitle(d.title, true);
  if (typeof d.html !== "string" || !d.html.trim()) throw new Error("The page's HTML is missing");
  if (new TextEncoder().encode(d.html).length > MAX_HTML) throw new Error(`The HTML is larger than ${MAX_HTML} bytes. Embed the page by its address instead.`);
  return { page: d.page as string, title, html: d.html, height: optHeight(d.height) };
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
    if (op === "append_embed") { const e = parseAppendEmbed(d); return `${e.title ? "“" + e.title + "” (" : "("}${e.host}) will be embedded at the end of the note, ${e.height} pixels tall. It shows live when you are online; if the site refuses to be shown inside NOU you get a card with “Open in new tab”.`; }
    if (op === "attach_html") { const a = parseAttachHtml(d); return `“${a.title}” will be saved with the note as a static copy (${new TextEncoder().encode(a.html).length} bytes) and shown at the end of the note. It works offline, runs in a frame with no network and no access to NOU, and will not update.`; }
    if (op === "habit_add") { const h = parseHabitAdd(d); return `A new habit “${h.name}” (${h.category}, ${h.days === 127 ? "every day" : WEEKDAYS.filter((_, i) => h.days & (1 << i)).join(", ")}) will be added. It also appears in the Life Timetable's activities, but is not placed on any day.`; }
    if (op === "habit_tick") { const t = parseHabitTick(d); return `“${t.habit}” will be marked ${t.done ? "done" : "not done (cleared)"} on ${t.day}.`; }
    if (op === "todo_reorder") { const t = parseTodoOrder(d); return `Today's tasks will start with, in this order: ${t.order.map(x => "“" + x.trim() + "”").join(", ")}. The rest keep their order after them.`; }
    if (op === "home_set_widgets") { const c = parseHomeWidgets(d); return [c.show.length ? "Show: " + c.show.map(titleOf).join(", ") : "", c.hide.length ? "Hide: " + c.hide.map(titleOf).join(", ") : ""].filter(Boolean).join(". ") + ". Nothing else on the Home page changes."; }
  } catch { return null; }
  return null;
}

/** What was made, for undo: a new page or row, or the blocks added to a note. Filled in while applying. */
export type ApplyAfter = { page?: string; blocks?: AddedBlock[] };
/**
 * Apply an approved proposal through the app's own commands (the same ones a person's edits use), so validation,
 * the restore barrier and backups all still apply. Returns a short result for the audit log; never throws.
 */
export async function applyProposal(p: Pick<Proposal, "op" | "payload">, after: ApplyAfter = {}): Promise<{ ok: boolean; result: string }> {
  const d = p.payload;
  try {
    switch (p.op) {
      case "create_page": {
        if (!text(d.title, 200)) throw new Error("The title is missing or too long");
        if (d.parent !== undefined && !id(d.parent)) throw new Error("The parent page id is invalid");
        const page = await invoke<{ id: string }>("create_page", { parentId: (d.parent as string | undefined) ?? null, title: (d.title as string).trim(), initialUpdate: await newRichUpdate() });
        after.page = page.id;
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
        after.page = row.id;
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
        const out = await appendBlocksToNote(d.page as string, lines.map(text => ({ type: "paragraph" as const, text })), after.blocks = []);
        if (out.changed) announceNoteChanged(d.page as string);
        return { ok: true, result: out.message };
      }
      case "add_checklist_item": {
        if (!id(d.page)) throw new Error("The page id is invalid");
        if (!text(d.text, 500) || /[\r\n]/.test(d.text as string)) throw new Error("A to-do must be one line of up to 500 characters");
        if (d.checked !== undefined && typeof d.checked !== "boolean") throw new Error("checked must be true or false");
        const out = await appendBlocksToNote(d.page as string, [{ type: "checkListItem", text: (d.text as string).trim(), checked: d.checked === true }], after.blocks = []);
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
      case "append_embed": {
        const e = parseAppendEmbed(d);
        const out = await appendBlocksToNote(e.page, [{ type: "raw", block: { type: "nouEmbed", props: { url: e.url, title: e.title, height: clampHeight(e.height), mode: "live", fileId: "" } } }]);
        if (out.changed) announceNoteChanged(e.page);
        return { ok: true, result: out.message };
      }
      case "attach_html": {
        const a = parseAttachHtml(d);
        const name = (a.title.replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "page") + ".html";
        const info = await invoke<{ id: string; name: string }>("upload_attachment_bytes", new TextEncoder().encode(a.html), { headers: { "x-file-name": encodeURIComponent(name) } });
        const out = await appendBlocksToNote(a.page, [{ type: "raw", block: { type: "nouEmbed", props: { url: "", title: a.title, height: clampHeight(a.height), mode: "snapshot", fileId: info.id } } }]);
        if (out.changed) announceNoteChanged(a.page);
        return { ok: true, result: out.message + " (saved copy of “" + a.title + "”)" };
      }
      case "habit_add": {
        const h = parseHabitAdd(d);
        const made = await habitsApi.add(h.name, h.days, h.category); announceHabits();
        return { ok: true, result: "Added the habit " + made.name };
      }
      case "habit_tick": {
        const t = parseHabitTick(d);
        if (t.day > todayLocal()) throw new Error("A day that has not happened yet cannot be logged");
        const habit = (await habitsApi.list()).find(h => norm(h.name) === norm(t.habit));
        if (!habit) throw new Error(`There is no habit called “${t.habit}”. Ask for it to be added first.`);
        await habitsApi.set(t.day, habit.id, t.done ? "done" : null); announceHabits();
        return { ok: true, result: `${habit.name} ${t.done ? "ticked" : "cleared"} on ${t.day}` };
      }
      case "todo_reorder": {
        const t = parseTodoOrder(d);
        const todos = (await invoke<{ id: string; text: string }[]>("linked_todo_list", { query: "" })) ?? [];
        const ids: string[] = [];
        for (const wanted of t.order) {
          const found = todos.find(x => norm(x.text) === norm(wanted) && !ids.includes(x.id));
          if (!found) throw new Error(`There is no task “${wanted.trim().slice(0, 60)}” in Today's tasks`);
          ids.push(found.id);
        }
        await invoke("linked_todo_reorder", { ids });
        try { window.dispatchEvent(new Event("nou:linked-todo")); } catch { /* only a refresh hint */ }
        return { ok: true, result: `Put ${ids.length} task${ids.length === 1 ? "" : "s"} first, in the order asked` };
      }
      default:
        return { ok: false, result: "This kind of request cannot be applied yet" };
    }
  } catch (e) {
    return { ok: false, result: String(e instanceof Error ? e.message : e).slice(0, 500) };
  }
}
