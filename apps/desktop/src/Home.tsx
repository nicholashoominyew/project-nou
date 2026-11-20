import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icons";
import type { PageInfo } from "./EditorContext";
import Approvals from "./Approvals";
import { CardHead, StateDot } from "./HomeBits";
import { CalendarWidget, ClocksWidget, CountdownWidget, DailyWidget, PeriodsWidget, SunArc, TasksWidget, TeachingWidget, WeatherWidget, useWeatherStore, type WeatherStore } from "./HomePanels";
import NowCard from "./timetable/NowCard";
import { editsPerDay, staleFraction } from "./homeLogic";
import { localDate, readSnoozed, reasonText, snooze, visible, SNOOZE_KEY, SNOOZE_DAYS, type Resurfaced } from "./resurface";
import { DEFAULT_LAYOUT_KEY, normalizeLayout, setWidgetHidden, type HomeLayout } from "./homeLayout";

/** What every widget may use. Widgets never reach into the app directly; later features plug in by adding an entry to HOME_WIDGETS with a render function over this context. */
export type HomeContext = { pages: PageInfo[]; open: (id: string) => void; today: string; openDaily: () => void; disabled: boolean; refresh: () => Promise<void>; weather?: WeatherStore; openTimetable?: () => void };
/**
 * Where a widget sits: `daily` is the slim strip, `left` and `right` are the two columns under it (left is twice as wide), `row1` and `row2` are the rows of cards below.
 * A `bare` widget draws its own heading (the calendar has its month buttons there, the clocks have their seconds); every other widget gets the standard one.
 */
export type HomeSlot = "top" | "daily" | "left" | "right" | "row1" | "row2";
export type HomeWidget = { id: string; title: string; hint?: string; live?: boolean; slot?: HomeSlot; bare?: boolean; render: (ctx: HomeContext) => ReactNode };

type Recent = { id: string; title: string; updated_at: string };

function ago(stamp: string): string {
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " h ago";
  const days = Math.round(hours / 24);
  return days < 30 ? days + " d ago" : new Date(then).toLocaleDateString();
}

function RecentWidget({ ctx }: { ctx: HomeContext }) {
  const [rows, setRows] = useState<Recent[] | null>(null);
  // Reload when the page list changes (a save or rename refreshes it), so the widget stays current.
  useEffect(() => { let off = false; void invoke<Recent[]>("list_recent_pages", { limit: 40 }).then(r => { if (!off) setRows(Array.isArray(r) ? r : []); }).catch(() => { if (!off) setRows([]); }); return () => { off = true; }; }, [ctx.pages]);
  if (rows === null) return <p className="hint">Loading…</p>;
  if (!rows.length) return <p className="hint">Nothing edited yet.</p>;
  const bars = editsPerDay(rows.map(r => r.updated_at), new Date()), top = Math.max(1, ...bars);
  return <>
    <div className="spark" role="img" aria-label={"Pages edited each day, last 14 days: " + bars.reduce((a, b) => a + b, 0) + " in total"}>
      {bars.map((n, i) => <i key={i} className={i === bars.length - 1 ? "today" : ""} style={{ height: 4 + (n / top) * 28 + "px", animationDelay: i * 0.03 + "s" }} />)}
    </div>
    <ul className="home-list">{rows.slice(0, 8).map((r, i) => <li key={r.id}><button disabled={ctx.disabled} onClick={() => ctx.open(r.id)}><i className="fade-dot" style={{ opacity: Math.max(0.25, 1 - i * 0.1) }} aria-hidden="true" /><span>{r.title}</span><em>{ago(r.updated_at)}</em></button></li>)}</ul>
  </>;
}

function FavoritesWidget({ ctx }: { ctx: HomeContext }) {
  const favorites = ctx.pages.filter(p => p.is_favorite);
  if (!favorites.length) return <p className="hint">Star a page from its ⋯ menu to pin it here.</p>;
  return <ul className="fav-grid">{favorites.map(p => <li key={p.id}><button className="nou-tile" disabled={ctx.disabled} onClick={() => ctx.open(p.id)}><Icon name={p.icon} size={18} /><span>{p.title}</span></button></li>)}</ul>;
}

/**
 * Old notes worth another look: pages you have not edited for a month or more (a different few each day) and notes you wrote on this date in an
 * earlier year. "Later" hides a note for two weeks. The snooze is only a preference kept on this computer.
 */
