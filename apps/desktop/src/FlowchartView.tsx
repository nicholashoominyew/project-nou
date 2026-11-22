import { useEffect, useId, useMemo, useRef, useState } from "react";
import { addNode, boundaryPoint, nodeAt, pathMidpoint, reconnectEdge, roundedPath, routeEdge, camOf, camPoint, camScale, chartBounds, connect, editNode, labelEdge, moveNode, nodeHeight, panCam, parseFlowchart, removeEdge, removeNode, serializeFlowchart, styleEdge, styleNode, tidyLayout, zoomCam, NODE_W, SHAPES, SHAPE_NAMES, type Cam, type EdgeLook, type Route, type FEdge, type Flowchart, type FNode, type NodeLook, type Shape } from "./flowchart";
import { BOX_COLORS, LINE_NAMES, LINE_TYPES, dashFor, toneFill, toneStroke, boxColor, lineType, type BoxColor, type LineType } from "./blockOps";
import { wheelAction } from "./graphGestures";

export type FlowMode = "edit" | "view";
type Selection = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string } | null;
type Tool = "select" | "box" | "connect";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const label = (text: string) => (text.length > 22 ? text.slice(0, 21) + "…" : text || "(empty)");
const DEFAULT_BOX: { shape: Shape } & NodeLook = { shape: "step" };
const DEFAULT_EDGE: EdgeLook = {};
const DRAG_START = 4; // pixels the pointer must travel before a press on a box in Connect becomes a drag

function outline(n: FNode, extra: object = {}, className?: string) {
  const w = NODE_W / 2, h = nodeHeight(n.shape) / 2;
  if (n.shape === "decision") return <polygon className={className} points={`0,${-h} ${w},0 0,${h} ${-w},0`} {...extra} />;
  return <rect className={className} x={-w} y={-h} width={NODE_W} height={h * 2} rx={n.shape === "terminal" ? h : 8} {...extra} />;
}
/** Inline look of a box. Left unset, the stylesheet's normal look applies (and follows light and dark mode). */
function nodeStyle(n: FNode): React.CSSProperties {
  const style: React.CSSProperties = {};
  const stroke = toneStroke(n.border), fill = toneFill(n.fill);
  if (stroke) style.stroke = stroke;
  if (fill) style.fill = fill;
  if (n.line === "none") style.stroke = "none";
  else if (n.line) { style.strokeDasharray = dashFor(n.line); style.strokeLinecap = "round"; }
  return style;
}

// ---- small line icons (16px, current colour) ----
const Ico = ({ children }: { children: React.ReactNode }) => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const ICON = {
  box: <Ico><rect x="2.5" y="4" width="11" height="8" rx="2" /></Ico>,
  connect: <Ico><rect x="1.5" y="2.5" width="4.5" height="4" rx="1" /><rect x="10" y="9.5" width="4.5" height="4" rx="1" /><path d="M6 4.5h2.5a1.5 1.5 0 0 1 1.5 1.5v3.5" /><path d="M8.5 8L10 9.5 11.5 8" /></Ico>,
  tidy: <Ico><path d="M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7" /></Ico>,
  trash: <Ico><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8h6l.5-8" /></Ico>,
  step: <Ico><rect x="2" y="4.5" width="12" height="7" rx="1.5" /></Ico>,
  decision: <Ico><path d="M8 2.5L14 8 8 13.5 2 8z" /></Ico>,
  terminal: <Ico><rect x="1.5" y="5" width="13" height="6" rx="3" /></Ico>,
  solid: <Ico><path d="M2 8h12" /></Ico>,
  dashed: <Ico><path d="M2 8h3M6.5 8h3M11 8h3" /></Ico>,
  dotted: <Ico><path d="M2.5 8h.01M5.5 8h.01M8.5 8h.01M11.5 8h.01" strokeWidth="2.2" /></Ico>,
  none: <Ico><path d="M2.5 13.5l11-11" /><rect x="3" y="4" width="10" height="8" rx="1.5" strokeDasharray="1 2.5" /></Ico>,
  stepped: <Ico><path d="M2 12.5h4v-9h8" /></Ico>,
  straight: <Ico><path d="M2.5 12.5l11-9" /></Ico>,
  arrow: <Ico><path d="M2 8h11M9.5 4.5L13 8l-3.5 3.5" /></Ico>,
};

