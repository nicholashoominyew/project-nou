import { useCallback, useEffect, useState, type ReactNode } from "react";
import { addDays, parseDay } from "../habitsLogic";
import { readTeachings, type Teaching } from "../teachings";
import { useHabits } from "../useHabits";
import { dailyApi, type DayPage as Page, type Entry } from "./api";
import { Arrow } from "./Calendar";
import JournalCard, { useJournal, type SaveState } from "./Journal";
import { dayOfMonth, daysLabel, habitsOn, isDaySpecific, sectionsOn, themeOf, toJournal, weekOf, type Section } from "./logic";

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
/** Where each ordinary card sits in the 12-column grid, in the design's order. The three small tiles share a row. */
const LAYOUT: Record<string, { span: number; tall?: boolean }> = {
  daily_summary: { span: 7 }, braindump: { span: 5 }, teaching_of_the_day: { span: 5, tall: true }, todo_list: { span: 7 }, daily_updates: { span: 7 },
};
const TILES = ["wecs_digest", "newsletter_summary", "aec_ai_news"];
const DAY_SPANS: Record<string, number> = { sunday_routine: 4, xgrok_card_reveals: 5, meals: 3 };
const OWNERS: Record<string, string> = { claude: "CLAUDE", xgrok: "XGROK", groza: "GROZA", "any agent": "ANY AGENT" };

export type DayProps = { day: string; today: string; disabled: boolean; focused: boolean; onDay: (day: string | null) => void; onFocusMode: (on: boolean) => void; onState: (s: SaveState) => void };

export default function DayPage(props: DayProps) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setPage(await dailyApi.get(props.day)); setError(""); } catch (e) { setError(errText(e)); }
  }, [props.day]);
  useEffect(() => { void load(); }, [load]);
  if (!page || page.day !== props.day) return error ? <p className="error" role="alert">{error}<button onClick={() => void load()}>Try again</button></p> : <p role="status">Opening the day…</p>;
  return <Loaded {...props} page={page} reload={load} error={error} setError={setError} />;
}

