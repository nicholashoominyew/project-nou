import { describe, expect, it } from "vitest";
import { blockLink, parseBlockLink } from "./blockLink";

describe("links to a block", () => {
  it("round-trip a page and a block", () => {
    const link = blockLink("page-1", "141380f0-c62f-458c-90d9-a55e8acb2296");
    expect(link).toBe("https://nou.invalid/page/page-1#141380f0-c62f-458c-90d9-a55e8acb2296");
    expect(parseBlockLink(" " + link + " ")).toEqual({ pageId: "page-1", blockId: "141380f0-c62f-458c-90d9-a55e8acb2296" });
  });
  it("are nothing else: other sites, missing or odd parts", () => {
    for (const bad of ["https://example.com/page/a#b", "https://nou.invalid.example.com/page/a#b", "https://nou.invalid/page/a", "https://nou.invalid/page/#b", "https://nou.invalid/page/a#b#c", 'https://nou.invalid/page/a#b"]{}', "nou://page/a#b"])
      expect(parseBlockLink(bad), bad).toBeNull();
  });
});
