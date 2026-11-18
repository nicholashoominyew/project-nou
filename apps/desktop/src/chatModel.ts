export type ChatMessage = { id: number; at: string; kind: "owner" | "assistant" | string; author: string; body: string };
export const SEEN_KEY = "nou-chat-seen";
export const MAX_BODY = 4000;

/** One of six fixed tones for an assistant, always the same for the same name, so each assistant is easy to tell apart. */
export function authorTone(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}
/** Messages from assistants newer than the last one you saw. Your own messages never count. */
export const unreadCount = (messages: ChatMessage[], seen: number) => messages.filter(m => m.kind === "assistant" && m.id > seen).length;
export const lastId = (messages: ChatMessage[]) => messages.reduce((n, m) => Math.max(n, m.id), 0);

/** Adds new messages to the list by id, in order, without duplicates (a message you sent also arrives from the next poll). */
export function mergeMessages(old: ChatMessage[], incoming: ChatMessage[], keep = 500): ChatMessage[] {
  const byId = new Map(old.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-keep);
}
export function readSeen(): number {
  try { const n = Number(localStorage.getItem(SEEN_KEY)); return Number.isFinite(n) && n >= 0 ? n : 0; } catch { return 0; }
}
export function writeSeen(id: number) { try { localStorage.setItem(SEEN_KEY, String(id)); } catch { /* a convenience only */ } }

/** "14:05" for today, "17 Nov 14:05" for another day. The stored time is UTC. */
export function clock(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} ${time}`;
}
/** True when this message continues the one above it from the same author a short while later (so the name is not repeated). */
export const continues = (prev: ChatMessage | undefined, m: ChatMessage) => !!prev && prev.author === m.author && prev.kind === m.kind && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60 * 1000;
