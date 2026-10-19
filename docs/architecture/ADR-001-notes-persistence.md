# ADR-001: Local-first Notes persistence and page ordering

**Status:** Proposed implementation baseline (Phase 0). **Date:** 2026-10-19.

## Decision
Use a dedicated SQLite Notes database (independent of the future Files database). In Phase 1, use it on Windows within the Tauri desktop application, with Yjs binary updates for document bodies. Do not require a server or internet connection for create/edit/search.

## Page hierarchy and order
- A page has a stable opaque ID, workspace, optional parent and a lexicographically ordered `sort_key`.
- Sibling sorting is deterministic: `ORDER BY sort_key COLLATE BINARY, id`. This preserves manual order across restarts.
- Generate keys between adjacent neighbors using a tested fractional-indexing library; rebalance sibling keys in a **single transaction** when keyspace is exhausted or collisions occur. Never assume floating-point indices are stable.
- Moves validate same-workspace parent, no self-parenting and no ancestor cycles, in the same transaction as key change. Apply optimistic revision checks to avoid silent lost updates.
- Soft delete uses `deleted_at`; restoring a page must resolve occupied sibling sort keys before clearing deleted_at. Trash purge is explicit.
- Parent-child cross-workspace and ancestry rules require transactional application validation in v1; add triggers if external writers ever gain direct access.

## Rich-text durability
- A Yjs document's binary updates are opaque stored blobs. Increment the per-page `seq` in a SQLite write transaction, not in process memory alone.
- Store periodic Yjs snapshots and compact historical updates **only after** a durable snapshot is validated. Never delete updates that a snapshot does not cover.
- UI text search indexes derived plain text into SQLite FTS5. Update the index transactionally after a successful document save or schedule re-indexing with crash-safe replay.
- Use WAL journal mode and foreign key enforcement **per connection**; on Windows, set a busy timeout and test multiple application windows. Use SQLite online backup API or equivalent consistent snapshot for backups.

## Isolation and migration
- Knowledge DB and Files DB are never attached in a single write transaction. Cross-system references use a stable Files API identifier.
- Numbered SQL migrations run once, inside transactions, with schema version checks and tested rollback/restore procedures.
- Data directories belong to Windows user profile for desktop MVP; later server storage uses service-owned paths with ACLs.

## Note location and backup
- `LOCAL` is an intentional MVP state, not a synonym for `DESKTOP` in the eventual multi-device model.
- Future location switch is journalled COPY -> VERIFY -> COMMIT -> RETIRE, with failure keeping old authoritative content. Require content hashes, version checks and an independent backup.
- Weekly desktop notes snapshots are duplicated backups; **never** delete server source as an effect of backup. Offline desktop misses weekly jobs and catches up when reachable.
- Location state only tracks the primary owner, not backup inventory. Define backup catalogue separately before enabling relocation.

## Verification tests
1. Insert two sibling pages, query deterministic manual sort across restart.
2. Move a page and reject cycles and cross-workspace ancestry.
3. Two competing moves: revision mismatch must fail.
4. Concurrent Yjs update append gets distinct ordered sequence.
5. Corrupted snapshot cannot trigger update deletion.
6. Trash restore with occupied sort key gets a new stable key.
7. FTS reindex after simulated crash reproduces expected search results.
8. Copy an active Notes database using SQLite online backup and restore without corruption.

## Known limitations and follow-up
- SQL alone cannot prevent all tree cycles or enforce cross-workspace tag assignment; application validation is mandatory.
- Search content must be derived from the editor's document model; FTS cannot read Yjs bytes directly.
- Define note primary transfer journal, cryptographic integrity, snapshot catalogue and backup retention in the next ADR.
