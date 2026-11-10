# Custom home page — widget shell (branch `feature/home-page`)

Roadmap: Phase 2b (`ROADMAP-PROPOSAL-2026-11-11.md`, draft). Stacked on `feature/phase-1b`. Nothing here is merged.

## Built
- **Home screen** replaces the old empty state. It shows when no page is open: sidebar *Home* row, the *Workspace* breadcrumb link, or closing the last tab.
- **Widget shell.** A widget is `{ id, title, hint?, render(ctx) }` in `HOME_WIDGETS` (`apps/desktop/src/Home.tsx`). `ctx` gives a widget only the page list, an `open(id)` callback, a tag-search callback and a `disabled` flag; widgets never reach into the app directly. Later features (quick-capture inbox, approval gateway, bot queue, resurfacing, linked checklist items) plug in by adding an entry.
- **First widgets:** *Recently edited* (`list_recent_pages`, newest first, excludes Trash and hidden database rows), *Favorites*, *Tags* (click a tag to open Quick find on `#tag`).
- **Customize:** move widgets up/down, hide, and show again. Widgets added by a later version appear automatically at the end; unknown or duplicate stored ids are ignored (`homeLayout.ts`).
- Quick find can now be opened pre-filled.

## Decisions
- The layout is a **local UI preference** in `localStorage` (`nou-home-layout`), like theme and tabs. It is not in the notes database, so it is not part of backups; losing it only resets the arrangement.
- A one-column ordered list of cards in an auto-fit grid, not free-form drag-and-drop. This answers the Notion row's open question ("how widgets are added/arranged") for now; free-form placement can replace it without changing the widget contract.
- No schema change.

## Verified (run this session)
TypeScript clean; 117 Vitest tests (layout model, widgets, customize/persistence, plug-in registry, app wiring); 45 Rust library tests including `recent_pages`. Not run in a real WebView2 window (Smart App Control blocks the unsigned dev binary here).

## Not built
Quick-capture inbox, approval, bot queue, resurfacing and linked checklist widgets (they need their own features); free-form drag layout; per-widget settings; multiple home pages.
