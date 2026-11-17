/** Flowchart data and the pure operations on it. The block stores this as JSON in one prop; everything read back is re-validated. */
export type Shape = "step" | "decision" | "terminal";
import { boxColor, lineType, type BoxColor, type LineType } from "./blockOps";
/** Look of a box: outline colour and type, and fill colour. Anything left out is the normal look. */
export type NodeLook = { border?: BoxColor; line?: LineType; fill?: BoxColor };
/** Look of an arrow: line colour and type, the arrowhead's fill colour (it follows the line colour when not set) and whether it has an arrowhead. */
export type Route = "stepped" | "straight";
export type EdgeLook = { color?: BoxColor; line?: Exclude<LineType, "none">; fill?: BoxColor; arrow?: boolean; route?: Route };
export type FNode = { id: string; text: string; x: number; y: number; shape: Shape } & NodeLook;
export type FEdge = { from: string; to: string; label: string } & EdgeLook;
export type Flowchart = { nodes: FNode[]; edges: FEdge[] };

export const MAX_NODES = 100, MAX_EDGES = 300, MAX_TEXT = 100, MAX_LABEL = 40, COORD = 5000;
export const NODE_W = 140;
export const nodeHeight = (shape: Shape) => (shape === "decision" ? 64 : 44);
export const SHAPES: Shape[] = ["step", "decision", "terminal"];
export const SHAPE_NAMES: Record<Shape, string> = { step: "Step", decision: "Decision", terminal: "Start / end" };

const clamp = (n: number) => Math.max(-COORD, Math.min(COORD, Math.round(n)));
const tidy = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const goodId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-zA-Z_-]{1,24}$/.test(s);

/** Looks are kept only when they differ from the default, so plain charts stay small and unchanged. */
function nodeLook(o: Record<string, unknown>): NodeLook {
  const out: NodeLook = {};
  if (boxColor(o.border) !== "default") out.border = boxColor(o.border);
  if (lineType(o.line) !== "solid") out.line = lineType(o.line);
  if (boxColor(o.fill) !== "default") out.fill = boxColor(o.fill);
  return out;
}
function edgeLook(o: Record<string, unknown>): EdgeLook {
  const out: EdgeLook = {};
  if (boxColor(o.color) !== "default") out.color = boxColor(o.color);
  const l = lineType(o.line);
  if (l === "dashed" || l === "dotted") out.line = l;
  if (boxColor(o.fill) !== "default") out.fill = boxColor(o.fill);
  if (o.arrow === false) out.arrow = false;
  if (o.route === "straight") out.route = "straight"; // stepped is the normal look, so it is not stored
  return out;
}

export const emptyChart = (): Flowchart => ({ nodes: [], edges: [] });

/** Reads stored JSON defensively. Anything malformed is dropped, never thrown: a damaged chart must not stop a note from opening. */
export function parseFlowchart(raw: unknown): Flowchart {
  let data: unknown = raw;
  if (typeof raw === "string") { try { data = JSON.parse(raw); } catch { return emptyChart(); } }
  if (!data || typeof data !== "object") return emptyChart();
  const d = data as { nodes?: unknown; edges?: unknown };
  const nodes: FNode[] = [], seen = new Set<string>();
  for (const n of Array.isArray(d.nodes) ? d.nodes : []) {
    if (nodes.length >= MAX_NODES || !n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    if (!goodId(o.id) || seen.has(o.id)) continue;
    seen.add(o.id);
    nodes.push({ id: o.id, text: tidy(o.text, MAX_TEXT), x: clamp(Number(o.x) || 0), y: clamp(Number(o.y) || 0), shape: SHAPES.includes(o.shape as Shape) ? (o.shape as Shape) : "step", ...nodeLook(o) });
  }
  const edges: FEdge[] = [], pairs = new Set<string>();
  for (const e of Array.isArray(d.edges) ? d.edges : []) {
    if (edges.length >= MAX_EDGES || !e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (!goodId(o.from) || !goodId(o.to) || o.from === o.to || !seen.has(o.from) || !seen.has(o.to)) continue;
    const key = o.from + ">" + o.to;
    if (pairs.has(key)) continue;
    pairs.add(key);
    edges.push({ from: o.from, to: o.to, label: tidy(o.label, MAX_LABEL), ...edgeLook(o) });
  }
  return { nodes, edges };
}
export const serializeFlowchart = (c: Flowchart) => JSON.stringify(parseFlowchart(c));

let counter = 0;
export function newId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let id = "";
  do { id = "n" + (Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 5)).slice(-8); } while (used.has(id));
  return id;
}