/** A small round colour button that opens the palette. */
function Palette({ name, value, open, onOpen, onPick }: { name: string; value: BoxColor | undefined; open: boolean; onOpen: (o: boolean) => void; onPick: (c: BoxColor) => void }) {
  const cur = boxColor(value);
  return <span className="fc-colour">
    <button type="button" className={"fc-dot" + (cur === "default" ? " plain" : "")} style={cur === "default" ? undefined : { background: toneStroke(cur) }} aria-label={name} aria-haspopup="true" aria-expanded={open} title={name} onClick={() => onOpen(!open)} />
    {open && <span className="fc-palette" role="group" aria-label={name + " choices"}>
      {BOX_COLORS.map(c => <button key={c} type="button" className={"fc-swatch" + (c === "default" ? " plain" : "")} style={c === "default" ? undefined : { background: toneStroke(c) }}
        aria-label={`${name}: ${capital(c)}`} aria-pressed={cur === c} title={capital(c)} onClick={() => { onPick(c); onOpen(false); }} />)}
    </span>}
  </span>;
}
function Choice<T extends string>({ name, value, options, onPick }: { name: string; value: T; options: { id: T; text: string; icon: React.ReactNode }[]; onPick: (v: T) => void }) {
  return <span className="fc-group" role="group" aria-label={name}>
    {options.map(o => <button key={o.id} type="button" className="fc-btn" aria-pressed={value === o.id} aria-label={`${name}: ${o.text}`} title={o.text} onClick={() => onPick(o.id)}>{o.icon}</button>)}
  </span>;
}

/**
 * A flowchart. In **edit** mode: drag a box to move it; Box adds one (or double-click the canvas); Connect joins two boxes by dragging from one to
 * the other (or clicking them in turn); drag the end of a selected arrow onto another box to re-route it; double-click a box or an arrow to edit its
 * text on the canvas; click anything to select it, then change its look in the small bar. Tidy up lays everything out and fits it to the frame.
 * In **view** mode there is nothing but the chart. Everything is plain SVG, so nothing is loaded from the web and text can never run as markup.
 */
