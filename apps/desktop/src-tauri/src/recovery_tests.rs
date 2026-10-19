use crate::{editor, recovery::*};
use rusqlite::Connection;
use std::{fs, path::{Path, PathBuf}};
use uuid::Uuid;

struct Fixture { dir: PathBuf, db: Connection }
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("nou-recovery-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = Connection::open(dir.join("live.sqlite3")).unwrap();
        db.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO workspaces(id,title) VALUES('personal','Personal'); INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('p','personal','Before','001'); INSERT INTO page_search VALUES('p','Before','original');").unwrap();
        Self { dir, db }
    }
    fn title(&self) -> String { self.db.query_row("SELECT title FROM pages WHERE id='p'", [], |r| r.get(0)).unwrap() }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Windows cannot remove a live SQLite connection.
        let old = std::mem::replace(&mut self.db, Connection::open_in_memory().unwrap());
        old.close().unwrap();
        fs::remove_dir_all(&self.dir).unwrap();
    }
}

#[test]
fn complete_wal_restore_and_rollback_survive_reopen() {
    let mut f = Fixture::new();
    let b = create(&f.db, &f.dir.join("backups")).unwrap();
    f.db.execute("UPDATE pages SET title='Latest WAL write'", []).unwrap();
    let staged = stage(Path::new(&b.path), &f.dir).unwrap();
    assert_eq!(f.title(), "Latest WAL write");
    let record = restore(&mut f.db, &staged, &f.dir).unwrap();
    assert_eq!(f.title(), "Before");
    assert!(unresolved(&f.dir).unwrap().is_empty());
    let current = std::mem::replace(&mut f.db, Connection::open_in_memory().unwrap());
    current.close().unwrap();
    f.db = Connection::open(f.dir.join("live.sqlite3")).unwrap();
    assert_eq!(f.title(), "Before");
    let rollback = stage(Path::new(&record.rollback), &f.dir).unwrap();
    restore(&mut f.db, &rollback, &f.dir).unwrap();
    assert_eq!(f.title(), "Latest WAL write");
}

#[test]
fn corrupt_and_truncated_packages_never_replace_live_data() {
    let mut f = Fixture::new();
    let b = create(&f.db, &f.dir.join("backups")).unwrap();
    let staged = stage(Path::new(&b.path), &f.dir).unwrap();
    fs::write(Path::new(&staged.path).join("notes.sqlite3"), b"corrupt").unwrap();
    assert!(restore(&mut f.db, &staged, &f.dir).is_err());
    assert_eq!(f.title(), "Before");
    assert!(unresolved(&f.dir).unwrap().is_empty());
    fs::write(Path::new(&b.path).join("manifest.json"), b"{").unwrap();
    assert!(stage(Path::new(&b.path), &f.dir).is_err());
}

#[test]
fn rejects_wrong_schema_foreign_keys_and_wal_sidecars() {
    let f = Fixture::new();
    let b = create(&f.db, &f.dir.join("backups")).unwrap();
    let path = Path::new(&b.path).join("notes.sqlite3");
    fs::write(PathBuf::from(format!("{}-wal", path.display())), b"WAL").unwrap();
    assert!(validate_notes(&path).is_err());
    fs::remove_file(PathBuf::from(format!("{}-wal", path.display()))).unwrap();
    let c = Connection::open(&path).unwrap();
    c.execute_batch("CREATE TRIGGER unexpected AFTER INSERT ON pages BEGIN DELETE FROM pages; END;").unwrap();
    drop(c);
    assert!(validate_notes(&path).is_err());
    let c = Connection::open(&path).unwrap();
    c.execute_batch("DROP TRIGGER unexpected; PRAGMA foreign_keys=OFF; UPDATE pages SET workspace_id='missing';").unwrap();
    drop(c);
    assert!(validate_notes(&path).is_err());
}

#[test]
fn failed_destination_never_changes_live_data_or_old_versions() {
    let f = Fixture::new();
    let root = f.dir.join("backups");
    let good = create(&f.db, &root).unwrap();
    fs::write(f.dir.join("not-a-directory"), b"unchanged").unwrap();
    assert!(create(&f.db, &f.dir.join("not-a-directory")).is_err());
    assert!(verify(Path::new(&good.path)).is_ok());
    assert_eq!(f.title(), "Before");
    assert!(destination(&f.dir, &f.dir).is_err());
    assert!(destination(&f.dir.join("missing-drive"), &f.dir).is_err());
}

