import { useEffect, useRef, useState, type ReactNode } from "react";

/** The small signature detail: a 7px dot, with a soft ring when the card is live. */
export function StateDot({ live }: { live?: boolean }) { return <i className={"state-dot" + (live ? " live" : "")} aria-hidden="true" />; }

/** A card heading in the mono label style, with the state dot and anything the card wants on the right. */
export function CardHead({ title, live, children }: { title: string; live?: boolean; children?: ReactNode }) {
  return <div className="card-head"><h2><StateDot live={live} />{title}</h2>{children && <div className="card-tools">{children}</div>}</div>;
}

/**
 * One flip tile. It shows its digit at once and only flips when the value changes afterwards (the animation is a class that appears on the first change),
 * so opening Home does not make every tile flip. Reduced motion turns the animation off in the stylesheet.
 */
export function Flip({ value, small }: { value: string; small?: boolean }) {
  const prev = useRef(value);
  const [flips, setFlips] = useState(0);
  useEffect(() => { if (prev.current !== value) { prev.current = value; setFlips(n => n + 1); } }, [value]);
  return <span key={flips} className={"flip" + (small ? " small" : "") + (flips ? " go" : "")} data-flips={flips}>{value}<i className="flip-shade" /><i className="flip-split" /></span>;
}

/** A progress ring: a track and an arc, drawn from the top. `radius` and `stroke` are in the 100x100 box of the parent svg. */
export function Arc({ radius, stroke, fraction, cx = 50, cy = 50 }: { radius: number; stroke: number; fraction: number; cx?: number; cy?: number }) {
  const c = 2 * Math.PI * radius, f = Math.min(1, Math.max(0, fraction));
  return <g transform={`rotate(-90 ${cx} ${cy})`}>
    <circle cx={cx} cy={cy} r={radius} fill="none" className="arc-track" strokeWidth={stroke} />
    <circle cx={cx} cy={cy} r={radius} fill="none" className="arc-fill" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(c * f).toFixed(2)} ${c.toFixed(2)}`} />
  </g>;
}

/** Weather icons as simple strokes, picked from the WMO code. */
const SKY = { sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4", cloud: "M7 18a4 4 0 1 1 .8-7.9A5.5 5.5 0 0 1 18.5 11 3.5 3.5 0 0 1 18 18z", rain: "M7 14a4 4 0 1 1 .8-7.9A5.5 5.5 0 0 1 18.5 7 3.5 3.5 0 0 1 18 14zM8 17l-1 3M12 17l-1 3M16 17l-1 3", snow: "M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9", fog: "M4 9h16M3 13h18M6 17h12", storm: "M7 14a4 4 0 1 1 .8-7.9A5.5 5.5 0 0 1 18.5 7 3.5 3.5 0 0 1 18 14zM12 12l-2 4h4l-2 4" };
export function skyIcon(code: number): keyof typeof SKY {
  if (code <= 1) return "sun";
  if (code <= 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}
export function SkyIcon({ code, size = 18 }: { code: number; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={SKY[skyIcon(code)]} /></svg>;
}
