//! File tracker: every file stored with your notes, which pages use it, and which are not used by any page. Read-only: it never deletes
//! or changes a file. Files live in their own database (`files.sqlite3`); which page uses which file is recorded in the Notes database (`note_files`).
use crate::{attachments, Db};
use rusqlite::Connection;
use serde::Serialize;
use std::{collections::HashMap, path::Path};
use tauri::State;

const MAX_FILES: i64 = 5000;

#[derive(Serialize, Debug, PartialEq)]
pub struct UsedOn { pub id: String, pub title: String }
#[derive(Serialize, Debug, PartialEq)]
pub struct TrackedFile { pub id: String, pub name: String, pub mime: String, pub bytes: i64, pub pages: Vec<UsedOn>, pub trashed_pages: i64 }

fn e(error: rusqlite::Error) -> String { error.to_string() }

/// Newest first. `pages` lists pages that are not in the trash; `trashed_pages` counts the ones that are (restoring them brings the file back into use).
pub fn tracked(notes: &Connection, files: &Connection) -> Result<Vec<TrackedFile>, String> {
    let mut by_file: HashMap<String, (Vec<UsedOn>, i64)> = HashMap::new();
    let mut s = notes.prepare("SELECT f.file_id,p.id,p.title,p.deleted_at IS NOT NULL FROM note_files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id='personal' ORDER BY p.title COLLATE NOCASE,p.id").map_err(e)?;
    let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)? != 0))).map_err(e)?;
    for row in rows {
        let (file, page, title, trashed) = row.map_err(e)?;
        let entry = by_file.entry(file).or_default();
        if trashed { entry.1 += 1; } else { entry.0.push(UsedOn { id: page, title }); }
    }
    let mut f = files.prepare("SELECT id,name,mime,length(data) FROM file_blobs ORDER BY rowid DESC LIMIT ?1").map_err(e)?;
    let it = f.query_map([MAX_FILES], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))).map_err(e)?;
    let mut out = Vec::new();
    for row in it {
        let (id, name, mime, bytes) = row.map_err(e)?;
        let (pages, trashed_pages) = by_file.remove(&id).unwrap_or_default();
        out.push(TrackedFile { id, name, mime, bytes, pages, trashed_pages });
    }
    Ok(out)
}

pub fn list(notes: &Connection, profile: &Path) -> Result<Vec<TrackedFile>, String> {
    let files = attachments::open(profile)?;
    tracked(notes, &files)
}

#[tauri::command]
pub fn list_files(app: tauri::AppHandle, db: State<'_, Db>) -> Result<Vec<TrackedFile>, String> {
    use tauri::Manager;
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let profile = crate::data_dir(app.path()).map_err(|e| e.to_string())?;
    list(&c, &profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn notes() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        c
    }
    fn files() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE file_blobs(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,data BLOB NOT NULL);").unwrap();
        c
    }
    fn blob(c: &Connection, id: &str, name: &str, mime: &str, size: usize) { c.execute("INSERT INTO file_blobs(id,name,mime,data) VALUES(?1,?2,?3,?4)", rusqlite::params![id, name, mime, vec![0u8; size]]).unwrap(); }
    fn page(c: &Connection, id: &str, title: &str, key: &str) { c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES(?1,'personal',?2,?3)", rusqlite::params![id, title, key]).unwrap(); }
    fn uses(c: &Connection, page: &str, file: &str) { c.execute("INSERT INTO note_files(page_id,file_id) VALUES(?1,?2)", rusqlite::params![page, file]).unwrap(); }
    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    #[test]
    fn lists_files_newest_first_with_sizes_and_the_pages_that_use_them() {
        let (n, f) = (notes(), files());
        page(&n, "p1", "Zebra", "1"); page(&n, "p2", "Apple", "2");
        blob(&f, A, "old.pdf", "application/pdf", 10); blob(&f, B, "new.png", "image/png", 2500);
        uses(&n, "p1", A); uses(&n, "p2", A); uses(&n, "p1", B);
        let list = tracked(&n, &f).unwrap();
        assert_eq!(list.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["new.png", "old.pdf"]);
        assert_eq!(list[0].bytes, 2500);
        assert_eq!(list[1].pages, vec![UsedOn { id: "p2".into(), title: "Apple".into() }, UsedOn { id: "p1".into(), title: "Zebra".into() }], "pages are listed by title");
    }
    #[test]
    fn a_file_no_page_uses_has_no_pages_and_trashed_pages_are_counted_apart() {
        let (n, f) = (notes(), files());
        page(&n, "p1", "Live", "1"); page(&n, "p2", "Gone", "2");
        blob(&f, A, "unused.txt", "text/plain", 1); blob(&f, B, "only-in-trash.pdf", "application/pdf", 1); blob(&f, C, "both.png", "image/png", 1);
        uses(&n, "p2", B); uses(&n, "p1", C); uses(&n, "p2", C);
        n.execute("UPDATE pages SET deleted_at='x' WHERE id='p2'", []).unwrap();
        let list = tracked(&n, &f).unwrap();
        let by = |name: &str| list.iter().find(|x| x.name == name).unwrap();
        assert!(by("unused.txt").pages.is_empty() && by("unused.txt").trashed_pages == 0);
        assert!(by("only-in-trash.pdf").pages.is_empty() && by("only-in-trash.pdf").trashed_pages == 1);
        assert_eq!(by("both.png").pages.len(), 1); assert_eq!(by("both.png").trashed_pages, 1);
    }
    #[test]
    fn it_never_changes_anything_and_handles_an_empty_store() {
        let (n, f) = (notes(), files());
        assert!(tracked(&n, &f).unwrap().is_empty());
        blob(&f, A, "x.bin", "application/octet-stream", 3);
        tracked(&n, &f).unwrap(); tracked(&n, &f).unwrap();
        assert_eq!(f.query_row::<i64, _, _>("SELECT COUNT(*) FROM file_blobs", [], |r| r.get(0)).unwrap(), 1);
    }
}
