import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { layoutGraph, MAX_GRAPH_NODES, pageDepths, dotRadius } from "./graphLayout";
import { wheelAction, zoomAround } from "./graphGestures";
import type { PageInfo } from "./EditorContext";

type Edge = { source: string; target: string };
const W = 1000, H = 700;
const short = (s: string) => (s.length > 26 ? s.slice(0, 25) + "…" : s);

/**
 * A map of the workspace: every page is a dot, a solid line is a link written in a note, a faint line is "this page lives under that one".
 * Click a page to open it. The picture is built from the same link index as "Linked from", so it is only ever a view of the notes.
 */
export default function GraphView({ pages, onOpen, disabled }: { pages: PageInfo[]; onOpen: (id: string) => void; disabled?: boolean }) {
  const [edges, setEdges] = useState<Edge[] | null>(null);
  const [error, setError] = useState("");
  const [hierarchy, setHierarchy] = useState(true);
  const [loose, setLoose] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<Edge[]>("list_link_edges").then(list => { if (!cancelled) setEdges(Array.isArray(list) ? list : []); }).catch(e => { if (!cancelled) { setError(String(e)); setEdges([]); } });
    return () => { cancelled = true; };
  }, []);

  const ids = useMemo(() => new Set(pages.map(p => p.id)), [pages]);
  const links = useMemo(() => (edges ?? []).filter(e => ids.has(e.source) && ids.has(e.target)), [edges, ids]);
  const tree = useMemo(() => pages.filter(p => p.parent_id && ids.has(p.parent_id)).map(p => ({ source: p.parent_id as string, target: p.id })), [pages, ids]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of [...links, ...(hierarchy ? tree : [])]) { d.set(e.source, (d.get(e.source) ?? 0) + 1); d.set(e.target, (d.get(e.target) ?? 0) + 1); }
    return d;
  }, [links, tree, hierarchy]);
  const shown = useMemo(() => pages.filter(p => loose || (degree.get(p.id) ?? 0) > 0), [pages, loose, degree]);
  const tooMany = shown.length > MAX_GRAPH_NODES;
  const layoutEdges = useMemo(() => [...links, ...(hierarchy ? tree : [])], [links, tree, hierarchy]);
  const pos = useMemo(() => (tooMany ? new Map<string, { x: number; y: number }>() : layoutGraph(shown, layoutEdges, W, H)), [shown, layoutEdges, tooMany]);
  const depths = useMemo(() => pageDepths(pages), [pages]);
  const titles = useMemo(() => new Map(pages.map(p => [p.id, p.title])), [pages]);
  const near = useMemo(() => {
    const s = new Set<string>();
    if (hover) { s.add(hover); for (const e of layoutEdges) { if (e.source === hover) s.add(e.target); if (e.target === hover) s.add(e.source); } }
    return s;
  }, [hover, layoutEdges]);
  const labelAll = shown.length <= 60;

  const zoom = (factor: number, cx = W / 2, cy = H / 2) => setView(v => zoomAround(v, factor, cx, cy));
  // Native (non-passive) listener: a trackpad pinch arrives as Ctrl + wheel, which would otherwise zoom the whole app window.
  const drawn = !!pages.length && !tooMany;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const a = wheelAction(e);
      if (a.type === "zoom") setView(v => zoomAround(v, a.factor, (e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H));
      else setView(v => ({ ...v, x: v.x + a.dx / r.width * W, y: v.y + a.dy / r.height * H }));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [drawn]);
  const line = (e: Edge, dashed: boolean) => {
    const a = pos.get(e.source), b = pos.get(e.target);
    if (!a || !b) return null;
    const lit = hover !== null && (e.source === hover || e.target === hover);
    return <line key={(dashed ? "t" : "l") + e.source + ">" + e.target} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={"graph-edge" + (dashed ? " tree" : "") + (lit ? " lit" : "") + (hover !== null && !lit ? " dim" : "")} />;
  };

  return <div className="document graph-screen">
    <h1>Graph</h1>
    <p className="hint">Each dot is a page; main pages are the biggest dots and each level of subpage gets smaller. A solid line is a link you wrote in a note; a faint line shows which page it sits under. Click a page to open it. Pinch or use Ctrl and the wheel to zoom, scroll with two fingers or drag the background to move around.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="graph-tools">
      <label><input type="checkbox" checked={hierarchy} onChange={e => setHierarchy(e.target.checked)} /> Show page hierarchy</label>
      <label><input type="checkbox" checked={loose} onChange={e => setLoose(e.target.checked)} /> Show pages with no lines</label>
      <span className="graph-zoom"><button aria-label="Zoom in" onClick={() => zoom(1.25)}>+</button><button aria-label="Zoom out" onClick={() => zoom(0.8)}>−</button><button onClick={() => setView({ k: 1, x: 0, y: 0 })}>Reset</button></span>
      <span className="hint" role="status">{edges === null ? "Loading…" : `${shown.length} page${shown.length === 1 ? "" : "s"}, ${links.length} link${links.length === 1 ? "" : "s"}`}</span>
    </div>
    {!pages.length ? <p>No pages yet.</p> : tooMany ? <p role="status">This workspace has more than {MAX_GRAPH_NODES} pages, which is too many to draw at once. Turn off “Show pages with no lines” or “Show page hierarchy” to narrow it down.</p> : <>
      {edges !== null && !links.length && <p className="hint">No links between pages yet. Type @ in a note to link to another page and the link will appear here.</p>}
      <svg ref={svgRef} className="graph-svg" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Page graph"
        onPointerDown={e => { if ((e.target as Element).closest(".graph-node")) return; drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; e.currentTarget.setPointerCapture?.(e.pointerId); }}
        onPointerMove={e => { const d = drag.current; if (!d) return; const r = e.currentTarget.getBoundingClientRect(); setView(v => ({ ...v, x: d.vx + (e.clientX - d.x) / r.width * W, y: d.vy + (e.clientY - d.y) / r.height * H })); }}
        onPointerUp={() => { drag.current = null; }}>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {hierarchy && tree.map(e => line(e, true))}
          {links.map(e => line(e, false))}
          {shown.map(p => {
            const at = pos.get(p.id); if (!at) return null;
            const d = degree.get(p.id) ?? 0, depth = depths.get(p.id) ?? 0, r = dotRadius(depth);
            const dim = hover !== null && !near.has(p.id);
            const label = labelAll || d >= 3 || near.has(p.id);
            return <g key={p.id} className={"graph-node" + (depth === 0 ? " main" : "") + (dim ? " dim" : "") + (hover === p.id ? " lit" : "") + (disabled ? " disabled" : "")} transform={`translate(${at.x} ${at.y})`} role="button" tabIndex={disabled ? -1 : 0} aria-label={"Open " + p.title} aria-disabled={disabled || undefined}
              onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.id)} onBlur={() => setHover(null)}
              onClick={() => { if (!disabled) onOpen(p.id); }} onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && !disabled) { e.preventDefault(); onOpen(p.id); } }}>
              <circle r={r} /><title>{titles.get(p.id)}</title>
              {label && <text y={-r - 5} textAnchor="middle">{short(p.title || "Untitled")}</text>}
            </g>;
          })}
        </g>
      </svg></>}
  </div>;
}
