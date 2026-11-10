//! Page tags (the `tags` / `page_tags` tables from the first schema). Tags are workspace-wide, case-insensitive and
//! created on demand; a page's tag list is replaced as a whole so the UI never has to reason about partial states.
use crate::Db;
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

const MAX_TAGS_PER_PAGE: usize = 20;
const MAX_TAG_LEN: usize = 40;

#[derive(Serialize, Debug, PartialEq)]
pub struct TagCount { name: String, count: i64 }
#[derive(Serialize, Debug, PartialEq)]
pub struct Titled { id: String, title: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }

/// "  #Research  Notes " -> "Research Notes". Empty after cleaning means "ignore this entry".
fn clean(name: &str) -> Result<Option<String>, String> {
    let collapsed = name.trim().trim_start_matches('#').split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { return Ok(None); }
    if collapsed.chars().count() > MAX_TAG_LEN { return Err(format!("Tags can be at most {MAX_TAG_LEN} characters")); }
    if collapsed.contains(',') { return Err("Tags cannot contain commas".into()); }
    Ok(Some(collapsed))
}

pub fn set_tags(tx: &Transaction<'_>, page: &str, names: &[String]) -> Result<Vec<String>, String> {
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL)", [page], |r| r.get(0)).map_err(e)?;
    if !exists { return Err("Page not found".into()); }
    let mut cleaned: Vec<String> = Vec::new();
    for name in names {
        if let Some(c) = clean(name)? { if !cleaned.iter().any(|x| x.eq_ignore_ascii_case(&c) || x.to_lowercase() == c.to_lowercase()) { cleaned.push(c); } }
    }
    if cleaned.len() > MAX_TAGS_PER_PAGE { return Err(format!("A page can have at most {MAX_TAGS_PER_PAGE} tags")); }
    tx.execute("DELETE FROM page_tags WHERE page_id=?1", [page]).map_err(e)?;
    for name in &cleaned {
        let existing: Option<String> = tx.query_row("SELECT id FROM tags WHERE workspace_id='personal' AND name=?1", [name], |r| r.get(0)).ok();
        let id = match existing { Some(id) => id, None => { let id = Uuid::new_v4().to_string(); tx.execute("INSERT INTO tags(id,workspace_id,name) VALUES(?1,'personal',?2)", params![id, name]).map_err(e)?; id } };
        tx.execute("INSERT OR IGNORE INTO page_tags(page_id,tag_id) VALUES(?1,?2)", params![page, id]).map_err(e)?;
    }
    Ok(cleaned)
}

