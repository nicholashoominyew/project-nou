import { useMemo, useState } from "react";
import { addDays, answerSplit, streaks, totalsPerHabit, weeklyTrend, parseDay, type Habit, type LogEntry, type LogMap } from "./habitsLogic";

const SPLIT_DAYS = 30;
const TREND_WEEKS = 12;
const COLOURS = { done: "var(--accent)", skipped: "var(--muted)", no_answer: "var(--danger)" } as const;
const LABELS = { done: "Checked in", skipped: "Skipping", no_answer: "No answer" } as const;
const short = (day: string) => parseDay(day).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A donut slice from angle a to b (radians, 0 at 12 o'clock). */
function arc(cx: number, cy: number, r0: number, r1: number, a: number, b: number) {
  const p = (r: number, t: number) => [cx + r * Math.sin(t), cy - r * Math.cos(t)];
  const big = b - a > Math.PI ? 1 : 0;
  const [x0, y0] = p(r1, a), [x1, y1] = p(r1, b), [x2, y2] = p(r0, b), [x3, y3] = p(r0, a);
  return `M${x0},${y0} A${r1},${r1} 0 ${big} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${big} 0 ${x3},${y3} Z`;
}

/** The charts under the daily table: streaks, completion per habit, a 12-week trend, and how answers split. Everything is read from the same log as the table. */
export default function HabitCharts({ habits, entries, log, today }: { habits: Habit[]; entries: LogEntry[]; log: LogMap; today: string }) {
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const from = addDays(today, -(range - 1));
  const per = useMemo(() => totalsPerHabit(habits, log, from, today), [habits, log, from, today]);
  const trend = useMemo(() => weeklyTrend(habits, log, today, TREND_WEEKS), [habits, log, today]);
  const split = useMemo(() => answerSplit(entries, addDays(today, -(SPLIT_DAYS - 1)), today, new Set(habits.map(h => h.id))), [entries, habits, today]);
  const splitTotal = split.done + split.skipped + split.no_answer;
  if (!habits.length) return <section className="hb-card" aria-label="Charts"><h2>Charts</h2><p className="hint">Add a habit and log a few days to see charts here.</p></section>;

  // line chart geometry
  const W = 600, H = 190, m = { l: 40, r: 14, t: 12, b: 28 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const x = (i: number) => m.l + (trend.length > 1 ? (pw * i) / (trend.length - 1) : pw / 2), y = (pct: number) => m.t + ph - (pct / 100) * ph;
  const segments: string[] = []; let current = "";
  trend.forEach((w, i) => { if (w.pct === null) { if (current) segments.push(current); current = ""; } else current += (current ? " L" : "M") + x(i) + "," + y(w.pct); });
  if (current) segments.push(current);
  // donut geometry
  const R1 = 78, R0 = 48; let angle = 0;
  const slices = (["done", "skipped", "no_answer"] as const).filter(k => split[k] > 0);

  return <section className="hb-card hb-charts" aria-label="Charts"><h2>Charts</h2>
    <div className="hb-chart-block" aria-label="Streaks"><h3>Streaks</h3>
      <ul className="hb-streaks">{habits.map(h => { const s = streaks(h, log, today); return <li key={h.id}><strong>{h.name}</strong><span><b>{s.current}</b> day{s.current === 1 ? "" : "s"} now</span><span className="hint">best {s.best}</span></li>; })}</ul></div>

    <div className="hb-chart-block" aria-label="Completion by habit"><div className="hb-card-head"><h3>Completion by habit</h3>
      <div role="group" aria-label="Range" className="tt-seg-toggle">{([7, 30, 90] as const).map(r => <button key={r} type="button" aria-pressed={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r} days</button>)}</div></div>
      <ul className="hb-hbars" aria-label={`Days done in the last ${range} days`}>{per.map(p => <li key={p.habit.id}><span className="hb-hbar-name">{p.habit.name}</span>
        <span className="hb-hbar" role="img" aria-label={`${p.habit.name}: ${p.done} of ${p.total} days, ${p.pct ?? 0}%`}><i style={{ width: (p.pct ?? 0) + "%" }} /></span><span className="hb-hbar-val">{p.total ? `${p.pct}% · ${p.done}/${p.total}` : "–"}</span></li>)}</ul></div>

    <div className="hb-chart-block" aria-label="Weekly trend"><h3>Last {TREND_WEEKS} weeks</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="hb-svg" role="img" aria-label={`Share of habit-days done each week for ${TREND_WEEKS} weeks: ${trend.map(w => `${short(w.start)} ${w.pct ?? "no data"}${w.pct === null ? "" : "%"}`).join(", ")}`}>
        {[0, 25, 50, 75, 100].map(t => <g key={t}><line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} className="hb-grid" /><text x={m.l - 6} y={y(t)} textAnchor="end" dominantBaseline="central" className="hb-tick-label">{t}%</text></g>)}
        {segments.map((d, i) => <path key={i} d={d} className="hb-line" />)}
        {trend.map((w, i) => w.pct !== null && <circle key={w.start} cx={x(i)} cy={y(w.pct)} r={4} className="hb-point"><title>{`Week of ${short(w.start)}: ${w.pct}% (${w.done} of ${w.total})`}</title></circle>)}
        {trend.map((w, i) => (i % 2 === (trend.length - 1) % 2) && <text key={w.start} x={x(i)} y={H - 8} textAnchor="middle" className="hb-tick-label">{short(w.start)}</text>)}
      </svg></div>

    <div className="hb-chart-block" aria-label="Answers"><h3>Answers, last {SPLIT_DAYS} days</h3>
      {!splitTotal ? <p className="hint">No answers yet.</p> : <div className="hb-donut-wrap">
        <svg viewBox="0 0 200 200" className="hb-donut" role="img" aria-label={`Checked in ${split.done}, skipping ${split.skipped}, no answer ${split.no_answer}`}>
          {slices.map(k => { const a = angle, b = angle + (split[k] / splitTotal) * Math.PI * 2; angle = b;
            return slices.length === 1 ? <path key={k} d={`${arc(100, 100, R0, R1, 0, Math.PI)} ${arc(100, 100, R0, R1, Math.PI, Math.PI * 2)}`} fill={COLOURS[k]} fillRule="evenodd"><title>{`${LABELS[k]}: ${split[k]}`}</title></path>
              : <path key={k} d={arc(100, 100, R0, R1, a, b)} fill={COLOURS[k]}><title>{`${LABELS[k]}: ${split[k]} (${Math.round((split[k] / splitTotal) * 100)}%)`}</title></path>; })}
          <text x="100" y="100" textAnchor="middle" dominantBaseline="central" className="hb-donut-center">{splitTotal}</text></svg>
        <ul className="hb-legend" aria-label="Legend">{(["done", "skipped", "no_answer"] as const).map(k => <li key={k}><i style={{ background: COLOURS[k] }} />{LABELS[k]} <b>{split[k]}</b></li>)}</ul></div>}</div>
  </section>;
}