function Loaded({ day, today, disabled, focused, onDay, onFocusMode, onState, page, reload, error, setError }: DayProps & { page: Page; reload: () => Promise<void>; error: string; setError: (s: string) => void }) {
  const { journal, state, change, retry } = useJournal(day, toJournal(page.journal), dailyApi.saveJournal, onState);
  const { habits, log } = useHabits();
  const [teachings, setTeachings] = useState<Teaching[]>([]);
  useEffect(() => { let off = false; void readTeachings(day, 5, true).then(t => { if (!off) setTeachings(t); }); return () => { off = true; }; }, [day]);
  useEffect(() => {
    if (!focused) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onFocusMode(false); };
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, [focused, onFocusMode]);

  // Words that could not be saved stay on screen: leaving is refused until they are.
  const go = (to: string | null) => (state === "failed" ? setError("Your journal is not saved yet. Choose Try again before leaving this day.") : onDay(to));
  const date = parseDay(day), theme = themeOf(day), { n, of } = dayOfMonth(day);
  const list = habitsOn(habits ?? [], log, day), done = list.filter(h => h.done).length;
  const sections = sectionsOn(day), by = (id: string) => page.entries.filter(e => e.section === id);
  const tiles = sections.filter(s => TILES.includes(s.id));
  const ordinary = [...Object.keys(LAYOUT).map(id => sections.find(s => s.id === id)).filter((s): s is Section => !!s), ...tiles];
  const special = sections.filter(isDaySpecific);

  async function tick(entry: Entry) {
    try { await dailyApi.setTodo(entry.id, !entry.done); await reload(); } catch (e) { setError(errText(e)); }
  }
  const link = (e: Entry) => e.link && /^https?:\/\//.test(e.link) &&
    <button type="button" className="dy-link" title={e.link} onClick={() => void dailyApi.openLink(e.link).catch(x => setError(errText(x)))}>link</button>;
  const empty = <p className="hint">Nothing here for this day.</p>;

  function body(s: Section): ReactNode {
    const items = by(s.id);
    if (s.id === "daily_summary") {
      const focusLine = by("focus");
      return <>
        <div className="dy-theme big"><i className="dy-ping" /><div><strong>{theme.theme}</strong><em>{theme.covers}</em></div></div>
        {focusLine.map(e => <p key={e.id}>{e.text}</p>)}
        {items.length ? <Lines items={items} link={link} /> : empty}
      </>;
    }
    if (s.id === "todo_list") {
      const ticked = items.filter(e => e.done).length;
      if (!items.length) return empty;
      return <>
        <div className="dy-progress-row"><span className="dy-mono">{ticked} / {items.length} DONE</span>
          <span className="dy-progress" role="progressbar" aria-label="To-dos done" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={ticked}><span style={{ width: (ticked / items.length) * 100 + "%" }} /></span></div>
        {items.map(e => <div key={e.id} className={"dy-todo" + (e.done ? " done" : "")}>
          <button type="button" className="dy-check" aria-pressed={e.done} disabled={disabled} aria-label={(e.done ? "Mark open: " : "Mark done: ") + e.text} onClick={() => void tick(e)}><span>{e.done && <Arrow d="M5 12l5 5 9-10" />}</span></button>
          <div className="dy-todo-text">{e.topic && <span className={"dy-tag" + (/needs/i.test(e.topic) ? " on" : "")}>[{e.topic}]</span>}<span>{e.text}</span>{link(e)}</div>
        </div>)}
      </>;
    }
    if (s.id === "daily_updates") {
      return items.length ? <ol className="dy-timeline">{items.map(e => <li key={e.id}><span className="dy-mono time">{e.time}</span><div className="dy-mono">{e.source.toUpperCase()}</div><div>{e.topic && `[${e.topic}] `}{e.text} {link(e)}</div></li>)}</ol> : empty;
    }
    if (s.id === "braindump") return items.length ? <Donut items={items} link={link} /> : empty;
    if (s.id === "teaching_of_the_day") {
      const rows = items.length ? items.map(e => ({ key: e.id, text: e.text, book: e.topic || e.source, by: "" }))
        : teachings.map((t, i) => ({ key: "t" + i, text: t.text, book: t.source, by: t.author }));
      return rows.length ? <ol className="dy-teachings">{rows.map((r, i) => <li key={r.key}><b className="dy-num">{i + 1}</b><div>{r.text}<div className="dy-cite">{r.book && <span className="dy-tag">{r.book}</span>}{r.by && <span className="dy-mono">{r.by}</span>}</div></div></li>)}</ol>
        : <p className="hint">Five teachings from five books appear here from a database called Teachings (with a Book column).</p>;
    }
    if (TILES.includes(s.id)) return items.length ? <><div className="dy-count"><b className="dy-num">{items.length}</b><span className="dy-mono">{items.length === 1 ? "ITEM" : "ITEMS"}</span></div><Lines items={items} link={link} /></> : empty;
    return items.length ? <Lines items={items} link={link} /> : empty;
  }

  const card = (s: Section, i: number, span: number, extra = "") => <section key={s.id} className={`dy-card s${span} ${extra}`} style={{ animationDelay: 50 + i * 55 + "ms" }} aria-label={s.title}>
    <div className="dy-card-head"><div><h2>{s.title}</h2><div className="dy-mono">{OWNERS[s.owner] ?? s.owner.toUpperCase()} · {daysLabel(s.days)}{s.trust === "untrusted_content" ? " · OUTSIDE TEXT" : ""}</div></div><b className="dy-num dy-order">{s.order}</b></div>
    {body(s)}
  </section>;
  const dim = "dy-dim" + (focused ? " off" : "");

  return <div className={"dy dy-day" + (focused ? " focusing" : "")} aria-label={"Daily page " + day}>
    {focused && <div className="dy-pill" role="status"><i className="dy-ping" />FOCUS · JOURNAL</div>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className={dim} inert={focused}>
      <div className="dy-rise dy-hero">
        {["tl", "tr", "bl", "br"].map(c => <span key={c} className={"dy-reg " + c} aria-hidden="true">+</span>)}
        <div className="dy-hero-left">
          <div className="dy-mono dy-crumb">NOU · <span className="dy-kanji">脳</span> · DAILY / {day}</div>
          <div className="dy-bignum-wrap"><Mark /><span className="dy-num dy-bignum">{n}</span></div>
          <div className="dy-hero-text">
            <div className="dy-mono big">{date.toLocaleDateString("en-GB", { weekday: "long" }).toUpperCase()}</div>
            <div className="dy-mono big muted">{date.toLocaleDateString("en-GB", { month: "long", year: "numeric" }).toUpperCase()}</div>
            <div className="dy-mono">DAY {n} OF {of}</div>
            <div className="dy-mono dy-saved"><i />OFFLINE · SAVED ON THIS DEVICE</div>
          </div>
        </div>
        <div className="dy-hero-right">
          <div className="dy-row end">
            <button type="button" className="dy-btn square" aria-label="Previous day" onClick={() => go(addDays(day, -1))}><Arrow d="M15 6l-6 6 6 6" /></button>
            <button type="button" className="dy-btn square" aria-label="Next day" onClick={() => go(addDays(day, 1))}><Arrow d="M9 6l6 6-6 6" /></button>
            <button type="button" className="dy-btn" onClick={() => go(null)}>Calendar</button>
          </div>
          <div className="dy-weekstrip">{weekOf(day).map(d => <button key={d} type="button" className={(d === day ? "open " : "") + (d === today ? "today" : "")} aria-current={d === day ? "page" : undefined}
            aria-label={parseDay(d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) + (d === today ? ", today" : "")} onClick={() => go(d)}>
            <span className="dy-mono">{parseDay(d).toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase()}</span><b className="dy-num">{parseDay(d).getDate()}</b><span className="dy-mono code">{themeOf(d).code}</span></button>)}</div>
          <div className="dy-habits">
            <div className="dy-mono">HABITS · {day === today ? "TODAY" : parseDay(day).toLocaleDateString("en-GB", { day: "numeric", month: "short" }).toUpperCase()}</div>
            {list.length ? <>
              <div className="dy-habits-sum">{done} of {list.length} done · {list.length - done} left</div>
              <div className="dy-segments" aria-hidden="true">{list.map((h, i) => <span key={h.id} className={i < done ? "on" : ""} />)}</div>
              <div className="dy-chips">{list.map(h => <span key={h.id} className={"dy-chip" + (h.done ? " on" : "")}><i />{h.name}<span className="dy-sr">{h.done ? " done" : " not done"}</span></span>)}</div>
            </> : <p className="hint">No habit counts on this day.</p>}
          </div>
        </div>
      </div>
    </div>
    <div className="dy-rise" style={{ animationDelay: "120ms" }}>
      <JournalCard journal={journal} state={state} change={change} retry={retry} readOnly={disabled} focused={focused} onFocusMode={onFocusMode} />
    </div>
    <div className={dim} inert={focused}>
      <div className="dy-bento">
        {ordinary.map((s, i) => card(s, i, TILES.includes(s.id) ? 12 / tiles.length : LAYOUT[s.id].span, LAYOUT[s.id]?.tall ? "tall" : ""))}
        {special.length > 0 && <div className="dy-divider dy-mono">DAY-SPECIFIC · DASHED CARDS APPEAR ONLY ON THEIR DAY</div>}
        {special.map((s, i) => card(s, ordinary.length + i, special.length === 1 ? 12 : DAY_SPANS[s.id] ?? 4, "ghost"))}
      </div>
    </div>
  </div>;
}

const Lines = ({ items, link }: { items: Entry[]; link: (e: Entry) => ReactNode }) =>
  <ul className="dy-lines">{items.map(e => <li key={e.id}>{e.time && <span className="dy-mono">{e.time} · {e.source.toUpperCase()} </span>}{e.topic && <span className="dy-tag">{e.topic}</span>} {e.text} {link(e)}</li>)}</ul>;

/** Braindump items counted by their [Topic]. */
function Donut({ items, link }: { items: Entry[]; link: (e: Entry) => ReactNode }) {
  const counts = new Map<string, number>();
  for (const e of items) counts.set(e.topic || "Other", (counts.get(e.topic || "Other") ?? 0) + 1);
  const parts = [...counts].sort((a, b) => b[1] - a[1]), around = 2 * Math.PI * 36;
  const shade = (i: number) => [1, 0.65, 0.4, 0.22][i % 4];
  let from = 0;
  return <>
    <div className="dy-donut">
      <div className="dy-donut-ring"><svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true"><g fill="none" strokeWidth="14" transform="rotate(-90 52 52)">
        <circle cx="52" cy="52" r="36" stroke="var(--line)" />
        {parts.map(([name, count], i) => { const len = (count / items.length) * around, at = from; from += len; return <circle key={name} cx="52" cy="52" r="36" stroke="var(--accent)" strokeOpacity={shade(i)} strokeDasharray={`${Math.max(len - 2, 1)} ${around}`} strokeDashoffset={-at} />; })}
      </g></svg><div><b className="dy-num">{items.length}</b><span className="dy-mono">{items.length === 1 ? "ITEM" : "ITEMS"}</span></div></div>
      <ul className="dy-legend">{parts.map(([name, count], i) => <li key={name}><i style={{ opacity: shade(i) }} />{name}<span className="dy-mono">{count}</span></li>)}</ul>
    </div>
    <Lines items={items.map(e => ({ ...e, topic: "" }))} link={link} />
  </>;
}

/** The Elementel mark behind the date: 24 blocks, each 10 by 8 on the 200 grid at radius 81. Decoration only. */
function Mark() {
  return <span className="dy-ring" aria-hidden="true"><svg viewBox="15 15 170 170"><g fill="var(--accent)" fillOpacity=".3">
    {Array.from({ length: 24 }, (_, i) => <rect key={i} x="95" y="19" width="10" height="8" rx="1" transform={`rotate(${i * 15} 100 100)`} />)}</g></svg></span>;
}
