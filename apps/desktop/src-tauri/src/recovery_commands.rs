use crate::{editor, recovery::{self, RestoreRecord, RetentionPlan, Verified}, Db};
use serde::Serialize;
pub use crate::schedule::Destination;
use std::{path::{Path, PathBuf}, sync::{Mutex, atomic::Ordering}};
use tauri::{Manager, State};

#[derive(Default)]
pub struct RecoveryState(Mutex<Plans>);
#[derive(Default)]
struct Plans {
    staged: Option<(String, Verified)>,
    retention: Option<(PathBuf, RetentionPlan)>,
}
#[derive(Serialize)]
pub struct Status { destination: Option<Destination>, interrupted: Vec<RestoreRecord>, rollback: Vec<Verified> }
#[derive(Serialize)]
pub struct Preview { token: String, backup: Verified }
fn folder(app: &tauri::AppHandle) -> Result<PathBuf, String> { app.path().app_data_dir().map_err(|e| e.to_string()) }
fn settings(app: &tauri::AppHandle) -> Result<Option<Destination>, String> {
    crate::schedule::destination(&folder(app)?)
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let chosen = settings(app)?.ok_or("Choose a backup destination first")?;
    recovery::destination(Path::new(&chosen.path), &folder(app)?)
}
#[tauri::command]
pub fn backup_status(app: tauri::AppHandle) -> Result<Status, String> {
    let data = folder(&app)?;
    let mut rollback = Vec::new();
    for name in ["rollback", "schema-rollback", "editor-rollback"] {
        if data.join(name).exists() { rollback.extend(recovery::list(&data.join(name))?.0); }
    }
    rollback.sort_by(|a,b| b.manifest.created_at.cmp(&a.manifest.created_at));
    Ok(Status { destination: settings(&app)?, interrupted: recovery::unresolved(&data)?, rollback })
}
#[tauri::command]
pub fn set_backup_destination(app: tauri::AppHandle, state: State<'_, RecoveryState>, db: State<'_, Db>, path: String, protection: String) -> Result<Destination, String> {
    let _guard = db.0.lock().map_err(|_| "Database lock poisoned")?;
    if !["local-or-unknown", "external-user-declared", "remote-user-declared"].contains(&protection.as_str()) { return Err("Choose the destination protection description".into()); }
    recovery::destination(Path::new(&path), &folder(&app)?)?;
    let chosen = Destination { path, protection };
    crate::schedule::atomic_json(&folder(&app)?.join("backup-destination.json"), &chosen)?;
    state.0.lock().map_err(|_| "Recovery lock poisoned")?.retention = None;
    Ok(chosen)
}
#[tauri::command]
pub fn create_backup(app: tauri::AppHandle, db: State<'_, Db>) -> Result<Verified, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let backup = recovery::create(&c, &root(&app)?)?;
    crate::schedule::record_success(&folder(&app)?, &backup, recovery::now())?;
    Ok(backup)
}
#[tauri::command]
pub fn list_backups(app: tauri::AppHandle) -> Result<(Vec<Verified>, usize), String> { recovery::list(&root(&app)?) }
#[tauri::command]
pub fn prepare_restore(app: tauri::AppHandle, state: State<'_, RecoveryState>, path: String) -> Result<Preview, String> {
    let backup = recovery::stage(Path::new(&path), &folder(&app)?)?;
    let token = uuid::Uuid::new_v4().to_string();
    state.0.lock().map_err(|_| "Recovery lock poisoned")?.staged = Some((token.clone(), backup.clone()));
    Ok(Preview { token, backup })
}
#[tauri::command]
pub fn prepare_legacy_restore(app: tauri::AppHandle, state: State<'_, RecoveryState>, path: String) -> Result<Preview, String> {
    let backup = recovery::import_snapshot(Path::new(&path), &folder(&app)?)?;
    let token = uuid::Uuid::new_v4().to_string();
    state.0.lock().map_err(|_| "Recovery lock poisoned")?.staged = Some((token.clone(), backup.clone()));
    Ok(Preview { token, backup })
}
#[tauri::command]
pub fn execute_restore(app: tauri::AppHandle, db: State<'_, Db>, state: State<'_, RecoveryState>, token: String, confirmation: String) -> Result<RestoreRecord, String> {
    if confirmation != "RESTORE" { return Err("Type RESTORE to confirm replacing all current notes".into()); }
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let mut plans = state.0.lock().map_err(|_| "Recovery lock poisoned")?;
    let (expected, staged) = plans.staged.take().ok_or("Prepare and review a restore first")?;
    if token != expected { return Err("Restore preview expired; select the backup again".into()); }
    db.2.store(true, Ordering::SeqCst);
    // Reject any queued save created before the restore, including on failure.
    db.1.fetch_add(1, Ordering::SeqCst);
    let result = recovery::restore(&mut c, &staged, &folder(&app)?);
    match result {
        Ok(record) => {
            editor::upgrade(&c)?;
            let pending = !recovery::unresolved(&folder(&app)?)?.is_empty();
            db.2.store(pending, Ordering::SeqCst);
            Ok(record)
        },
        Err(error) => {
            // Before intent publication nothing changed. Afterwards keep the write barrier.
            db.2.store(!recovery::unresolved(&folder(&app)?)?.is_empty(), Ordering::SeqCst);
            Err(error)
        }
    }
}
#[tauri::command]
pub fn preview_retention(app: tauri::AppHandle, state: State<'_, RecoveryState>, keep: usize) -> Result<RetentionPlan, String> {
    let root = root(&app)?;
    let plan = recovery::retention(&root, keep, recovery::now())?;
    state.0.lock().map_err(|_| "Recovery lock poisoned")?.retention = Some((root, plan.clone()));
    Ok(plan)
}
#[tauri::command]
pub fn apply_retention(state: State<'_, RecoveryState>, token: String, confirmation: String) -> Result<usize, String> {
    if confirmation != "DELETE OLD BACKUPS" { return Err("Confirm the exact retention preview first".into()); }
    let (root, plan) = state.0.lock().map_err(|_| "Recovery lock poisoned")?.retention.take().ok_or("Preview retention first")?;
    if token != plan.token { return Err("Retention preview expired".into()); }
    recovery::prune(&root, &plan)
}
#[tauri::command]
pub fn review_restore(app: tauri::AppHandle, db: State<'_, Db>, confirmation: String) -> Result<(), String> {
    if confirmation != "KEEP CURRENT DATABASE" { return Err("Confirm review of the current notes first".into()); }
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let data = folder(&app)?;
    // A fresh verified snapshot also checks the complete live schema before permitting edits.
    recovery::create(&c, &data.join("rollback"))?;
    for record in recovery::unresolved(&data)? {
        recovery::write_new_json(&data.join("restore-journal").join(format!("{}.reviewed.json", record.id)), &record)?;
    }
    db.2.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn backup_schedule_status(app: tauri::AppHandle) -> Result<crate::schedule::Schedule, String> {
    crate::schedule::load(&folder(&app)?)
}
#[tauri::command]
pub fn configure_backup_schedule(app: tauri::AppHandle, db: State<'_, Db>, enabled: bool, auto_keep: Option<usize>) -> Result<crate::schedule::Schedule, String> {
    let _guard = db.0.lock().map_err(|_| "Database lock poisoned")?;
    crate::schedule::configure(&folder(&app)?, enabled, auto_keep)
}

#[tauri::command]
pub async fn create_encrypted_backup(app: tauri::AppHandle, path: String, password: String) -> Result<crate::encrypted::Export, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
        crate::encrypted::export(&c, &folder(&app)?, Path::new(&path), password)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn prepare_encrypted_restore(app: tauri::AppHandle, path: String, password: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backup = crate::encrypted::stage(Path::new(&path), &folder(&app)?, password)?;
        let token = uuid::Uuid::new_v4().to_string();
        app.state::<RecoveryState>().0.lock().map_err(|_| "Recovery lock poisoned")?.staged = Some((token.clone(), backup.clone()));
        Ok(Preview { token, backup })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn reset_backup_schedule(app: tauri::AppHandle, db: State<'_, Db>) -> Result<crate::schedule::Schedule, String> {
    let _guard = db.0.lock().map_err(|_| "Database lock poisoned")?;
    crate::schedule::reset(&folder(&app)?)
}
