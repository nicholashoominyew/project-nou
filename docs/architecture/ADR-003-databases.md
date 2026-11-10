# ADR-003: Databases and relations

Status: phases 1 to 3 implemented on branch `feature/databases` (see `docs/development/DATABASES.md` for what is built and verified); phase 4 not started.

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
  checked by `PRAGMA foreign_key_check`. Used by relation columns (two-way relations store a mirror row).
- Everything is schema v4 (`db/notes/004_databases.sql`), validated by backup/restore like earlier versions.
- Rows are hidden from the sidebar tree; the database page shows them as a table.
- Deleting a property soft-deletes it (`deleted_at`); values stay in the file. Deleting a row or database
  uses the existing page trash. Nothing is erased irreversibly.

## Phases
1. Properties and table view. **Done** (plus email, phone, place, created/last-edited time).
2. Relations (one- and two-way) and rollups. **Done.** Relations are filtered only by empty/not empty; duplicating or converting them is refused.
3. Sorting, filtering, saved views, board, calendar, gallery, timeline, list, offline map. **Done.**
4. Formulas, date ranges, templates, CSV/Notion import, recurring rows. **Not started.**

## Later decisions
- Databases are **inline blocks** inserted with `/` (not sidebar pages). The block stores only the database id, so the same database can be shown in several places ("linked view"). A database whose block is deleted stays hidden in the file and can be re-linked from the `/` menu.
- Views are stored (`db_views`) and every view setting is validated against the database's own properties before it is saved.
- Rollups are computed in Rust when a database is read, so every client sees the same value.
- Schema v4 was amended before any real profile used it. After the first real profile is upgraded, further changes must be a new migration (v5).

## Risks
- Moving the live profile to v4 means older builds (0.0.3, 0.0.4 before this branch) refuse to open it.
  A `schema-rollback` snapshot is taken before the upgrade, as for v3.
- Values are validated in Rust per type; the frontend is never trusted.
