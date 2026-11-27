BEGIN IMMEDIATE;
-- Life Timetable in 10-minute steps. A slot was half an hour (48 a day); it is now ten minutes (144 a day), so every old slot becomes three and nothing moves.
-- SQLite cannot change a CHECK constraint, so the three tables that count slots are rebuilt. Nothing references them.
CREATE TABLE timetable_slots_v3 (
 variant TEXT NOT NULL CHECK(variant IN ('A','B')),
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 slot_index INTEGER NOT NULL CHECK(slot_index BETWEEN 0 AND 143),
 activity_id TEXT NOT NULL REFERENCES timetable_activities(id) ON DELETE RESTRICT,
 PRIMARY KEY(variant,weekday,slot_index,activity_id)
) WITHOUT ROWID;
INSERT INTO timetable_slots_v3(variant,weekday,slot_index,activity_id)
 SELECT s.variant,s.weekday,s.slot_index*3+k.n,s.activity_id FROM timetable_slots s JOIN (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2) k;
DROP TABLE timetable_slots;
ALTER TABLE timetable_slots_v3 RENAME TO timetable_slots;
CREATE INDEX timetable_slots_activity ON timetable_slots(activity_id);

CREATE TABLE checkins_v2 (
 id TEXT PRIMARY KEY,
 habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 start_slot INTEGER NOT NULL CHECK(start_slot BETWEEN 0 AND 143),
 end_slot INTEGER NOT NULL CHECK(end_slot BETWEEN 1 AND 144),
 variant TEXT NOT NULL CHECK(variant IN ('A','B')),
 CHECK(end_slot > start_slot),
 UNIQUE(habit_id, weekday, start_slot, end_slot, variant)
);
INSERT INTO checkins_v2(id,habit_id,weekday,start_slot,end_slot,variant) SELECT id,habit_id,weekday,start_slot*3,end_slot*3,variant FROM checkins;
DROP TABLE checkins;
ALTER TABLE checkins_v2 RENAME TO checkins;

CREATE TABLE checkin_events_v2 (
 checkin_id TEXT NOT NULL,
 day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE RESTRICT,
 block TEXT NOT NULL CHECK(length(block) <= 200),
 start_slot INTEGER NOT NULL CHECK(start_slot BETWEEN 0 AND 143),
 end_slot INTEGER NOT NULL CHECK(end_slot BETWEEN 1 AND 144),
 shown_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('shown','answered','expired','lapsed')),
 PRIMARY KEY(checkin_id, day)
) WITHOUT ROWID;
INSERT INTO checkin_events_v2(checkin_id,day,habit_id,block,start_slot,end_slot,shown_at,expires_at,state)
 SELECT checkin_id,day,habit_id,block,start_slot*3,end_slot*3,shown_at,expires_at,state FROM checkin_events;
DROP TABLE checkin_events;
ALTER TABLE checkin_events_v2 RENAME TO checkin_events;
INSERT INTO schema_migrations(version) VALUES(20);
COMMIT;
