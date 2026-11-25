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
/** The sections of the Home page, as the app declares them (a test keeps this in step with HOME_WIDGETS). An assistant may ask to show or hide these. */
export const HOME_WIDGET_INFO: { id: string; title: string }[] = [
  { id: "now", title: "Now" }, { id: "daily", title: "Daily page" }, { id: "calendar", title: "Calendar" }, { id: "teaching", title: "Teaching of the day" },
  { id: "clocks", title: "Clocks" }, { id: "tasks", title: "Today's tasks" }, { id: "weather", title: "Weather" }, { id: "periods", title: "Year, quarter, month and day" },
  { id: "countdowns", title: "Countdowns" }, { id: "goals", title: "Goals" }, { id: "approvals", title: "Waiting for approval" }, { id: "recent", title: "Recently edited" }, { id: "favorites", title: "Favorites" },
  { id: "resurface", title: "Worth revisiting" },
];
export const HOME_WIDGET_IDS = HOME_WIDGET_INFO.map(w => w.id);
/** The one section a request can never hide: it is where the owner sees what assistants have asked for. */
export const HOME_NEVER_HIDDEN = "approvals";
/** Sent after a change to the stored layout from outside Home (an approved request), so an open Home page updates at once. */
export const HOME_LAYOUT_EVENT = "nou:home-layout-changed";
