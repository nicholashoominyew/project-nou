import { invoke } from "@tauri-apps/api/core";
import { now } from "./timetable/clock";
import { localDay, type Checkin, type CheckinEvent, type Habit, type LogEntry } from "./habitsLogic";

/** Sent after anything that changes habits, their log or the check-ins, so every open screen reads again. */
export const HABITS_CHANGED = "nou-habits-changed";
export const CHECKINS_CHANGED = "nou-checkins-changed";
export const announceHabits = () => { try { window.dispatchEvent(new Event(HABITS_CHANGED)); } catch { /* only a refresh hint */ } };
export const announceCheckins = () => { try { window.dispatchEvent(new Event(CHECKINS_CHANGED)); } catch { /* only a refresh hint */ } };
/** The device clock (or the simulated one in a development build) as whole seconds, which is what the backend wants. */
export const nowSecs = () => Math.floor(now().getTime() / 1000);
/** Ask for a pop-up to be shown now, for a habit, to see that pop-ups and notifications work on this computer. Nothing is recorded until it is answered. */
export const TEST_CHECKIN = "nou-test-checkin";
export const testCheckin = (habit: { id: string; name: string }) => { try { window.dispatchEvent(new CustomEvent(TEST_CHECKIN, { detail: { id: habit.id, name: habit.name } })); } catch { /* only a request */ } };
export const todayLocal = () => localDay(now());
export type ImportRow = { day: string; habit: string; done: boolean };

export const habitsApi = {
  list: () => invoke<Habit[]>("habits_list_cmd"),
  add: (name: string, days?: number, category?: string) => invoke<Habit>("habit_add_cmd", { name, days: days ?? null, category: category ?? null }),
  update: (id: string, patch: { name?: string; days?: number; category?: string }) => invoke<Habit>("habit_update_cmd", { id, name: patch.name ?? null, days: patch.days ?? null, category: patch.category ?? null }),
  linkActivity: (habitId: string, activityId: string) => invoke<void>("habit_link_activity_cmd", { habitId, activityId }),
  reorder: (ids: string[]) => invoke<void>("habits_reorder_cmd", { ids }),
  remove: (id: string) => invoke<void>("habit_delete_cmd", { id }),
  log: (from: string, to: string) => invoke<LogEntry[]>("habit_log_list_cmd", { from, to }),
  set: (day: string, habitId: string, state: "done" | "skipped" | null) => invoke<void>("habit_log_set_cmd", { day, habitId, state, today: todayLocal(), now: nowSecs() }),
  import: (rows: ImportRow[]) => invoke<{ habits_added: number; entries_added: number; entries_kept: number }>("habit_import_cmd", { rows }),
  checkins: () => invoke<Checkin[]>("checkin_list_cmd"),
  show: (checkinId: string, day: string, block: string, until = 0) => invoke<CheckinEvent | null>("checkin_event_show_cmd", { checkinId, day, block, now: nowSecs(), until }),
  pending: () => invoke<CheckinEvent[]>("checkin_events_pending_cmd", { now: nowSecs() }),
  answer: (checkinId: string, day: string, answer: "done" | "skipped") => invoke<LogEntry>("checkin_event_answer_cmd", { checkinId, day, answer, now: nowSecs() }),
  sweep: (closed: boolean) => invoke<number>("checkin_events_sweep_cmd", { now: nowSecs(), closed }),
};
