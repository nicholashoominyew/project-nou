import { useState, type DragEvent, type KeyboardEvent } from "react";

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

/**
 * Drag-to-reorder for a list, using the six-dot grip ("⠿"). The grip is a button, so the keyboard works too: focus it and press the up or down arrow.
 * `onChange` gets the full new order of ids.
 */
export function useReorder(ids: string[], onChange: (ids: string[]) => void, disabled?: boolean) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const end = () => { setDragId(null); setOverId(null); };
  return {
    dragId, overId,
    /** Spread on the row (any element that holds one item). */
    rowProps: (id: string) => ({
      "data-reorder-id": id,
      className: (dragId === id ? "reorder-dragging " : "") + (overId === id && dragId && dragId !== id ? "reorder-over" : ""),
      onDragOver: (e: DragEvent) => { if (dragId && !disabled) { e.preventDefault(); if (overId !== id) setOverId(id); } },
      onDrop: (e: DragEvent) => { if (dragId && !disabled) { e.preventDefault(); const next = moveBefore(ids, dragId, id); if (next !== ids) onChange(next); end(); } },
    }),
    /** Spread on the grip button. */
    gripProps: (id: string, label: string) => ({
      type: "button" as const, className: "grip", "aria-label": `Drag ${label} to reorder. With the keyboard, press the up or down arrow.`, title: disabled ? "Reordering is off" : "Drag to reorder", disabled, draggable: !disabled,
      onDragStart: (e: DragEvent) => { e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; setDragId(id); },
      onDragEnd: end,
      onKeyDown: (e: KeyboardEvent) => {
        if (disabled || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault(); const next = nudge(ids, id, e.key === "ArrowUp" ? -1 : 1); if (next !== ids) onChange(next);
      },
    }),
  };
}
export const GRIP = "⠿";