export default function FlowchartView({ data, editable, mode = "edit", onChange }: { data: string; editable: boolean; mode?: FlowMode; onChange: (json: string) => void }) {
  const editing = editable && mode === "edit";
  const chart = useMemo(() => parseFlowchart(data), [data]);
  const [live, setLive] = useState<{ id: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [pending, setPending] = useState<string | null>(null); // the first box of a click-to-connect
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null);
  const [endDrag, setEndDrag] = useState<{ from: string; to: string; end: "from" | "to"; x: number; y: number } | null>(null);
  const [ed, setEd] = useState<{ sel: NonNullable<Selection>; draft: string } | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const [boxDefaults, setBoxDefaults] = useState(DEFAULT_BOX);
  const [edgeDefaults, setEdgeDefaults] = useState(DEFAULT_EDGE);
  const marker = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const pre = useRef<{ from: string; x: number; y: number } | null>(null);
  const editDone = useRef(false);
  const [cam, setCam] = useState<Cam | null>(null);
  const panning = useRef<{ x: number; y: number; cam: Cam } | null>(null);

  // Leaving edit mode drops every edit-only state, so a chart in view mode is just the chart.
  useEffect(() => { if (!editing) { setSelected(null); setTool("select"); setPending(null); setLink(null); setEndDrag(null); setEd(null); setPalette(null); setCam(null); drag.current = null; panning.current = null; pre.current = null; setLive(null); } }, [editing]);

  const shown: Flowchart = live ? moveNode(chart, live.id, live.x, live.y) : chart;
  const fit = chartBounds(shown);
  const box: Cam = editing && cam ? cam : camOf(fit);
  const byId = new Map(shown.nodes.map(n => [n.id, n]));
  const commit = (next: Flowchart) => onChange(serializeFlowchart(next));
  const node = selected?.kind === "node" ? byId.get(selected.id) : undefined;
  const edge = selected?.kind === "edge" ? shown.edges.find(e => e.from === selected.from && e.to === selected.to) : undefined;

  function toChart(clientX: number, clientY: number) {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return camPoint(box, r.width, r.height, clientX - r.left, clientY - r.top);
  }
  // Non-passive wheel listener (a trackpad pinch arrives as Ctrl + wheel and would otherwise zoom the whole window).
  const boxRef = useRef(box); boxRef.current = box;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !editing) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const a = wheelAction(e), cur = boxRef.current;
      if (a.type === "zoom") setCam(zoomCam(cur, a.factor, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
      else { const k = camScale(cur, r.width, r.height); setCam(panCam(cur, -a.dx / k, -a.dy / k)); }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [editing, chart.nodes.length === 0]);

  // ---- editing text on the canvas ----
  function startEdit(sel: NonNullable<Selection>, text: string) { if (!editing) return; editDone.current = false; setEd({ sel, draft: text }); }
  function finishEdit(save: boolean) {
    if (editDone.current) return;
    editDone.current = true;
    if (ed && save) commit(ed.sel.kind === "node" ? editNode(chart, ed.sel.id, { text: ed.draft }) : labelEdge(chart, ed.sel.from, ed.sel.to, ed.draft));
    setEd(null);
  }
  function newBox(x?: number, y?: number) {
    const out = addNode(chart, "New box", boxDefaults.shape);
    if (!out.id) return;
    let next = out.chart;
    if (x !== undefined && y !== undefined) next = moveNode(next, out.id, x, y);
    const { shape: _shape, ...look } = boxDefaults;
    next = styleNode(next, out.id, look);
    commit(next); setSelected({ kind: "node", id: out.id }); startEdit({ kind: "node", id: out.id }, "New box");
  }
  function removeSelected() {
    if (!selected || !editing) return;
    commit(selected.kind === "node" ? removeNode(chart, selected.id) : removeEdge(chart, selected.from, selected.to));
    setSelected(null);
  }
  function joined(from: string, to: string) {
    const next = styleEdge(connect(chart, from, to), from, to, edgeDefaults);
    commit(next); setSelected({ kind: "edge", from, to });
  }
  // What you choose for a selected box or arrow is also what the next new one uses.
  const boxLook: NodeLook & { shape: Shape } = { ...boxDefaults, ...(node ? { shape: node.shape, border: node.border, line: node.line, fill: node.fill } : {}) };
  const edgeLook: EdgeLook = { ...edgeDefaults, ...(edge ? { color: edge.color, line: edge.line, fill: edge.fill, arrow: edge.arrow, route: edge.route } : {}) };
  function setBox(patch: Partial<NodeLook & { shape: Shape }>) {
    setBoxDefaults(d => ({ ...d, ...patch }));
    if (node) { const { shape, ...look } = patch; let next = chart; if (shape) next = editNode(next, node.id, { shape }); if (Object.keys(look).length) next = styleNode(next, node.id, look); commit(next); }
  }
  function setEdge(patch: EdgeLook) {
    setEdgeDefaults(d => ({ ...d, ...patch }));
    if (edge) commit(styleEdge(chart, edge.from, edge.to, patch));
  }
  const heads = new Set<string>(["default"]);
  for (const e of shown.edges) heads.add(e.fill ?? e.color ?? "default");
  const pick = (t: Tool) => { setTool(cur => (cur === t ? "select" : t)); setPending(null); setLink(null); };

  function finishPointer(clientX: number, clientY: number) {
    panning.current = null;
    const d = drag.current; drag.current = null;
    if (d?.moved && live) commit(moveNode(chart, live.id, live.x, live.y));
    setLive(null);
    const p = toChart(clientX, clientY);
    if (link) { const target = nodeAt(chart, p.x, p.y); if (target && target.id !== link.from) joined(link.from, target.id); setLink(null); }
    pre.current = null;
    if (endDrag) {
      const target = nodeAt(chart, p.x, p.y);
      const nf = endDrag.end === "from" && target ? target.id : endDrag.from, nt = endDrag.end === "to" && target ? target.id : endDrag.to;
      const next = reconnectEdge(chart, endDrag.from, endDrag.to, nf, nt);
      if (next !== chart) { commit(next); setSelected({ kind: "edge", from: nf, to: nt }); }
      setEndDrag(null);
    }
  }

  return <div className={"flowchart" + (editing ? " fc-editing" : " view")} contentEditable={false}
    onKeyDown={e => { if (editing && e.key === "Escape" && !ed) { if (palette) setPalette(null); else if (tool !== "select" || pending || selected) { setTool("select"); setPending(null); setSelected(null); } } }}>
    {editing && <div className="fc-tools" role="toolbar" aria-label="Flowchart tools">
      <button type="button" className="fc-btn" aria-label="Box" title="Add a box (or double-click the canvas)" aria-pressed={tool === "box"} onClick={() => pick("box")}>{ICON.box}</button>
      <button type="button" className="fc-btn" aria-label="Connect" title="Connect boxes: drag from one to another" aria-pressed={tool === "connect"} disabled={chart.nodes.length < 2} onClick={() => pick("connect")}>{ICON.connect}</button>
      <button type="button" className="fc-btn" aria-label="Tidy up" title="Tidy up and fit" disabled={!chart.nodes.length} onClick={() => { commit(tidyLayout(chart)); setCam(null); }}>{ICON.tidy}</button>
    </div>}
    {editing && (node || edge) && <div className="fc-inspector" role="toolbar" aria-label={node ? "Box settings" : "Connection settings"}>
      {node && <>
        <Choice name="Shape" value={boxLook.shape} options={SHAPES.map(s => ({ id: s, text: SHAPE_NAMES[s], icon: ICON[s] }))} onPick={s => setBox({ shape: s })} />
        <Choice name="Line" value={lineType(boxLook.line)} options={LINE_TYPES.map(l => ({ id: l, text: LINE_NAMES[l], icon: ICON[l] }))} onPick={l => setBox({ line: l as LineType })} />
        <Palette name="Line colour" value={boxLook.border} open={palette === "line"} onOpen={o => setPalette(o ? "line" : null)} onPick={c => setBox({ border: c })} />
        <Palette name="Fill colour" value={boxLook.fill} open={palette === "fill"} onOpen={o => setPalette(o ? "fill" : null)} onPick={c => setBox({ fill: c })} />
        <button type="button" className="fc-btn danger" aria-label="Delete box" title="Delete box (Delete key)" onClick={removeSelected}>{ICON.trash}</button>
      </>}
      {edge && <>
        <Choice name="Line" value={(edgeLook.line ?? "solid") as "solid" | "dashed" | "dotted"} options={(["solid", "dashed", "dotted"] as const).map(l => ({ id: l, text: LINE_NAMES[l], icon: ICON[l] }))} onPick={l => setEdge({ line: l })} />
        <Choice name="Route" value={(edgeLook.route ?? "stepped") as Route} options={[{ id: "stepped" as Route, text: "Stepped", icon: ICON.stepped }, { id: "straight" as Route, text: "Straight", icon: ICON.straight }]} onPick={r => setEdge({ route: r })} />
        <button type="button" className="fc-btn" aria-label="Arrowhead" title="Arrowhead" aria-pressed={edgeLook.arrow !== false} onClick={() => setEdge({ arrow: edgeLook.arrow === false })}>{ICON.arrow}</button>
        <Palette name="Line colour" value={edgeLook.color} open={palette === "eline"} onOpen={o => setPalette(o ? "eline" : null)} onPick={c => setEdge({ color: c })} />
        <Palette name="Arrowhead colour" value={edgeLook.fill} open={palette === "efill"} onOpen={o => setPalette(o ? "efill" : null)} onPick={c => setEdge({ fill: c })} />
        <button type="button" className="fc-btn danger" aria-label="Delete connection" title="Delete connection (Delete key)" onClick={removeSelected}>{ICON.trash}</button>
      </>}
    </div>}
    {editing && tool === "connect" && <p className="fc-hint" role="status">{pending === null ? "Drag from one box to another, or click two boxes." : "Now click the second box."}</p>}
    {editing && tool === "box" && <p className="fc-hint" role="status">Click the canvas to place a box.</p>}
    <svg ref={svgRef} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="group" aria-label="Flowchart" className={"flowchart-svg" + (editing ? " editing" : "") + (editing && tool === "box" ? " placing" : "")} style={editing ? { height: 440 } : { minHeight: Math.min(520, Math.max(120, box.h)) }}
      onPointerDown={e => {
        if (!editing || e.target !== e.currentTarget || tool !== "select") return;
        setPalette(null);
        panning.current = { x: e.clientX, y: e.clientY, cam: box };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={e => {
        const pan = panning.current;
        if (pan) { const r = e.currentTarget.getBoundingClientRect(), k = camScale(pan.cam, r.width, r.height); setCam(panCam(pan.cam, -(e.clientX - pan.x) / k, -(e.clientY - pan.y) / k)); return; }
        const p = toChart(e.clientX, e.clientY);
        if (endDrag) { setEndDrag({ ...endDrag, x: p.x, y: p.y }); return; }
        if (link) { setLink({ ...link, x: p.x, y: p.y }); return; }
        const s = pre.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > DRAG_START) { setLink({ from: s.from, x: p.x, y: p.y }); return; }
        const d = drag.current; if (!d) return; d.moved = true; setLive({ id: d.id, x: p.x - d.dx, y: p.y - d.dy });
      }}
      onPointerUp={e => finishPointer(e.clientX, e.clientY)}
      onPointerLeave={() => { if (panning.current) panning.current = null; if (drag.current) { drag.current = null; setLive(null); } if (link) setLink(null); if (endDrag) setEndDrag(null); pre.current = null; }}
      onClick={e => {
        if (!editing || e.target !== e.currentTarget) return;
        setPalette(null);
        if (tool === "box") { if (!cam) setCam(box); const p = toChart(e.clientX, e.clientY); newBox(p.x, p.y); setTool("select"); return; }
        setSelected(null); setPending(null);
      }}
      onDoubleClick={e => { if (!editing || e.target !== e.currentTarget || tool === "connect") return; if (!cam) setCam(box); const p = toChart(e.clientX, e.clientY); newBox(p.x, p.y); setTool("select"); }}>
      <defs>{[...heads].map(h => <marker key={h} id={`${marker}-${h}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="flowchart-arrowhead" style={toneStroke(h as BoxColor) ? { fill: toneStroke(h as BoxColor) } : undefined} /></marker>)}</defs>
      {shown.edges.map((e: FEdge) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) return null;
        const pts = routeEdge(a, b, e.route), d = roundedPath(pts), mid = pathMidpoint(pts);
        const on = editing && selected?.kind === "edge" && selected.from === e.from && selected.to === e.to;
        const stroke = toneStroke(e.color), dash = dashFor(e.line);
        const lineStyle: React.CSSProperties = { ...(stroke ? { stroke } : {}), ...(dash ? { strokeDasharray: dash, strokeLinecap: "round" } : {}) };
        const head = e.arrow === false ? undefined : `url(#${marker}-${e.fill ?? e.color ?? "default"})`;
        const select = () => setSelected({ kind: "edge", from: e.from, to: e.to });
        const first = pts[0], lastPt = pts[pts.length - 1];
        return <g key={e.from + ">" + e.to} className={"flowchart-edge" + (on ? " selected" : "")} role={editing ? "button" : undefined} tabIndex={editing ? 0 : undefined} aria-label={`Arrow from ${a.text || "box"} to ${b.text || "box"}${e.label ? ", " + e.label : ""}`}
          onPointerDown={ev => { if (editing) { ev.stopPropagation(); setPalette(null); select(); } }}
          onClick={ev => { if (!editing) return; ev.stopPropagation(); select(); }} onDoubleClick={ev => { if (!editing) return; ev.stopPropagation(); startEdit({ kind: "edge", from: e.from, to: e.to }, e.label); }}
          onKeyDown={ev => { if (!editing) return; if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(); } else if (ev.key === "F2") startEdit({ kind: "edge", from: e.from, to: e.to }, e.label); else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); commit(removeEdge(chart, e.from, e.to)); setSelected(null); } }}>
          {on && <path d={d} className="flowchart-halo-line" />}
          <path d={d} className="flowchart-hit" />
          <path d={d} markerEnd={head} style={lineStyle} />
          {e.label && <text x={mid.x} y={mid.y - 6} textAnchor="middle">{e.label}</text>}
          {on && <>
            <circle className="fc-handle" cx={first.x} cy={first.y} r={6} role="button" aria-label="Move the start of the arrow to another box" onPointerDown={ev => { ev.stopPropagation(); (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId); setEndDrag({ from: e.from, to: e.to, end: "from", x: first.x, y: first.y }); }} />
            <circle className="fc-handle" cx={lastPt.x} cy={lastPt.y} r={6} role="button" aria-label="Move the end of the arrow to another box" onPointerDown={ev => { ev.stopPropagation(); (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId); setEndDrag({ from: e.from, to: e.to, end: "to", x: lastPt.x, y: lastPt.y }); }} />
          </>}
        </g>;
      })}
      {shown.nodes.map(n => {
        const on = editing && selected?.kind === "node" && selected.id === n.id;
        const custom = nodeStyle(n);
        const textStyle = n.shape === "terminal" && n.fill ? { fill: "var(--text)" } : undefined;
        const target = !!link && link.from !== n.id && !!nodeAt(shown, link.x, link.y) && nodeAt(shown, link.x, link.y)?.id === n.id;
        return <g key={n.id} className={"flowchart-node " + n.shape + (on ? " selected" : "") + (pending === n.id || link?.from === n.id ? " source" : "") + (target ? " target" : "")} transform={`translate(${n.x} ${n.y})`} role={editing ? "button" : undefined} tabIndex={editing ? 0 : undefined} aria-label={`${SHAPE_NAMES[n.shape]}: ${n.text || "empty"}`}
          onPointerDown={e => {
            if (!editing) return;
            e.stopPropagation(); setPalette(null);
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            if (tool === "connect") { pre.current = { from: n.id, x: e.clientX, y: e.clientY }; return; }
            setSelected({ kind: "node", id: n.id });
            if (!cam) setCam(box);
            const p = toChart(e.clientX, e.clientY); drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false };
          }}
          onClick={ev => {
            if (!editing) return; ev.stopPropagation();
            if (tool === "connect") { if (pending === null) setPending(n.id); else { if (pending !== n.id) joined(pending, n.id); setPending(null); } return; }
            setSelected({ kind: "node", id: n.id });
          }}
          onDoubleClick={ev => { if (!editing) return; ev.stopPropagation(); startEdit({ kind: "node", id: n.id }, n.text); }}
          onKeyDown={ev => {
            if (!editing) return;
            if (ev.key === "Enter") { ev.preventDefault(); if (tool === "connect") { if (pending === null) setPending(n.id); else { if (pending !== n.id) joined(pending, n.id); setPending(null); } } else setSelected({ kind: "node", id: n.id }); }
            else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); commit(removeNode(chart, n.id)); setSelected(null); }
            else if (ev.key === "F2") startEdit({ kind: "node", id: n.id }, n.text);
          }}>
          {on && outline(n, {}, "flowchart-halo")}
          {outline(n, { style: custom })}<text textAnchor="middle" dominantBaseline="central" style={textStyle}>{label(n.text)}</text><title>{n.text}</title>
        </g>;
      })}
      {link && byId.get(link.from) && (() => { const a = byId.get(link.from)!, s = boundaryPoint(a, link.x, link.y); return <path className="fc-preview" d={`M${s.x},${s.y} L${link.x},${link.y}`} />; })()}
      {endDrag && (() => { const other = byId.get(endDrag.end === "from" ? endDrag.to : endDrag.from); if (!other) return null; const s = boundaryPoint(other, endDrag.x, endDrag.y); return <path className="fc-preview" d={`M${s.x},${s.y} L${endDrag.x},${endDrag.y}`} />; })()}
      {ed && (() => {
        if (ed.sel.kind === "node") {
          const n = byId.get(ed.sel.id); if (!n) return null;
          const w = NODE_W, h = nodeHeight(n.shape);
          return <foreignObject x={n.x - w / 2} y={n.y - h / 2} width={w} height={h}>
            <input className="fc-input" aria-label="Box text" autoFocus value={ed.draft} maxLength={100} onFocus={e => e.currentTarget.select()} onChange={e => setEd({ ...ed, draft: e.target.value })} onBlur={() => finishEdit(true)}
              onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
              onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finishEdit(true); } else if (e.key === "Escape") { e.preventDefault(); finishEdit(false); } }} />
          </foreignObject>;
        }
        const s = ed.sel; const a = byId.get(s.from), b = byId.get(s.to); if (!a || !b) return null;
        const e0 = shown.edges.find(x => x.from === s.from && x.to === s.to); const mid = pathMidpoint(routeEdge(a, b, e0?.route));
        return <foreignObject x={mid.x - 60} y={mid.y - 14} width={120} height={28}>
          <input className="fc-input small" aria-label="Connection label" autoFocus value={ed.draft} maxLength={40} onFocus={e => e.currentTarget.select()} onChange={e => setEd({ ...ed, draft: e.target.value })} onBlur={() => finishEdit(true)}
            onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
            onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finishEdit(true); } else if (e.key === "Escape") { e.preventDefault(); finishEdit(false); } }} />
        </foreignObject>;
      })()}
    </svg>
    {!chart.nodes.length && <p className="hint">{editing ? "An empty flowchart. Double-click the canvas, or use the box button." : "An empty flowchart."}</p>}
  </div>;
}
