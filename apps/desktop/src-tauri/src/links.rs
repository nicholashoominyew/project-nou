//! Backlinks: which pages link to a page. The index (`page_links`) is derived from page-link blocks in note bodies
//! and is rebuilt whenever a note is saved or opened, so it can never hold the only copy of anything.
use crate::Db;
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, PartialEq)]
pub struct Linked { id: String, title: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }

/// Replace the outgoing links of `source`. Unknown pages, itself and duplicates are ignored.
pub fn replace_links(tx: &Transaction<'_>, source: &str, targets: &[String]) -> Result<usize, String> {
    if targets.len() > 2000 { return Err("Too many links in one page".into()); }
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal')", [source], |r| r.get(0)).map_err(e)?;
    if !exists { return Err("Page not found".into()); }
    tx.execute("DELETE FROM page_links WHERE source_id=?1", [source]).map_err(e)?;
    let mut kept = 0;
    for target in targets {
        if target == source { continue; }
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal')", [target], |r| r.get(0)).map_err(e)?;
        if !known { continue; }
        kept += tx.execute("INSERT OR IGNORE INTO page_links(source_id,target_id) VALUES(?1,?2)", params![source, target]).map_err(e)?;
    }
    Ok(kept)
}

/// Pages that link to `page`, excluding trashed pages and hidden database rows/databases (they cannot be opened from the sidebar).
pub fn backlinks(c: &Connection, page: &str) -> Result<Vec<Linked>, String> {
    let mut s = c.prepare(
        "SELECT p.id,p.title FROM page_links l JOIN pages p ON p.id=l.source_id
         WHERE l.target_id=?1 AND p.deleted_at IS NULL AND p.workspace_id='personal'
           AND p.id NOT IN (SELECT page_id FROM db_rows) AND p.id NOT IN (SELECT page_id FROM databases)
         ORDER BY p.title COLLATE NOCASE,p.id").map_err(e)?;
    let it = s.query_map([page], |r| Ok(Linked { id: r.get(0)?, title: r.get(1)? })).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[tauri::command]
pub fn set_page_links(db: State<'_, Db>, page_id: String, targets: Vec<String>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    replace_links(&tx, &page_id, &targets)?;
    tx.commit().map_err(e)
}

#[tauri::command]
pub fn list_backlinks(db: State<'_, Db>, page_id: String) -> Result<Vec<Linked>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    backlinks(&c, &page_id)
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
    fn page(c: &Connection, id: &str, title: &str, key: &str) {
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES(?1,'personal',?2,?3)", params![id, title, key]).unwrap();
    }
    fn set(c: &mut Connection, source: &str, targets: &[&str]) -> usize {
        let tx = c.transaction().unwrap();
        let n = replace_links(&tx, source, &targets.iter().map(|t| t.to_string()).collect::<Vec<_>>()).unwrap();
        tx.commit().unwrap();
        n
    }
    #[test]
    fn backlinks_follow_saved_links_and_ignore_trash_self_and_unknown_pages() {
        let mut c = fresh();
        page(&c, "a", "Alpha", "1"); page(&c, "b", "Beta", "2"); page(&c, "t", "Target", "3");
        assert_eq!(set(&mut c, "a", &["t", "t", "a", "ghost"]), 1, "duplicates, self and unknown pages are dropped");
        assert_eq!(set(&mut c, "b", &["t"]), 1);
        assert_eq!(backlinks(&c, "t").unwrap(), vec![Linked { id: "a".into(), title: "Alpha".into() }, Linked { id: "b".into(), title: "Beta".into() }]);
        // saving again replaces the old links
        set(&mut c, "a", &[]);
        assert_eq!(backlinks(&c, "t").unwrap().len(), 1);
        // trashed sources disappear from the list but their links come back on restore
        c.execute("UPDATE pages SET deleted_at='x' WHERE id='b'", []).unwrap();
        assert!(backlinks(&c, "t").unwrap().is_empty());
        c.execute("UPDATE pages SET deleted_at=NULL WHERE id='b'", []).unwrap();
        assert_eq!(backlinks(&c, "t").unwrap().len(), 1);
    }
    #[test]
    fn deleting_a_page_row_cascades_and_unknown_sources_are_refused() {
        let mut c = fresh();
        page(&c, "a", "Alpha", "1"); page(&c, "t", "Target", "2");
        set(&mut c, "a", &["t"]);
        let tx = c.transaction().unwrap();
        assert!(replace_links(&tx, "missing", &["t".to_string()]).is_err());
        drop(tx);
        c.execute("DELETE FROM pages WHERE id='a'", []).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM page_links", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }
    #[test]
    fn database_rows_are_not_listed_as_backlink_sources() {
        let mut c = fresh();
        page(&c, "d", "DB", "1"); page(&c, "r", "Row", "2"); page(&c, "t", "Target", "3");
        c.execute("INSERT INTO databases(page_id) VALUES('d')", []).unwrap();
        c.execute("INSERT INTO db_rows(page_id,database_id) VALUES('r','d')", []).unwrap();
        set(&mut c, "r", &["t"]);
        assert!(backlinks(&c, "t").unwrap().is_empty());
    }
}
