# Life Timetable and the Home "Now" timer

A permanent page that holds the weekly routine as two alternating weeks (A and B), a current-event panel with a circular timer, a time distribution ring and table, a weekly/daily timetable you edit by clicking blocks, a focus mode, and a reminder shortly before the next event starts. Schema version **11** (v1 of this feature was schema 10). The approved visual reference is `docs/design/life-timetable-v2-reference.html`; it is a standalone prototype and was matched for layout, colours, spacing and behaviour, not copied as code.

## What was built

- **Data** lives in the notes database. `timetable_activities` (name, category, optional colour, `remind`, order) and `timetable_slots` (`variant` A or B, `weekday` 0 = Monday … 6 = Sunday, `slot_index` 0–47 for half hours from 00:00, `activity_id`; the primary key covers all four, so one slot can hold several activities). Migration 011 added the `variant` column by rebuilding the slots table and a small `timetable_settings` table (`swap_ab`).
- **Which week is this week:** ISO week number, odd = A, even = B, flipped by the persisted `swap_ab` setting. Week 47 of 2026 (16–22 Nov) is A. The resolver, the live timer and the reminder read each slot from the week it really belongs to, so on Sunday night the slots after midnight come from the **next** week's variant.
- **Saturday split.** The combined activity "Dark Sphere / Library deep learning (alternating)" is gone. Week A Saturday 11:30–19:00 is **Dark Sphere** (Leisure), week B is **Deep learning (library)** (Training). The upgrade only rewrites slots that still hold the old activity (edited slots are left alone) and deletes the old activity only when nothing uses it. The seed (`apps/desktop/src-tauri/seed/life_timetable.json`) now contains both weeks, so a fresh install gets A and B directly.
- **The built-in page** is a row in `pages` with `system_key = 'life_timetable'`, created at startup if missing. It is hidden from the page tree, search, graph and Home lists. Rename, trash, move, delete and "create inside it" are refused in Rust (`timetable::refuse_system`) and by database triggers.
- **Backups** are full copies of the notes database, so both weeks and the swap setting are in every backup, encrypted backup and restore. Backups made before this version restore normally (they are upgraded on restore).

## Time accounting

One slot is 30 minutes. A slot with n activities gives each **30/n minutes**; an activity with several categories would split its share equally across them (activities have one category today). A filled day always totals 24 h and a week 168 h (tested for both weeks).

## The page (top to bottom)

