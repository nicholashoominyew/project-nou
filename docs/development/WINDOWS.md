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

Building an installer can be attempted with `npm run tauri -- build` after completing the icon/assets and bundle validation work. The initial scaffold does not promise a signed installer.

## Security and limitations
- Do not use this prototype for irreplaceable data.
- Plain-text note-body editing is present, but not yet validated end-to-end on Windows; no BlockNote-rich-text UI, encryption key handling, sync or backup UI is in place.
- Only the single default `personal` workspace is exposed.
- Deleting a page moves it and descendants to trash; restore UI is future work.
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
