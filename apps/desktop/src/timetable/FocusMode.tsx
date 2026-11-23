import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { now } from "./clock";
import { Countdown, ProgressRing } from "./CountdownRing";
import { eventAt, names, progress } from "./schedule";
import { useTick, useTimetable } from "./useTimetable";

export const BURST_MS = 30 * 60 * 1000;

/**
 * Full-window focus mode: only the event name and the big timer ring. The 5-minute reminder toast stays above it. Esc or the corner button exits.
 * "30-minute burst" starts a second, shorter timer in the middle and shrinks the block's own timer into the bottom-right corner; the button
 * fades out when less than 30 minutes of the block is left, because a burst would not fit.
 */
export default function FocusMode({ onClose }: { onClose: () => void }) {
  const { timeline, activities, data } = useTimetable();
  const t = useTick(1000, now);
  const exit = useRef<HTMLButtonElement>(null);
  const [burstEnd, setBurstEnd] = useState<number | null>(null);
  useEffect(() => {
    exit.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", esc, true); return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);
  const ev = eventAt(timeline, t);
  const planned = !!ev && ev.ids.length > 0;
  const left = ev ? ev.end.getTime() - t.getTime() : 0;
  const pct = ev ? 1 - progress(ev, t) : 0; // the ring starts full and drains as the block runs out
  const burstLeft = burstEnd === null ? 0 : Math.max(0, burstEnd - t.getTime());
  const bursting = burstEnd !== null && burstLeft > 0;
  useEffect(() => { if (burstEnd !== null && burstLeft <= 0) setBurstEnd(null); }, [burstEnd, burstLeft]);
  const canBurst = planned && left >= BURST_MS && !bursting;
  return createPortal(<div className={"tt-focus" + (bursting ? " bursting" : "")} role="dialog" aria-modal="true" aria-label="Focus mode">
    <button ref={exit} type="button" className="tt-focus-exit" aria-label="Exit focus mode" onClick={onClose}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
    <p className="tt-focus-name">{bursting ? "30-minute burst" : !data ? "" : planned ? names(ev!.ids, activities) : "Nothing planned"}</p>
    {bursting && <div className="tt-focus-ring tt-burst-ring" role="group" aria-label="30-minute burst">
      <ProgressRing fraction={burstLeft / BURST_MS} thin label={`30-minute burst, ${Math.round((burstLeft / BURST_MS) * 100)}% of the time left`} />
      <div className="tt-ring-center"><Countdown ms={burstLeft} big /></div>
    </div>}
    <div className="tt-focus-ring tt-block-ring" aria-label={bursting ? "Time left in " + (planned ? names(ev!.ids, activities) : "the block") : undefined}>
      <ProgressRing fraction={pct} thin label={`Current event, ${Math.round(pct * 100)}% of the time left`} />
      <div className="tt-ring-center">{planned ? <Countdown ms={left} big /> : <span className="tt-cd big">–</span>}</div>
    </div>
    <button type="button" className={"tt-burst-btn" + (canBurst ? "" : " away")} disabled={!canBurst} aria-hidden={canBurst ? undefined : true} tabIndex={canBurst ? 0 : -1}
      onClick={() => setBurstEnd(t.getTime() + BURST_MS)}>30-minute burst</button>
    {bursting && <button type="button" className="tt-burst-end" onClick={() => setBurstEnd(null)}>End burst</button>}
  </div>, document.body);
}
