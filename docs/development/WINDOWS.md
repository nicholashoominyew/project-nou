# Windows development guide

## Status
Early Phase 0/Phase 1 prototype. GUI supports page hierarchy, rename, manual up/down ordering and trash, plus a **plain-text Notes editor backed by Yjs updates stored in SQLite**. Rich-text blocks and BlockNote are not implemented yet. Test before storing important notes.

## Prerequisites
1. Windows 10/11 (Windows 11 recommended).
2. Node.js current LTS and npm.
3. Rust MSVC toolchain (`rustup` with x86_64-pc-windows-msvc).
4. Visual Studio Build Tools with **Desktop development with C++** workload.
5. Microsoft Edge WebView2 Runtime (usually bundled with Windows 11).
6. Git.

Tauri requirements: https://v2.tauri.app/start/prerequisites/

## Run the application
Open PowerShell:

```powershell
git clone https://github.com/nicholashoominyew/project-nou.git
cd project-nou
npm install
npm run tauri -- dev
```

The app creates its SQLite Notes database in the **per-user Windows application-data directory** resolved by Tauri for `app.projectnou.desktop`.

## Validate
```powershell
python -m unittest discover -s tests -v
npm run typecheck
npm run build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## First Windows installer (unsigned test build)
The repository contains a dedicated GitHub Actions workflow: [Windows desktop build and test installer](https://github.com/nicholashoominyew/project-nou/actions/workflows/desktop-checks.yml).

It runs on pushes to main and can be started manually from **Actions → Windows desktop build and test installer → Run workflow**. A successful run must pass SQLite unit tests, TypeScript compilation, Vite build, Rust unit tests, Rust check and Tauri/NSIS packaging.

To retrieve the generated installer:
1. Open the completed successful workflow run in GitHub Actions.
2. Under **Artifacts**, download `project-nou-windows-x64-unsigned`.
3. Unzip the archive to locate the Windows x64 `.exe` installer.
4. Install only on a spare Windows PC/VM, with no important Notes data. The installer is **unsigned**; Windows SmartScreen may warn. Verify that the archive came from the repository's own Actions run rather than a third-party mirror.
5. Create a test page, enter text, close and reopen, search notes, test Trash/Restore, then test a recovery snapshot and non-destructive staged restore.
6. Report failures with the exact GitHub workflow/job or application error and Windows version.

Alternatively, build locally from PowerShell:
```powershell
npm install
npm run icons
python -m unittest discover -s tests -v
npm run typecheck
npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run package:windows
```

Installer output should appear in `apps/desktop/src-tauri/target/release/bundle/nsis/`. Building the installer does **not** guarantee runtime correctness; keep backups and avoid important data. Production distribution requires code signing, reproducible dependency locking, restore tests, and hardening.

The Tauri icon files are generated on demand from `apps/desktop/assets/nou-icon.svg` using `npm run icons`. Run this before native `cargo check` or packaging after a fresh checkout.

## Security and limitations
- Do not use this prototype for irreplaceable data.
- Plain-text note-body editing is present, but not yet validated end-to-end on Windows; no BlockNote-rich-text UI, encryption key handling, sync or automatic off-device backup is in place.
- Only the single default `personal` workspace is exposed.
- Deleting a page moves it and its active descendants to Trash. A Restore action is now in the prototype, but Windows end-to-end behavior is unverified.
- Hierarchy cycle prevention for arbitrary reparenting will be implemented before adding drag-and-drop.
- Network/server connectivity is **not required**.

## Data backup
While app is CLOSED, back up its complete per-user application data directory using a verified copy. Do not assume copying an open WAL-mode SQLite database is a consistent backup. The application backup workflow will be implemented separately using SQLite's online backup API.

## Offline writing acceptance test (manual; not yet verified)
1. Run the application with `npm run tauri -- dev`.
2. Create a new page, type two paragraphs, and wait for **Saved on this device**.
3. Switch to a different page and reopen the first page; confirm content persists.
4. Exit the application, restart it and confirm content remains.
5. Disconnect from the network and repeat editing and reopening.
6. Simulate a failed disk write only in a disposable test database; verify a visible save error instead of false success.

Notes are Yjs documents stored as ordered updates. The current prototype uses a plain-text `Y.Text` field named `body`; a future BlockNote editor needs a defined migration strategy. Do not assume Yjs text updates are directly compatible with BlockNote block trees.

## Offline search acceptance test (manual; not yet verified)
1. Create a new page with the title `Morning planning`, without typing body text.
2. Search for `Morning` in the sidebar; verify the page is visible.
3. Type `Project NOU offline notes`, wait for a successful save and search for `offline`.
4. Switch pages and search again. Confirm that stored text is searchable.
5. Move a matching page to trash and verify it no longer appears in search results.
6. Rename another matching page and verify the new title is indexed.
7. Try punctuation and literal double quotes; a search must not throw an FTS query syntax error.
8. Close, reopen and repeat the search while disconnected from the network.

Implementation uses SQLite FTS5 over the separate Notes database. Search is a locally derived cache; the authoritative document remains Yjs update history. This milestone does **not** include backlinks or semantic/AI search.

## Local recovery snapshot (prototype)
Click **Create recovery snapshot** in the Notes sidebar **after all current note edits display Saved on this device**. The desktop issues a `VACUUM INTO` command through SQLite, creating a **new consistent standalone database** even when the main database runs in WAL mode. The application verifies `PRAGMA integrity_check` and Notes schema version before reporting success, and shows the snapshot's full Windows path.

**This does not replace real backups:** by default snapshots are saved under the same Windows application-data directory as the live Notes database, in a `snapshots` subfolder. If the PC, disk or Windows profile is lost, both can disappear. Copy the snapshot file to an **independent destination** such as an external drive, then verify that copy opens and passes integrity checks. The system does not automatically send or encrypt snapshots off-device. Automated weekly server-to-desktop duplicate backup is a later phase.

### Recovery procedure for an isolated test copy
1. Exit Project NOU completely; keep the original database and its `-wal` and `-shm` files unchanged.
2. Copy the snapshot to a separate test directory, using a separate filename such as `restore-test.sqlite3`.
3. Open the copied database in a compatible SQLite tool, execute `PRAGMA integrity_check;` and confirm the result is `ok`.
4. Confirm schema version is 1 and inspect `pages` and `yjs_updates` records. This does not validate editor-level reconstruction; that is a separate test.
5. **Do not overwrite the live database while the application is open.** Full guided restore/import is not implemented; test an actual rollback before using this with personal data.

The backend also supports `verify_notes_snapshot` for a snapshot filename within the application's own snapshot directory; it rejects path traversal. The Rust backup module includes tests for consistent snapshots and invalid filenames. Python `tests/test_notes_snapshot.py` independently exercises `VACUUM INTO` with WAL and confirms it refuses overwrites.

**Known limitation:** each editor save writes a full Yjs state update; storage compaction, write coalescing, and comprehensive editor load/save integration testing remain future work.

## Safe restore rehearsal (new prototype control)
After creating a verified snapshot, choose **Verify a separate recovery copy**. The native `stage_notes_restore` command only accepts a validated snapshot filename from the controlled snapshots directory. It copies into a **new randomly named file** under the application's `restore-staging` directory, checks SQLite integrity and schema version, and leaves the active `notes.sqlite3` and its WAL files unchanged.

### Acceptance test
1. Create a page called "Recovery Test" with a paragraph of content and wait for "Saved".
2. Create a snapshot using the sidebar button.
3. Change the page text and wait for "Saved" again.
4. Choose "Verify a separate recovery copy", then open the displayed staged SQLite path with a SQLite viewer and inspect the `pages` and `yjs_updates` tables.
5. Confirm the staged file contains state from before the subsequent edit, while the live application still shows the subsequent edit.
6. Restart Project NOU. Verify the live state is unchanged.
7. Run Rust tests: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`. Inspect the backup test results; tests are committed but native execution is not verified in this environment.

