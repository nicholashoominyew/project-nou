//! App preferences that live in the window (theme, Home layout, reminders, places...) copied into the database so a sync or a backup carries them too.
//! The page decides which preferences are shared and sends them before a sync; after another device's copy is restored it reads them back. Nothing here is a secret.
use crate::Db;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_ENTRIES: usize = 60;
const MAX_VALUE: usize = 60_000;
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Entry { pub key: String, pub value: String }

/// Replace every stored preference with `entries`.
pub fn save(c: &mut Connection, entries: &[Entry]) -> Result<usize, String> {
    if entries.len() > MAX_ENTRIES { return Err("Too many settings".into()); }
    for e in entries { if !e.key.starts_with("nou-") || e.key.len() < 5 || e.key.len() > 100 || e.value.len() > MAX_VALUE { return Err(format!("Setting “{}” is not valid", e.key.chars().take(40).collect::<String>())); } }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM app_settings", []).map_err(|e| e.to_string())?;
    for e in entries { tx.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?1,?2)", params![e.key, e.value]).map_err(|e| e.to_string())?; }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entries.len())
}
pub fn get(c: &Connection) -> Result<Vec<Entry>, String> {
    let mut s = c.prepare("SELECT key,value FROM app_settings ORDER BY key").map_err(|e| e.to_string())?;
    let rows = s.query_map([], |r| Ok(Entry { key: r.get(0)?, value: r.get(1)? })).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string());
    rows
}
#[tauri::command]
pub fn app_settings_save_cmd(db: State<'_, Db>, entries: Vec<Entry>) -> Result<usize, String> { let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; save(&mut c, &entries) }
#[tauri::command]
pub fn app_settings_get_cmd(db: State<'_, Db>) -> Result<Vec<Entry>, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; get(&c) }

#[cfg(test)]
mod tests {
    use super::*;
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap(); c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap(); c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap(); c
    }
    fn e(k: &str, v: &str) -> Entry { Entry { key: k.into(), value: v.into() } }
    #[test]
    fn preferences_are_replaced_as_a_whole_and_bad_ones_are_refused() {
        let mut c = fresh();
        assert_eq!(save(&mut c, &[e("nou-theme", "\"dark\""), e("nou-home-layout", "{}")]).unwrap(), 2);
        assert_eq!(get(&c).unwrap(), vec![e("nou-home-layout", "{}"), e("nou-theme", "\"dark\"")]);
        save(&mut c, &[e("nou-theme", "\"light\"")]).unwrap(); assert_eq!(get(&c).unwrap(), vec![e("nou-theme", "\"light\"")], "what was not sent is gone");
        for bad in [e("theme", "x"), e("nou-", "x"), e(&format!("nou-{}", "k".repeat(100)), "x"), e("nou-big", &"v".repeat(MAX_VALUE + 1))] { assert!(save(&mut c, &[bad]).is_err()); }
        assert!(save(&mut c, &(0..61).map(|i| e(&format!("nou-k{i}"), "x")).collect::<Vec<_>>()).is_err());
        assert_eq!(get(&c).unwrap(), vec![e("nou-theme", "\"light\"")], "a refused save changes nothing");
    }
}