/** Adds a step just below the lowest existing one (or at the top for an empty chart). Returns the new chart and the new node's id. */
export function addNode(c: Flowchart, text = "New step", shape: Shape = "step", id?: string): { chart: Flowchart; id: string } {
  if (c.nodes.length >= MAX_NODES) return { chart: c, id: "" };
  const nid = id ?? newId(c.nodes.map(n => n.id));
  const lowest = c.nodes.reduce((m, n) => Math.max(m, n.y), -90);
  const x = c.nodes.length ? c.nodes[c.nodes.length - 1].x : 0;
  return { chart: { ...c, nodes: [...c.nodes, { id: nid, text: tidy(text, MAX_TEXT), x, y: c.nodes.length ? lowest + 100 : 0, shape }] }, id: nid };
}
export const moveNode = (c: Flowchart, id: string, x: number, y: number): Flowchart => ({ ...c, nodes: c.nodes.map(n => (n.id === id ? { ...n, x: clamp(x), y: clamp(y) } : n)) });
export const editNode = (c: Flowchart, id: string, patch: Partial<Pick<FNode, "text" | "shape">>): Flowchart => ({ ...c, nodes: c.nodes.map(n => (n.id === id ? { ...n, ...(patch.text !== undefined ? { text: tidy(patch.text, MAX_TEXT) } : {}), ...(patch.shape && SHAPES.includes(patch.shape) ? { shape: patch.shape } : {}) } : n)) });
/** Change how a box looks. A value equal to the default removes the setting. */
export function styleNode(c: Flowchart, id: string, look: NodeLook): Flowchart {
  return { ...c, nodes: c.nodes.map(n => {
    if (n.id !== id) return n;
    const { border, line, fill, ...rest } = n;
    return { ...rest, ...nodeLook({ border, line, fill, ...look }) } as FNode;
  }) };
}
/** Change how an arrow looks. A value equal to the default removes the setting. */
export function styleEdge(c: Flowchart, from: string, to: string, look: EdgeLook): Flowchart {
  return { ...c, edges: c.edges.map(e => {
    if (e.from !== from || e.to !== to) return e;
    const { color, line, fill, arrow, route, ...rest } = e;
    return { ...rest, ...edgeLook({ color, line, fill, arrow, route, ...look }) } as FEdge;
  }) };
}
export const removeNode = (c: Flowchart, id: string): Flowchart => ({ nodes: c.nodes.filter(n => n.id !== id), edges: c.edges.filter(e => e.from !== id && e.to !== id) });
/** Connects two steps. A link that already exists (either way round counts as separate), a link to itself, or one to an unknown step is ignored. */
export function connect(c: Flowchart, from: string, to: string): Flowchart {
  const ids = new Set(c.nodes.map(n => n.id));
  if (from === to || !ids.has(from) || !ids.has(to) || c.edges.length >= MAX_EDGES || c.edges.some(e => e.from === from && e.to === to)) return c;
  return { ...c, edges: [...c.edges, { from, to, label: "" }] };
}
export const removeEdge = (c: Flowchart, from: string, to: string): Flowchart => ({ ...c, edges: c.edges.filter(e => !(e.from === from && e.to === to)) });
export const labelEdge = (c: Flowchart, from: string, to: string, label: string): Flowchart => ({ ...c, edges: c.edges.map(e => (e.from === from && e.to === to ? { ...e, label: tidy(label, MAX_LABEL) } : e)) });

