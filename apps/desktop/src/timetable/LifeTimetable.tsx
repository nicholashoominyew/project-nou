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

const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEK_PX = 48, DAY_PX = 64; // pixels per hour
type Status = { state: "saved" | "saving" | "error"; message?: string };

function BlockButton({ block, day, today, px, detailed, activities, live, nowMin, onEdit }: { block: Block; day: number; today: number; px: number; detailed: boolean; activities: Activity[]; live: boolean; nowMin: number; onEdit: (el: HTMLElement) => void }) {
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
  return <button type="button" className={"tt-block" + (detailed ? " day" : "") + (isCur ? " current" : "")} data-day={day} data-first={block.first} aria-current={isCur ? "time" : undefined} style={style} title={title} aria-label={title} onClick={e => onEdit(e.currentTarget)}>
    <span className={"tt-block-name" + (h >= 40 ? " wrap" : "")}>{label}</span>
    {h >= (detailed ? 44 : 52) && <span className="tt-block-range">{range}{detailed ? " · " + fmtDuration(mins) : ""}</span>}
    {detailed && n > 1 && h >= 66 && <span className="tt-block-share">{n} activities · {fmtDuration(mins / n)} each</span>}
    {!quiet && n > 1 && <span className="tt-block-stripe" style={{ background: stripe }} />}
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
  const [undo, setUndo] = useState<{ variant: Variant; cells: Cell[] } | null>(null);
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
    ? openEdit({ isNew: true, days: [d], start: b.first, end: b.first + b.count, acts: [] }, el)
    : openEdit({ isNew: false, days: [d], start: b.first, end: b.first + b.count, acts: [...b.ids], from: { day: d, start: b.first, end: b.first + b.count, ids: [...b.ids] } }, el);

  async function commit(s: EditorState, acts: string[]) {
    try {
      let before: Cell[] = [];
      await run(async () => {
        before = await saveRange(variant, s.days, s.start, s.end, acts);
        const o = s.from;
        if (o) { // slots the block used to cover and no longer does become a gap; Undo puts them back with the rest
          const gone: Cell[] = [];
          for (let i = o.start; i < o.end; i++) if (!s.days.includes(o.day) || i < s.start || i >= s.end) gone.push({ weekday: o.day, slot_index: i, activity_ids: [] });
          if (gone.length) { await restoreCells(variant, gone); before = [...before, ...gone.map(c => ({ ...c, activity_ids: o.ids }))]; }
        }
      });
      setUndo({ variant, cells: before });
      closeEditor();
    } catch (e) { setEditorError(String(e)); }
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
        {DAY_SHORT.map((d, i) => <div key={d} className={"tt-col" + (i % 2 === 0 ? " band" : "")} style={{ ...hourLines(WEEK_PX), height: 24 * WEEK_PX }}>
          {dayBlocks(grid, i).map(b => <BlockButton key={b.first} block={b} day={i} today={today} px={WEEK_PX} detailed={false} activities={activities} live={live} nowMin={nowMin} onEdit={el => editBlock(b, i, el)} />)}
          {live && i === today && nowLine(WEEK_PX)}
        </div>)}
      </div></div>
      : <div className="tt-daygrid">
        <div className="tt-headcell" />
        <div className="tt-dayhead">{DAY_LONG[day].toUpperCase()}</div>
        <div className="tt-gutter" style={{ ...hourLines(DAY_PX), height: 24 * DAY_PX }}>{hours.map(h => <span key={h} style={{ top: h * DAY_PX + 8 }}>{String(h).padStart(2, "0")}:00</span>)}</div>
        <div className="tt-col band" style={{ ...hourLines(DAY_PX), height: 24 * DAY_PX }}>
          {dayBlocks(grid, day).map(b => <BlockButton key={b.first} block={b} day={day} today={today} px={DAY_PX} detailed activities={activities} live={live} nowMin={nowMin} onEdit={el => editBlock(b, day, el)} />)}
          {live && day === today && nowLine(DAY_PX)}
        </div>
      </div>}
    </section>

    {undo && createPortal(<div className="tt-undo" role="status"><span>Block saved</span><button type="button" onClick={undoLast}>Undo</button></div>, document.body)}
    {editor && <BlockEditor initial={editor} variant={variant} activities={activities} serverError={editorError} onSave={s => void commit(s, s.acts)} onClear={s => void clearToFree(s)} onCancel={closeEditor} />}
  </div>;
}
