import { useCallback, useEffect, useRef, useState } from "react";
import { parseDay } from "../habitsLogic";
import { useHabits } from "../useHabits";
import { dailyApi } from "./api";
import { parseHistoryFile, type ImportDay } from "./importHistory";
import { habitsOn, monthStats, sixWeeks, themeOf, THEMES, type Summary } from "./logic";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MARK = { full: "journal written", part: "journal started", none: "journal empty" };
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
export const Arrow = ({ d }: { d: string }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

export default function Calendar({ today, disabled, onOpen }: { today: string; disabled: boolean; onOpen: (day: string) => void }) {
  const [month, setMonth] = useState(() => ({ y: parseDay(today).getFullYear(), m: parseDay(today).getMonth() }));
  const [picked, setPicked] = useState(today);
  const [summaries, setSummaries] = useState<Map<string, Summary>>(new Map());
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const { habits, log } = useHabits();
  const file = useRef<HTMLInputElement>(null);
  const cells = sixWeeks(month.y, month.m);
  // Only the small records are read for the grid, never the pages. A year back is enough for the streak.
  const load = useCallback(async () => {
    try {
      const from = `${month.y - 1}-${String(month.m + 1).padStart(2, "0")}-01`, last = sixWeeks(month.y, month.m)[41].day;
      const rows = await dailyApi.summaries(from, last > today ? last : today);
      setSummaries(new Map((Array.isArray(rows) ? rows : []).map(s => [s.day, s]))); setError("");
    } catch (e) { setError(errText(e)); }
  }, [month.y, month.m, today]);
  useEffect(() => { void load(); }, [load]);

  const move = (n: number) => setMonth(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const goToday = () => { const d = parseDay(today); setMonth({ y: d.getFullYear(), m: d.getMonth() }); setPicked(today); };

  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    setError(""); setNotice("");
    try {
      const days: ImportDay[] = [], unknown = new Set<string>();
      for (const f of Array.from(list)) { const got = parseHistoryFile(f.name, await f.text()); days.push(...got.days); got.unknownHeadings.forEach(h => unknown.add(h)); }
      const r = await dailyApi.import(days);
      setNotice(`Imported ${r.days} ${r.days === 1 ? "day" : "days"}: ${r.entries_added} entries added, ${r.entries_skipped} already there, ${r.journals_added} journals added, ${r.journals_kept} of yours kept.` +
        (unknown.size ? ` Headings not recognised and left out: ${[...unknown].slice(0, 8).join(", ")}.` : ""));
      await load();
    } catch (e) { setError(errText(e)); }
    finally { if (file.current) file.current.value = ""; }
  }

  const monthName = new Date(month.y, month.m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const shortMonth = new Date(month.y, month.m, 1).toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  const stats = monthStats(month.y, month.m, today, summaries, habits ?? [], log);
  const sel = summaries.get(picked), future = picked > today, theme = themeOf(picked);
  const selHabits = habitsOn(habits ?? [], log, picked), selDate = parseDay(picked);
  const has = !future && (!!sel || selHabits.length > 0);
  const chip = (name: string, on: boolean, key = name) => <span key={key} className={"dy-chip" + (on ? " on" : "")}><i />{name}<span className="dy-sr">{on ? " done" : " not done"}</span></span>;

  return <div className="dy dy-cal-page" aria-label="Daily calendar">
    <header className="dy-rise dy-head">
      <div><div className="dy-mono dy-crumb">NOU · <span className="dy-kanji">脳</span> · DAILY</div><h1>Daily</h1></div>
      <div className="dy-row">
        <input ref={file} type="file" accept=".md,.json,text/markdown,application/json" multiple hidden aria-label="Choose daily history files" onChange={e => void importFiles(e.target.files)} />
        <button type="button" className="dy-btn" disabled={disabled} onClick={() => file.current?.click()} title="Bring in days exported from Notion (Markdown or JSON)">Import history…</button>
        <button type="button" className="dy-btn square" aria-label="Previous month" onClick={() => move(-1)}><Arrow d="M15 6l-6 6 6 6" /></button>
        <span className="dy-month" aria-live="polite">{monthName}</span>
        <button type="button" className="dy-btn square" aria-label="Next month" onClick={() => move(1)}><Arrow d="M9 6l6 6-6 6" /></button>
        <button type="button" className="dy-btn" onClick={goToday}>Today</button>
      </div>
    </header>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="dy-cal-wrap">
      <div className="dy-cal-main">
        <div className="dy-week-head" aria-hidden="true">{WEEKDAYS.map((d, i) => <div key={d}><div className="dy-mono strong">{d.toUpperCase()}</div><div className="dy-mono">{THEMES[i].code}</div></div>)}</div>
        <div className="dy-grid" key={`${month.y}-${month.m}`}>
          {cells.map((c, i) => {
            const date = parseDay(c.day), s = summaries.get(c.day), isToday = c.day === today, ahead = c.day > today;
            const dots = ahead ? [] : habitsOn(habits ?? [], log, c.day), done = dots.filter(d => d.done).length;
            const journal = s?.journal ?? "none";
            const label = `${WEEKDAYS[(date.getDay() + 6) % 7]} ${date.getDate()} ${date.toLocaleDateString("en-GB", { month: "long" })}` +
              (ahead ? "" : `: ${dots.length ? `${done} of ${dots.length} habits, ` : ""}${MARK[journal]}`);
            return <button key={c.day} type="button" aria-label={label} aria-current={isToday ? "date" : undefined} style={{ animationDelay: i * 8 + "ms" }}
              className={"dy-cell" + (c.inMonth ? "" : " out") + (isToday ? " today" : "") + (c.day === picked ? " picked" : "") + (ahead ? " ahead" : "")}
              onMouseEnter={() => setPicked(c.day)} onFocus={() => setPicked(c.day)} onClick={() => onOpen(c.day)}>
              <span className="dy-cell-top"><span><b className="dy-num">{date.getDate()}</b>{isToday && <em className="dy-mono">TODAY</em>}</span>{!ahead && <span className={"dy-jmark " + journal} />}</span>
              {dots.length > 0 && <span className="dy-cell-bottom"><span className="dy-dots">{dots.map(d => <i key={d.id} className={d.done ? "on" : ""} />)}</span><span className="dy-mono">{done}/{dots.length}</span></span>}
            </button>;
          })}
        </div>
      </div>
      <aside className="dy-rise dy-side" aria-label="Selected day">
        <div><div className="dy-mono">{picked === today ? "TODAY · " : ""}{WEEKDAYS[(selDate.getDay() + 6) % 7].toUpperCase()} · {picked}</div>
          <h2>{selDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "")}</h2></div>
        <div className="dy-theme"><i /><div><strong>{theme.theme}</strong><em>{theme.covers}</em></div></div>
        {has && <>
          <div><div className="dy-mono">BRIEFING</div><div>{sel?.sections ?? 0} sections · {sel?.open_todos ?? 0} open to-dos</div></div>
          {selHabits.length > 0 && <div><div className="dy-mono">HABITS · {selHabits.filter(h => h.done).length}/{selHabits.length}</div><div className="dy-chips">{selHabits.map(h => chip(h.name, h.done, h.id))}</div></div>}
          <div><div className="dy-mono">JOURNAL</div><div className="dy-chips">{chip(`Goals ${Math.min(sel?.goals ?? 0, 3)}/3`, (sel?.goals ?? 0) >= 3, "goals")}{chip("Small win", !!sel?.win)}{chip("Learnings", !!sel?.learn)}</div></div>
        </>}
        {!sel && (future ? <p className="hint">No page yet. It is made the first time there is something to put on this date.</p> : !has && <p className="hint">Nothing recorded on this day.</p>)}
        <button type="button" className="dy-open" onClick={() => onOpen(picked)}>Open day <Arrow d="M5 12h14M13 6l6 6-6 6" /></button>
      </aside>
    </div>
    <div className="dy-rise dy-stats">
      {[{ label: `JOURNAL DAYS · ${shortMonth}`, value: stats.journalDays, unit: `/ ${stats.daysSoFar}` }, { label: "JOURNAL STREAK", value: stats.streak, unit: stats.streak === 1 ? "day" : "days" }, { label: "HABITS AVERAGE", value: stats.habitsAverage, unit: "%" }]
        .map(t => <div key={t.label} className="dy-stat"><div className="dy-mono">{t.label}</div><div><b className="dy-num">{t.value}</b> <span>{t.unit}</span></div></div>)}
    </div>
  </div>;
}
