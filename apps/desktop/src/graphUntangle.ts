/** Removing crossings from a drawn graph: lines that cross are hard to read, so after the force layout the positions are nudged until no two lines cross. */
export type Pt = { x: number; y: number };
export type Link = [number, number];

const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Do the segments ab and cd properly cross (not just touch at an end)? */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
/** Is the point p closer than `tol` to the segment ab? */
export function nearSegment(p: Pt, a: Pt, b: Pt, tol: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < tol;
}

/** How many pairs of lines cross. Lines that share a page never count. */
export function countCrossings(pos: Pt[], links: Link[]): number {
  let n = 0;
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    const [a, b] = links[i], [c, d] = links[j];
    if (a === c || a === d || b === c || b === d) continue;
    if (segmentsCross(pos[a], pos[b], pos[c], pos[d])) n++;
  }
  return n;
}
/** How many pages sit on top of a line they do not belong to. */
export function countOnLines(pos: Pt[], links: Link[], tol = 12): number {
  let n = 0;
  for (const [a, b] of links) for (let v = 0; v < pos.length; v++) if (v !== a && v !== b && nearSegment(pos[v], pos[a], pos[b], tol)) n++;
  return n;
}

function mulberry(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const W_CROSS = 100000, W_ON = 2000, TOL = 13, APART = 34, REST = 90;

/**
 * Moves pages, never more than needed, until no line crosses another and no page sits on a line that is not its own. Each move is kept only if it
 * lowers a cost that counts crossings first, then pages on lines, then pages too close together, then lines far from a comfortable length.
 * It is deterministic. If the links form a forest and the moves did not finish the job, that part is redrawn as a radial tree, which can never cross.
 * A graph that cannot be drawn flat (for example five pages all linked to each other) keeps the fewest crossings found.
 */
export function untangle(pos: Pt[], links: Link[], bounds: { x0: number; y0: number; x1: number; y1: number }): Pt[] {
  const n = pos.length;
  if (n < 3 || links.length < 2) return pos;
  const p = pos.map(q => ({ ...q }));
  const inc: number[][] = Array.from({ length: n }, () => []);
  links.forEach(([a, b], k) => { inc[a].push(k); inc[b].push(k); });
  const share = (k: number, m: number) => links[k][0] === links[m][0] || links[k][0] === links[m][1] || links[k][1] === links[m][0] || links[k][1] === links[m][1];

  /** Everything that depends on where page i is. */
  function local(i: number): number {
    let cost = 0;
    for (const k of inc[i]) {
      const [a, b] = links[k];
      for (let m = 0; m < links.length; m++) { if (m === k || share(k, m)) continue; if (segmentsCross(p[a], p[b], p[links[m][0]], p[links[m][1]])) cost += W_CROSS; }
      for (let v = 0; v < n; v++) if (v !== a && v !== b && nearSegment(p[v], p[a], p[b], TOL)) cost += W_ON;
      const len = Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
      cost += (len - REST) * (len - REST) * 0.002;
    }
    for (let m = 0; m < links.length; m++) { const [a, b] = links[m]; if (a === i || b === i) continue; if (nearSegment(p[i], p[a], p[b], TOL)) cost += W_ON; }
    for (let j = 0; j < n; j++) if (j !== i) { const d = Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y); if (d < APART) cost += (APART - d) * (APART - d) * 4; }
    return cost;
  }
  const clampPt = (q: Pt): Pt => ({ x: Math.min(bounds.x1, Math.max(bounds.x0, q.x)), y: Math.min(bounds.y1, Math.max(bounds.y0, q.y)) });
  const bad = () => countCrossings(p, links) + countOnLines(p, links, TOL);

  const rnd = mulberry(7), K = 8;
  const rounds = Math.max(4, Math.min(60, Math.floor(40000 / (n * K))));
  for (let round = 0; round < rounds && bad() > 0; round++) {
    const reach = Math.max(25, 220 * (1 - round / rounds));
    for (let i = 0; i < n; i++) {
      let best = local(i), bx = p[i].x, by = p[i].y;
      const keep = { x: p[i].x, y: p[i].y };
      for (let t = 0; t < K; t++) {
        let c: Pt;
        const mode = t % 4;
        if (mode === 0) c = { x: keep.x + (rnd() - 0.5) * reach, y: keep.y + (rnd() - 0.5) * reach };
        else if (mode === 1) c = { x: keep.x + (rnd() - 0.5) * 3 * reach, y: keep.y + (rnd() - 0.5) * 3 * reach };
        else if (mode === 2 && inc[i].length) { const k = inc[i][Math.floor(rnd() * inc[i].length)], o = links[k][0] === i ? links[k][1] : links[k][0], a = rnd() * 6.2832; c = { x: p[o].x + Math.cos(a) * REST, y: p[o].y + Math.sin(a) * REST }; }
        else c = { x: bounds.x0 + rnd() * (bounds.x1 - bounds.x0), y: bounds.y0 + rnd() * (bounds.y1 - bounds.y0) };
        c = clampPt(c);
        p[i].x = c.x; p[i].y = c.y;
        const cost = local(i);
        if (cost < best - 1e-9) { best = cost; bx = c.x; by = c.y; }
      }
      p[i].x = bx; p[i].y = by;
    }
  }
  if (countCrossings(p, links) > 0) forestFallback(p, links, bounds);
  return p;
}

