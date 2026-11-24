BEGIN IMMEDIATE;
-- Three more things an assistant may ASK for (it still cannot do any of them; the owner decides in the app): change a block of the Life Timetable, add a
-- timetable activity, and show or hide sections of the Home page. SQLite cannot change a CHECK constraint, so the proposals table is rebuilt with the
-- longer list of operations. Every row is copied unchanged; nothing else refers to this table.
CREATE TABLE proposals_new (
 id TEXT PRIMARY KEY,
 token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE RESTRICT,
 op TEXT NOT NULL CHECK(op IN ('create_page','append_text','rename_page','create_row','set_value','add_checklist_item','timetable_set_block','timetable_add_activity','home_set_widgets')),
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
INSERT INTO schema_migrations(version) VALUES(15);
COMMIT;
