import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ActivitiesPanel from "./ActivitiesPanel";
import BlockEditor, { type EditorState } from "./BlockEditor";
import { now } from "./clock";
import Distribution from "./Distribution";
import NowPanel, { kickerOf } from "./NowPanel";
import { colours } from "./palette";
import { dayBlocks, fmtDuration, hm, names, otherVariant, weekdayOf, type Activity, type Block, type Variant } from "./schedule";
import { addActivity, resetVariant, restoreCells, saveRange, setSwap, useTick, useTimetable, type Cell } from "./useTimetable";
import { announceCheckins, habitsApi } from "../habitsApi";
import { useCheckinData } from "../useHabits";

const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEK_PX = 48, DAY_PX = 64; // pixels per hour
type Status = { state: "saved" | "saving" | "error"; message?: string };

type Zone = "top" | "bottom" | "move";
/** Which part of a block the pointer is on: the thin top and bottom edges stretch it, the rest moves it. */
function zoneOf(e: { clientY: number; currentTarget: HTMLElement }): Zone {
  const r = e.currentTarget.getBoundingClientRect(), y = e.clientY - r.top, edge = Math.min(8, r.height / 3);
  return y < edge ? "top" : r.height - y < edge ? "bottom" : "move";
}
interface Drag { day: number; start: number; end: number; from: Block; fromDay: number }
interface BlockActions { onEdit: (el: HTMLElement) => void; onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void; onMenu: (e: React.MouseEvent<HTMLButtonElement>) => void; onKey: (e: React.KeyboardEvent<HTMLButtonElement>) => void }

