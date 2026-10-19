# Windows development guide

## Status
Early Phase 0/Phase 1 prototype. GUI supports page hierarchy, rename, manual up/down ordering and trash. **Rich-text document editing is not implemented yet.** Test before storing important notes.

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
- No note-body editor, encryption key handling, sync or backup UI is in place.
- Only the single default `personal` workspace is exposed.
- Deleting a page moves it and descendants to trash; restore UI is future work.
- Hierarchy cycle prevention for arbitrary reparenting will be implemented before adding drag-and-drop.
- Network/server connectivity is **not required**.

## Data backup
While app is CLOSED, back up its complete per-user application data directory using a verified copy. Do not assume copying an open WAL-mode SQLite database is a consistent backup. The application backup workflow will be implemented separately using SQLite's online backup API.
