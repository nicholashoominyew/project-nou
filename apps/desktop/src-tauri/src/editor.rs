use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const MIGRATION: &str = include_str!("../../../../db/notes/002_editor_formats.sql");
/// Part of the page-creation transaction: never leave a format marker without its initial state.
pub fn initialize_rich(tx: &rusqlite::Transaction<'_>, page: &str, update: &[u8]) -> Result<(), String> {
    if update.is_empty() || update.len() > 8 * 1024 * 1024 { return Err("Invalid initial rich-text state".into()); }
    tx.execute("INSERT INTO note_formats(page_id,format,legacy_text) VALUES (?1,'blocknote-v1','')", [page]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO yjs_updates(page_id,seq,update_bytes) VALUES (?1,1,?2)", params![page,update]).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn upgrade(c: &Connection) -> Result<(), String> {
    let v: i64 = c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    match v { 1 => { c.execute_batch(MIGRATION).map_err(|e| e.to_string())?; upgrade(c) }, 2 => { c.execute_batch(include_str!("../../../../db/notes/003_page_icons.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 3 => { c.execute_batch(include_str!("../../../../db/notes/004_databases.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 4 => { c.execute_batch(include_str!("../../../../db/notes/005_page_links.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 5 => { c.execute_batch(include_str!("../../../../db/notes/006_gateway.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 6 => { c.execute_batch(include_str!("../../../../db/notes/007_linked_todos.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 7 => { c.execute_batch(include_str!("../../../../db/notes/008_page_locks.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 8 => { c.execute_batch(include_str!("../../../../db/notes/009_bot_chat.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 9 => { c.execute_batch(include_str!("../../../../db/notes/010_life_timetable.sql")).map_err(|e| e.to_string())?; upgrade(c) }, 10 => { c.execute_batch(include_str!("../../../../db/notes/011_timetable_variants.sql")).map_err(|e| e.to_string())?; crate::timetable::migrate_saturday_split(c)?; upgrade(c) }, 11 => { crate::timetable::ensure_system_page(c)?; crate::timetable::seed(c).map(|_| ()) }, _ => Err(format!("Unsupported Notes schema: {v}")) }
}
#[derive(Serialize, Debug)]
pub struct Note {
    pub updates: Vec<Vec<u8>>,
    pub format: String,
    pub legacy_text: Option<String>,
    pub seq: i64,
    pub epoch: u64,
}
/// For notes that are not locked. A locked note's stored bytes are ciphertext, so this refuses; see `locks::load`.
pub fn load(c: &Connection, page: &str, epoch: u64) -> Result<Note, String> {
    if crate::locks::is_locked(c, page)? { return Err(crate::locks::LOCKED.into()); }
    load_raw(c, page, epoch)
}
/// The stored bytes exactly as they are (ciphertext for a locked note).
pub fn load_raw(c: &Connection, page: &str, epoch: u64) -> Result<Note, String> {
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
pub fn append(c: &mut Connection,page:&str,update:&[u8],text:&str,format:&str,migration:Option<(i64,&str)>)->Result<i64,String>{append_with_files(c,page,update,text,format,migration,None)}
pub fn append_with_files(c: &mut Connection, page: &str, update: &[u8], text: &str, format: &str, migration: Option<(i64, &str)>, files:Option<&[String]>) -> Result<i64, String> {
    if update.is_empty() || update.len() > 8 * 1024 * 1024 || text.len() > 5_000_000 { return Err("Note exceeds the supported save size; copy your content before leaving".into()); }
    if crate::locks::is_locked(c, page)? { return Err(crate::locks::LOCKED.into()); }
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
    if let Some(files)=files{tx.execute("DELETE FROM note_files WHERE page_id=?1",[page]).map_err(|e|e.to_string())?;for id in files{tx.execute("INSERT OR IGNORE INTO note_files(page_id,file_id) VALUES(?1,?2)",params![page,id]).map_err(|e|e.to_string())?;}}
    tx.commit().map_err(|e| e.to_string())?;
    Ok(seq+1)
}
