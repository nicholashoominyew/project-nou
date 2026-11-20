import { useState } from "react";
import { CATEGORIES, distribution, fmtHours, type Activity, type Grid, type Variant } from "./schedule";
import { catFill } from "./palette";

const pt = (r: number, deg: number): [number, number] => { const a = (deg * Math.PI) / 180; return [150 + r * Math.sin(a), 150 - r * Math.cos(a)]; };
const f2 = (n: number) => Math.round(n * 100) / 100;
/** One donut segment between two radii and two angles (degrees clockwise from 12 o'clock). */
export function segment(r0: number, r1: number, a0: number, a1: number): string {
  if (a1 - a0 >= 359.99) a1 = a0 + 359.99;
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${f2(x0)} ${f2(y0)} A${r1} ${r1} 0 ${large} 1 ${f2(x1)} ${f2(y1)} L${f2(x2)} ${f2(y2)} A${r0} ${r0} 0 ${large} 0 ${f2(x3)} ${f2(y3)} Z`;
}
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** One donut and a table, for the day the timetable has selected (Day view) or the whole week (Week view). Hover or focus a category to highlight it in both. */
export default function Distribution({ grid, activities, day, variant }: { grid: Grid; activities: Activity[]; day: number | null; variant: Variant }) {
  const [hover, setHover] = useState<string | null>(null);
  const { hours, total } = distribution(grid, activities, day);
  const scope = day === null ? "Week" : DAYS[day];
  let acc = 0;
  const segs = CATEGORIES.map(c => {
    const v = hours[c]; if (v <= 0.0000001) return null;
    const a0 = (acc / total) * 360, a1 = ((acc + v) / total) * 360; acc += v;
    const focused = hover === c;
    return <path key={c} d={segment(98, focused ? 146 : 138, a0, a1)} className="tt-seg" data-cat={c} style={{ fill: catFill(c), opacity: hover === null || focused ? 1 : 0.25 }} onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)}>
      <title>{`${c} · ${fmtHours(v)}h (${Math.round((v / total) * 100)}%)`}</title></path>;
  });
  const hv = hover ? hours[hover] : null;
  return <section className="tt-card tt-dist" aria-label="Time distribution">
    <div className="tt-dist-head">
      <h2>Time distribution</h2>
      <span className="tt-mono-muted" data-testid="dist-title">{(day === null ? "WHOLE WEEK · 168H" : `${scope.toUpperCase()} · 24H`) + " · WEEK " + variant}</span>
    </div>
    <div className="tt-dist-body">
      <div className="tt-donut">
        <svg viewBox="0 0 300 300" width="220" height="220" role="img" aria-label={`Time per category, ${scope}`} style={{ overflow: "visible" }}>{segs}</svg>
        <div className="tt-ring-center small" aria-hidden="true">
          <span className="tt-donut-kicker" style={{ color: hover ? "var(--text)" : "var(--muted)" }}>{hover ? hover.toUpperCase() : scope.toUpperCase()}</span>
          <span className="tt-donut-big" data-testid="donut-big">{hv !== null ? fmtHours(hv) + "h" : total + "h"}</span>
          <span className="tt-donut-sub">{hv !== null ? Math.round((hv / total) * 100) + "% of " + scope.toLowerCase() : day === null ? "in the week" : "in the day"}</span>
        </div>
      </div>
      <div className="tt-legend">
        <div className="tt-legend-head"><span>CATEGORY · {day === null ? "WEEK" : DAYS[day].slice(0, 3).toUpperCase()}</span><span>HOURS</span><span>SHARE</span></div>
        <ul>{CATEGORIES.map(c => {
          const v = hours[c];
          return <li key={c}><button type="button" className={"tt-legend-row" + (hover === c ? " on" : "")} onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(c)} onBlur={() => setHover(null)}>
            <span className="tt-legend-name"><span className="tt-swatch" style={{ background: catFill(c) }} />{c}</span>
            <span className="tt-num">{v > 0.0000001 ? fmtHours(v) + "h" : "–"}</span>
            <span className="tt-num muted">{v > 0.0000001 ? Math.round((v / total) * 100) + "%" : "–"}</span>
          </button></li>;
        })}</ul>
      </div>
    </div>
  </section>;
}
