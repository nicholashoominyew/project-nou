import { describe, expect, it } from "vitest";
import { moveWidget, normalizeLayout, setWidgetHidden } from "./homeLayout";

const known = ["recent", "favorites", "tags"];

describe("home layout", () => {
  it("starts with every widget visible in registry order", () => {
    expect(normalizeLayout(null, known)).toEqual({ order: known, hidden: [] });
    expect(normalizeLayout("garbage", known)).toEqual({ order: known, hidden: [] });
  });
  it("drops unknown or duplicate ids, appends widgets added later, and keeps hidden to real widgets", () => {
    const stored = { order: ["tags", "ghost", "tags", "recent"], hidden: ["ghost", "recent", "recent", 7] };
    expect(normalizeLayout(stored, known)).toEqual({ order: ["tags", "recent", "favorites"], hidden: ["recent"] });
  });
  it("moves a widget among the visible ones and ignores moves off either end", () => {
    const layout = { order: ["recent", "favorites", "tags"], hidden: [] };
    expect(moveWidget(layout, "tags", -1).order).toEqual(["recent", "tags", "favorites"]);
    expect(moveWidget(layout, "recent", -1)).toBe(layout);
    expect(moveWidget(layout, "tags", 1)).toBe(layout);
    expect(moveWidget(layout, "nope", 1)).toBe(layout);
  });
  it("skips hidden widgets when moving, so a visible widget never swaps with an invisible one", () => {
    const layout = { order: ["recent", "favorites", "tags"], hidden: ["favorites"] };
    expect(moveWidget(layout, "tags", -1).order).toEqual(["tags", "favorites", "recent"]);
  });
  it("hides and shows widgets without reordering", () => {
    const layout = normalizeLayout(null, known);
    const hidden = setWidgetHidden(layout, "favorites", true);
    expect(hidden).toEqual({ order: known, hidden: ["favorites"] });
    expect(setWidgetHidden(hidden, "favorites", false)).toEqual({ order: known, hidden: [] });
    expect(setWidgetHidden(layout, "ghost", true)).toBe(layout);
  });
});
