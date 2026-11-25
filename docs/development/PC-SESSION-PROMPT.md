# Prompt for a Claude Code session on the Windows PC

Paste everything below the line into a Claude Code session started in the root of the NOU repo on Nick's Windows PC (Nicks_Rig).

---

You are continuing work on NOU (脳), Nick's Windows notes app, in the repo you are standing in (nicholashoominyew/project-nou). Work on the branch feature/bots-hub-redesign-nz0myh and push only to that branch. A previous Claude session ran in a Linux cloud container, so it could build and unit-test everything but could never run the app on Windows. You are on the real PC. Your main job is to run the app, check the things below with your own eyes, and fix what is wrong.

## The app in one paragraph
Tauri 2 + React + TypeScript + BlockNote + Yjs, with embedded SQLite (rusqlite). Windows-first, local-first, no server yet. Database schema is at version 17 (migrations in db/notes/, wired through apps/desktop/src-tauri/src/editor.rs, lib.rs, backup.rs, recovery.rs). Frontend is in apps/desktop/src, Rust in apps/desktop/src-tauri/src. Read docs/development/HABITS.md, EMBEDS.md, BOTS-HUB.md, LIFE-TIMETABLE.md, BACKUP-RESTORE.md and WINDOWS.md first. Notion plan page: "Project NOU (脳) — Architecture & Build Plan" (Latest update, 25 November 2026).

## What was built recently (all untested on Windows by anyone)
- Habits are Life Timetable activities (type and colour). A habit's place on the timetable grid sets its check-in. A pop-up (one "Yes, started" button, an X to hide, no Skip) should show for the whole block while it is running, unless the habit is already ticked, plus a Windows notification once. Unanswered becomes No answer after 2 hours or at block end. Files: apps/desktop/src/checkins.tsx, habitsLogic.ts, habits.rs (derived check-ins, sync_checkins).
- Habits page redesigned to an Elementel reference (Today ring, Streaks with heatmaps, collapsed History and Your habits): Habits.tsx, habitsPage.css. "Test pop-up" button per habit under Your habits shows a pop-up and notification immediately.
- Drag reordering with the six-dot grip now follows the pointer itself (apps/desktop/src/Reorder.tsx), used for Today's tasks on Home and for habits.
- Shared Ctrl+Z / Ctrl+Y (apps/desktop/src/undo.tsx) for the timetable, Habits and Today's tasks.
- Backup and sync through a OneDrive folder, encrypted, by taking turns (sync.rs, OneDriveSync.tsx), now also carrying window preferences (syncSettings.ts, appsettings.rs).
- Embed block (EmbedView.tsx, embed.ts, embeds.rs). Known and tested: claude.ai artifact pages send frame-ancestors 'self', so they cannot be framed in NOU and show as a card; srcdoc snapshots inherit NOU's script-src 'self' so scripts in them are blocked.
- Bots Hub (rooms, approvals, queue), assistants propose changes that Nick approves. The in-house bot (Kura) was removed on 25 Nov 2026.

## Check these on this PC, in this order
1. Pop-up and notification. Open Habits, Your habits, press "Test pop-up". Does the in-app card appear? Does a Windows notification appear? Does the notification have a "Checked in" button (plugin-notification actions on Windows are unverified)? Then put a habit on a Life Timetable block that is running right now and check the pop-up appears within about 5 seconds, stays until ticked, hides with the X, and disappears when the block ends. Check the "Not on the timetable yet" hint and "Use an existing activity" (for example the shipped "JP Anki") work. Check Tauri notification permission and capability files if nothing shows (apps/desktop/src-tauri/capabilities). Fix what you find.
2. Dragging. On Home, drag a task in Today's tasks by its six dots with the real mouse. Does the row move and does the order survive a restart? Same for habits under Your habits. If it fails, find out why in the real window (dev tools: right-click, Inspect, or the Tauri devtools) and fix Reorder.tsx.
3. OneDrive sync. Nick has not tested it yet. With a throwaway folder, use Backups and restore, Backup and sync: password of 12+ characters, Sync now, then simulate a second device by using a second data directory if you can (see docs/development/WINDOWS.md for the profile folder). He earlier said it "seemed not to be working": find out what he would have seen.
4. Ctrl+Z and Ctrl+Y on the timetable, Habits and Today's tasks. Typing boxes must keep their own undo.
5. Embed: paste a https://claude.ai/artifact/... address onto an empty line in a note, confirm the card appears, "Try live view anyway" shows the browser's blocked page, and a snapshot of a small HTML file displays. Decide with Nick whether a custom protocol for scripted snapshots is worth building.
6. Home calendar bubbles (accent gradient by habit progress), the Habits page in dark and light, and the top-bar timer ring thickness.

## Rules
- Use a backup or a disposable profile. Do not change or delete Nick's real notes. Before running a dev build against the real data folder, make a verified backup from the app.
- Windows file systems are case-insensitive: never create two files whose names differ only by case (this broke CI once: Embed.tsx vs embed.ts). Windows clocks are coarser than Linux: do not write tests that depend on distinct timestamps.
- Keep the existing design rules: Elementel tokens (see apps/desktop/src/theme.css), one accent-filled button per view, no gradients, no emoji, nothing written to Notion by the app.
- Every AI-requested write in the app needs Nick's explicit approval in the UI. Do not weaken that.
- Do not claim something works unless you saw it work. Say plainly what you could not check.
- Before finishing run: npx tsc --noEmit and npm test (in apps/desktop); cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib; node --test tools/nou-claude/nou-claude.test.mjs tests/mcp/*.mjs; python -m unittest discover -s tests. The Rust test run takes a couple of minutes.
- Commit small, clear commits and push to feature/bots-hub-redesign-nz0myh. To build the installer, run the workflow desktop-checks.yml on that branch (GitHub Actions, workflow_dispatch); the artifact is project-nou-windows-x64-unsigned. Do not open a pull request unless Nick asks.

## When you report back
For each of the six checks: what you did, what you saw (a screenshot description is fine), what you changed (files), and what is still unverified. Then list anything surprising you found that was not on the list.

## Setup if this PC has not run NOU before
Install Node LTS, Rust (MSVC) and the Visual Studio C++ Build Tools (WebView2 is already on Windows 11). Then in the repo root: npm install, and from apps\desktop: npm run tauri dev (the first Rust build takes several minutes).
