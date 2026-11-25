# Habits and timetable check-ins

A permanent **Habits** screen (sidebar). Habits are also **activities in the Life Timetable**. Schema version 17.

## Habits are timetable activities
- Adding a habit on the Habits page adds an activity of the same name to the timetable, listed first under **Habits** in the block editor and the Activities panel.
- A habit has a **type** (Training, Health, Work, Leisure, Chores, Travel, Rest). Its blocks take that type's colour.
- If a timetable activity with the same name already exists (in any category), the habit **takes it over**: it is not listed twice, it becomes the habit's type, and its blocks stay where they are.
- Renaming a habit (or its activity) or changing its type changes both. A habit's activity cannot be deleted from the timetable: delete the habit instead (its blocks stay as an ordinary activity and its history is kept).
- **The check-in time is where the habit sits on the grid.** A stretch of consecutive half-hours holding the habit, on one weekday of one week, is one check-in at its start. Moving, stretching, deleting or undoing a block moves the check-in with it.

## Pop-ups
- While a habit's block is **running** and the habit is not ticked for the day, NOU shows a pop-up with one button, **Checked in**, and a system notification (once). It stays up for the whole block until ticked, and goes when the block ends. Opening NOU in the middle of a block shows it straight away.
- There is no Skip. A day is done or not done.
- The **×** on a pop-up hides it for now (it stays open on the Habits page and comes back at the next block or when NOU is reopened).
- **Test pop-up** (Habits, Your habits) shows a pop-up and a Windows notification for a habit straight away, to check they work on this computer. Answering it ticks the habit for today.
- A habit only pops up if it is on the timetable. Your habits shows which habits are not ("Not on the timetable yet"), and a habit's window can **use an existing timetable activity** (for example "JP Anki"): the activity takes the habit's name and type and its blocks start checking in.
- Unanswered, the pop-up becomes **No answer** (not done) two hours after it was first shown, or when the block ends if that is later. A pop-up that expires while NOU is closed is not logged, so the day can be ticked by hand.
- Ticking on the Habits page closes the pop-up.

## Habits page (redesign)
Top to bottom: header with Import history; **Today** (a 96px ring with done/scheduled, one 56px circle per habit that counts today, no Skip: anything not done by the end of the day is not done); **Streaks** (7D / 30D / 90D, three tiles, the 8-week chart made of blocks of 7 days ending today, and a card per habit with its rate, streak and heatmap; tap a card to focus it); **History** (closed at first; Table with 14 days and "Show 30 more days", or Month); **Your habits** (closed at first; drag handle, weekday chips, delete, and the New habit form). Rates, tiles and bars count only the days a habit applied (it had started, and the weekday chip was on).
The heatmap is one row of 44px squares for 7D, a weekday grid of 24px for 30D and 14px for 90D, padded so the first day sits on its weekday row (Monday first). Motion is CSS only and is off under reduced motion. Fonts are bundled (Barlow Condensed for the big numbers). Home has a **Goals** card (JLPT N3 countdown to 4 Jul 2027, live Japanese and Anki streaks, the coding goal due Feb 2027); the Teaching card shows the author and a "Try today" line when the Teachings database has Author and How to apply columns.
The check-in pop-up follows the reference: CHECK-IN label with time and block name, the habit name in condensed capitals, one **Yes, started** button, and a footer with START ONLY · NO CHECK-OUT and the next block.

### Older description of the page
Today card, waiting pop-ups, history (table / month), charts, **Your habits**: drag the six dots (or press the up or down arrow on them) to reorder; click a habit to open its window (current and longest streak, last 30 days, totals, a 35-day strip, rename, type, days it counts, delete). "Import history…" brings in a JSON history file.

## How many habits make 100%
Under the Today circles, **Needed for 100%** has two choices. **Usually** is the number every day needs (or *Every habit*, the default); changing it counts from today, and earlier days keep what they had. **Today** gives one day its own number; for a past day use History, Month, then click the day. A day never needs more habits than count that day, and ticks beyond the target do not make up for another day. The ring, history, month, weekly bars, completion tiles and the Home calendar follow it; each habit's own rate and streak do not. It is a preference (`nou-habit-target`) that a sync carries; it is not in the database tables.

## Import file
`{"rows":[{"day":"YYYY-MM-DD","habit":"Exercise","done":true}]}` (or a bare array). Ticks only are stored, nothing existing is overwritten, and every habit in the file counts from the earliest day in it.

## Also in this release
- Today's tasks can be reordered by dragging the six dots (the drag follows the pointer itself, not the browser's drag-and-drop). The order is stored (`linked_todos.sort_order`).
- **Ctrl+Z** undoes (and **Ctrl+Y** or **Ctrl+Shift+Z** redoes) the last change on the timetable (blocks, resets, activities), Habits (ticks, new, renamed or deleted habits, order) and Today's tasks (ticks, order), up to 50 steps. Inside a text box or the note editor, Ctrl+Z keeps its normal typing undo. Page-level changes (trash, moves) are not covered yet.
- The Home calendar colours each past day in shades of the accent colour by the share of habits done (faint for few, strong for all) and shows a progress bar for the selected day.
- Assistants can propose, with your approval each time: add a habit, tick a habit for a day, reorder Today's tasks (plus the existing timetable requests, which can put a habit on a block by name). Reads: `GET /v1/habits` (timetable:read) and `GET /v1/todos` (notes:read), without ids.

## Data
`habits` (+ `category`), `habit_log`, `checkins` (derived from the timetable, rebuilt after every timetable change), `checkin_events`, `timetable_activities.habit_id`, `linked_todos.sort_order`, `app_settings`. See `db/notes/016_habits.sql` and `017_habit_activities.sql`.

## Known limits
- Checked on Windows 11 on 25 Nov 2026 (dev and release builds, throwaway profile): the pop-up through a running block, the toast reaching Windows with its **Checked in** button, dragging tasks and habits with a real mouse and keeping the order after a restart, Ctrl+Z and Ctrl+Y.
- Not verified: pressing the toast's button (Do Not Disturb was on, which also keeps banners off the screen). The plugin only reports a press while the toast is on screen, not from the notification centre. Toasts are silent. A build run from `target\` shows them under PowerShell's name; the installed app uses its own.
- Several habits on the same block each get their own pop-up.
