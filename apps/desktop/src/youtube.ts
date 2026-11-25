// YouTube transcripts (docs/development/YOUTUBE-TRANSCRIPTS.md). The worker fetches and transcribes; this stores each finished video
// as a row through NOU's ordinary commands, so validation, search, backups and the restore barrier all apply. It lives outside the
// panel, so a job carries on while you do something else.
import { invoke } from "@tauri-apps/api/core";
import { newRichUpdate } from "./richUpdate";
import { appendBlocksToNote, databaseBlocks, replaceNoteBlocks, type NewBlock } from "./noteAppend";

export const PAGE_TITLE = "YouTube Transcripts";
export const MODELS = ["tiny", "base", "small", "medium", "large-v3"] as const;
export type Settings = {
  langs: string; timestamps: boolean; whisperFallback: boolean; forceWhisper: boolean; model: string; device: string;
  cookieBrowser: string; cookieFile: string; saveFiles: boolean; outDir: string; format: string; python: string;
};
export const DEFAULTS: Settings = { langs: "en", timestamps: false, whisperFallback: true, forceWhisper: false, model: "small", device: "auto", cookieBrowser: "none", cookieFile: "", saveFiles: false, outDir: "", format: "txt", python: "" };
const KEY = "nou-youtube";
/** Kept on this device only (paths differ between PCs). Only the path of a cookies file is stored, never what is in it. */
export function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Settings>) }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s: Settings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* the choices last until NOU closes */ } }

const ID = /^[A-Za-z0-9_-]{11}$/;
/** The same patterns as the worker's extract_video_id. */
export function videoId(text: string): string | null {
  const s = text.trim();
  if (ID.test(s)) return s;
  return /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(s)?.[1] ?? null;
}

// ---- the database inside the "YouTube Transcripts" page ----
type Page = { id: string; title: string; parent_id: string | null };
type Property = { id: string; name: string; type: string; options: { id: string; name: string }[] };
type Database = { page_id?: string; title: string; properties: Property[]; rows: { id: string; title: string; values: Record<string, unknown> }[] };
const COLUMNS = [["URL", "url"], ["Method", "select"], ["Minutes", "number"], ["Added", "date"]] as const;

export type Target = { pageId: string; databaseId: string };
const getDatabase = (id: string) => invoke<Database | null>("get_database", { pageId: id });
/** The transcripts database: the "YouTube Transcripts" page itself if it is one, otherwise the database inside it with a URL column (or the only one). */
export async function findDatabase(): Promise<{ pageId: string | null; databaseId: string | null }> {
  const pages = await invoke<Page[]>("list_pages");
  const page = pages.find(p => p.title === PAGE_TITLE);
  if (!page) return { pageId: null, databaseId: null };
  if (await getDatabase(page.id)) return { pageId: page.id, databaseId: page.id };
  const found: { id: string; db: Database }[] = [];
  for (const id of await databaseBlocks(page.id)) { const db = await getDatabase(id).catch(() => null); if (db) found.push({ id, db }); }
  const chosen = found.find(f => f.db.properties.some(p => p.name === "URL" && p.type === "url")) ?? (found.length === 1 ? found[0] : undefined);
  return { pageId: page.id, databaseId: chosen?.id ?? null };
}

/** Make whatever is missing: the page, the database inside it, and its columns. Existing content is never changed or removed. */
export async function setupDatabase(): Promise<Target> {
  let { pageId, databaseId } = await findDatabase();
  if (!pageId) {
    const knowledge = (await invoke<Page[]>("list_pages")).find(p => p.title === "Knowledge");
    pageId = (await invoke<Page>("create_page", { parentId: knowledge?.id ?? null, title: PAGE_TITLE, initialUpdate: await newRichUpdate() })).id;
  }
  if (!databaseId) {
    const db = await invoke<Page>("create_database", { parentId: pageId, title: "Transcripts", initialUpdate: await newRichUpdate(), initialView: "table" });
    databaseId = db.id;
    await appendBlocksToNote(pageId, [{ type: "raw", block: { type: "nouDatabase", props: { databaseId } } }]);
    const status = (await getDatabase(databaseId))?.properties.find(p => p.type === "status");
    if (status) await invoke("delete_property", { propertyId: status.id }); // made a moment ago, holds nothing
  }
  const have = (await getDatabase(databaseId))!.properties;
  for (const [name, kind] of COLUMNS) {
    const same = have.find(p => p.name === name);
    if (same && same.type !== kind) throw new Error(`The database has a “${name}” column of another type (${same.type}). Rename it, then try again.`);
    if (!same) await invoke("add_property", { databaseId, name, kind });
  }
  try { window.dispatchEvent(new CustomEvent("nou:note-changed", { detail: pageId })); } catch { /* only a refresh hint */ }
  return { pageId, databaseId };
}

