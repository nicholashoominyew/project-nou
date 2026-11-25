BEGIN IMMEDIATE;
-- Habits become part of the Life Timetable. A habit has a type (the same list as the timetable's categories, so its blocks take that colour) and is linked to one timetable
-- activity (timetable_activities.habit_id); putting that activity on the grid is what sets when the check-in pop-up appears. Linked to-dos get an order so Today's tasks can be
-- rearranged by hand. SQLite cannot change a CHECK constraint, so the proposals table is rebuilt with three more things an assistant may ASK for (rename nothing, copy every
-- row unchanged): add a habit, tick a habit for a day, and put Today's tasks in a new order.
ALTER TABLE habits ADD COLUMN category TEXT NOT NULL DEFAULT 'Health';
ALTER TABLE timetable_activities ADD COLUMN habit_id TEXT REFERENCES habits(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX timetable_activity_habit ON timetable_activities(habit_id) WHERE habit_id IS NOT NULL;
-- App preferences kept on this device (Home layout, theme, reminders, places...) are copied here before a sync, so they travel in the same encrypted file as everything else.
CREATE TABLE app_settings (
 key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 5 AND 100 AND key GLOB 'nou-*'),
 value TEXT NOT NULL CHECK(length(value) <= 60000),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE linked_todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE linked_todos SET sort_order=(SELECT COUNT(*) FROM linked_todos o WHERE o.created_at<linked_todos.created_at OR (o.created_at=linked_todos.created_at AND o.id<linked_todos.id));
CREATE TABLE proposals_new (
 id TEXT PRIMARY KEY,
 token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE RESTRICT,
 op TEXT NOT NULL CHECK(op IN ('create_page','append_text','rename_page','create_row','set_value','add_checklist_item','timetable_set_block','timetable_add_activity','home_set_widgets','habit_add','habit_tick','todo_reorder')),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=65536),
 summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
 dedupe_key TEXT NOT NULL CHECK(length(dedupe_key)=64),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','cancelled','applied','failed')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 decided_at TEXT,
 applied_at TEXT,
 result TEXT CHECK(result IS NULL OR length(result)<=4000)
);
INSERT INTO proposals_new(id,token_id,op,payload,summary,dedupe_key,status,created_at,decided_at,applied_at,result)
 SELECT id,token_id,op,payload,summary,dedupe_key,status,created_at,decided_at,applied_at,result FROM proposals;
DROP TABLE proposals;
ALTER TABLE proposals_new RENAME TO proposals;
CREATE INDEX proposals_status ON proposals(status,created_at);
CREATE INDEX proposals_dedupe ON proposals(token_id,dedupe_key,status);
INSERT INTO schema_migrations(version) VALUES(17);
COMMIT;
