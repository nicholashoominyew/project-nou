import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyProposal, canApply } from "./gatewayApply";

const { calls } = vi.hoisted(() => ({ calls: [] as { command: string; args: any }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any) => { calls.push({ command, args }); if (command === "create_page") return { id: "new-page" }; if (command === "add_row") return { id: "new-row" }; } }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));
beforeEach(() => { calls.length = 0; });

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
    expect((await applyProposal({ op: "append_text", payload: { page: "p", text: "hi" } })).ok).toBe(false);
    expect(canApply("append_text")).toBe(false);
    expect(canApply("create_page")).toBe(true);
  });
});
