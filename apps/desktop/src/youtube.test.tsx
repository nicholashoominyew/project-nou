import * as Y from "yjs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blocksToPlainText, migrateLegacy } from "./blockModel";
import { inspectDocument } from "./noteTransfer";
import { applyProposal, describeProposal } from "./gatewayApply";
import { cancelJob, findDatabase, getJob, loadSettings, parseBotRequest, requestJob, setupDatabase, videoId, writeVideo, DEFAULTS } from "./youtube";
import YouTubePanel from "./YouTubePanel";

// A small stand-in for NOU's page, note and database commands, with real Yjs notes.
const h = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[], s: {} as any, emit: (_e: any) => {} }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_n: string, f: (e: { payload: any }) => void) => { h.emit = p => f({ payload: p }); return () => { h.emit = () => {}; }; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => {
  h.calls.push({ command, args });
  const s = h.s, blank = () => [Array.from(Y.encodeStateAsUpdate(migrateLegacy(new Y.Doc())))];
  const id = () => "id" + ++s.next;
  if (command === "list_pages") return s.pages;
  if (command === "create_page") { const p = { id: id(), title: args.title, parent_id: args.parentId }; s.pages.push(p); s.notes[p.id] = blank(); return p; }
  if (command === "create_database") { const p = { id: id(), title: args.title, parent_id: args.parentId }; s.pages.push(p); s.notes[p.id] = blank(); s.dbs[p.id] = { title: args.title, properties: [{ id: id(), name: "Status", type: "status", options: [] }], rows: [] }; return p; }
  if (command === "get_database") return s.dbs[args.pageId] ? structuredClone(s.dbs[args.pageId]) : null;
  if (command === "delete_property") { for (const d of Object.values<any>(s.dbs)) d.properties = d.properties.filter((p: any) => p.id !== args.propertyId); return; }
  if (command === "add_property") { const p = { id: id(), name: args.name, type: args.kind, options: [] }; s.dbs[args.databaseId].properties.push(p); return p; }
  if (command === "add_select_option") { const o = { id: id(), name: args.name }; for (const d of Object.values<any>(s.dbs)) d.properties.find((p: any) => p.id === args.propertyId)?.options.push(o); return o; }
  if (command === "add_row") { const row = { id: id(), title: "Untitled", values: {} }; s.dbs[args.databaseId].rows.push(row); s.notes[row.id] = blank(); return row; }
  if (command === "load_note") return { updates: s.notes[args.pageId], format: "blocknote-v1", legacy_text: null, seq: 1, epoch: 1 };
  if (command === "save_note") { if (s.failSave) throw new Error("disk full"); s.notes[args.pageId] = [...s.notes[args.pageId], args.update]; return 1; }
  const row = (rowId: string) => Object.values<any>(s.dbs).flatMap((d: any) => d.rows).find((r: any) => r.id === rowId);
  if (command === "rename_page") { const r = row(args.pageId); if (r) r.title = args.title; return; }
  if (command === "set_value") { row(args.rowId).values[args.propertyId] = args.value; return; }
  if (command === "trash_page") { for (const d of Object.values<any>(s.dbs)) d.rows = d.rows.filter((r: any) => r.id !== args.pageId); return; }
  if (command === "yt_start") { s.job = args; return; }
  if (command === "yt_check") return s.check;
  return null;
} }));

const sent = (c: string) => h.calls.filter(x => x.command === c);
const blocksOf = (pageId: string) => { const doc = new Y.Doc(); for (const u of h.s.notes[pageId]) Y.applyUpdate(doc, Uint8Array.from(u)); return (inspectDocument(doc, "blocknote-v1").blocks as any[]); };
const textsOf = (pageId: string) => blocksOf(pageId).map(b => blocksToPlainText([b]).trim()).filter(Boolean);
const video = (id: string, extra: object = {}) => ({ id, title: "Title " + id, url: "https://www.youtube.com/watch?v=" + id, method: "Captions" as const, minutes: 3.54, paragraphs: ["First part.", "Second part."], ...extra });
const A = "aaaaaaaaaaa", B = "bbbbbbbbbbb";
const db = () => Object.entries<any>(h.s.dbs)[0];
const values = (row: any) => Object.fromEntries(db()[1].properties.map((p: any) => [p.name, p.type === "select" ? p.options.find((o: any) => o.id === row.values[p.id])?.name : row.values[p.id]]));
const settle = () => new Promise(r => setTimeout(r, 120));