#[test]
fn retention_keeps_three_recent_unknown_and_invalid_versions() {
    let f = Fixture::new(); let root = f.dir.join("backups");
    for _ in 0..5 {
        let b = create(&f.db, &root).unwrap();
        let mut m = b.manifest; m.created_at = now() - 8 * 86400;
        fs::write(Path::new(&b.path).join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    }
    let young = create(&f.db, &root).unwrap();
    fs::create_dir(root.join("backup-incomplete")).unwrap();
    fs::write(root.join("user-file.txt"), "keep").unwrap();
    assert!(retention(&root, 2, now()).is_err());
    let plan = retention(&root, 3, now()).unwrap();
    assert_eq!(plan.remove.len(), 3);
    assert_eq!(plan.skipped, 1);
    assert_eq!(prune(&root, &plan).unwrap(), 3);
    assert_eq!(list(&root).unwrap().0.len(), 3);
    assert!(Path::new(&young.path).exists());
    assert!(root.join("backup-incomplete").exists());
    assert!(root.join("user-file.txt").exists());
}

#[test]
fn retention_aborts_if_a_survivor_has_become_corrupt() {
    let f = Fixture::new(); let root = f.dir.join("backups");
    for _ in 0..4 {
        let b = create(&f.db, &root).unwrap();
        let mut m = b.manifest; m.created_at = now() - 8 * 86400;
        fs::write(Path::new(&b.path).join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    }
    let plan = retention(&root, 3, now()).unwrap();
    let survivor = list(&root).unwrap().0[0].clone();
    fs::write(Path::new(&survivor.path).join("notes.sqlite3"), "bad").unwrap();
    assert!(prune(&root, &plan).is_err());
    assert!(Path::new(&plan.remove[0].path).exists());
}

#[test]
fn interrupted_restore_intent_exposes_rollback_without_replaying() {
    let f = Fixture::new();
    let b = create(&f.db, &f.dir.join("rollback")).unwrap();
    let record = RestoreRecord { id: "interrupted".into(), source: "staged".into(), rollback: b.path, started_at: now() };
    fs::create_dir(f.dir.join("restore-journal")).unwrap();
    write_new_json(&f.dir.join("restore-journal/interrupted.intent.json"), &record).unwrap();
    let pending = unresolved(&f.dir).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(verify(Path::new(&pending[0].rollback)).is_ok());
    assert_eq!(f.title(), "Before");
}

#[test]
fn blocked_sqlite_restore_preserves_rollback_and_wal_data() {
    let mut f = Fixture::new();
    let b = create(&f.db, &f.dir.join("backups")).unwrap();
    let staged = stage(Path::new(&b.path), &f.dir).unwrap();
    f.db.execute("UPDATE pages SET title='newer'", []).unwrap();
    let reader = Connection::open(f.dir.join("live.sqlite3")).unwrap();
    reader.execute_batch("BEGIN IMMEDIATE;").unwrap();
    f.db.busy_timeout(std::time::Duration::from_millis(30)).unwrap();
    // A lock may block the pre-restore VACUUM, or the actual copy. Both must be safe.
    assert!(restore(&mut f.db, &staged, &f.dir).is_err());
    reader.execute_batch("ROLLBACK;").unwrap(); drop(reader);
    assert_eq!(f.title(), "newer");
}

#[test]
fn schema_and_editor_migration_keep_original_updates_and_reject_stale_conversions() {
    let mut f = Fixture::new();
    editor::upgrade(&f.db).unwrap(); editor::upgrade(&f.db).unwrap();
    editor::append(&mut f.db, "p", &[1,2], "original 脳", "text-v1", None).unwrap();
    assert!(editor::append(&mut f.db,"p", &[3], "converted", "blocknote-v1", Some((0,"original 脳"))).is_err());
    assert_eq!(editor::load(&f.db,"p",7).unwrap().format, "text-v1");
    editor::append(&mut f.db,"p", &[3], "converted", "blocknote-v1", Some((1,"original 脳"))).unwrap();
    let note = editor::load(&f.db,"p",7).unwrap();
    assert_eq!(note.legacy_text.as_deref(), Some("original 脳"));
    assert_eq!(note.updates, vec![vec![1,2],vec![3]]);
    assert_eq!(note.epoch, 7);
    assert!(editor::append(&mut f.db,"p", &[4], "stale text", "text-v1", None).is_err());
    assert!(editor::append(&mut f.db,"p", &[4], "again", "blocknote-v1", Some((2,"original"))).is_err());
    let b = create(&f.db, &f.dir.join("backups")).unwrap();
    assert_eq!(b.manifest.schema, 2);
}

#[test]
fn stale_editor_epochs_and_interrupted_restore_block_writes() {
    use std::sync::{Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
    let db = crate::Db(Mutex::new(Connection::open_in_memory().unwrap()), AtomicU64::new(4), AtomicBool::new(false));
    assert!(db.check_epoch(3).is_err()); assert!(db.check_epoch(4).is_ok());
    db.2.store(true, Ordering::SeqCst);
    assert!(db.writable().is_err()); assert!(db.check_epoch(4).is_err());
}

#[test]
#[ignore = "subprocess worker invoked only by the crash recovery test"]
fn restore_crash_worker() {
    let dir = PathBuf::from(std::env::var("NOU_TEST_PROFILE").unwrap());
    let mut c = Connection::open(dir.join("live.sqlite3")).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;").unwrap();
    let staged = verify(Path::new(&std::env::var("NOU_TEST_STAGED").unwrap())).unwrap();
    restore(&mut c, &staged, &dir).unwrap();
    panic!("Crash hook did not terminate the process");
}

#[test]
fn abrupt_process_exit_before_during_and_after_restore_is_recoverable() {
    for point in ["before-copy", "mid-copy", "after-copy"] {
        let mut f = Fixture::new();
        let b = create(&f.db, &f.dir.join("backups")).unwrap();
        let staged = stage(Path::new(&b.path), &f.dir).unwrap();
        f.db.execute("UPDATE pages SET title='latest'", []).unwrap();
        let old = std::mem::replace(&mut f.db, Connection::open_in_memory().unwrap());
        old.close().unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "recovery_tests::restore_crash_worker", "--ignored", "--nocapture"])
            .env("NOU_TEST_CRASH",point).env("NOU_TEST_PROFILE", &f.dir).env("NOU_TEST_STAGED", &staged.path)
            .output().unwrap();
        assert_eq!(child.status.code(), Some(77), "{point}: {}", String::from_utf8_lossy(&child.stderr));
        f.db = Connection::open(f.dir.join("live.sqlite3")).unwrap();
        assert_eq!(f.title(), if point == "after-copy" { "Before" } else { "latest" });
        let pending = unresolved(&f.dir).unwrap(); assert_eq!(pending.len(),1);
        let rollback = stage(Path::new(&pending[0].rollback), &f.dir).unwrap();
        restore(&mut f.db, &rollback, &f.dir).unwrap();
        assert_eq!(f.title(), "latest");
    }
}

#[test]
fn legacy_snapshot_import_preserves_original_and_can_restore() {
    let mut f = Fixture::new();
    let old = crate::backup::create_snapshot(&f.db, &f.dir.join("old-snapshots")).unwrap();
    let original_hash = hash_file(Path::new(&old.path)).unwrap();
    f.db.execute("UPDATE pages SET title='newer'", []).unwrap();
    let staged = import_snapshot(Path::new(&old.path), &f.dir).unwrap();
    assert_eq!(hash_file(Path::new(&old.path)).unwrap(), original_hash);
    assert_eq!(f.title(), "newer");
    restore(&mut f.db, &staged, &f.dir).unwrap();
    assert_eq!(f.title(), "Before");
}

#[test]
fn new_page_rich_state_and_format_commit_together() {
    let mut f = Fixture::new(); editor::upgrade(&f.db).unwrap();
    {
        let tx = f.db.transaction().unwrap();
        assert!(editor::initialize_rich(&tx, "p", &[]).is_err());
    }
    assert_eq!(editor::load(&f.db,"p",0).unwrap().format,"text-v1");
    let tx = f.db.transaction().unwrap();
    editor::initialize_rich(&tx, "p", &[1,2,3]).unwrap(); tx.commit().unwrap();
    let note = editor::load(&f.db,"p",0).unwrap();
    assert_eq!(note.format,"blocknote-v1"); assert_eq!(note.seq,1);
    assert_eq!(note.updates,vec![vec![1,2,3]]);
}
