# Databases, relations and editor shortcuts (branch `feature/databases`)

Status: implemented and unit-tested; **not yet run in a real Windows window** (see "Verification state"). Design decisions are in `docs/architecture/ADR-003-databases.md`.

## What exists
- **Inline databases.** Type `/` and choose *Database* to create one, or *Database: <name>* to show an existing one again (a linked view; this also recovers a database whose block was deleted). A database is a hidden child page of the note; its rows are hidden child pages with full rich-text bodies. Neither appears in the sidebar.
- **Views** (saved per database): Table, Board, List, Gallery, Calendar, Timeline, Map. Calendar, Timeline and Map create their Date/Place column when the database has none. The Map is an offline latitude/longitude plot on a degree grid (no map tiles, no network, no coastlines).
- **Properties:** text, number, select, multi-select, status, date, checkbox, URL, email, phone, place, created time and last edited time (automatic, read-only), relation (one- or two-way, kept in sync) and rollup (computed in Rust: counts, percentages, sum, average, median, min, max, range, earliest/latest, checked counts, show original).
- **Column menu:** rename, change type (only when no value would be lost), filter, sort, group, calculate, freeze, hide, wrap, insert left/right, duplicate, delete (soft), and option editing.
- **Per-view settings** (validated in Rust; unknown property ids or operators are refused): filters with And/Or, sorts, grouping, hidden/frozen/wrapped columns, column widths, calculation row. A search box filters every view.
- **Row actions:** open in a side panel, duplicate (values, links and page body), move to Trash.

## Storage (schema v4, `db/notes/004_databases.sql`)
`databases`, `db_properties` (soft delete), `db_options`, `db_rows`, `db_values` (one JSON value per cell), `db_relations` (relational, so `PRAGMA foreign_key_check` covers links), `db_views` (soft delete, last view protected). Everything is inside `notes.sqlite3`, so existing backups, restore, rollback and schema validation cover it. `validate_notes` compares against the shipped migrations including 004.

Deleting a column hides it; its values stay in the file. Deleting a select option clears it from rows (after a confirmation). Rows go to the normal page Trash.

**Downgrade risk:** once a profile is upgraded to v4, builds without this migration (0.0.3 and earlier 0.0.4 builds) refuse to open it. A `schema-rollback` snapshot is taken first, as for v3. Rehearse the upgrade on a **copy** of real data before using a real profile.

Schema v4 was amended several times on this branch before any real profile used it. A disposable profile created by an earlier commit of this branch will not match the final v4 definition; create a new one.

## Keyboard shortcuts added
Ctrl+Q Quick find, Ctrl+P print, Ctrl+\ sidebar, Ctrl+[ / Ctrl+] history, Ctrl+1–9 tabs, Ctrl+Shift+T reopen tab, Ctrl+Shift+L theme, Ctrl+Shift+U parent page, Ctrl+= / − / 0 zoom, Ctrl+/ shortcut list, Ctrl+D duplicate block, `@` page link. Heading, list, code-block and move-block shortcuts come from BlockNote (confirmed in its source, not re-implemented).

## Testing without a launchable build
Windows Smart App Control (enforcing) blocks freshly built unsigned executables on some machines (`os error 4551`), including the Tauri dev binary. `cargo test --lib` and the Vitest suite are unaffected. Never launch the app without `NOU_PROFILE_DIR` pointing at a disposable folder; without it the app opens the real `%APPDATA%\app.projectnou.desktop` profile. PowerShell:

```powershell
$env:NOU_PROFILE_DIR = "C:\path\to\disposable-profile"
npm run tauri dev
```

## Verification state (11 November 2026)
Ran and passed: TypeScript, 91 Vitest tests, 38 Rust library tests (`cargo test --locked --lib`) including the v3→v4 upgrade, backup/restore with database data, value/config validation, two-way relations, rollups and duplicate-property. Layout of table, board, calendar, timeline and map was checked in a browser pane with a **fake Tauri backend**.

