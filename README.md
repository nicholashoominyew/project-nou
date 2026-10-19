# Project NOU (脳)

A Windows-first, local-first knowledge workspace with **two separate systems**: Notes (primary) and Files (secondary).

## Current stage
**Phase 0 progressing into an early desktop prototype.** A Tauri/React UI and Rust/SQLite Notes backend are committed, but the native build and GUI have **not yet been validated**. Do not store important data in this prototype.

## Prototype capabilities
- Create a page or nested subpage in the default Personal workspace.
- Rename and manually reorder pages using up/down controls.
- Move pages and descendants to Trash; recover deleted page trees through a Restore action without clearing their Yjs update history.
- Keep page metadata in an offline per-user SQLite database.
- Plain-text note content editor with Yjs updates saved to SQLite and local FTS5 title/body search.
- Local **recovery snapshot creation and integrity verification** via SQLite `VACUUM INTO` (same PC by default; not independent backup).
- Stage verified recovery copies without replacing the live database; full live-database restoration remains out of scope.
- **Not implemented:** BlockNote rich-text blocks, file manager, server sync, automated/off-device backups, guided full-database restoration, signed installer.

## Windows test installer

GitHub Actions is configured to run the Windows compilation, SQLite/Rust tests, and unsigned NSIS packaging. After a **successful** [Windows desktop workflow run](https://github.com/nicholashoominyew/project-nou/actions/workflows/desktop-checks.yml), download the `project-nou-windows-x64-unsigned` artifact from that run. The ZIP should contain an NSIS installer EXE and `SHA256SUMS.txt` for integrity verification. This prototype installer is **not code-signed** and is **not production-ready**. Do not test it with your real notes until backup and recovery have been confirmed.

**Release verification:** A committed GitHub Actions workflow is not itself evidence that CI passed or that an installer was successfully uploaded. See the successful run and its artifacts before treating the test build as available.

## Windows development
See [Windows setup and commands](docs/development/WINDOWS.md). After installing Node.js, Rust MSVC, Visual Studio C++ Build Tools and WebView2:

```powershell
git clone https://github.com/nicholashoominyew/project-nou.git
cd project-nou
npm install
npm run icons
npm run tauri -- dev
```

Check build and database tests:
```powershell
python -m unittest discover -s tests -v
npm run typecheck
npm run build
npm run icons
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
- [Snapshot safety tests](tests/test_notes_snapshot.py)
- [Trash and Restore SQL behavior tests](tests/test_notes_trash_restore.py)
- [Native backup implementation](apps/desktop/src-tauri/src/backup.rs)
- [Windows development guide](docs/development/WINDOWS.md)
- [Phase 0 issues](https://github.com/nicholashoominyew/project-nou/issues)

## Next engineering milestones
1. Verify Windows CI runs, fix native compilation and add necessary bundle assets.
2. Validate offline editor persistence and SQLite search on an actual Windows machine.
3. Verify local snapshot restore on a Windows test machine, then build independent off-device backup and guided restore; add BlockNote with explicit migration from current Y.Text.
4. Design Files database and verified archive state machine separately.

Never commit private note contents or credentials.
