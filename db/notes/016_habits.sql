BEGIN IMMEDIATE;
-- Habits and timetable check-ins. A habit is something to do (Exercise, Anki, Reading...). The log has at most one entry per habit per day: done, skipped, or no answer
-- (a check-in pop-up that was not answered within 2 hours). A day with no entry is simply empty, and an entry can be changed or removed by hand. A check-in ties a habit to
-- a timetable block (a weekday, a start and end half-hour slot, and week A or B), so a pop-up appears when that block starts. A habit is archived, never deleted, so its
-- history stays; the pop-up history keeps no link to the check-in, so it survives that check-in being removed.
CREATE TABLE habits (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL COLLATE NOCASE CHECK(length(trim(name)) BETWEEN 1 AND 60),
 days INTEGER NOT NULL DEFAULT 127 CHECK(days BETWEEN 1 AND 127),
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 archived_at TEXT
);
CREATE UNIQUE INDEX habits_name_live ON habits(name) WHERE archived_at IS NULL;
CREATE TABLE habit_log (
 day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state IN ('done','skipped','no_answer')),
 answered_at TEXT,
 source TEXT NOT NULL CHECK(source IN ('popup','manual','import','timeout')),
 PRIMARY KEY(day, habit_id)
) WITHOUT ROWID;
CREATE INDEX habit_log_habit ON habit_log(habit_id, day);
CREATE TABLE checkins (
 id TEXT PRIMARY KEY,
 habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 start_slot INTEGER NOT NULL CHECK(start_slot BETWEEN 0 AND 47),
 end_slot INTEGER NOT NULL CHECK(end_slot BETWEEN 1 AND 48),
 variant TEXT NOT NULL CHECK(variant IN ('A','B')),
 CHECK(end_slot > start_slot),
 UNIQUE(habit_id, weekday, start_slot, end_slot, variant)
);
CREATE TABLE checkin_events (
 checkin_id TEXT NOT NULL,
 day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE RESTRICT,
 block TEXT NOT NULL CHECK(length(block) <= 200),
 start_slot INTEGER NOT NULL CHECK(start_slot BETWEEN 0 AND 47),
 end_slot INTEGER NOT NULL CHECK(end_slot BETWEEN 1 AND 48),
 shown_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('shown','answered','expired','lapsed')),
 PRIMARY KEY(checkin_id, day)
) WITHOUT ROWID;
INSERT INTO schema_migrations(version) VALUES(16);
COMMIT;
