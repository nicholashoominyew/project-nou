# Verification record — 19 October 2026

## Established baseline

The user confirmed that alpha 0.0.1 installed/launched and passed persistence after restart, search, Trash and restored-text checks. The canonical plan links its successful Windows run [39256621454](https://github.com/nicholashoominyew/project-nou/actions/runs/39256621454). These baseline observations do not automatically verify the new increment.

## Executed locally on Windows for 0.0.2

- Rust native tests: 16 passed, covering WAL-consistent complete restore, reopen and rollback, corruption/truncation/foreign-schema/sidecar rejection, unavailable destination, retention floors and changed-survivor rejection, transactional migration/CAS, new-page rich-state initialization, old standalone snapshot import, stale-editor barriers, interrupted journal and abrupt child-process exits before/during/after SQLite copying. The ignored crash worker is executed by its parent test, not skipped coverage.
- Python: all 16 existing SQLite schema/search/snapshot/Trash tests passed.
- Vitest/jsdom: 11 passed, covering explicit legacy migration preserving exact originals, Unicode/blank lines/literal markup, repeated-conversion refusal, mounted BlockNote rich-content save/reopen (headings/bold/nested lists/checklists/table cells), plain-text indexing, sequential save/failure/retry behavior, restore confirmation, cancellation and failed verification.
- PowerShell cold recovery: preview leaves data unchanged; active lock is refused; entire disposable profile preserves main DB, WAL and SHM bytes.
- TypeScript typecheck and Vite production build passed. Vite reports a non-failing large-editor-chunk warning.
- Unsigned NSIS 0.0.2 packaging completed locally; this is a build result, not an installation/GUI acceptance result.
- npm dependency audit reported zero advisories after updating the test runner and adding the required Yjs adapters. This is a point-in-time advisory result, not a security certification.

The initial test attempts exposed sandbox temporary-folder access failures and a SQLite backup wrapper argument assertion. Tests were rerun outside that sandbox restriction after correcting the code; only completed reruns count above. A headless editor test was corrected to mount the actual editor before checking its Yjs binding.

## Not yet verified by those automated checks

New installer installation/upgrade and interactive WebView2 acceptance on the user's live profile; physical USB removal/reconnection and separate-device recovery; actual cloud upload/version history; physical power loss, controller durability and disk-full fault injection; broad Windows versions and accessibility/IME/drag-drop behavior. No live user notes were opened, migrated, restored or deleted during this development run.

## Remaining product work

Scheduled/weekly backups and catch-up, server sync/relocation, Files and attachments, encrypted backup/key management, signed releases, CRDT compaction, multi-device migration coordination, full Notion import, integrations and production hardening remain outstanding. Independence is always unverified by NOU; users must verify their actual storage arrangement.

Use the current commit's GitHub Actions result and artifacts as CI evidence. Merely committing the workflow does not constitute a passing run.