function ResurfaceWidget({ ctx }: { ctx: HomeContext }) {
  const today = useMemo(() => localDate(), []);
  const [items, setItems] = useState<Resurfaced[] | null>(null);
  const [snoozed, setSnoozed] = useState<Record<string, string>>(() => { try { return readSnoozed(JSON.parse(localStorage.getItem(SNOOZE_KEY) || "null"), today); } catch { return {}; } });
  useEffect(() => {
    let off = false;
    // Ask for a few extra so snoozed ones can be skipped and the widget still shows up to three.
    void invoke<Resurfaced[]>("list_resurfaced_pages", { today, staleLimit: 8, anniversaryLimit: 4 }).then(r => { if (!off) setItems(Array.isArray(r) ? r : []); }).catch(() => { if (!off) setItems([]); });
    return () => { off = true; };
  }, [today, ctx.pages]);
  function later(id: string) {
    const next = snooze(snoozed, id, today);
    setSnoozed(next);
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)); } catch { /* a preference only */ }
  }
  if (items === null) return <p className="hint">Loading…</p>;
  const shown = visible(items, snoozed, today);
  const anniversaries = shown.filter(p => p.reason === "anniversary").slice(0, 3), stale = shown.filter(p => p.reason !== "anniversary").slice(0, 3);
  const list = [...anniversaries, ...stale];
  if (!list.length) return <p className="hint">{items.length ? "Nothing else to revisit today." : "No old notes to bring back yet. Notes you have not touched for a month will appear here."}</p>;
  return <ul className="home-list resurface">{list.map(p => <li key={p.id}>
    <button disabled={ctx.disabled} onClick={() => ctx.open(p.id)}><span>{p.title || "Untitled"}</span><em>{reasonText(p)}</em></button>
    <span className="mini-bar" aria-hidden="true"><i style={{ width: staleFraction((Date.now() - Date.parse(p.updated_at)) / 86400000) * 100 + "%" }} /></span>
    <button className="resurface-later" aria-label={`Not now: ${p.title || "Untitled"}`} title={`Hide for ${SNOOZE_DAYS} days`} onClick={() => later(p.id)}>Later</button>
  </li>)}</ul>;
}

/** The standard order is the order on the screen: the daily strip, then the calendar column, the clocks column, then two rows of cards. */
export const HOME_WIDGETS: HomeWidget[] = [
  { id: "now", title: "Now", slot: "top", bare: true, render: ctx => <NowCard open={ctx.openTimetable} /> },
  { id: "daily", title: "Daily page", slot: "daily", bare: true, render: ctx => <DailyWidget ctx={ctx} /> },
  { id: "calendar", title: "Calendar", slot: "left", bare: true, render: ctx => <CalendarWidget ctx={ctx} /> },
  { id: "teaching", title: "Teaching of the day", slot: "left", bare: true, render: ctx => <TeachingWidget today={ctx.today} /> },
  { id: "clocks", title: "Clocks", slot: "right", bare: true, render: () => <ClocksWidget /> },
  { id: "tasks", title: "Today's tasks", slot: "right", bare: true, render: ctx => <TasksWidget disabled={ctx.disabled} /> },
  { id: "weather", title: "Weather", slot: "right", bare: true, render: ctx => <WeatherWidget store={ctx.weather} /> },
  { id: "periods", title: "Year, quarter, month and day", live: true, slot: "row1", render: () => <PeriodsWidget /> },
  { id: "countdowns", title: "Countdowns", slot: "row1", render: () => <CountdownWidget /> },
  { id: "approvals", title: "Waiting for approval", live: true, slot: "row1", hint: "AI tools can ask; only you can approve", render: ctx => <Approvals disabled={ctx.disabled} refresh={ctx.refresh} /> },
  { id: "recent", title: "Recently edited", live: true, slot: "row2", render: ctx => <RecentWidget ctx={ctx} /> },
  { id: "favorites", title: "Favorites", live: true, slot: "row2", render: ctx => <FavoritesWidget ctx={ctx} /> },
  { id: "resurface", title: "Worth revisiting", slot: "row2", hint: "Old notes, and what you wrote on this day", render: ctx => <ResurfaceWidget ctx={ctx} /> },
];

