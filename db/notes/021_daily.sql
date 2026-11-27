BEGIN IMMEDIATE;
-- The Daily page (docs/development/DAILY.md): one page per date. Sections hold entries; the journal is stored apart from them.
-- `day` is the Europe/London calendar day, "2026-11-27", and the primary key makes it unique. Entries are never overwritten or
-- hard deleted by NOU: a removal sets deleted_at. `daily_summaries` is the small record the calendar reads instead of the pages.
CREATE TABLE daily_days (
 day TEXT PRIMARY KEY CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 notion_page_id TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE daily_entries (
 id TEXT PRIMARY KEY,
 day TEXT NOT NULL REFERENCES daily_days(day) ON DELETE CASCADE,
 section TEXT NOT NULL CHECK(length(section) BETWEEN 1 AND 40),
 position INTEGER NOT NULL,
 time TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT '',
 topic TEXT NOT NULL DEFAULT '',
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
 link TEXT NOT NULL DEFAULT '',
 done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
 hash TEXT NOT NULL CHECK(length(hash)=64),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 deleted_at TEXT
);
CREATE INDEX daily_entries_day ON daily_entries(day,section,position);
CREATE TABLE daily_journals (
 day TEXT PRIMARY KEY REFERENCES daily_days(day) ON DELETE CASCADE,
 body TEXT NOT NULL CHECK(json_valid(body) AND length(body)<=200000),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE daily_summaries (
 day TEXT PRIMARY KEY REFERENCES daily_days(day) ON DELETE CASCADE,
 journal TEXT NOT NULL DEFAULT 'none' CHECK(journal IN ('none','part','full')),
 goals INTEGER NOT NULL DEFAULT 0,
 win INTEGER NOT NULL DEFAULT 0,
 learn INTEGER NOT NULL DEFAULT 0,
 open_todos INTEGER NOT NULL DEFAULT 0,
 sections INTEGER NOT NULL DEFAULT 0
);
INSERT INTO schema_migrations(version) VALUES(21);
COMMIT;
