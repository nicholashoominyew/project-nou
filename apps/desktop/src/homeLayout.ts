/** Home page layout: which widgets exist, in what order, and which are hidden. Pure functions so it is easy to test. */
export type HomeLayout = { order: string[]; hidden: string[] };

/**
 * Make any stored value safe to use: unknown widget ids are dropped, duplicates removed, widgets the stored layout
 * has never seen (for example a widget added in a later version) are appended, and `hidden` only names real widgets.
 */
export function normalizeLayout(raw: unknown, known: string[]): HomeLayout {
  const value = (raw && typeof raw === "object" ? raw : {}) as { order?: unknown; hidden?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const order: string[] = [];
  for (const id of list(value.order)) if (known.includes(id) && !order.includes(id)) order.push(id);
  for (const id of known) if (!order.includes(id)) order.push(id);
  const hidden: string[] = [];
  for (const id of list(value.hidden)) if (order.includes(id) && !hidden.includes(id)) hidden.push(id);
  return { order, hidden };
}

/** Move a widget one step among the visible ones (hidden widgets keep their place). */
export function moveWidget(layout: HomeLayout, id: string, step: -1 | 1): HomeLayout {
  const visible = layout.order.filter(w => !layout.hidden.includes(w));
  const at = visible.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= visible.length) return layout;
  const swapWith = visible[to];
  const order = [...layout.order];
  const a = order.indexOf(id), b = order.indexOf(swapWith);
  [order[a], order[b]] = [order[b], order[a]];
  return { ...layout, order };
}

export function setWidgetHidden(layout: HomeLayout, id: string, hidden: boolean): HomeLayout {
  if (!layout.order.includes(id)) return layout;
  const rest = layout.hidden.filter(h => h !== id);
  return { ...layout, hidden: hidden ? [...rest, id] : rest };
}

export const DEFAULT_LAYOUT_KEY = "nou-home-layout";
