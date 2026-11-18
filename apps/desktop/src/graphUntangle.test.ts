import { describe, expect, it } from "vitest";
import { countCrossings, countOnLines, nearSegment, segmentsCross, type Link, type Pt } from "./graphUntangle";
import { layoutGraph } from "./graphLayout";

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: "p" + i }));
const asEdges = (links: Link[]) => links.map(([a, b]) => ({ source: "p" + a, target: "p" + b }));
function drawn(n: number, links: Link[]) {
  const map = layoutGraph(ids(n), asEdges(links));
  return { pos: ids(n).map(x => map.get(x.id)!) as Pt[], map };
}
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

describe("crossing helpers", () => {
  it("segments cross only when they properly cross", () => {
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBe(false);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 0 })).toBe(false); // they only touch at an end
    expect(segmentsCross({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(false); // lines would meet beyond the first segment
  });
  it("counts crossings but not lines that share a page", () => {
    const pos = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 5, y: 20 }];
    expect(countCrossings(pos, [[0, 1], [2, 3]])).toBe(1);
    expect(countCrossings(pos, [[0, 1], [1, 3]])).toBe(0);
    expect(countCrossings(pos, [[0, 1], [2, 3], [2, 4]])).toBe(1);
  });
  it("sees a page sitting on someone else's line", () => {
    expect(nearSegment({ x: 5, y: 1 }, { x: 0, y: 0 }, { x: 10, y: 0 }, 3)).toBe(true);
    expect(nearSegment({ x: 5, y: 9 }, { x: 0, y: 0 }, { x: 10, y: 0 }, 3)).toBe(false);
    expect(nearSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, 3)).toBe(false);
    expect(countOnLines([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 1 }], [[0, 1]], 3)).toBe(1);
  });
});

describe("a drawn graph has no crossing lines", () => {
  it("the graph from the screenshot: two clusters whose lines used to cross", () => {
    // 0 Gateway test, 1 Gateway sub, 2 centre page, 3 top right, 4 left, 5 bottom, 6 bottom right
    const links: Link[] = [[0, 1], [2, 3], [2, 4], [2, 5], [2, 1], [1, 6]];
    const { pos } = drawn(7, links);
    expect(countCrossings(pos, links)).toBe(0);
    expect(countOnLines(pos, links)).toBe(0);
  });
  it("any tree or forest, large or small, is drawn without a crossing", () => {
    const r = rng(5);
    for (let t = 0; t < 40; t++) {
      const n = 5 + Math.floor(r() * 40);
      const links: Link[] = [];
      for (let i = 1; i < n; i++) if (r() < 0.9) links.push([Math.floor(r() * i), i]);
      const { pos } = drawn(n, links);
      expect(countCrossings(pos, links), `tree ${t} with ${n} pages`).toBe(0);
    }
  });
  it("graphs that can be drawn flat are drawn flat: cycles, a wheel, a grid and a cube", () => {
    const cycle: Link[] = Array.from({ length: 9 }, (_, i) => [i, (i + 1) % 9]);
    const wheel: Link[] = [...Array.from({ length: 6 }, (_, i): Link => [i, (i + 1) % 6]), ...Array.from({ length: 6 }, (_, i): Link => [i, 6])];
    const grid: Link[] = []; for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) { if (x < 2) grid.push([y * 3 + x, y * 3 + x + 1]); if (y < 2) grid.push([y * 3 + x, (y + 1) * 3 + x]); }
    const cube: Link[] = []; for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) cube.push([i, i | bit]);
    for (const [name, n, links] of [["cycle", 9, cycle], ["wheel", 7, wheel], ["grid", 9, grid], ["cube", 8, cube]] as [string, number, Link[]][]) {
      const { pos } = drawn(n, links);
      expect(countCrossings(pos, links), name).toBe(0);
    }
  });
  it("a graph that cannot be drawn flat (five pages all linked) is never worse than before", () => {
    const k5: Link[] = []; for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) k5.push([a, b]);
    const { pos } = drawn(5, k5);
    expect(countCrossings(pos, k5)).toBeLessThanOrEqual(5);
    expect(countCrossings(pos, k5)).toBeGreaterThanOrEqual(1);
  });
  it("a big graph is laid out quickly and stays inside the frame", () => {
    const r = rng(9), n = 150, links: Link[] = [];
    for (let i = 1; i < n; i++) links.push([Math.floor(r() * i), i]);
    for (let e = 0; e < 20; e++) links.push([Math.floor(r() * n), Math.floor(r() * n)]);
    const t0 = Date.now();
    const { pos } = drawn(n, links.filter(([a, b]) => a !== b));
    expect(Date.now() - t0).toBeLessThan(25000);
    for (const p of pos) { expect(p.x).toBeGreaterThanOrEqual(59); expect(p.x).toBeLessThanOrEqual(941); expect(p.y).toBeGreaterThanOrEqual(59); expect(p.y).toBeLessThanOrEqual(641); expect(Number.isFinite(p.x + p.y)).toBe(true); }
  }, 60000);
  it("is deterministic and keeps unlinked pages in the frame", () => {
    const links: Link[] = [[0, 1], [1, 2], [2, 0], [3, 4]];
    expect(drawn(7, links).pos).toEqual(drawn(7, links).pos);
    expect(drawn(2, []).pos.length).toBe(2);
    expect(drawn(1, []).pos.length).toBe(1);
  });
});
