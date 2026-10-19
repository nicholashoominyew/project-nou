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

fn verify_file(path: &Path) -> Result<u64, String> {
    // SQLite immutable read-only opening avoids creating companion WAL or SHM files.
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
    if version != 1 {
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
    fn reject_path_traversal() {
        let dir = temporary_directory();
        assert!(verify_snapshot(&dir, "../notes-secret.sqlite3").is_err());
        assert!(verify_snapshot(&dir, "notes-foo/../other.sqlite3").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
