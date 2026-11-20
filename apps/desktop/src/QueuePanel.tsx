import { useState } from "react";
import { FILTERS, codeOf, filterCounts, filterItems, openCount, statusWord, type Filter, type QueueItem } from "./hubModel";

const tone = (s: string) => (s === "running" ? "live" : s === "needs_nick" ? "ask" : s === "queued" ? "muted" : "hollow");

/** The small queue: a task list with filters, a bot code per row and status as a dot plus a word. */
export default function QueuePanel({ items, onOpenFull }: { items: QueueItem[]; onOpenFull: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts = filterCounts(items);
  const shown = filterItems(items, filter);
  return <section className="hub-panel hub-queue" aria-label="Bot queue">
    <header className="hub-queue-head">
      <div className="hub-queue-title"><h2>Bot queue</h2><span className="hub-eyebrow tight num">{openCount(items)} OPEN</span></div>
      <div className="hub-tabs small" role="tablist" aria-label="Filter queue">
        {FILTERS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>{label} {counts[id]}</button>)}
      </div>
    </header>
    <ul className="hub-queue-list">
      {shown.map(q => <li key={q.id} className={q.status === "done" ? "done" : ""}>
        <span className="hub-code" title={q.bot}>{codeOf(q.bot)}</span>
        <span className="hub-queue-title-text" title={q.title}>{q.title}</span>
        <span className="hub-status"><i className={"hub-dot " + tone(q.status)} aria-hidden="true" />{statusWord(q.status)}</span>
      </li>)}
      {!shown.length && <li className="hub-nothing">Nothing here.</li>}
    </ul>
    <button type="button" className="hub-footlink" onClick={onOpenFull}>OPEN FULL QUEUE →</button>
  </section>;
}
