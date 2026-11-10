# Phase 1b — finishing the offline MVP (branch `feature/phase-1b`)

Proposed in `ROADMAP-PROPOSAL-2026-11-11.md` (draft, not yet in the Notion plan). This branch is stacked on `feature/databases`, which contains `fix/editor-undo-alignment-shortcuts` and the 0.0.4 branch. Nothing here is merged.

## Built
- **Clickable breadcrumb.** `Workspace / Parent / Child`: every ancestor opens that page; "Workspace" returns to the empty screen. Cycle-safe. (Pending Features: "title bar … click and navigate".)
- **Focus mode.** `Ctrl+Shift+F` or the toolbar *Focus* button hides the sidebar, top bar, toolbar and save line and centres the page. `Esc` leaves it (unless a menu is open and handles Esc itself); an always-visible *Exit focus mode* button is the fallback.
- **Backlinks.** Schema **v5** (`db/notes/005_page_links.sql`, table `page_links`). Page-link blocks (`/page` and `@`) in a note are indexed by `set_page_links` after every successful save and when a note is opened; `list_backlinks` feeds a *Linked from* panel under the note. The index is derived data and is not part of the atomic note save, so a failure there cannot affect saving.
- **Tags.** Commands `set_page_tags`, `get_page_tags`, `list_tags`, `find_pages_by_tag` over the existing `tags` / `page_tags` tables (no schema change). Chips under the title (Enter or comma adds, × removes, suggestions from existing tags). Quick find: type `#name` to list pages whose tag starts with `name`. Tags are workspace-wide, case-insensitive, up to 20 per page and 40 characters.

## Verified (run this session on the development PC)
TypeScript clean; 104 Vitest tests; 44 Rust library tests (`cargo test --locked --lib`, including the v1→v5 upgrade, backlink and tag rules); 11 `tests/native-core` tests; 16 Python SQL tests. **Not** run: anything in a real WebView2 window (Smart App Control blocks the unsigned dev binary on this machine), and the Windows desktop CI workflow for this branch.

## Limitations
- The link index fills when a note is **opened or saved**; notes you never open after this change have no outgoing links indexed, so they will not yet appear in other pages' *Linked from*.
- Backlinks come from page-link blocks only (not from relations, bookmarks or typed titles). Links from database rows and from trashed pages are not listed.
- Tags are not included in the JSON recovery export/import (they are in complete backups, which copy the whole database).
- The NoteEditor-to-`set_page_links` call has no dedicated component test; the Rust rules and the panel are tested separately.
- A note's tags are shown but not editable while a save or restore is pending.

## Upgrade note
Schema 5 is another one-way step like v3 and v4: builds without migration 005 refuse a v5 profile. A `schema-rollback` snapshot is taken before the upgrade. Rehearse on a copy before opening a real profile.
