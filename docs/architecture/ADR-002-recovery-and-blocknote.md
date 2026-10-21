# ADR-002: Versioned backup packages, transactional restore and explicit BlockNote migration

Date: 19 October 2026. Status: implemented in alpha 0.0.2; see the verification record for executed checks.

## Boundaries

Keep Tauri 2 / React / TypeScript / SQLite / Yjs. Notes remain independent of the future Files database and blob store. No server, account, network provider or AI service is introduced. The canonical Notion plan's future server is Windows 11 Pro; old Linux references are historical and do not impose a deployment requirement on this increment.

## Backup contract

An existing user-selected directory receives a controlled `Project-NOU-backups` child. Resolve paths canonically and reject app-data ancestry, unavailable destinations and a redirected child. Never fall back to another location when a drive is unavailable. Protection is labelled local/unknown or external/remote **user-declared**, never inferred from letters or folder names.

Each unique `backup-<time>-<uuid>` folder contains `notes.sqlite3` and a version-1 `manifest.json`. SQLite VACUUM INTO captures a consistent snapshot, including committed WAL content. Flush the data file, validate SQLite integrity and the supported full schema against shipped migrations, check foreign keys/Personal workspace, compute SHA-256 and length, then write/flush the manifest last. Reopen and verify the package. A partial write has no valid manifest and cannot become a successful version. No existing package is overwritten. Manifest hashes detect damage, not malicious replacement of both data and manifest; only restore trusted provenance.

Scope is explicitly `notes-database-only`: page metadata, Trash, tags, Yjs state, location catalogue and derived search. Media blocks are disabled. There are no attachment bytes to promise in this alpha. BitLocker/encrypted destination management remains external; the app never claims encryption or remote-upload verification.

Retention is opt-in per exact preview. Keep at least three verified versions and all versions younger than seven days. Reverify inventory and requested survivors before deletion. Reject altered inventory or extra files; remove only two known files and the now-empty package directory. Never recursively delete a selected directory. Rollback, schema migration and editor migration packages are outside the retention root and stay until a separately designed cleanup feature exists.

## Restore and WAL

Prepare: verify selected package, copy to a uniquely named local staging package with create-new semantics, flush, recheck checksum/schema. Return a short-lived in-process token and review metadata. Do not change active notes during preview.

Confirm: require the token and exact RESTORE text. Hold the shared database mutex, invalidate the editor epoch, block writes, create/verify a rollback package, write/flush an intent record, then use SQLite's Backup API into the existing connection in one transaction. Never rename/copy an open database or discard WAL/SHM. Refuse busy/locked results rather than retry indefinitely. Verify integrity and write a separate durable completion marker. Upgrade schema-v1 restores to v2, preserving their content. Reload all UI state after returning to Notes.

All note saves carry the load epoch. Old queued saves fail after restore, and all ordinary metadata writes check the interrupted-restore barrier. A profile-level fs2 lock prevents a second current NOU process. The UI blocks navigation while unsaved, pauses editing during conversion, and guards normal window close.

Crash recovery: SQLite's transaction leaves the old or completed new state. An intent without completion/review is surfaced on startup, and edits remain blocked. The user can inspect notes, restore the preserved rollback through the same flow, or explicitly keep the current verified database. No automatic choice is made. Physical power loss and unreliable storage controllers remain separate hardware tests.

If corruption prevents opening the application, the cold-recovery helper previews then requires explicit confirmation to rename the **entire** closed profile to a unique sibling directory. Main database, WAL, SHM, rollback and settings stay together. It holds a process lock, never deletes files, and creates no replacement until NOU is reopened. Restore into the new profile from a separately verified package.

## Document migration

Schema 002 adds `note_formats(page_id, format, legacy_text, migrated_at)`. Before applying it, preserve a verified schema-v1 database package. Missing format rows mean legacy `Y.Text('body')`; old updates/snapshots remain intact. Alpha 0.0.1 refuses schema 2 instead of silently editing rich notes.

New pages initialize their rich fragment, format marker and first Yjs update inside the page-creation transaction. They open directly in BlockNote; no conversion prompt is needed for content that did not exist before.

Conversion is explicit per note. Clone the existing Y.Doc, convert literal lines to paragraphs with BlockNote's supported Yjs utilities, write them once to `nou-blocks-v1`, and retain `body`. Preserve exact original text separately, including CRLF/trailing newlines. Rich paragraphs normalize line endings but the original remains exact and viewable. Never interpret legacy Markdown/HTML or replace an already populated rich fragment.

Create a pre-conversion database recovery package. In one SQLite transaction compare the expected update sequence and legacy format, append the complete Yjs state, insert the format marker/original text, update FTS and page revision. Reopen using the persisted format. A failed/stale/repeated migration cannot erase the original or append duplicate blocks. Existing rich notes rehydrate from Yjs updates, not JSON reconversion; CRDT history survives.

Persist rich edits as serialized complete-state Yjs updates; derive FTS from nested blocks/table cells. Failed writes stop the queue, expose copyable text and Yjs state, and permit an explicit complete-state retry. Multi-device migration conflicts, update compaction and permanent per-note rich-to-text downgrade are future work.

## References

- [SQLite backup API](https://www.sqlite.org/backup.html)
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)
- [BlockNote Yjs utilities](https://www.blocknotejs.org/docs/reference/editor/yjs-utilities)
- [BlockNote collaboration](https://www.blocknotejs.org/docs/features/collaboration)
