//! User-selected text exports and additive, transactional single-note recovery.
use crate::{editor, key_for_position, rebalance, Db, Page};
use rusqlite::params;
use std::{fs, io::{Read, Write}, path::Path};
use tauri::State;
const MAX_IMPORT: u64 = 40 * 1024 * 1024;
#[tauri::command]
pub fn read_note_import(path: String) -> Result<String, String> {
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Choose a regular recovery JSON file".into()); }
    let mut data = String::new();
    Read::by_ref(&mut file).take(MAX_IMPORT + 1).read_to_string(&mut data).map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_IMPORT { return Err("Recovery JSON exceeds 40 MB".into()); }
    Ok(data)
}
#[tauri::command]
pub fn write_note_export(path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_IMPORT { return Err("Export exceeds 40 MB".into()); }
    if !matches!(Path::new(&path).extension().and_then(|x| x.to_str()), Some("txt" | "md" | "html" | "json")) {
        return Err("Choose a .txt, .md, .html or .json filename".into());
    }
    write_new(Path::new(&path), content.as_bytes())
}
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new().create_new(true).write(true).open(path).map_err(|e| format!("Choose a new filename; existing files are never overwritten: {e}"))?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string());
    drop(file);
    if result.is_err() { let _ = fs::remove_file(path); }
    result
}
#[tauri::command]
pub fn import_note(db: State<'_, Db>, title: String, update: Vec<u8>, plain_text: String, format: String, legacy_text: Option<String>) -> Result<Page, String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    import(&mut c, &title, &update, &plain_text, &format, legacy_text.as_deref())
}
pub fn import(c: &mut rusqlite::Connection, title: &str, update: &[u8], text: &str, format: &str, legacy: Option<&str>) -> Result<Page, String> {
    if !["text-v1", "blocknote-v1"].contains(&format) || update.is_empty() || update.len() > 8*1024*1024 || text.len() > 5_000_000 || legacy.is_some_and(|s| s.len() > 5_000_000) || title.len() > 1000 {
        return Err("Unsupported recovery format or note size".into());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let title = if title.trim().is_empty() { "Recovered note" } else { title.trim() };
    let key = key_for_position(&tx, None, usize::MAX, None)?;
    tx.execute("INSERT INTO pages(id,workspace_id,parent_id,title,sort_key) VALUES (?1,'personal',NULL,?2,?3)", params![id,title,key]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO note_locations(page_id) VALUES (?1)", [&id]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO page_search(page_id,title,body) VALUES (?1,?2,?3)", params![id,title,text]).map_err(|e| e.to_string())?;
    if format == "blocknote-v1" {
        editor::initialize_rich(&tx, &id, update)?;
        tx.execute("UPDATE note_formats SET legacy_text=?1 WHERE page_id=?2", params![legacy.unwrap_or(""),id]).map_err(|e| e.to_string())?;
    } else {
        tx.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?1,1,?2)", params![id,update]).map_err(|e| e.to_string())?;
    }
    rebalance(&tx, None)?;
    let sort_key = tx.query_row("SELECT sort_key FROM pages WHERE id=?1", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Page { id, title: title.into(), parent_id: None, sort_key })
}
