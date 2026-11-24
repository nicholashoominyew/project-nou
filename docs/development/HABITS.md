# Habits and timetable check-ins

A permanent **Habits** screen (sidebar) plus optional check-in pop-ups on Life Timetable blocks. Schema version 16.

## Behaviour
- A block can have one or more habits switched on in its editor ("CHECK-IN" section). A bell shows on such blocks.
- When a block **starts** (never when it ends) NOU shows a pop-up and a system notification with "Checked in" / "Skipping".
- Unanswered after **2 hours** (`EXPIRY_SECS = 7200`) is logged as **No answer**. That counts as not done.
- Blocks that start while NOU is closed or the PC is asleep are ignored (the start must fall between two looks no more than 2 minutes apart).
- A pop-up that expires while NOU is closed is not logged; it is marked lapsed and the day can be ticked by hand on the Habits page.
- Skipping and No answer count as not done and break a streak.
- Exercise and Anki are separate check-ins and can sit on the same 30-minute block.

## Habits page
Today card, waiting pop-ups, history (table / month), per-habit "days it applies", add / rename / delete, charts (streaks, completion 7/30/90 days, 12-week trend, answer split), and "Import history…".
Deleting a habit archives it; history is kept and adding the same name restores it.

## Import file
`{"rows":[{"day":"YYYY-MM-DD","habit":"Exercise","done":true}]}` (or a bare array). Ticks only are stored, nothing existing is overwritten, and every habit in the file starts counting from the earliest day in it.

## Data
`habits`, `habit_log` (one row per day and habit; state done/skipped/no_answer; source popup/manual/import/timeout), `checkins` (habit tied to a block: variant, weekday, start/end slot), `checkin_events` (pop-up record). See `db/notes/016_habits.sql`.

## Known limits
- Undo in the timetable restores slots but not check-ins.
- Moving or stretching a block moves its check-ins; deleting a block removes them.
- Not verified on real Windows: notification action buttons, WebView2 behaviour, behaviour across real restarts.
