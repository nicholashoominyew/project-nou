BEGIN IMMEDIATE;
-- Approval gateway (ADR-004). Clients hold a token and can only PROPOSE changes; a human decides in the app.
CREATE TABLE api_tokens (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 scopes TEXT NOT NULL CHECK(json_valid(scopes)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 last_used_at TEXT,
 revoked_at TEXT
);
CREATE TABLE proposals (
 id TEXT PRIMARY KEY,
 token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE RESTRICT,
 op TEXT NOT NULL CHECK(op IN ('create_page','append_text','rename_page','create_row','set_value','add_checklist_item')),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=65536),
 summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
 dedupe_key TEXT NOT NULL CHECK(length(dedupe_key)=64),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','cancelled','applied','failed')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 decided_at TEXT,
 applied_at TEXT,
 result TEXT CHECK(result IS NULL OR length(result)<=4000)
);
CREATE INDEX proposals_status ON proposals(status,created_at);
CREATE INDEX proposals_dedupe ON proposals(token_id,dedupe_key,status);
-- Append-only: nothing may edit or remove an audit entry.
CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 80),
 action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 60),
 detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail))
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
INSERT INTO schema_migrations(version) VALUES(6);
COMMIT;
