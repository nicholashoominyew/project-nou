-- Project NOU Notes database; SQLite 3.35+; Notes ONLY (Files has its own store).
-- Apply on a fresh database with PRAGMA foreign_keys=ON.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  parent_id TEXT REFERENCES pages(id) ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  sort_key TEXT NOT NULL COLLATE BINARY,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0,1)),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  CHECK(parent_id IS NULL OR parent_id <> id),
  CHECK(length(sort_key) > 0)
);
CREATE INDEX pages_tree_idx ON pages(workspace_id,parent_id,deleted_at,sort_key,id);
CREATE INDEX pages_updated_idx ON pages(workspace_id,updated_at DESC);
CREATE UNIQUE INDEX pages_sibling_order_unique ON pages(workspace_id,COALESCE(parent_id,''),sort_key)
  WHERE deleted_at IS NULL;
-- Application must enforce parent belongs to same workspace, no cycles and no moves under deleted parents.
-- Reserve empty string as an invalid page ID when using COALESCE sibling uniqueness.

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(name)) > 0),
  UNIQUE(workspace_id,name)
);
CREATE TABLE page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(page_id,tag_id)
);

-- Yjs document is reconstructed from ordered opaque updates. Content stays opaque to SQLite.
CREATE TABLE yjs_updates (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK(seq > 0),
  update_bytes BLOB NOT NULL CHECK(length(update_bytes) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(page_id,seq)
);
CREATE TABLE yjs_snapshots (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  through_seq INTEGER NOT NULL CHECK(through_seq >= 0),
  snapshot_bytes BLOB NOT NULL CHECK(length(snapshot_bytes) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Initial local-first deployment keeps content on this device. Later: SERVER or DESKTOP.
CREATE TABLE note_locations (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  primary_device TEXT NOT NULL DEFAULT 'LOCAL'
    CHECK(primary_device IN ('LOCAL','SERVER','DESKTOP')),
  state TEXT NOT NULL DEFAULT 'READY'
    CHECK(state IN ('READY','COPYING','VERIFYING','COMMITTING','ERROR')),
  destination_device TEXT CHECK(destination_device IN ('SERVER','DESKTOP')),
  content_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  CHECK((state='READY' AND destination_device IS NULL)
    OR (state<>'READY' AND destination_device IS NOT NULL))
);

-- Indexable plain text is a derived cache, never the primary note body.
CREATE VIRTUAL TABLE page_search USING fts5(page_id UNINDEXED, title, body, tokenize='unicode61');
INSERT INTO schema_migrations(version) VALUES (1);
COMMIT;
