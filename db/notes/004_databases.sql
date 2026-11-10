BEGIN IMMEDIATE;
-- A database is an ordinary page that also has a row here. Its rows are ordinary pages (child pages)
-- listed in db_rows, so each row keeps a full rich-text body, search, trash and backups.
CREATE TABLE databases (
 page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE
);
CREATE TABLE db_properties (
 id TEXT PRIMARY KEY,
 database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 type TEXT NOT NULL CHECK(type IN ('text','number','select','multi_select','status','date','checkbox','url','relation')),
 position INTEGER NOT NULL,
 config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config)),
 deleted_at TEXT
);
CREATE INDEX db_properties_database ON db_properties(database_id,position);
CREATE TABLE db_options (
 id TEXT PRIMARY KEY,
 property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 color TEXT NOT NULL DEFAULT 'gray' CHECK(length(color) BETWEEN 1 AND 20),
 position INTEGER NOT NULL
);
CREATE INDEX db_options_property ON db_options(property_id,position);
CREATE TABLE db_rows (
 page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE
);
CREATE INDEX db_rows_database ON db_rows(database_id);
-- One JSON-encoded value per row and property (text, number, bool, date string, option id or option-id list).
CREATE TABLE db_values (
 row_id TEXT NOT NULL REFERENCES db_rows(page_id) ON DELETE CASCADE,
 property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
 value TEXT NOT NULL CHECK(json_valid(value)),
 PRIMARY KEY(row_id,property_id)
);
-- Relations are stored relationally (not as JSON) so references stay checkable. Used from phase 2.
CREATE TABLE db_relations (
 property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
 from_row TEXT NOT NULL REFERENCES db_rows(page_id) ON DELETE CASCADE,
 to_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 PRIMARY KEY(property_id,from_row,to_page)
);
CREATE INDEX db_relations_target ON db_relations(to_page);
-- Saved views of one database (table, board, list, gallery, calendar, timeline). config holds the view's settings
-- (e.g. which property groups a board or places items on a calendar).
CREATE TABLE db_views (
 id TEXT PRIMARY KEY,
 database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 type TEXT NOT NULL CHECK(type IN ('table','board','list','gallery','calendar','timeline')),
 position INTEGER NOT NULL,
 config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config)),
 deleted_at TEXT
);
CREATE INDEX db_views_database ON db_views(database_id,position);
INSERT INTO schema_migrations(version) VALUES(4);
COMMIT;
