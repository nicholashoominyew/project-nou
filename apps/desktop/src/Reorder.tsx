import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

/** The ids with `id` moved to just before `beforeId` (or to the end when `beforeId` is null). Anything unknown leaves the order unchanged. */
export function moveBefore(ids: string[], id: string, beforeId: string | null): string[] {
  if (!ids.includes(id) || id === beforeId || (beforeId !== null && !ids.includes(beforeId))) return ids;
  const rest = ids.filter(x => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
/** The ids with `id` moved one place up (-1) or down (+1). */
export function nudge(ids: string[], id: string, by: -1 | 1): string[] {
  const i = ids.indexOf(id), j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = [...ids]; [out[i], out[j]] = [out[j], out[i]]; return out;
}
/** Where a dragged row would land for a pointer height: before the first row whose middle is below the pointer, or at the end. `rows` are the other rows, top to bottom. */
export function dropTarget(rows: { id: string; top: number; bottom: number }[], y: number): string | null {
  for (const r of rows) if (y < (r.top + r.bottom) / 2) return r.id;
  return null;
}

/**
 * Drag-to-reorder for a list, using the six-dot grip ("⠿"). It follows the pointer itself (press the grip, move, let go), so it does not depend on the browser's drag-and-drop,
 * which some windows handle badly. The grip is also a button, so the keyboard works: focus it and press the up or down arrow. `onChange` gets the full new order of ids.
 * Rows carry `data-reorder-id`; they are found inside the row's own list.
 */
export function useReorder(ids: string[], onChange: (ids: string[]) => void, disabled?: boolean) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null | undefined>(undefined); // undefined: not over anything; null: the end of the list
  const live = useRef({ ids, onChange }); live.current = { ids, onChange };
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  function begin(id: string, e: ReactPointerEvent<HTMLElement>) {
    if (disabled || e.button > 0) return;
    const list = (e.currentTarget.closest("[data-reorder-id]")?.parentElement) ?? null;
    if (!list) return;
    e.preventDefault(); setDragId(id);
    const rowsNow = () => [...list.querySelectorAll<HTMLElement>(":scope > [data-reorder-id]")].filter(el => el.dataset.reorderId !== id).map(el => { const r = el.getBoundingClientRect(); return { id: el.dataset.reorderId!, top: r.top, bottom: r.bottom }; });
    let target: string | null | undefined;
    const move = (m: PointerEvent) => { const rows = rowsNow(); target = rows.length ? dropTarget(rows, m.clientY) : undefined; setOverId(target); };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key); stop.current = null;
      setDragId(null); setOverId(undefined);
      if (commit && target !== undefined) { const was = live.current.ids, next = moveBefore(was, id, target); if (next.some((x, i) => x !== was[i])) live.current.onChange(next); }
    };
    const up = (m: PointerEvent) => { move(m); finish(true); }, cancel = () => finish(false), key = (k: globalThis.KeyboardEvent) => { if (k.key === "Escape") finish(false); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel); window.addEventListener("keydown", key); stop.current = () => finish(false);
  }
  return {
    dragId, overId,
    /** Spread on the row (any element that holds one item; all rows must share one parent). */
    rowProps: (id: string) => ({
      "data-reorder-id": id,
      className: (dragId === id ? "reorder-dragging " : "") + (dragId && dragId !== id && overId === id ? "reorder-over" : "") + (dragId && dragId !== id && overId === null && ids[ids.length - 1] === id ? "reorder-over-end" : ""),
    }),
    /** Spread on the grip button. */
    gripProps: (id: string, label: string) => ({
      type: "button" as const, className: "grip", "aria-label": `Drag ${label} to reorder. With the keyboard, press the up or down arrow.`, title: disabled ? "Reordering is off" : "Drag to reorder", disabled,
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => begin(id, e),
      onKeyDown: (e: KeyboardEvent) => {
        if (disabled || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault(); const next = nudge(ids, id, e.key === "ArrowUp" ? -1 : 1); if (next !== ids) onChange(next);
      },
    }),
  };
}
export const GRIP = "⠿";
