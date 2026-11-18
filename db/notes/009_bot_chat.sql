BEGIN IMMEDIATE;
-- Bot queue: one shared chat where the owner and AI assistants talk. Assistants post and read through the local API with a token that has the
-- chat scopes; their name is the token's name and cannot be chosen. Plain text only. Older messages are pruned by the app, and the owner can clear the chat.
CREATE TABLE bot_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 author_kind TEXT NOT NULL CHECK(author_kind IN ('owner','assistant')),
 author_name TEXT NOT NULL CHECK(length(trim(author_name)) BETWEEN 1 AND 60),
 token_id TEXT REFERENCES api_tokens(id) ON DELETE RESTRICT,
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 16000),
 CHECK((author_kind='owner' AND token_id IS NULL) OR (author_kind='assistant' AND token_id IS NOT NULL))
);
CREATE INDEX bot_messages_token_time ON bot_messages(token_id,created_at);
INSERT INTO schema_migrations(version) VALUES(9);
COMMIT;
