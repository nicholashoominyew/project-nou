export type View = { k: number; x: number; y: number };
export type Wheel = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean };
export const MIN_ZOOM = 0.4, MAX_ZOOM = 4;

/**
 * What a wheel event means on the graph.
 *  - Pinch on a laptop trackpad arrives as a wheel event with Ctrl held: zoom, smoothly, by the amount of the pinch.
 *  - A mouse wheel (whole steps, or "lines") zooms a notch at a time.
 *  - Two-finger scrolling on a trackpad (small, often fractional, often sideways) pans the picture.
 */
export function wheelAction(e: Wheel): { type: "zoom"; factor: number } | { type: "pan"; dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  if (e.ctrlKey) return { type: "zoom", factor: Math.exp(-Math.max(-60, Math.min(60, e.deltaY * unit)) * 0.01) };
  const mouseNotch = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
  if (mouseNotch) return { type: "zoom", factor: e.deltaY < 0 ? 1.15 : 1 / 1.15 };
  return { type: "pan", dx: -e.deltaX * unit, dy: -e.deltaY * unit };
}

/** Zoom by `factor` keeping the point (cx, cy) of the picture where it is on screen. */
export function zoomAround(v: View, factor: number, cx: number, cy: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor)), r = k / v.k;
  return { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
}
