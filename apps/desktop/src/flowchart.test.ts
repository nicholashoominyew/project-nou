import { describe, expect, it } from "vitest";
import { addNode, boundaryPoint, chartBounds, connect, editNode, emptyChart, flowchartText, labelEdge, moveNode, newId, parseFlowchart, removeEdge, removeNode, serializeFlowchart, tidyLayout, MAX_NODES, MAX_TEXT, NODE_W } from "./flowchart";

const chart3 = () => {
  let c = emptyChart();
  for (const [id, text] of [["a", "Start"], ["b", "Check"], ["c", "End"]] as const) c = addNode(c, text, "step", id).chart;
  return connect(connect(c, "a", "b"), "b", "c");
};

describe("parseFlowchart", () => {
  it("round-trips a chart", () => {
    const c = chart3();
    expect(parseFlowchart(serializeFlowchart(c))).toEqual(c);
  });
  it("never throws on junk and returns an empty chart", () => {
    for (const bad of [undefined, null, 5, "", "{not json", "[]", "null", { nodes: 3 }, { nodes: "x", edges: {} }]) expect(parseFlowchart(bad as never)).toEqual(emptyChart());
  });
  it("drops bad nodes and edges but keeps good ones", () => {
    const c = parseFlowchart({
      nodes: [{ id: "a", text: "A", x: 1, y: 2 }, { id: "a", text: "dup" }, { id: "bad id!", text: "x" }, { id: "b", text: "B", shape: "weird", x: "oops" }, null],
      edges: [{ from: "a", to: "b" }, { from: "a", to: "a" }, { from: "a", to: "ghost" }, { from: "a", to: "b", label: "again" }, "x"],
    });
    expect(c.nodes.map(n => n.id)).toEqual(["a", "b"]);
    expect(c.nodes[1]).toMatchObject({ shape: "step", x: 0, y: 0 });
    expect(c.edges).toEqual([{ from: "a", to: "b", label: "" }]);
  });
  it("limits sizes, strips control characters and keeps coordinates sane", () => {
    const c = parseFlowchart({ nodes: [{ id: "a", text: "x".repeat(500) + "\u0000", x: 1e9, y: -1e9 }, ...Array.from({ length: 200 }, (_, i) => ({ id: "n" + i, text: "t" }))] });
    expect(c.nodes.length).toBe(MAX_NODES);
    expect(c.nodes[0].text.length).toBe(MAX_TEXT);
    expect(c.nodes[0].x).toBe(5000); expect(c.nodes[0].y).toBe(-5000);
  });
  it("treats markup in text as plain text (it is only ever drawn as SVG text)", () => {
    expect(parseFlowchart({ nodes: [{ id: "a", text: "<script>alert(1)</script>" }] }).nodes[0].text).toBe("<script>alert(1)</script>");
  });
});

describe("editing operations", () => {
  it("adds steps below the lowest one and returns the new id", () => {
    const first = addNode(emptyChart(), "One", "step", "a");
    expect(first.chart.nodes[0]).toMatchObject({ id: "a", x: 0, y: 0 });
    const second = addNode(first.chart, "Two", "decision", "b");
    expect(second.chart.nodes[1].y).toBeGreaterThan(0);
    expect(newId(["a"])).not.toBe("a");
  });
  it("stops adding at the limit", () => {
    let c = emptyChart();
    for (let i = 0; i < MAX_NODES + 5; i++) c = addNode(c, "s", "step", "n" + i).chart;
    expect(c.nodes.length).toBe(MAX_NODES);
  });
  it("moves, edits and relabels", () => {
    let c = chart3();
    c = moveNode(c, "a", 50, 60); expect(c.nodes[0]).toMatchObject({ x: 50, y: 60 });
    c = editNode(c, "a", { text: "  New   text ", shape: "decision" }); expect(c.nodes[0]).toMatchObject({ text: "New text", shape: "decision" });
    c = labelEdge(c, "a", "b", "yes"); expect(c.edges[0].label).toBe("yes");
  });
  it("connect ignores self links, unknown steps and repeats", () => {
    const c = chart3();
    expect(connect(c, "a", "a")).toBe(c); expect(connect(c, "a", "zzz")).toBe(c); expect(connect(c, "a", "b")).toBe(c);
    expect(connect(c, "c", "a").edges.length).toBe(3);
  });
  it("removing a step removes its arrows; removing an arrow keeps the steps", () => {
    const c = removeNode(chart3(), "b");
    expect(c.nodes.map(n => n.id)).toEqual(["a", "c"]); expect(c.edges).toEqual([]);
    const d = removeEdge(chart3(), "a", "b");
    expect(d.nodes.length).toBe(3); expect(d.edges).toEqual([{ from: "b", to: "c", label: "" }]);
  });
});

describe("geometry and layout", () => {
  it("arrows leave a box at its edge, and a diamond at its point", () => {
    const rect = { id: "r", text: "", x: 0, y: 0, shape: "step" as const };
    expect(boundaryPoint(rect, 1000, 0).x).toBeCloseTo(NODE_W / 2); expect(boundaryPoint(rect, 1000, 0).y).toBeCloseTo(0);
    expect(boundaryPoint(rect, 0, -500).y).toBeCloseTo(-22);
    const dia = { ...rect, shape: "decision" as const };
    expect(boundaryPoint(dia, 1000, 0).x).toBeCloseTo(NODE_W / 2);
    const diag = boundaryPoint(dia, 100, 100);
    expect(Math.abs(diag.x) / (NODE_W / 2) + Math.abs(diag.y) / 32).toBeCloseTo(1);
    expect(boundaryPoint(rect, 0, 0)).toEqual({ x: 0, y: 0 });
  });
  it("tidy puts each step a row below what feeds it, side by side when parallel, and survives loops", () => {
    let c = chart3();
    c = addNode(c, "Side", "step", "d").chart; c = connect(c, "a", "d");
    const t = tidyLayout(c);
    const at = (id: string) => t.nodes.find(n => n.id === id)!;
    expect(at("a").y).toBe(0); expect(at("b").y).toBe(100); expect(at("c").y).toBe(200); expect(at("d").y).toBe(100);
    expect(at("b").x).not.toBe(at("d").x);
    const loop = tidyLayout(connect(c, "c", "a"));
    expect(loop.nodes.every(n => Number.isFinite(n.x + n.y))).toBe(true);
  });
  it("the view box fits all steps and has a default for an empty chart", () => {
    const b = chartBounds(chart3());
    expect(b.w).toBeGreaterThanOrEqual(200); expect(b.h).toBeGreaterThan(0);
    expect(chartBounds(emptyChart()).w).toBeGreaterThan(0);
  });
  it("search text lists the step texts in order", () => {
    expect(flowchartText(serializeFlowchart(chart3()))).toBe("Start → Check → End");
    expect(flowchartText("junk")).toBe("");
  });
});
