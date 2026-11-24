// Types and small pure helpers for the Bots Hub page. The rules live in Rust (chat.rs, hub.rs); this only shapes what the screen shows.
export type Room = { id: number; name: string; slug: string };
export type HubMessage = {
  id: number; at: string; kind: "owner" | "assistant" | string; author: string; body: string; room: string;
  type: "message" | "handoff" | "approval" | string; role: string | null; from: string | null; to: string | null; task_ref: string | null;
  approval: "open" | "approved" | "declined" | null; queue_item_id: number | null; decided_at: string | null;
};
export type QueueStatus = "queued" | "running" | "needs_nick" | "done";
export type QueueItem = { id: number; title: string; bot: string; status: QueueStatus | string; room: string; created_at: string; updated_at: string; approval_message_id: number | null };
export type Participant = { name: string; code: string; online: boolean; you: boolean };
export type InhouseState = "running" | "sleeping" | "offline";
export type Summary = { rooms: Room[]; participants: Participant[]; bots_online: number; inhouse_state: InhouseState | string; waiting: number; open: number };
export type InhouseMessage = { id: number; at: string; author: "owner" | "bot" | string; body: string; chat_id?: number };
/** One private chat with the local model, and the ids of the harnesses chosen for it. */
export type InhouseChatInfo = { id: number; title: string; created_at: string; updated_at: string; messages: number; harnesses: number[] };
/** A named block of extra instructions for the local model. `always` applies it to every chat. */
export type Harness = { id: number; name: string; instructions: string; always: boolean };
/** Starting points written for NOU. Adding one only fills in the form: nothing is saved until the owner saves it. */
export const HARNESS_PRESETS: { name: string; instructions: string }[] = [
  { name: "NOU helper", instructions: "You live inside NOU, an offline notes app for Windows. NOU has pages (rich notes with subpages and favourites), databases with table, board, calendar, timeline, list, gallery, map and chart views, a Life Timetable (a weekly routine in half-hour blocks, with alternating Week A and Week B, a timer for the current event and a Focus mode) and a Bots Hub where assistants chat and queue work. When the user asks how to do something in NOU, explain it using those features and the app's own words. If you are not sure a feature exists, say so instead of inventing one." },
  { name: "Timetable coach", instructions: "Help the user plan and review their Life Timetable. Time is split into half-hour blocks from Monday to Sunday, in two alternating weeks (A and B). When you suggest a change, name the week, the day, the start and end times and the activity so the user can make the change by hand. Remind the user that you cannot edit the timetable yourself." },
  { name: "Brief answers", instructions: "Keep every answer to a few short sentences in plain words. Give more detail only when the user asks for it." },
];

/** The word shown next to a status dot. */
export const STATUS_WORD: Record<string, string> = { running: "RUNNING", needs_nick: "NEEDS NICK", queued: "QUEUED", done: "DONE" };
export const statusWord = (s: string) => STATUS_WORD[s] ?? s.toUpperCase();

export const FILTERS = [["all", "All"], ["running", "Running"], ["needs_nick", "Needs Nick"], ["done", "Done"]] as const;
export type Filter = (typeof FILTERS)[number][0];
export const filterItems = (items: QueueItem[], f: Filter) => (f === "all" ? items : items.filter(i => i.status === f));
export const filterCounts = (items: QueueItem[]): Record<Filter, number> => ({ all: items.length, running: items.filter(i => i.status === "running").length, needs_nick: items.filter(i => i.status === "needs_nick").length, done: items.filter(i => i.status === "done").length });
/** Anything that is not Done. */
export const openCount = (items: QueueItem[]) => items.filter(i => i.status !== "done").length;

/** Two letters for an avatar or a queue row. */
export function codeOf(name: string): string { const l = [...name].filter(c => /\p{L}/u.test(c)).slice(0, 2).join("").toUpperCase(); return l || "??"; }
/** Add `@Name ` to the end of a draft, with one space before it when the draft is not empty. */
export const addMention = (draft: string, name: string) => (draft ? draft.replace(/\s*$/, " ") : "") + "@" + name + " ";
/** `CLAUDE → CHATGPT · HANDED OFF “C# DIMENSION COMPONENT”` */
export const handoffLine = (m: Pick<HubMessage, "from" | "to" | "task_ref" | "body">) => `${(m.from ?? "").toUpperCase()} → ${(m.to ?? "").toUpperCase()} · HANDED OFF “${(m.task_ref ?? m.body).toUpperCase()}”`;
export const approvalWord = (a: HubMessage["approval"]) => (a === "open" ? "NEEDS NICK" : a === "approved" ? "APPROVED" : a === "declined" ? "DECLINED" : "");
/** Replace or add messages by id, keeping order (a decided card replaces its open version). */
export function mergeById<T extends { id: number }>(old: T[], incoming: T[], keep = 500): T[] {
  const byId = new Map(old.map(m => [m.id, m])); for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-keep);
}
const pad = (n: number) => String(n).padStart(2, "0");
export const clockOf = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** TODAY, YESTERDAY or "17 NOV" for the divider above a day's messages. */
export function dayLabel(at: string, now = new Date()): string {
  const d = new Date(at); if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  return diff === 0 ? "TODAY" : diff === 1 ? "YESTERDAY" : `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" }).toUpperCase()}`;
}
export const inhouseWord = (s: string) => (s === "running" ? "RUNNING" : s === "sleeping" ? "SLEEPING" : "OFFLINE");
