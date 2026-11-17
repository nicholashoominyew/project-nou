import { useEffect, useId, useMemo, useRef, useState } from "react";
import { addNode, pathMidpoint, roundedPath, routeEdge, camOf, camPoint, camScale, chartBounds, connect, editNode, labelEdge, moveNode, nodeHeight, panCam, parseFlowchart, removeEdge, removeNode, serializeFlowchart, styleEdge, styleNode, tidyLayout, zoomCam, NODE_W, SHAPES, SHAPE_NAMES, MAX_NODES, type Cam, type EdgeLook, type Route, type FEdge, type Flowchart, type FNode, type NodeLook, type Shape } from "./flowchart";
import { BOX_COLORS, LINE_NAMES, LINE_TYPES, dashFor, toneFill, toneStroke, boxColor, lineType, type BoxColor, type LineType } from "./blockOps";
import { wheelAction } from "./graphGestures";

export type FlowMode = "edit" | "view";
type Selection = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string } | null;
type Tool = "select" | "box" | "connect";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const label = (text: string) => (text.length > 22 ? text.slice(0, 21) + "…" : text || "(empty)");
const DEFAULT_BOX: { shape: Shape } & NodeLook = { shape: "step" };
const DEFAULT_EDGE: EdgeLook = {};

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

function Swatches({ name, value, onPick }: { name: string; value: BoxColor | undefined; onPick: (c: BoxColor) => void }) {
  return <span className="flowchart-swatches" role="group" aria-label={name}>
    {BOX_COLORS.map(c => <button key={c} type="button" className={"flowchart-swatch" + (c === "default" ? " plain" : "")} style={c === "default" ? undefined : { background: toneStroke(c) }}
      aria-label={`${name}: ${capital(c)}`} aria-pressed={boxColor(value) === c} title={capital(c)} onClick={() => onPick(c)} />)}
  </span>;
}

/**
 * A flowchart. In **edit** mode there are three tools: Select (move, rename and pan), Box (click the canvas to add a box) and Connect (click two
 * boxes to join them), and each box or arrow has its own line type, line colour and fill colour. In **view** mode there is nothing but the chart:
 * it is fitted to the frame and locked. Everything is plain SVG, so nothing is loaded from the web and text can never run as markup.
 */
