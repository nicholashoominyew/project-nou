/** Keeps the old value when a refresh brings back exactly the same data, so a poll does not redraw anything that did not change. */
export function keep<T>(old: T, next: T): T {
  try { return JSON.stringify(old) === JSON.stringify(next) ? old : next; } catch { return next; }
}
