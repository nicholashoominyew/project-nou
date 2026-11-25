//! Linked to-dos: one to-do shown on several pages, always in step. The shared state lives in `linked_todos`; notes only hold the id.
//! `linked_todo_refs` records which pages show which to-do. It is derived from the note bodies and rebuilt on every save, like `page_links`.
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

const MAX_TEXT: usize = 500;
const MAX_IDS: usize = 500;

#[derive(Serialize, Debug, PartialEq)]
pub struct Todo { id: String, text: String, checked: bool, pages: i64 }
impl Todo { pub fn text(&self) -> &str { &self.text } pub fn checked(&self) -> bool { self.checked } }
#[derive(Serialize, Debug, PartialEq)]
pub struct TodoPage { id: String, title: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }
fn clean_text(text: &str) -> Result<String, String> {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > MAX_TEXT { return Err(format!("A to-do can be at most {MAX_TEXT} characters")); }
    Ok(t)
}
fn valid_id(id: &str) -> bool { (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }

pub fn create(c: &Connection, text: &str) -> Result<Todo, String> {
    let text = clean_text(text)?;
    let id = Uuid::new_v4().to_string();
    c.execute("INSERT INTO linked_todos(id,text,sort_order) VALUES(?1,?2,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM linked_todos))", params![id, text]).map_err(e)?;
    Ok(Todo { id, text, checked: false, pages: 0 })
}

const SELECT: &str = "SELECT t.id,t.text,t.checked,(SELECT COUNT(*) FROM linked_todo_refs r JOIN pages p ON p.id=r.page_id WHERE r.todo_id=t.id AND p.deleted_at IS NULL) FROM linked_todos t";
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> { Ok(Todo { id: r.get(0)?, text: r.get(1)?, checked: r.get::<_, i64>(2)? != 0, pages: r.get(3)? }) }

pub fn get(c: &Connection, ids: &[String]) -> Result<Vec<Todo>, String> {
    if ids.len() > MAX_IDS { return Err("Too many to-dos requested".into()); }
    let mut out = Vec::new();
    for id in ids {
        if !valid_id(id) { continue; }
        if let Some(t) = c.query_row(&format!("{SELECT} WHERE t.id=?1"), [id], row).optional().map_err(e)? { out.push(t); }
    }
    Ok(out)
}

/// Change the ticked state and/or the text. Unknown ids are an error so a stale block cannot silently do nothing.
pub fn set(c: &Connection, id: &str, checked: Option<bool>, text: Option<&str>) -> Result<Todo, String> {
    if !valid_id(id) { return Err("Not a valid to-do id".into()); }
    let text = match text { Some(t) => Some(clean_text(t)?), None => None };
    let n = c.execute(
        "UPDATE linked_todos SET checked=COALESCE(?2,checked),text=COALESCE(?3,text),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        params![id, checked.map(|b| b as i64), text]).map_err(e)?;
    if n == 0 { return Err("That linked to-do no longer exists".into()); }
    get(c, &[id.to_string()])?.into_iter().next().ok_or_else(|| "That linked to-do no longer exists".to_string())
}

/// Existing linked to-dos for the picker, newest first, optionally filtered by text. `%` and `_` in the query are plain characters.
pub fn list(c: &Connection, query: &str) -> Result<Vec<Todo>, String> {
    let q = format!("%{}%", query.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let mut s = c.prepare(&format!("{SELECT} WHERE t.text LIKE ?1 ESCAPE '\\' ORDER BY t.sort_order,t.updated_at DESC,t.id LIMIT 100")).map_err(e)?;
    let it = s.query_map([q], row).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

/// Put the to-dos in the given order (Today's tasks). To-dos not listed keep their relative order after the listed ones. Unknown ids are an error.
pub fn reorder(c: &mut Connection, ids: &[String]) -> Result<(), String> {
    if ids.len() > MAX_IDS { return Err("Too many to-dos".into()); }
    let tx = c.transaction().map_err(e)?;
    let mut seen = std::collections::HashSet::new(); let mut order = 0i64;
    for id in ids {
        if !valid_id(id) { return Err("Not a valid to-do id".into()); }
        if !seen.insert(id.clone()) { continue; }
        if tx.execute("UPDATE linked_todos SET sort_order=?1 WHERE id=?2", params![order, id]).map_err(e)? == 0 { return Err("That linked to-do no longer exists".into()); }
        order += 1;
    }
    let rest: Vec<String> = { let mut s = tx.prepare("SELECT id FROM linked_todos ORDER BY sort_order,updated_at DESC,id").map_err(e)?; let r = s.query_map([], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<Vec<String>>>().map_err(e)?; r };
    for id in rest { if seen.contains(&id) { continue; } tx.execute("UPDATE linked_todos SET sort_order=?1 WHERE id=?2", params![order, id]).map_err(e)?; order += 1; }
    tx.commit().map_err(e)
}

/// The pages (not in the trash) that show this to-do.
pub fn pages(c: &Connection, id: &str) -> Result<Vec<TodoPage>, String> {
    let mut s = c.prepare("SELECT p.id,p.title FROM linked_todo_refs r JOIN pages p ON p.id=r.page_id WHERE r.todo_id=?1 AND p.deleted_at IS NULL AND p.workspace_id='personal' ORDER BY p.title COLLATE NOCASE,p.id").map_err(e)?;
    let it = s.query_map([id], |r| Ok(TodoPage { id: r.get(0)?, title: r.get(1)? })).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

/// Replace which linked to-dos `page` shows. Unknown to-dos and duplicates are ignored.
pub fn replace_refs(tx: &Transaction<'_>, page: &str, ids: &[String]) -> Result<usize, String> {
    if ids.len() > MAX_IDS { return Err("Too many linked to-dos in one page".into()); }
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal')", [page], |r| r.get(0)).map_err(e)?;
    if !exists { return Err("Page not found".into()); }
    tx.execute("DELETE FROM linked_todo_refs WHERE page_id=?1", [page]).map_err(e)?;
    if crate::locks::is_locked(tx, page)? { return Ok(0); }
    let mut kept = 0;
    for id in ids {
        if !valid_id(id) { continue; }
        kept += tx.execute("INSERT OR IGNORE INTO linked_todo_refs(todo_id,page_id) SELECT id,?2 FROM linked_todos WHERE id=?1", params![id, page]).map_err(e)?;
    }
    Ok(kept)
}

#[tauri::command]
pub fn linked_todo_create(db: State<'_, Db>, text: String) -> Result<Todo, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    create(&c, &text)
}
#[tauri::command]
pub fn linked_todo_get(db: State<'_, Db>, ids: Vec<String>) -> Result<Vec<Todo>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    get(&c, &ids)
}
#[tauri::command]
pub fn linked_todo_set(db: State<'_, Db>, id: String, checked: Option<bool>, text: Option<String>) -> Result<Todo, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    set(&c, &id, checked, text.as_deref())
}
#[tauri::command]
pub fn linked_todo_list(db: State<'_, Db>, query: String) -> Result<Vec<Todo>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    list(&c, &query)
}
#[tauri::command]
pub fn linked_todo_reorder(db: State<'_, Db>, ids: Vec<String>) -> Result<(), String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    reorder(&mut c, &ids)
}
#[tauri::command]
pub fn linked_todo_pages(db: State<'_, Db>, id: String) -> Result<Vec<TodoPage>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    pages(&c, &id)
}
#[tauri::command]
pub fn set_page_todo_links(db: State<'_, Db>, page_id: String, ids: Vec<String>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    replace_refs(&tx, &page_id, &ids)?;
    tx.commit().map_err(e)
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
    fn page(c: &Connection, id: &str, title: &str, key: &str) { c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES(?1,'personal',?2,?3)", params![id, title, key]).unwrap(); }
    fn refs(c: &mut Connection, page: &str, ids: &[&str]) -> usize { let tx = c.transaction().unwrap(); let n = replace_refs(&tx, page, &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap(); tx.commit().unwrap(); n }

    #[test]
    fn ticking_in_one_place_is_seen_everywhere_and_text_edits_too() {
        let mut c = fresh();
        page(&c, "a", "Alpha", "1"); page(&c, "b", "Beta", "2");
        let t = create(&c, "  Call   Sam ").unwrap();
        assert_eq!(t.text, "Call Sam", "spacing is tidied");
        refs(&mut c, "a", &[&t.id]); refs(&mut c, "b", &[&t.id]);
        assert_eq!(get(&c, &[t.id.clone()]).unwrap()[0].pages, 2);
        let done = set(&c, &t.id, Some(true), None).unwrap();
        assert!(done.checked && done.text == "Call Sam");
        let renamed = set(&c, &t.id, None, Some("Call Sam back")).unwrap();
        assert!(renamed.checked, "changing the text leaves the tick alone");
        assert_eq!(get(&c, &[t.id.clone()]).unwrap()[0].text, "Call Sam back");
        assert!(!set(&c, &t.id, Some(false), None).unwrap().checked);
    }
    #[test]
    fn refs_follow_saved_pages_and_ignore_unknown_todos_and_duplicates() {
        let mut c = fresh();
        page(&c, "a", "Alpha", "1"); page(&c, "b", "Beta", "2");
        let t = create(&c, "x").unwrap();
        assert_eq!(refs(&mut c, "a", &[&t.id, &t.id, "ghost-ghost-ghost"]), 1);
        refs(&mut c, "b", &[&t.id]);
        assert_eq!(pages(&c, &t.id).unwrap(), vec![TodoPage { id: "a".into(), title: "Alpha".into() }, TodoPage { id: "b".into(), title: "Beta".into() }]);
        refs(&mut c, "a", &[]);
        assert_eq!(pages(&c, &t.id).unwrap().len(), 1);
        c.execute("UPDATE pages SET deleted_at='x' WHERE id='b'", []).unwrap();
        assert!(pages(&c, &t.id).unwrap().is_empty(), "trashed pages are not listed");
        assert_eq!(get(&c, &[t.id.clone()]).unwrap()[0].pages, 0);
    }
    #[test]
    fn bad_input_is_refused_and_a_missing_todo_is_an_error() {
        let c = fresh();
        assert!(create(&c, &"x".repeat(501)).is_err());
        assert!(set(&c, "../../etc", Some(true), None).is_err());
        assert!(set(&c, "doesnotexist1", Some(true), None).is_err());
        assert!(get(&c, &["bad id!".to_string()]).unwrap().is_empty());
        let mut c2 = fresh();
        let tx = c2.transaction().unwrap();
        assert!(replace_refs(&tx, "missing", &[]).is_err());
    }
    #[test]
    fn the_picker_finds_todos_by_text_and_treats_wildcards_literally() {
        let c = fresh();
        create(&c, "Buy milk").unwrap(); create(&c, "100% done").unwrap(); create(&c, "Call Sam").unwrap();
        assert_eq!(list(&c, "milk").unwrap().len(), 1);
        assert_eq!(list(&c, "").unwrap().len(), 3);
        assert_eq!(list(&c, "%").unwrap().len(), 1, "a percent sign is a literal character");
        assert_eq!(list(&c, "_").unwrap().len(), 0);
    }
    #[test]
    fn deleting_a_page_removes_its_refs_but_keeps_the_todo() {
        let mut c = fresh();
        page(&c, "a", "Alpha", "1");
        let t = create(&c, "x").unwrap(); refs(&mut c, "a", &[&t.id]);
        c.execute("DELETE FROM pages WHERE id='a'", []).unwrap();
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM linked_todo_refs", [], |r| r.get(0)).unwrap(), 0);
        assert_eq!(get(&c, &[t.id]).unwrap().len(), 1);
    }

    #[test]
    fn to_dos_are_listed_in_the_order_they_were_put_in_and_can_be_reordered() {
        let mut c = fresh();
        let a = create(&c, "a").unwrap(); let b = create(&c, "b").unwrap(); let d = create(&c, "d").unwrap();
        let texts = |c: &Connection| list(c, "").unwrap().into_iter().map(|t| t.text).collect::<Vec<_>>();
        assert_eq!(texts(&c), vec!["a", "b", "d"], "new ones go to the end");
        reorder(&mut c, &[d.id.clone(), a.id.clone()]).unwrap();
        assert_eq!(texts(&c), vec!["d", "a", "b"], "listed first, the rest after");
        assert!(reorder(&mut c, &["not-a-real-id".to_string()]).is_err() && reorder(&mut c, &["x".to_string()]).is_err());
        assert_eq!(texts(&c), vec!["d", "a", "b"], "a refused change leaves the order alone");
        let _ = b;
    }
}