export default function FlowchartView({ data, editable, mode = "edit", onChange }: { data: string; editable: boolean; mode?: FlowMode; onChange: (json: string) => void }) {
  const editing = editable && mode === "edit";
  const chart = useMemo(() => parseFlowchart(data), [data]);
  const [live, setLive] = useState<{ id: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [from, setFrom] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Selection>(null);
  const [draft, setDraft] = useState("");
  const [boxDefaults, setBoxDefaults] = useState(DEFAULT_BOX);
  const [edgeDefaults, setEdgeDefaults] = useState(DEFAULT_EDGE);
  const marker = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  // While editing the canvas can be moved around; `cam` is null until you do (the chart is then fitted). Viewing is always fitted and locked.
  const [cam, setCam] = useState<Cam | null>(null);
  const panning = useRef<{ x: number; y: number; cam: Cam } | null>(null);

  // Leaving edit mode drops every edit-only state, so a chart in view mode is just the chart.
  useEffect(() => { if (!editing) { setSelected(null); setTool("select"); setFrom(null); setRenaming(null); setCam(null); drag.current = null; panning.current = null; setLive(null); } }, [editing]);

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
  const zoomBy = (factor: number) => setCam(zoomCam(box, factor));

  function startRename(sel: Selection, text: string) { if (!editing) return; setRenaming(sel); setDraft(text); }
  function finishRename(save: boolean) {
    if (renaming && save) commit(renaming.kind === "node" ? editNode(chart, renaming.id, { text: draft }) : labelEdge(chart, renaming.from, renaming.to, draft));
    setRenaming(null);
  }
  function newBox(x?: number, y?: number) {
    const out = addNode(chart, "New box", boxDefaults.shape);
    if (!out.id) return;
    let next = out.chart;
    if (x !== undefined && y !== undefined) next = moveNode(next, out.id, x, y);
    const { shape: _shape, ...look } = boxDefaults;
    next = styleNode(next, out.id, look);
    commit(next); setSelected({ kind: "node", id: out.id }); startRename({ kind: "node", id: out.id }, "New box");
  }
  function clickNode(n: FNode) {
    if (!editing) return;
    if (tool === "connect") {
      if (from === null) { setFrom(n.id); return; }
      if (from !== n.id) { const joined = connect(chart, from, n.id); commit(styleEdge(joined, from, n.id, edgeDefaults)); setSelected({ kind: "edge", from, to: n.id }); }
      setFrom(null); return;
    }
    setSelected({ kind: "node", id: n.id });
  }
  function remove() {
    if (!selected || !editing) return;
    commit(selected.kind === "node" ? removeNode(chart, selected.id) : removeEdge(chart, selected.from, selected.to));
    setSelected(null);
  }
  // Changing a look applies to what is selected, and is also what the next new box or arrow will use.
  const boxLook: NodeLook & { shape: Shape } = { ...boxDefaults, ...(node ? { shape: node.shape, border: node.border, line: node.line, fill: node.fill } : {}) };
  const edgeLook: EdgeLook = { ...edgeDefaults, ...(edge ? { color: edge.color, line: edge.line, fill: edge.fill, arrow: edge.arrow } : {}) };
  function setBox(patch: Partial<NodeLook & { shape: Shape }>) {
    setBoxDefaults(d => ({ ...d, ...patch }));
    if (node) { const { shape, ...look } = patch; let next = chart; if (shape) next = editNode(next, node.id, { shape }); if (Object.keys(look).length) next = styleNode(next, node.id, look); commit(next); }
  }
  function setEdge(patch: EdgeLook) {
    setEdgeDefaults(d => ({ ...d, ...patch }));
    if (edge) commit(styleEdge(chart, edge.from, edge.to, patch));
  }

  // The panel follows the tool: Box shows box settings, Connect shows connection settings, and Select shows whatever is selected.
  const showBoxPanel = editing && (tool === "box" || (tool === "select" && !!node));
  const showEdgePanel = editing && (tool === "connect" || (tool === "select" && !!edge));
  const heads = new Set<string>(["default"]);
  for (const e of shown.edges) heads.add(e.fill ?? e.color ?? "default");

  return <div className={"flowchart" + (editing ? "" : " view")} contentEditable={false}>
    {editing && <div className="flowchart-tools" role="toolbar" aria-label="Flowchart tools">
      <span className="flowchart-tooltabs" role="group" aria-label="Tool">
        {(["select", "box", "connect"] as Tool[]).map(t => <button key={t} aria-pressed={tool === t} disabled={t === "connect" && chart.nodes.length < 2} onClick={() => { setTool(t); setFrom(null); }}>{capital(t)}</button>)}
      </span>
      <button onClick={() => commit(tidyLayout(chart))} disabled={!chart.nodes.length}>Tidy up</button>
      <span className="flowchart-zoom" role="group" aria-label="Zoom the canvas"><button aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button><button aria-label="Zoom out" onClick={() => zoomBy(0.8)}>−</button><button onClick={() => setCam(null)} disabled={!cam}>Fit</button></span>
    </div>}
    {showBoxPanel && <div className="flowchart-panel" role="group" aria-label="Box settings">
      <strong>Box</strong>
      <label>Shape <select aria-label="Shape" value={boxLook.shape} onChange={e => setBox({ shape: e.target.value as Shape })}>{SHAPES.map(s => <option key={s} value={s}>{SHAPE_NAMES[s]}</option>)}</select></label>
      <label>Line <select aria-label="Box line type" value={lineType(boxLook.line)} onChange={e => setBox({ line: e.target.value as LineType })}>{LINE_TYPES.map(l => <option key={l} value={l}>{LINE_NAMES[l]}</option>)}</select></label>
      <label>Line colour <Swatches name="Box line colour" value={boxLook.border} onPick={c => setBox({ border: c })} /></label>
      <label>Fill <Swatches name="Box fill colour" value={boxLook.fill} onPick={c => setBox({ fill: c })} /></label>
      <button onClick={() => newBox()} disabled={chart.nodes.length >= MAX_NODES}>Add box</button>
      {node && <button onClick={() => startRename({ kind: "node", id: node.id }, node.text)}>Rename</button>}
      {node && <button className="danger" onClick={remove}>Delete box</button>}
      {tool === "box" && !node && <span className="hint">Click the canvas to place a box.</span>}
    </div>}
    {showEdgePanel && <div className="flowchart-panel" role="group" aria-label="Connection settings">
      <strong>Connection</strong>
      <label>Line <select aria-label="Connection line type" value={edgeLook.line ?? "solid"} onChange={e => setEdge({ line: e.target.value as "solid" | "dashed" | "dotted" })}>{LINE_TYPES.filter(l => l !== "none").map(l => <option key={l} value={l}>{LINE_NAMES[l]}</option>)}</select></label>
      <label>Shape <select aria-label="Connection shape" value={edgeLook.route ?? "stepped"} onChange={e => setEdge({ route: e.target.value as Route })}><option value="stepped">Stepped</option><option value="straight">Straight</option></select></label>
      <label>Line colour <Swatches name="Connection line colour" value={edgeLook.color} onPick={c => setEdge({ color: c })} /></label>
      <label>Arrowhead fill <Swatches name="Connection fill colour" value={edgeLook.fill} onPick={c => setEdge({ fill: c })} /></label>
      <label><input type="checkbox" aria-label="Arrowhead" checked={edgeLook.arrow !== false} onChange={e => setEdge({ arrow: e.target.checked })} /> Arrowhead</label>
      {edge && <button onClick={() => startRename(selected, edge.label)}>Label</button>}
      {edge && <button className="danger" onClick={remove}>Delete connection</button>}
      {tool === "connect" && !edge && <span className="hint" role="status">{from === null ? "Click the first box." : "Now click the second box."}</span>}
    </div>}
    {renaming && <form className="flowchart-edit" onSubmit={e => { e.preventDefault(); finishRename(true); }}>
      <input aria-label={renaming.kind === "node" ? "Box text" : "Connection label"} autoFocus value={draft} maxLength={renaming.kind === "node" ? 100 : 40} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); finishRename(false); } }} />
      <button type="submit">Save</button><button type="button" onClick={() => finishRename(false)}>Cancel</button>
    </form>}
    <svg ref={svgRef} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="group" aria-label="Flowchart" className={"flowchart-svg" + (editing ? " editing" : "") + (editing && tool === "box" ? " placing" : "")} style={editing ? { height: 440 } : { minHeight: Math.min(520, Math.max(120, box.h)) }}
      onPointerDown={e => {
        if (!editing || tool === "connect" || e.target !== e.currentTarget) return;
        if (tool === "box") return; // a click places a box; see onClick
        panning.current = { x: e.clientX, y: e.clientY, cam: box };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={e => {
        const pan = panning.current;
        if (pan) { const r = e.currentTarget.getBoundingClientRect(), k = camScale(pan.cam, r.width, r.height); setCam(panCam(pan.cam, -(e.clientX - pan.x) / k, -(e.clientY - pan.y) / k)); return; }
        const d = drag.current; if (!d) return; const p = toChart(e.clientX, e.clientY); d.moved = true; setLive({ id: d.id, x: p.x - d.dx, y: p.y - d.dy }); }}
      onPointerUp={() => { panning.current = null; const d = drag.current; drag.current = null; if (d?.moved && live) commit(moveNode(chart, live.id, live.x, live.y)); setLive(null); }}
      onPointerLeave={() => { if (panning.current) panning.current = null; if (drag.current) { drag.current = null; setLive(null); } }}
      onClick={e => {
        if (!editing || e.target !== e.currentTarget) return;
        if (tool === "box") { if (!cam) setCam(box); const p = toChart(e.clientX, e.clientY); newBox(p.x, p.y); setTool("select"); return; }
        setSelected(null); if (from !== null) setFrom(null);
      }}>
      <defs>{[...heads].map(h => <marker key={h} id={`${marker}-${h}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="flowchart-arrowhead" style={toneStroke(h as BoxColor) ? { fill: toneStroke(h as BoxColor) } : undefined} /></marker>)}</defs>
      {shown.edges.map((e: FEdge) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) return null;
        const pts = routeEdge(a, b, e.route), d = roundedPath(pts), mid = pathMidpoint(pts);
        const on = editing && selected?.kind === "edge" && selected.from === e.from && selected.to === e.to;
        const stroke = toneStroke(e.color), dash = dashFor(e.line);
        const lineStyle: React.CSSProperties = { ...(stroke ? { stroke } : {}), ...(dash ? { strokeDasharray: dash, strokeLinecap: "round" } : {}) };
        const head = e.arrow === false ? undefined : `url(#${marker}-${e.fill ?? e.color ?? "default"})`;
        return <g key={e.from + ">" + e.to} className={"flowchart-edge" + (on ? " selected" : "")} role={editing ? "button" : undefined} tabIndex={editing ? 0 : undefined} aria-label={`Arrow from ${a.text || "box"} to ${b.text || "box"}${e.label ? ", " + e.label : ""}`}
          onClick={ev => { if (!editing) return; ev.stopPropagation(); setSelected({ kind: "edge", from: e.from, to: e.to }); }} onKeyDown={ev => { if (editing && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); setSelected({ kind: "edge", from: e.from, to: e.to }); } }}>
          {on && <path d={d} className="flowchart-halo-line" />}
          <path d={d} className="flowchart-hit" />
          <path d={d} markerEnd={head} style={lineStyle} />
          {e.label && <text x={mid.x} y={mid.y - 6} textAnchor="middle">{e.label}</text>}
        </g>;
      })}
      {shown.nodes.map(n => {
        const on = editing && selected?.kind === "node" && selected.id === n.id;
        const custom = nodeStyle(n);
        const textStyle = n.shape === "terminal" && n.fill ? { fill: "var(--text)" } : undefined;
        return <g key={n.id} className={"flowchart-node " + n.shape + (on ? " selected" : "") + (from === n.id ? " source" : "")} transform={`translate(${n.x} ${n.y})`} role={editing ? "button" : undefined} tabIndex={editing ? 0 : undefined} aria-label={`${SHAPE_NAMES[n.shape]}: ${n.text || "empty"}`}
          onPointerDown={e => { if (!editing || tool !== "select") return; e.stopPropagation(); if (!cam) setCam(box); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const p = toChart(e.clientX, e.clientY); drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false }; }}
          onClick={ev => { if (!editing) return; ev.stopPropagation(); clickNode(n); }} onDoubleClick={() => startRename({ kind: "node", id: n.id }, n.text)}
          onKeyDown={ev => { if (!editing) return; if (ev.key === "Enter") { ev.preventDefault(); clickNode(n); } else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); commit(removeNode(chart, n.id)); setSelected(null); } else if (ev.key === "F2") { startRename({ kind: "node", id: n.id }, n.text); } }}>
          {on && outline(n, {}, "flowchart-halo")}
          {outline(n, { style: custom })}<text textAnchor="middle" dominantBaseline="central" style={textStyle}>{label(n.text)}</text><title>{n.text}</title>
        </g>;
      })}
    </svg>
    {!chart.nodes.length && <p className="hint">{editing ? "An empty flowchart. Choose the Box tool, then click the canvas." : "An empty flowchart."}</p>}
  </div>;
}
