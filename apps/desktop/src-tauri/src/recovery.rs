//! Notes-only packages. The manifest is written last; incomplete folders are never valid backups.
//! Restoration uses SQLite's transactional Backup API into the existing connection: never copy
//! a database over an open file or discard WAL/SHM files. The caller holds the database mutex.
use crate::backup;
use rusqlite::{backup::{Backup, StepResult}, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
pub const MIN_KEEP: usize = 3;
const WEEK: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub id: String,
    pub created_at: u64,
    pub schema: i64,
    pub bytes: u64,
    pub sha256: String,
    pub scope: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Verified {
    pub path: String,
    pub manifest: Manifest,
    pub pages: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestoreRecord {
    pub id: String,
    pub source: String,
    pub rollback: String,
    pub started_at: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct RetentionPlan {
    pub token: String,
    pub remove: Vec<Verified>,
    pub retained: usize,
    pub skipped: usize,
}
pub fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

pub fn write_new_json<T: Serialize>(path: &Path, data: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new().create_new(true).write(true).open(path).map_err(|e| e.to_string())?;
    f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())
}
pub fn hash_file(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn regular(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() || m.file_type().is_symlink() { return Err("Expected a regular file, not a link".into()); }
    Ok(())
}
pub fn destination(root: &Path, app_data: &Path) -> Result<PathBuf> {
    // Require an existing chosen directory. An unplugged drive must fail, not silently fall back.
    let root = root.canonicalize().map_err(|e| format!("Backup destination unavailable: {e}"))?;
    let app = app_data.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() || root.starts_with(&app) || app.starts_with(&root) {
        return Err("Choose a dedicated backup folder outside the application's data folder".into());
    }
    let owned = root.join("Project-NOU-backups");
    if owned.exists() && fs::symlink_metadata(&owned).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("Backup folder must not be a link".into());
    }
    fs::create_dir_all(&owned).map_err(|e| e.to_string())?;
    let actual = owned.canonicalize().map_err(|e| e.to_string())?;
    if actual.parent() != Some(root.as_path()) { return Err("Backup folder resolves outside chosen destination".into()); }
    Ok(actual)
}

/// Validate the actual Notes schema, not merely a table claiming a schema number.
pub fn validate_notes(path: &Path) -> Result<(i64, i64)> {
    regular(path)?;
    backup::verify_file(path)?;
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    c.pragma_update(None, "trusted_schema", "OFF").map_err(|e| e.to_string())?;
    let schema: i64 = c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    // Compare schema definitions against the shipped migrations. Reject extra triggers/views/tables.
    let expected = Connection::open_in_memory().map_err(|e| e.to_string())?;
    expected.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).map_err(|e| e.to_string())?;
    if schema == 2 { expected.execute_batch(include_str!("../../../../db/notes/002_editor_formats.sql")).map_err(|e| e.to_string())?; }
    fn definitions(c: &Connection) -> Result<Vec<(String, String, String)>> {
        let mut s = c.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").map_err(|e| e.to_string())?;
        let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?.split_whitespace().collect::<Vec<_>>().join(" ")))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    }
    if definitions(&c)? != definitions(&expected)? { return Err("Backup schema does not match a supported NOU Notes database".into()); }
    if c.prepare("PRAGMA foreign_key_check").map_err(|e| e.to_string())?.exists([]).map_err(|e| e.to_string())? {
        return Err("Backup contains broken references".into());
    }
    let workspace: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id='personal')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !workspace { return Err("Backup has no Personal workspace".into()); }
    let pages = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok((schema, pages))
}
pub fn create(source: &Connection, root: &Path) -> Result<Verified> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let id = format!("backup-{}-{}", now(), Uuid::new_v4());
    let dir = root.join(&id);
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("notes.sqlite3");
    source.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()]).map_err(|e| format!("Backup failed; previous versions retained: {e}"))?;
    fs::OpenOptions::new().write(true).open(&path).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    let (schema, _) = validate_notes(&path)?;
    let manifest = Manifest { format: 1, id, created_at: now(), schema, bytes: fs::metadata(&path).map_err(|e| e.to_string())?.len(), sha256: hash_file(&path)?, scope: "notes-database-only".into() };
    write_new_json(&dir.join("manifest.json"), &manifest)?;
    verify(&dir)
}
pub fn verify(dir: &Path) -> Result<Verified> {
    if fs::symlink_metadata(dir).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("Backup package must not be a link".into()); }
    let manifest_path = dir.join("manifest.json");
    regular(&manifest_path)?;
    if fs::metadata(&manifest_path).map_err(|e| e.to_string())?.len() > 16384 { return Err("Oversized manifest".into()); }
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if manifest.format != 1 || manifest.scope != "notes-database-only" || !manifest.id.starts_with("backup-") || dir.file_name().and_then(|s| s.to_str()) != Some(&manifest.id) {
        return Err("Unsupported backup manifest or renamed package".into());
    }
    let path = dir.join("notes.sqlite3");
    regular(&path)?;
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() != manifest.bytes || hash_file(&path)? != manifest.sha256 { return Err("Backup checksum/size mismatch".into()); }
    let (schema, pages) = validate_notes(&path)?;
    if schema != manifest.schema { return Err("Manifest schema mismatch".into()); }
    Ok(Verified { path: dir.to_string_lossy().into(), manifest, pages })
}
pub fn list(root: &Path) -> Result<(Vec<Verified>, usize)> {
    let mut valid = Vec::new(); let mut skipped = 0;
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with("backup-") { continue; }
        match verify(&entry.path()) { Ok(v) => valid.push(v), Err(_) => skipped += 1 }
    }
    valid.sort_by(|a,b| b.manifest.created_at.cmp(&a.manifest.created_at).then(b.manifest.id.cmp(&a.manifest.id)));
    Ok((valid, skipped))
}
pub fn retention(root: &Path, keep: usize, timestamp: u64) -> Result<RetentionPlan> {
    if keep < MIN_KEEP { return Err("Keep at least three verified backup versions".into()); }
    let (valid, skipped) = list(root)?;
    let remove: Vec<_> = valid.iter().skip(keep).filter(|v| timestamp.saturating_sub(v.manifest.created_at) >= WEEK).cloned().collect();
    Ok(RetentionPlan { token: Uuid::new_v4().to_string(), retained: valid.len() - remove.len(), remove, skipped })
}
pub fn prune(root: &Path, plan: &RetentionPlan) -> Result<usize> {
    // Reverify all survivors immediately before pruning. Unknown/corrupt/young versions are kept.
    let fresh = retention(root, plan.retained.max(MIN_KEEP), now())?;
    for v in &plan.remove {
        if !fresh.remove.iter().any(|f| f.manifest.id == v.manifest.id && f.manifest.sha256 == v.manifest.sha256) { return Err("Backup inventory changed; review retention again".into()); }
        let dir = root.join(&v.manifest.id);
        let children: Vec<_> = fs::read_dir(&dir).map_err(|e| e.to_string())?.collect::<std::io::Result<Vec<_>>>().map_err(|e| e.to_string())?;
        if children.len() != 2 { return Err("Package contains extra files; retained for safety".into()); }
        for child in children { regular(&child.path())?; }
    }
    let mut count = 0;
    for v in &plan.remove {
        let dir = root.join(&v.manifest.id);
        // Delete only these two known files. No recursive deletion of user-selected directories.
        fs::remove_file(dir.join("manifest.json")).map_err(|e| e.to_string())?;
        fs::remove_file(dir.join("notes.sqlite3")).map_err(|e| e.to_string())?;
        fs::remove_dir(dir).map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}
pub fn stage(source: &Path, app_data: &Path) -> Result<Verified> {
    let selected = verify(source)?;
    let parent = app_data.join("restore-staging").join(Uuid::new_v4().to_string());
    let target = parent.join(&selected.manifest.id);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let mut input = fs::File::open(source.join("notes.sqlite3")).map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new().create_new(true).write(true).open(target.join("notes.sqlite3")).map_err(|e| e.to_string())?;
    std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?; drop(output);
    write_new_json(&target.join("manifest.json"), &selected.manifest)?;
    verify(&target)
}
/// Wrap an alpha-0.0.1 standalone snapshot without modifying the original file.
pub fn import_snapshot(source: &Path, app_data: &Path) -> Result<Verified> {
    let (schema, _) = validate_notes(source)?;
    let manifest = Manifest { format: 1, id: format!("backup-{}-{}", now(), Uuid::new_v4()), created_at: now(), schema,
        bytes: fs::metadata(source).map_err(|e| e.to_string())?.len(), sha256: hash_file(source)?, scope: "notes-database-only".into() };
    let dir = app_data.join("restore-staging").join(Uuid::new_v4().to_string()).join(&manifest.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(dir.join("notes.sqlite3")).map_err(|e| e.to_string())?;
    std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?; drop(output);
    write_new_json(&dir.join("manifest.json"), &manifest)?;
    verify(&dir)
}
pub fn restore(connection: &mut Connection, staged: &Verified, app_data: &Path) -> Result<RestoreRecord> {
    let checked = verify(Path::new(&staged.path))?;
    if checked.manifest.sha256 != staged.manifest.sha256 { return Err("Staged restore changed".into()); }
    let rollback = create(connection, &app_data.join("rollback"))?;
    let record = RestoreRecord { id: Uuid::new_v4().to_string(), source: checked.path.clone(), rollback: rollback.path, started_at: now() };
    let journal = app_data.join("restore-journal");
    fs::create_dir_all(&journal).map_err(|e| e.to_string())?;
    write_new_json(&journal.join(format!("{}.intent.json", record.id)), &record)?;
    #[cfg(test)]
    crash_test_hook("before-copy");
    let source = Connection::open_with_flags(Path::new(&checked.path).join("notes.sqlite3"), OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    // One SQLite transaction, including WAL commits; SQLite rolls back an incomplete copy.
    // Step all pages at once to avoid a partial restore becoming visible to another reader.
    {
        let backup = Backup::new(&source, connection).map_err(|e| e.to_string())?;
        #[cfg(test)]
        if std::env::var("NOU_TEST_CRASH").as_deref() == Ok("mid-copy") {
            backup.step(1).map_err(|e| e.to_string())?;
            crash_test_hook("mid-copy");
        }
        match backup.step(-1).map_err(|e| format!("Restore incomplete. Rollback preserved at {}. {e}", record.rollback))? {
            StepResult::Done => (),
            _ => return Err(format!("Database busy; restore cancelled. Rollback preserved at {}", record.rollback)),
        }
    }
    #[cfg(test)]
    crash_test_hook("after-copy");
    let result: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if result != "ok" { return Err(format!("Restore verification failed. Rollback: {}", record.rollback)); }
    // Durable marker is separate; a crash/failed marker write leaves the intent visible on restart.
    write_new_json(&journal.join(format!("{}.done.json", record.id)), &record)?;
    Ok(record)
}

#[cfg(test)]
fn crash_test_hook(point: &str) {
    if std::env::var("NOU_TEST_CRASH").as_deref() == Ok(point) {
        // Abrupt process termination: deliberately skip all Rust/SQLite destructors.
        std::process::exit(77);
    }
}
pub fn unresolved(app_data: &Path) -> Result<Vec<RestoreRecord>> {
    let journal = app_data.join("restore-journal");
    if !journal.exists() { return Ok(Vec::new()); }
    let mut records = Vec::new();
    for entry in fs::read_dir(&journal).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.to_string_lossy().ends_with(".intent.json") { continue; }
        let record: RestoreRecord = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| format!("Unreadable restore journal (preserved): {e}"))?;
        if !journal.join(format!("{}.done.json", record.id)).exists() && !journal.join(format!("{}.reviewed.json", record.id)).exists() { records.push(record); }
    }
    Ok(records)
}
