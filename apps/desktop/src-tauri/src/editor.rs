use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const MIGRATION: &str = include_str!("../../../../db/notes/002_editor_formats.sql");
pub fn upgrade(c: &Connection) -> Result<(), String> {
    let v: i64 = c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    match v { 1 => c.execute_batch(MIGRATION).map_err(|e| e.to_string()), 2 => Ok(()), _ => Err(format!("Unsupported Notes schema: {v}")) }
}
#[derive(Serialize)]
pub struct Note {
    pub updates: Vec<Vec<u8>>,
    pub format: String,
    pub legacy_text: Option<String>,
    pub seq: i64,
    pub epoch: u64,
}
pub fn load(c: &Connection, page: &str, epoch: u64) -> Result<Note, String> {
    let active: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL)", [page], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !active { return Err("Note not found".into()); }
    let format: Option<(String, String)> = c.query_row("SELECT format,legacy_text FROM note_formats WHERE page_id=?1", [page], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e| e.to_string())?;
    let mut updates = Vec::new();
    if let Some(snapshot) = c.query_row("SELECT snapshot_bytes FROM yjs_snapshots WHERE page_id=?1", [page], |r| r.get::<_, Vec<u8>>(0)).optional().map_err(|e| e.to_string())? { updates.push(snapshot); }
    let mut stmt = c.prepare("SELECT update_bytes FROM yjs_updates WHERE page_id=?1 ORDER BY seq").map_err(|e| e.to_string())?;
    updates.extend(stmt.query_map([page], |r| r.get::<_,Vec<u8>>(0)).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?);
    let seq = c.query_row("SELECT COALESCE(MAX(seq),0) FROM yjs_updates WHERE page_id=?1", [page], |r| r.get(0)).map_err(|e| e.to_string())?;
    let (format, legacy_text) = match format { Some((f,t)) => (f,Some(t)), None => ("text-v1".into(),None) };
    Ok(Note { updates, format, legacy_text, seq, epoch })
}
pub fn append(c: &mut Connection, page: &str, update: &[u8], text: &str, format: &str, migration: Option<(i64, &str)>) -> Result<i64, String> {
    if update.is_empty() || update.len() > 8 * 1024 * 1024 || text.len() > 5_000_000 { return Err("Note exceeds the supported save size; copy your content before leaving".into()); }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let title: String = tx.query_row("SELECT title FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL", [page], |r| r.get(0)).map_err(|e| e.to_string())?;
    let current: String = tx.query_row("SELECT format FROM note_formats WHERE page_id=?1", [page], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or("text-v1".into());
    let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0) FROM yjs_updates WHERE page_id=?1", [page], |r| r.get(0)).map_err(|e| e.to_string())?;
    if let Some((expected, original)) = migration {
        if current != "text-v1" || format != "blocknote-v1" || expected != seq { return Err("Note changed or was already converted. Reopen it before converting".into()); }
        if original.len() > 5_000_000 { return Err("Legacy note too large".into()); }
        tx.execute("INSERT INTO note_formats(page_id,format,legacy_text) VALUES (?1,'blocknote-v1',?2)", params![page,original]).map_err(|e| e.to_string())?;
    } else if current != format { return Err("Editor format changed; reopen this note".into()); }
    tx.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?1,?2,?3)", params![page,seq+1,update]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM page_search WHERE page_id=?1", [page]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO page_search(page_id,title,body) VALUES (?1,?2,?3)", params![page,title,text]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE pages SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [page]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(seq+1)
}
