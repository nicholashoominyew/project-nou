BEGIN IMMEDIATE;
-- Life Timetable: the weekly routine. Activities are named things (with a category); a slot is one half hour of one weekday and may hold several
-- activities at once (for example 06:00-06:30 holds Shower + Breakfast, Exercise and Japanese Study). Times are device-local wall-clock times.
CREATE TABLE timetable_activities (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 category TEXT NOT NULL CHECK(category IN ('Work','Rest','Leisure','Travel','Chores','Training','Health')),
 colour TEXT CHECK(colour IS NULL OR (length(colour)=7 AND colour GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]')),
 remind INTEGER NOT NULL DEFAULT 1 CHECK(remind IN (0,1)),
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX timetable_activity_name_unique ON timetable_activities(name COLLATE NOCASE);
CREATE TABLE timetable_slots (
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 slot_index INTEGER NOT NULL CHECK(slot_index BETWEEN 0 AND 47),
 activity_id TEXT NOT NULL REFERENCES timetable_activities(id) ON DELETE RESTRICT,
 PRIMARY KEY(weekday,slot_index,activity_id)
) WITHOUT ROWID;
CREATE INDEX timetable_slots_activity ON timetable_slots(activity_id);

-- System pages: built-in pages that always exist. The row is looked up by its key, never by title or position.
ALTER TABLE pages ADD COLUMN system_key TEXT CHECK(system_key IS NULL OR system_key IN ('life_timetable'));
CREATE UNIQUE INDEX pages_system_key_unique ON pages(system_key) WHERE system_key IS NOT NULL;
-- Backstop for the Rust commands: even a direct write cannot delete, rename, trash, re-parent or re-key a system page.
CREATE TRIGGER pages_system_no_delete BEFORE DELETE ON pages WHEN OLD.system_key IS NOT NULL
BEGIN SELECT RAISE(ABORT,'This is a built-in page and cannot be deleted'); END;
CREATE TRIGGER pages_system_locked BEFORE UPDATE OF title,parent_id,deleted_at,system_key,workspace_id ON pages WHEN OLD.system_key IS NOT NULL
BEGIN SELECT RAISE(ABORT,'This is a built-in page and cannot be renamed, moved or trashed'); END;
INSERT INTO schema_migrations(version) VALUES(10);
COMMIT;
