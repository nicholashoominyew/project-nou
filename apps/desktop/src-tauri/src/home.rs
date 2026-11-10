//! Data for the home page widgets that need more than the page list the app already holds.
use crate::Db;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, PartialEq)]
pub struct Recent { id: String, title: String, updated_at: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }

/// Most recently edited pages, newest first. Trashed pages and hidden database rows/databases are left out.
pub fn recent_pages(c: &Connection, limit: u32) -> Result<Vec<Recent>, String> {
    let mut s = c.prepare(
        "SELECT id,title,updated_at FROM pages
         WHERE workspace_id='personal' AND deleted_at IS NULL
           AND id NOT IN (SELECT page_id FROM db_rows) AND id NOT IN (SELECT page_id FROM databases)
         ORDER BY updated_at DESC,id LIMIT ?1").map_err(e)?;
    let it = s.query_map([limit.clamp(1, 50)], |r| Ok(Recent { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)? })).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[tauri::command]
pub fn list_recent_pages(db: State<'_, Db>, limit: Option<u32>) -> Result<Vec<Recent>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    recent_pages(&c, limit.unwrap_or(8))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        c
    }
    fn page(c: &Connection, id: &str, key: &str, updated: &str) {
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key,updated_at) VALUES(?1,'personal',?1,?2,?3)", rusqlite::params![id, key, updated]).unwrap();
    }
    #[test]
    fn recent_pages_are_newest_first_and_skip_trash_databases_and_rows() {
        let c = fresh();
        page(&c, "old", "1", "2026-11-01T00:00:00.000Z");
        page(&c, "new", "2", "2026-11-10T00:00:00.000Z");
        page(&c, "mid", "3", "2026-11-05T00:00:00.000Z");
        page(&c, "gone", "4", "2026-11-11T00:00:00.000Z");
        page(&c, "db", "5", "2026-11-11T01:00:00.000Z");
        page(&c, "row", "6", "2026-11-11T02:00:00.000Z");
        c.execute("UPDATE pages SET deleted_at='t' WHERE id='gone'", []).unwrap();
        c.execute("INSERT INTO databases(page_id) VALUES('db')", []).unwrap();
        c.execute("INSERT INTO db_rows(page_id,database_id) VALUES('row','db')", []).unwrap();
        let ids: Vec<String> = recent_pages(&c, 10).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["new", "mid", "old"]);
        assert_eq!(recent_pages(&c, 2).unwrap().len(), 2);
        assert_eq!(recent_pages(&c, 0).unwrap().len(), 1, "the limit is clamped to at least one");
        assert_eq!(recent_pages(&c, 9999).unwrap().len(), 3, "and to at most fifty");
    }
}
