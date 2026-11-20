import { useEffect, useRef, useState } from "react";
import { now } from "./clock";
import { clock, countdown, eventAfter, eventAt, names, progress } from "./schedule";
import { categoryOf, colourOf } from "./NowCard";
import { useTick, useTimetable } from "./useTimetable";

const R = 140, C = 2 * Math.PI * R, GAP = 10; // the ring starts and ends just either side of 12 o'clock, leaving a small gap

/** Full-window focus view: a round countdown to the end of the current event. Pause holds the picture still (the real clock keeps running underneath); the back arrow returns to it. */
export default function FocusView({ onClose }: { onClose: () => void }) {
  const { grid, activities, data } = useTimetable();
  const live = useTick(250, now);
  const [frozen, setFrozen] = useState<Date | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const t = frozen ?? live;
  const ev = eventAt(grid, t);
  const planned = !!ev && ev.ids.length > 0;
  const next = ev ? eventAfter(grid, ev, t) : null;
  const left = ev ? ev.end.getTime() - t.getTime() : 0;
  const remaining = ev ? 1 - progress(ev, t) : 0;
  const colour = ev ? colourOf(ev.ids, activities) : null;
  const category = ev ? categoryOf(ev.ids, activities) : "Rest";
  const arc = Math.max(0, (C - GAP) * remaining);
  const icon = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  return <div className={"focus-view cat-" + category.toLowerCase()} style={colour ? ({ "--cat-bar": colour } as React.CSSProperties) : undefined} role="dialog" aria-modal="true" aria-label="Focus view">
    <button ref={closeRef} className="focus-close" aria-label="Exit focus view" title="Exit (Esc)" onClick={onClose}><svg {...icon} width={18} height={18}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg></button>
    <p className="focus-title">{!data ? "" : planned ? names(ev!.ids, activities) : "Nothing planned"}</p>
    <div className="focus-ring">
      <svg viewBox="0 0 320 320" aria-hidden="true">
        <circle className="focus-track" cx="160" cy="160" r={R} />
        <circle className="focus-arc" data-testid="focus-arc" cx="160" cy="160" r={R} strokeDasharray={`${arc} ${C}`} strokeDashoffset={-GAP / 2} transform="rotate(-90 160 160)" />
      </svg>
      <div className="focus-center">
        <span className="focus-time" role="timer" aria-label={planned ? countdown(left) + " left" : "No event"}>{planned ? countdown(left) : "--:--:--"}</span>
        {ev && planned && <span className="focus-chip"><svg {...icon} width={16} height={16}><path d="M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 21a2 2 0 0 0 4 0" /></svg>{clock(ev.end)}</span>}
      </div>
    </div>
    <div className="focus-controls">
      <button className="focus-main" aria-pressed={!!frozen} aria-label={frozen ? "Resume display" : "Pause display"} onClick={() => setFrozen(frozen ? null : live)}>
        {frozen ? <svg {...icon} fill="currentColor" stroke="none"><path d="M7 4l13 8-13 8z" /></svg> : <svg {...icon} fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1.5" /><rect x="14" y="4" width="4" height="16" rx="1.5" /></svg>}
      </button>
      <button className="focus-sub" aria-label="Back to live time" title="Back to live time" disabled={!frozen} onClick={() => setFrozen(null)}><svg {...icon}><path d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5" /></svg></button>
    </div>
    <p className="focus-next">{next && next.ids.length ? <>Next: {names(next.ids, activities)} at {clock(next.start)}</> : ""}</p>
  </div>;
}
