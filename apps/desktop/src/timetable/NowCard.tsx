import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";
import { now } from "./clock";
import { clock, countdown, eventAfter, eventAt, names, progress, type Activity } from "./schedule";
import { useTick, useTimetable } from "./useTimetable";

export const categoryOf = (ids: string[], activities: Activity[]) => activities.find(a => a.id === ids[0])?.category ?? "Rest";
export const colourOf = (ids: string[], activities: Activity[]) => activities.find(a => a.id === ids[0] && a.colour)?.colour ?? null;

/** Home: what is happening now, how long is left, and what comes next. Everything is worked out from the clock on every tick. */
const FocusView = lazy(() => import("./FocusView"));
export default function NowCard({ open }: { open?: () => void }) {
  const [focus, setFocus] = useState(false);
  const { grid, activities, data } = useTimetable();
  const t = useTick(1000, now);
  if (!data) return null;
  const ev = eventAt(grid, t);
  const planned = !!ev && ev.ids.length > 0;
  const next = ev ? eventAfter(grid, ev, t) : null;
  const colour = ev ? colourOf(ev.ids, activities) : null;
  const category = ev ? categoryOf(ev.ids, activities) : "Rest";
  const title = planned ? names(ev!.ids, activities) : "Nothing planned";
  const pct = ev ? Math.round(progress(ev, t) * 100) : 0;
  const label = planned ? `Now: ${title}, ${clock(ev!.start)} to ${clock(ev!.end)}, ${countdown(ev!.end.getTime() - t.getTime())} left` : "Now: nothing planned";
  return <div className="now-wrap"><button type="button" className={"now-card cat-" + category.toLowerCase()} style={colour ? ({ "--cat-bar": colour } as React.CSSProperties) : undefined} aria-label={label} title="Open the Life Timetable" onClick={open}>
    <span className="now-kicker">Now</span>
    <span className="now-main">
      <span className="now-title">{title}</span>
      {ev && <span className="now-range">{clock(ev.start)}–{clock(ev.end)}{planned ? " · " + category : ""}</span>}
    </span>
    {ev && planned && <span className="now-clock" aria-hidden="true">{countdown(ev.end.getTime() - t.getTime())}</span>}
    <span className="now-bar" role="progressbar" aria-label="Progress through the current event" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: pct + "%" }} /></span>
    <span className="now-next">{next && next.ids.length ? <>Next: <b>{names(next.ids, activities)}</b> at {clock(next.start)}</> : planned ? "Nothing after this" : "Open the Life Timetable to plan your week"}</span>
  </button>
    <button type="button" className="now-focus" aria-label="Focus view" title="Focus view with a round timer" onClick={() => setFocus(true)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg></button>
    {focus && createPortal(<Suspense fallback={null}><FocusView onClose={() => setFocus(false)} /></Suspense>, document.body)}
  </div>;
}
