//! Durable weekly scheduling shared by the desktop worker and the headless Windows task.
//! The caller holds the profile lock and database mutex. No destination fallback or implicit cleanup.
use crate::recovery;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Destination { pub path: String, pub protection: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Success { pub at: u64, pub path: String, pub sha256: String, pub destination: String }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Schedule {
    pub enabled: bool,
    pub auto_keep: Option<usize>,
    pub last_attempt: Option<u64>,
    pub last_success: Option<Success>,
    pub error: Option<String>,
}
pub const WEEK: u64 = 7 * 24 * 60 * 60;
pub const RETRY: u64 = 15 * 60;
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 65536 { return Err("Settings file exceeds supported size".into()); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| format!("Cannot commit settings: {e}"))
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}
pub fn destination(data: &Path) -> Result<Option<Destination>, String> {
    let path = data.join("backup-destination.json");
    if !path.exists() { return Ok(None); }
    read_json(&path).map(Some).map_err(|e| format!("Backup destination unreadable: {e}"))
}
pub fn root(data: &Path) -> Result<PathBuf, String> {
    let selected = destination(data)?.ok_or("Choose a backup destination first")?;
    recovery::destination(Path::new(&selected.path), data)
}
pub fn load(data: &Path) -> Result<Schedule, String> {
    let path = data.join("backup-schedule.json");
    if !path.exists() { return Ok(Schedule::default()); }
    let config: Schedule = read_json(&path).map_err(|e| format!("Backup schedule unreadable; no automatic backups or cleanup will run: {e}"))?;
    if config.auto_keep.is_some_and(|n| !(3..=10000).contains(&n)) { return Err("Invalid automatic retention setting".into()); }
    Ok(config)
}
pub fn configure(data: &Path, enabled: bool, auto_keep: Option<usize>) -> Result<Schedule, String> {
    if auto_keep.is_some_and(|n| !(3..=10000).contains(&n)) { return Err("Keep between 3 and 10000 verified versions".into()); }
    if enabled { root(data)?; }
    let mut config = load(data)?;
    config.enabled = enabled; config.auto_keep = auto_keep;
    // Re-enabling retries immediately if due; it never resets the last verified success.
    config.last_attempt = None; config.error = None;
    atomic_json(&data.join("backup-schedule.json"), &config)?;
    Ok(config)
}
pub fn reset(data: &Path) -> Result<Schedule, String> {
    let path = data.join("backup-schedule.json");
    if path.exists() {
        let preserved = data.join(format!("backup-schedule-preserved-{}.json", uuid::Uuid::new_v4()));
        let mut input = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new().create_new(true).write(true).open(preserved).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()).map_err(|e| e.to_string())?;
    }
    let state = Schedule::default(); atomic_json(&path, &state)?; Ok(state)
}
pub fn due(config: &Schedule, destination: &str, timestamp: u64) -> bool {
    config.enabled && config.last_success.as_ref().is_none_or(|last| {
        last.destination != destination || timestamp < last.at || timestamp - last.at >= WEEK
    }) && config.last_attempt.is_none_or(|at| timestamp < at || timestamp - at >= RETRY)
}
pub fn record_success(data: &Path, backup: &recovery::Verified, timestamp: u64) -> Result<(), String> {
    let mut config = load(data)?;
    let destination = destination(data)?.ok_or("Backup destination missing")?.path;
    config.last_success = Some(Success { at: timestamp, path: backup.path.clone(), sha256: backup.manifest.sha256.clone(), destination });
    config.last_attempt = Some(timestamp); config.error = None;
    atomic_json(&data.join("backup-schedule.json"), &config)
}
/// At most one catch-up copy, regardless of how many weeks the machine was asleep/offline.
pub fn tick(source: &Connection, data: &Path, timestamp: u64) -> Result<Schedule, String> {
    let mut config = load(data)?;
    if !config.enabled { return Ok(config); }
    let selected = destination(data)?;
    let selected_path = selected.as_ref().map(|d| d.path.as_str()).unwrap_or("");
    if !due(&config, selected_path, timestamp) { return Ok(config); }
    config.last_attempt = Some(timestamp);
    // Persist the attempt first, so repeated restarts cannot hammer an unplugged drive.
    atomic_json(&data.join("backup-schedule.json"), &config)?;
    let result = (|| {
        if !recovery::unresolved(data)?.is_empty() { return Err("Review the interrupted restore before automatic backup".into()); }
        let root = root(data)?;
        let backup = recovery::create(source, &root)?;
        config.last_success = Some(Success { at: timestamp, path: backup.path, sha256: backup.manifest.sha256, destination: selected_path.into() });
        // Only explicit opt-in permits cleanup, after a new verified backup succeeded.
        if let Some(keep) = config.auto_keep {
            let plan = recovery::retention(&root, keep, timestamp)?;
            recovery::prune(&root, &plan).map_err(|e| format!("Backup succeeded; cleanup needs review: {e}"))?;
        }
        Ok::<_, String>(())
    })();
    config.error = result.err();
    atomic_json(&data.join("backup-schedule.json"), &config)?;
    Ok(config)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn due_catches_up_once_and_throttles_failures() {
        let mut c = Schedule { enabled: true, ..Schedule::default() };
        assert!(due(&c, "D:/copies", 1000));
        c.last_attempt = Some(1000);
        assert!(!due(&c, "D:/copies", 1001)); assert!(due(&c, "D:/copies", 1900));
        c.last_success = Some(Success { at: 1000, path: "x".into(), sha256: "x".into(), destination: "D:/copies".into() });
        assert!(!due(&c, "D:/copies", 1900)); assert!(due(&c, "E:/copies", 1900));
        assert!(due(&c, "D:/copies", 1000 + WEEK * 5));
        assert!(due(&c, "D:/copies", 999)); // Clock moved backwards: make a fresh copy.
        c.enabled = false; assert!(!due(&c, "D:/copies", u64::MAX));
    }
    #[test]
    fn unavailable_destination_never_advances_success_and_can_catch_up() {
        let dir = std::env::temp_dir().join(format!("nou-schedule-{}", uuid::Uuid::new_v4()));
        let data = dir.join("profile"); let target = dir.join("separate");
        fs::create_dir_all(&data).unwrap(); fs::create_dir_all(&target).unwrap();
        atomic_json(&data.join("backup-destination.json"), &Destination { path: target.to_string_lossy().into(), protection: "local-or-unknown".into() }).unwrap();
        configure(&data, true, None).unwrap();
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute_batch(include_str!("../../../../db/notes/002_editor_formats.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        let first = tick(&c, &data, 1000).unwrap(); assert!(first.last_success.is_some());
        let count = recovery::list(&root(&data).unwrap()).unwrap().0.len();
        tick(&c, &data, 2000).unwrap(); assert_eq!(recovery::list(&root(&data).unwrap()).unwrap().0.len(), count);
        fs::rename(&target, dir.join("unplugged")).unwrap();
        let failed = tick(&c, &data, 1000 + WEEK).unwrap(); assert!(failed.error.is_some()); assert_eq!(failed.last_success.unwrap().at, 1000);
        fs::rename(dir.join("unplugged"), &target).unwrap();
        let caught_up = tick(&c, &data, 1000 + WEEK + RETRY).unwrap(); assert!(caught_up.error.is_none());
        assert_eq!(recovery::list(&root(&data).unwrap()).unwrap().0.len(), count + 1);
        fs::create_dir_all(data.join("restore-journal")).unwrap();
        let record = recovery::RestoreRecord { id: "pending".into(), source: "source".into(), rollback: "rollback".into(), started_at: 1000 };
        recovery::write_new_json(&data.join("restore-journal/pending.intent.json"), &record).unwrap();
        let blocked = tick(&c, &data, 1000 + WEEK*2 + RETRY).unwrap(); assert!(blocked.error.unwrap().contains("interrupted restore"));
        assert_eq!(recovery::list(&root(&data).unwrap()).unwrap().0.len(), count + 1);
        fs::write(data.join("backup-schedule.json"), b"broken").unwrap(); assert!(tick(&c, &data, u64::MAX).is_err());
        assert!(!reset(&data).unwrap().enabled);
        assert!(fs::read_dir(&data).unwrap().any(|x| x.unwrap().file_name().to_string_lossy().starts_with("backup-schedule-preserved-")));
        drop(c); fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn automatic_cleanup_runs_only_after_verified_success_and_preserves_floors() {
        let dir = std::env::temp_dir().join(format!("nou-scheduled-retention-{}",uuid::Uuid::new_v4()));
        let data = dir.join("profile"); let target = dir.join("separate");
        fs::create_dir_all(&data).unwrap(); fs::create_dir_all(&target).unwrap();
        atomic_json(&data.join("backup-destination.json"),&Destination { path: target.to_string_lossy().into(),protection:"local-or-unknown".into() }).unwrap();
        let c=Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap(); c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')",[]).unwrap();
        let root=root(&data).unwrap();
        for _ in 0..5 {
            let b=recovery::create(&c,&root).unwrap(); let mut m=b.manifest; m.created_at=recovery::now()-WEEK-10;
            fs::write(Path::new(&b.path).join("manifest.json"),serde_json::to_vec(&m).unwrap()).unwrap();
        }
        fs::create_dir(root.join("backup-incomplete")).unwrap();
        configure(&data,true,None).unwrap(); tick(&c,&data,recovery::now()).unwrap(); assert_eq!(recovery::list(&root).unwrap().0.len(),6);
        configure(&data,true,Some(3)).unwrap();
        let mut config=load(&data).unwrap(); config.last_success=None; atomic_json(&data.join("backup-schedule.json"),&config).unwrap();
        let result=tick(&c,&data,recovery::now()).unwrap(); assert!(result.error.is_none());
        assert_eq!(recovery::list(&root).unwrap().0.len(),3); assert!(root.join("backup-incomplete").exists());
        drop(c); fs::remove_dir_all(dir).unwrap();
    }
}
