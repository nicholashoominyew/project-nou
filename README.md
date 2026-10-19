# Project NOU (脳)

A Windows-first, local-first knowledge workspace with **two separate systems**: Notes (primary) and Files (secondary).

## Current stage
**Phase 0 — architecture and data design.** The app is not yet installable; the repository currently contains architecture and first-pass SQLite design.

## Decisions
- Start offline on the existing Windows desktop; no Beelink hardware required for Phase 1.
- Later home server target: fully configured **Beelink SER8 Ryzen 7 8745HS**, Windows 11 Pro preferred.
- Notes: Notion-style editor, hierarchy, manual sort, search and Yjs persistence.
- Files: OneDrive-style manager with weekly verified archive to the desktop's 4 TB drive.
- Notes backup is a **duplicate**, while Files archive is a **move**; neither substitutes for an independent backup.

## Files
- [Architecture baseline](docs/architecture/PHASE-0.md)
- [Notes persistence decision](docs/architecture/ADR-001-notes-persistence.md)
- [Initial Notes SQLite migration](db/notes/001_initial.sql)
- [Phase 0 backlog](https://github.com/nicholashoominyew/project-nou/issues)

## Next engineering milestone
Create the Windows desktop monorepo and migration runner, then run schema + page-order integration tests against a temporary SQLite database. Do not store credentials, exports or private Notes content in this repository.