Not run: the Python SQL tests and the `tests/native-core` crate after the v4 changes; the Tauri binary target's (empty) test run (blocked by Smart App Control); anything in a real WebView2 window.

## Acceptance checklist (needs a build that can run, on a disposable profile)
1. `/Database` creates a table; add rows, every property type, a Status change, a relation (two-way) and a rollup; restart and confirm everything persisted.
2. Each view type; drag a board card between columns; calendar day "+"; timeline bars; map pins.
3. Column menu: sort, filter (And/Or), group, calculate, freeze, hide, wrap, resize, insert, duplicate, change type refusal with data.
4. Row side panel: edit the page body, close; confirm navigation is blocked while it shows "Saving…".
5. Delete a database block, then re-insert it with `/Database: <name>`.
6. Back up, restore into a second disposable profile, confirm databases, relations and rollups match.
7. Upgrade rehearsal: copy a real profile (never the original), open the copy, confirm the rollback snapshot exists and notes are intact.
8. Close with the window X; drop an image, a PDF and an HTML file onto a page; resize an image by its right edge; Ctrl+P print preview; all shortcuts above.

## Known limitations
- Note export/import (JSON) does not include databases.
- Quick find does not list database rows by title (rows are hidden from the page list).
- Relations support filtering only by empty/not empty; relations and rollups cannot be converted or duplicated.
- Missing compared with Notion: formulas, date ranges/times, person/files/button/ID properties, templates and the New-row menu, row/column drag-reordering, multi-row selection, cell keyboard navigation, charts, full-page databases, CSV import/export.

## Updates after first use in the real window (12 November 2026)
- **Slash menu:** `/database` offers only *Database*. Existing databases (linked view, or recovering an orphan) are listed only after typing `/linked` or `/existing`.
- **Empty table:** just the header and *+ New row* (no "No rows" text, no empty calculation row). The calculation row appears once a calculation is set from the column menu.
- **Row page:** opening a row (table, board, list, gallery, calendar, timeline or map) shows a full page: editable title, every property as an editable field (rollups and automatic times read-only), then the body. *Expand* makes it full width.
- **Row handles:** hovering a table row shows **+** (add a row directly below) and **⠿** (drag to reorder; drop on a row to move before it, or on *Move to the end*). Reordering is off while the view is sorted or grouped, and when read-only. Uses the existing `relocate_page` ordering.
- **Full width:** the database block fills the page and extends into the margins (16px gutter); wider tables, boards and timelines pan with a horizontal scrollbar.
- **Places by name or address:** a Place cell and the Map's search box accept a name or address; pressing **Enter** looks it up on OpenStreetMap Nominatim and the chosen result is saved with its name, address and coordinates. Typing coordinates (`35.68, 139.69`) still works and never goes online.
  - **Privacy and security:** this is the only place the app contacts a third party. It happens only on Enter, never in the background, and only the typed text is sent (to `nominatim.openstreetmap.org`). The app's content-security policy was widened by exactly that one host (`connect-src` in `tauri.conf.json`). Remote answers are validated (coordinate ranges, lengths) and shown as plain text. The Rust validator accepts an optional `address` (300 characters) on a place.
  - The Map is still an offline degree grid; places found online are plotted on it, but no map tiles or coastlines are drawn.
- **Editor shortcuts:** Ctrl+Shift+H applies the last highlight colour (again to remove); Tab and Shift+Tab stay in the note text.

Verified: TypeScript clean; 171 Vitest tests (geocoder validation, place search in the cell and on the map, row page, row handles and drag, empty table, slash-menu rule, full-width rules). In a browser with a fake backend and the real app and styles: the `/data` menu, the full-width block with horizontal scrollbar, **+** inserting between rows, and the row page. **Not verified:** a live OpenStreetMap lookup (no network call was made in tests), real mouse-drag reordering in the Tauri window, and Ctrl+Shift+H on selected text in the real editor (the colour logic is unit-tested; the BlockNote calls are not).
