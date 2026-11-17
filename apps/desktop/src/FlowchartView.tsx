import { useId, useMemo, useRef, useState } from "react";
import { addNode, boundaryPoint, chartBounds, connect, editNode, labelEdge, moveNode, nodeHeight, parseFlowchart, removeEdge, removeNode, serializeFlowchart, tidyLayout, NODE_W, SHAPES, SHAPE_NAMES, type Flowchart, type FNode, type Shape } from "./flowchart";

type Selection = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string } | null;

function outline(n: FNode) {
  const w = NODE_W / 2, h = nodeHeight(n.shape) / 2;
  if (n.shape === "decision") return <polygon points={`0,${-h} ${w},0 0,${h} ${-w},0`} />;
  return <rect x={-w} y={-h} width={NODE_W} height={h * 2} rx={n.shape === "terminal" ? h : 8} />;
}
const label = (text: string) => (text.length > 22 ? text.slice(0, 21) + "…" : text || "(empty)");

/**
 * A small flowchart editor. Click a step to select it; drag to move it. "Connect" then click two steps to draw an arrow. Everything is
 * plain SVG, so nothing is loaded from the web and the text can never run as markup. `onChange` receives the new chart after each completed action.
 */
export default function FlowchartView({ data, editable, onChange }: { data: string; editable: boolean; onChange: (json: string) => void }) {
  const chart = useMemo(() => parseFlowchart(data), [data]);
  const [live, setLive] = useState<{ id: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [connecting, setConnecting] = useState<string | null | "pick">(null);
  const [editing, setEditing] = useState<Selection>(null);
  const [draft, setDraft] = useState("");
  const marker = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);

  const shown: Flowchart = live ? moveNode(chart, live.id, live.x, live.y) : chart;
  const box = chartBounds(shown);
  const byId = new Map(shown.nodes.map(n => [n.id, n]));
  const commit = (next: Flowchart) => onChange(serializeFlowchart(next));
  const node = selected?.kind === "node" ? byId.get(selected.id) : undefined;

  function toChart(clientX: number, clientY: number) {
    const svg = svgRef.current;
    const r = svg?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return { x: box.x + (clientX - r.left) / r.width * box.w, y: box.y + (clientY - r.top) / r.height * box.h };
  }
  function startEdit(sel: Selection, text: string) { if (!editable) return; setEditing(sel); setDraft(text); }
  function finishEdit(save: boolean) {
    if (editing && save) {
      if (editing.kind === "node") commit(editNode(chart, editing.id, { text: draft }));
      else commit(labelEdge(chart, editing.from, editing.to, draft));
    }
    setEditing(null);
  }
  function clickNode(n: FNode) {
    if (connecting === "pick") { setConnecting(n.id); return; }
    if (connecting) { if (connecting !== n.id) commit(connect(chart, connecting, n.id)); setConnecting(null); setSelected({ kind: "node", id: n.id }); return; }
    setSelected({ kind: "node", id: n.id });
  }
  function remove() {
    if (!selected || !editable) return;
    commit(selected.kind === "node" ? removeNode(chart, selected.id) : removeEdge(chart, selected.from, selected.to));
    setSelected(null);
  }
  function add() {
    const out = addNode(chart);
    if (!out.id) return;
    commit(out.chart); setSelected({ kind: "node", id: out.id }); startEdit({ kind: "node", id: out.id }, "New step");
  }

  return <div className="flowchart" contentEditable={false}>
    {editable && <div className="flowchart-tools" role="toolbar" aria-label="Flowchart tools">
      <button onClick={add}>Add step</button>
      <button aria-pressed={!!connecting} onClick={() => setConnecting(c => (c ? null : "pick"))} disabled={chart.nodes.length < 2}>{connecting ? (connecting === "pick" ? "Click the first step" : "Click the second step") : "Connect"}</button>
      <button onClick={() => commit(tidyLayout(chart))} disabled={!chart.nodes.length}>Tidy up</button>
      {node && <>
        <label>Shape <select aria-label="Shape" value={node.shape} onChange={e => commit(editNode(chart, node.id, { shape: e.target.value as Shape }))}>{SHAPES.map(s => <option key={s} value={s}>{SHAPE_NAMES[s]}</option>)}</select></label>
        <button onClick={() => startEdit({ kind: "node", id: node.id }, node.text)}>Rename</button>
      </>}
      {selected?.kind === "edge" && <button onClick={() => startEdit(selected, chart.edges.find(e => e.from === selected.from && e.to === selected.to)?.label ?? "")}>Label arrow</button>}
      {selected && <button className="danger" onClick={remove}>{selected.kind === "node" ? "Delete step" : "Delete arrow"}</button>}
    </div>}
    {editing && <form className="flowchart-edit" onSubmit={e => { e.preventDefault(); finishEdit(true); }}>
      <input aria-label={editing.kind === "node" ? "Step text" : "Arrow label"} autoFocus value={draft} maxLength={editing.kind === "node" ? 100 : 40} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); finishEdit(false); } }} />
      <button type="submit">Save</button><button type="button" onClick={() => finishEdit(false)}>Cancel</button>
    </form>}
    <svg ref={svgRef} className="flowchart-svg" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="group" aria-label="Flowchart" style={{ minHeight: Math.min(520, Math.max(120, box.h)) }}
      onPointerMove={e => { const d = drag.current; if (!d) return; const p = toChart(e.clientX, e.clientY); d.moved = true; setLive({ id: d.id, x: p.x - d.dx, y: p.y - d.dy }); }}
      onPointerUp={() => { const d = drag.current; drag.current = null; if (d?.moved && live) commit(moveNode(chart, live.id, live.x, live.y)); setLive(null); }}
      onPointerLeave={() => { if (drag.current) { drag.current = null; setLive(null); } }}
      onClick={e => { if (e.target === e.currentTarget) { setSelected(null); if (connecting) setConnecting(null); } }}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="flowchart-arrowhead" /></marker></defs>
      {shown.edges.map(e => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) return null;
        const p = boundaryPoint(a, b.x, b.y), q = boundaryPoint(b, a.x, a.y);
        const on = selected?.kind === "edge" && selected.from === e.from && selected.to === e.to;
        return <g key={e.from + ">" + e.to} className={"flowchart-edge" + (on ? " selected" : "")} role="button" tabIndex={0} aria-label={`Arrow from ${a.text || "step"} to ${b.text || "step"}${e.label ? ", " + e.label : ""}`}
          onClick={ev => { ev.stopPropagation(); setSelected({ kind: "edge", from: e.from, to: e.to }); }} onKeyDown={ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSelected({ kind: "edge", from: e.from, to: e.to }); } }}>
          <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="flowchart-hit" />
          <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} markerEnd={`url(#${marker})`} />
          {e.label && <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 6} textAnchor="middle">{e.label}</text>}
        </g>;
      })}
      {shown.nodes.map(n => {
        const on = selected?.kind === "node" && selected.id === n.id;
        return <g key={n.id} className={"flowchart-node " + n.shape + (on ? " selected" : "") + (connecting === n.id ? " source" : "")} transform={`translate(${n.x} ${n.y})`} role="button" tabIndex={0} aria-label={`${SHAPE_NAMES[n.shape]}: ${n.text || "empty"}`}
          onPointerDown={e => { if (!editable || connecting) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const p = toChart(e.clientX, e.clientY); drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false }; }}
          onClick={ev => { ev.stopPropagation(); clickNode(n); }} onDoubleClick={() => startEdit({ kind: "node", id: n.id }, n.text)}
          onKeyDown={ev => { if (ev.key === "Enter") { ev.preventDefault(); clickNode(n); } else if ((ev.key === "Delete" || ev.key === "Backspace") && editable) { ev.preventDefault(); commit(removeNode(chart, n.id)); setSelected(null); } else if (ev.key === "F2" && editable) { startEdit({ kind: "node", id: n.id }, n.text); } }}>
          {outline(n)}<text textAnchor="middle" dominantBaseline="central">{label(n.text)}</text><title>{n.text}</title>
        </g>;
      })}
    </svg>
    {!chart.nodes.length && <p className="hint">{editable ? "An empty flowchart. Choose Add step to start." : "An empty flowchart."}</p>}
  </div>;
}
