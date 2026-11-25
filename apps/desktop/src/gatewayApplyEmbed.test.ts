import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyProposal, canApply, describeProposal, parseAppendEmbed, parseAttachHtml } from "./gatewayApply";
import { writeExtraHosts } from "./embed";

const { calls, appended } = vi.hoisted(() => ({ calls: [] as { command: string; args: any; extra?: any }[], appended: [] as { page: string; blocks: any[] }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: any, extra: any) => { calls.push({ command, args, extra }); if (command === "upload_attachment_bytes") return { id: "f".repeat(64), name: "x.html", mime: "text/html", bytes: 9 }; return null; } }));
vi.mock("./noteAppend", () => ({ appendBlocksToNote: async (page: string, blocks: any[]) => { appended.push({ page, blocks }); return { changed: true, message: "Added 1 block" }; } }));
vi.mock("./richUpdate", () => ({ newRichUpdate: async () => [1] }));
beforeEach(() => { calls.length = 0; appended.length = 0; localStorage.clear(); });
const ok = { page: "p1", url: "https://claude.ai/artifact/abc", title: "Chart", height: 600 };

describe("a request to embed a page", () => {
  it("accepts an https address on the list, with an optional title and height", () => {
    expect(parseAppendEmbed(ok)).toEqual({ page: "p1", url: "https://claude.ai/artifact/abc", host: "claude.ai", title: "Chart", height: 600 });
    expect(parseAppendEmbed({ page: "p1", url: "https://claude.ai/a" })).toMatchObject({ title: "", height: 480 });
  });
  it("rejects anything that is not https, not on the list, or badly shaped, and says why", () => {
    for (const bad of [{ ...ok, url: "http://claude.ai/a" }, { ...ok, url: "javascript:alert(1)" }, { ...ok, url: "https://evil.example/a" }, { ...ok, url: "https://claude.ai.evil.com/a" }, { ...ok, url: "https://u:p@claude.ai/a" }, { ...ok, url: 5 }, { page: "p1" }, { ...ok, page: "bad id!" }, { ...ok, height: 50 }, { ...ok, height: 9999 }, { ...ok, height: 480.5 }, { ...ok, height: "tall" }, { ...ok, title: 3 }, { ...ok, title: "x".repeat(201) }, { ...ok, title: "a\u0007" }]) expect(() => parseAppendEmbed(bad as any), JSON.stringify(bad)).toThrow();
    expect(() => parseAppendEmbed({ ...ok, url: "https://example.com/x" })).toThrow(/Settings, Embedded pages/);
  });
  it("accepts a site the owner added in Settings (and its subdomains), and only then", () => {
    expect(() => parseAppendEmbed({ ...ok, url: "https://docs.example.com/x" })).toThrow();
    writeExtraHosts(["example.com"]); expect(parseAppendEmbed({ ...ok, url: "https://docs.example.com/x" }).host).toBe("docs.example.com");
  });
  it("is described in a sentence and, when approved, adds one live embed block at the end of the note", async () => {
    expect(describeProposal("append_embed", ok)).toMatch(/“Chart” \(claude\.ai\).*embedded at the end of the note, 600 pixels tall.*Open in new tab/);
    expect(canApply("append_embed")).toBe(true);
    expect(await applyProposal({ op: "append_embed", payload: ok })).toEqual({ ok: true, result: "Added 1 block" });
    expect(appended).toEqual([{ page: "p1", blocks: [{ type: "raw", block: { type: "nouEmbed", props: { url: "https://claude.ai/artifact/abc", title: "Chart", height: 600, mode: "live", fileId: "" } } }] }]);
  });
  it("writes nothing when the request is wrong when it is approved (the owner may have removed the site since)", async () => {
    const out = await applyProposal({ op: "append_embed", payload: { ...ok, url: "https://example.com/x" } });
    expect(out.ok).toBe(false); expect(out.result).toMatch(/not on your list/); expect(appended).toEqual([]); expect(calls).toEqual([]);
    expect(describeProposal("append_embed", { ...ok, url: "http://claude.ai/x" })).toBeNull();
  });
});

describe("a request to attach an HTML page", () => {
  const html = "<!doctype html><title>t</title><p>Hello</p>";
  const req = { page: "p1", title: "Chart", html };
  it("needs a title, a page and an HTML document that fits", () => {
    expect(parseAttachHtml(req)).toEqual({ page: "p1", title: "Chart", html, height: 480 });
    for (const bad of [{ ...req, title: "" }, { ...req, title: undefined }, { ...req, html: "  " }, { ...req, html: 5 }, { page: "p1", title: "T" }, { ...req, page: "x y" }, { ...req, html: "é".repeat(30_000) }, { ...req, height: 10 }]) expect(() => parseAttachHtml(bad as any), JSON.stringify(bad).slice(0, 60)).toThrow();
    expect(parseAttachHtml({ ...req, html: "x".repeat(48_000) }).html.length).toBe(48_000);
  });
  it("is stored with the page's files and then shown as a snapshot block that points at the stored file", async () => {
    expect(describeProposal("attach_html", req)).toMatch(/static copy.*works offline.*no network and no access to NOU.*will not update/);
    const out = await applyProposal({ op: "attach_html", payload: { ...req, title: "My <chart>/1" } });
    expect(out.ok).toBe(true);
    const up = calls.find(c => c.command === "upload_attachment_bytes")!; expect(new TextDecoder().decode(up.args)).toBe(html); expect(decodeURIComponent(up.extra.headers["x-file-name"])).toBe("My chart1.html");
    expect(appended[0].blocks[0]).toEqual({ type: "raw", block: { type: "nouEmbed", props: { url: "", title: "My <chart>/1", height: 480, mode: "snapshot", fileId: "f".repeat(64) } } });
  });
  it("stores nothing when the request is wrong", async () => {
    expect((await applyProposal({ op: "attach_html", payload: { page: "p1", title: "T", html: "" } })).ok).toBe(false);
    expect(calls).toEqual([]); expect(appended).toEqual([]);
  });
});
