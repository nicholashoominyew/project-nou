import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildGrids, variantFor, type Activity, type Timeline, type SlotRow, type Variant } from "./schedule";

export interface Cell { weekday: number; slot_index: number; activity_ids: string[] }
export interface TimetableData { system_page_id: string | null; swap_ab: boolean; activities: Activity[]; slots: SlotRow[]; edited: { a: boolean; b: boolean } }
const CHANGED = "nou-timetable-changed";
const announce = () => window.dispatchEvent(new Event(CHANGED));

function valid(v: unknown): v is TimetableData {
  const d = v as TimetableData | null;
  return !!d && Array.isArray(d.activities) && Array.isArray(d.slots);
}

/** The timetable from the database. Every part of the window that shows it re-reads when any of them saves, so edits show up at once without a restart. */
export function useTimetable() {
  const [data, setData] = useState<TimetableData | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { const v = await invoke<TimetableData>("timetable_get"); if (valid(v)) { setData(v); setError(""); } }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { void load(); window.addEventListener(CHANGED, load); return () => window.removeEventListener(CHANGED, load); }, [load]);
  const swap = !!data?.swap_ab;
  const timeline: Timeline = useMemo(() => ({ grids: buildGrids((data?.slots ?? []).map(s => ({ ...s, variant: s.variant === "B" ? "B" : "A" }))), swap }), [data, swap]);
  const activities = data?.activities ?? [];
  /** The variant that is this week's, for a given moment. */
  const variantNow = useCallback((at: Date): Variant => variantFor(at, swap), [swap]);
  return { data, timeline, activities, swap, error, reload: load, variantNow };
}

export async function saveRange(variant: Variant, weekdays: number[], start: number, end: number, activityIds: string[]): Promise<Cell[]> {
  const before = await invoke<Cell[]>("timetable_save_range", { variant, weekdays, start, end, activityIds }); announce(); return before ?? [];
}
export async function restoreCells(variant: Variant, cells: Cell[]) { await invoke("timetable_restore_cells", { variant, cells }); announce(); }
export async function resetVariant(variant: Variant) { await invoke("timetable_reset_variant", { variant }); announce(); }
export async function setSwap(swap: boolean) { await invoke("timetable_set_swap", { swap }); announce(); }
export async function addActivity(name: string, category: string): Promise<Activity> { const a = await invoke<Activity>("timetable_add_activity", { name, category }); announce(); return a; }
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
