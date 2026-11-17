/** Flowchart data and the pure operations on it. The block stores this as JSON in one prop; everything read back is re-validated. */
export type Shape = "step" | "decision" | "terminal";
export type FNode = { id: string; text: string; x: number; y: number; shape: Shape };
export type FEdge = { from: string; to: string; label: string };
export type Flowchart = { nodes: FNode[]; edges: FEdge[] };

export const MAX_NODES = 100, MAX_EDGES = 300, MAX_TEXT = 100, MAX_LABEL = 40, COORD = 5000;
export const NODE_W = 140;
export const nodeHeight = (shape: Shape) => (shape === "decision" ? 64 : 44);
export const SHAPES: Shape[] = ["step", "decision", "terminal"];
export const SHAPE_NAMES: Record<Shape, string> = { step: "Step", decision: "Decision", terminal: "Start / end" };

const clamp = (n: number) => Math.max(-COORD, Math.min(COORD, Math.round(n)));
const tidy = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const goodId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-zA-Z_-]{1,24}$/.test(s);

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
    nodes.push({ id: o.id, text: tidy(o.text, MAX_TEXT), x: clamp(Number(o.x) || 0), y: clamp(Number(o.y) || 0), shape: SHAPES.includes(o.shape as Shape) ? (o.shape as Shape) : "step" });
  }
  const edges: FEdge[] = [], pairs = new Set<string>();
  for (const e of Array.isArray(d.edges) ? d.edges : []) {
    if (edges.length >= MAX_EDGES || !e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (!goodId(o.from) || !goodId(o.to) || o.from === o.to || !seen.has(o.from) || !seen.has(o.to)) continue;
    const key = o.from + ">" + o.to;
    if (pairs.has(key)) continue;
    pairs.add(key);
    edges.push({ from: o.from, to: o.to, label: tidy(o.label, MAX_LABEL) });
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
