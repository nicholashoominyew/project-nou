//! Sync through a shared folder such as OneDrive, by taking turns. NOU never merges two devices' notes. Each "Sync now" either saves this device's notes into the
//! folder as a new password-encrypted file, or, when another device has saved a newer one, lets the owner choose between using that copy (after saving this
//! device's notes into the folder first, so nothing is lost) and keeping this device's notes. The folder only ever holds encrypted files; the passphrase is
//! never stored. The live database is never placed in the folder: OneDrive would copy it half-written, so only finished, verified snapshots go there.
//!
//! File names carry a UTC time and a short device id, never a note title: `NOU-20261124-103000-3fa9c1d2.noubackup`. A copy saved just before this device
//! adopted another device's notes gets `-prev` and is only a safety copy; other devices never offer it as "newer".
use crate::{encrypted, recovery::{self, Verified}, schedule, Db};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, State};

/// How many of this device's own normal files stay in the folder, and how many "-prev" safety copies.
const KEEP_OWN: usize = 5;
const KEEP_PREV: usize = 3;
const PREFIX: &str = "NOU-";
const SUFFIX: &str = ".noubackup";

// ---- settings: <profile>/onedrive-sync.json ----
/// Local to this device (it is never put in the folder). `seen` holds the file names that were in the folder at the last sync, so "newer" does not depend on clocks.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Settings {
    #[serde(default)] pub folder: Option<String>,
    #[serde(default)] pub device_id: String,
    #[serde(default)] pub seen: Vec<String>,
    #[serde(default)] pub last_sync_at: Option<u64>,
    #[serde(default)] pub last_file: Option<String>,
}
fn settings_path(data: &Path) -> PathBuf { data.join("onedrive-sync.json") }
/// Read tolerantly: a missing or damaged file gives a new device id and no folder (nothing is deleted or overwritten until the owner saves a setting).
pub fn load(data: &Path) -> Settings {
    let mut s: Settings = fs::read_to_string(settings_path(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if s.device_id.len() != 8 || !s.device_id.bytes().all(|b| b.is_ascii_hexdigit()) { s.device_id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string(); }
    s
}
pub fn save(data: &Path, s: &Settings) -> Result<(), String> { schedule::atomic_json(&settings_path(data), s) }

// ---- file names ----
/// SQLite does the date arithmetic, so no date library is needed.
fn sql_text(sql: &str, arg: &str) -> Option<String> { Connection::open_in_memory().ok()?.query_row(sql, [arg], |r| r.get::<_, Option<String>>(0)).ok().flatten() }
/// `NOU-<UTC date>-<UTC time>-<device>[-prev].noubackup`
pub fn file_name(at: u64, device: &str, prev: bool) -> String {
    let stamp = sql_text("SELECT strftime('%Y%m%d-%H%M%S', CAST(?1 AS INTEGER), 'unixepoch')", &at.to_string()).unwrap_or_else(|| "00000000-000000".into());
    format!("{PREFIX}{stamp}-{device}{}{SUFFIX}", if prev { "-prev" } else { "" })
}
/// (time, device, is a safety copy) from a file name made by `file_name`; None for anything else.
pub fn parse_name(name: &str) -> Option<(u64, String, bool)> {
    let core = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let parts: Vec<&str> = core.split('-').collect();
    let (date, time, device, prev) = match parts.as_slice() { [d, t, v] => (*d, *t, *v, false), [d, t, v, "prev"] => (*d, *t, *v, true), _ => return None };
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(date, 8) || !digits(time, 6) || device.len() != 8 || !device.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    let text = format!("{}-{}-{} {}:{}:{}", &date[..4], &date[4..6], &date[6..], &time[..2], &time[2..4], &time[4..]);
    let at = sql_text("SELECT CAST(strftime('%s', ?1) AS TEXT)", &text)?.parse::<u64>().ok()?;
    Some((at, device.to_string(), prev))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SyncFile { pub name: String, pub at: u64, pub device: String, pub mine: bool, pub prev: bool, pub bytes: u64 }
/// The sync files in the folder, oldest first. Anything that is not a regular file with a name made by `file_name` (partial uploads, other files) is ignored.
pub fn list_files(folder: &Path, my_device: &str) -> Result<Vec<SyncFile>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(folder).map_err(|e| format!("The sync folder cannot be read: {e}"))? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((at, device, prev)) = parse_name(&name) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() { continue; }
        out.push(SyncFile { mine: device == my_device, name, at, device, prev, bytes: meta.len() });
    }
    out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}
/// The latest normal file from another device that was not in the folder at the last sync. Safety copies and this device's own files never count.
pub fn newer_than_seen(files: &[SyncFile], seen: &[String]) -> Option<SyncFile> {
    files.iter().filter(|f| !f.mine && !f.prev && !seen.contains(&f.name)).max_by(|a, b| a.at.cmp(&b.at).then_with(|| a.name.cmp(&b.name))).cloned()
}
/// The names of this device's own files that should be removed: all but the newest few of the same kind (normal files and safety copies are counted apart).
/// Another device's files are never in the list.
pub fn stale(files: &[SyncFile], prev: bool) -> Vec<String> {
    let keep = if prev { KEEP_PREV } else { KEEP_OWN };
    let mut mine: Vec<&SyncFile> = files.iter().filter(|f| f.mine && f.prev == prev).collect();
    mine.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.name.cmp(&a.name)));
    mine.into_iter().skip(keep).map(|f| f.name.clone()).collect()
}
/// True when `path` is inside one of the OneDrive folders (compared without regard to case or slash direction).
pub fn under_onedrive(path: &str, roots: &[String]) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_start_matches("//?/").trim_end_matches('/').to_lowercase();
    let p = norm(path);
    roots.iter().map(|r| norm(r)).any(|r| !r.is_empty() && (p == r || p.starts_with(&(r + "/"))))
}
fn onedrive_roots() -> Vec<String> { ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].iter().filter_map(|k| std::env::var(k).ok()).filter(|v| !v.is_empty()).collect() }