/** Redraw every tree-shaped group of pages as a radial tree (each page's subtree gets its own wedge of the circle), which cannot cross itself. */
function forestFallback(p: Pt[], links: Link[], bounds: { x0: number; y0: number; x1: number; y1: number }) {
  const n = p.length, adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of links) { adj[a].push(b); adj[b].push(a); }
  const comp = new Array<number>(n).fill(-1);
  const groups: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const g: number[] = [], stack = [s]; comp[s] = groups.length;
    while (stack.length) { const v = stack.pop()!; g.push(v); for (const w of adj[v]) if (comp[w] < 0) { comp[w] = groups.length; stack.push(w); } }
    groups.push(g);
  }
  const edgesIn = (g: number[]) => links.filter(([a]) => comp[a] === comp[g[0]]).length;
  const trees = groups.filter(g => g.length > 1 && edgesIn(g) === g.length - 1);
  const rows = Math.max(1, Math.ceil(Math.sqrt(trees.length)));
  trees.forEach((g, ti) => {
    const root = g.reduce((best, v) => (adj[v].length > adj[best].length ? v : best), g[0]);
    const kids = new Map<number, number[]>(), leaves = new Map<number, number>(), depth = new Map<number, number>([[root, 0]]);
    const order: number[] = [root], seen = new Set([root]);
    for (let i = 0; i < order.length; i++) { const v = order[i]; kids.set(v, []); for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); depth.set(w, depth.get(v)! + 1); kids.get(v)!.push(w); order.push(w); } }
    for (let i = order.length - 1; i >= 0; i--) { const v = order[i], ks = kids.get(v)!; leaves.set(v, ks.length ? ks.reduce((s, k) => s + leaves.get(k)!, 0) : 1); }
    const ring = 80, local = new Map<number, Pt>();
    const place = (v: number, a0: number, a1: number) => {
      const mid = (a0 + a1) / 2, r = depth.get(v)! * ring;
      local.set(v, { x: Math.cos(mid) * r, y: Math.sin(mid) * r });
      let at = a0;
      for (const k of kids.get(v)!) { const span = (a1 - a0) * leaves.get(k)! / leaves.get(v)!; place(k, at, at + span); at += span; }
    };
    place(root, 0, 6.2832);
    // each tree gets a cell of its own so trees do not run into each other
    const cols = Math.ceil(trees.length / rows), cw = (bounds.x1 - bounds.x0) / cols, ch = (bounds.y1 - bounds.y0) / rows;
    const cx = bounds.x0 + (ti % cols + 0.5) * cw, cy = bounds.y0 + (Math.floor(ti / cols) + 0.5) * ch;
    let ext = 1; for (const q of local.values()) ext = Math.max(ext, Math.abs(q.x), Math.abs(q.y));
    const k = Math.min(1, Math.min(cw, ch) / 2 / ext * 0.92);
    for (const [v, q] of local) { p[v].x = cx + q.x * k; p[v].y = cy + q.y * k; }
  });
}
