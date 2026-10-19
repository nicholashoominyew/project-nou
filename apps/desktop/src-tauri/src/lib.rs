mod backup;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};
use uuid::Uuid;

const MIGRATION: &str = include_str!("../../../../db/notes/001_initial.sql");

struct Db(Mutex<Connection>);
struct BackupDirectory(PathBuf);

#[derive(Clone, Debug, Serialize)]
struct Page {
    id: String,
    title: String,
    parent_id: Option<String>,
    sort_key: String,
}

fn get_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let folder: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find app data path: {e}"))?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let conn = Connection::open(folder.join("notes.sqlite3")).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let has_migration: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !has_migration {
        conn.execute_batch(MIGRATION).map_err(|e| format!("Notes migration failed: {e}"))?;
    } else {
        let version: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version != 1 { return Err(format!("Unsupported Notes database version: {version}")); }
    }
    conn.execute("INSERT OR IGNORE INTO workspaces (id,title) VALUES ('personal','Personal')", [])
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn row_page(row: &rusqlite::Row<'_>) -> rusqlite::Result<Page> {
    Ok(Page { id: row.get(0)?, title: row.get(1)?, parent_id: row.get(2)?, sort_key: row.get(3)? })
}

#[tauri::command]
fn list_pages(db: State<'_, Db>) -> Result<Vec<Page>, String> {
    let conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let mut stmt = conn.prepare("SELECT id,title,parent_id,sort_key FROM pages WHERE workspace_id='personal' AND deleted_at IS NULL ORDER BY sort_key COLLATE BINARY,id").map_err(|e| e.to_string())?;
    let pages = stmt.query_map([], row_page).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(pages)
}

fn key_for_position(tx: &Transaction<'_>, parent_id: Option<&str>, desired: usize, exclude: Option<&str>) -> Result<String, String> {
    let mut stmt = tx.prepare(
        "SELECT id FROM pages WHERE workspace_id='personal' AND parent_id IS ?1 AND deleted_at IS NULL AND (?2 IS NULL OR id <> ?2) ORDER BY sort_key COLLATE BINARY,id"
    ).map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt.query_map(params![parent_id,exclude], |r| r.get(0)).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    // Rebalance siblings atomically using fixed-width sortable integer keys. O(n) per insertion/move;
    // a future fractional-indexing migration can optimize large sibling lists.
    for (i, id) in ids.iter().enumerate() {
        let key = format!("{:016x}", (i as u64 + 1) * 1024);
        tx.execute("UPDATE pages SET sort_key=?1 WHERE id=?2", params![key,id])
            .map_err(|e| e.to_string())?;
    }
    let position = desired.min(ids.len());
    Ok(format!("{:016x}", (position as u64 + 1) * 1024 + 1))
}

fn rebalance(tx: &Transaction<'_>, parent_id: Option<&str>) -> Result<(), String> {
    let mut stmt = tx.prepare("SELECT id FROM pages WHERE workspace_id='personal' AND parent_id IS ?1 AND deleted_at IS NULL ORDER BY sort_key COLLATE BINARY,id").map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt.query_map([parent_id], |r| r.get(0)).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    // Two-step renumber avoids UNIQUE collisions by temporarily assigning an id-based prefix.
    for id in &ids {
        tx.execute("UPDATE pages SET sort_key=? WHERE id=?", params![format!("~{id}"),id])
            .map_err(|e| e.to_string())?;
    }
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE pages SET sort_key=? WHERE id=?", params![format!("{:016x}", (i as u64 + 1) * 1024),id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn create_page(db: State<'_, Db>, parent_id: Option<String>, title: String) -> Result<Page, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if let Some(ref parent) = parent_id {
        let valid: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL)",
            [parent], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !valid { return Err("Parent page is missing or in trash".into()); }
    }
    let key = key_for_position(&tx,parent_id.as_deref(),usize::MAX,None)?;
    let id = Uuid::new_v4().to_string();
    let title = if title.trim().is_empty() { "Untitled".to_string() } else { title.trim().to_string() };
    tx.execute("INSERT INTO pages(id,workspace_id,parent_id,title,sort_key) VALUES (?1,'personal',?2,?3,?4)",
        params![id,parent_id,title,key]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO note_locations(page_id) VALUES (?1)", [&id]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO page_search(page_id,title,body) VALUES (?1,?2,'')",
        params![id,title]).map_err(|e| e.to_string())?;
    rebalance(&tx,parent_id.as_deref())?;
    let actual_key: String = tx.query_row(
        "SELECT sort_key FROM pages WHERE id=?1", [&id], |r| r.get(0)
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Page { id,title,parent_id,sort_key:actual_key })
}

