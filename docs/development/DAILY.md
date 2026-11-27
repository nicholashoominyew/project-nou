# Daily page

One page per date: a month calendar, a day page, and the journal on the same page with a focus mode. Sidebar: **Daily**. The Home card's "Open today's page" opens it too (older pages titled with a date are untouched).

## What is built (stage 1 of 4)
- Calendar and day page, light and dark. Cards and the days they appear come from `apps/desktop/src/daily/section-registry.json`.
- Journal (six blocks) saved as typed. A journal is "written" with 3 goals, a small win and a learning; "started" with anything in it.
- Imported briefing sections, read-only apart from ticking to-dos.
- Habits are read from the Habits log; nothing is duplicated. A day shows the habits that count on it (not a fixed five).
- Teaching of the day: imported text for that date, otherwise five teachings from different books out of a NOU database called **Teachings** (Teaching title or text column, Book, Author).

## Not built yet
Section index and permissions, agent writes through proposals, the audit log, an MCP view of any of it, and the Wednesday and Saturday project touchpoints. No assistant can read or write the Daily page, including the journal.

## Data (schema 21)
`daily_days` (date is the key), `daily_entries`, `daily_journals`, `daily_summaries`. The calendar reads only the summaries. Habit dots come from the habit log. Days are Europe/London.

The upgrade is one-way: update other devices before syncing.

## Import history
Takes Markdown files (one per day) or `{"days":[{"date","notion_page_id","markdown"}]}`. Headings are matched to the registry; unrecognised ones are reported and left out. Importing again adds nothing already there, and never replaces a journal that has writing in it. Nothing is written to Notion. The format has not yet been tried against a real Notion export.

## Open decisions (answered 27 Nov 2026)
Bots keep writing to Notion until cutover; Braindump and WECS are separate cards; Teachings are copied into NOU.