function BlockButton({ block, day, today, px, detailed, activities, live, nowMin, dragging, actions, checkins = [] }: { block: Block; day: number; today: number; px: number; detailed: boolean; activities: Activity[]; live: boolean; nowMin: number; dragging: boolean; actions: BlockActions; checkins?: string[] }) {
  const { onEdit } = actions;
  const acts = block.ids.map(id => activities.find(a => a.id === id)).filter((a): a is Activity => !!a);
  const n = acts.length, sp = px / 2, h = block.count * sp - 6;
  const isBed = n === 1 && acts[0].name.toLowerCase() === "bed time";
  const quiet = isBed || n === 0;
  const mins = block.count * 30, range = `${hm(block.first * 30)}–${hm((block.first + block.count) * 30)}`;
  const isCur = live && day === today && nowMin >= block.first * 30 && nowMin < (block.first + block.count) * 30;
  const single = n === 1 ? colours(acts[0]) : null;
  const label = n === 0 ? "Empty" : names(block.ids, activities);
  const stripe = n > 1 ? `linear-gradient(to right, ${acts.map((a, i) => `${colours(a).fill} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(", ")})` : "";
  const style: React.CSSProperties = {
    top: block.first * sp + 3, height: h, borderRadius: Math.floor(Math.min(h, 40) / 2),
    background: quiet ? "transparent" : n > 1 ? "var(--tt-shared)" : single!.fill,
    color: quiet ? "var(--muted)" : n > 1 ? "var(--text)" : single!.ink,
  };
  const title = `Edit ${label} · ${range}${n > 1 ? " · split equally" : ""}`;
  const bell = checkins.length ? ` · check-in: ${checkins.join(", ")}` : "";
  const real = n > 0; // a gap is not a block: it can be filled by clicking it, but not dragged, stretched or deleted
  return <button type="button" className={"tt-block" + (detailed ? " day" : "") + (isCur ? " current" : "") + (dragging ? " dragging" : "")} data-day={day} data-first={block.first} aria-current={isCur ? "time" : undefined} style={style} title={real ? title + bell + " · drag to move, drag an edge to stretch, right-click for more" : title} aria-label={title}
    onClick={e => onEdit(e.currentTarget)}
    onPointerDown={real ? actions.onPointerDown : undefined}
    onPointerMove={real ? e => { if (e.buttons === 0) e.currentTarget.style.cursor = zoneOf(e) === "move" ? "grab" : "ns-resize"; } : undefined}
    onContextMenu={real ? actions.onMenu : undefined}
    onKeyDown={real ? actions.onKey : undefined}>
    <span className={"tt-block-name" + (h >= 40 ? " wrap" : "")}>{label}</span>
    {h >= (detailed ? 44 : 52) && <span className="tt-block-range">{range}{detailed ? " · " + fmtDuration(mins) : ""}</span>}
    {detailed && n > 1 && h >= 66 && <span className="tt-block-share">{n} activities · {fmtDuration(mins / n)} each</span>}
    {!quiet && n > 1 && <span className="tt-block-stripe" style={{ background: stripe }} />}
    {real && checkins.length > 0 && <svg className="tt-block-bell" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={`Check-in: ${checkins.join(", ")}`}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>}
  </button>;
}

export default function LifeTimetable({ disabled = false }: { disabled?: boolean }) {
  const { data, timeline, activities, swap, error, variantNow } = useTimetable();
  const t = useTick(15000, now);
  const [view, setView] = useState<"week" | "day">("week");
  const [viewVar, setViewVar] = useState<Variant | null>(null);
  const [selDay, setSelDay] = useState<number | null>(null);
  const [showActs, setShowActs] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState("");
  const [undo, setUndo] = useState<{ variant: Variant; cells: Cell[]; label: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { habits, habitsAt } = useCheckinData();
  const [menu, setMenu] = useState<{ x: number; y: number; block: Block; day: number; el: HTMLElement } | null>(null);
  const moved = useRef(false); // true from the first real movement of a drag until just after it ends, so the click that follows a drag is ignored
  const [status, setStatus] = useState<Status>({ state: "saved" });
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const today = weekdayOf(t);
  const nowMin = t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60;
  const currentVar = variantNow(t);
  const variant = viewVar ?? currentVar;
  const day = selDay ?? today;
  const live = variant === currentVar;
  const grid = timeline.grids[variant];
  const usedBy = useMemo(() => (id: string) => (data?.slots ?? []).filter(s => s.activity_id === id).length, [data]);

  useEffect(() => { if (!undo) return; const id = setTimeout(() => setUndo(null), 10000); return () => clearTimeout(id); }, [undo]);

  const run = async (job: () => Promise<unknown>) => {
    setStatus({ state: "saving" });
    try { await job(); setStatus({ state: "saved" }); } catch (e) { setStatus({ state: "error", message: String(e) }); throw e; }
  };
  const runQuiet = (job: () => Promise<unknown>) => run(job).catch(() => undefined);

  const closeEditor = () => {
    setEditor(null); setEditorError("");
    const el = opener.current;
    requestAnimationFrame(() => { if (el && el.isConnected) el.focus(); else addButton.current?.focus(); });
  };
  const openEdit = (state: EditorState, from?: HTMLElement | null) => { opener.current = from ?? (document.activeElement as HTMLElement | null); setEditorError(""); setEditor(state); };
  // A gap (nothing planned) opens as a new block over exactly that gap; a real block opens as an edit that remembers what it covered.
  const editBlock = (b: Block, d: number, el: HTMLElement) => b.ids.length === 0
    ? openEdit({ isNew: true, days: [d], start: b.first, end: b.first + b.count, acts: [], habitIds: [] }, el)
    : openEdit({ isNew: false, days: [d], start: b.first, end: b.first + b.count, acts: [...b.ids], habitIds: habitsAt(variant, d, b.first, b.first + b.count), from: { day: d, start: b.first, end: b.first + b.count, ids: [...b.ids] } }, el);

  /** Save a block's new place. Slots the block used to cover and no longer does become a gap; Undo puts everything back in one step. */
  async function write(s: EditorState, acts: string[], label = "saved") {
    let before: Cell[] = [];
    {
      await run(async () => {
        before = await saveRange(variant, s.days, s.start, s.end, acts);
        const o = s.from;
        if (o) { // slots the block used to cover and no longer does become a gap; Undo puts them back with the rest
          const gone: Cell[] = [];
          for (let i = o.start; i < o.end; i++) if (!s.days.includes(o.day) || i < s.start || i >= s.end) gone.push({ weekday: o.day, slot_index: i, activity_ids: [] });
          if (gone.length) { await restoreCells(variant, gone); before = [...before, ...gone.map(c => ({ ...c, activity_ids: o.ids }))]; }
        }
      });
      setUndo({ variant, cells: before, label });
    }
  }
  /** Save which habits check in for the block, wherever it now is. A failure here does not undo the timetable change; it is reported. */
  async function saveCheckins(s: EditorState) {
    try { await habitsApi.setBlock(variant, s.from ? { day: s.from.day, start: s.from.start, end: s.from.end } : null, s.days, s.start, s.end, s.habitIds ?? []); announceCheckins(); }
    catch (e) { setStatus({ state: "error", message: "The block was saved, but its check-in setting was not: " + String(e instanceof Error ? e.message : e) }); }
  }
  async function commit(s: EditorState, acts: string[]) {
    try { await write(s, acts); await saveCheckins(s); closeEditor(); } catch (e) { setEditorError(String(e)); }
  }
  /** Move or stretch a block to a new day and half-hour range. */
  const place = (b: Block, fromDay: number, to: { day: number; start: number; end: number }, label: string) => {
    if (disabled || (to.day === fromDay && to.start === b.first && to.end === b.first + b.count)) return;
    const mine = habitsAt(variant, fromDay, b.first, b.first + b.count); // its check-ins go with it
    const state: EditorState = { isNew: false, days: [to.day], start: to.start, end: to.end, acts: [...b.ids], habitIds: mine, from: { day: fromDay, start: b.first, end: b.first + b.count, ids: [...b.ids] } };
    void write(state, b.ids, label).then(() => { if (mine.length || habitsAt(variant, to.day, to.start, to.end).length) return saveCheckins(state); }).catch(() => undefined);
  };
  /** Delete a block: its half-hours become a gap. Undo brings it back. */
  const remove = (b: Block, d: number) => {
    if (disabled) return;
    const cells = (ids: string[]): Cell[] => Array.from({ length: b.count }, (_, i) => ({ weekday: d, slot_index: b.first + i, activity_ids: ids }));
    void run(async () => { await restoreCells(variant, cells([])); setUndo({ variant, cells: cells([...b.ids]), label: "deleted" }); })
      .then(() => { if (habitsAt(variant, d, b.first, b.first + b.count).length) return saveCheckins({ isNew: false, days: [], start: 0, end: 0, acts: [], habitIds: [], from: { day: d, start: b.first, end: b.first + b.count, ids: [] } }); }).catch(() => undefined);
  };
  const columnAt = (x: number, y: number): number | null => {
    const col = (document.elementsFromPoint?.(x, y) ?? []).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.col !== undefined);
    return col ? Number(col.dataset.col) : null;
  };
  /** Press on a block: a short press is a click (opens the editor); moving the pointer drags it, or stretches it from its top or bottom edge. Esc cancels. */
  function beginDrag(e: React.PointerEvent<HTMLButtonElement>, b: Block, d: number, px: number) {
    if (disabled || e.button !== 0 || e.pointerType === "touch") return;
    const zone = zoneOf(e), sp = px / 2, x0 = e.clientX, y0 = e.clientY, end0 = b.first + b.count;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    let cur = { day: d, start: b.first, end: end0 }, active = false, cancelled = false;
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", abort); window.removeEventListener("keydown", key, true); };
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      active = true; moved.current = true;
      const ds = Math.round((ev.clientY - y0) / sp);
      if (zone === "top") cur = { day: d, start: clamp(b.first + ds, 0, end0 - 1), end: end0 };
      else if (zone === "bottom") cur = { day: d, start: b.first, end: clamp(end0 + ds, b.first + 1, 48) };
      else { const st = clamp(b.first + ds, 0, 48 - b.count); cur = { day: columnAt(ev.clientX, ev.clientY) ?? d, start: st, end: st + b.count }; }
      setDrag({ ...cur, from: b, fromDay: d });
    };
    const finish = () => { stop(); setDrag(null); if (active) setTimeout(() => { moved.current = false; }, 0); };
    const up = () => { finish(); if (active && !cancelled) place(b, d, cur, zone === "move" ? "moved" : "resized"); };
    const abort = () => { cancelled = true; finish(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); abort(); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", abort); window.addEventListener("keydown", key, true);
  }
  /** Keyboard: Delete removes the block, Alt+Up/Down moves it by half an hour, Alt+Shift+Up/Down stretches its end. */
  function blockKey(e: React.KeyboardEvent<HTMLButtonElement>, b: Block, d: number) {
    if (disabled) return;
    if (e.key === "Delete") { e.preventDefault(); remove(b, d); return; }
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const dir = e.key === "ArrowUp" ? -1 : 1, end = b.first + b.count;
    if (e.shiftKey) { const ne = Math.max(b.first + 1, Math.min(48, end + dir)); place(b, d, { day: d, start: b.first, end: ne }, "resized"); }
    else { const st = Math.max(0, Math.min(48 - b.count, b.first + dir)); place(b, d, { day: d, start: st, end: st + b.count }, "moved"); }
  }
  async function clearToFree(s: EditorState) {
    try {
      let id = activities.find(a => a.name.toLowerCase() === "free time")?.id;
      if (!id) await run(async () => { id = (await addActivity("Free time", "Leisure")).id; });
      await commit(s, [id!]);
    } catch (e) { setEditorError(String(e)); }
  }
  const undoLast = () => { if (!undo) return; const u = undo; setUndo(null); void runQuiet(() => restoreCells(u.variant, u.cells)); };
  const reset = () => { if (window.confirm(`Reset Week ${variant} to the original plan? Your edits to this week will be replaced.`)) void runQuiet(() => resetVariant(variant)); };
  const flip = () => setViewVar(otherVariant(variant));
  const toggleSwap = () => { setViewVar(null); void runQuiet(() => setSwap(!swap)); };
  const jump = () => {
    setSelDay(today); setViewVar(null);
    setTimeout(() => document.querySelector<HTMLElement>('[data-testid="now-line"]')?.scrollIntoView?.({ block: "center", behavior: "smooth" }), 30);
  };

  if (!data) return <div className="document tt-screen"><h1 className="tt-title">Life Timetable</h1><p className={error ? "error" : "hint"} role={error ? "alert" : "status"}>{error || "Opening the timetable…"}</p></div>;
  const edited = variant === "A" ? data.edited.a : data.edited.b;
  const hourLines = (px: number): React.CSSProperties => ({ ["--hr" as string]: px + "px" });
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const nowLine = (px: number) => <div className="tt-nowline" data-testid="now-line" style={{ top: (nowMin / 60) * px }} aria-hidden="true"><span /></div>;

  const actionsFor = (b: Block, d: number, px: number): BlockActions => ({
    onEdit: el => { if (moved.current) { moved.current = false; return; } editBlock(b, d, el); },
    onPointerDown: e => beginDrag(e, b, d, px),
    onMenu: e => { if (disabled) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, block: b, day: d, el: e.currentTarget }); },
    onKey: e => blockKey(e, b, d),
  });
  const checkinNames = (d: number, b: Block) => habitsAt(variant, d, b.first, b.first + b.count).map(id => habits.find(h => h.id === id)?.name).filter((n): n is string => !!n);
  const ghost = (g: Drag, px: number) => <div className="tt-ghost" aria-hidden="true" style={{ top: g.start * (px / 2) + 3, height: (g.end - g.start) * (px / 2) - 6 }}><span>{hm(g.start * 30)}–{hm(g.end * 30)}</span></div>;
  return <div className="document tt-screen" aria-label="Life Timetable">
    <header className="tt-head">
      <div className="tt-head-title">
        <span className="tt-kicker-mono">{kickerOf(t)}</span>
        <h1 className="tt-title">Life Timetable</h1>
      </div>
      <div className="tt-wrap">
        <button type="button" className="tt-btn primary big" onClick={jump}>Jump to now</button>
        <button type="button" className="tt-btn big" aria-expanded={showActs} onClick={() => setShowActs(v => !v)}>Activities</button>
      </div>
    </header>
    <span className="tt-status" role="status">{status.state === "saving" ? "Saving…" : status.state === "error" ? "Not saved: " + status.message : ""}</span>

    <div className="tt-top">
      <NowPanel />
      <Distribution grid={grid} activities={activities} day={view === "day" ? day : null} variant={variant} />
    </div>

    {showActs && <ActivitiesPanel activities={activities} usedBy={usedBy} disabled={disabled} run={runQuiet} />}

    <section className="tt-card tt-table" aria-label="Timetable">
      <div className="tt-table-head">
        <div className="tt-wrap center">
          <h2>Timetable</h2>
          <button type="button" className="tt-btn" onClick={flip} aria-label={`Showing Week ${variant}${live ? " (this week)" : ""}. Switch to Week ${otherVariant(variant)}`} title="Switch between Week A and Week B">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4" /><path d="M3 8h14" /><path d="M17 20l4-4-4-4" /><path d="M21 16H7" /></svg>Week {variant}{live && <span className="tt-dot-live" aria-hidden="true" />}
          </button>
          <button type="button" className="tt-text-btn mono" onClick={toggleSwap} title="Swap which week is current" disabled={disabled}>This week is {currentVar} · swap</button>
        </div>
        <div className="tt-wrap center">
          {view === "day" && <div role="tablist" aria-label="Day" className="tt-pills">{DAY_SHORT.map((d, i) => <button key={d} type="button" role="tab" aria-selected={i === day} className={"tt-daypill" + (i === day ? " on" : "") + (i === today ? " today" : "")} onClick={() => setSelDay(i)}>{d}</button>)}</div>}
          {edited && <button type="button" className="tt-text-btn" disabled={disabled} onClick={reset}>Reset to plan</button>}
          <button ref={addButton} type="button" className="tt-btn" disabled={disabled} onClick={e => openEdit({ isNew: true, days: [day], start: 24, end: 26, acts: [] }, e.currentTarget)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Add block
          </button>
          <div role="group" aria-label="View" className="tt-seg-toggle">
            <button type="button" aria-pressed={view === "week"} className={view === "week" ? "on" : ""} onClick={() => setView("week")}>Week</button>
            <button type="button" aria-pressed={view === "day"} className={view === "day" ? "on" : ""} onClick={() => setView("day")}>Day</button>
          </div>
        </div>
      </div>

      {view === "week" ? <div className="tt-scroll-x"><div className="tt-weekgrid">
        <div className="tt-headcell" />
        {DAY_SHORT.map((d, i) => <button key={d} type="button" className={"tt-colhead" + (i % 2 === 0 ? " band" : "") + (i === today ? " today" : "")} aria-pressed={i === day} onClick={() => setSelDay(i)}>
          <span>{d}</span><span className={"tt-mark" + (i === day ? " on" : "")} /></button>)}
        <div className="tt-gutter" style={{ ...hourLines(WEEK_PX), height: 24 * WEEK_PX }}>{hours.map(h => <span key={h} style={{ top: h * WEEK_PX + 6 }}>{String(h).padStart(2, "0")}:00</span>)}</div>
        {DAY_SHORT.map((d, i) => <div key={d} data-col={i} className={"tt-col" + (i % 2 === 0 ? " band" : "")} style={{ ...hourLines(WEEK_PX), height: 24 * WEEK_PX }}>
          {dayBlocks(grid, i).map(b => <BlockButton key={b.first} block={b} day={i} today={today} px={WEEK_PX} detailed={false} activities={activities} live={live} nowMin={nowMin} dragging={drag?.from === b} actions={actionsFor(b, i, WEEK_PX)} checkins={checkinNames(i, b)} />)}
          {drag?.day === i && ghost(drag, WEEK_PX)}
          {live && i === today && nowLine(WEEK_PX)}
        </div>)}
      </div></div>
      : <div className="tt-daygrid">
        <div className="tt-headcell" />
        <div className="tt-dayhead">{DAY_LONG[day].toUpperCase()}</div>
        <div className="tt-gutter" style={{ ...hourLines(DAY_PX), height: 24 * DAY_PX }}>{hours.map(h => <span key={h} style={{ top: h * DAY_PX + 8 }}>{String(h).padStart(2, "0")}:00</span>)}</div>
        <div data-col={day} className="tt-col band" style={{ ...hourLines(DAY_PX), height: 24 * DAY_PX }}>
          {dayBlocks(grid, day).map(b => <BlockButton key={b.first} block={b} day={day} today={today} px={DAY_PX} detailed activities={activities} live={live} nowMin={nowMin} dragging={drag?.from === b} actions={actionsFor(b, day, DAY_PX)} checkins={checkinNames(day, b)} />)}
          {drag?.day === day && ghost(drag, DAY_PX)}
          {live && day === today && nowLine(DAY_PX)}
        </div>
      </div>}
    </section>

    {menu && <BlockMenu at={menu} onClose={() => setMenu(null)} onEdit={() => { const m = menu; setMenu(null); editBlock(m.block, m.day, m.el); }} onDelete={() => { const m = menu; setMenu(null); remove(m.block, m.day); }} />}
    {undo && createPortal(<div className="tt-undo" role="status"><span>Block {undo.label}</span><button type="button" onClick={undoLast}>Undo</button></div>, document.body)}
    {editor && <BlockEditor initial={editor} variant={variant} activities={activities} habits={habits} serverError={editorError} onSave={s => void commit(s, s.acts)} onClear={s => void clearToFree(s)} onCancel={closeEditor} />}
  </div>;
}

/** The right-click menu of a block: Edit or Delete. Closes on Esc, a click elsewhere, scrolling or resizing. Arrow keys move between the items. */
function BlockMenu({ at, onClose, onEdit, onDelete }: { at: { x: number; y: number }; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
    box.current?.querySelector<HTMLElement>("button")?.focus();
    const away = (e: Event) => { if (!(e.target instanceof Node && box.current?.contains(e.target))) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", away, true); window.addEventListener("scroll", onClose, true); window.addEventListener("resize", onClose); window.addEventListener("keydown", esc, true); window.addEventListener("blur", onClose);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("scroll", onClose, true); window.removeEventListener("resize", onClose); window.removeEventListener("keydown", esc, true); window.removeEventListener("blur", onClose); };
  }, [at.x, at.y, onClose]);
  const arrows = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])], i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return createPortal(<div ref={box} className="tt-menu" role="menu" aria-label="Block" style={pos} onKeyDown={arrows} onContextMenu={e => e.preventDefault()}>
    <button type="button" role="menuitem" onClick={onEdit}>Edit block…</button>
    <button type="button" role="menuitem" className="danger" onClick={onDelete}>Delete block</button>
  </div>, document.body);
}