- **Header:** `NOU · 脳 · WEEKDAY · HH:MM`, the title, **Jump to now** (selects today, switches to this week's variant and scrolls to the now line) and **Activities** (the activities manager). No subtitle and no page-local theme toggle: it follows the app's light/dark theme.
- **Current event panel:** `NOW · HH:MM`, the time range (with `(+1)` past midnight), category chips, the event name, and a thin ring whose accent arc fills clockwise from 12 o'clock. The countdown in the ring shows **hours** (large, bold, hidden under an hour), **minutes** (same size, regular) and **seconds** (about half size, muted) with h / m / s labels. It is always live: no scrub slider, no LIVE button, no "Next" row. A **Focus** button opens focus mode. The same panel is the Home card (with a link to open the page).
- **Time distribution:** one donut and a table (Category · Hours · Share) driven by the timetable's Week/Day toggle: the whole week of the variant shown (168 h) or the selected day (24 h). Hovering or focusing a category highlights it in both and shows its hours and share in the centre.
- **Timetable:** the Week A/B button (an accent dot marks this week's variant), `This week is A · swap`, **Reset to plan** (only when that week differs from the plan; asks first and resets the week shown), **Add block**, the Week | Day toggle and, in Day view, day pills. Week view has a 60 px gutter, banded alternate columns, hour lines with `HH:00` labels, pill blocks coloured by category (Bed time is unfilled, shared slots are neutral with a split stripe along the bottom), a ring on the current block and a now line, both shown only on this week's variant. Below ~920 px the grid scrolls sideways.
- **Editing:** every block is a button. Click one (or **Add block**) to open the editor: start and end in half-hour steps, days (Mon–Sun), and activities grouped by category with the time split equally. **Save** stays disabled with an inline reason until at least one day and one activity are chosen and the end is after the start. **Clear to free time** writes the Free time activity. Saving writes the range for every chosen day in the **variant being viewed only**, in one SQLite transaction, through `timetable_save_range`, which validates everything and changes nothing if anything is wrong. Esc and the backdrop close the editor, focus stays inside it and returns to the block afterwards. After a save a toast offers **Undo** for ten seconds (`timetable_restore_cells` puts the previous slots back exactly).
- **Focus mode:** a full-window overlay with only the event name and a large ring with the same countdown, scaled to the window. Exit with the corner ✕ (aria-label "Exit focus mode") or Esc. The reminder toast stays above it.

## Colours

Each category has a fill and a text colour per theme (`--tt-work`, `--tt-work-ink`, …) in `theme.css`, mapped onto the app's existing theme variables for page, surface, text, muted, line and accent. A per-activity colour override still works: its text colour is black or white by contrast.

## Reminders: where they run, and why

The decision is made in the page (one tested copy of the rules in `schedule.ts`). A hidden or minimised webview throttles its own JavaScript timers, so the Rust side starts a native thread that sends a `timetable-tick` event every 10 seconds; that event is not throttled and runs the check on time in the background. A 5-second interval plus focus, visibility and "simulated time changed" events cover everything else, including waking from sleep.

- Fires once per transition: the key (date + weekday + slot of the next start) is saved to `localStorage` (`nou-timetable-last-reminder`) before anything is shown.
- If the app opens or wakes inside the window it fires at once; if the next event has already started it never fires late.
- Skipped when every activity of the next event has `remind` off, or when reminders are off in Settings. Lead time is 1–30 minutes (default 5), stored in `localStorage` (`nou-timetable-reminders`).
- Output: a toast (`UP NEXT IN m:ss`, the next event, its range, a dismiss ✕) and a Windows notification through `tauri-plugin-notification`. If notification permission is denied the toast still shows.
- Limit: reminders work while the app is running (hidden or minimised is fine). A closed app cannot remind.

## Upgrade warning

Opening an existing database with this version makes a rollback snapshot (`schema-rollback`) and upgrades it to schema 11. **Older builds cannot open a schema 11 database.** A database from the first Life Timetable branch (schema 10) keeps every slot in both weeks. A database that still has the old combined Saturday activity gets the split described above.

## Known gaps

- **Reset to plan** resets only the week being shown (the reference resets both). Editing also only changes the week shown, so this keeps the two consistent.
- Reminder lead time and the last-fired key live in `localStorage`, not the database.
- Windows notifications from a `tauri dev` run are attributed to the development host process; use an installed build to see the app's own name and icon.
- The multi-category split rule is implemented and tested through the equal-split maths, but activities have a single category today.

## Manual acceptance checklist

Use a disposable profile (`NOU_PROFILE_DIR=<empty folder>`), never real data.

1. Start the app. The sidebar shows **Life Timetable**; it is not in the page tree, search or graph. Home shows the current-event panel at the top.
2. Open the page. Header kicker, title, **Jump to now** and **Activities** are there; there is no subtitle and no theme toggle. Switch the app theme (light/dark) and check both palettes.
3. **A/B and swap:** the Week button shows the week in view with an accent dot on this week's variant. Click it to flip to the other week: the ring and now line disappear, the distribution title says WEEK B. Click `This week is A · swap`: A and B trade places (week 47 of 2026 is A with swap off). Saturday 11:30–19:00 is Dark Sphere in A and Deep learning (library) in B.
4. **Edit across several days, then undo:** click a block, add more days and another activity, Save. The grid, the distribution and the panel update at once; only the week in view changed. Press **Undo** in the toast and confirm the previous slots are back. Try Save with no activity or no day: it stays disabled and says why. Esc, the backdrop and Cancel close the editor and focus returns to the block.
5. **Clear to free time** on an existing block. **Add block** opens at 12:00–13:00 on the selected day with nothing chosen.
6. **Reset to plan** appears only after an edit; it asks first and then restores that week.
7. **Week | Day toggle drives the ring:** Week shows WHOLE WEEK · 168H, Day shows the selected day · 24H. Hover a category in the table: the ring highlights it and the centre shows its hours and share.
8. **Focus mode:** the Focus button opens the overlay with only the event name and the ring; Esc and the ✕ both exit.
9. **Reminder via the dev simulate-time flag** (development builds only; Settings → Timetable reminders → Simulate time): set the clock to 5 minutes before a change, for example Monday 12:55. Expect one toast (`UP NEXT IN 4:xx`, Meal, 13:00–13:30) and one Windows notification. Wait several ticks: no repeat. Minimise and repeat with another change: it still fires. Restart inside the window: no duplicate. Check Sunday 23:56 of a week whose next Monday is the other variant. **Use the real time** to return.
10. Back up, edit both weeks, restore: both weeks and the swap setting are as they were.
11. Take light and dark screenshots of the page, the editor and focus mode and compare them with the reference.

## Tests

- Rust (`cargo test --locked --lib`): fresh and upgraded databases (single week copied into A and B, Saturday split, edited slots untouched), both weeks fill 48 slots a day, only Saturday differs, seed only when empty, swap setting persistence, range save validation and rollback, undo restores exactly, reset to plan, system page refusals, activities, and a backup → restore round trip with both variants and the swap setting.
- Vitest: `schedule.test.ts` (ISO week → variant with swap and year ends, current event and countdown parts, Sunday → Monday crossing into the other variant, BST/GMT change days, sleep/resume, equal split totals 24 h / 168 h, reminder once, never stale, `remind` skip, lead time, this week's variant) and `timetable.ui.test.tsx` (panel, focus mode, reminder, A/B and swap, Week/Day and the ring, Reset, the editor: validation, focus trap, Esc, save, undo, clear, refused save; activities).

The simulate-time control exists only in development builds (`import.meta.env.DEV`) or a build made with `VITE_NOU_SIM_TIME=1`; it does not appear in release builds.

## Check-ins
Blocks can carry habit check-ins (pop-up at the start of the block). See [HABITS.md](HABITS.md).
