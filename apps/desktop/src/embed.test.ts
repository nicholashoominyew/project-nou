import { beforeEach, describe, expect, it } from "vitest";
import { allowedHosts, clampHeight, cleanHosts, embeddableUrl, embedLabel, EMBED_HOSTS_KEY, hostAllowed, knownUnframable, LIVE_SANDBOX, parseEmbedUrl, readExtraHosts, snapshotDocument, SNAPSHOT_SANDBOX, writeExtraHosts } from "./embed";
beforeEach(() => localStorage.clear());

describe("which addresses can be embedded", () => {
  it("accepts plain https addresses and returns the host, lower-cased", () => {
    expect(parseEmbedUrl(" https://Claude.AI/artifact/abc?x=1#y ")).toEqual({ href: "https://claude.ai/artifact/abc?x=1#y", host: "claude.ai" });
    expect(parseEmbedUrl("https://claude.ai:443/a").host).toBe("claude.ai");
  });
  it("rejects everything else with a plain message", () => {
    for (const bad of ["http://claude.ai/a", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "//claude.ai/a", "claude.ai/a", "", "   ", "https://", "https://user:pw@claude.ai/a", "https://claude.ai@evil.com/", "https://claude.ai:8443/a", "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/", "https://claude.ai/a b", "https://-bad.example.com/", "https://claude.ai/" + "a".repeat(2100), "ftp://claude.ai/a", "https://claude.ai\u0000/a"]) expect(() => parseEmbedUrl(bad), JSON.stringify(bad.slice(0, 50))).toThrow();
  });
});

describe("the host allowlist", () => {
  it("allows listed hosts and their subdomains, and nothing that merely looks similar", () => {
    const a = ["claude.ai"];
    for (const ok of ["claude.ai", "www.claude.ai", "a.b.claude.ai"]) expect(hostAllowed(ok, a), ok).toBe(true);
    for (const no of ["evilclaude.ai", "claude.ai.evil.com", "claude.com", "notclaude.ai", "claude.aix", "ai"]) expect(hostAllowed(no, a), no).toBe(false);
  });
  it("starts with claude.ai and takes extra hosts from Settings; anything else is not embeddable", () => {
    expect(allowedHosts()).toEqual(["claude.ai"]);
    expect(embeddableUrl("https://claude.ai/artifact/x")).toBe("https://claude.ai/artifact/x");
    expect(embeddableUrl("https://example.com/x")).toBeNull(); expect(embeddableUrl("http://claude.ai/x")).toBeNull(); expect(embeddableUrl("not a url")).toBeNull();
    expect(writeExtraHosts(["Example.com", "example.com", "  ", "http://bad", "localhost", "claude.ai", "x y.com", "ok.dev"])).toEqual(["example.com", "ok.dev"]);
    expect(readExtraHosts()).toEqual(["example.com", "ok.dev"]);
    expect(embeddableUrl("https://docs.example.com/x")).toBe("https://docs.example.com/x");
    expect(embeddableUrl("https://example.org/x")).toBeNull();
  });
  it("copes with a damaged or hostile stored list", () => {
    localStorage.setItem(EMBED_HOSTS_KEY, "not json"); expect(readExtraHosts()).toEqual([]);
    localStorage.setItem(EMBED_HOSTS_KEY, JSON.stringify([3, null, { a: 1 }, "ok.dev"])); expect(readExtraHosts()).toEqual(["ok.dev"]);
    expect(cleanHosts("x")).toEqual([]); expect(cleanHosts(Array.from({ length: 200 }, (_, i) => `h${i}.dev`)).length).toBe(50);
  });
});

describe("small rules", () => {
  it("keeps the height in range, with a default", () => {
    expect([clampHeight(undefined), clampHeight("x"), clampHeight(NaN), clampHeight(10), clampHeight(5000), clampHeight(600.4)]).toEqual([480, 480, 480, 200, 1600, 600]);
  });
  it("knows claude.ai refuses to be framed, and labels a block by its title or host", () => {
    expect(knownUnframable("claude.ai")).toMatch(/frame-ancestors/); expect(knownUnframable("www.claude.ai")).toBeTruthy(); expect(knownUnframable("example.com")).toBeNull();
    expect(embedLabel("Chart", "https://claude.ai/a")).toBe("Chart"); expect(embedLabel("  ", "https://claude.ai/a")).toBe("claude.ai"); expect(embedLabel("", "")).toBe("Embedded page");
  });
  it("the sandboxes have no top navigation, and a snapshot has no origin of its own", () => {
    expect(LIVE_SANDBOX).toBe("allow-scripts allow-same-origin allow-popups"); expect(LIVE_SANDBOX).not.toMatch(/top-navigation/);
    expect(SNAPSHOT_SANDBOX).toBe("allow-scripts"); expect(SNAPSHOT_SANDBOX).not.toMatch(/same-origin|top-navigation|popups|forms/);
  });
  it("a snapshot starts with a policy that allows no network, and its own doctype replaces the page's", () => {
    const doc = snapshotDocument("<!DOCTYPE html><html><body>Hi</body></html>");
    expect(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc).toMatch(/default-src 'none'/); expect(doc).toMatch(/connect-src 'none'/); expect(doc).toMatch(/frame-src 'none'/); expect(doc).toMatch(/form-action 'none'/); expect(doc).not.toMatch(/https?:/);
    expect(doc.match(/<!doctype/gi)!.length).toBe(1); expect(doc).toContain("<html><body>Hi</body></html>");
  });
});
