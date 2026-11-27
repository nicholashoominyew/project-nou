// Teachings come from a database called Teachings in NOU. Used by the Home card and the Daily page.
import { invoke } from "@tauri-apps/api/core";
import { pickForDay } from "./homeLogic";

type Db = { title: string; properties: { id: string; name: string; type: string; options?: { id: string; name: string }[] }[]; rows: { id: string; title: string; values: Record<string, unknown> }[] };
export type Teaching = { text: string; theme: string; source: string; author: string; apply: string };
const prop = (db: Db, names: string[], types: string[]) => db.properties.find(p => names.includes(p.name.trim().toLowerCase()) && types.includes(p.type));
function valueOf(p: Db["properties"][number] | undefined, v: unknown): string {
  if (!p || v == null) return "";
  if (typeof v === "string") return (p.options?.find(o => o.id === v)?.name ?? v).slice(0, 300);
  if (Array.isArray(v)) return v.map(x => (typeof x === "string" ? p.options?.find(o => o.id === x)?.name ?? x : "")).filter(Boolean).join(", ").slice(0, 300);
  return "";
}

/** The day's picks. With `oneEachBook`, no two come from the same book (a teaching without a book counts as its own). */
export async function readTeachings(day: string, count = 5, oneEachBook = false): Promise<Teaching[]> {
  try {
    const list = await invoke<{ id: string; title: string }[]>("list_databases");
    const brief = (Array.isArray(list) ? list : []).find(d => d.title.trim().toLowerCase() === "teachings");
    const db = brief ? await invoke<Db | null>("get_database", { pageId: brief.id }) : null;
    if (!db) return [];
    const body = prop(db, ["teaching", "text", "quote", "note"], ["text"]), theme = prop(db, ["theme"], ["select", "multi_select", "text"]), src = prop(db, ["book", "source"], ["select", "text", "url"]), who = prop(db, ["author"], ["select", "text"]), how = prop(db, ["how to apply", "try today", "apply"], ["text"]);
    const all = db.rows.map(r => ({ text: (valueOf(body, r.values?.[body?.id ?? ""]) || r.title || "").trim(), theme: valueOf(theme, r.values?.[theme?.id ?? ""]), source: valueOf(src, r.values?.[src?.id ?? ""]), author: valueOf(who, r.values?.[who?.id ?? ""]), apply: valueOf(how, r.values?.[how?.id ?? ""]) })).filter(t => t.text);
    if (!oneEachBook) return pickForDay(all, day, count);
    const books = new Set<string>();
    return pickForDay(all, day, all.length).filter(t => !t.source || (!books.has(t.source) && !!books.add(t.source))).slice(0, count);
  } catch { return []; }
}