**Not a live restore:** The application intentionally does not overwrite, import, or switch its live Notes database. Test-restore copies are for recovery rehearsals only. A future explicit restore workflow must close database connections, preserve an emergency copy of the current database and WAL/SHM, verify both source and destination, and allow a rollback on failure.

**Retention warning:** Test restores and snapshots consume disk space until cleaned up. Do not delete your only verified backup.

## Trash and page recovery (prototype)
1. Create a page with a subpage and save some note text in both.
2. Select the parent and click **Trash**; confirm the parent and child disappear from the normal sidebar and search.
3. Open **Trash** in the sidebar. The UI lists the top-level trashed pages; nested children deleted with their parent are recovered together.
4. Click **Restore** and verify both pages return, along with their existing SQLite Yjs update history.
5. Test a sort-key conflict: delete a page, create a new page in its previous sibling position, then restore the original. Both pages should remain visible with unique keys.
6. Verify an independently trashed child remains in Trash after its parent is separately trashed and restored.
7. Exit and reopen the desktop application; confirm page hierarchy, order and note content survive.

**Safety rules:** Restoration is transactional and does not erase Yjs updates. A child cannot be restored while its parent is still in Trash; restore its parent first. A restore only brings back descendants sharing the parent operation's deletion timestamp. No permanent delete button is provided in this prototype. The existing local snapshot and independent backup precautions still apply.

**Verification status:** The Python test `tests/test_notes_trash_restore.py` tests SQLite restoration semantics; actual Tauri/Rust integration and Windows GUI flows are not verified yet.
