import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyProposal, canApply } from "./gatewayApply";

const { calls } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => { calls.push({ command, args }); if (command === "create_page") return { id: "new-page" }; if (command === "add_row") return { id: "new-row" }; } }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));
const { appended, appendResult } = vi.hoisted(() => ({ appended: [] as { page: string; blocks: any[] }[], appendResult: { value: { changed: true, message: "Added 2 blocks" } as { changed: boolean; message: string } } }));
vi.mock("./noteAppend", () => ({ appendBlocksToNote: async (page: string, blocks: any[]) => { appended.push({ page, blocks }); return appendResult.value; } }));
beforeEach(() => { calls.length = 0; appended.length = 0; appendResult.value = { changed: true, message: "Added 2 blocks" }; });

describe("applyProposal", () => {
  it("creates a page through the normal create_page command, under an optional parent", async () => {
    expect(await applyProposal({ op: "create_page", payload: { title: "  Ideas  ", parent: "p1" } })).toEqual({ ok: true, result: "Created page new-page" });
    expect(calls).toEqual([{ command: "create_page", args: { parentId: "p1", title: "Ideas", initialUpdate: [1] } }]);
  });
  it("renames a page and sets a cell", async () => {
    expect((await applyProposal({ op: "rename_page", payload: { page: "p1", title: "New" } })).ok).toBe(true);
    expect((await applyProposal({ op: "set_value", payload: { row: "r1", property: "x", value: { lat: 1, lng: 2 } } })).ok).toBe(true);
    expect(calls.map(c => c.command)).toEqual(["rename_page", "set_value"]);
    expect(calls[1].args).toEqual({ rowId: "r1", propertyId: "x", value: { lat: 1, lng: 2 } });
  });
  it("adds a row with a title and values", async () => {
    const out = await applyProposal({ op: "create_row", payload: { database: "d1", title: "Task", values: { a: 1, b: "x" } } });
    expect(out).toEqual({ ok: true, result: "Added row new-row" });
    expect(calls.map(c => c.command)).toEqual(["add_row", "rename_page", "set_value", "set_value"]);
  });
  it("refuses malformed or hostile payloads without calling the backend", async () => {
    const bad: [string, Record<string, unknown>][] = [
      ["create_page", {}], ["create_page", { title: "" }], ["create_page", { title: "x".repeat(201) }], ["create_page", { title: "ok", parent: "../../etc" }],
      ["rename_page", { page: "p1" }], ["rename_page", { page: "p 1; DROP", title: "x" }],
      ["set_value", { row: "r" }], ["set_value", { row: "r", property: "p" }],
      ["create_row", { database: "" }], ["create_row", { database: "d", values: [1, 2] }], ["create_row", { database: "d", title: "" }],
    ];
    for (const [op, payload] of bad) { const out = await applyProposal({ op, payload }); expect(out.ok, op + JSON.stringify(payload)).toBe(false); }
    expect(calls).toEqual([]);
  });
  it("reports unsupported operations as failed instead of pretending", async () => {
    expect((await applyProposal({ op: "link_pages", payload: { a: "p", b: "q" } })).ok).toBe(false);
    expect(canApply("link_pages")).toBe(false);
    expect(canApply("create_page")).toBe(true);
    expect(canApply("append_text")).toBe(true);
    expect(canApply("add_checklist_item")).toBe(true);
  });
  describe("note body edits", () => {
    it("append_text adds each non-empty line as a plain paragraph", async () => {
      const heard: string[] = [];
      const on = (e: Event) => heard.push((e as CustomEvent).detail);
      window.addEventListener("nou:note-changed", on);
      const out = await applyProposal({ op: "append_text", payload: { page: "p1", text: "First\r\n\n  Second  \n\u0007Third" } });
      window.removeEventListener("nou:note-changed", on);
      expect(out).toEqual({ ok: true, result: "Added 2 blocks" });
      expect(appended).toEqual([{ page: "p1", blocks: [{ type: "paragraph", text: "First" }, { type: "paragraph", text: "Second" }, { type: "paragraph", text: "Third" }] }]);
      expect(heard).toEqual(["p1"]);
    });
    it("add_checklist_item adds one to-do, optionally ticked", async () => {
      expect((await applyProposal({ op: "add_checklist_item", payload: { page: "p1", text: " Call Sam ", checked: true } })).ok).toBe(true);
      expect(appended[0]).toEqual({ page: "p1", blocks: [{ type: "checkListItem", text: "Call Sam", checked: true }] });
    });
    it("a to-do that is already on the page changes nothing and does not announce a change", async () => {
      appendResult.value = { changed: false, message: "That to-do is already on the page, so nothing was added" };
      const heard: string[] = [];
      const on = (e: Event) => heard.push((e as CustomEvent).detail);
      window.addEventListener("nou:note-changed", on);
      const out = await applyProposal({ op: "add_checklist_item", payload: { page: "p1", text: "Call Sam" } });
      window.removeEventListener("nou:note-changed", on);
      expect(out.ok).toBe(true);
      expect(heard).toEqual([]);
    });
    it("refuses malformed or oversized body edits before touching the note", async () => {
      const bad: [string, Record<string, unknown>][] = [
        ["append_text", { text: "x" }], ["append_text", { page: "p1" }], ["append_text", { page: "p1", text: "   " }], ["append_text", { page: "p1", text: "x".repeat(20001) }],
        ["append_text", { page: "p1", text: Array.from({ length: 201 }, (_, i) => "line " + i).join("\n") }], ["append_text", { page: "p1", text: "y".repeat(2001) }],
        ["append_text", { page: "../etc", text: "x" }], ["append_text", { page: "p1", text: 5 }],
        ["add_checklist_item", { page: "p1" }], ["add_checklist_item", { page: "p1", text: "" }], ["add_checklist_item", { page: "p1", text: "two\nlines" }],
        ["add_checklist_item", { page: "p1", text: "x".repeat(501) }], ["add_checklist_item", { page: "p1", text: "ok", checked: "yes" }], ["add_checklist_item", { page: "bad id!", text: "ok" }],
      ];
      for (const [op, payload] of bad) expect((await applyProposal({ op, payload })).ok, op + JSON.stringify(payload).slice(0, 60)).toBe(false);
      expect(appended).toEqual([]);
    });
  });
});
