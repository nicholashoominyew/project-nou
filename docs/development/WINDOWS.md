# Windows development and acceptance

## Setup

Use Node 22+ and npm, Python 3.12+, Rust MSVC (`x86_64-pc-windows-msvc`), Visual Studio C++ Build Tools, WebView2 and Git. Follow [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm ci
npm run icons
npm run tauri -- dev
```

NOU resolves its per-user application data directory through Tauri for `app.projectnou.desktop`. On Windows this is normally `%APPDATA%\app.projectnou.desktop`; verify the actual directory rather than assuming. `notes.sqlite3`, its WAL/SHM sidecars, local recovery packages and the process lock live here. Never replace an open SQLite file.

## Automated checks and packaging

```powershell
npm run typecheck
npm test
npm run build
python -m unittest discover -s tests -v
./tests/test_cold_recovery.ps1
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run package:windows
```

The package command generates icons and runs `tauri build --bundles nsis -- --locked`. Installer output: `apps/desktop/src-tauri/target/release/bundle/nsis/`. CI runs these checks on Windows and uploads an EXE and SHA256SUMS. Download only a successful run's `project-nou-windows-x64-unsigned` artifact. Verify with `Get-FileHash -Algorithm SHA256`. The installer is unsigned; installing or launching a new build is a separate acceptance step.

## Manual acceptance checklist for this increment

Use a disposable Windows profile/VM, not the user's live Notes database.

1. Open a 0.0.1 profile with Unicode, blank lines, literal Markdown and a trashed child page. Confirm the schema upgrade retains every note and creates `schema-rollback` first.
2. Edit the original plain text, wait for Saved, switch pages and restart. Convert only the selected note. Check the preserved original, including blank lines and Unicode. Other notes must remain plain text.
3. Exercise slash menu, headings, bold/italic, lists, checklists, nested blocks, table cells, drag handles and Ctrl+Z/redo. Restart and compare formatting and content. Search for text in nested blocks and tables.
4. Verify saving/loading blocks navigation and window close. Simulate a failed save on a disposable profile: show failure, preserve text/full Yjs recovery data, stop queued writes, retry a complete state successfully. Forced process/OS termination can still lose edits that never reported Saved.
5. Repeat offline with network disconnected. The editor must not depend on a network service.
6. Follow the [backup/restore drill](BACKUP-RESTORE.md), including destination unplugging, corrupted packages, full restore, restart and rollback.
7. Open a second NOU 0.0.2 process against the same profile: it must refuse the lock. Close all older alpha instances before upgrading; they did not implement this lock.
8. Verify root/subpage creation, rename/order, body/title search and parent/child Trash restoration still behave correctly. Independently trashed descendants must stay trashed.

See [verified outcomes](VERIFICATION.md) for what has actually run. This checklist is not a claim that manual tests passed.

## Limits

- One local Personal workspace. No sync, arbitrary page reparenting, Files, attachment storage, importer, scheduled backups or application encryption.
- Full Yjs state is appended for each edit. There is no compaction; large histories consume disk and can slow backup/loading. Saves are capped at 8 MiB of Yjs state and 5 MB of text; failures remain visible with copy/retry options.
- Rich text has a separate format marker and fragment. Never open a schema-v2 profile with alpha 0.0.1: it should refuse the version. To downgrade, preserve the current profile and use a pre-upgrade schema-v1 recovery copy in a separate profile.
- Legacy standalone snapshot files and staged rehearsal copies remain untouched. They are not new manifest-based backup packages; see the recovery guide for conversion.