/** Where the line from `node`'s centre toward (tx, ty) leaves the node's outline, so arrows end at the edge of a box, not its middle. */
export function boundaryPoint(node: FNode, tx: number, ty: number): { x: number; y: number } {
  const w = NODE_W / 2, h = nodeHeight(node.shape) / 2;
  const dx = tx - node.x, dy = ty - node.y;
  if (dx === 0 && dy === 0) return { x: node.x, y: node.y };
  const t = node.shape === "decision" ? 1 / (Math.abs(dx) / w + Math.abs(dy) / h) : 1 / Math.max(Math.abs(dx) / w, Math.abs(dy) / h);
  return { x: node.x + dx * t, y: node.y + dy * t };
}

/** A tidy top-to-bottom layout: each step sits one row below its deepest predecessor; loops are cut so they cannot hang the layout. */
export function tidyLayout(c: Flowchart): Flowchart {
  const incoming = new Map<string, string[]>(c.nodes.map(n => [n.id, []]));
  for (const e of c.edges) incoming.get(e.to)?.push(e.from);
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of incoming.get(id) ?? []) d = Math.max(d, depth(p) + 1);
    visiting.delete(id);
    level.set(id, d);
    return d;
  };
  for (const n of c.nodes) depth(n.id);
  const rows = new Map<number, FNode[]>();
  for (const n of c.nodes) { const l = level.get(n.id) ?? 0; rows.set(l, [...(rows.get(l) ?? []), n]); }
  const placed = new Map<string, { x: number; y: number }>();
  for (const [l, row] of rows) row.forEach((n, i) => placed.set(n.id, { x: Math.round((i - (row.length - 1) / 2) * (NODE_W + 40)), y: l * 100 }));
  return { ...c, nodes: c.nodes.map(n => ({ ...n, ...(placed.get(n.id) ?? {}) })) };
}

/** The view box that fits every step with some room around it. */
export function chartBounds(c: Flowchart, pad = 30): { x: number; y: number; w: number; h: number } {
  if (!c.nodes.length) return { x: -NODE_W, y: -50, w: NODE_W * 2, h: 100 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of c.nodes) { x0 = Math.min(x0, n.x - NODE_W / 2); x1 = Math.max(x1, n.x + NODE_W / 2); y0 = Math.min(y0, n.y - nodeHeight(n.shape) / 2); y1 = Math.max(y1, n.y + nodeHeight(n.shape) / 2); }
  return { x: x0 - pad, y: y0 - pad, w: Math.max(x1 - x0 + 2 * pad, 200), h: y1 - y0 + 2 * pad };
}

/** Searchable text for the note's plain-text index. */
export const flowchartText = (raw: unknown) => parseFlowchart(raw).nodes.map(n => n.text).filter(Boolean).join(" → ");

/** The part of the canvas that is on screen while editing: a rectangle in chart coordinates. */
export type Cam = { x: number; y: number; w: number; h: number };
export const MIN_CAM_W = 80, MAX_CAM_W = 60000;
export const camOf = (b: { x: number; y: number; w: number; h: number }): Cam => ({ x: b.x, y: b.y, w: b.w, h: b.h });
/** Zoom by `factor` (above 1 zooms in) around the point (fx, fy), given as fractions of the view (0 to 1) so that point stays under the pointer. */
export function zoomCam(c: Cam, factor: number, fx = 0.5, fy = 0.5): Cam {
  const w = Math.min(MAX_CAM_W, Math.max(MIN_CAM_W, c.w / factor)), scale = w / c.w, h = c.h * scale;
  return { x: c.x + fx * (c.w - w), y: c.y + fy * (c.h - h), w, h };
}
/** Move the view by (dx, dy) in chart units. Dragging the picture right means the camera moves left, so pass the negative of the drag. */
export const panCam = (c: Cam, dx: number, dy: number): Cam => ({ ...c, x: c.x + dx, y: c.y + dy });
/** Chart coordinates of a point inside an element of `width` x `height` pixels showing `cam` (the picture is centred and keeps its proportions). */
export function camPoint(cam: Cam, width: number, height: number, px: number, py: number): { x: number; y: number } {
  if (!width || !height) return { x: cam.x, y: cam.y };
  const scale = Math.min(width / cam.w, height / cam.h);
  const ox = (width - cam.w * scale) / 2, oy = (height - cam.h * scale) / 2;
  return { x: cam.x + (px - ox) / scale, y: cam.y + (py - oy) / scale };
}
export const camScale = (cam: Cam, width: number, height: number) => (width && height ? Math.min(width / cam.w, height / cam.h) : 1);