/** Video id -> row id for everything already saved. */
export async function savedVideos(databaseId: string): Promise<Map<string, string>> {
  const db = await getDatabase(databaseId);
  const url = db?.properties.find(p => p.name === "URL");
  const out = new Map<string, string>();
  for (const row of db?.rows ?? []) { const id = url ? videoId(String(row.values[url.id] ?? "")) : null; if (id) out.set(id, row.id); }
  return out;
}

export type Video = { id: string; title: string; url: string; method: "Captions" | "Whisper"; minutes: number; paragraphs: string[] };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** The source address first, then the transcript. */
export const bodyBlocks = (v: Video): NewBlock[] => [
  { type: "raw", block: { type: "paragraph", content: [{ type: "link", href: v.url, content: [{ type: "text", text: v.url, styles: {} }] }] } },
  ...v.paragraphs.map(text => ({ type: "paragraph" as const, text })),
];

/** Write one video: a new row, or over the row it already has. The URL column is set last, so a half-written row is not counted as saved. */
export async function writeVideo(databaseId: string, v: Video, existingRow?: string): Promise<{ rowId: string; overwritten: boolean }> {
  const db = await getDatabase(databaseId);
  if (!db) throw new Error("The transcripts database is gone");
  const column = (name: string) => { const p = db.properties.find(x => x.name === name); if (!p) throw new Error(`The database has no “${name}” column`); return p; };
  const [url, method, minutes, added] = ["URL", "Method", "Minutes", "Added"].map(column);
  const rowId = existingRow ?? (await invoke<{ id: string }>("add_row", { databaseId, initialUpdate: await newRichUpdate() })).id;
  try {
    if (existingRow) await replaceNoteBlocks(rowId, bodyBlocks(v)); else await appendBlocksToNote(rowId, bodyBlocks(v));
    await invoke("rename_page", { pageId: rowId, title: v.title.trim().slice(0, 300) || v.id });
    const option = method.options.find(o => o.name === v.method) ?? await invoke<{ id: string }>("add_select_option", { propertyId: method.id, name: v.method, color: v.method === "Captions" ? "blue" : "green" });
    await invoke("set_value", { rowId, propertyId: method.id, value: option.id });
    await invoke("set_value", { rowId, propertyId: minutes.id, value: Math.round(v.minutes * 10) / 10 });
    await invoke("set_value", { rowId, propertyId: added.id, value: today() });
    await invoke("set_value", { rowId, propertyId: url.id, value: v.url });
  } catch (e) {
    if (!existingRow) await invoke("trash_page", { pageId: rowId }).catch(() => { /* an empty row is left, without a URL */ });
    throw e;
  }
  try { window.dispatchEvent(new CustomEvent("nou:note-changed", { detail: rowId })); } catch { /* only a refresh hint */ }
  return { rowId, overwritten: !!existingRow };
}

// ---- the running job ----
export type Job = { running: boolean; cancelling: boolean; log: string[]; done: number; total: number; summary: string };
const idle: Job = { running: false, cancelling: false, log: [], done: 0, total: 0, summary: "" };
let job: Job = idle;
const listeners = new Set<() => void>();
export const getJob = () => job;
export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const update = (patch: Partial<Job>) => { job = { ...job, ...patch }; listeners.forEach(f => f()); };
const say = (line: string) => update({ log: [...job.log, line].slice(-500) });
const msg = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

export type Request = { targets: string[]; settings: Settings; reextract: boolean; proposalId?: string };
const queue: Request[] = [];

/** Start now, or after the job that is running (a request approved while one runs). */
export async function requestJob(request: Request): Promise<"started" | "queued"> {
  if (job.running) { queue.push(request); say(`Queued ${request.targets.length} more address(es).`); return "queued"; }
  await start(request);
  return "started";
}

export async function cancelJob() {
  if (!job.running) return;
  for (const q of queue.splice(0)) if (q.proposalId) await report(q.proposalId, "Cancelled before it started.");
  update({ cancelling: true });
  await invoke("yt_cancel");
}

const report = (id: string, result: string) => invoke("gateway_set_result", { id, result }).catch(e => say("! Could not record the outcome: " + msg(e)));

