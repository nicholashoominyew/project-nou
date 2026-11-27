import { useEffect, useState } from "react";
import { now } from "../timetable/clock";
import Calendar from "./Calendar";
import DayPage from "./DayPage";
import type { SaveState } from "./Journal";
import { londonDay } from "./logic";
import "./daily.css";

/** The Daily screen: the month calendar (`day` is null) or one day's page. */
export default function Daily({ day, disabled, focused, onDay, onFocusMode, onState }: {
  day: string | null; disabled: boolean; focused: boolean; onDay: (day: string | null) => void; onFocusMode: (on: boolean) => void; onState: (s: SaveState) => void;
}) {
  const [today, setToday] = useState(() => londonDay(now()));
  useEffect(() => { const id = window.setInterval(() => setToday(londonDay(now())), 30000); return () => window.clearInterval(id); }, []);
  // Leaving the page or the screen always ends focus mode, so the rest of the app is never left dimmed.
  useEffect(() => () => onFocusMode(false), [day, onFocusMode]);
  return day === null ? <Calendar today={today} disabled={disabled} onOpen={onDay} />
    : <DayPage key={day} day={day} today={today} disabled={disabled} focused={focused} onDay={onDay} onFocusMode={onFocusMode} onState={onState} />;
}