pub fn page_tags(c: &Connection, page: &str) -> Result<Vec<String>, String> {
    let mut s = c.prepare("SELECT t.name FROM page_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.page_id=?1 ORDER BY t.name COLLATE NOCASE").map_err(e)?;
    let it = s.query_map([page], |r| r.get(0)).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

/// Tags that are on at least one live page, with how many pages use each.
pub fn tag_counts(c: &Connection) -> Result<Vec<TagCount>, String> {
    let mut s = c.prepare(
        "SELECT t.name,COUNT(p.id) FROM tags t JOIN page_tags pt ON pt.tag_id=t.id JOIN pages p ON p.id=pt.page_id
         WHERE t.workspace_id='personal' AND p.deleted_at IS NULL GROUP BY t.id ORDER BY t.name COLLATE NOCASE").map_err(e)?;
    let it = s.query_map([], |r| Ok(TagCount { name: r.get(0)?, count: r.get(1)? })).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

/// Pages whose tag starts with `prefix` (case-insensitive); `%` and `_` in the prefix are literal.
pub fn pages_with_tag(c: &Connection, prefix: &str) -> Result<Vec<Titled>, String> {
    let escaped = prefix.trim().trim_start_matches('#').replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    if escaped.is_empty() { return Ok(Vec::new()); }
    let mut s = c.prepare(
        "SELECT DISTINCT p.id,p.title FROM tags t JOIN page_tags pt ON pt.tag_id=t.id JOIN pages p ON p.id=pt.page_id
         WHERE t.workspace_id='personal' AND p.deleted_at IS NULL AND t.name LIKE ?1 || '%' ESCAPE '\\'
           AND p.id NOT IN (SELECT page_id FROM db_rows) AND p.id NOT IN (SELECT page_id FROM databases)
         ORDER BY p.title COLLATE NOCASE,p.id LIMIT 200").map_err(e)?;
    let it = s.query_map([escaped], |r| Ok(Titled { id: r.get(0)?, title: r.get(1)? })).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

#[tauri::command]
pub fn set_page_tags(db: State<'_, Db>, page_id: String, names: Vec<String>) -> Result<Vec<String>, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    let saved = set_tags(&tx, &page_id, &names)?;
    tx.commit().map_err(e)?;
    Ok(saved)
}
#[tauri::command]
pub fn get_page_tags(db: State<'_, Db>, page_id: String) -> Result<Vec<String>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    page_tags(&c, &page_id)
}
#[tauri::command]
pub fn list_tags(db: State<'_, Db>) -> Result<Vec<TagCount>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    tag_counts(&c)
}
#[tauri::command]
pub fn find_pages_by_tag(db: State<'_, Db>, prefix: String) -> Result<Vec<Titled>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    pages_with_tag(&c, &prefix)
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
        for (id, title, key) in [("a", "Alpha", "1"), ("b", "Beta", "2"), ("c", "Gamma", "3")] {
            c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES(?1,'personal',?2,?3)", params![id, title, key]).unwrap();
        }
        c
    }
    fn set(c: &mut Connection, page: &str, names: &[&str]) -> Result<Vec<String>, String> {
        let tx = c.transaction().unwrap();
        let out = set_tags(&tx, page, &names.iter().map(|n| n.to_string()).collect::<Vec<_>>());
        if out.is_ok() { tx.commit().unwrap(); }
        out
    }
    #[test]
    fn tags_are_cleaned_deduplicated_case_insensitively_and_replaced_as_a_whole() {
        let mut c = fresh();
        assert_eq!(set(&mut c, "a", &["  #Research ", "research", "Deep   Work", "", "#"]).unwrap(), ["Research", "Deep Work"]);
        assert_eq!(page_tags(&c, "a").unwrap(), ["Deep Work", "Research"]);
        set(&mut c, "a", &["Research"]).unwrap();
        assert_eq!(page_tags(&c, "a").unwrap(), ["Research"], "the list is replaced, not merged");
        // an existing tag is reused (case-insensitively), not duplicated
        set(&mut c, "b", &["RESEARCH"]).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "Research and Deep Work only");
        assert_eq!(tag_counts(&c).unwrap(), vec![TagCount { name: "Research".into(), count: 2 }]);
    }
    #[test]
    fn invalid_tags_and_missing_pages_are_refused_without_changing_anything() {
        let mut c = fresh();
        set(&mut c, "a", &["keep"]).unwrap();
        assert!(set(&mut c, "a", &["a,b"]).is_err());
        assert!(set(&mut c, "a", &[&"x".repeat(41)]).is_err());
        let many: Vec<String> = (0..21).map(|i| format!("t{i}")).collect();
        assert!(set(&mut c, "a", &many.iter().map(String::as_str).collect::<Vec<_>>()).is_err());
        assert!(set(&mut c, "nope", &["x"]).is_err());
        assert_eq!(page_tags(&c, "a").unwrap(), ["keep"]);
    }
    #[test]
    fn counts_and_prefix_search_skip_trashed_pages_and_treat_wildcards_literally() {
        let mut c = fresh();
        set(&mut c, "a", &["project-x", "100%_done"]).unwrap();
        set(&mut c, "b", &["Project-Y"]).unwrap();
        set(&mut c, "c", &["project-x"]).unwrap();
        c.execute("UPDATE pages SET deleted_at='t' WHERE id='c'", []).unwrap();
        let hits: Vec<String> = pages_with_tag(&c, "#PROJ").unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(hits, ["a", "b"], "case-insensitive prefix, trashed page excluded");
        assert_eq!(pages_with_tag(&c, "100%").unwrap().len(), 1);
        assert!(pages_with_tag(&c, "%").unwrap().is_empty(), "a bare % must not match every tag");
        assert!(pages_with_tag(&c, "").unwrap().is_empty());
        let counts = tag_counts(&c).unwrap();
        assert_eq!(counts.iter().find(|t| t.name == "project-x").unwrap().count, 1);
    }
}