export type Pt = { x: number; y: number };
/**
 * The path an arrow takes between two boxes. "straight" is a line between their outlines. "stepped" uses right angles and always leaves and enters a box
 * at the middle of one of its sides:
 *  - boxes apart both sideways and up/down: out of the side facing the target, along, then straight down (or up) into the target;
 *  - side by side: out of the side, to the halfway point, up or down, then into the target's side;
 *  - above or below each other: out of the bottom (or top), to the halfway point, across, then into the target;
 *  - overlapping: a plain straight line.
 * Lines that are almost aligned collapse into one straight segment, so no tiny jogs.
 */
export function routeEdge(a: FNode, b: FNode, route: Route = "stepped"): Pt[] {
  if (route === "straight") return [boundaryPoint(a, b.x, b.y), boundaryPoint(b, a.x, a.y)];
  const ha = nodeHeight(a.shape) / 2, hb = nodeHeight(b.shape) / 2, w = NODE_W / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const apartX = Math.abs(dx) > 2 * w, apartY = Math.abs(dy) > ha + hb;
  const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
  const near = 3;
  let pts: Pt[];
  if (apartX && apartY) {
    pts = [{ x: a.x + sx * w, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y - sy * hb }];
  } else if (apartX) {
    const mid = (a.x + sx * w + b.x - sx * w) / 2;
    pts = [{ x: a.x + sx * w, y: a.y }, { x: mid, y: a.y }, { x: mid, y: b.y }, { x: b.x - sx * w, y: b.y }];
  } else if (apartY) {
    const mid = (a.y + sy * ha + b.y - sy * hb) / 2;
    pts = [{ x: a.x, y: a.y + sy * ha }, { x: a.x, y: mid }, { x: b.x, y: mid }, { x: b.x, y: b.y - sy * hb }];
  } else return [boundaryPoint(a, b.x, b.y), boundaryPoint(b, a.x, a.y)];
  // nearly aligned: one straight segment between the two side midpoints
  if (pts.length === 4 && apartX && Math.abs(dy) < near) return [pts[0], pts[3]];
  if (pts.length === 4 && !apartX && Math.abs(dx) < near) return [pts[0], pts[3]];
  return pts;
}

/** A path through the points with rounded corners of at most `radius` (never more than half of a segment). */
export function roundedPath(pts: Pt[], radius = 10): string {
  if (pts.length < 2) return "";
  const f = (n: number) => Math.round(n * 100) / 100;
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) { d += ` L${f(c.x)} ${f(c.y)}`; continue; }
    const a = { x: c.x - (c.x - p.x) / l1 * r, y: c.y - (c.y - p.y) / l1 * r }, b = { x: c.x + (n.x - c.x) / l2 * r, y: c.y + (n.y - c.y) / l2 * r };
    d += ` L${f(a.x)} ${f(a.y)} Q${f(c.x)} ${f(c.y)} ${f(b.x)} ${f(b.y)}`;
  }
  const end = pts[pts.length - 1];
  return d + ` L${f(end.x)} ${f(end.y)}`;
}

/** The point halfway along a path, for the label. */
export function pathMidpoint(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (left <= len && len > 0) { const t = left / len; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; }
    left -= len;
  }
  return pts[0] ?? { x: 0, y: 0 };
}
