# ADR-003: Databases and relations

Status: proposed, phase 1 in progress (branch `feature/databases`).

## Context
Notion-style databases are the next large feature. The user's Notion workspace (for example Live Projects)
uses checkbox, select, date, text, title, created-time and relation properties. Notes are pages with
Yjs/BlockNote bodies in `notes.sqlite3`; uploads live in the separate `files.sqlite3`.

## Decision
- A database is a normal page that also has a row in `databases`. Its rows are normal child pages listed in
  `db_rows`, so every row keeps a full rich-text body, search, trash, favorites and backup coverage.
- The row title is the page title. Other columns are `db_properties`; select-like choices are `db_options`;
  cell contents are one JSON value per (row, property) in `db_values`.
- Relations are stored relationally in `db_relations` (property, from row, to page) so references can be
  checked by `PRAGMA foreign_key_check`. The table ships in v4 but is unused until phase 2.
- Everything is schema v4 (`db/notes/004_databases.sql`), validated by backup/restore like earlier versions.
- Rows are hidden from the sidebar tree; the database page shows them as a table.
- Deleting a property soft-deletes it (`deleted_at`); values stay in the file. Deleting a row or database
  uses the existing page trash. Nothing is erased irreversibly.

## Phases
1. Properties: text, number, select, multi-select, status, date, checkbox, URL. Table view, add/remove
   rows and columns, edit cells. (this branch)
2. Relations (one-way, then two-way) and rollups.
3. Sorting, filtering, saved views; board, calendar and gallery.
4. Formulas, Notion CSV import, recurring rows.

## Risks
- Moving the live profile to v4 means older builds (0.0.3, 0.0.4 before this branch) refuse to open it.
  A `schema-rollback` snapshot is taken before the upgrade, as for v3.
- Values are validated in Rust per type; the frontend is never trusted.
