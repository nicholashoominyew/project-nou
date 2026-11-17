export type GNode = { id: string };
export type GEdge = { source: string; target: string };
export type Point = { x: number; y: number };

/** Most pages the graph lays out. Beyond this the view says so instead of freezing the app. */
export const MAX_GRAPH_NODES = 400;

/**
 * A small force-directed layout: every node pushes every other away, linked nodes pull together, and a weak pull toward the middle keeps
 * separate clusters on screen. It is deterministic (the same pages always land in the same places) so the graph does not reshuffle each visit.
 * The result is scaled to fit inside `width` x `height` with `pad` around the edge.
 */
export function layoutGraph(nodes: GNode[], edges: GEdge[], width = 1000, height = 700, pad = 60): Map<string, Point> {
  const out = new Map<string, Point>();
  const list = nodes.slice(0, MAX_GRAPH_NODES);
  const n = list.length;
  if (!n) return out;
  if (n === 1) { out.set(list[0].id, { x: width / 2, y: height / 2 }); return out; }
  const index = new Map(list.map((node, i) => [node.id, i]));
  const links: [number, number][] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a + ":" + b : b + ":" + a;
    if (!seen.has(key)) { seen.add(key); links.push([a, b]); }
  }
  // Start on a spiral: spread out, no randomness.
  const x = new Float64Array(n), y = new Float64Array(n), dx = new Float64Array(n), dy = new Float64Array(n);
  for (let i = 0; i < n; i++) { const r = 12 * Math.sqrt(i + 1), t = i * 2.399963; x[i] = r * Math.cos(t); y[i] = r * Math.sin(t); }
  const rest = 40, steps = n > 200 ? 120 : 250;
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let vx = x[i] - x[j], vy = y[i] - y[j];
      let d2 = vx * vx + vy * vy;
      if (d2 < 0.01) { vx = 0.1 * ((i + j) % 3 - 1 || 1); vy = 0.1; d2 = vx * vx + vy * vy; }
      const d = Math.sqrt(d2), f = 1800 / d2;
      dx[i] += vx / d * f; dy[i] += vy / d * f; dx[j] -= vx / d * f; dy[j] -= vy / d * f;
    }
    for (const [a, b] of links) {
      const vx = x[b] - x[a], vy = y[b] - y[a], d = Math.sqrt(vx * vx + vy * vy) || 0.01, f = 0.05 * (d - rest);
      dx[a] += vx / d * f; dy[a] += vy / d * f; dx[b] -= vx / d * f; dy[b] -= vy / d * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= 0.01 * x[i]; dy[i] -= 0.01 * y[i];
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1, cap = Math.min(len, 20 * cool + 1);
      x[i] += dx[i] / len * cap; y[i] += dy[i] / len * cap;
    }
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const scale = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const ox = (width - w * scale) / 2, oy = (height - h * scale) / 2;
  list.forEach((node, i) => out.set(node.id, { x: ox + (x[i] - minX) * scale, y: oy + (y[i] - minY) * scale }));
  return out;
}

/** How deep each page sits: 0 for a top-level page, 1 for its subpages, and so on. A page whose parent is missing counts as top level. Safe against loops. */
export function pageDepths(pages: { id: string; parent_id: string | null }[]): Map<string, number> {
  const parent = new Map(pages.map(p => [p.id, p.parent_id]));
  const out = new Map<string, number>();
  for (const p of pages) {
    let depth = 0, at: string | null = p.parent_id;
    const seen = new Set<string>([p.id]);
    while (at && parent.has(at) && !seen.has(at) && depth < 50) { seen.add(at); depth++; at = parent.get(at) ?? null; }
    out.set(p.id, depth);
  }
  return out;
}

/** Dot size by depth: main pages are the biggest and each level of subpage is smaller, down to a floor so deep pages stay clickable. */
export const dotRadius = (depth: number) => Math.max(5, 15 - 3.5 * depth);

/**
 * How a page is drawn in the graph, by how deep it sits. Main pages (top level) are solid white stars. Every subpage is a ring: a white outline with
 * no fill. The depth also sets the size, so a sub-subpage is a smaller ring than a subpage.
 */
export type StarKind = "solid" | "ring";
export const starKind = (depth: number): StarKind => (depth <= 0 ? "solid" : "ring");
export const starRadius = (depth: number) => Math.max(3.5, 8.5 - 1.7 * Math.max(0, depth));
