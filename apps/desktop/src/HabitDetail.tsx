import { useEffect, useRef, useState } from "react";
import { appliesOn, addDays, HABIT_TYPES, logKey, maskHas, maskLabel, maskToggle, startDay, streaks, WEEKDAYS, type Habit, type LogMap } from "./habitsLogic";

/** Everything about one habit in a window: its streaks and numbers, and where its name, type and days are changed. Opened by clicking the habit. */
export default function HabitDetail({ habit, log, today, disabled, onClose, onChange, onDelete }: {
  habit: Habit; log: LogMap; today: string; disabled?: boolean; onClose: () => void;
  onChange: (patch: { name?: string; days?: number; category?: string }) => void; onDelete: () => void;
}) {
  const [name, setName] = useState(habit.name);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setName(habit.name); }, [habit.name]);
  useEffect(() => { ref.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const { current, best } = streaks(habit, log, today);
  let done = 0, total = 0, last30 = 0, last30total = 0;
  const from30 = addDays(today, -29);
  for (let day = startDay(habit), guard = 0; day <= today && guard < 4000; day = addDays(day, 1), guard++) {
    if (!appliesOn(habit, day)) continue;
    total++; const d = log.get(logKey(day, habit.id))?.state === "done"; if (d) done++;
    if (day >= from30) { last30total++; if (d) last30++; }
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + "%" : "–");
  const strip = Array.from({ length: 35 }, (_, i) => addDays(today, i - 34));
  const rename = () => { const n = name.trim(); if (n && n !== habit.name) onChange({ name: n }); else setName(habit.name); };
  return <div className="hb-modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="hb-modal" role="dialog" aria-modal="true" aria-label={`${habit.name} details`} tabIndex={-1} ref={ref}>
      <div className="hb-modal-head">
        <input aria-label="Habit name" className="hb-modal-name" maxLength={60} value={name} disabled={disabled} onChange={e => setName(e.target.value)} onBlur={rename} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <button type="button" className="tt-btn small" onClick={onClose} aria-label="Close">Close</button>
      </div>
      <div className="hb-stats" aria-label="Streaks and totals">
        <div><b>{current}</b><span>Current streak</span></div>
        <div><b>{best}</b><span>Longest streak</span></div>
        <div><b>{pct(last30, last30total)}</b><span>Last 30 days</span></div>
        <div><b>{done}</b><span>Days done · {pct(done, total)} of {total}</span></div>
      </div>
      <div className="hb-strip" role="img" aria-label="The last 35 days, oldest first">{strip.map(day => { const s = log.get(logKey(day, habit.id))?.state; return <i key={day} className={(s === "done" ? "done " : "") + (appliesOn(habit, day) ? "" : "off")} title={`${day}: ${s === "done" ? "done" : appliesOn(habit, day) ? "not done" : "not a day for this habit"}`} />; })}</div>
      <label className="hb-field">Type<select value={HABIT_TYPES.includes(habit.category as never) ? habit.category : "Health"} disabled={disabled} onChange={e => onChange({ category: e.target.value })}>{HABIT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      <div className="hb-field">Days it counts <span className="hint">({maskLabel(habit.days)})</span>
        <span className="hb-days" role="group" aria-label={`Days for ${habit.name}`}>{WEEKDAYS.map((d, i) => <button key={d} type="button" className={"tt-toggle" + (maskHas(habit.days, i) ? " on" : "")} aria-pressed={maskHas(habit.days, i)} disabled={disabled} onClick={() => { const next = maskToggle(habit.days, i); if (next > 0) onChange({ days: next }); }}>{d}</button>)}</span></div>
      <p className="hint">This habit is also an activity in the Life Timetable. Put it on a block there; its check-in comes at the start of that block.</p>
      <div className="hb-modal-foot"><button type="button" className="tt-text-btn danger" disabled={disabled} onClick={onDelete}>Delete habit</button></div>
    </div>
  </div>;
}
