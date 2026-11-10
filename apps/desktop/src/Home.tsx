import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icons";
import type { PageInfo } from "./EditorContext";
import { DEFAULT_LAYOUT_KEY, moveWidget, normalizeLayout, setWidgetHidden, type HomeLayout } from "./homeLayout";

/** What every widget may use. Widgets never reach into the app directly; later features (inbox, approvals, bot queue,
 * resurfacing) plug in by adding an entry to HOME_WIDGETS with a render function over this context. */
export type HomeContext = { pages: PageInfo[]; open: (id: string) => void; searchTag: (tag: string) => void; disabled: boolean };
export type HomeWidget = { id: string; title: string; hint?: string; render: (ctx: HomeContext) => ReactNode };

type Recent = { id: string; title: string; updated_at: string };
type TagCount = { name: string; count: number };

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
  useEffect(() => { let off = false; void invoke<Recent[]>("list_recent_pages", { limit: 8 }).then(r => { if (!off) setRows(Array.isArray(r) ? r : []); }).catch(() => { if (!off) setRows([]); }); return () => { off = true; }; }, [ctx.pages]);
  if (rows === null) return <p className="hint">Loading…</p>;
  if (!rows.length) return <p className="hint">Nothing edited yet.</p>;
  return <ul className="home-list">{rows.map(r => <li key={r.id}><button disabled={ctx.disabled} onClick={() => ctx.open(r.id)}><span>{r.title}</span><em>{ago(r.updated_at)}</em></button></li>)}</ul>;
}

function FavoritesWidget({ ctx }: { ctx: HomeContext }) {
  const favorites = ctx.pages.filter(p => p.is_favorite);
  if (!favorites.length) return <p className="hint">Star a page from its ⋯ menu to pin it here.</p>;
  return <ul className="home-list">{favorites.map(p => <li key={p.id}><button disabled={ctx.disabled} onClick={() => ctx.open(p.id)}><Icon name={p.icon} size={15} /><span>{p.title}</span></button></li>)}</ul>;
}

function TagsWidget({ ctx }: { ctx: HomeContext }) {
  const [tags, setTags] = useState<TagCount[] | null>(null);
  useEffect(() => { let off = false; void invoke<TagCount[]>("list_tags").then(t => { if (!off) setTags(Array.isArray(t) ? t : []); }).catch(() => { if (!off) setTags([]); }); return () => { off = true; }; }, [ctx.pages]);
  if (tags === null) return <p className="hint">Loading…</p>;
  if (!tags.length) return <p className="hint">Add tags under a page title and they show up here.</p>;
  return <div className="home-tags">{tags.map(t => <button key={t.name} disabled={ctx.disabled} onClick={() => ctx.searchTag(t.name)}>#{t.name}<em>{t.count}</em></button>)}</div>;
}

export const HOME_WIDGETS: HomeWidget[] = [
  { id: "recent", title: "Recently edited", render: ctx => <RecentWidget ctx={ctx} /> },
  { id: "favorites", title: "Favorites", render: ctx => <FavoritesWidget ctx={ctx} /> },
  { id: "tags", title: "Tags", hint: "Click a tag to find its pages", render: ctx => <TagsWidget ctx={ctx} /> },
];

function readLayout(): unknown { try { return JSON.parse(localStorage.getItem(DEFAULT_LAYOUT_KEY) || "null"); } catch { return null; } }
function writeLayout(layout: HomeLayout) { try { localStorage.setItem(DEFAULT_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* a preference only; the page still works */ } }

export default function Home({ pages, open, searchTag, newPage, disabled, widgets = HOME_WIDGETS }: { pages: PageInfo[]; open: (id: string) => void; searchTag: (tag: string) => void; newPage: () => void; disabled: boolean; widgets?: HomeWidget[] }) {
  const ids = useMemo(() => widgets.map(w => w.id), [widgets]);
  const [layout, setLayout] = useState<HomeLayout>(() => normalizeLayout(readLayout(), ids));
  const [editing, setEditing] = useState(false);
  const update = (next: HomeLayout) => { setLayout(next); writeLayout(next); };
  const byId = new Map(widgets.map(w => [w.id, w]));
  const visible = layout.order.filter(id => !layout.hidden.includes(id)).map(id => byId.get(id)!).filter(Boolean);
  const hidden = layout.order.filter(id => layout.hidden.includes(id)).map(id => byId.get(id)!).filter(Boolean);
  const ctx: HomeContext = { pages, open, searchTag, disabled };
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return <div className="home" aria-label="Home">
    <header className="home-head">
      <div><span className="big-mark" aria-hidden="true">脳</span><h1>{greeting}</h1><p className="hint">{pages.length ? pages.length + " page" + (pages.length === 1 ? "" : "s") + " in your workspace" : "Your knowledge, your device."}</p></div>
      <div className="home-actions">
        <button disabled={disabled} onClick={newPage}>{pages.length ? "New page" : "Create your first page"}</button>
        <button aria-pressed={editing} onClick={() => setEditing(v => !v)}>{editing ? "Done" : "Customize"}</button>
      </div>
    </header>
    <div className="home-grid">
      {visible.map((w, i) => <section key={w.id} className="home-card" aria-label={w.title}>
        <header><h2>{w.title}</h2>
          {editing && <span className="home-card-tools">
            <button aria-label={"Move " + w.title + " up"} disabled={i === 0} onClick={() => update(moveWidget(layout, w.id, -1))}>↑</button>
            <button aria-label={"Move " + w.title + " down"} disabled={i === visible.length - 1} onClick={() => update(moveWidget(layout, w.id, 1))}>↓</button>
            <button aria-label={"Hide " + w.title} onClick={() => update(setWidgetHidden(layout, w.id, true))}>Hide</button>
          </span>}
        </header>
        {w.hint && !editing && <p className="hint home-hint">{w.hint}</p>}
        {w.render(ctx)}
      </section>)}
      {!visible.length && <p className="hint">All widgets are hidden. Choose Customize to bring some back.</p>}
    </div>
    {editing && hidden.length > 0 && <section className="home-hidden" aria-label="Hidden widgets"><h2>Hidden widgets</h2>
      {hidden.map(w => <button key={w.id} onClick={() => update(setWidgetHidden(layout, w.id, false))}>Show {w.title}</button>)}</section>}
  </div>;
}
