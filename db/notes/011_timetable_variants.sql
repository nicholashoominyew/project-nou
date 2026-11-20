BEGIN IMMEDIATE;
-- Life Timetable v2: alternating weeks. Every slot now belongs to variant 'A' or 'B'. Existing slots are copied into both, so neither loses edits.
CREATE TABLE timetable_slots_v2 (
 variant TEXT NOT NULL CHECK(variant IN ('A','B')),
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 slot_index INTEGER NOT NULL CHECK(slot_index BETWEEN 0 AND 47),
 activity_id TEXT NOT NULL REFERENCES timetable_activities(id) ON DELETE RESTRICT,
 PRIMARY KEY(variant,weekday,slot_index,activity_id)
) WITHOUT ROWID;
INSERT INTO timetable_slots_v2(variant,weekday,slot_index,activity_id) SELECT 'A',weekday,slot_index,activity_id FROM timetable_slots;
INSERT INTO timetable_slots_v2(variant,weekday,slot_index,activity_id) SELECT 'B',weekday,slot_index,activity_id FROM timetable_slots;
DROP TABLE timetable_slots;
ALTER TABLE timetable_slots_v2 RENAME TO timetable_slots;
CREATE INDEX timetable_slots_activity ON timetable_slots(activity_id);
-- Small persisted settings for the timetable. 'swap_ab' = '1' flips which variant counts as the current week (ISO week odd = A by default).
CREATE TABLE timetable_settings (
 key TEXT PRIMARY KEY CHECK(key IN ('swap_ab')),
 value TEXT NOT NULL CHECK(value IN ('0','1'))
);
INSERT INTO schema_migrations(version) VALUES(11);
COMMIT;
