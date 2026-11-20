import { countdownParts } from "./schedule";

const R = 132;
const pt = (deg: number): [number, number] => { const a = (deg * Math.PI) / 180; return [150 + R * Math.sin(a), 150 - R * Math.cos(a)]; };
const f2 = (n: number) => Math.round(n * 100) / 100;
/** SVG path of the progress arc: starts at 12 o'clock and fills clockwise. */
export function progressPath(fraction: number): string {
  const e = Math.min(359.9, Math.max(0.5, fraction * 360));
  const [x0, y0] = pt(0), [x1, y1] = pt(e);
  return `M${f2(x0)} ${f2(y0)} A${R} ${R} 0 ${e > 180 ? 1 : 0} 1 ${f2(x1)} ${f2(y1)}`;
}

/** A thin track ring with an accent arc and round caps. No ticks, hand, knob or percentage. */
export function ProgressRing({ fraction, label, thin }: { fraction: number; label: string; thin?: boolean }) {
  const w = thin ? 6 : 10;
  return <svg viewBox="0 0 300 300" width="100%" height="100%" role="img" aria-label={label} className="tt-ring">
    <circle cx="150" cy="150" r={R} className="tt-ring-track" style={{ strokeWidth: w }} />
    <path d={progressPath(fraction)} className="tt-ring-arc" data-testid="ring-arc" style={{ strokeWidth: w }} />
  </svg>;
}

/** Hours (bold, hidden under an hour), minutes, then smaller muted seconds, each with its h / m / s label. */
export function Countdown({ ms, big }: { ms: number; big?: boolean }) {
  const p = countdownParts(ms);
  return <span className={"tt-cd" + (big ? " big" : "")} role="timer" aria-label={p.aria}>
    {p.showH && <><b className="cd-h">{p.h}</b><i>h</i></>}
    <span className="cd-m">{p.m}</span><i>m</i>
    <span className="cd-s">{p.s}</span><i>s</i>
  </span>;
}
