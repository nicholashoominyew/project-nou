//! Notion-style databases (ADR-003). A database is a page with a row in `databases`; its rows are child
//! pages listed in `db_rows`. Every write validates the value against the property type here, never in the UI.
use crate::{insert_page, Db, Page};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

const TYPES: [&str; 8] = ["text", "number", "select", "multi_select", "status", "date", "checkbox", "url"];
const COLORS: [&str; 9] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const MAX_TEXT: usize = 10_000;

#[derive(Serialize)]
pub struct Opt { id: String, name: String, color: String }
#[derive(Serialize)]
pub struct Prop { id: String, name: String, #[serde(rename = "type")] kind: String, options: Vec<Opt> }
#[derive(Serialize)]
pub struct Row { id: String, title: String, values: Map<String, Value> }
#[derive(Serialize)]
pub struct DatabaseView { properties: Vec<Prop>, rows: Vec<Row> }

fn e(error: rusqlite::Error) -> String { error.to_string() }

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 { return Err("Names must be 1 to 100 characters".into()); }
    Ok(name.to_string())
}

fn is_database(c: &Connection, id: &str) -> Result<bool, String> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM databases d JOIN pages p ON p.id=d.page_id WHERE d.page_id=?1 AND p.deleted_at IS NULL)", [id], |r| r.get(0)).map_err(e)
}

fn add_option(tx: &Transaction<'_>, property: &str, name: &str, color: &str) -> Result<Opt, String> {
    let name = clean_name(name)?;
    let color = if COLORS.contains(&color) { color } else { "gray" };
    let position: i64 = tx.query_row("SELECT COALESCE(MAX(position),0)+1 FROM db_options WHERE property_id=?1", [property], |r| r.get(0)).map_err(e)?;
    let id = Uuid::new_v4().to_string();
    tx.execute("INSERT INTO db_options(id,property_id,name,color,position) VALUES(?1,?2,?3,?4,?5)", params![id, property, name, color, position]).map_err(e)?;
    Ok(Opt { id, name, color: color.into() })
}

fn insert_property(tx: &Transaction<'_>, database: &str, name: &str, kind: &str) -> Result<Prop, String> {
    if !TYPES.contains(&kind) { return Err("Unsupported property type".into()); }
    let name = clean_name(name)?;
    let position: i64 = tx.query_row("SELECT COALESCE(MAX(position),0)+1 FROM db_properties WHERE database_id=?1", [database], |r| r.get(0)).map_err(e)?;
    let id = Uuid::new_v4().to_string();
    tx.execute("INSERT INTO db_properties(id,database_id,name,type,position) VALUES(?1,?2,?3,?4,?5)", params![id, database, name, kind, position]).map_err(e)?;
    let mut options = Vec::new();
    if kind == "status" {
        for (n, c) in [("Not started", "gray"), ("In progress", "blue"), ("Done", "green")] { options.push(add_option(tx, &id, n, c)?); }
    }
    Ok(Prop { id, name, kind: kind.into(), options })
}

#[tauri::command]
pub fn create_database(db: State<'_, Db>, parent_id: Option<String>, title: String, initial_update: Vec<u8>) -> Result<Page, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    let title = if title.trim().is_empty() { "Untitled database" } else { title.trim() };
    let page = insert_page(&tx, parent_id, title, &initial_update)?;
    tx.execute("INSERT INTO databases(page_id) VALUES(?1)", [&page.id]).map_err(e)?;
    insert_property(&tx, &page.id, "Status", "status")?;
    tx.commit().map_err(e)?;
    Ok(page)
}

