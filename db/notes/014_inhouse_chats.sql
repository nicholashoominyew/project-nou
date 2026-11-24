BEGIN IMMEDIATE;
-- In-house chats: the private chat with the local model (Kura) becomes several named chats, like an ordinary AI chat app, and the owner can add
-- harnesses: named blocks of extra instructions written for NOU that are given to the model along with its usual instructions.
-- Everything here is plain text and data. Nothing in it can change a note.

CREATE TABLE inhouse_chats (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 80),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Chat 1 always exists at first and takes every message written before this migration. (SQLite cannot add a column that both references another
-- table and has a default, so the chat is checked by the trigger below.)
INSERT INTO inhouse_chats(id,title) VALUES(1, CASE WHEN EXISTS(SELECT 1 FROM inhouse_messages) THEN 'Earlier chat' ELSE 'New chat' END);
ALTER TABLE inhouse_messages ADD COLUMN chat_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX inhouse_messages_chat ON inhouse_messages(chat_id,id);
CREATE TRIGGER inhouse_messages_chat_exists BEFORE INSERT ON inhouse_messages WHEN NOT EXISTS(SELECT 1 FROM inhouse_chats WHERE id=NEW.chat_id)
BEGIN SELECT RAISE(ABORT,'Unknown chat'); END;

CREATE TABLE inhouse_harnesses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 60),
 instructions TEXT NOT NULL CHECK(length(trim(instructions)) BETWEEN 1 AND 4000),
 always INTEGER NOT NULL DEFAULT 0 CHECK(always IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Which harnesses a chat uses on top of the ones marked "always".
CREATE TABLE inhouse_chat_harnesses (
 chat_id INTEGER NOT NULL REFERENCES inhouse_chats(id) ON DELETE CASCADE,
 harness_id INTEGER NOT NULL REFERENCES inhouse_harnesses(id) ON DELETE CASCADE,
 PRIMARY KEY(chat_id, harness_id)
);
INSERT INTO schema_migrations(version) VALUES(14);
COMMIT;
