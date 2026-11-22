# Installing and updating on more than one computer

The code lives in the GitHub repo `nicholashoominyew/project-nou`. The installed app is built from it. **Your notes are not in the repo and not in the installer**: each computer keeps its own notes in `%APPDATA%\app.projectnou.desktop`.

## First install on a computer

You need Git, Node 22 (or newer), Rust (stable, with the MSVC build tools) and the WebView2 runtime that Windows already has.

```bash
git clone https://github.com/nicholashoominyew/project-nou.git
cd project-nou
git switch <the branch with the newest work>
npm ci
npm run package:windows
```

The installer appears in `apps/desktop/src-tauri/target/release/bundle/nsis/`. Run it. It installs per user and does not touch your notes. (`package:windows` also regenerates the icons from `assets/nou-icon.svg`; that is expected.)

Or download the installer from the repo's **Releases** page, if one was published there, and run it.

## Updating

On the computer that has the new code:

```bash
git pull
npm ci
npm run package:windows
```

Run the new installer over the old install. Your notes stay where they are.

## Before updating: the database moves forward only

Newer versions upgrade the notes database when the app starts (schema 12 today). An older build cannot open a database that a newer one has upgraded. The app keeps a rollback snapshot in `schema-rollback` next to your notes before each upgrade, but the simple rule is: **update every computer to the same newest version, and make a backup first** (Settings, then Backups & restore).

## Moving notes between computers

Git does not carry notes. To bring pages from one computer to another, make a backup on the first (Settings, then Backups & restore) and restore it on the second, or copy the backup folder across. Restoring replaces that computer's notes, so do it on a computer you have not used yet, or after a backup there too.

## Only one copy at a time

The app locks its data folder. Close the installed app before running a development build (`npm run tauri dev`) on the same computer, and the other way round.

## Not set up

There is no automatic in-app updater (that would need a signing key and a new dependency). The installer is unsigned unless you use `tools/Build-SignedRelease.ps1` with a certificate, so Windows may show a SmartScreen warning the first time.
