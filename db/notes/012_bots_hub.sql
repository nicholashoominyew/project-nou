BEGIN IMMEDIATE;
-- Bots Hub: rooms, hand-offs and approvals in the collaboration chat; the bot queue; and a private in-house channel.
-- Everything an assistant writes is plain text and data. Nothing here changes a note.

-- Rooms. "General" (id 1) always exists and takes every message written before this migration.
CREATE TABLE bot_rooms (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 40),
 slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 1 AND 40),
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO bot_rooms(id,name,slug,sort_order) VALUES(1,'General','general',0);

-- Message types: a normal message, a hand-off line, or an approval card. (SQLite cannot add a column that both references another table and has a
-- default, so the room is checked by the triggers below.)
ALTER TABLE bot_messages ADD COLUMN room_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bot_messages ADD COLUMN type TEXT NOT NULL DEFAULT 'message' CHECK(type IN ('message','handoff','approval'));
ALTER TABLE bot_messages ADD COLUMN role TEXT CHECK(role IS NULL OR length(role) BETWEEN 1 AND 20);
ALTER TABLE bot_messages ADD COLUMN handoff_from TEXT CHECK(handoff_from IS NULL OR length(handoff_from) BETWEEN 1 AND 60);
ALTER TABLE bot_messages ADD COLUMN handoff_to TEXT CHECK(handoff_to IS NULL OR length(handoff_to) BETWEEN 1 AND 60);
ALTER TABLE bot_messages ADD COLUMN task_ref TEXT CHECK(task_ref IS NULL OR length(task_ref) BETWEEN 1 AND 160);
ALTER TABLE bot_messages ADD COLUMN approval_status TEXT CHECK(approval_status IS NULL OR approval_status IN ('open','approved','declined'));
ALTER TABLE bot_messages ADD COLUMN queue_item_id INTEGER;
ALTER TABLE bot_messages ADD COLUMN decided_at TEXT;
CREATE INDEX bot_messages_room ON bot_messages(room_id,id);
CREATE TRIGGER bot_messages_room_exists BEFORE INSERT ON bot_messages WHEN NOT EXISTS(SELECT 1 FROM bot_rooms WHERE id=NEW.room_id)
BEGIN SELECT RAISE(ABORT,'Unknown room'); END;
CREATE TRIGGER bot_messages_shape BEFORE INSERT ON bot_messages
WHEN (NEW.type='approval') IS NOT (NEW.approval_status IS NOT NULL) OR (NEW.type='handoff' AND (NEW.handoff_from IS NULL OR NEW.handoff_to IS NULL))
BEGIN SELECT RAISE(ABORT,'Malformed message'); END;
CREATE TRIGGER bot_rooms_in_use BEFORE DELETE ON bot_rooms WHEN OLD.id=1 OR EXISTS(SELECT 1 FROM bot_messages WHERE room_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'General, or a room that has messages, cannot be deleted'); END;

-- The bot queue: what each assistant is working on. needs_nick items are made by an approval card and closed only by the owner.
CREATE TABLE bot_queue_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
 bot TEXT NOT NULL CHECK(length(trim(bot)) BETWEEN 1 AND 60),
 token_id TEXT REFERENCES api_tokens(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','needs_nick','done')),
 room_id INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX bot_queue_status ON bot_queue_items(status,updated_at);
CREATE TRIGGER bot_queue_room_exists BEFORE INSERT ON bot_queue_items WHEN NOT EXISTS(SELECT 1 FROM bot_rooms WHERE id=NEW.room_id)
BEGIN SELECT RAISE(ABORT,'Unknown room'); END;

-- The in-house channel: a private one-to-one chat with the local model. It is a separate table on purpose: the collaboration room, /v1/chat and
-- every other bot's reads never touch it.
CREATE TABLE inhouse_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 author TEXT NOT NULL CHECK(author IN ('owner','bot')),
 token_id TEXT REFERENCES api_tokens(id) ON DELETE RESTRICT,
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),
 CHECK((author='owner' AND token_id IS NULL) OR (author='bot' AND token_id IS NOT NULL))
);
INSERT INTO schema_migrations(version) VALUES(12);
COMMIT;
