# Life Timetable and the Home "Now" timer

A permanent page that holds the weekly routine, a **Now** card on Home that counts down to the end of the current event, a **Focus view** with a round timer, and a reminder shortly before the next event starts. Schema version **10**.

## What was built

- **Data** lives in the notes database (`db/notes/010_life_timetable.sql`): `timetable_activities` (name, category, optional colour, `remind`, order) and `timetable_slots` (`weekday` 0 = Monday … 6 = Sunday, `slot_index` 0–47 for half hours from 00:00, `activity_id`; primary key on all three so one slot can hold several activities). Activity names are unique ignoring case. A slot cannot point at a missing activity (`ON DELETE RESTRICT`).
- **The page** is a row in `pages` with `system_key = 'life_timetable'` (id `system-life-timetable`), created at startup if missing. It is hidden from the page tree, search, graph and Home lists, and shown as the permanent sidebar item **Life Timetable**. It has no note content: the UI opens the timetable view for it.
- **Protection is in the database and in Rust, not only the UI.** `rename_page`, `trash_page`, `move_page`, `relocate_page` and `create_page` (as a parent) call `timetable::refuse_system`. Triggers in migration 010 refuse any direct `DELETE`, or `UPDATE` of title, parent, trashed flag, workspace or key on that row.
- **Seed** (`apps/desktop/src-tauri/seed/life_timetable.json`, from the Notion "Life Timetable", Areas, updated 20 Nov 2026) is loaded once, during the 9 → 10 upgrade, only when both timetable tables are empty. Later launches never touch it.
- **Backups.** A backup is a full copy of the notes database, so the timetable is included in every backup, encrypted backup and restore. There is no separate "Recovery JSON" for the whole database (that export is per note), so none was added.
- **Timing logic** is pure TypeScript in `apps/desktop/src/timetable/schedule.ts`; the rest (`useTimetable`, `reminders`, `NowCard`, `FocusView`, `LifeTimetable`) only reads the clock and draws.

## Timing rules

- An event is a run of consecutive slots holding the **same set of activities**. The countdown runs to the end of the run, not of the 30-minute slot. Two runs with the same name are separate events (Work 09:00–13:00 and 13:30–17:00).
- Runs wrap across midnight and from Sunday into Monday (Sunday 22:00 Bed time ends Monday 05:00).
- Everything is worked out from `Date` in the device's local time zone on every tick. Nothing counts intervals, so sleep, travel and clock changes correct themselves on the next tick. Start and end times are built from wall-clock minutes, so on 25 Oct 2026 (25-hour day) and 29 Mar 2026 (23-hour day) the countdown is still right (both have tests).
- A slot with several activities counts each of them in the **hours per category** table, as the Notion rollups did, so a day can total more than 24 hours.

## Reminders: where they run, and why

The decision is made in the page (one tested copy of the rules in `schedule.ts`). A hidden or minimised webview throttles its own JavaScript timers, so the Rust side starts a native thread that sends a `timetable-tick` event every 10 seconds; that event is not throttled and runs the check on time in the background. A 5-second interval plus focus, visibility and "simulated time changed" events cover everything else, including waking from sleep.

- Fires once per transition: the key (date + weekday + slot of the next start) is saved to `localStorage` (`nou-timetable-last-reminder`) before anything is shown.
- If the app opens or wakes inside the window it fires at once; if the next event has already started it never fires late.
- Skipped when every activity of the next event has `remind` off, or when reminders are off in Settings. Lead time is set in Settings (1–60 min, default 5): stored in `localStorage` (`nou-timetable-reminders`).
- Output: an in-app toast and a Windows notification through `tauri-plugin-notification`. Permission is requested once; if denied or unavailable the toast still shows.
- Limit: reminders work while the app is running (hidden or minimised is fine). A closed app cannot remind; there is no tray or background service.

## Upgrade warning

Opening an existing database with this version makes a rollback snapshot (`schema-rollback`) and upgrades it to schema 10. **Older alphas cannot open a schema 10 database.** Backups made before this version restore normally (they are upgraded on restore); backups made with this version cannot be restored by older builds.

## Known gaps

- "Dark Sphere / Library deep learning (alternating)" is one combined activity (category Leisure). There is no recurrence engine; the alternation (twice each a month) is a TODO.
- Only `Leisure` is stored for that activity, though Notion lists Leisure + Training.
- Copying a day replaces the target days completely (it asks first).
- Windows notifications from a `tauri dev` run are attributed to the development host process; use an installed build to see the app's own name and icon.

## Manual acceptance checklist

Use a disposable profile (`NOU_PROFILE_DIR=<empty folder>`), never real data.

1. Start the app. Sidebar shows **Life Timetable** under Files. It does not appear in the page tree, search or graph.
2. Open Home: the **Now** card is at the top. Its name, times and category colour match the grid; the countdown ends at the end of the run.
3. Open Life Timetable (sidebar, or click the Now card). Today's column is highlighted, the red/yellow now line sits at the current time, the grid is scrolled to it.
4. Edit: click a slot, drag across several, or use the arrow keys (Shift extends); press Enter, tick activities, Apply. The status reads Saving… then Saved. Delete clears slots. "Copy day" asks first.
5. Go back to Home without restarting: the Now card reflects the edit.
6. Activities: add, rename, change category and colour, toggle Remind, delete. Deleting a used activity needs a replacement; deleting an unused one does not.
7. Totals table matches the grid (Mon Work = 7.5 h in the seed).
8. Try to rename or trash the page: there is no button for it; a direct write is refused (Rust tests cover `rename`, `trash`, `move`, `relocate`, child creation and raw SQL).
9. Settings → Timetable reminders: tick/untick, set the lead time.
10. Reminders (development build): Settings → Simulate time → pick a time 5 minutes before a change (for example Monday 12:55) → **Set the app clock**. Expect one toast and one Windows notification: "In 5 min: Meal · 13:00–13:30". Wait several ticks: no repeat. Minimise the window and repeat with another change: it still fires. Restart the app inside the window: no duplicate. **Use the real time** to return.
11. Focus view: the corner button on the Now card opens a full-window round timer (hh:mm:ss, bell with the end time). Pause holds the picture, the arrow returns to live time, Esc closes.
12. Back up (Settings → Backups), edit the timetable, restore the backup: the timetable is as it was.

## Tests

- Rust (`cargo test --locked --lib`): migration on a fresh and upgraded database, 48 filled slots per day, spot checks of the seed against Notion, seed-only-when-empty, system page refusals (rename, trash, move, re-key, delete, relocate, create child), slot edit/copy/clear, activity validation, delete/reassign, backup → restore round trip.
- Vitest: `schedule.test.ts` (current event, merged runs, multi-activity slots, midnight and Sunday → Monday wrap, BST and GMT change days, sleep/resume, reminder once, no stale reminder, `remind` skip, lead time, edit) and `timetable.ui.test.tsx` (Now card, Focus view, reminder once and after reload, native notification denied, grid editing, activities).

The simulate-time control exists only in development builds (`import.meta.env.DEV`) or a build made with `VITE_NOU_SIM_TIME=1`.
