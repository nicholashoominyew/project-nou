# File tracker

A **Files** screen in the sidebar (under Graph) listing every file stored with your notes.

## What it shows
- Name, type, size, and the pages that use each file (click a page to open it).
- A total at the top: how many files, how much space, and how many are **not used by any page** (and how much space they take).
- A file used only by pages in the trash is shown as "Only on N pages in the trash", not as unused, because restoring the page brings it back into use.
- Search by file name or page name, filter by type (images, PDFs, other), "Unused only", and sort by newest, name or size.
- **Save a copy** writes any file out to a place you choose.

## What it does not do
It only reads. It cannot delete, rename or change a stored file. That is deliberate: files live in their own database (`files.sqlite3`) and are part of backups, so removing them needs its own careful design (confirm what is deleted, keep a recoverable copy, make sure no backup or restore path depends on it). Until then, "unused" is information, not an action.

## How it works
- `list_files` (`file_tracker.rs`) reads `file_blobs` from the files database (name, type, size, newest first, at most 5,000) and `note_files` from the Notes database, which records which page holds which file. It never writes.
- `fileList.ts` holds the sizes, filtering, sorting and totals; `FileTracker.tsx` is the screen.
- The file names are drawn as plain text.

## Verified
- Rust: 3 tests (newest first with sizes and pages sorted by title; unused vs trash-only; read-only and empty store).
- Vitest: 11 tests for the helpers and the screen (list, unused flag, trash-only wording, opening a page, busy lock, filters and empty result, Save a copy and cancel and failure, empty and error states, hostile names) and the sidebar wiring.
- Not verified: the screen in the real window with real files, and Save a copy through the real dialog.

## Not built
Deleting unused files, a preview or thumbnail, the date a file was added (the files database does not record one), and listing files that are in a backup but not in the live store.
