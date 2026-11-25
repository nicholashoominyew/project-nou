import { useState } from "react";
import { Icon } from "../Icons";
import { isSimulated, now, simulate, simulationAllowed } from "./clock";
import { readReminderSettings, writeReminderSettings } from "./reminders";

const pad = (n: number) => String(n).padStart(2, "0");
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Settings for the timetable reminders, plus (development builds only) a control that moves the app's clock so reminders can be tried without waiting. */
export default function ReminderSettings() {
  const [s, setS] = useState(readReminderSettings);
  const [sim, setSim] = useState(() => local(now()));
  const [, redraw] = useState(0);
  const save = (next: typeof s) => { setS(next); writeReminderSettings(next); };
  return <section className="settings-card tt-reminder-settings" aria-label="Timetable reminders">
    <span className="settings-icon" aria-hidden="true"><Icon name="bell" size={20} /></span>
    <div className="settings-text">
      <h2>Timetable reminders</h2>
      <p>Get a notice shortly before the next event in your Life Timetable starts. It appears in the app and as a Windows notification.</p>
      <label className="tt-check"><input type="checkbox" checked={s.on} onChange={e => save({ ...s, on: e.target.checked })} /> Remind me before the next event</label>
      <label className="tt-lead">Lead time <input type="number" min={1} max={30} value={s.lead} disabled={!s.on} aria-label="Reminder lead time in minutes" onChange={e => save({ ...s, lead: Math.min(30, Math.max(1, Math.round(Number(e.target.value)) || 5)) })} /> minutes before</label>
      {simulationAllowed && <fieldset className="tt-sim"><legend>Simulate time (development builds only)</legend>
        <input type="datetime-local" aria-label="Simulated local time" value={sim} onChange={e => setSim(e.target.value)} />
        <button onClick={() => { const d = new Date(sim); if (!Number.isNaN(d.getTime())) { simulate(d); redraw(n => n + 1); } }}>Set the app clock</button>
        <button disabled={!isSimulated()} onClick={() => { simulate(null); setSim(local(now())); redraw(n => n + 1); }}>Use the real time</button>
        <span className="hint">{isSimulated() ? "The app clock is simulated." : "Using the real time."}</span>
      </fieldset>}
    </div>
  </section>;
}