async function start(request: Request) {
  update({ running: true, cancelling: false, log: [], done: 0, total: 0, summary: "" });
  let off: (() => void) | undefined;
  const written: string[] = [];
  let writeFailures = 0, finished: Record<string, any> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const finish = async (summary: string) => {
    off?.(); off = undefined;
    update({ running: false, cancelling: false, summary });
    say(summary);
    if (request.proposalId) await report(request.proposalId, summary);
    const next = queue.shift();
    if (next) await start(next).catch(e => { say("! " + msg(e)); if (next.proposalId) void report(next.proposalId, "Failed: " + msg(e)); });
  };
  try {
    const { databaseId } = await findDatabase();
    if (!databaseId) throw new Error("There is no transcripts database yet. Open the YouTube Transcripts tool and set it up.");
    const saved = await savedVideos(databaseId);
    const { listen } = await import("@tauri-apps/api/event");
    off = await listen<Record<string, any>>("yt-event", ({ payload: e }) => {
      if (e.type === "log") say(String(e.text));
      else if (e.type === "progress") update({ done: e.done, total: e.total });
      else if (e.type === "done") finished = e;
      else if (e.type === "video") {
        // One after another, as they arrive: what is already written stays if a later one fails or the job is cancelled.
        chain = chain.then(async () => {
          const v = e as unknown as Video;
          try {
            const existing = (await savedVideos(databaseId)).get(v.id);
            if (existing && !request.reextract) { say(`  ${v.id}: already saved.`); return; }
            const { rowId, overwritten } = await writeVideo(databaseId, v, existing);
            written.push(`${v.title} (row ${rowId})`);
            say(`  ${overwritten ? "Replaced" : "Added to NOU"}: ${v.title}`);
          } catch (x) { writeFailures++; say(`  ✗ Could not save ${v.id} to NOU: ${msg(x)}`); }
        });
      } else if (e.type === "exit") {
        void chain.then(() => {
          const f = finished;
          const head = !f ? "Stopped: the worker ended unexpectedly." + (e.error ? " " + e.error : "") : f.cancelled || job.cancelling ? "Cancelled." : "Finished.";
          return finish(`${head} ${written.length} saved, ${f?.skipped ?? 0} already there, ${(f?.failed ?? 0) + writeFailures} failed${f ? " of " + f.total : ""}. Database ${databaseId}.${written.length ? " " + written.join("; ") : ""}`.slice(0, 3900));
        });
      }
    });
    const s = request.settings;
    await invoke("yt_start", { python: s.python, job: { targets: request.targets, skip: request.reextract ? [] : [...saved.keys()], options: {
      langs: s.langs, timestamps: s.timestamps, whisperFallback: s.whisperFallback, forceWhisper: s.forceWhisper, model: s.model, device: s.device,
      cookieBrowser: s.cookieBrowser, cookieFile: s.cookieFile, saveFiles: s.saveFiles, outDir: s.outDir, format: s.format } } });
  } catch (e) {
    off?.();
    update({ running: false, summary: "Failed: " + msg(e) });
    say("Failed: " + msg(e));
    throw e;
  }
}

// ---- requests from bots (approved by the owner) ----
export type BotRequest = { urls: string[]; langs?: string; timestamps?: boolean; alwaysWhisper?: boolean; model?: string; reextract: boolean };
/** Check a bot's request. It may choose what to fetch and how to write it, never cookies, folders or which program runs. */
export function parseBotRequest(d: Record<string, unknown>): BotRequest {
  const urls = d.urls;
  if (!Array.isArray(urls) || !urls.length || urls.length > 50) throw new Error("urls must be a list of 1 to 50 YouTube addresses");
  const clean = urls.map(u => {
    const s = typeof u === "string" ? u.trim() : "";
    if (ID.test(s)) return s;
    let host = ""; try { const x = new URL(s); if (x.protocol === "https:" || x.protocol === "http:") host = x.hostname.toLowerCase(); } catch { /* refused below */ }
    if (!(host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) || /\s/.test(s) || s.length > 500) throw new Error("Not a YouTube address: " + String(u).slice(0, 80));
    return s;
  });
  if (d.languages !== undefined && (typeof d.languages !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?(\s*,\s*[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?){0,9}$/.test(d.languages))) throw new Error("languages must look like en or en,ja");
  for (const k of ["timestamps", "always_whisper", "reextract"] as const) if (d[k] !== undefined && typeof d[k] !== "boolean") throw new Error(k + " must be true or false");
  if (d.model !== undefined && !(MODELS as readonly unknown[]).includes(d.model)) throw new Error("model must be one of " + MODELS.join(", "));
  return { urls: clean, langs: d.languages as string | undefined, timestamps: d.timestamps as boolean | undefined, alwaysWhisper: d.always_whisper as boolean | undefined, model: d.model as string | undefined, reextract: d.reextract === true };
}
/** Run an approved bot request with the owner's own settings, changed only where the request says. */
export async function runBotRequest(d: Record<string, unknown>, proposalId?: string): Promise<string> {
  const r = parseBotRequest(d);
  if (!(await findDatabase()).databaseId) throw new Error("There is no transcripts database yet. Open the YouTube Transcripts tool and set it up.");
  const own = loadSettings();
  const settings = { ...own, langs: r.langs ?? own.langs, timestamps: r.timestamps ?? own.timestamps, forceWhisper: r.alwaysWhisper ?? own.forceWhisper, model: r.model ?? own.model };
  // The outcome is recorded after this request has been marked applied, so the job starts just after.
  setTimeout(() => void requestJob({ targets: r.urls, settings, reextract: r.reextract, proposalId }).catch(e => { if (proposalId) void report(proposalId, "Failed: " + msg(e)); }), 500);
  return `Queued ${r.urls.length} address${r.urls.length === 1 ? "" : "es"}. This result changes when the job ends.`;
}
