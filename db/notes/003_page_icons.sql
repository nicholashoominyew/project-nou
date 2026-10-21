BEGIN IMMEDIATE;
ALTER TABLE pages ADD COLUMN icon TEXT NOT NULL DEFAULT 'document' CHECK(length(icon) BETWEEN 1 AND 40);
CREATE TABLE note_files (
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL CHECK(length(file_id)=64),
 PRIMARY KEY(page_id,file_id)
);
INSERT INTO schema_migrations(version) VALUES(3);
COMMIT;