#[tauri::command]
fn rename_page(db: State<'_, Db>, page_id: String, title: String) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() { return Err("Page title cannot be empty".into()); }
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let affected = tx.execute(
        "UPDATE pages SET title=?1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE id=?2 AND workspace_id='personal' AND deleted_at IS NULL",
        params![title,page_id]).map_err(|e| e.to_string())?;
    if affected != 1 { return Err("Page not found".into()); }
    tx.execute("UPDATE page_search SET title=?1 WHERE page_id=?2",
        params![title,page_id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
struct SearchHit { id: String, title: String, parent_id: Option<String> }

#[tauri::command]
fn search_notes(db: State<'_, Db>, query: String) -> Result<Vec<SearchHit>, String> {
    let search = query.trim();
    if search.is_empty() { return Ok(Vec::new()); }
    if search.len() > 200 { return Err("Search query is too long".into()); }
    // Quote FTS5 input so user punctuation/operators cannot alter query grammar.
    let exact = format!(r#""{}""#, search.replace('"', r#""""#));
    let conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let mut statement = conn.prepare(
        "SELECT p.id,p.title,p.parent_id FROM page_search s
         JOIN pages p ON p.id=s.page_id
         WHERE page_search MATCH ?1 AND p.workspace_id='personal'
           AND p.deleted_at IS NULL
         ORDER BY bm25(page_search),p.title COLLATE NOCASE LIMIT 100"
    ).map_err(|e| e.to_string())?;
    let hits = statement.query_map([exact], |row| Ok(SearchHit {
        id: row.get(0)?, title: row.get(1)?, parent_id: row.get(2)?
    })).map_err(|e| e.to_string())?
      .collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(hits)
}

#[tauri::command]
fn trash_page(db: State<'_, Db>, page_id: String) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let parent: Option<String> = tx.query_row(
        "SELECT parent_id FROM pages WHERE id=?1 AND deleted_at IS NULL",
        [&page_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?
        .ok_or("Page not found")?;
    // Keep all descendants consistently in trash; recursive query assumes acyclic tree.
    tx.execute(
        "WITH RECURSIVE subtree(id) AS (SELECT id FROM pages WHERE id=?1 UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id)
         UPDATE pages SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE id IN (SELECT id FROM subtree)",
        [&page_id]).map_err(|e| e.to_string())?;
    rebalance(&tx,parent.as_deref())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_page(db: State<'_, Db>, page_id: String, direction: String) -> Result<(), String> {
    if direction != "up" && direction != "down" { return Err("Invalid direction".into()); }
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let parent: Option<String> = tx.query_row(
        "SELECT parent_id FROM pages WHERE id=?1 AND deleted_at IS NULL",
        [&page_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?
        .ok_or("Page not found")?;
    let mut stmt = tx.prepare(
        "SELECT id FROM pages WHERE workspace_id='personal' AND parent_id IS ?1 AND deleted_at IS NULL ORDER BY sort_key COLLATE BINARY,id"
    ).map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = stmt.query_map([parent.as_deref()], |r| r.get(0)).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    drop(stmt);
    let index = ids.iter().position(|p| p == &page_id).ok_or("Page missing among siblings")?;
    let target = if direction == "up" { index.checked_sub(1) } else if index+1 < ids.len() { Some(index+1) } else { None };
    if let Some(other) = target {
        ids.swap(index,other);
        for id in &ids {
            tx.execute("UPDATE pages SET sort_key=? WHERE id=?",params![format!("~{id}"),id])
                .map_err(|e| e.to_string())?;
        }
        for (i,id) in ids.iter().enumerate() {
            tx.execute("UPDATE pages SET sort_key=?,revision=revision+1 WHERE id=?",params![format!("{:016x}",(i as u64+1)*1024),id])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
fn load_note_updates(db: State<'_, Db>, page_id: String) -> Result<Vec<Vec<u8>>, String> {
    let conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let active: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL)",
        [&page_id], |row| row.get(0)
    ).map_err(|e| e.to_string())?;
    if !active { return Err("Page not found or in trash".into()); }
    let mut statement = conn.prepare(
        "SELECT update_bytes FROM yjs_updates WHERE page_id=?1 ORDER BY seq ASC"
    ).map_err(|e| e.to_string())?;
    let updates = statement.query_map([page_id], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(updates)
}

#[tauri::command]
fn append_note_update(
    db: State<'_, Db>,
    page_id: String,
    update: Vec<u8>,
    plain_text: String,
) -> Result<i64, String> {
    if update.is_empty() || update.len() > 1_048_576 {
        return Err("Invalid or oversized Yjs update".into());
    }
    if plain_text.len() > 5_000_000 {
        return Err("Note text exceeds the current prototype limit".into());
    }
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let title: String = tx.query_row(
        "SELECT title FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL",
        [&page_id], |row| row.get(0)
    ).optional().map_err(|e| e.to_string())?
        .ok_or("Page not found or in trash")?;
    let seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM yjs_updates WHERE page_id=?1",
        [&page_id], |row| row.get(0)
    ).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO yjs_updates(page_id, seq, update_bytes) VALUES (?1,?2,?3)",
        params![page_id,seq,update],
    ).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM page_search WHERE page_id=?1", [&page_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO page_search(page_id,title,body) VALUES (?1,?2,?3)",
        params![page_id,title,plain_text],
    ).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE pages SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE id=?1",
        [&page_id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(seq)
}

#[tauri::command]
fn create_notes_snapshot(
    db: State<'_, Db>,
    backup_directory: State<'_, BackupDirectory>,
) -> Result<backup::Snapshot, String> {
    let connection = db.0.lock().map_err(|_| "Database lock poisoned")?;
    backup::create_snapshot(&connection, &backup_directory.0)
}

#[tauri::command]
fn verify_notes_snapshot(
    backup_directory: State<'_, BackupDirectory>,
    filename: String,
) -> Result<backup::Snapshot, String> {
    backup::verify_snapshot(&backup_directory.0, &filename)
}

#[tauri::command]
fn stage_notes_restore(
    backup_directory: State<'_, BackupDirectory>,
    filename: String,
) -> Result<backup::Snapshot, String> {
    let app_data = backup_directory.0.parent()
        .ok_or("Backup directory has no parent")?;
    let staging_directory = app_data.join("restore-staging");
    backup::stage_restore(&backup_directory.0, &filename, &staging_directory)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let conn = get_connection(app.handle()).map_err(std::io::Error::other)?;
            let backups = app.handle().path().app_data_dir()
                .map_err(std::io::Error::other)?
                .join("snapshots");
            app.manage(BackupDirectory(backups));
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_pages,create_page,rename_page,trash_page,move_page,load_note_updates,append_note_update,search_notes,create_notes_snapshot,verify_notes_snapshot,stage_notes_restore])
        .run(tauri::generate_context!())
        .expect("error running Project NOU");
}