// ---- status ----
#[derive(Serialize, Debug)]
pub struct SyncStatus {
    pub folder: Option<String>, pub folder_ok: bool, pub in_onedrive: bool,
    /// This device's short id (it is in the names of its files).
    pub device: String, pub last_sync_at: Option<u64>,
    /// The latest files, newest first.
    pub files: Vec<SyncFile>,
    /// A newer copy saved by another device since this device last synced.
    pub newer: Option<SyncFile>,
    /// Pages edited on this device since the last sync (all pages when it has never synced). Notes only: other data is not counted.
    pub pages_changed: i64, pub pages: i64,
}
pub fn status(c: &Connection, data: &Path) -> Result<SyncStatus, String> {
    let s = load(data);
    let dir = s.folder.as_deref().map(PathBuf::from).filter(|p| p.is_dir());
    let files = match &dir { Some(d) => list_files(d, &s.device_id).unwrap_or_default(), None => vec![] };
    let newer = newer_than_seen(&files, &s.seen);
    let pages: i64 = c.query_row("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND system_key IS NULL", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let pages_changed: i64 = match s.last_sync_at {
        Some(at) => c.query_row("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND system_key IS NULL AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', ?1, 'unixepoch')", [at as i64], |r| r.get(0)).map_err(|e| e.to_string())?,
        None => pages,
    };
    let mut latest = files.clone(); latest.reverse(); latest.truncate(12);
    Ok(SyncStatus { in_onedrive: s.folder.as_deref().is_some_and(|f| under_onedrive(f, &onedrive_roots())), folder: s.folder, folder_ok: dir.is_some(), device: s.device_id, last_sync_at: s.last_sync_at, files: latest, newer, pages_changed, pages })
}

/// The sync folder itself (no subfolder is made inside it): it must exist and must not be NOU's own data folder, inside it, or around it.
fn checked_folder(folder: &Path, data: &Path) -> Result<PathBuf, String> {
    let root = folder.canonicalize().map_err(|e| format!("The sync folder is unavailable: {e}"))?;
    let app = data.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() || root.starts_with(&app) || app.starts_with(&root) { return Err("Choose a dedicated folder outside NOU's own data folder".into()); }
    Ok(root)
}
/// Choose the sync folder (it is created if it does not exist). Files already in it from other devices count as new.
pub fn set_folder(data: &Path, folder: &Path) -> Result<Settings, String> {
    if !folder.exists() { fs::create_dir_all(folder).map_err(|e| format!("The sync folder could not be created: {e}"))?; }
    let checked = checked_folder(folder, data)?;
    let mut s = load(data);
    s.folder = Some(checked.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    s.seen = vec![]; s.last_sync_at = None; s.last_file = None;
    save(data, &s)?;
    Ok(s)
}

// ---- saving this device's notes into the folder ----
#[derive(Serialize, Debug, PartialEq)]
pub struct Pushed { pub name: String, pub bytes: u64, pub removed: usize }
fn sync_dir(data: &Path, s: &Settings) -> Result<PathBuf, String> { checked_folder(Path::new(s.folder.as_deref().ok_or("Choose the sync folder first")?), data) }
/// Save this device's notes into the folder as a new encrypted file. The file is written next to the folder as `.partial` and renamed when complete, so another device (or OneDrive)
/// never sees half of it. With `record` the folder's file list is remembered as seen and the sync time is stored; a safety copy (`prev`) records nothing.
/// Unless `overwrite`, it refuses while another device has a newer copy that this device has not dealt with.
pub fn push(c: &Connection, data: &Path, password: String, overwrite: bool, prev: bool, now: u64) -> Result<Pushed, String> {
    let mut s = load(data);
    let dir = sync_dir(data, &s)?;
    let files = list_files(&dir, &s.device_id)?;
    if !overwrite && !prev {
        if let Some(n) = newer_than_seen(&files, &s.seen) { return Err(format!("Another device saved a newer copy ({}). Choose whether to use it or to keep this device's notes first.", n.name)); }
    }
    let name = file_name(now, &s.device_id, prev);
    let target = dir.join(&name);
    if target.exists() { return Err("A copy with this exact time already exists; wait a second and try again".into()); }
    let staging = data.join("sync-staging");
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let local = staging.join(format!("{}.noubackup", uuid::Uuid::new_v4()));
    let outcome = (|| -> Result<u64, String> {
        encrypted::export(c, data, &local, password)?; // encrypted, then decrypted again to check it
        let partial = dir.join(format!("{name}.partial"));
        let _ = fs::remove_file(&partial);
        fs::copy(&local, &partial).map_err(|e| format!("Could not write to the sync folder: {e}"))?;
        if recovery::hash_file(&partial)? != recovery::hash_file(&local)? { let _ = fs::remove_file(&partial); return Err("The copy in the sync folder did not match; nothing was saved there".into()); }
        let bytes = fs::metadata(&partial).map_err(|e| e.to_string())?.len();
        fs::rename(&partial, &target).map_err(|e| { let _ = fs::remove_file(&partial); format!("Could not finish the file in the sync folder: {e}") })?;
        Ok(bytes)
    })();
    let _ = fs::remove_file(&local);
    let bytes = outcome?;
    // Keep only a few of this device's own files; another device's files are never removed.
    let mut removed = 0;
    for old in stale(&list_files(&dir, &s.device_id)?, prev) { if fs::remove_file(dir.join(&old)).is_ok() { removed += 1; } }
    if !prev {
        s.seen = list_files(&dir, &s.device_id)?.into_iter().map(|f| f.name).collect();
        s.last_sync_at = Some(now); s.last_file = Some(name.clone());
        save(data, &s)?;
    }
    Ok(Pushed { name, bytes, removed })
}

// ---- using another device's copy ----
/// Check the password and the file, save this device's notes into the folder first as a safety copy, and return the verified staged backup. Nothing is replaced yet:
/// the owner reviews it and confirms in the normal restore screen. If the safety copy cannot be saved, nothing is staged.
pub fn stage_remote(c: &Connection, data: &Path, file: &str, password: String, now: u64) -> Result<Verified, String> {
    let s = load(data);
    let dir = sync_dir(data, &s)?;
    if file.contains(['/', '\\']) || parse_name(file).is_none() { return Err("That is not a NOU sync file".into()); }
    let path = dir.join(file);
    if !path.is_file() { return Err("That file is no longer in the sync folder. Check that OneDrive has finished syncing.".into()); }
    let backup = encrypted::stage(&path, data, password.clone())?;
    push(c, data, password, true, true, now).map_err(|e| format!("This device's notes could not be saved to the folder first, so nothing was changed: {e}"))?;
    Ok(backup)
}
/// Called after the owner has restored from `file`: this device is now up to date with everything in the folder.
pub fn mark_pulled(data: &Path, file: &str, now: u64) -> Result<Settings, String> {
    let mut s = load(data);
    let dir = sync_dir(data, &s)?;
    s.seen = list_files(&dir, &s.device_id)?.into_iter().map(|f| f.name).collect();
    s.last_sync_at = Some(now); s.last_file = Some(file.to_string());
    save(data, &s)?;
    Ok(s)
}

// ---- commands ----
fn data(app: &AppHandle) -> Result<PathBuf, String> { crate::data_dir(app.path()).map_err(|e| e.to_string()) }
/// A folder inside OneDrive to suggest ("NOU Sync"), when OneDrive is set up on this PC.
#[tauri::command]
pub fn sync_suggest_folder() -> Option<String> { onedrive_roots().into_iter().find(|r| Path::new(r).is_dir()).map(|r| Path::new(&r).join("NOU Sync").to_string_lossy().to_string()) }
#[tauri::command]
pub fn sync_status(app: AppHandle, db: State<'_, Db>) -> Result<SyncStatus, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    status(&c, &data(&app)?)
}
#[tauri::command]
pub fn sync_set_folder(app: AppHandle, db: State<'_, Db>, path: String) -> Result<SyncStatus, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let d = data(&app)?;
    set_folder(&d, Path::new(&path))?;
    status(&c, &d)
}
#[tauri::command]
pub async fn sync_push(app: AppHandle, password: String, overwrite: bool) -> Result<Pushed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        db.writable()?;
        let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
        push(&c, &data(&app)?, password, overwrite, false, recovery::now())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sync_prepare_pull(app: AppHandle, file: String, password: String) -> Result<crate::recovery_commands::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        db.writable()?;
        let backup = { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; stage_remote(&c, &data(&app)?, &file, password, recovery::now())? };
        crate::recovery_commands::stage_preview(&app, backup)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn sync_mark_pulled(app: AppHandle, db: State<'_, Db>, file: String) -> Result<SyncStatus, String> {
    let d = data(&app)?;
    mark_pulled(&d, &file, recovery::now())?;
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    status(&c, &d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    const PASS: &str = "a long shared passphrase";

    fn tmp(label: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("nou-sync-test-{}-{}-{label}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d); fs::create_dir_all(&d).unwrap(); d
    }
    fn fresh(pages: &[&str]) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        for (i, t) in pages.iter().enumerate() { c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES(?1,'personal',?2,?3)", rusqlite::params![format!("p{i}"), t, format!("{i:03}")]).unwrap(); }
        c
    }
    /// One "device": its own profile folder, its own notes, and the shared sync folder.
    struct Device { data: PathBuf, db: Connection }
    fn device(label: &str, pages: &[&str], shared: &Path) -> Device {
        let data = tmp(label); let db = fresh(pages);
        set_folder(&data, shared).unwrap();
        Device { data, db }
    }
    impl Device { fn id(&self) -> String { load(&self.data).device_id } }

    #[test]
    fn names_carry_a_utc_time_and_a_device_and_nothing_else_parses() {
        let n = file_name(1_700_000_000, "3fa9c1d2", false);
        assert_eq!(n, "NOU-20231114-221320-3fa9c1d2.noubackup");
        assert_eq!(parse_name(&n), Some((1_700_000_000, "3fa9c1d2".into(), false)));
        let p = file_name(1_700_000_000, "3fa9c1d2", true); assert_eq!(p, "NOU-20231114-221320-3fa9c1d2-prev.noubackup"); assert_eq!(parse_name(&p), Some((1_700_000_000, "3fa9c1d2".into(), true)));
        for bad in ["", "notes.noubackup", "NOU-20231114-221320-3fa9c1d2.noubackup.partial", "NOU-20231114-221320-3fa9c1d2.zip", "NOU-2023114-221320-3fa9c1d2.noubackup", "NOU-20231114-221320-zzzzzzzz.noubackup", "NOU-20231114-221320-3fa9c1d2-old.noubackup", "NOU-20231314-221320-3fa9c1d2.noubackup", "NOU-20231114-221320-3fa9c1d2-prev-x.noubackup", "x/NOU-20231114-221320-3fa9c1d2.noubackup"] { assert_eq!(parse_name(bad), None, "{bad}"); }
        assert!(file_name(1, "3fa9c1d2", false) < file_name(2_000_000_000, "3fa9c1d2", false), "names sort by time");
    }

    #[test]
    fn only_real_sync_files_are_listed_and_newer_means_another_device_not_yet_seen() {
        let dir = tmp("list");
        for n in ["NOU-20261124-100000-aaaaaaaa.noubackup", "NOU-20261124-110000-bbbbbbbb.noubackup", "NOU-20261124-120000-bbbbbbbb-prev.noubackup", "NOU-20261124-090000-bbbbbbbb.noubackup.partial", "readme.txt", "NOU-20261124-130000-cccccccc.noubackup"] { fs::write(dir.join(n), b"x").unwrap(); }
        fs::create_dir_all(dir.join("NOU-20261124-140000-dddddddd.noubackup")).unwrap(); // a folder with a matching name is not a file
        let files = list_files(&dir, "aaaaaaaa").unwrap();
        assert_eq!(files.iter().map(|f| (f.name.as_str(), f.mine, f.prev)).collect::<Vec<_>>(), vec![("NOU-20261124-100000-aaaaaaaa.noubackup", true, false), ("NOU-20261124-110000-bbbbbbbb.noubackup", false, false), ("NOU-20261124-120000-bbbbbbbb-prev.noubackup", false, true), ("NOU-20261124-130000-cccccccc.noubackup", false, false)]);
        assert_eq!(newer_than_seen(&files, &[]).unwrap().name, "NOU-20261124-130000-cccccccc.noubackup", "the latest unseen file of another device; a safety copy never counts");
        assert_eq!(newer_than_seen(&files, &["NOU-20261124-130000-cccccccc.noubackup".into()]).unwrap().name, "NOU-20261124-110000-bbbbbbbb.noubackup");
        assert_eq!(newer_than_seen(&files, &["NOU-20261124-130000-cccccccc.noubackup".into(), "NOU-20261124-110000-bbbbbbbb.noubackup".into()]), None, "my own files and safety copies are not newer");
        assert!(list_files(&dir.join("missing"), "x").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn onedrive_is_recognised_by_its_folder_whatever_the_case_or_slashes() {
        let roots = vec![r"C:\Users\nicho\OneDrive".to_string()];
        assert!(under_onedrive(r"c:\users\NICHO\onedrive\NOU Sync", &roots) && under_onedrive(r"\\?\C:\Users\nicho\OneDrive\NOU Sync\", &roots) && under_onedrive(r"C:\Users\nicho\OneDrive", &roots));
        assert!(!under_onedrive(r"C:\Users\nicho\OneDrive2\x", &roots) && !under_onedrive(r"C:\Users\nicho\Documents", &roots) && !under_onedrive("C:/x", &[]) && !under_onedrive("C:/x", &[String::new()]));
    }

    #[test]
    fn settings_are_tolerant_and_hold_no_passphrase_and_the_folder_must_be_outside_the_data_folder() {
        let data = tmp("settings"); let shared = tmp("settings-shared");
        let fresh_settings = load(&data); assert_eq!(fresh_settings.device_id.len(), 8); assert_eq!(fresh_settings.folder, None);
        fs::write(settings_path(&data), "{ damaged").unwrap(); assert_eq!(load(&data).folder, None);
        assert!(set_folder(&data, &data).is_err() && set_folder(&data, &data.join("inside")).is_err(), "not inside NOU's own folder");
        let s = set_folder(&data, &shared).unwrap();
        assert_eq!(load(&data).folder, s.folder); assert_eq!(load(&data).device_id, s.device_id, "the device id is kept");
        let created = shared.join("new folder"); set_folder(&data, &created).unwrap(); assert!(created.is_dir(), "a missing folder is created");
        let text = fs::read_to_string(settings_path(&data)).unwrap(); assert!(!text.to_lowercase().contains("pass"));
        for d in [data, shared] { fs::remove_dir_all(d).unwrap(); }
    }

    #[test]
    fn two_devices_take_turns_and_nothing_is_replaced_without_a_choice() {
        let shared = tmp("shared");
        let a = device("A", &["Alpha", "Beta", "Gamma"], &shared); let b = device("B", &["Only on B"], &shared);
        assert_ne!(a.id(), b.id());
        // A has never synced: everything counts as changed, nothing is newer.
        let st = status(&a.db, &a.data).unwrap(); assert_eq!((st.pages, st.pages_changed, st.newer.is_none(), st.last_sync_at), (3, 3, true, None));
        // A saves. The file is encrypted, named without titles, and no partial file is left.
        let pushed = push(&a.db, &a.data, PASS.into(), false, false, 1_800_000_000).unwrap();
        assert_eq!(pushed.name, file_name(1_800_000_000, &a.id(), false));
        let listing: Vec<String> = fs::read_dir(&shared).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect(); assert_eq!(listing, vec![pushed.name.clone()]);
        let raw = fs::read(shared.join(&pushed.name)).unwrap(); assert!(raw.starts_with(b"NOUENC02") && !String::from_utf8_lossy(&raw).contains("Alpha"), "only ciphertext is in the folder");
        let st = status(&a.db, &a.data).unwrap(); assert_eq!((st.pages_changed, st.newer.is_none(), st.last_sync_at), (0, true, Some(1_800_000_000)), "A is up to date with its own file");
        // B sees A's copy as newer, and a plain save is refused until B chooses.
        let st = status(&b.db, &b.data).unwrap(); assert_eq!(st.newer.as_ref().map(|f| f.name.clone()), Some(pushed.name.clone()));
        assert!(push(&b.db, &b.data, PASS.into(), false, false, 1_800_000_100).unwrap_err().contains("newer copy"));
        assert_eq!(list_files(&shared, &b.id()).unwrap().len(), 1, "the refused save wrote nothing");
        // A wrong passphrase stages nothing and saves nothing.
        assert!(stage_remote(&b.db, &b.data, &pushed.name, "a different passphrase".into(), 1_800_000_200).is_err());
        assert_eq!(list_files(&shared, &b.id()).unwrap().len(), 1);
        // Using A's copy: B's own notes are saved into the folder first as a safety copy, and A's notes are staged for review.
        let staged = stage_remote(&b.db, &b.data, &pushed.name, PASS.into(), 1_800_000_300).unwrap();
        assert_eq!(staged.pages, a.db.query_row::<i64, _, _>("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap(), "the package holds all of A's pages (the built-in timetable page included)");
        let files = list_files(&shared, &b.id()).unwrap(); let safety = files.iter().find(|f| f.mine && f.prev).expect("a safety copy of B's notes");
        assert_eq!(safety.name, file_name(1_800_000_300, &b.id(), true));
        assert!(status(&b.db, &b.data).unwrap().newer.is_some(), "until B really restores, A's copy is still offered");
        // After the restore B is up to date; A is not shown B's safety copy as newer.
        mark_pulled(&b.data, &pushed.name, 1_800_000_400).unwrap();
        assert!(status(&b.db, &b.data).unwrap().newer.is_none()); assert_eq!(load(&b.data).last_file.as_deref(), Some(pushed.name.as_str()));
        assert!(status(&a.db, &a.data).unwrap().newer.is_none(), "a safety copy is never offered as newer");
        // B edits and saves; now A sees B's normal file as newer.
        let b2 = push(&b.db, &b.data, PASS.into(), false, false, 1_800_000_500).unwrap();
        assert_eq!(status(&a.db, &a.data).unwrap().newer.map(|f| f.name), Some(b2.name.clone()));
        // A may keep its own notes and save anyway; B's file stays in the folder as a version.
        push(&a.db, &a.data, PASS.into(), true, false, 1_800_000_600).unwrap();
        assert!(list_files(&shared, &a.id()).unwrap().iter().any(|f| f.name == b2.name));
        assert!(status(&a.db, &a.data).unwrap().newer.is_none());
        for d in [a.data, b.data, shared] { fs::remove_dir_all(d).unwrap(); }
    }

    #[test]
    fn a_device_keeps_a_few_of_its_own_files_and_never_removes_another_devices() {
        let f = |at: u64, dev: &str, prev: bool| SyncFile { name: file_name(at, dev, prev), at, device: dev.into(), mine: dev == "aaaaaaaa", prev, bytes: 1 };
        let mut files: Vec<SyncFile> = (1..=7).map(|i| f(i * 100, "aaaaaaaa", false)).chain((1..=5).map(|i| f(i * 100, "aaaaaaaa", true))).chain((1..=9).map(|i| f(i * 100, "bbbbbbbb", false))).collect();
        files.sort_by_key(|x| x.at);
        let normal = stale(&files, false); let safety = stale(&files, true);
        assert_eq!(normal, vec![file_name(200, "aaaaaaaa", false), file_name(100, "aaaaaaaa", false)], "all but the newest five of A's normal files");
        assert_eq!(safety, vec![file_name(200, "aaaaaaaa", true), file_name(100, "aaaaaaaa", true)], "all but the newest three safety copies, counted apart");
        assert!(normal.iter().chain(&safety).all(|n| !n.contains("bbbbbbbb")), "another device's files are never listed");
        assert!(stale(&files[..3], false).is_empty());
        // And for real: files made earlier are removed by a real save, a safety copy only trims safety copies, and the other device's files stay.
        let shared = tmp("prune"); let a = device("prune-A", &["A1"], &shared); let id = a.id();
        for i in 1..=7u64 { fs::write(shared.join(file_name(1_700_000_000 + i * 100, &id, false)), b"old").unwrap(); }
        for i in 1..=5u64 { fs::write(shared.join(file_name(1_700_000_000 + i * 100, &id, true)), b"old").unwrap(); }
        for i in 1..=4u64 { fs::write(shared.join(file_name(1_700_000_000 + i * 100, "bbbbbbbb", false)), b"theirs").unwrap(); }
        let pushed = push(&a.db, &a.data, PASS.into(), true, false, 1_800_000_000).unwrap();
        assert_eq!(pushed.removed, 3, "8 normal files of A, the newest 5 stay");
        let count = |prev: bool, mine: bool| list_files(&shared, &id).unwrap().iter().filter(|x| x.mine == mine && x.prev == prev).count();
        assert_eq!((count(false, true), count(true, true), count(false, false)), (KEEP_OWN, 5, 4), "safety copies and the other device's files were not touched");
        assert_eq!(push(&a.db, &a.data, PASS.into(), true, true, 1_800_000_100).unwrap().removed, 3);
        assert_eq!((count(false, true), count(true, true), count(false, false)), (KEEP_OWN, KEEP_PREV, 4));
        for d in [a.data, shared] { fs::remove_dir_all(d).unwrap(); }
    }
    #[test]
    fn it_refuses_a_bad_file_name_a_missing_file_a_weak_passphrase_and_a_missing_folder() {
        let shared = tmp("refuse"); let a = device("refuse-A", &["A1"], &shared);
        for bad in ["../x.noubackup", "..\\x.noubackup", "notes.noubackup", "NOU-20261124-100000-aaaaaaaa.noubackup"] { assert!(stage_remote(&a.db, &a.data, bad, PASS.into(), 1).is_err(), "{bad}"); }
        assert!(push(&a.db, &a.data, "short".into(), true, false, 1_800_000_000).unwrap_err().contains("12 characters"));
        assert!(list_files(&shared, &a.id()).unwrap().is_empty(), "a refused save leaves nothing behind");
        assert!(!a.data.join("sync-staging").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false), "no temporary copy is left in the profile either");
        let other = tmp("no-folder"); assert!(push(&a.db, &other, PASS.into(), false, false, 1).unwrap_err().contains("Choose the sync folder"));
        for d in [a.data, shared, other] { fs::remove_dir_all(d).unwrap(); }
    }
}
