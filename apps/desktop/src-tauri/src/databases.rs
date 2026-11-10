//! Notion-style databases (ADR-003). A database is a page with a row in `databases`; its rows are child
//! pages listed in `db_rows`. Every write validates the value against the property type here, never in the UI.
use crate::{insert_page, Db, Page};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

const TYPES: [&str; 15] = ["text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "place", "email", "phone", "created_time", "last_edited_time", "relation", "rollup"];
/// Filled in from the row page itself; never stored in db_values and never edited by hand.
fn is_computed(kind: &str) -> bool { matches!(kind, "created_time" | "last_edited_time" | "rollup") }
/// Created through their own forms (they need a target), never through the plain "add property" path.
fn needs_setup(kind: &str) -> bool { matches!(kind, "relation" | "rollup") }
fn email_ok(s: &str) -> bool { s.len() <= 320 && !s.chars().any(char::is_whitespace) && s.split_once('@').is_some_and(|(a, b)| !a.is_empty() && b.contains('.') && !b.starts_with('.') && !b.ends_with('.')) }
fn phone_ok(s: &str) -> bool { s.len() <= 40 && s.chars().any(|c| c.is_ascii_digit()) && s.chars().all(|c| c.is_ascii_digit() || "+-() .#*".contains(c)) }
const COLORS: [&str; 9] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const MAX_TEXT: usize = 10_000;

#[derive(Serialize)]
pub struct Opt { id: String, name: String, color: String }
#[derive(Serialize)]
pub struct Prop { id: String, name: String, #[serde(rename = "type")] kind: String, options: Vec<Opt>, config: Value }
#[derive(Serialize)]
pub struct Row { id: String, title: String, values: Map<String, Value> }
#[derive(Serialize)]
pub struct View { id: String, name: String, #[serde(rename = "type")] kind: String, config: Value }
#[derive(Serialize)]
pub struct DatabaseView { title: String, properties: Vec<Prop>, rows: Vec<Row>, views: Vec<View>, linked: HashMap<String, String> }
#[derive(Serialize)]
pub struct Brief { id: String, title: String }

const VIEW_TYPES: [&str; 7] = ["table", "board", "list", "gallery", "calendar", "timeline", "map"];
const FILTER_OPS: [&str; 14] = ["contains", "not_contains", "is", "is_not", "empty", "not_empty", "gt", "lt", "gte", "lte", "before", "after", "checked", "unchecked"];
const CALC_FNS: [&str; 17] = ["count", "count_values", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty", "sum", "average", "min", "max", "median", "range", "earliest", "latest", "checked", "unchecked", "percent_checked"];

/// View settings (which property groups a board, sorts, filters, hidden columns, ...). They name properties by id,
/// so every id must belong to this database, and every operator/function must be one we implement.
fn clean_config(c: &Connection, database: &str, config: &Value) -> Result<String, String> {
    let Value::Object(map) = config else { return Err("View settings must be an object".into()) };
    let known = |id: &Value| -> Result<String, String> {
        let Some(id) = id.as_str() else { return Err("Invalid view setting".into()) };
        let ok: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM db_properties WHERE id=?1 AND database_id=?2 AND deleted_at IS NULL)", params![id, database], |r| r.get(0)).map_err(e)?;
        if ok { Ok(id.to_string()) } else { Err("View setting refers to a property that is not in this database".into()) }
    };
    let mut out = Map::new();
    for (key, value) in map {
        if value.is_null() { continue; }
        match key.as_str() {
            "groupBy" | "dateBy" | "endBy" | "placeBy" | "frozen" => { out.insert(key.clone(), Value::String(known(value)?)); }
            "filterMode" => { if !matches!(value.as_str(), Some("and" | "or")) { return Err("Invalid filter mode".into()); } out.insert(key.clone(), value.clone()); }
            "widths" => {
                let Value::Object(m) = value else { return Err("Invalid column widths".into()) };
                if m.len() > 200 { return Err("Too many column widths".into()); }
                let mut widths = Map::new();
                for (property, width) in m {
                    let w = width.as_f64().filter(|w| w.is_finite() && (60.0..=800.0).contains(w)).ok_or("Invalid column width")?;
                    let id = if property == "title" { property.clone() } else { known(&Value::String(property.clone()))? };
                    widths.insert(id, Value::from(w.round()));
                }
                out.insert(key.clone(), Value::Object(widths));
            }
            "hidden" | "wrap" => {
                let Value::Array(items) = value else { return Err("Invalid view setting".into()) };
                if items.len() > 200 { return Err("Too many columns in a view setting".into()); }
                out.insert(key.clone(), Value::Array(items.iter().map(|v| known(v).map(Value::String)).collect::<Result<_, _>>()?));
            }
            "sorts" => {
                let Value::Array(items) = value else { return Err("Invalid sort".into()) };
                if items.len() > 5 { return Err("A view can have at most 5 sorts".into()); }
                let mut list = Vec::new();
                for item in items {
                    let Value::Object(m) = item else { return Err("Invalid sort".into()) };
                    let dir = m.get("dir").and_then(Value::as_str).unwrap_or("");
                    if m.keys().any(|k| k != "p" && k != "dir") || !matches!(dir, "asc" | "desc") { return Err("Invalid sort".into()); }
                    list.push(serde_json::json!({ "p": known(m.get("p").unwrap_or(&Value::Null))?, "dir": dir }));
                }
                out.insert(key.clone(), Value::Array(list));
            }
            "filters" => {
                let Value::Array(items) = value else { return Err("Invalid filter".into()) };
                if items.len() > 10 { return Err("A view can have at most 10 filters".into()); }
                let mut list = Vec::new();
                for item in items {
                    let Value::Object(m) = item else { return Err("Invalid filter".into()) };
                    let op = m.get("op").and_then(Value::as_str).unwrap_or("");
                    if m.keys().any(|k| !matches!(k.as_str(), "p" | "op" | "v")) || !FILTER_OPS.contains(&op) { return Err("Invalid filter".into()); }
                    let v = m.get("v").cloned().unwrap_or(Value::Null);
                    let v_ok = match &v { Value::Null | Value::Bool(_) => true, Value::Number(n) => n.as_f64().is_some_and(f64::is_finite), Value::String(t) => t.chars().count() <= 500, Value::Array(a) => a.len() <= 100 && a.iter().all(|x| x.as_str().is_some_and(|t| t.chars().count() <= 100)), _ => false };
                    if !v_ok { return Err("Invalid filter value".into()); }
                    list.push(serde_json::json!({ "p": known(m.get("p").unwrap_or(&Value::Null))?, "op": op, "v": v }));
                }
                out.insert(key.clone(), Value::Array(list));
            }
            "calc" => {
                let Value::Object(m) = value else { return Err("Invalid calculation".into()) };
                if m.len() > 200 { return Err("Too many calculations".into()); }
                let mut calc = Map::new();
                for (property, function) in m {
                    let f = function.as_str().unwrap_or("");
                    if !CALC_FNS.contains(&f) { return Err("Unknown calculation".into()); }
                    calc.insert(known(&Value::String(property.clone()))?, Value::String(f.into()));
                }
                out.insert(key.clone(), Value::Object(calc));
            }
            _ => return Err("Unknown view setting".into()),
        }
    }
    Ok(Value::Object(out).to_string())
}
fn insert_view(c: &Connection, database: &str, name: &str, kind: &str, config: &str) -> Result<View, String> {
    if !VIEW_TYPES.contains(&kind) { return Err("Unsupported view type".into()); }
    let name = clean_name(name)?;
    let position: i64 = c.query_row("SELECT COALESCE(MAX(position),0)+1 FROM db_views WHERE database_id=?1", [database], |r| r.get(0)).map_err(e)?;
    let id = Uuid::new_v4().to_string();
    c.execute("INSERT INTO db_views(id,database_id,name,type,position,config) VALUES(?1,?2,?3,?4,?5,?6)", params![id, database, name, kind, position, config]).map_err(e)?;
    Ok(View { id, name, kind: kind.into(), config: serde_json::from_str(config).unwrap_or(Value::Null) })
}

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
    insert_property_at(tx, database, name, kind, None)
}
/// `at` is a 1-based position; later columns shift right to make room.
fn insert_property_at(tx: &Transaction<'_>, database: &str, name: &str, kind: &str, at: Option<i64>) -> Result<Prop, String> {
    if !TYPES.contains(&kind) { return Err("Unsupported property type".into()); }
    let name = clean_name(name)?;
    let position: i64 = match at {
        Some(at) => { tx.execute("UPDATE db_properties SET position=position+1 WHERE database_id=?1 AND position>=?2", params![database, at]).map_err(e)?; at }
        None => tx.query_row("SELECT COALESCE(MAX(position),0)+1 FROM db_properties WHERE database_id=?1", [database], |r| r.get(0)).map_err(e)?,
    };
    let id = Uuid::new_v4().to_string();
    tx.execute("INSERT INTO db_properties(id,database_id,name,type,position) VALUES(?1,?2,?3,?4,?5)", params![id, database, name, kind, position]).map_err(e)?;
    let mut options = Vec::new();
    if kind == "status" {
        for (n, c) in [("Not started", "gray"), ("In progress", "blue"), ("Done", "green")] { options.push(add_option(tx, &id, n, c)?); }
    }
    Ok(Prop { id, name, kind: kind.into(), options, config: Value::Object(Map::new()) })
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
    insert_view(&tx, &page.id, "Table", "table", "{}")?;
    tx.commit().map_err(e)?;
    Ok(page)
}

const ROLLUP_FNS: [&str; 18] = ["count", "count_values", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty", "sum", "average", "min", "max", "median", "range", "earliest", "latest", "checked", "unchecked", "percent_checked", "show_original"];
fn blank(v: &Value) -> bool { v.is_null() || v.as_str().is_some_and(str::is_empty) || v.as_array().is_some_and(Vec::is_empty) }
fn num_text(n: f64) -> String { let r = (n * 100.0).round() / 100.0; if r.fract() == 0.0 { format!("{}", r as i64) } else { format!("{r}") } }
fn pct(part: usize, whole: usize) -> String { if whole == 0 { "0%".into() } else { format!("{}%", ((part as f64 / whole as f64) * 100.0).round() as i64) } }

/// One rollup cell: `values` are the target property's values on the related rows (`None` for rows that have no value).
fn rollup_text(function: &str, values: &[Value], names: &HashMap<String, String>) -> String {
    let filled: Vec<&Value> = values.iter().filter(|v| !blank(v)).collect();
    let numbers: Vec<f64> = filled.iter().filter_map(|v| v.as_f64()).collect();
    let days: Vec<&str> = filled.iter().filter_map(|v| v.as_str()).filter(|t| t.len() >= 10 && t.as_bytes()[4] == b'-').map(|t| &t[..10]).collect();
    match function {
        "count" => values.len().to_string(),
        "count_values" | "count_not_empty" => filled.len().to_string(),
        "count_empty" => (values.len() - filled.len()).to_string(),
        "percent_empty" => pct(values.len() - filled.len(), values.len()),
        "percent_not_empty" => pct(filled.len(), values.len()),
        "sum" => num_text(numbers.iter().sum()),
        "average" => if numbers.is_empty() { String::new() } else { num_text(numbers.iter().sum::<f64>() / numbers.len() as f64) },
        "min" => numbers.iter().cloned().reduce(f64::min).map(num_text).unwrap_or_default(),
        "max" => numbers.iter().cloned().reduce(f64::max).map(num_text).unwrap_or_default(),
        "median" => { if numbers.is_empty() { return String::new(); } let mut n = numbers.clone(); n.sort_by(|a, b| a.total_cmp(b)); let m = n.len() / 2; num_text(if n.len() % 2 == 1 { n[m] } else { (n[m - 1] + n[m]) / 2.0 }) }
        "range" => match (numbers.iter().cloned().reduce(f64::min), numbers.iter().cloned().reduce(f64::max)) { (Some(a), Some(b)) => num_text(b - a), _ => String::new() },
        "earliest" => days.iter().min().map(|d| d.to_string()).unwrap_or_default(),
        "latest" => days.iter().max().map(|d| d.to_string()).unwrap_or_default(),
        "checked" => values.iter().filter(|v| v.as_bool() == Some(true)).count().to_string(),
        "unchecked" => values.iter().filter(|v| v.as_bool() != Some(true)).count().to_string(),
        "percent_checked" => pct(values.iter().filter(|v| v.as_bool() == Some(true)).count(), values.len()),
        "show_original" => {
            let show = |v: &Value| -> Vec<String> { match v { Value::String(t) => vec![names.get(t).cloned().unwrap_or_else(|| t.clone())], Value::Array(a) => a.iter().filter_map(Value::as_str).map(|t| names.get(t).cloned().unwrap_or_else(|| t.to_string())).collect(), Value::Number(n) => vec![n.to_string()], Value::Bool(b) => vec![if *b { "Yes".into() } else { "No".into() }], _ => vec![] } };
            filled.iter().flat_map(|v| show(v)).collect::<Vec<_>>().join(", ")
        }
        _ => String::new(),
    }
}

/// Relation cells (lists of related page ids), rollup cells (computed text) and the titles of linked pages.
fn fill_relations_and_rollups(c: &Connection, database: &str, properties: &[Prop], index: &HashMap<String, usize>, rows: &mut [Row]) -> Result<HashMap<String, String>, String> {
    let mut linked = HashMap::new();
    // property id -> row -> related page ids (in the order they were linked)
    let mut related: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
    {
        let mut st = c.prepare("SELECT rel.property_id,rel.from_row,rel.to_page,pg.title FROM db_relations rel JOIN pages pg ON pg.id=rel.to_page JOIN db_properties pr ON pr.id=rel.property_id WHERE pr.database_id=?1 AND pg.deleted_at IS NULL ORDER BY rel.rowid").map_err(e)?;
        let it = st.query_map([database], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))).map_err(e)?;
        for item in it { let (property, row, to, title) = item.map_err(e)?; related.entry(property).or_default().entry(row).or_default().push(to.clone()); linked.insert(to, title); }
    }
    for property in properties.iter().filter(|p| p.kind == "relation") {
        for (row, ids) in related.get(&property.id).into_iter().flatten() {
            if let Some(i) = index.get(row) { rows[*i].values.insert(property.id.clone(), Value::Array(ids.iter().cloned().map(Value::String).collect())); }
        }
    }
    for property in properties.iter().filter(|p| p.kind == "rollup") {
        let (Some(relation), Some(target), Some(function)) = (property.config.get("relation").and_then(Value::as_str), property.config.get("property").and_then(Value::as_str), property.config.get("fn").and_then(Value::as_str)) else { continue };
        let mut stored: HashMap<String, Value> = HashMap::new();
        let mut names: HashMap<String, String> = HashMap::new();
        if target != "title" {
            let mut st = c.prepare("SELECT row_id,value FROM db_values WHERE property_id=?1").map_err(e)?;
            let it = st.query_map([target], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
            for item in it { let (row, json) = item.map_err(e)?; if let Ok(v) = serde_json::from_str::<Value>(&json) { stored.insert(row, v); } }
            let mut st = c.prepare("SELECT id,name FROM db_options WHERE property_id=?1").map_err(e)?;
            let it = st.query_map([target], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
            for item in it { let (id, name) = item.map_err(e)?; names.insert(id, name); }
        }
        for (row, i) in index {
            let ids = related.get(relation).and_then(|m| m.get(row)).cloned().unwrap_or_default();
            let values: Vec<Value> = ids.iter().map(|id| if target == "title" { Value::String(linked.get(id).cloned().unwrap_or_default()) } else { stored.get(id).cloned().unwrap_or(Value::Null) }).collect();
            rows[*i].values.insert(property.id.clone(), Value::String(rollup_text(function, &values, &names)));
        }
    }
    Ok(linked)
}

/// Replace one row's links for a relation property, keeping the other side of a two-way relation in step.
fn set_relation(tx: &Transaction<'_>, property: &str, config: &Value, row: &str, ids: &[String]) -> Result<(), String> {
    let target = config.get("target").and_then(Value::as_str).ok_or("This relation has no target database")?;
    let reverse = config.get("reverse").and_then(Value::as_str);
    let mut wanted: Vec<String> = Vec::new();
    for id in ids {
        let ok: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM db_rows r JOIN pages p ON p.id=r.page_id WHERE r.page_id=?1 AND r.database_id=?2 AND p.deleted_at IS NULL)", params![id, target], |r| r.get(0)).map_err(e)?;
        if !ok { return Err("A linked page is not a row of the related database".into()); }
        if !wanted.contains(id) { wanted.push(id.clone()); }
    }
    let current: Vec<String> = {
        let mut st = tx.prepare("SELECT to_page FROM db_relations WHERE property_id=?1 AND from_row=?2").map_err(e)?;
        let it = st.query_map(params![property, row], |r| r.get(0)).map_err(e)?;
        it.collect::<rusqlite::Result<_>>().map_err(e)?
    };
    for gone in current.iter().filter(|c| !wanted.contains(c)) {
        tx.execute("DELETE FROM db_relations WHERE property_id=?1 AND from_row=?2 AND to_page=?3", params![property, row, gone]).map_err(e)?;
        if let Some(rev) = reverse { tx.execute("DELETE FROM db_relations WHERE property_id=?1 AND from_row=?2 AND to_page=?3", params![rev, gone, row]).map_err(e)?; }
    }
    for added in wanted.iter().filter(|w| !current.contains(w)) {
        tx.execute("INSERT INTO db_relations(property_id,from_row,to_page) VALUES(?1,?2,?3)", params![property, row, added]).map_err(e)?;
        if let Some(rev) = reverse { tx.execute("INSERT OR IGNORE INTO db_relations(property_id,from_row,to_page) VALUES(?1,?2,?3)", params![rev, added, row]).map_err(e)?; }
    }
    Ok(())
}

#[tauri::command]
pub fn list_databases(db: State<'_, Db>) -> Result<Vec<Brief>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let mut s = c.prepare("SELECT p.id,p.title FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.deleted_at IS NULL ORDER BY p.title COLLATE NOCASE").map_err(e)?;
    let it = s.query_map([], |r| Ok(Brief { id: r.get(0)?, title: r.get(1)? })).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[tauri::command]
pub fn list_rows(db: State<'_, Db>, database_id: String) -> Result<Vec<Brief>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let mut s = c.prepare("SELECT p.id,p.title FROM db_rows r JOIN pages p ON p.id=r.page_id WHERE r.database_id=?1 AND p.deleted_at IS NULL ORDER BY p.sort_key COLLATE BINARY,p.id").map_err(e)?;
    let it = s.query_map([&database_id], |r| Ok(Brief { id: r.get(0)?, title: r.get(1)? })).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

/// Create a relation column, and with `two_way` its mirror column in the related database.
#[tauri::command]
pub fn add_relation(db: State<'_, Db>, database_id: String, name: String, target_id: String, two_way: bool) -> Result<Prop, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    if !is_database(&conn, &database_id)? || !is_database(&conn, &target_id)? { return Err("Database not found".into()); }
    let tx = conn.transaction().map_err(e)?;
    let mut forward = insert_property_at(&tx, &database_id, &name, "relation", None)?;
    let mut config = serde_json::json!({ "target": target_id, "reverse": null });
    if two_way {
        let own_title: String = tx.query_row("SELECT title FROM pages WHERE id=?1", [&database_id], |r| r.get(0)).map_err(e)?;
        let mirror_name: String = own_title.chars().take(100).collect();
        let mirror = insert_property_at(&tx, &target_id, if mirror_name.trim().is_empty() { "Related" } else { &mirror_name }, "relation", None)?;
        tx.execute("UPDATE db_properties SET config=?1 WHERE id=?2", params![serde_json::json!({ "target": database_id, "reverse": forward.id }).to_string(), mirror.id]).map_err(e)?;
        config["reverse"] = Value::String(mirror.id);
    }
    tx.execute("UPDATE db_properties SET config=?1 WHERE id=?2", params![config.to_string(), forward.id]).map_err(e)?;
    forward.config = config;
    tx.commit().map_err(e)?;
    Ok(forward)
}

/// Create a rollup column that summarises one property of the pages linked through a relation column.
#[tauri::command]
pub fn add_rollup(db: State<'_, Db>, database_id: String, name: String, relation_id: String, property: String, function: String) -> Result<Prop, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    if !ROLLUP_FNS.contains(&function.as_str()) { return Err("Unknown rollup function".into()); }
    if !is_database(&conn, &database_id)? { return Err("Database not found".into()); }
    let tx = conn.transaction().map_err(e)?;
    let config: String = tx.query_row("SELECT config FROM db_properties WHERE id=?1 AND database_id=?2 AND type='relation' AND deleted_at IS NULL", params![relation_id, database_id], |r| r.get(0)).optional().map_err(e)?.ok_or("Choose a relation column in this database")?;
    let target = serde_json::from_str::<Value>(&config).ok().and_then(|v| v.get("target").and_then(Value::as_str).map(str::to_string)).ok_or("The relation has no target")?;
    if property != "title" {
        let ok: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM db_properties WHERE id=?1 AND database_id=?2 AND deleted_at IS NULL AND type NOT IN ('relation','rollup','created_time','last_edited_time'))", params![property, target], |r| r.get(0)).map_err(e)?;
        if !ok { return Err("Choose a property of the related database".into()); }
    }
    let mut prop = insert_property_at(&tx, &database_id, &name, "rollup", None)?;
    let config = serde_json::json!({ "relation": relation_id, "property": property, "fn": function });
    tx.execute("UPDATE db_properties SET config=?1 WHERE id=?2", params![config.to_string(), prop.id]).map_err(e)?;
    prop.config = config;
    tx.commit().map_err(e)?;
    Ok(prop)
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
        let mut s = c.prepare("SELECT id,name,type,config FROM db_properties WHERE database_id=?1 AND deleted_at IS NULL ORDER BY position").map_err(e)?;
        let rows = s.query_map([&page_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))).map_err(e)?;
        let mut out = Vec::new();
        for row in rows { let (id, name, kind, config) = row.map_err(e)?; let opts = options.remove(&id).unwrap_or_default(); out.push(Prop { id, name, kind, options: opts, config: serde_json::from_str(&config).unwrap_or(Value::Null) }); }
        out
    };
    let mut rows: Vec<Row> = {
        let mut s = c.prepare("SELECT p.id,p.title FROM db_rows r JOIN pages p ON p.id=r.page_id WHERE r.database_id=?1 AND p.deleted_at IS NULL ORDER BY p.sort_key COLLATE BINARY,p.id").map_err(e)?;
        let it = s.query_map([&page_id], |r| Ok(Row { id: r.get(0)?, title: r.get(1)?, values: Map::new() })).map_err(e)?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?
    };
    let index: HashMap<String, usize> = rows.iter().enumerate().map(|(i, r)| (r.id.clone(), i)).collect();
    let computed: Vec<(String, String)> = properties.iter().filter(|p| matches!(p.kind.as_str(), "created_time" | "last_edited_time")).map(|p| (p.id.clone(), p.kind.clone())).collect();
    if !computed.is_empty() {
        let mut st = c.prepare("SELECT r.page_id,p.created_at,p.updated_at FROM db_rows r JOIN pages p ON p.id=r.page_id WHERE r.database_id=?1").map_err(e)?;
        let times = st.query_map([&page_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e)?;
        for t in times {
            let (row, created, edited) = t.map_err(e)?;
            if let Some(i) = index.get(&row) { for (id, kind) in &computed { rows[*i].values.insert(id.clone(), Value::String(if kind == "created_time" { created.clone() } else { edited.clone() })); } }
        }
    }
    let mut s = c.prepare("SELECT v.row_id,v.property_id,v.value FROM db_values v JOIN db_properties p ON p.id=v.property_id WHERE p.database_id=?1 AND p.deleted_at IS NULL").map_err(e)?;
    let values = s.query_map([&page_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(e)?;
    for v in values {
        let (row, property, json) = v.map_err(e)?;
        if let (Some(i), Ok(value)) = (index.get(&row), serde_json::from_str::<Value>(&json)) { rows[*i].values.insert(property, value); }
    }
    let linked = fill_relations_and_rollups(&c, &page_id, &properties, &index, &mut rows)?;
    let views = {
        let mut s = c.prepare("SELECT id,name,type,config FROM db_views WHERE database_id=?1 AND deleted_at IS NULL ORDER BY position").map_err(e)?;
        let it = s.query_map([&page_id], |r| Ok(View { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, config: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null) })).map_err(e)?;
        it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?
    };
    let title: String = c.query_row("SELECT title FROM pages WHERE id=?1", [&page_id], |r| r.get(0)).map_err(e)?;
    Ok(Some(DatabaseView { title, properties, rows, views, linked }))
}

#[tauri::command]
pub fn add_property(db: State<'_, Db>, database_id: String, name: String, kind: String, near: Option<String>, side: Option<String>) -> Result<Prop, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    if !is_database(&conn, &database_id)? { return Err("Database not found".into()); }
    if needs_setup(&kind) { return Err("Relations and rollups are created from their own form".into()); }
    let tx = conn.transaction().map_err(e)?;
    let at = match near {
        Some(id) => {
            let position: i64 = tx.query_row("SELECT position FROM db_properties WHERE id=?1 AND database_id=?2", params![id, database_id], |r| r.get(0)).optional().map_err(e)?.ok_or("Property not found")?;
            Some(if side.as_deref() == Some("left") { position } else { position + 1 })
        }
        None => None,
    };
    let prop = insert_property_at(&tx, &database_id, &name, &kind, at)?;
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

/// Convert one stored value to another property type; `None` means it cannot be converted without losing it.
fn convert_value(from: &str, to: &str, value: &Value) -> Option<Value> {
    let select_like = |k: &str| matches!(k, "select" | "status");
    match (from, to) {
        (a, b) if a == b => Some(value.clone()),
        (a, "text") if matches!(a, "url" | "email" | "phone") => Some(value.clone()),
        (a, "url") if matches!(a, "text" | "email") => value.as_str().filter(|t| t.len() <= 2048 && !t.chars().any(char::is_whitespace)).map(|_| value.clone()),
        (a, "email") if matches!(a, "text" | "url") => value.as_str().filter(|t| email_ok(t)).map(|_| value.clone()),
        (a, "phone") if matches!(a, "text" | "url") => value.as_str().filter(|t| phone_ok(t)).map(|_| value.clone()),
        ("number", "text") => value.as_f64().map(|n| Value::String(n.to_string())),
        ("date", "text") => Some(value.clone()),
        (a, b) if select_like(a) && select_like(b) => Some(value.clone()),
        (a, "multi_select") if select_like(a) => Some(Value::Array(vec![value.clone()])),
        ("multi_select", b) if select_like(b) => match value.as_array() { Some(items) if items.len() == 1 => Some(items[0].clone()), _ => None },
        _ => None,
    }
}

/// Change a column's type. Existing values are converted when that loses nothing; otherwise the change is refused
/// (with the number of values that would not fit) rather than silently dropping data. Empty columns can become anything.
#[tauri::command]
pub fn change_property_type(db: State<'_, Db>, property_id: String, kind: String) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    if !TYPES.contains(&kind.as_str()) { return Err("Unsupported property type".into()); }
    let tx = conn.transaction().map_err(e)?;
    let from: String = tx.query_row("SELECT type FROM db_properties WHERE id=?1 AND deleted_at IS NULL", [&property_id], |r| r.get(0)).optional().map_err(e)?.ok_or("Property not found")?;
    if from == kind { return Ok(()); }
    if needs_setup(&from) || needs_setup(&kind) { return Err("Relations and rollups cannot be converted to or from another type".into()); }
    let rows: Vec<(String, String)> = {
        let mut s = tx.prepare("SELECT row_id,value FROM db_values WHERE property_id=?1").map_err(e)?;
        let it = s.query_map([&property_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        it.collect::<rusqlite::Result<_>>().map_err(e)?
    };
    let mut converted = Vec::new();
    let mut blocked = 0;
    for (row, json) in &rows {
        match serde_json::from_str::<Value>(json).ok().and_then(|v| convert_value(&from, &kind, &v)) {
            Some(v) => converted.push((row.clone(), v.to_string())),
            None => blocked += 1,
        }
    }
    if blocked > 0 { return Err(format!("{blocked} value(s) cannot be converted to {kind} without losing them. Clear them first, or duplicate the column and change the copy.")); }
    for (row, json) in converted { tx.execute("UPDATE db_values SET value=?1 WHERE row_id=?2 AND property_id=?3", params![json, row, property_id]).map_err(e)?; }
    tx.execute("UPDATE db_properties SET type=?1 WHERE id=?2", params![kind, property_id]).map_err(e)?;
    tx.commit().map_err(e)
}

/// Copy a column next to the original, with its options and values (inside the caller's transaction).
fn copy_property(tx: &Transaction<'_>, property_id: &str) -> Result<Prop, String> {
    let (database, name, kind, position): (String, String, String, i64) = tx.query_row("SELECT database_id,name,type,position FROM db_properties WHERE id=?1 AND deleted_at IS NULL", [property_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional().map_err(e)?.ok_or("Property not found")?;
    if needs_setup(&kind) { return Err("Relations and rollups cannot be duplicated yet".into()); }
    let copy_name: String = format!("{name} copy").chars().take(100).collect();
    let mut copy = insert_property_at(tx, &database, &copy_name, &kind, Some(position + 1))?;
    // insert_property seeds Status options; replace them with exact copies of the original's.
    tx.execute("DELETE FROM db_options WHERE property_id=?1", [&copy.id]).map_err(e)?;
    copy.options.clear();
    let mut map: HashMap<String, String> = HashMap::new();
    let originals: Vec<(String, String, String, i64)> = {
        let mut s = tx.prepare("SELECT id,name,color,position FROM db_options WHERE property_id=?1 ORDER BY position").map_err(e)?;
        let it = s.query_map([property_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(e)?;
        it.collect::<rusqlite::Result<_>>().map_err(e)?
    };
    for (old, option_name, color, pos) in originals {
        let id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO db_options(id,property_id,name,color,position) VALUES(?1,?2,?3,?4,?5)", params![id, copy.id, option_name, color, pos]).map_err(e)?;
        map.insert(old, id.clone());
        copy.options.push(Opt { id, name: option_name, color });
    }
    let values: Vec<(String, String)> = {
        let mut s = tx.prepare("SELECT row_id,value FROM db_values WHERE property_id=?1").map_err(e)?;
        let it = s.query_map([property_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        it.collect::<rusqlite::Result<_>>().map_err(e)?
    };
    for (row, json) in values {
        let Ok(mut value) = serde_json::from_str::<Value>(&json) else { continue };
        let remap = |v: &Value| v.as_str().and_then(|id| map.get(id)).map(|n| Value::String(n.clone()));
        match (&kind[..], &value) {
            ("select" | "status", v) => { match remap(v) { Some(n) => value = n, None => continue } }
            ("multi_select", Value::Array(items)) => value = Value::Array(items.iter().filter_map(remap).collect()),
            _ => {}
        }
        tx.execute("INSERT INTO db_values(row_id,property_id,value) VALUES(?1,?2,?3)", params![row, copy.id, value.to_string()]).map_err(e)?;
    }
    Ok(copy)
}

/// Copy a column next to the original, with its options and values.
#[tauri::command]
pub fn duplicate_property(db: State<'_, Db>, property_id: String) -> Result<Prop, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    let copy = copy_property(&tx, &property_id)?;
    tx.commit().map_err(e)?;
    Ok(copy)
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
pub fn add_view(db: State<'_, Db>, database_id: String, name: String, kind: String, config: Value) -> Result<View, String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    if !is_database(&conn, &database_id)? { return Err("Database not found".into()); }
    let tx = conn.transaction().map_err(e)?;
    let json = clean_config(&tx, &database_id, &config)?;
    let view = insert_view(&tx, &database_id, &name, &kind, &json)?;
    tx.commit().map_err(e)?;
    Ok(view)
}

#[tauri::command]
pub fn update_view(db: State<'_, Db>, view_id: String, name: Option<String>, config: Option<Value>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    let database: String = tx.query_row("SELECT database_id FROM db_views WHERE id=?1 AND deleted_at IS NULL", [&view_id], |r| r.get(0)).optional().map_err(e)?.ok_or("View not found")?;
    if let Some(name) = name { tx.execute("UPDATE db_views SET name=?1 WHERE id=?2", params![clean_name(&name)?, view_id]).map_err(e)?; }
    if let Some(config) = config { let json = clean_config(&tx, &database, &config)?; tx.execute("UPDATE db_views SET config=?1 WHERE id=?2", params![json, view_id]).map_err(e)?; }
    tx.commit().map_err(e)
}

/// Soft delete; the last remaining view cannot be removed.
#[tauri::command]
pub fn delete_view(db: State<'_, Db>, view_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let database: String = conn.query_row("SELECT database_id FROM db_views WHERE id=?1 AND deleted_at IS NULL", [&view_id], |r| r.get(0)).optional().map_err(e)?.ok_or("View not found")?;
    let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM db_views WHERE database_id=?1 AND deleted_at IS NULL", [&database], |r| r.get(0)).map_err(e)?;
    if remaining <= 1 { return Err("A database needs at least one view".into()); }
    conn.execute("UPDATE db_views SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [view_id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn update_select_option(db: State<'_, Db>, option_id: String, name: Option<String>, color: Option<String>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM db_options WHERE id=?1)", [&option_id], |r| r.get(0)).map_err(e)?;
    if !exists { return Err("Option not found".into()); }
    if let Some(name) = name { tx.execute("UPDATE db_options SET name=?1 WHERE id=?2", params![clean_name(&name)?, option_id]).map_err(e)?; }
    if let Some(color) = color { if !COLORS.contains(&color.as_str()) { return Err("Unknown colour".into()); } tx.execute("UPDATE db_options SET color=?1 WHERE id=?2", params![color, option_id]).map_err(e)?; }
    tx.commit().map_err(e)
}

/// Removes the option and clears it from every row that used it (other options on those rows are kept).
#[tauri::command]
pub fn delete_select_option(db: State<'_, Db>, option_id: String) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    let tx = conn.transaction().map_err(e)?;
    let property: String = tx.query_row("SELECT property_id FROM db_options WHERE id=?1", [&option_id], |r| r.get(0)).optional().map_err(e)?.ok_or("Option not found")?;
    let rows: Vec<(String, String)> = {
        let mut st = tx.prepare("SELECT row_id,value FROM db_values WHERE property_id=?1").map_err(e)?;
        let it = st.query_map([&property], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        it.collect::<rusqlite::Result<_>>().map_err(e)?
    };
    for (row, json) in rows {
        let Ok(value) = serde_json::from_str::<Value>(&json) else { continue };
        let next = match &value {
            Value::String(id) if *id == option_id => None,
            Value::Array(items) => { let kept: Vec<Value> = items.iter().filter(|v| v.as_str() != Some(option_id.as_str())).cloned().collect(); if kept.len() == items.len() { continue } else if kept.is_empty() { None } else { Some(Value::Array(kept)) } }
            _ => continue,
        };
        match next {
            Some(v) => { tx.execute("UPDATE db_values SET value=?1 WHERE row_id=?2 AND property_id=?3", params![v.to_string(), row, property]).map_err(e)?; }
            None => { tx.execute("DELETE FROM db_values WHERE row_id=?1 AND property_id=?2", params![row, property]).map_err(e)?; }
        }
    }
    tx.execute("DELETE FROM db_options WHERE id=?1", [&option_id]).map_err(e)?;
    tx.commit().map_err(e)
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
        (k, _) if is_computed(k) => return Err("This property is filled in automatically".into()),
        (_, Value::Null) => return Ok(None),
        ("text", Value::String(s)) if s.is_empty() => return Ok(None),
        ("url", Value::String(s)) if s.is_empty() => return Ok(None),
        ("text", Value::String(s)) if s.chars().count() <= MAX_TEXT => {}
        ("url", Value::String(s)) if s.len() <= 2048 && !s.chars().any(char::is_whitespace) => {}
        ("number", Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {}
        ("email", Value::String(s)) if s.is_empty() => return Ok(None),
        ("phone", Value::String(s)) if s.is_empty() => return Ok(None),
        ("email", Value::String(s)) if email_ok(s) => {}
        ("phone", Value::String(s)) if phone_ok(s) => {}
        ("checkbox", Value::Bool(_)) => {}
        ("place", Value::Object(map)) => {
            let coord = |key: &str, limit: f64| map.get(key).and_then(Value::as_f64).is_some_and(|v| v.is_finite() && v.abs() <= limit);
            let name_ok = map.get("name").is_none_or(|n| n.as_str().is_some_and(|s| s.chars().count() <= 100));
            if !coord("lat", 90.0) || !coord("lng", 180.0) || !name_ok || map.keys().any(|k| !matches!(k.as_str(), "lat" | "lng" | "name")) { return bad(); }
        }
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
    let (kind, config): (String, String) = tx.query_row(
        "SELECT p.type,p.config FROM db_properties p JOIN db_rows r ON r.database_id=p.database_id JOIN pages pg ON pg.id=r.page_id WHERE p.id=?1 AND r.page_id=?2 AND p.deleted_at IS NULL AND pg.deleted_at IS NULL",
        params![property_id, row_id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?.ok_or("Row or property not found")?;
    if kind == "relation" {
        let ids: Vec<String> = match &value {
            Value::Null => Vec::new(),
            Value::Array(items) if items.len() <= 500 => items.iter().map(|v| v.as_str().map(str::to_string).ok_or("A relation holds page ids")).collect::<Result<_, _>>()?,
            _ => return Err("Invalid value for a relation property".into()),
        };
        set_relation(&tx, &property_id, &serde_json::from_str::<Value>(&config).unwrap_or(Value::Null), &row_id, &ids)?;
        tx.execute("UPDATE pages SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [&row_id]).map_err(e)?;
        return tx.commit().map_err(e);
    }
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
        let cfg = |v: Value| clean_config(&tx, &database.id, &v);
        assert!(cfg(serde_json::json!({"groupBy": status.id})).is_ok());
        assert!(cfg(serde_json::json!({"groupBy": "nope"})).is_err());
        assert!(cfg(serde_json::json!({"script": "x"})).is_err());
        assert!(cfg(serde_json::json!([1])).is_err());
        let view = insert_view(&tx, &database.id, "Board", "board", "{}").unwrap();
        assert_eq!(view.kind, "board");
        assert!(insert_view(&tx, &database.id, "Map", "map", "{}").is_ok());
        assert!(insert_view(&tx, &database.id, "Radar", "radar", "{}").is_err());
        let place = insert_property(&tx, &database.id, "Where", "place").unwrap();
        let spot = |v: Value| validate(&tx, &place.id, &place.kind, &v);
        assert!(spot(serde_json::json!({"lat": 35.68, "lng": 139.69, "name": "Tokyo"})).unwrap().is_some());
        assert!(spot(serde_json::json!({"lat": 91.0, "lng": 0.0})).is_err());
        assert!(spot(serde_json::json!({"lat": 0.0, "lng": 181.0})).is_err());
        assert!(spot(serde_json::json!({"lat": 0.0})).is_err());
        assert!(spot(serde_json::json!({"lat": 0.0, "lng": 0.0, "x": 1})).is_err());
        assert!(spot(serde_json::json!("35.68, 139.69")).is_err());
        assert_eq!(spot(Value::Null).unwrap(), None);
        assert!(cfg(serde_json::json!({"placeBy": place.id})).is_ok());
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
    fn rich_view_settings_are_validated_against_this_database() {
        let mut c = fresh();
        let tx = c.transaction().unwrap();
        let database = insert_page(&tx, None, "D", &[1]).unwrap();
        tx.execute("INSERT INTO databases(page_id) VALUES(?1)", [&database.id]).unwrap();
        let hours = insert_property(&tx, &database.id, "Hours", "number").unwrap();
        let cfg = |v: Value| clean_config(&tx, &database.id, &v);
        assert!(cfg(serde_json::json!({"sorts": [{"p": hours.id, "dir": "asc"}], "filters": [{"p": hours.id, "op": "gt", "v": 3}], "hidden": [hours.id], "wrap": [hours.id], "frozen": hours.id, "calc": {hours.id.clone(): "sum"}})).is_ok());
        assert!(cfg(serde_json::json!({"sorts": [{"p": hours.id, "dir": "sideways"}]})).is_err());
        assert!(cfg(serde_json::json!({"filters": [{"p": hours.id, "op": "drop_table"}]})).is_err());
        assert!(cfg(serde_json::json!({"filters": [{"p": "other-db-property", "op": "empty"}]})).is_err());
        assert!(cfg(serde_json::json!({"calc": {hours.id.clone(): "eval"}})).is_err());
        assert!(cfg(serde_json::json!({"hidden": ["nope"]})).is_err());
        assert!(cfg(serde_json::json!({"sorts": [1, 2, 3, 4, 5, 6]})).is_err());
    }
    #[test]
    fn insert_beside_duplicate_and_type_changes_keep_data() {
        let mut c = fresh();
        let tx = c.transaction().unwrap();
        let database = insert_page(&tx, None, "D", &[1]).unwrap();
        tx.execute("INSERT INTO databases(page_id) VALUES(?1)", [&database.id]).unwrap();
        let a = insert_property(&tx, &database.id, "A", "text").unwrap();
        let b = insert_property(&tx, &database.id, "B", "text").unwrap();
        let mid = insert_property_at(&tx, &database.id, "Mid", "text", Some(2)).unwrap();
        let order = |tx: &Transaction<'_>| -> Vec<String> { let mut s = tx.prepare("SELECT name FROM db_properties WHERE database_id=?1 ORDER BY position").unwrap(); s.query_map([&database.id], |r| r.get(0)).unwrap().map(Result::unwrap).collect() };
        assert_eq!(order(&tx), ["A", "Mid", "B"]);
        let _ = (a, b, mid);
        // conversions
        assert_eq!(convert_value("number", "text", &serde_json::json!(2.5)), Some(serde_json::json!("2.5")));
        assert_eq!(convert_value("select", "multi_select", &serde_json::json!("o")), Some(serde_json::json!(["o"])));
        assert_eq!(convert_value("multi_select", "select", &serde_json::json!(["o"])), Some(serde_json::json!("o")));
        assert_eq!(convert_value("multi_select", "select", &serde_json::json!(["o", "p"])), None);
        assert_eq!(convert_value("text", "number", &serde_json::json!("12")), None);
        assert_eq!(convert_value("text", "url", &serde_json::json!("two words")), None);
        assert_eq!(convert_value("text", "url", &serde_json::json!("https://a.example")), Some(serde_json::json!("https://a.example")));
    }
    #[test]
    fn email_phone_and_automatic_properties() {
        let mut c = fresh();
        let tx = c.transaction().unwrap();
        let database = insert_page(&tx, None, "D", &[1]).unwrap();
        tx.execute("INSERT INTO databases(page_id) VALUES(?1)", [&database.id]).unwrap();
        let mail = insert_property(&tx, &database.id, "Mail", "email").unwrap();
        let phone = insert_property(&tx, &database.id, "Tel", "phone").unwrap();
        let made = insert_property(&tx, &database.id, "Created", "created_time").unwrap();
        let check = |p: &Prop, v: Value| validate(&tx, &p.id, &p.kind, &v);
        assert!(check(&mail, serde_json::json!("a@b.example")).unwrap().is_some());
        assert!(check(&mail, serde_json::json!("not an email")).is_err());
        assert!(check(&mail, serde_json::json!("a@b")).is_err());
        assert!(check(&phone, serde_json::json!("+81 (3) 1234-5678")).unwrap().is_some());
        assert!(check(&phone, serde_json::json!("call me")).is_err());
        assert!(check(&made, serde_json::json!("2026-01-01")).is_err(), "automatic properties are read-only");
        assert!(check(&made, Value::Null).is_err());
        assert_eq!(convert_value("text", "email", &serde_json::json!("a@b.example")), Some(serde_json::json!("a@b.example")));
        assert_eq!(convert_value("text", "email", &serde_json::json!("nope")), None);
        assert_eq!(convert_value("email", "text", &serde_json::json!("a@b.example")), Some(serde_json::json!("a@b.example")));
        let cfg = |v: Value| clean_config(&tx, &database.id, &v);
        assert!(cfg(serde_json::json!({"filterMode": "or", "widths": {"title": 300, mail.id.clone(): 120}})).is_ok());
        assert!(cfg(serde_json::json!({"filterMode": "xor"})).is_err());
        assert!(cfg(serde_json::json!({"widths": {"title": 5}})).is_err());
        assert!(cfg(serde_json::json!({"widths": {"nope": 200}})).is_err());
    }
    #[test]
    fn relations_stay_in_sync_both_ways_and_reject_foreign_pages() {
        let mut c = fresh();
        let tx = c.transaction().unwrap();
        let mk = |tx: &Transaction<'_>, title: &str| { let p = insert_page(tx, None, title, &[1]).unwrap(); tx.execute("INSERT INTO databases(page_id) VALUES(?1)", [&p.id]).unwrap(); p };
        let projects = mk(&tx, "Projects");
        let tasks = mk(&tx, "Tasks");
        let row = |tx: &Transaction<'_>, db: &Page, title: &str| { let r = insert_page(tx, Some(db.id.clone()), title, &[1]).unwrap(); tx.execute("INSERT INTO db_rows(page_id,database_id) VALUES(?1,?2)", params![r.id, db.id]).unwrap(); r };
        let (p1, t1, t2) = (row(&tx, &projects, "Launch"), row(&tx, &tasks, "Write"), row(&tx, &tasks, "Ship"));
        let forward = insert_property_at(&tx, &projects.id, "Tasks", "relation", None).unwrap();
        let mirror = insert_property_at(&tx, &tasks.id, "Projects", "relation", None).unwrap();
        let fc = serde_json::json!({ "target": tasks.id, "reverse": mirror.id });
        tx.execute("UPDATE db_properties SET config=?1 WHERE id=?2", params![serde_json::json!({ "target": projects.id, "reverse": forward.id }).to_string(), mirror.id]).unwrap();
        let count = |tx: &Transaction<'_>, prop: &str, from: &str| -> i64 { tx.query_row("SELECT COUNT(*) FROM db_relations WHERE property_id=?1 AND from_row=?2", params![prop, from], |r| r.get(0)).unwrap() };
        set_relation(&tx, &forward.id, &fc, &p1.id, &[t1.id.clone(), t2.id.clone()]).unwrap();
        assert_eq!(count(&tx, &forward.id, &p1.id), 2);
        assert_eq!(count(&tx, &mirror.id, &t1.id), 1, "the other side is linked back");
        set_relation(&tx, &forward.id, &fc, &p1.id, &[t2.id.clone()]).unwrap();
        assert_eq!(count(&tx, &mirror.id, &t1.id), 0, "unlinking removes the mirror link");
        assert_eq!(count(&tx, &mirror.id, &t2.id), 1);
        // pages that are not rows of the target database are refused
        assert!(set_relation(&tx, &forward.id, &fc, &p1.id, &[p1.id.clone()]).is_err());
        assert!(set_relation(&tx, &forward.id, &fc, &p1.id, &["nope".into()]).is_err());
        assert_eq!(count(&tx, &forward.id, &p1.id), 1, "a refused change leaves the links as they were");
        assert!(!tx.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }
    #[test]
    fn rollups_summarise_related_values() {
        let none = HashMap::new();
        let nums = [serde_json::json!(5), serde_json::json!(2), Value::Null, serde_json::json!(9)];
        assert_eq!(rollup_text("sum", &nums, &none), "16");
        assert_eq!(rollup_text("average", &nums, &none), "5.33");
        assert_eq!(rollup_text("median", &nums, &none), "5");
        assert_eq!(rollup_text("min", &nums, &none), "2");
        assert_eq!(rollup_text("max", &nums, &none), "9");
        assert_eq!(rollup_text("range", &nums, &none), "7");
        assert_eq!(rollup_text("count", &nums, &none), "4");
        assert_eq!(rollup_text("count_empty", &nums, &none), "1");
        assert_eq!(rollup_text("percent_not_empty", &nums, &none), "75%");
        assert_eq!(rollup_text("sum", &[], &none), "0");
        assert_eq!(rollup_text("earliest", &[serde_json::json!("2026-11-20"), serde_json::json!("2026-11-03T08:00:00Z")], &none), "2026-11-03");
        let done = [serde_json::json!(true), serde_json::json!(false), serde_json::json!(true)];
        assert_eq!(rollup_text("percent_checked", &done, &none), "67%");
        let names: HashMap<String, String> = [("o1".to_string(), "Done".to_string())].into();
        assert_eq!(rollup_text("show_original", &[serde_json::json!("o1"), serde_json::json!(["o1"]), serde_json::json!("Plain")], &names), "Done, Done, Plain");
        assert_eq!(rollup_text("nonsense", &nums, &none), "");
    }
    #[test]
    fn duplicating_a_column_copies_options_and_values_with_fresh_option_ids() {
        let mut c = fresh();
        let tx = c.transaction().unwrap();
        let database = insert_page(&tx, None, "D", &[1]).unwrap();
        tx.execute("INSERT INTO databases(page_id) VALUES(?1)", [&database.id]).unwrap();
        let status = insert_property(&tx, &database.id, "Status", "status").unwrap();
        let tags = insert_property(&tx, &database.id, "Tags", "multi_select").unwrap();
        let tag_a = add_option(&tx, &tags.id, "A", "red").unwrap();
        let tag_b = add_option(&tx, &tags.id, "B", "blue").unwrap();
        let after = insert_property(&tx, &database.id, "After", "text").unwrap();
        let row = insert_page(&tx, Some(database.id.clone()), "Row", &[1]).unwrap();
        tx.execute("INSERT INTO db_rows(page_id,database_id) VALUES(?1,?2)", params![row.id, database.id]).unwrap();
        tx.execute("INSERT INTO db_values(row_id,property_id,value) VALUES(?1,?2,?3)", params![row.id, status.id, Value::String(status.options[1].id.clone()).to_string()]).unwrap();
        tx.execute("INSERT INTO db_values(row_id,property_id,value) VALUES(?1,?2,?3)", params![row.id, tags.id, serde_json::json!([tag_a.id, tag_b.id]).to_string()]).unwrap();
        let copy = copy_property(&tx, &status.id).unwrap();
        assert_eq!(copy.name, "Status copy");
        assert_eq!(copy.options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Not started", "In progress", "Done"], "exactly the original's options, not the freshly seeded ones");
        assert!(copy.options.iter().all(|o| !status.options.iter().any(|p| p.id == o.id)), "option ids are new");
        let stored: String = tx.query_row("SELECT value FROM db_values WHERE row_id=?1 AND property_id=?2", params![row.id, copy.id], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), Value::String(copy.options[1].id.clone()), "the copied value points at the copy's own option");
        let multi = copy_property(&tx, &tags.id).unwrap();
        let stored: String = tx.query_row("SELECT value FROM db_values WHERE row_id=?1 AND property_id=?2", params![row.id, multi.id], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), serde_json::json!([multi.options[0].id, multi.options[1].id]));
        // it sits directly after the original and pushes later columns right
        let order: Vec<String> = { let mut st = tx.prepare("SELECT name FROM db_properties WHERE database_id=?1 ORDER BY position").unwrap(); st.query_map([&database.id], |r| r.get(0)).unwrap().map(Result::unwrap).collect() };
        assert_eq!(order, ["Status", "Status copy", "Tags", "Tags copy", "After"]);
        let _ = after;
        // relations and rollups are refused rather than copied half-way
        let relation = insert_property(&tx, &database.id, "Rel", "relation").unwrap();
        assert!(copy_property(&tx, &relation.id).is_err());
        assert!(!tx.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }
    #[test]
    fn dates_are_calendar_checked() {
        for ok in ["2026-11-10", "2024-02-29", "2026-11-10T09:30"] { assert!(is_date(ok), "{ok}"); }
        for bad in ["2026-02-30", "2025-02-29", "2026-13-01", "26-11-10", "2026-11-10T24:00", "2026-11-10T9:30", "", "2026/11/10"] { assert!(!is_date(bad), "{bad}"); }
    }
}
