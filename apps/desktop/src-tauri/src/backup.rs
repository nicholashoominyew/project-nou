use rusqlite::Connection;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

/// Local recovery snapshots stay on the same device. They are NOT off-device backups.
#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub filename: String,
    pub path: String,
    pub bytes: u64,
}

pub fn create_snapshot(source: &Connection, directory: &Path) -> Result<Snapshot, String> {
    fs::create_dir_all(directory).map_err(|e| format!("Cannot create snapshot directory: {e}"))?;
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let filename = format!("notes-{epoch}-{}.sqlite3", Uuid::new_v4());
    let target = directory.join(&filename);
    // VACUUM INTO produces a transactionally consistent standalone database even in WAL mode.
    // Target must be a *new* file; never overwrite a previously good snapshot.
    source.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
        .map_err(|e| format!("Snapshot failed: {e}"))?;
    // VACUUM output must be durable before reporting success.
    fs::OpenOptions::new().write(true).open(&target).and_then(|f| f.sync_all())
        .map_err(|e| format!("Snapshot flush failed: {e}"))?;
    match verify_file(&target) {
        Ok(bytes) => Ok(Snapshot {
            filename,
            path: target.to_string_lossy().to_string(),
            bytes,
        }),
        Err(problem) => {
            // A corrupt newly created snapshot is discarded; existing snapshots are untouched.
            let _ = fs::remove_file(&target);
            Err(problem)
        }
    }
}

pub fn verify_file(path: &Path) -> Result<u64, String> {
    // These are standalone snapshots, never live databases with uncheckpointed WAL.
    for suffix in ["-wal", "-shm", "-journal"] {
        if PathBuf::from(format!("{}{suffix}", path.display())).exists() {
            return Err("Snapshot has SQLite sidecars; select a standalone NOU backup".into());
        }
    }
    // READ_ONLY is not immutable mode. Do not claim it bypasses SQLite locking.
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).map_err(|e| format!("Cannot open snapshot: {e}"))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("Cannot verify snapshot: {e}"))?;
    if integrity != "ok" {
        return Err(format!("SQLite integrity check failed: {integrity}"));
    }
    let version: i64 = connection
        .query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |row| row.get(0))
        .map_err(|e| format!("Snapshot missing migration metadata: {e}"))?;
    if version != 1 && version != 2 {
        return Err(format!("Snapshot has unsupported Notes schema version: {version}"));
    }
    fs::metadata(path).map_err(|e| e.to_string()).map(|m| m.len())
}

pub fn verify_snapshot(directory: &Path, filename: &str) -> Result<Snapshot, String> {
    if !filename.starts_with("notes-")
        || !filename.ends_with(".sqlite3")
        || Path::new(filename).file_name().and_then(|s| s.to_str()) != Some(filename)
        || filename.contains('/') || filename.contains('\\')
    {
        return Err("Invalid snapshot filename".into());
    }
    let path: PathBuf = directory.join(filename);
    let bytes = verify_file(&path)?;
    Ok(Snapshot {
        filename: filename.to_string(),
        path: path.to_string_lossy().to_string(),
        bytes,
    })
}

/// Recover a verified snapshot into a fresh, isolated SQLite database.
/// Never open or overwrite the live application's Notes database.
pub fn stage_restore(directory: &Path, filename: &str, staging: &Path) -> Result<Snapshot, String> {
    let selected = verify_snapshot(directory, filename)?;
    fs::create_dir_all(staging).map_err(|e| format!("Cannot create staging directory: {e}"))?;
    let source = directory.join(filename);
    let restored_name = format!("restore-{}.sqlite3", Uuid::new_v4());
    let destination = staging.join(&restored_name);

    // The caller can inspect this recovered copy before any cutover decision.
    // create_new ensures a previous successful recovery cannot be overwritten.
    let mut input = fs::File::open(&source).map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&destination)
        .map_err(|e| e.to_string())?;
    if let Err(e) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(&destination);
        return Err(format!("Restore copy failed: {e}"));
    }
    output.sync_all().map_err(|e| format!("Restore flush failed: {e}"))?;
    drop(output);
    let bytes = match verify_file(&destination) {
        Ok(size) if size == selected.bytes => size,
        Ok(_) => {
            let _ = fs::remove_file(&destination);
            return Err("Restored file size does not match source snapshot".into());
        }
        Err(error) => {
            let _ = fs::remove_file(&destination);
            return Err(format!("Staged restore failed verification: {error}"));
        }
    };
    Ok(Snapshot {
        filename: restored_name,
        path: destination.to_string_lossy().to_string(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("nou-backup-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn roundtrip_including_wal_writes() {
        let dir = temporary_directory();
        let db = Connection::open(dir.join("live.sqlite3")).unwrap();
        db.execute_batch("
            PRAGMA journal_mode=WAL;
            CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
            INSERT INTO schema_migrations(version) VALUES(1);
            CREATE TABLE pages(id TEXT PRIMARY KEY, title TEXT NOT NULL);
            INSERT INTO pages VALUES('page1','Before backup');
        ").unwrap();
        let snapshot = create_snapshot(&db, &dir.join("snapshots")).unwrap();
        db.execute("UPDATE pages SET title='After backup' WHERE id='page1'", []).unwrap();
        let backup_db = Connection::open(&snapshot.path).unwrap();
        let restored_title: String = backup_db.query_row(
            "SELECT title FROM pages WHERE id='page1'", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(restored_title, "Before backup");
        assert!(verify_snapshot(&dir.join("snapshots"), &snapshot.filename).is_ok());
        drop(backup_db);
        drop(db);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restore_is_staged_and_live_file_unchanged() {
        let dir = temporary_directory();
        let live_path = dir.join("live.sqlite3");
        let db = Connection::open(&live_path).unwrap();
        db.execute_batch("
            CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
            INSERT INTO schema_migrations(version) VALUES (1);
            CREATE TABLE pages(id TEXT PRIMARY KEY, title TEXT NOT NULL);
            INSERT INTO pages VALUES ('p1','Original');
        ").unwrap();
        let snapshots = dir.join("snapshots");
        let snapshot = create_snapshot(&db, &snapshots).unwrap();
        db.execute("UPDATE pages SET title='Live change' WHERE id='p1'", []).unwrap();
        let staged = stage_restore(&snapshots, &snapshot.filename, &dir.join("restore-tests")).unwrap();
        let staged_db = Connection::open(&staged.path).unwrap();
        let title: String = staged_db.query_row(
            "SELECT title FROM pages WHERE id='p1'", [], |row| row.get(0)
        ).unwrap();
        let live_title: String = db.query_row(
            "SELECT title FROM pages WHERE id='p1'", [], |row| row.get(0)
        ).unwrap();
        assert_eq!(title, "Original");
        assert_eq!(live_title, "Live change");
        drop(staged_db);
        drop(db);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reject_path_traversal() {
        let dir = temporary_directory();
        assert!(verify_snapshot(&dir, "../notes-secret.sqlite3").is_err());
        assert!(verify_snapshot(&dir, "notes-foo/../other.sqlite3").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
