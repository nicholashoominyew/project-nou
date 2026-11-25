import { describe, expect, it } from "vitest";
import { moveBefore, nudge } from "./Reorder";

describe("reordering", () => {
  it("moves an item before another, to the end, and ignores nonsense", () => {
    expect(moveBefore(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveBefore(["a", "b", "c", "d"], "a", null)).toEqual(["b", "c", "d", "a"]);
    const same = ["a", "b"];
    expect(moveBefore(same, "a", "a")).toBe(same);
    expect(moveBefore(same, "x", "a")).toBe(same);
    expect(moveBefore(same, "a", "x")).toBe(same);
  });
  it("nudges an item up or down one place and stops at the ends", () => {
    expect(nudge(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudge(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    const l = ["a", "b"];
    expect(nudge(l, "a", -1)).toBe(l); expect(nudge(l, "b", 1)).toBe(l); expect(nudge(l, "z", 1)).toBe(l);
  });
});
