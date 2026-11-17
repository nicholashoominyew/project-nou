import { describe, expect, it } from "vitest";
import { routeEdge, roundedPath, pathMidpoint, styleNode, styleEdge, camOf, camPoint, camScale, panCam, zoomCam, MIN_CAM_W, addNode, boundaryPoint, chartBounds, connect, editNode, emptyChart, flowchartText, labelEdge, moveNode, newId, parseFlowchart, removeEdge, removeNode, serializeFlowchart, tidyLayout, MAX_NODES, MAX_TEXT, NODE_W } from "./flowchart";

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

describe("canvas camera", () => {
  const cam = { x: 0, y: 0, w: 1000, h: 500 };
  it("zooming keeps the point under the pointer fixed", () => {
    const z = zoomCam(cam, 2, 0.25, 0.5);
    expect(z.w).toBe(500); expect(z.h).toBe(250);
    // the chart point at 25% across and halfway down is the same before and after
    expect(z.x + 0.25 * z.w).toBeCloseTo(0 + 0.25 * cam.w); expect(z.y + 0.5 * z.h).toBeCloseTo(0 + 0.5 * cam.h);
  });
  it("zoom is limited so the chart can neither vanish nor fill the frame with nothing", () => {
    let c = cam; for (let i = 0; i < 40; i++) c = zoomCam(c, 2);
    expect(c.w).toBe(MIN_CAM_W);
    c = cam; for (let i = 0; i < 40; i++) c = zoomCam(c, 0.5);
    expect(c.w).toBeLessThanOrEqual(60000);
  });
  it("panning moves the view and nothing else", () => {
    expect(panCam(cam, 30, -10)).toEqual({ x: 30, y: -10, w: 1000, h: 500 });
  });
  it("converts a pixel in the frame to chart coordinates, keeping proportions and centring", () => {
    // a 1000x500 view in a 500x500 frame is scaled by 0.5 and centred vertically
    expect(camScale(cam, 500, 500)).toBe(0.5);
    expect(camPoint(cam, 500, 500, 0, 125)).toEqual({ x: 0, y: 0 });
    expect(camPoint(cam, 500, 500, 500, 375)).toEqual({ x: 1000, y: 500 });
    expect(camPoint(cam, 0, 0, 5, 5)).toEqual({ x: 0, y: 0 });
    expect(camOf({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe("box and arrow looks", () => {
  const base = () => connect(addNode(addNode(emptyChart(), "A", "step", "a").chart, "B", "step", "b").chart, "a", "b");
  it("a look is kept, and a value equal to the default removes it again", () => {
    let c = styleNode(base(), "a", { border: "red", line: "dashed", fill: "blue" });
    expect(c.nodes[0]).toMatchObject({ border: "red", line: "dashed", fill: "blue" });
    c = styleNode(c, "a", { line: "solid", fill: "default" });
    expect(c.nodes[0].line).toBeUndefined(); expect(c.nodes[0].fill).toBeUndefined(); expect(c.nodes[0].border).toBe("red");
    let e = styleEdge(base(), "a", "b", { color: "green", line: "dotted", fill: "pink", arrow: false });
    expect(e.edges[0]).toMatchObject({ color: "green", line: "dotted", fill: "pink", arrow: false });
    e = styleEdge(e, "a", "b", { arrow: true, line: "solid" });
    expect(e.edges[0].arrow).toBeUndefined(); expect(e.edges[0].line).toBeUndefined();
  });
  it("a plain chart stores no look at all, so existing charts are unchanged", () => {
    const c = parseFlowchart(serializeFlowchart(base()));
    expect(Object.keys(c.nodes[0]).sort()).toEqual(["id", "shape", "text", "x", "y"]);
    expect(Object.keys(c.edges[0]).sort()).toEqual(["from", "label", "to"]);
  });
  it("saved looks survive a round trip; anything outside the lists is dropped", () => {
    const c = parseFlowchart({ nodes: [{ id: "a", text: "A", border: "red", line: "dotted", fill: "blue" }, { id: "b", text: "B", border: "#ff0000", line: "wavy", fill: "url(javascript:x)" }],
      edges: [{ from: "a", to: "b", color: "purple", line: "none", fill: "pink", arrow: false }, { from: "b", to: "a", color: "<script>", line: "dashed", arrow: "no" }] });
    expect(c.nodes[0]).toMatchObject({ border: "red", line: "dotted", fill: "blue" });
    expect(c.nodes[1].border).toBeUndefined(); expect(c.nodes[1].line).toBeUndefined(); expect(c.nodes[1].fill).toBeUndefined();
    expect(c.edges[0]).toMatchObject({ color: "purple", fill: "pink", arrow: false }); expect(c.edges[0].line).toBeUndefined();
    expect(c.edges[1]).toMatchObject({ line: "dashed" }); expect(c.edges[1].color).toBeUndefined(); expect(c.edges[1].arrow).toBeUndefined();
  });
});

describe("stepped arrows", () => {
  const box = (id: string, x: number, y: number, shape: "step" | "decision" | "terminal" = "step") => ({ id, text: id, x, y, shape });
  const onlyRightAngles = (pts: { x: number; y: number }[]) => pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);
  it("a box up and to the right of another leaves its side, goes along, and drops into the top (the L shape)", () => {
    const pts = routeEdge(box("in", 400, 0), box("z", 0, 200));
    expect(pts).toEqual([{ x: 330, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 178 }]);
    expect(onlyRightAngles(pts)).toBe(true);
  });
  it("a box below another leaves the bottom and enters the top, with a step between when they are offset", () => {
    const pts = routeEdge(box("a", 0, 0), box("b", 60, 200));
    expect(pts[0]).toEqual({ x: 0, y: 22 }); expect(pts[pts.length - 1]).toEqual({ x: 60, y: 178 });
    expect(onlyRightAngles(pts)).toBe(true); expect(pts.length).toBe(4);
  });
  it("boxes side by side leave one side and enter the other, with a step when they differ in height", () => {
    const pts = routeEdge(box("a", 0, 0), box("b", 400, 30));
    expect(pts[0]).toEqual({ x: 70, y: 0 }); expect(pts[pts.length - 1]).toEqual({ x: 330, y: 30 }); expect(pts.length).toBe(4);
    expect(onlyRightAngles(pts)).toBe(true);
  });
  it("aligned boxes get one straight segment, with no tiny jog", () => {
    expect(routeEdge(box("a", 0, 0), box("b", 0, 200))).toEqual([{ x: 0, y: 22 }, { x: 0, y: 178 }]);
    expect(routeEdge(box("a", 0, 0), box("b", 400, 1))).toEqual([{ x: 70, y: 0 }, { x: 330, y: 1 }]);
  });
  it("goes the other way for a target that is left of or above the source", () => {
    const up = routeEdge(box("a", 0, 200), box("b", 0, 0));
    expect(up).toEqual([{ x: 0, y: 178 }, { x: 0, y: 22 }]);
    const left = routeEdge(box("a", 400, 0), box("b", 0, 0));
    expect(left[0].x).toBe(330); expect(left[left.length - 1].x).toBe(70);
  });
  it("a decision diamond is joined at its points, and overlapping boxes fall back to a plain line", () => {
    const pts = routeEdge(box("d", 0, 0, "decision"), box("b", 400, 300));
    expect(pts[0]).toEqual({ x: 70, y: 0 });
    expect(routeEdge(box("a", 0, 0), box("b", 20, 10)).length).toBe(2);
  });
  it("straight keeps the old line between the outlines", () => {
    const pts = routeEdge(box("a", 0, 0), box("b", 400, 200), "straight");
    expect(pts.length).toBe(2);
    expect(pts[0].x).toBeGreaterThan(0); expect(pts[1].x).toBeLessThan(400);
  });
  it("a rounded path keeps the end points, rounds the corners and never overshoots a short segment", () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10);
    expect(d).toBe("M0 0 L90 0 Q100 0 100 10 L100 100");
    expect(roundedPath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 100 }], 10)).toContain("Q4 0 4 2");
    expect(roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }], 10)).toBe("M0 0 L50 0");
    expect(roundedPath([], 10)).toBe("");
  });
  it("the label sits halfway along the path", () => {
    expect(pathMidpoint([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])).toEqual({ x: 100, y: 0 });
    expect(pathMidpoint([{ x: 0, y: 0 }, { x: 0, y: 40 }])).toEqual({ x: 0, y: 20 });
  });
  it("straight is the only route that is stored; stepped is the default", () => {
    let c = connect(addNode(addNode(emptyChart(), "A", "step", "a").chart, "B", "step", "b").chart, "a", "b");
    expect(c.edges[0].route).toBeUndefined();
    c = styleEdge(c, "a", "b", { route: "straight" }); expect(c.edges[0].route).toBe("straight");
    c = styleEdge(c, "a", "b", { route: "stepped" }); expect(c.edges[0].route).toBeUndefined();
    expect(parseFlowchart({ nodes: [{ id: "a", text: "A" }, { id: "b", text: "B" }], edges: [{ from: "a", to: "b", route: "diagonal" }] }).edges[0].route).toBeUndefined();
  });
});
