BEGIN IMMEDIATE;
-- Password-locked notes. A row here means the note's content (every Yjs update and snapshot) is stored as AES-256-GCM ciphertext under a key
-- derived from the person's password with Argon2id. The password and key are never stored; `check_blob` is a small known value encrypted with
-- the key so a wrong password is detected. Titles, tags and attached files are NOT encrypted. Existing rows are never changed by this migration.
CREATE TABLE page_locks (
 page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 salt BLOB NOT NULL CHECK(length(salt)=16),
 kdf_m INTEGER NOT NULL CHECK(kdf_m BETWEEN 8192 AND 1048576),
 kdf_t INTEGER NOT NULL CHECK(kdf_t BETWEEN 1 AND 10),
 kdf_p INTEGER NOT NULL CHECK(kdf_p BETWEEN 1 AND 4),
 check_blob BLOB NOT NULL CHECK(length(check_blob) BETWEEN 29 AND 64),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO schema_migrations(version) VALUES(8);
COMMIT;
