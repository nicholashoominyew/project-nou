import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildGrid, type Activity, type Grid, type SlotRow } from "./schedule";

export interface TimetableData { system_page_id: string | null; activities: Activity[]; slots: SlotRow[] }
const CHANGED = "nou-timetable-changed";
const announce = () => window.dispatchEvent(new Event(CHANGED));

function valid(v: unknown): v is TimetableData {
  const d = v as TimetableData | null;
  return !!d && Array.isArray(d.activities) && Array.isArray(d.slots);
}

/** The timetable from the database. Every window part that shows it re-reads when any of them saves, so edits show up at once without a restart. */
export function useTimetable() {
  const [data, setData] = useState<TimetableData | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { const v = await invoke<TimetableData>("timetable_get"); if (valid(v)) { setData(v); setError(""); } }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { void load(); window.addEventListener(CHANGED, load); return () => window.removeEventListener(CHANGED, load); }, [load]);
  const grid: Grid = useMemo(() => buildGrid(data?.slots ?? []), [data]);
  const activities = data?.activities ?? [];
  return { data, grid, activities, error, reload: load };
}

export async function saveSlots(weekday: number, slots: number[], activityIds: string[]) { await invoke("timetable_set_slots", { weekday, slots, activityIds }); announce(); }
export async function copyDay(from: number, to: number[]) { await invoke("timetable_copy_day", { from, to }); announce(); }
export async function addActivity(name: string, category: string) { await invoke("timetable_add_activity", { name, category }); announce(); }
export async function updateActivity(a: Pick<Activity, "id" | "name" | "category" | "colour" | "remind">) { await invoke("timetable_update_activity", { activity: a }); announce(); }
export async function deleteActivity(id: string, reassignTo: string | null) { await invoke("timetable_delete_activity", { id, reassignTo }); announce(); }

/** Re-renders every `ms`, reading the clock fresh each time (never counting ticks), so sleep, travel and clock changes correct themselves. */
export function useTick(ms: number, read: () => Date): Date {
  const [t, setT] = useState(read);
  useEffect(() => {
    const go = () => setT(read());
    const id = setInterval(go, ms);
    const resume = () => { if (!document.hidden) go(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("focus", go); window.addEventListener("nou-sim-changed", go);
    go();
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", go); window.removeEventListener("nou-sim-changed", go); };
  }, [ms, read]);
  return t;
}
