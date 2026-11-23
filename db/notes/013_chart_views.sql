BEGIN IMMEDIATE;
-- Chart views for databases. SQLite cannot change a CHECK in place, so the views table is rebuilt with 'chart' allowed. Every existing view keeps its id, name, order and settings.
CREATE TABLE db_views_new (
 id TEXT PRIMARY KEY,
 database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 type TEXT NOT NULL CHECK(type IN ('table','board','list','gallery','calendar','timeline','map','chart')),
 position INTEGER NOT NULL,
 config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config)),
 deleted_at TEXT
);
INSERT INTO db_views_new(id,database_id,name,type,position,config,deleted_at) SELECT id,database_id,name,type,position,config,deleted_at FROM db_views;
DROP TABLE db_views;
ALTER TABLE db_views_new RENAME TO db_views;
CREATE INDEX db_views_database ON db_views(database_id,position);
INSERT INTO schema_migrations(version) VALUES(13);
COMMIT;