/// `None` when the page is not a database, so the UI can open it as a normal note.
#[tauri::command]
pub fn get_database(db: State<'_, Db>, page_id: String) -> Result<Option<DatabaseView>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    if !is_database(&c, &page_id)? { return Ok(None); }
    let mut options: HashMap<String, Vec<Opt>> = HashMap::new();
    {
        let mut s = c.prepare("SELECT o.property_id,o.id,o.name,o.color FROM db_options o JOIN db_properties p ON p.id=o.property_id WHERE p.database_id=?1 ORDER BY o.position").map_err(e)?;
        let rows = s.query_map([&page_id], |r| Ok((r.get::<_, String>(0)?, Opt { id: r.get(1)?, name: r.get(2)?, color: r.get(3)? }))).map_err(e)?;
        for row in rows { let (property, option) = row.map_err(e)?; options.entry(property).or_default().push(option); }
    }
    let properties = {
        let mut s = c.prepare("SELECT id,name,type FROM db_properties WHERE database_id=?1 AND deleted_at IS NULL ORDER BY position").map_err(e)?;
        let rows = s.query_map([&page_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e)?;
        let mut out = Vec::new();
        for row in rows { let (id, name, kind) = row.map_err(e)?; let opts = options.remove(&id).unwrap_or_default(); out.push(Prop { id, name, kind, options: opts }); }
        out
    };
    let mut rows: Vec<Row> = {
        let mut s = c.prepare("SELECT p.id,p.title FROM db_rows r JOIN pages p ON p.id=r.page_id WHERE r.database_id=?1 AND p.deleted_at IS NULL ORDER BY p.sort_key COLLATE BINARY,p.id").map_err(e)?;
        let it = s.query_map([&page_id], |r| Ok(Row { id: r.get(0)?, title: r.get(1)?, values: Map::new() })).map_err(e)?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?
    };
    let index: HashMap<String, usize> = rows.iter().enumerate().map(|(i, r)| (r.id.clone(), i)).collect();
    let mut s = c.prepare("SELECT v.row_id,v.property_id,v.value FROM db_values v JOIN db_properties p ON p.id=v.property_id WHERE p.database_id=?1 AND p.deleted_at IS NULL").map_err(e)?;
    let values = s.query_map([&page_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e)?;
    for v in values {
        let (row, property, json) = v.map_err(e)?;
        if let (Some(i), Ok(value)) = (index.get(&row), serde_json::from_str::<Value>(&json)) { rows[*i].values.insert(property, value); }
    }
    Ok(Some(DatabaseView { properties, rows }))
}

#[tauri::command]
pub fn add_property(db: State<'_, Db>, database_id: String, name: String, kind: String) -> Result<Prop, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    if !is_database(&conn, &database_id)? { return Err("Database not found".into()); }
    let tx = conn.transaction().map_err(e)?;
    let prop = insert_property(&tx, &database_id, &name, &kind)?;
    tx.commit().map_err(e)?;
    Ok(prop)
}

#[tauri::command]
pub fn rename_property(db: State<'_, Db>, property_id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let n = conn.execute("UPDATE db_properties SET name=?1 WHERE id=?2 AND deleted_at IS NULL", params![clean_name(&name)?, property_id]).map_err(e)?;
    if n != 1 { return Err("Property not found".into()); }
    Ok(())
}

/// Soft delete: the column disappears but its values stay in the file.
#[tauri::command]
pub fn delete_property(db: State<'_, Db>, property_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let n = conn.execute("UPDATE db_properties SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND deleted_at IS NULL", [property_id]).map_err(e)?;
    if n != 1 { return Err("Property not found".into()); }
    Ok(())
}

#[tauri::command]
pub fn add_select_option(db: State<'_, Db>, property_id: String, name: String, color: String) -> Result<Opt, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let kind: Option<String> = conn.query_row("SELECT type FROM db_properties WHERE id=?1 AND deleted_at IS NULL", [&property_id], |r| r.get(0)).optional().map_err(e)?;
    if !matches!(kind.as_deref(), Some("select" | "multi_select" | "status")) { return Err("This property has no options".into()); }
    let tx = conn.transaction().map_err(e)?;
    let option = add_option(&tx, &property_id, &name, &color)?;
    tx.commit().map_err(e)?;
    Ok(option)
}

#[tauri::command]
pub fn add_row(db: State<'_, Db>, database_id: String, initial_update: Vec<u8>) -> Result<Row, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    if !is_database(&conn, &database_id)? { return Err("Database not found".into()); }
    let tx = conn.transaction().map_err(e)?;
    let page = insert_page(&tx, Some(database_id.clone()), "Untitled", &initial_update)?;
    tx.execute("INSERT INTO db_rows(page_id,database_id) VALUES(?1,?2)", params![page.id, database_id]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(Row { id: page.id, title: page.title, values: Map::new() })
}

/// Check a value against its property type. `Ok(None)` means "clear the cell".
fn validate(tx: &Transaction<'_>, property: &str, kind: &str, value: &Value) -> Result<Option<String>, String> {
    let option_ok = |id: &Value| -> Result<bool, String> {
        let Some(id) = id.as_str() else { return Ok(false) };
        tx.query_row("SELECT EXISTS(SELECT 1 FROM db_options WHERE id=?1 AND property_id=?2)", params![id, property], |r| r.get(0)).map_err(e)
    };
    let bad = || Err(format!("Invalid value for a {kind} property"));
    match (kind, value) {
        (_, Value::Null) => return Ok(None),
        ("text", Value::String(s)) if s.is_empty() => return Ok(None),
        ("url", Value::String(s)) if s.is_empty() => return Ok(None),
        ("text", Value::String(s)) if s.chars().count() <= MAX_TEXT => {}
        ("url", Value::String(s)) if s.len() <= 2048 && !s.chars().any(char::is_whitespace) => {}
        ("number", Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {}
        ("checkbox", Value::Bool(_)) => {}
        ("date", Value::String(s)) if is_date(s) => {}
        ("select" | "status", v @ Value::String(_)) if option_ok(v)? => {}
        ("multi_select", Value::Array(items)) if items.len() <= 100 => {
            if items.is_empty() { return Ok(None); }
            for item in items { if !option_ok(item)? { return bad(); } }
        }
        _ => return bad(),
    }
    Ok(Some(value.to_string()))
}

/// `YYYY-MM-DD`, optionally followed by `THH:MM`. Calendar-valid days only.
fn is_date(s: &str) -> bool {
    let (day, time) = match s.split_once('T') { Some((d, t)) => (d, Some(t)), None => (s, None) };
    let parts: Vec<&str> = day.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 { return false; }
    let (Ok(y), Ok(m), Ok(d)) = (parts[0].parse::<i32>(), parts[1].parse::<u32>(), parts[2].parse::<u32>()) else { return false };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let max = match m { 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31, 4 | 6 | 9 | 11 => 30, 2 => if leap { 29 } else { 28 }, _ => return false };
    if d < 1 || d > max { return false; }
    match time {
        None => true,
        Some(t) => t.len() == 5 && t.as_bytes()[2] == b':' && t[..2].parse::<u32>().is_ok_and(|h| h < 24) && t[3..].parse::<u32>().is_ok_and(|m| m < 60),
    }
}

#[tauri::command]
pub fn set_value(db: State<'_, Db>, row_id: String, property_id: String, value: Value) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    let kind: String = tx.query_row(
        "SELECT p.type FROM db_properties p JOIN db_rows r ON r.database_id=p.database_id JOIN pages pg ON pg.id=r.page_id WHERE p.id=?1 AND r.page_id=?2 AND p.deleted_at IS NULL AND pg.deleted_at IS NULL",
        params![property_id, row_id], |r| r.get(0)).optional().map_err(e)?.ok_or("Row or property not found")?;
    match validate(&tx, &property_id, &kind, &value)? {
        Some(json) => { tx.execute("INSERT INTO db_values(row_id,property_id,value) VALUES(?1,?2,?3) ON CONFLICT(row_id,property_id) DO UPDATE SET value=excluded.value", params![row_id, property_id, json]).map_err(e)?; }
        None => { tx.execute("DELETE FROM db_values WHERE row_id=?1 AND property_id=?2", params![row_id, property_id]).map_err(e)?; }
    }
    tx.execute("UPDATE pages SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [&row_id]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(())
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
    #[test]
    fn values_are_validated_per_type_and_columns_soft_delete() {
        let mut c = fresh();
        let tx = c.transaction().unwrap();
        let database = insert_page(&tx, None, "Projects", &[1]).unwrap();
        tx.execute("INSERT INTO databases(page_id) VALUES(?1)", [&database.id]).unwrap();
        let status = insert_property(&tx, &database.id, "Status", "status").unwrap();
        assert_eq!(status.options.len(), 3);
        let number = insert_property(&tx, &database.id, "Hours", "number").unwrap();
        let tags = insert_property(&tx, &database.id, "Tags", "multi_select").unwrap();
        let tag = add_option(&tx, &tags.id, "Urgent", "red").unwrap();
        let other = insert_property(&tx, &database.id, "Other", "select").unwrap();
        let foreign = add_option(&tx, &other.id, "Elsewhere", "blue").unwrap();
        let date = insert_property(&tx, &database.id, "Due", "date").unwrap();
        assert!(insert_property(&tx, &database.id, "Bad", "formula").is_err());
        assert!(insert_property(&tx, &database.id, "  ", "text").is_err());
        let ok = |p: &Prop, v: Value| validate(&tx, &p.id, &p.kind, &v);
        assert_eq!(ok(&number, serde_json::json!(2.5)).unwrap().as_deref(), Some("2.5"));
        assert!(ok(&number, serde_json::json!("2")).is_err());
        assert_eq!(ok(&number, Value::Null).unwrap(), None);
        assert!(ok(&status, serde_json::json!(status.options[1].id)).unwrap().is_some());
        assert!(ok(&status, serde_json::json!(foreign.id)).is_err(), "option from another property");
        assert!(ok(&status, serde_json::json!("made-up")).is_err());
        assert!(ok(&tags, serde_json::json!([tag.id])).unwrap().is_some());
        assert_eq!(ok(&tags, serde_json::json!([])).unwrap(), None);
        assert!(ok(&tags, serde_json::json!([tag.id, "nope"])).is_err());
        assert!(ok(&date, serde_json::json!("2026-02-30")).is_err());
        assert!(ok(&date, serde_json::json!("2026-11-10")).is_ok());
        // Rows are hidden children; deleting a column keeps its values.
        let row = insert_page(&tx, Some(database.id.clone()), "Row", &[1]).unwrap();
        tx.execute("INSERT INTO db_rows(page_id,database_id) VALUES(?1,?2)", params![row.id, database.id]).unwrap();
        tx.execute("INSERT INTO db_values(row_id,property_id,value) VALUES(?1,?2,'3')", params![row.id, number.id]).unwrap();
        tx.execute("UPDATE db_properties SET deleted_at='x' WHERE id=?1", [&number.id]).unwrap();
        let kept: i64 = tx.query_row("SELECT COUNT(*) FROM db_values WHERE property_id=?1", [&number.id], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1);
        tx.commit().unwrap();
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }
    #[test]
    fn dates_are_calendar_checked() {
        for ok in ["2026-11-10", "2024-02-29", "2026-11-10T09:30"] { assert!(is_date(ok), "{ok}"); }
        for bad in ["2026-02-30", "2025-02-29", "2026-13-01", "26-11-10", "2026-11-10T24:00", "2026-11-10T9:30", "", "2026/11/10"] { assert!(!is_date(bad), "{bad}"); }
    }
}
