import { describe, expect, it } from "vitest";
import { layoutGraph, MAX_GRAPH_NODES, pageDepths, dotRadius } from "./graphLayout";

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: "p" + i }));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("layoutGraph", () => {
  it("handles no pages and one page", () => {
    expect(layoutGraph([], []).size).toBe(0);
    expect(layoutGraph([{ id: "a" }], [])).toEqual(new Map([["a", { x: 500, y: 350 }]]));
  });
  it("is deterministic: the same pages always land in the same places", () => {
    const edges = [{ source: "p0", target: "p1" }, { source: "p1", target: "p2" }];
    expect(layoutGraph(ids(8), edges)).toEqual(layoutGraph(ids(8), edges));
  });
  it("keeps every node inside the frame and never on top of another", () => {
    const nodes = ids(40);
    const edges = nodes.slice(1).map((n, i) => ({ source: "p" + Math.floor(i / 2), target: n.id }));
    const pts = layoutGraph(nodes, edges, 1000, 700, 60);
    expect(pts.size).toBe(40);
    const all = [...pts.values()];
    for (const p of all) { expect(p.x).toBeGreaterThanOrEqual(59.9); expect(p.x).toBeLessThanOrEqual(940.1); expect(p.y).toBeGreaterThanOrEqual(59.9); expect(p.y).toBeLessThanOrEqual(640.1); expect(Number.isFinite(p.x + p.y)).toBe(true); }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(dist(all[i], all[j])).toBeGreaterThan(2);
  });
  it("pulls linked pages closer together than unlinked ones", () => {
    const nodes = ids(6);
    const pts = layoutGraph(nodes, [{ source: "p0", target: "p1" }, { source: "p1", target: "p2" }, { source: "p0", target: "p2" }]);
    const linked = (dist(pts.get("p0")!, pts.get("p1")!) + dist(pts.get("p1")!, pts.get("p2")!)) / 2;
    const loose = (dist(pts.get("p3")!, pts.get("p4")!) + dist(pts.get("p4")!, pts.get("p5")!)) / 2;
    expect(linked).toBeLessThan(loose);
  });
  it("ignores edges to unknown pages, self links and duplicates", () => {
    const pts = layoutGraph(ids(3), [{ source: "p0", target: "ghost" }, { source: "p1", target: "p1" }, { source: "p0", target: "p2" }, { source: "p2", target: "p0" }]);
    expect(pts.size).toBe(3);
  });
  it("lays out at most the maximum number of pages", () => {
    expect(layoutGraph(ids(MAX_GRAPH_NODES + 25), []).size).toBe(MAX_GRAPH_NODES);
  });
});

describe("hierarchy sizing", () => {
  it("measures how deep each page sits and survives missing parents and loops", () => {
    const d = pageDepths([{ id: "a", parent_id: null }, { id: "b", parent_id: "a" }, { id: "c", parent_id: "b" }, { id: "orphan", parent_id: "gone" }, { id: "x", parent_id: "y" }, { id: "y", parent_id: "x" }]);
    expect(d.get("a")).toBe(0); expect(d.get("b")).toBe(1); expect(d.get("c")).toBe(2); expect(d.get("orphan")).toBe(0);
    expect(Number.isFinite(d.get("x")!)).toBe(true);
  });
  it("main pages get the biggest dots, each level is smaller, and there is a floor", () => {
    expect(dotRadius(0)).toBeGreaterThan(dotRadius(1));
    expect(dotRadius(1)).toBeGreaterThan(dotRadius(2));
    expect(dotRadius(2)).toBeGreaterThan(dotRadius(3));
    expect(dotRadius(30)).toBe(5);
  });
});
