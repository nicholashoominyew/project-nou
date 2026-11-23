import { useMemo } from "react";
import { buildChart, fmtNum, niceScale, paletteColor, type ChartData } from "./chartLogic";
import type { ViewContext } from "./dbShared";

const W = 760;
const HEIGHTS = { small: 220, medium: 320, large: 440, xlarge: 580 } as const;

/** Smooth line through points (Catmull-Rom turned into Béziers). */
function smoothPath(pts: [number, number][]) {
  if (pts.length < 3) return pts.map((p, i) => (i ? "L" : "M") + p[0] + "," + p[1]).join(" ");
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A donut slice from angle a to b (radians, 0 at 12 o'clock). */
function arc(cx: number, cy: number, r0: number, r1: number, a: number, b: number) {
  const p = (r: number, t: number) => [cx + r * Math.sin(t), cy - r * Math.cos(t)];
  const big = b - a > Math.PI ? 1 : 0;
  const [x0, y0] = p(r1, a), [x1, y1] = p(r1, b), [x2, y2] = p(r0, b), [x3, y3] = p(r0, a);
  return `M${x0},${y0} A${r1},${r1} 0 ${big} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${big} 0 ${x3},${y3} Z`;
}

function Legend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return <ul className="db-chart-legend" aria-label="Legend">{items.map(i => <li key={i.key}><span className="swatch" style={{ background: i.color }} />{i.label}</li>)}</ul>;
}

function Donut({ data, ctx }: { data: ChartData; ctx: ViewContext }) {
  const cfg = ctx.view.config;
  const slices = data.buckets.filter(b => b.total > 0).map((b, i) => ({ ...b, color: b.color ?? paletteColor(i) }));
  const total = slices.reduce((a, b) => a + b.total, 0);
  const H = HEIGHTS[cfg.height ?? "medium"], r1 = Math.min(H / 2 - 12, 190), r0 = r1 * 0.62, cx = W / 2, cy = H / 2;
  let angle = 0;
  if (!total) return <p className="hint db-notice">Nothing to chart yet.</p>;
  return <>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Donut chart of ${data.xLabel}`} className="db-chart-svg" style={{ height: H }}>
      {slices.map(s => {
        const a = angle, b = angle + (s.total / total) * Math.PI * 2; angle = b;
        const mid = (a + b) / 2, rm = (r0 + r1) / 2;
        const whole = slices.length === 1;
        return <g key={s.key}>
          {whole ? <path d={`${arc(cx, cy, r0, r1, 0, Math.PI)} ${arc(cx, cy, r0, r1, Math.PI, Math.PI * 2)}`} fill={s.color} fillRule="evenodd" /> : <path d={arc(cx, cy, r0, r1, a, b)} fill={s.color} className="db-chart-mark" />}
          <title>{`${s.label}: ${fmtNum(s.total)} (${Math.round((s.total / total) * 100)}%)`}</title>
          {cfg.dataLabels && (b - a > 0.25 || whole) && <text x={cx + rm * Math.sin(mid)} y={cy - rm * Math.cos(mid)} textAnchor="middle" dominantBaseline="central" className="db-chart-datalabel on-mark">{fmtNum(s.total)}</text>}
        </g>;
      })}
      {cfg.donutCenter !== "none" && <g textAnchor="middle"><text x={cx} y={cy} dominantBaseline="central" className="db-chart-center">{fmtNum(total)}</text><text x={cx} y={cy + 26} className="db-chart-center-sub">{data.yLabel}</text></g>}
    </svg>
    {cfg.legend !== false && <Legend items={slices.map(s => ({ key: s.key, label: s.label, color: s.color }))} />}
  </>;
}

export function ChartView({ ctx }: { ctx: ViewContext }) {
  const cfg = ctx.view.config;
  const type = cfg.chartType ?? "vbar";
  const data = useMemo(() => buildChart(ctx.data.rows, ctx.data.properties, cfg, ctx.data.linked), [ctx.data.rows, ctx.data.properties, ctx.data.linked, cfg]);
  if (!data) return <p className="hint db-notice">Choose a property for the X axis to build the chart.</p>;
  if (!data.buckets.length) return <p className="hint db-notice">Nothing to chart yet.</p>;
  if (type === "donut") return <div className="db-chart"><Donut data={data} ctx={ctx} /></div>;

  const H = HEIGHTS[cfg.height ?? "medium"];
  const horizontal = type === "hbar";
  const grid = cfg.grid !== false, names = cfg.axisNames === true, labels = cfg.dataLabels === true;
  const stacked = cfg.barStyle === "stacked" || cfg.barStyle === "percent";
  const labelRoom = horizontal ? Math.min(180, 24 + Math.max(...data.buckets.map(b => Math.min(b.label.length, 22))) * 7) : 0;
  const m = { l: horizontal ? labelRoom + (names ? 22 : 0) : 48 + (names ? 22 : 0), r: 20, t: 16, b: horizontal ? 28 + (names ? 20 : 0) : 46 + (names ? 20 : 0) };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const ref = typeof cfg.refLine === "number" ? cfg.refLine : undefined;
  const { top, ticks } = niceScale(Math.max(data.max, ref ?? 0));
  const n = data.buckets.length, sN = data.series.length;
  const along = horizontal ? ph : pw, band = along / n;
  const val = (v: number) => (v / top) * (horizontal ? pw : ph);
  const bx = (i: number) => (horizontal ? m.t + band * i : m.l + band * i);
  const pct = cfg.barStyle === "percent";
  const tipFor = (label: string, series: string, v: number) => `${label}${data.series.length > 1 ? " · " + series : ""}: ${fmtNum(v)}${pct ? "%" : ""}`;

  return <div className="db-chart">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${type === "line" ? "Line" : horizontal ? "Horizontal bar" : "Vertical bar"} chart of ${data.yLabel} by ${data.xLabel}`} className="db-chart-svg" style={{ height: H }}>
      {ticks.map(t => {
        const p = horizontal ? m.l + (t / top) * pw : m.t + ph - (t / top) * ph;
        return <g key={t}>
          {grid && (horizontal ? <line x1={p} x2={p} y1={m.t} y2={m.t + ph} className="db-chart-grid" /> : <line x1={m.l} x2={m.l + pw} y1={p} y2={p} className="db-chart-grid" />)}
          {horizontal ? <text x={p} y={m.t + ph + 16} textAnchor="middle" className="db-chart-tick">{fmtNum(t)}{pct ? "%" : ""}</text> : <text x={m.l - 8} y={p} textAnchor="end" dominantBaseline="central" className="db-chart-tick">{fmtNum(t)}{pct ? "%" : ""}</text>}
        </g>;
      })}
      <line x1={m.l} x2={m.l} y1={m.t} y2={m.t + ph} className="db-chart-axis" /><line x1={m.l} x2={m.l + pw} y1={m.t + ph} y2={m.t + ph} className="db-chart-axis" />
      {data.buckets.map((b, i) => {
        const c = bx(i) + band / 2;
        return horizontal
          ? <text key={b.key} x={m.l - 8} y={c} textAnchor="end" dominantBaseline="central" className="db-chart-tick">{short(b.label, 22)}<title>{b.label}</title></text>
          : <text key={b.key} x={c} y={m.t + ph + 18} textAnchor="middle" className="db-chart-tick">{short(b.label, Math.max(4, Math.floor(band / 7)))}<title>{b.label}</title></text>;
      })}
      {type !== "line" && data.buckets.map((b, i) => {
        const gap = Math.min(band * 0.22, 16), inner = band - gap * 2;
        let acc = 0;
        return <g key={b.key}>{b.values.map((v, s) => {
          const size = Math.max(0, val(v));
          const thick = stacked ? inner : inner / sN, off = stacked ? 0 : thick * s;
          const x = horizontal ? m.l + (stacked ? val(acc) : 0) : bx(i) + gap + off;
          const y = horizontal ? bx(i) + gap + off : m.t + ph - size - (stacked ? val(acc) : 0);
          const w = horizontal ? size : thick, h = horizontal ? thick : size;
          acc += v;
          if (!size) return null;
          const color = sN === 1 && b.color ? b.color : data.series[s].color;
          return <g key={s}><rect x={x} y={y} width={Math.max(w, 0)} height={Math.max(h, 0)} rx={2} fill={color} className="db-chart-mark"><title>{tipFor(b.label, data.series[s].label, v)}</title></rect>
            {labels && (horizontal ? w > 26 : h > 16) && <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="central" className="db-chart-datalabel on-mark">{fmtNum(v)}</text>}</g>;
        })}</g>;
      })}
      {type === "line" && data.series.map((s, k) => {
        const pts = data.buckets.map((b, i) => [bx(i) + band / 2, m.t + ph - val(b.values[k])] as [number, number]);
        return <g key={s.key}>
          <path d={cfg.smooth ? smoothPath(pts) : pts.map((p, i) => (i ? "L" : "M") + p[0] + "," + p[1]).join(" ")} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {pts.map((p, i) => <g key={i}><circle cx={p[0]} cy={p[1]} r={4} fill={s.color} className="db-chart-mark"><title>{tipFor(data.buckets[i].label, s.label, data.buckets[i].values[k])}</title></circle>
            {labels && <text x={p[0]} y={p[1] - 9} textAnchor="middle" className="db-chart-datalabel">{fmtNum(data.buckets[i].values[k])}</text>}</g>)}
        </g>;
      })}
      {ref !== undefined && ref <= top && (horizontal
        ? <line x1={m.l + (ref / top) * pw} x2={m.l + (ref / top) * pw} y1={m.t} y2={m.t + ph} className="db-chart-ref"><title>{`Reference line: ${fmtNum(ref)}`}</title></line>
        : <line x1={m.l} x2={m.l + pw} y1={m.t + ph - (ref / top) * ph} y2={m.t + ph - (ref / top) * ph} className="db-chart-ref"><title>{`Reference line: ${fmtNum(ref)}`}</title></line>)}
      {names && <>
        <text x={m.l + pw / 2} y={H - 6} textAnchor="middle" className="db-chart-axisname">{horizontal ? data.yLabel : data.xLabel}</text>
        <text transform={`translate(12 ${m.t + ph / 2}) rotate(-90)`} textAnchor="middle" className="db-chart-axisname">{horizontal ? data.xLabel : data.yLabel}</text>
      </>}
    </svg>
    {cfg.legend !== false && data.series.length > 1 && <Legend items={data.series} />}
  </div>;
}
