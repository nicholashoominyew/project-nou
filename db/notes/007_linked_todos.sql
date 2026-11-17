BEGIN IMMEDIATE;
-- Linked to-dos: one to-do that can sit on several pages and stays in step everywhere. The shared state (text and ticked or not) lives here;
-- a linked-to-do block in a note only stores the id (plus a copy of the text for search). `linked_todo_refs` is derived data, rebuilt
-- whenever a note is saved, like page_links.
CREATE TABLE linked_todos (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 64),
 text TEXT NOT NULL CHECK(length(text) <= 500),
 checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE linked_todo_refs (
 todo_id TEXT NOT NULL REFERENCES linked_todos(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 PRIMARY KEY(todo_id,page_id)
);
CREATE INDEX linked_todo_refs_page ON linked_todo_refs(page_id);
INSERT INTO schema_migrations(version) VALUES(7);
COMMIT;
