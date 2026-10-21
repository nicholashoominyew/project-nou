BEGIN IMMEDIATE;
-- Absence of a row means the original Y.Text('body') model. Never delete legacy updates.
CREATE TABLE note_formats (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK(format = 'blocknote-v1'),
  legacy_text TEXT NOT NULL,
  migrated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO schema_migrations(version) VALUES (2);
COMMIT;
