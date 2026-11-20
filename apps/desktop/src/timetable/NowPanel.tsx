import { lazy, Suspense, useState } from "react";
import { now } from "./clock";
import { Countdown, ProgressRing } from "./CountdownRing";
import { catFill, catInk } from "./palette";
import { CATEGORIES, clock, eventAt, names, progress, weekdayOf } from "./schedule";
import { useTick, useTimetable } from "./useTimetable";

const FocusMode = lazy(() => import("./FocusMode"));
const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
export const kickerOf = (d: Date) => `PROJECT NOU · 脳 · ${DAYS[weekdayOf(d)]} · ${clock(d)}`;

/** The current event: kicker, time range, category chips, name, and the circular timer. Always live; the next event only shows in the reminder. */
export default function NowPanel() {
  const { timeline, activities, data } = useTimetable();
  const t = useTick(1000, now);
  const [focus, setFocus] = useState(false);
  if (!data) return null;
  const ev = eventAt(timeline, t);
  const planned = !!ev && ev.ids.length > 0;
  const mine = ev ? ev.ids.map(id => activities.find(a => a.id === id)).filter(Boolean) : [];
  const cats = CATEGORIES.filter(c => mine.some(a => a!.category === c));
  const pct = ev ? progress(ev, t) : 0;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // "(+1)" when the event runs past midnight (an event ending exactly at 24:00 does not).
  const crosses = !!ev && startOfDay(new Date(ev.end.getTime() - 60000)) !== startOfDay(ev.start);
  const range = ev ? `${clock(ev.start)}–${clock(ev.end)}${crosses ? " (+1)" : ""}` : "";
  const left = ev ? ev.end.getTime() - t.getTime() : 0;
  return <section className="tt-card tt-now" aria-label="Current event">
    <div className="tt-now-head">
      <span className="tt-kicker"><span className="tt-dot-live" aria-hidden="true" />NOW · {clock(t)}</span>
      <span className="tt-now-tools">
        <span className="tt-mono-muted">{range}</span>
        <button type="button" className="tt-btn small" aria-label="Enter focus mode" onClick={() => setFocus(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>Focus
        </button>
      </span>
    </div>
    <div className="tt-now-body">
      <div className="tt-chips">{cats.map(c => <span key={c} className="tt-chip" style={{ background: catFill(c), color: catInk(c) }}>{c}</span>)}</div>
      <span className="tt-now-name">{planned ? names(ev!.ids, activities) : "Nothing planned"}</span>
    </div>
    <div className="tt-now-ring">
      <ProgressRing fraction={pct} label={planned ? `Current event progress, ${Math.round(pct * 100)}% done` : "Nothing planned"} />
      <div className="tt-ring-center">{planned ? <Countdown ms={left} /> : <span className="tt-mono-muted">–</span>}</div>
    </div>
    {focus && <Suspense fallback={null}><FocusMode onClose={() => setFocus(false)} /></Suspense>}
  </section>;
}
