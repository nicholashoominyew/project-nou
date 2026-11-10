BEGIN IMMEDIATE;
-- Index of which pages link to which (page-link blocks in note bodies). It is derived data: the note bodies stay the
-- source of truth, so the index can always be rebuilt by re-saving a note. Powers "Linked from" (backlinks).
CREATE TABLE page_links (
 source_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 PRIMARY KEY(source_id,target_id),
 CHECK(source_id <> target_id)
);
CREATE INDEX page_links_target ON page_links(target_id);
INSERT INTO schema_migrations(version) VALUES(5);
COMMIT;