function readLayout(): unknown { try { return JSON.parse(localStorage.getItem(DEFAULT_LAYOUT_KEY) || "null"); } catch { return null; } }
function writeLayout(layout: HomeLayout) { try { localStorage.setItem(DEFAULT_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* a preference only; the page still works */ } }

export default function Home({ pages, open, openDaily, newPage, disabled, refresh = async () => {}, onManageAccess, openTimetable, widgets = HOME_WIDGETS }: { pages: PageInfo[]; open: (id: string) => void; openDaily: () => void; newPage: () => void; disabled: boolean; refresh?: () => Promise<void>; onManageAccess?: () => void; openTimetable?: () => void; widgets?: HomeWidget[] }) {
  const ids = useMemo(() => widgets.map(w => w.id), [widgets]);
  const [layout, setLayout] = useState<HomeLayout>(() => normalizeLayout(readLayout(), ids));
  const [editing, setEditing] = useState(false);
  const update = (next: HomeLayout) => { setLayout(next); writeLayout(next); };
  const weather = useWeatherStore();
  const byId = new Map(widgets.map(w => [w.id, w]));
  // The arrangement is fixed, so sections follow the order they are declared in; only what is hidden is remembered.
  const shown = widgets.filter(w => !layout.hidden.includes(w.id));
  const hidden = layout.order.filter(id => layout.hidden.includes(id)).map(id => byId.get(id)!).filter(Boolean);
  const today = useMemo(() => localDate(), []);
  const ctx: HomeContext = { pages, open, today, openDaily, disabled, refresh, weather, openTimetable };
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const long = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const inSlot = (slot: HomeSlot) => shown.filter(w => (w.slot ?? "row2") === slot);
  const hideButton = (w: HomeWidget) => editing && <button className="card-hide" aria-label={"Hide " + w.title} onClick={() => update(setWidgetHidden(layout, w.id, true))}>Hide</button>;
  const card = (w: HomeWidget) => <section key={w.id} className={"home-card w-" + w.id + (w.bare ? " bare" : "") + (editing ? " editing" : "")} aria-label={w.title}>
    {!w.bare && <CardHead title={w.title} live={w.live} />}
    {w.hint && !w.bare && !editing && <p className="hint home-hint">{w.hint}</p>}
    {w.render(ctx)}
    {hideButton(w)}
  </section>;
  const left = inSlot("left"), right = inSlot("right"), row1 = inSlot("row1"), row2 = inSlot("row2");

  return <div className="home" aria-label="Home">
    <header className="home-head">
      <div><span className="big-mark" aria-hidden="true">脳</span><h1>{greeting}</h1><p className="hint">{long} · {pages.length ? pages.length + " page" + (pages.length === 1 ? "" : "s") : "your knowledge, your device"}</p></div>
      <div className="home-actions">
        <SunArc store={weather} />
        <button className="primary" disabled={disabled} onClick={newPage}>{pages.length ? "New page" : "Create your first page"}</button>
        <button className="icon-button" aria-label="Customize" title="Customize Home" aria-pressed={editing} onClick={() => setEditing(v => !v)}><Icon name="settings" size={17} /></button>
      </div>
    </header>
    {editing && <section className="home-customize" aria-label="Customize Home"><p className="hint">Hide or show the sections below. The layout itself is fixed.</p>
      {onManageAccess && <button onClick={onManageAccess}><Icon name="hub" size={15} /> AI access</button>}
      <button onClick={() => setEditing(false)}>Done</button></section>}
    {inSlot("top").map(w => <section key={w.id} className={"home-card top bare w-" + w.id + (editing ? " editing" : "")} aria-label={w.title}>{w.render(ctx)}{hideButton(w)}</section>)}
    {inSlot("daily").map(w => <section key={w.id} className={"home-card strip bare w-" + w.id + (editing ? " editing" : "")} aria-label={w.title}>{w.render(ctx)}{hideButton(w)}</section>)}
    {(left.length > 0 || right.length > 0) && <div className="home-grid">
      {left.length > 0 && <div className="home-col span2">{left.map(card)}</div>}
      {right.length > 0 && <div className="home-col">{right.map(card)}</div>}
    </div>}
    {row1.length > 0 && <div className="home-row">{row1.map(card)}</div>}
    {row2.length > 0 && <div className="home-row">{row2.map(card)}</div>}
    {!shown.length && <p className="hint">All widgets are hidden. Open the gear to bring some back.</p>}
    {editing && hidden.length > 0 && <section className="home-hidden" aria-label="Hidden widgets"><h2><StateDot />Hidden widgets</h2>
      {hidden.map(w => <button key={w.id} onClick={() => update(setWidgetHidden(layout, w.id, false))}>Show {w.title}</button>)}</section>}
  </div>;
}
