import { useCallback, useEffect, useState } from "react";
import { CHECKINS_CHANGED, habitsApi, HABITS_CHANGED, loadTargets, todayLocal } from "./habitsApi";
import { indexLog, type Checkin, type CheckinEvent, type Habit, type LogEntry, type LogMap } from "./habitsLogic";

/** The habits, their whole log and the open pop-ups, read again whenever anything changes them. */
export function useHabits() {
  const [habits, setHabits] = useState<Habit[] | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<CheckinEvent[]>([]);
  const [error, setError] = useState("");
  const [today, setToday] = useState(todayLocal);
  const [targets, setTargets] = useState(loadTargets);
  const load = useCallback(async () => {
    setTargets(loadTargets());
    try {
      const day = todayLocal(); setToday(day);
      const [h, l, p] = await Promise.all([habitsApi.list(), habitsApi.log("2000-01-01", day), habitsApi.pending()]);
      setHabits(Array.isArray(h) ? h : []); setEntries(Array.isArray(l) ? l : []); setPending(Array.isArray(p) ? p : []); setError("");
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); setHabits(old => old ?? []); }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener(HABITS_CHANGED, load);
    const id = window.setInterval(() => void load(), 30000); // also picks up a new day and expired pop-ups
    return () => { window.removeEventListener(HABITS_CHANGED, load); window.clearInterval(id); };
  }, [load]);
  const log: LogMap = indexLog(entries);
  return { habits, entries, log, pending, targets, today, error, reload: load, setError };
}

/** The habits and the timetable check-ins, for the timetable page (the editor's check-in setting and the bell on a block). Read again when either changes. */
export function useCheckinData() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const load = useCallback(async () => {
    try { const [h, c] = await Promise.all([habitsApi.list(), habitsApi.checkins()]); setHabits(Array.isArray(h) ? h : []); setCheckins(Array.isArray(c) ? c : []); } catch { /* the timetable still works without them */ }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener(HABITS_CHANGED, load); window.addEventListener(CHECKINS_CHANGED, load);
    return () => { window.removeEventListener(HABITS_CHANGED, load); window.removeEventListener(CHECKINS_CHANGED, load); };
  }, [load]);
  /** The ids of the habits that check in for a block (week, day, first slot, end slot). */
  const habitsAt = useCallback((variant: "A" | "B", day: number, start: number, end: number) => checkins.filter(k => k.variant === variant && k.weekday === day && k.start_slot === start && k.end_slot === end).map(k => k.habit_id), [checkins]);
  return { habits, checkins, habitsAt, reload: load };
}
