# Project NOU (脳)

A Windows-first, local-first knowledge workspace with **two separate systems**: Notes (primary) and Files (secondary).

## Current stage
**Phase 0 progressing into an early desktop prototype.** A Tauri/React UI and Rust/SQLite Notes backend are committed, but the native build and GUI have **not yet been validated**. Do not store important data in this prototype.

## Prototype capabilities
- Create a page or nested subpage in the default Personal workspace.
- Rename and manually reorder pages using up/down controls.
- Move pages and their descendants to trash (restoration UI not yet available).
- Keep page metadata in an offline per-user SQLite database.
- Plain-text note content editor with Yjs updates saved to SQLite and local FTS5 title/body search.
- **Not implemented:** BlockNote rich-text blocks, file manager, server sync, backup/restore, signed installer.

## Windows development
See [Windows setup and commands](docs/development/WINDOWS.md). After installing Node.js, Rust MSVC, Visual Studio C++ Build Tools and WebView2:

```powershell
git clone https://github.com/nicholashoominyew/project-nou.git
cd project-nou
npm install
npm run tauri -- dev
```

Check build and database tests:
```powershell
python -m unittest discover -s tests -v
npm run typecheck
npm run build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Design decisions
- Develop offline on the existing Windows desktop; the home server isn't needed for the initial prototype.
- Target later deployment on a fully assembled **Beelink SER8 Ryzen 7 8745HS** with Windows 11 Pro preferred.
- Notes: Notion-style editor, hierarchy, tags, stable manual ordering, search and Yjs persistence.
- Files: independent OneDrive-style system with verified weekly archiving to desktop 4 TB storage.
- Notes backup **duplicates**; Files archive **moves**; both require independent recovery coverage.

## Documentation
- [Architecture baseline](docs/architecture/PHASE-0.md)
- [Notes persistence ADR](docs/architecture/ADR-001-notes-persistence.md)
- [Initial Notes SQLite migration](db/notes/001_initial.sql)
- [SQLite schema tests](tests/test_notes_schema.py)
- [Windows development guide](docs/development/WINDOWS.md)
- [Phase 0 issues](https://github.com/nicholashoominyew/project-nou/issues)

## Next engineering milestones
1. Verify Windows CI runs, fix native compilation and add necessary bundle assets.
2. Validate offline editor persistence and SQLite search on an actual Windows machine.
3. Implement safe Notes backup/restore and a richer BlockNote document model with explicit migration from current Y.Text.
4. Design Files database and verified archive state machine separately.

Never commit private note contents or credentials.
