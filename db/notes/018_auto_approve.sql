BEGIN IMMEDIATE;
-- Auto-approval of low-risk proposals (docs/development/AUTO-APPROVE.md). Only the app's own screens write rules and switches; nothing reachable by a bot does.
-- A rule says where (a page, optionally with everything under it, or anywhere), what (some of the six page operations), who (a token name, or any) and how often.
CREATE TABLE auto_rules (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
 page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
 include_subtree INTEGER NOT NULL DEFAULT 1 CHECK(include_subtree IN (0,1)),
 ops TEXT NOT NULL CHECK(json_valid(ops)),
 source TEXT CHECK(source IS NULL OR length(source) BETWEEN 1 AND 60),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 per_hour INTEGER NOT NULL DEFAULT 100 CHECK(per_hour BETWEEN 1 AND 1000),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- One row. Both switches matter: nothing auto-approves unless the feature is on AND it is not paused.
CREATE TABLE auto_state (
 id INTEGER PRIMARY KEY CHECK(id=1),
 feature_on INTEGER NOT NULL DEFAULT 0 CHECK(feature_on IN (0,1)),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
);
INSERT INTO auto_state(id) VALUES(1);
-- Every proposal a rule approved. rule_id has no foreign key: the history stays when a rule is deleted.
CREATE TABLE auto_log (
 proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
 rule_id TEXT NOT NULL,
 rule_name TEXT NOT NULL,
 source TEXT NOT NULL,
 op TEXT NOT NULL,
 page_id TEXT,
 change_text TEXT NOT NULL,
 undo TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(undo)),
 approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 claimed_at TEXT,
 applied_at TEXT,
 undone_at TEXT,
 seen INTEGER NOT NULL DEFAULT 0 CHECK(seen IN (0,1))
);
CREATE INDEX auto_log_rule ON auto_log(rule_id,approved_at);
CREATE INDEX auto_log_page ON auto_log(page_id,seen);
-- Pages a bot created, as it last left them. A bot may only have a rename auto-approved on its own page while nobody else has changed it.
CREATE TABLE auto_bot_pages (
 page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 source TEXT NOT NULL,
 title TEXT NOT NULL,
 body TEXT NOT NULL
);
INSERT INTO schema_migrations(version) VALUES(18);
COMMIT;