beforeEach(() => {
  h.calls.length = 0; localStorage.clear();
  Object.assign(h.s, { next: 0, pages: [], notes: {}, dbs: {}, failSave: false, job: null, check: { ok: true, python: "py", version: "3.12", packages: {}, missing: [], install: [] } });
  h.s.pages.push({ id: "know", title: "Knowledge", parent_id: null }, { id: "yt", title: "YouTube Transcripts", parent_id: "know" });
  h.s.notes.yt = [Array.from(Y.encodeStateAsUpdate(migrateLegacy(new Y.Doc())))];
});

describe("the transcripts database", () => {
  it("is set up inside the existing page, without a second page, and found again", async () => {
    expect(await findDatabase()).toEqual({ pageId: "yt", databaseId: null });
    const made = await setupDatabase();
    expect(made.pageId).toBe("yt");
    expect(sent("create_page"), "no duplicate page").toHaveLength(0);
    expect(db()[1].properties.map((p: any) => `${p.name}:${p.type}`)).toEqual(["URL:url", "Method:select", "Minutes:number", "Added:date"]);
    expect(blocksOf("yt").some(b => b.type === "nouDatabase" && b.props.databaseId === made.databaseId)).toBe(true);
    expect(await findDatabase()).toEqual(made);
    await setupDatabase();
    expect(sent("create_database"), "nothing is made twice").toHaveLength(1);
  });
  it("writes a row with the source address first, and overwrites it on re-extract", async () => {
    const { databaseId } = await setupDatabase();
    const first = await writeVideo(databaseId, video(A));
    const row = db()[1].rows[0];
    expect(row.title).toBe("Title " + A);
    expect(values(row)).toMatchObject({ URL: "https://www.youtube.com/watch?v=" + A, Method: "Captions", Minutes: 3.5 });
    expect(values(row).Added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(textsOf(first.rowId)).toEqual(["https://www.youtube.com/watch?v=" + A, "First part.", "Second part."]);
    await writeVideo(databaseId, video(A, { method: "Whisper", paragraphs: ["Better."] }), first.rowId);
    expect(db()[1].rows).toHaveLength(1);
    expect(textsOf(first.rowId)).toEqual(["https://www.youtube.com/watch?v=" + A, "Better."]);
    expect(values(db()[1].rows[0]).Method).toBe("Whisper");
  });
  it("leaves no half-written row behind", async () => {
    const { databaseId } = await setupDatabase();
    h.s.failSave = true;
    await expect(writeVideo(databaseId, video(A))).rejects.toThrow("disk full");
    expect(db()[1].rows).toHaveLength(0);
  });
});

describe("a job", () => {
  const run = async (reextract: boolean, proposalId?: string) => { await requestJob({ targets: ["x"], settings: DEFAULTS, reextract, proposalId }); };
  it("writes each video as it arrives, skips saved ones, and keeps them if cancelled", async () => {
    const { databaseId } = await setupDatabase();
    await writeVideo(databaseId, video(A));
    await run(false);
    expect(h.s.job.job.skip).toEqual([A]);
    h.emit({ type: "progress", done: 0, total: 3 });
    h.emit({ type: "video", ...video(B) });
    await settle();
    expect(db()[1].rows).toHaveLength(2);
    expect(getJob().running).toBe(true);
    await cancelJob();
    expect(sent("yt_cancel")).toHaveLength(1);
    h.emit({ type: "done", total: 3, ok: 1, failed: 0, skipped: 1, cancelled: true });
    h.emit({ type: "exit", ok: true, error: "" });
    await settle();
    expect(getJob()).toMatchObject({ running: false });
    expect(getJob().summary).toMatch(/^Cancelled\. 1 saved, 1 already there, 0 failed of 3/);
    expect(db()[1].rows).toHaveLength(2);
  });
  it("re-extracting skips nothing and replaces the row; a bot's request records the outcome", async () => {
    const { databaseId } = await setupDatabase();
    await writeVideo(databaseId, video(A));
    await run(true, "prop-1");
    expect(h.s.job.job.skip).toEqual([]);
    h.emit({ type: "video", ...video(A, { title: "Again" }) });
    h.emit({ type: "done", total: 1, ok: 1, failed: 0, skipped: 0, cancelled: false });
    h.emit({ type: "exit", ok: true, error: "" });
    await settle();
    expect(db()[1].rows.map((r: any) => r.title)).toEqual(["Again"]);
    expect(sent("gateway_set_result")[0].args.id).toBe("prop-1");
    expect(sent("gateway_set_result")[0].args.result).toMatch(/^Finished\. 1 saved.*Database .*Again \(row /);
  });
  it("says why when the worker dies", async () => {
    await setupDatabase();
    await run(false);
    h.emit({ type: "exit", ok: false, error: "ModuleNotFoundError: x" });
    await settle();
    expect(getJob().summary).toMatch(/ended unexpectedly\. ModuleNotFoundError/);
  });
});

describe("requests from bots", () => {
  it("accept only YouTube addresses and harmless options", () => {
    expect(parseBotRequest({ urls: ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/playlist?list=PL1", "dQw4w9WgXcQ"], languages: "en,ja" }).urls).toHaveLength(3);
    for (const urls of [[], ["https://evil.example.com/watch?v=dQw4w9WgXcQ"], ["file:///c:/x"], ["https://youtube.com.evil.com/x"], ["--exec rm"], Array(51).fill("dQw4w9WgXcQ")]) expect(() => parseBotRequest({ urls })).toThrow();
    expect(() => parseBotRequest({ urls: ["dQw4w9WgXcQ"], model: "huge" })).toThrow();
    expect(() => parseBotRequest({ urls: ["dQw4w9WgXcQ"], languages: "en; rm" })).toThrow();
    const r = parseBotRequest({ urls: ["dQw4w9WgXcQ"], cookieFile: "c:/secret", outDir: "c:/", python: "evil.exe" }) as any;
    expect(r.cookieFile ?? r.outDir ?? r.python).toBeUndefined();
    expect(describeProposal("transcripts_extract", { urls: ["dQw4w9WgXcQ"] })).toMatch(/1 YouTube address .* saved to your Transcripts database/);
  });
  it("is queued once approved, with your own settings", async () => {
    await setupDatabase();
    localStorage.setItem("nou-youtube", JSON.stringify({ cookieBrowser: "firefox", model: "medium" }));
    const out = await applyProposal({ id: "p9", op: "transcripts_extract", payload: { urls: ["dQw4w9WgXcQ"], model: "tiny" } });
    expect(out).toMatchObject({ ok: true });
    await waitFor(() => expect(h.s.job).not.toBeNull(), { timeout: 2000 });
    expect(h.s.job.job.options).toMatchObject({ cookieBrowser: "firefox", model: "tiny" });
    h.emit({ type: "exit", ok: true, error: "" }); await settle();
  });
});

describe("the tool screen", () => {
  it("offers to set up a missing database, and says what to install", async () => {
    h.s.check = { ok: false, python: "py", version: "3.12", packages: { "yt-dlp": null }, missing: ["yt-dlp"], install: ["py -3.12 -m venv x", "pip install -r y"] };
    render(<YouTubePanel onClose={() => {}} onOpenPage={() => {}} refresh={() => {}} />);
    await screen.findByText("Set up the database");
    expect((await screen.findByText(/Missing: yt-dlp/)).textContent).toMatch(/download on first use/);
    fireEvent.change(screen.getByLabelText("Addresses"), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    expect((screen.getByText("Extract") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Set up the database"));
    await waitFor(() => expect(screen.queryByText("Set up the database")).toBeNull());
  });
  it("remembers the options on this device", async () => {
    await setupDatabase();
    render(<YouTubePanel onClose={() => {}} onOpenPage={() => {}} refresh={() => {}} />);
    fireEvent.change(screen.getByLabelText("Languages"), { target: { value: "ja,en" } });
    fireEvent.change(screen.getByLabelText("Cookies file"), { target: { value: "C:\\c.txt" } });
    expect(loadSettings()).toMatchObject({ langs: "ja,en", cookieFile: "C:\\c.txt", saveFiles: false, whisperFallback: true });
    expect(videoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(videoId("not a url")).toBeNull();
  });
});
