import { describe, expect, it } from "vitest";
import { MAX_PASTED_IMAGES, namedPastes, pastedImages, pastedName } from "./pasteImages";

const file = (name: string, type: string, bytes = 5) => new File([new Uint8Array(bytes)], name, { type });
const clip = (files: File[], text = "") => ({ files, getData: (t: string) => (t === "text/plain" ? text : "") });
const when = new Date(2026, 10, 18, 21, 4, 9);

describe("pastedImages", () => {
  it("takes the images from a screenshot paste", () => {
    const shot = file("image.png", "image/png");
    expect(pastedImages(clip([shot]))).toEqual([shot]);
  });
  it("leaves the paste alone when there is text too (copied cells, copied web text)", () => {
    expect(pastedImages(clip([file("image.png", "image/png")], "A1\tB1"))).toEqual([]);
    expect(pastedImages(clip([file("image.png", "image/png")], "   "))).toHaveLength(1);
  });
  it("ignores files that are not pictures, empty files and a missing clipboard", () => {
    expect(pastedImages(clip([file("a.pdf", "application/pdf"), file("b.txt", "text/plain")]))).toEqual([]);
    expect(pastedImages(clip([file("empty.png", "image/png", 0)]))).toEqual([]);
    for (const none of [null, undefined, {}, { files: [] }, { files: null }]) expect(pastedImages(none as never)).toEqual([]);
  });
  it("refuses types that could carry script (svg) and stops at a sensible number", () => {
    expect(pastedImages(clip([file("x.svg", "image/svg+xml")]))).toEqual([]);
    const many = Array.from({ length: 25 }, (_, i) => file("i" + i + ".png", "image/png"));
    expect(pastedImages(clip(many))).toHaveLength(MAX_PASTED_IMAGES);
  });
  it("copes with a clipboard that refuses to be read", () => {
    const strict = { files: [file("image.png", "image/png")], getData: () => { throw new Error("no"); } };
    expect(pastedImages(strict)).toHaveLength(1);
  });
});

describe("naming pasted images", () => {
  it("a generic name becomes a screenshot name with the time", () => {
    expect(pastedName(file("image.png", "image/png"), when)).toBe("Screenshot 2026-11-18 21.04.09.png");
    expect(pastedName(file("", "image/jpeg"), when)).toBe("Screenshot 2026-11-18 21.04.09.jpg");
    expect(pastedName(file("blob", "image/webp"), when)).toBe("Screenshot 2026-11-18 21.04.09.webp");
  });
  it("a real name is kept, with unsafe characters replaced", () => {
    expect(pastedName(file("floor plan.png", "image/png"), when)).toBe("floor plan.png");
    expect(pastedName(file('a/b:c*d?.png', "image/png"), when)).toBe("a_b_c_d_.png");
  });
  it("several screenshots pasted at once get different names", () => {
    const out = namedPastes([file("image.png", "image/png"), file("image.png", "image/png"), file("image.png", "image/png")], when);
    expect(out.map(f => f.name)).toEqual(["Screenshot 2026-11-18 21.04.09.png", "Screenshot 2026-11-18 21.04.09 (2).png", "Screenshot 2026-11-18 21.04.09 (3).png"]);
    expect(out[0].type).toBe("image/png");
  });
});
