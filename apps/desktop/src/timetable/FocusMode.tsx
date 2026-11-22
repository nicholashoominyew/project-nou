import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { now } from "./clock";
import { Countdown, ProgressRing } from "./CountdownRing";
import { eventAt, names, progress } from "./schedule";
import { useTick, useTimetable } from "./useTimetable";

/** Full-window focus mode: only the event name and the big timer ring. The 5-minute reminder toast stays above it. Esc or the corner button exits. */
export default function FocusMode({ onClose }: { onClose: () => void }) {
  const { timeline, activities, data } = useTimetable();
  const t = useTick(1000, now);
  const exit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    exit.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", esc, true); return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);
  const ev = eventAt(timeline, t);
  const planned = !!ev && ev.ids.length > 0;
  const left = ev ? ev.end.getTime() - t.getTime() : 0;
  const pct = ev ? 1 - progress(ev, t) : 0; // the ring starts full and drains as the block runs out
  return createPortal(<div className="tt-focus" role="dialog" aria-modal="true" aria-label="Focus mode">
    <button ref={exit} type="button" className="tt-focus-exit" aria-label="Exit focus mode" onClick={onClose}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
    <p className="tt-focus-name">{!data ? "" : planned ? names(ev!.ids, activities) : "Nothing planned"}</p>
    <div className="tt-focus-ring">
      <ProgressRing fraction={pct} thin label={`Current event, ${Math.round(pct * 100)}% of the time left`} />
      <div className="tt-ring-center">{planned ? <Countdown ms={left} big /> : <span className="tt-cd big">–</span>}</div>
    </div>
  </div>, document.body);
}
