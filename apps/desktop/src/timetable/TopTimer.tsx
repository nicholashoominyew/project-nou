import { now } from "./clock";
import { ProgressRing } from "./CountdownRing";
import { clock, countdownParts, eventAt, names, progress } from "./schedule";
import { useTick, useTimetable } from "./useTimetable";

/**
 * A small timer for the app's top bar: a mini draining ring, the current event's name and the time left in it (h:mm:ss, or m:ss under an hour).
 * It shows nothing when no event is planned, and the app hides the whole top bar in focus mode. Clicking it opens the Life Timetable.
 */
export default function TopTimer({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  const { timeline, activities, data } = useTimetable();
  const t = useTick(1000, now);
  if (!data) return null;
  const ev = eventAt(timeline, t);
  if (!ev || !ev.ids.length) return null;
  const name = names(ev.ids, activities), left = ev.end.getTime() - t.getTime(), p = countdownParts(left);
  const label = `${name}, ${p.aria}`;
  return <button type="button" className="top-timer" disabled={disabled} onClick={onOpen} aria-label={`${label}. Open the Life Timetable`} title={`${name} · ${clock(ev.start)}–${clock(ev.end)} · open the Life Timetable`}>
    <span className="top-timer-ring" aria-hidden="true"><ProgressRing fraction={1 - progress(ev, t)} mini label="" /></span>
    <span className="top-timer-name">{name}</span>
    <span className="top-timer-time" role="timer" aria-label={p.aria}>{p.showH ? `${p.h}:${p.m}:${p.s}` : `${p.m}:${p.s}`}</span>
  </button>;
}
