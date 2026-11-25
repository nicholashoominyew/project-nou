//! Life Timetable: the weekly routine, stored in the notes database so it can be queried and timed reliably.
//! A slot is one half hour of one weekday (0 = Monday ... 6 = Sunday, slot 0 = 00:00) in one variant ('A' or 'B', alternating weeks);
//! one slot may hold several activities, which share the half hour equally.
//! The built-in "Life Timetable" page is a row in `pages` with `system_key='life_timetable'`; the commands here and the triggers in
//! migration 010 both refuse to rename, trash, move, re-parent or delete it.
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use tauri::State;
use uuid::Uuid;

pub const SYSTEM_KEY: &str = "life_timetable";
pub const SYSTEM_PAGE_ID: &str = "system-life-timetable";
const SEED: &str = include_str!("../seed/life_timetable.json");
const CATEGORIES: [&str; 7] = ["Work", "Rest", "Leisure", "Travel", "Chores", "Training", "Health"];
const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_PER_SLOT: usize = 12;
const MAX_ACTIVITIES: i64 = 200;
/// The activity v1 shipped for the alternating Saturday, split in v2 into Dark Sphere (week A) and Deep learning (library) (week B).
const OLD_ALTERNATING: &str = "Dark Sphere / Library deep learning (alternating)";

fn e(error: rusqlite::Error) -> String { error.to_string() }
fn variant_ok(v: &str) -> Result<(), String> { if v == "A" || v == "B" { Ok(()) } else { Err("Variant must be A or B".into()) } }

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Activity { pub id: String, name: String, category: String, colour: Option<String>, remind: bool, sort_order: i64, habit_id: Option<String> }
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Slot { variant: String, weekday: i64, slot_index: i64, activity_id: String }
/// What one slot held, used to undo a save.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct Cell { weekday: i64, slot_index: i64, activity_ids: Vec<String> }
#[derive(Serialize, Debug)]
pub struct Edited { a: bool, b: bool }
#[derive(Serialize, Debug)]
pub struct Timetable { pub activities: Vec<Activity>, system_page_id: Option<String>, swap_ab: bool, slots: Vec<Slot>, edited: Edited }

#[derive(Deserialize)]
struct SeedActivity { name: String, category: String, remind: bool }
type Runs = Vec<(String, String, Vec<String>)>;
#[derive(Deserialize)]
struct SeedFile { activities: Vec<SeedActivity>, days: HashMap<String, Runs>, #[serde(default)] variants: HashMap<String, HashMap<String, Runs>> }

fn minutes(text: &str) -> Result<i64, String> {
    let (h, m) = text.split_once(':').ok_or("Bad seed time")?;
    let v = h.parse::<i64>().map_err(|_| "Bad seed time")? * 60 + m.parse::<i64>().map_err(|_| "Bad seed time")?;
    if v % 30 != 0 || !(0..=1440).contains(&v) { return Err(format!("Seed time {text} is not on a half hour")); }
    Ok(v)
}
fn seed_file() -> Result<SeedFile, String> { serde_json::from_str(SEED).map_err(|x| format!("Seed data is invalid: {x}")) }
/// The plan for one variant as (weekday, slot, activity name), names lower-cased for comparison.
fn plan(file: &SeedFile, variant: &str) -> Result<BTreeSet<(i64, i64, String)>, String> {
    variant_ok(variant)?;
    let mut out = BTreeSet::new();
    for (d, day) in DAYS.iter().enumerate() {
        let runs = file.variants.get(variant).and_then(|v| v.get(*day)).or_else(|| file.days.get(*day)).ok_or("Seed is missing a day")?;
        for (start, end, names) in runs {
            for slot in (minutes(start)? / 30)..(minutes(end)? / 30) { for n in names { out.insert((d as i64, slot, n.to_lowercase())); } }
        }
    }
    Ok(out)
}

/// The built-in page row. Safe to call on every start: it creates the row once and never changes an existing one.
pub fn ensure_system_page(c: &Connection) -> Result<(), String> {
    let has: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('pages') WHERE name='system_key')", [], |r| r.get(0)).map_err(e)?;
    if !has { return Ok(()); }
    c.execute(
        "INSERT OR IGNORE INTO pages(id,workspace_id,title,sort_key,icon)
         SELECT ?1,'personal','Life Timetable','~system-life-timetable','calendar' WHERE EXISTS(SELECT 1 FROM workspaces WHERE id='personal')",
        [SYSTEM_PAGE_ID]).map_err(e)?;
    c.execute("UPDATE pages SET system_key=?1 WHERE id=?2 AND system_key IS NULL", params![SYSTEM_KEY, SYSTEM_PAGE_ID]).map_err(e)?;
    Ok(())
}

fn activity_id(c: &Connection, name: &str) -> Result<Option<String>, String> {
    c.query_row("SELECT id FROM timetable_activities WHERE name=?1 COLLATE NOCASE", [name], |r| r.get(0)).optional().map_err(e)
}
fn ensure_activity(c: &Connection, name: &str, category: &str) -> Result<String, String> {
    if let Some(id) = activity_id(c, name)? { return Ok(id); }
    let id = Uuid::new_v4().to_string();
    let order: i64 = c.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM timetable_activities", [], |r| r.get(0)).map_err(e)?;
    c.execute("INSERT INTO timetable_activities(id,name,category,sort_order) VALUES(?1,?2,?3,?4)", params![id, name, category, order]).map_err(e)?;
    Ok(id)
}

/// Seed the starting timetable (both weeks), only when no activity or slot exists. Edits made later are never overwritten.
pub fn seed(c: &Connection) -> Result<bool, String> {
    ensure_system_page(c)?;
    let have: i64 = c.query_row("SELECT (SELECT COUNT(*) FROM timetable_activities)+(SELECT COUNT(*) FROM timetable_slots)", [], |r| r.get(0)).map_err(e)?;
    if have > 0 { return Ok(false); }
    let file = seed_file()?;
    c.execute_batch("SAVEPOINT timetable_seed").map_err(e)?;
    let result = (|| -> Result<(), String> {
        let mut ids = HashMap::new();
        for (i, a) in file.activities.iter().enumerate() {
            let id = Uuid::new_v4().to_string();
            c.execute("INSERT INTO timetable_activities(id,name,category,remind,sort_order) VALUES(?1,?2,?3,?4,?5)", params![id, a.name, a.category, a.remind as i64, i as i64]).map_err(e)?;
            ids.insert(a.name.to_lowercase(), id);
        }
        for variant in ["A", "B"] {
            for (d, slot, name) in plan(&file, variant)? {
                let id = ids.get(&name).ok_or_else(|| format!("Seed uses an unknown activity: {name}"))?;
                c.execute("INSERT OR IGNORE INTO timetable_slots(variant,weekday,slot_index,activity_id) VALUES(?1,?2,?3,?4)", params![variant, d, slot, id]).map_err(e)?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => { c.execute_batch("RELEASE timetable_seed").map_err(e)?; Ok(true) }
        Err(x) => { let _ = c.execute_batch("ROLLBACK TO timetable_seed; RELEASE timetable_seed"); Err(x) }
    }
}

/// Part of the 10 -> 11 upgrade. Splits the old combined Saturday activity: week A gets Dark Sphere, week B gets Deep learning (library).
/// Only slots that still hold the old activity are rewritten, so anything edited is left alone. The old activity is deleted only when nothing uses it.
pub fn migrate_saturday_split(c: &Connection) -> Result<(), String> {
    let Some(old) = activity_id(c, OLD_ALTERNATING)? else { return Ok(()) };
    let dark = ensure_activity(c, "Dark Sphere", "Leisure")?;
    let deep = ensure_activity(c, "Deep learning (library)", "Training")?;
    for (variant, target) in [("A", &dark), ("B", &deep)] {
        c.execute("INSERT OR IGNORE INTO timetable_slots(variant,weekday,slot_index,activity_id) SELECT variant,weekday,slot_index,?3 FROM timetable_slots WHERE variant=?1 AND activity_id=?2", params![variant, old, target]).map_err(e)?;
        c.execute("DELETE FROM timetable_slots WHERE variant=?1 AND activity_id=?2", params![variant, old]).map_err(e)?;
    }
    let used: i64 = c.query_row("SELECT COUNT(*) FROM timetable_slots WHERE activity_id=?1", [&old], |r| r.get(0)).map_err(e)?;
    if used == 0 { c.execute("DELETE FROM timetable_activities WHERE id=?1", [&old]).map_err(e)?; }
    Ok(())
}

/// Refuse any change to a built-in page. Used by the page commands before they touch a row.
pub fn refuse_system(c: &Connection, page_id: &str) -> Result<(), String> {
    let has: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('pages') WHERE name='system_key')", [], |r| r.get(0)).map_err(e)?;
    if !has { return Ok(()); }
    let key: Option<Option<String>> = c.query_row("SELECT system_key FROM pages WHERE id=?1", [page_id], |r| r.get(0)).optional().map_err(e)?;
    if matches!(key, Some(Some(_))) { return Err("The Life Timetable is a built-in page: it cannot be renamed, moved, trashed or deleted".into()); }
    Ok(())
}

pub fn swap_ab(c: &Connection) -> Result<bool, String> {
    Ok(c.query_row("SELECT value FROM timetable_settings WHERE key='swap_ab'", [], |r| r.get::<_, String>(0)).optional().map_err(e)?.as_deref() == Some("1"))
}
pub fn set_swap_ab(c: &Connection, swap: bool) -> Result<(), String> {
    c.execute("INSERT INTO timetable_settings(key,value) VALUES('swap_ab',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [if swap { "1" } else { "0" }]).map(|_| ()).map_err(e)
}

/// True when a variant's slots differ from the shipped plan (compared by activity name).
fn edited(c: &Connection, file: &SeedFile, variant: &str) -> Result<bool, String> {
    let mut s = c.prepare("SELECT s.weekday,s.slot_index,lower(a.name) FROM timetable_slots s JOIN timetable_activities a ON a.id=s.activity_id WHERE s.variant=?1").map_err(e)?;
    let actual = s.query_map([variant], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).map_err(e)?.collect::<rusqlite::Result<BTreeSet<_>>>().map_err(e)?;
    Ok(actual != plan(file, variant)?)
}

pub fn get(c: &Connection) -> Result<Timetable, String> {
    let system_page_id = c.query_row("SELECT id FROM pages WHERE system_key=?1", [SYSTEM_KEY], |r| r.get(0)).optional().map_err(e)?;
    let mut s = c.prepare("SELECT id,name,category,colour,remind,sort_order,habit_id FROM timetable_activities ORDER BY sort_order,name COLLATE NOCASE,id").map_err(e)?;
    let activities = s.query_map([], |r| Ok(Activity { id: r.get(0)?, name: r.get(1)?, category: r.get(2)?, colour: r.get(3)?, remind: r.get::<_, i64>(4)? != 0, sort_order: r.get(5)?, habit_id: r.get(6)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    let mut s = c.prepare("SELECT variant,weekday,slot_index,activity_id FROM timetable_slots ORDER BY variant,weekday,slot_index,activity_id").map_err(e)?;
    let slots = s.query_map([], |r| Ok(Slot { variant: r.get(0)?, weekday: r.get(1)?, slot_index: r.get(2)?, activity_id: r.get(3)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    let file = seed_file()?;
    Ok(Timetable { system_page_id, swap_ab: swap_ab(c)?, activities, slots, edited: Edited { a: edited(c, &file, "A")?, b: edited(c, &file, "B")? } })
}

/// A compact, read-only picture of the timetable for an assistant: the activities (name and category) and, for each week and day, the blocks (a run of half-hours
/// with the same activities, listed by name). Gaps are left out. It carries no ids and changes nothing.
pub fn summary(c: &Connection) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let tt = get(c)?;
    let names: HashMap<&str, &str> = tt.activities.iter().map(|a| (a.id.as_str(), a.name.as_str())).collect();
    let hm = |slot: i64| format!("{:02}:{:02}", slot / 2, slot % 2 * 30);
    let mut weeks = serde_json::Map::new();
    for variant in ["A", "B"] {
        let mut days = serde_json::Map::new();
        for (d, day) in DAYS.iter().enumerate() {
            let mut cells: Vec<Vec<&str>> = vec![Vec::new(); 48];
            for s in tt.slots.iter().filter(|s| s.variant == variant && s.weekday == d as i64 && (0..48).contains(&s.slot_index)) {
                if let Some(n) = names.get(s.activity_id.as_str()) { cells[s.slot_index as usize].push(n); }
            }
            for cell in cells.iter_mut() { cell.sort_unstable(); }
            let mut blocks = Vec::new(); let mut i = 0usize;
            while i < 48 {
                if cells[i].is_empty() { i += 1; continue; }
                let mut j = i + 1; while j < 48 && cells[j] == cells[i] { j += 1; }
                blocks.push(json!({ "start": hm(i as i64), "end": hm(j as i64), "activities": cells[i] }));
                i = j;
            }
            days.insert(day.to_string(), serde_json::Value::Array(blocks));
        }
        weeks.insert(variant.to_string(), serde_json::Value::Object(days));
    }
    Ok(json!({
        "activities": tt.activities.iter().map(|a| json!({ "name": a.name, "category": a.category, "habit": a.habit_id.is_some() })).collect::<Vec<_>>(),
        "swap_ab": tt.swap_ab, "weeks": weeks,
        "note": "Times are local, in half-hour steps; 'end' is exclusive. Weeks A and B alternate by ISO week number (odd is A) unless swap_ab is true. Empty stretches are not listed.",
    }))
}

fn read_cell(tx: &rusqlite::Transaction<'_>, variant: &str, weekday: i64, slot: i64) -> Result<Cell, String> {
    let mut s = tx.prepare("SELECT activity_id FROM timetable_slots WHERE variant=?1 AND weekday=?2 AND slot_index=?3 ORDER BY activity_id").map_err(e)?;
    let activity_ids = s.query_map(params![variant, weekday, slot], |r| r.get::<_, String>(0)).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    Ok(Cell { weekday, slot_index: slot, activity_ids })
}
fn known(tx: &rusqlite::Transaction<'_>, ids: &[String]) -> Result<(), String> {
    for a in ids {
        let ok: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM timetable_activities WHERE id=?1)", [a], |r| r.get(0)).map_err(e)?;
        if !ok { return Err("Unknown activity".into()); }
    }
    Ok(())
}

/// Write `activity_ids` into every slot of [start, end) (half-hour indexes, end exclusive, up to 48) on each chosen weekday of ONE variant,
/// in a single transaction. Returns what those slots held before, so the caller can offer Undo.
pub fn save_range(c: &mut Connection, variant: &str, weekdays: &[i64], start: i64, end: i64, activity_ids: &[String]) -> Result<Vec<Cell>, String> {
    variant_ok(variant)?;
    let days: BTreeSet<i64> = weekdays.iter().copied().collect();
    if days.is_empty() || days.iter().any(|d| !(0..=6).contains(d)) { return Err("Pick at least one day, Monday to Sunday".into()); }
    if !(0..48).contains(&start) || !(1..=48).contains(&end) || end <= start { return Err("The end must be after the start, within one day".into()); }
    let ids: BTreeSet<&String> = activity_ids.iter().collect();
    if ids.is_empty() { return Err("Pick at least one activity".into()); }
    if ids.len() > MAX_PER_SLOT { return Err(format!("A slot can hold at most {MAX_PER_SLOT} activities")); }
    let tx = c.transaction().map_err(e)?;
    known(&tx, activity_ids)?;
    let mut before = Vec::new();
    for d in &days {
        for s in start..end {
            before.push(read_cell(&tx, variant, *d, s)?);
            tx.execute("DELETE FROM timetable_slots WHERE variant=?1 AND weekday=?2 AND slot_index=?3", params![variant, d, s]).map_err(e)?;
            for a in &ids { tx.execute("INSERT INTO timetable_slots(variant,weekday,slot_index,activity_id) VALUES(?1,?2,?3,?4)", params![variant, d, s, a]).map_err(e)?; }
        }
    }
    tx.commit().map_err(e)?;
    crate::habits::sync_checkins(c)?;
    Ok(before)
}

/// Put exact slot contents back (Undo). Every cell is checked first; nothing changes unless all of them are valid.
pub fn restore_cells(c: &mut Connection, variant: &str, cells: &[Cell]) -> Result<(), String> {
    variant_ok(variant)?;
    if cells.len() > 7 * 48 { return Err("Too many slots".into()); }
    let tx = c.transaction().map_err(e)?;
    for cell in cells {
        if !(0..=6).contains(&cell.weekday) || !(0..48).contains(&cell.slot_index) || cell.activity_ids.len() > MAX_PER_SLOT { return Err("Invalid slot".into()); }
        known(&tx, &cell.activity_ids)?;
    }
    for cell in cells {
        tx.execute("DELETE FROM timetable_slots WHERE variant=?1 AND weekday=?2 AND slot_index=?3", params![variant, cell.weekday, cell.slot_index]).map_err(e)?;
        for a in cell.activity_ids.iter().collect::<BTreeSet<_>>() { tx.execute("INSERT INTO timetable_slots(variant,weekday,slot_index,activity_id) VALUES(?1,?2,?3,?4)", params![variant, cell.weekday, cell.slot_index, a]).map_err(e)?; }
    }
    tx.commit().map_err(e)?;
    crate::habits::sync_checkins(c)
}

/// Put one variant back to the shipped plan. Activities the plan needs that have since been deleted are created again.
pub fn reset_variant(c: &mut Connection, variant: &str) -> Result<(), String> {
    variant_ok(variant)?;
    let file = seed_file()?;
    let tx = c.transaction().map_err(e)?;
    let mut ids = HashMap::new();
    for a in &file.activities { ids.insert(a.name.to_lowercase(), ensure_activity(&tx, &a.name, &a.category)?); }
    tx.execute("DELETE FROM timetable_slots WHERE variant=?1", [variant]).map_err(e)?;
    for (d, slot, name) in plan(&file, variant)? {
        let id = ids.get(&name).ok_or("Plan uses an unknown activity")?;
        tx.execute("INSERT OR IGNORE INTO timetable_slots(variant,weekday,slot_index,activity_id) VALUES(?1,?2,?3,?4)", params![variant, d, slot, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    crate::habits::sync_checkins(c)
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 80 || n.chars().any(|c| c.is_control()) { return Err("An activity name is 1 to 80 characters".into()); }
    Ok(n.to_string())
}
fn clean_colour(colour: &Option<String>) -> Result<Option<String>, String> {
    match colour.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) if v.len() == 7 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_hexdigit()) => Ok(Some(v.to_ascii_lowercase())),
        Some(_) => Err("A colour looks like #1a2b3c".into()),
    }
}
fn clean_category(category: &str) -> Result<(), String> { if CATEGORIES.contains(&category) { Ok(()) } else { Err("Unknown category".into()) } }

pub fn add_activity(c: &Connection, name: &str, category: &str) -> Result<Activity, String> {
    let name = clean_name(name)?; clean_category(category)?;
    let count: i64 = c.query_row("SELECT COUNT(*) FROM timetable_activities", [], |r| r.get(0)).map_err(e)?;
    if count >= MAX_ACTIVITIES { return Err("Too many activities".into()); }
    let id = Uuid::new_v4().to_string();
    let order: i64 = c.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM timetable_activities", [], |r| r.get(0)).map_err(e)?;
    c.execute("INSERT INTO timetable_activities(id,name,category,sort_order) VALUES(?1,?2,?3,?4)", params![id, name, category, order])
        .map_err(|x| if x.to_string().contains("UNIQUE") { "An activity with that name already exists".to_string() } else { x.to_string() })?;
    Ok(Activity { id, name, category: category.into(), colour: None, remind: true, sort_order: order, habit_id: None })
}

#[derive(Deserialize)]
pub struct ActivityEdit { id: String, name: String, category: String, colour: Option<String>, remind: bool }
pub fn update_activity(c: &Connection, a: &ActivityEdit) -> Result<(), String> {
    let name = clean_name(&a.name)?; clean_category(&a.category)?; let colour = clean_colour(&a.colour)?;
    let n = c.execute("UPDATE timetable_activities SET name=?1,category=?2,colour=?3,remind=?4,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?5", params![name, a.category, colour, a.remind as i64, a.id])
        .map_err(|x| if x.to_string().contains("UNIQUE") { "An activity with that name already exists".to_string() } else { x.to_string() })?;
    if n != 1 { return Err("Activity not found".into()); }
    // A habit's activity and the habit are one thing: renaming or retyping either changes both.
    c.execute("UPDATE habits SET name=?1,category=?2 WHERE id=(SELECT habit_id FROM timetable_activities WHERE id=?3)", params![name, a.category, a.id])
        .map_err(|x| if x.to_string().contains("UNIQUE") { "A habit with that name already exists".to_string() } else { x.to_string() })?;
    Ok(())
}

/// Delete an activity. If it is still used in either week it is refused, unless `reassign_to` names another activity to take its slots.
pub fn delete_activity(c: &mut Connection, id: &str, reassign_to: Option<&str>) -> Result<(), String> {
    let habit: bool = c.query_row("SELECT habit_id IS NOT NULL FROM timetable_activities WHERE id=?1", [id], |r| r.get(0)).optional().map_err(e)?.unwrap_or(false);
    if habit { return Err("This activity is a habit. Delete it on the Habits page".into()); }
    let tx = c.transaction().map_err(e)?;
    let used: i64 = tx.query_row("SELECT COUNT(*) FROM timetable_slots WHERE activity_id=?1", [id], |r| r.get(0)).map_err(e)?;
    if used > 0 {
        let to = reassign_to.filter(|t| *t != id).ok_or_else(|| format!("This activity is used in {used} slots. Pick another activity to take them over, or clear them first"))?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM timetable_activities WHERE id=?1)", [to], |r| r.get(0)).map_err(e)?;
        if !known { return Err("The activity to reassign to does not exist".into()); }
        tx.execute("INSERT OR IGNORE INTO timetable_slots(variant,weekday,slot_index,activity_id) SELECT variant,weekday,slot_index,?2 FROM timetable_slots WHERE activity_id=?1", params![id, to]).map_err(e)?;
        tx.execute("DELETE FROM timetable_slots WHERE activity_id=?1", [id]).map_err(e)?;
    }
    if tx.execute("DELETE FROM timetable_activities WHERE id=?1", [id]).map_err(e)? != 1 { return Err("Activity not found".into()); }
    tx.commit().map_err(e)?;
    crate::habits::sync_checkins(c)
}

#[tauri::command]
pub fn timetable_get(db: State<'_, Db>) -> Result<Timetable, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; get(&c) }
#[tauri::command]
pub fn timetable_save_range(db: State<'_, Db>, variant: String, weekdays: Vec<i64>, start: i64, end: i64, activity_ids: Vec<String>) -> Result<Vec<Cell>, String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; save_range(&mut c, &variant, &weekdays, start, end, &activity_ids)
}
#[tauri::command]
pub fn timetable_restore_cells(db: State<'_, Db>, variant: String, cells: Vec<Cell>) -> Result<(), String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; restore_cells(&mut c, &variant, &cells)
}
#[tauri::command]
pub fn timetable_reset_variant(db: State<'_, Db>, variant: String) -> Result<(), String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; reset_variant(&mut c, &variant)
}
#[tauri::command]
pub fn timetable_set_swap(db: State<'_, Db>, swap: bool) -> Result<(), String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; set_swap_ab(&c, swap)
}
#[tauri::command]
pub fn timetable_add_activity(db: State<'_, Db>, name: String, category: String) -> Result<Activity, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; add_activity(&c, &name, &category)
}
#[tauri::command]
pub fn timetable_update_activity(db: State<'_, Db>, activity: ActivityEdit) -> Result<(), String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; update_activity(&c, &activity)
}
#[tauri::command]
pub fn timetable_delete_activity(db: State<'_, Db>, id: String, reassign_to: Option<String>) -> Result<(), String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; delete_activity(&mut c, &id, reassign_to.as_deref())
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
    fn count(c: &Connection, sql: &str) -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() }
    fn id_of(c: &Connection, name: &str) -> String { activity_id(c, name).unwrap().unwrap() }
    fn names_at(c: &Connection, variant: &str, d: i64, s: i64) -> Vec<String> {
        let mut st = c.prepare("SELECT a.name FROM timetable_slots t JOIN timetable_activities a ON a.id=t.activity_id WHERE t.variant=?1 AND t.weekday=?2 AND t.slot_index=?3 ORDER BY a.name").unwrap();
        st.query_map(params![variant, d, s], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap()
    }

    #[test]
    fn a_new_database_gets_the_tables_the_system_page_and_both_weeks() {
        let c = fresh();
        assert_eq!(count(&c, "SELECT MAX(version) FROM schema_migrations"), 17);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM pages WHERE system_key='life_timetable' AND title='Life Timetable' AND parent_id IS NULL"), 1);
        assert!(count(&c, "SELECT COUNT(*) FROM timetable_activities") >= 30);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_activities WHERE name LIKE '%alternating%'"), 0, "the old combined activity is not seeded");
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_settings"), 0);
        assert!(!swap_ab(&c).unwrap());
    }
    #[test]
    fn every_day_of_both_weeks_fills_exactly_48_slots_and_the_seed_is_contiguous() {
        let c = fresh();
        for v in ["A", "B"] { for d in 0..7 { assert_eq!(count(&c, &format!("SELECT COUNT(DISTINCT slot_index) FROM timetable_slots WHERE variant='{v}' AND weekday={d}")), 48, "{v} day {d}"); } }
        let file = seed_file().unwrap();
        let mut all: Vec<&Runs> = file.days.values().collect();
        all.extend(file.variants.values().flat_map(|v| v.values()));
        for runs in all { let mut at = 0; for (s, en, _) in runs { assert_eq!(minutes(s).unwrap(), at, "gap or overlap at {s}"); at = minutes(en).unwrap(); } assert_eq!(at, 1440); }
    }
    #[test]
    fn the_saturday_differs_between_weeks_and_everything_else_matches() {
        let c = fresh();
        assert_eq!(names_at(&c, "A", 5, 23), vec!["Dark Sphere"], "Saturday 11:30, week A");
        assert_eq!(names_at(&c, "B", 5, 23), vec!["Deep learning (library)"], "Saturday 11:30, week B");
        assert_eq!(names_at(&c, "A", 5, 37), vec!["Dark Sphere"], "until 19:00");
        assert_eq!(names_at(&c, "A", 5, 38), vec!["Read", "Travel"]);
        assert_eq!(names_at(&c, "A", 0, 10), vec!["JP Anki", "Japanese Study", "Shower + Breakfast", "Walk"], "Monday 05:00 uses Walk");
        assert_eq!(names_at(&c, "B", 2, 38), vec!["Deep learning (library)", "Japanese Study"]);
        let diff = count(&c, "SELECT COUNT(*) FROM (SELECT weekday,slot_index,activity_id FROM timetable_slots WHERE variant='A' EXCEPT SELECT weekday,slot_index,activity_id FROM timetable_slots WHERE variant='B')");
        assert_eq!(diff, 15, "only the 15 Saturday slots differ");
        let t = get(&c).unwrap(); assert!(!t.edited.a && !t.edited.b, "a fresh seed is not edited");
    }

    /// A v10 database as the first Life Timetable branch left it: single-week slots and the combined Saturday activity.
    fn v10(edit_sat: bool) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        for sql in [include_str!("../../../../db/notes/002_editor_formats.sql"), include_str!("../../../../db/notes/003_page_icons.sql"), include_str!("../../../../db/notes/004_databases.sql"), include_str!("../../../../db/notes/005_page_links.sql"), include_str!("../../../../db/notes/006_gateway.sql"), include_str!("../../../../db/notes/007_linked_todos.sql"), include_str!("../../../../db/notes/008_page_locks.sql"), include_str!("../../../../db/notes/009_bot_chat.sql"), include_str!("../../../../db/notes/010_life_timetable.sql")] { c.execute_batch(sql).unwrap(); }
        c.execute_batch("INSERT INTO timetable_activities(id,name,category,sort_order) VALUES('old','Dark Sphere / Library deep learning (alternating)','Leisure',0),('w','Work','Work',1),('r','Read','Training',2)").unwrap();
        for s in 23..38 { c.execute("INSERT INTO timetable_slots(weekday,slot_index,activity_id) VALUES(5,?1,'old')", [s]).unwrap(); }
        c.execute("INSERT INTO timetable_slots(weekday,slot_index,activity_id) VALUES(0,18,'w')", []).unwrap();
        if edit_sat { c.execute("DELETE FROM timetable_slots WHERE weekday=5 AND slot_index=30", []).unwrap(); c.execute("INSERT INTO timetable_slots(weekday,slot_index,activity_id) VALUES(5,30,'r')", []).unwrap(); }
        c
    }
    #[test]
    fn the_upgrade_copies_existing_slots_into_both_weeks_and_splits_the_saturday() {
        let c = v10(false);
        crate::editor::upgrade(&c).unwrap();
        assert_eq!(count(&c, "SELECT MAX(version) FROM schema_migrations"), 17);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE variant='A' AND weekday=0 AND slot_index=18 AND activity_id='w'"), 1);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE variant='B' AND weekday=0 AND slot_index=18 AND activity_id='w'"), 1, "both weeks keep the edit");
        assert_eq!(names_at(&c, "A", 5, 25), vec!["Dark Sphere"]); assert_eq!(names_at(&c, "B", 5, 25), vec!["Deep learning (library)"]);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_activities WHERE id='old'"), 0, "the unused old activity is retired");
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots"), 2 * 16, "nothing was lost or added: 15 Saturday slots + 1 Monday slot, in two weeks");
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_activities WHERE name='Dark Sphere' AND category='Leisure'"), 1);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_activities"), 4, "an upgraded database is not re-seeded");
    }
    #[test]
    fn slots_the_user_already_edited_are_not_touched_by_the_split() {
        let c = v10(true);
        crate::editor::upgrade(&c).unwrap();
        for v in ["A", "B"] { assert_eq!(names_at(&c, v, 5, 30), vec!["Read"], "{v}: the edited slot stays"); }
        assert_eq!(names_at(&c, "A", 5, 29), vec!["Dark Sphere"]);
        assert_eq!(names_at(&c, "B", 5, 29), vec!["Deep learning (library)"]);
    }
    #[test]
    fn swap_setting_persists() {
        let c = fresh();
        set_swap_ab(&c, true).unwrap(); assert!(swap_ab(&c).unwrap()); assert!(get(&c).unwrap().swap_ab);
        set_swap_ab(&c, false).unwrap(); assert!(!swap_ab(&c).unwrap());
        assert!(c.execute("INSERT INTO timetable_settings(key,value) VALUES('other','1')", []).is_err());
    }

    #[test]
    fn seeding_runs_only_on_empty_tables_and_never_overwrites_edits() {
        let mut c = fresh();
        let before = count(&c, "SELECT COUNT(*) FROM timetable_slots");
        let free = id_of(&c, "Free time");
        save_range(&mut c, "A", &[0], 0, 1, &[free]).unwrap();
        assert!(!seed(&c).unwrap(), "a second run does nothing");
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots"), before, "the edit survives (one activity replaced by one)");
        c.execute_batch("DELETE FROM timetable_slots; DELETE FROM timetable_activities;").unwrap();
        assert!(seed(&c).unwrap(), "only when both tables are empty");
    }
    #[test]
    fn the_system_page_cannot_be_renamed_trashed_moved_or_deleted() {
        let c = fresh();
        assert!(refuse_system(&c, SYSTEM_PAGE_ID).is_err());
        assert!(refuse_system(&c, "some-normal-page").is_ok());
        let err = |sql: &str| c.execute(sql, []).unwrap_err().to_string();
        assert!(err("UPDATE pages SET title='Mine' WHERE system_key='life_timetable'").contains("built-in"), "rename");
        assert!(err("UPDATE pages SET deleted_at='2026-01-01' WHERE system_key='life_timetable'").contains("built-in"), "trash");
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('other','personal','Other','a')", []).unwrap();
        assert!(err("UPDATE pages SET parent_id='other' WHERE system_key='life_timetable'").contains("built-in"), "move into a page");
        assert!(err("UPDATE pages SET system_key=NULL WHERE system_key='life_timetable'").contains("built-in"), "unmark");
        assert!(err("DELETE FROM pages WHERE system_key='life_timetable'").contains("built-in"), "delete");
        c.execute("UPDATE pages SET title='Renamed' WHERE id='other'", []).unwrap();
        c.execute("DELETE FROM pages WHERE id='other'", []).unwrap();
    }
    #[test]
    fn the_relocate_and_create_paths_refuse_the_system_page_as_the_moved_page_or_as_a_parent() {
        let mut c = fresh();
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('other','personal','Other','a')", []).unwrap();
        assert!(crate::workspace_commands::relocate(&mut c, SYSTEM_PAGE_ID, None, None).is_err());
        assert!(crate::workspace_commands::relocate(&mut c, SYSTEM_PAGE_ID, Some("other"), None).is_err());
        assert!(crate::workspace_commands::relocate(&mut c, "other", Some(SYSTEM_PAGE_ID), None).is_err());
        let tx = c.transaction().unwrap();
        assert!(crate::insert_page(&tx, Some(SYSTEM_PAGE_ID.into()), "Child", &[1]).is_err());
    }

    #[test]
    fn saving_a_range_writes_every_chosen_day_in_one_variant_only_and_returns_what_it_replaced() {
        let mut c = fresh();
        let (piano, guitar) = (add_activity(&c, "Piano", "Training").unwrap().id, add_activity(&c, "Guitar", "Training").unwrap().id);
        let before_b: i64 = count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE variant='B'");
        let prev = save_range(&mut c, "A", &[1, 3, 3], 12, 14, &[piano.clone(), guitar.clone(), piano.clone()]).unwrap();
        assert_eq!(prev.len(), 4, "two days x two slots, each remembered once");
        assert!(prev.iter().all(|cell| !cell.activity_ids.is_empty()), "the slots held something before");
        for d in [1, 3] { for s in [12, 13] { assert_eq!(names_at(&c, "A", d, s), vec!["Guitar", "Piano"]); } }
        assert_eq!(names_at(&c, "A", 1, 14), names_at(&c, "B", 1, 14), "the slot after the range is untouched");
        assert_eq!(names_at(&c, "A", 2, 12), names_at(&c, "B", 2, 12), "other days are untouched");
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE variant='B'"), before_b, "week B is untouched");
        let t = get(&c).unwrap(); assert!(t.edited.a); assert!(!t.edited.b);
    }
    #[test]
    fn saving_a_range_validates_everything_and_changes_nothing_when_something_is_wrong() {
        let mut c = fresh();
        let w = id_of(&c, "Work");
        let snapshot = |c: &Connection| count(c, "SELECT COUNT(*) FROM timetable_slots") * 1000 + count(c, "SELECT SUM(slot_index+weekday) FROM timetable_slots");
        let s0 = snapshot(&c);
        assert!(save_range(&mut c, "C", &[0], 0, 1, &[w.clone()]).is_err(), "variant");
        assert!(save_range(&mut c, "A", &[], 0, 1, &[w.clone()]).is_err(), "no day");
        assert!(save_range(&mut c, "A", &[7], 0, 1, &[w.clone()]).is_err(), "weekday 7");
        assert!(save_range(&mut c, "A", &[0], 5, 5, &[w.clone()]).is_err(), "empty range");
        assert!(save_range(&mut c, "A", &[0], 6, 5, &[w.clone()]).is_err(), "end before start");
        assert!(save_range(&mut c, "A", &[0], 0, 49, &[w.clone()]).is_err(), "past midnight");
        assert!(save_range(&mut c, "A", &[0], -1, 3, &[w.clone()]).is_err(), "negative");
        assert!(save_range(&mut c, "A", &[0], 0, 1, &[]).is_err(), "no activity");
        assert!(save_range(&mut c, "A", &[0, 1], 0, 4, &[w.clone(), "ghost".into()]).is_err(), "unknown activity");
        assert_eq!(snapshot(&c), s0, "a refused save leaves the timetable exactly as it was");
        save_range(&mut c, "B", &[6], 0, 48, &[w]).unwrap();
    }
    #[test]
    fn a_failure_part_way_through_a_save_rolls_everything_back() {
        let mut c = fresh();
        let w = id_of(&c, "Work");
        let s0 = count(&c, "SELECT COUNT(*) FROM timetable_slots");
        // A trigger that refuses the third insert makes the failure happen after some writes.
        c.execute_batch("CREATE TEMP TABLE hits(n); CREATE TEMP TRIGGER boom BEFORE INSERT ON timetable_slots WHEN (SELECT COUNT(*) FROM hits)>=2 BEGIN SELECT RAISE(ABORT,'boom'); END; CREATE TEMP TRIGGER cnt AFTER INSERT ON timetable_slots BEGIN INSERT INTO hits VALUES(1); END;").unwrap();
        assert!(save_range(&mut c, "A", &[0, 1, 2], 0, 4, &[w.clone()]).is_err());
        c.execute_batch("DROP TRIGGER boom; DROP TRIGGER cnt").unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots"), s0, "all or nothing");
        assert_eq!(names_at(&c, "A", 0, 0), vec!["Bed time"]);
    }
    #[test]
    fn undo_puts_the_previous_slots_back_exactly() {
        let mut c = fresh();
        let before = get(&c).unwrap().slots;
        let w = id_of(&c, "Work");
        let prev = save_range(&mut c, "A", &[0, 4], 0, 10, &[w]).unwrap();
        assert_ne!(get(&c).unwrap().slots, before);
        restore_cells(&mut c, "A", &prev).unwrap();
        assert_eq!(get(&c).unwrap().slots, before);
        assert!(restore_cells(&mut c, "A", &[Cell { weekday: 9, slot_index: 0, activity_ids: vec![] }]).is_err());
        assert!(restore_cells(&mut c, "A", &[Cell { weekday: 0, slot_index: 0, activity_ids: vec!["ghost".into()] }]).is_err());
        assert_eq!(get(&c).unwrap().slots, before, "a refused restore changes nothing");
    }
    #[test]
    fn reset_puts_one_week_back_to_the_plan_and_recreates_deleted_activities() {
        let mut c = fresh();
        let w = id_of(&c, "Work");
        save_range(&mut c, "A", &[0], 0, 48, &[w.clone()]).unwrap();
        save_range(&mut c, "B", &[0], 0, 4, &[w]).unwrap();
        reset_variant(&mut c, "A").unwrap();
        let t = get(&c).unwrap(); assert!(!t.edited.a && t.edited.b, "only the week that was reset is back to the plan");
        let read = id_of(&c, "Read");
        c.execute("DELETE FROM timetable_slots WHERE activity_id=?1", [&read]).unwrap();
        c.execute("DELETE FROM timetable_activities WHERE id=?1", [&read]).unwrap();
        reset_variant(&mut c, "B").unwrap();
        assert!(activity_id(&c, "Read").unwrap().is_some());
        assert!(reset_variant(&mut c, "Z").is_err());
    }

    #[test]
    fn activities_are_validated_unique_and_only_deleted_when_unused_or_reassigned() {
        let mut c = fresh();
        assert!(add_activity(&c, "  ", "Work").is_err()); assert!(add_activity(&c, "X", "Nope").is_err());
        assert!(add_activity(&c, "bed TIME", "Rest").is_err(), "names are unique ignoring case");
        let a = add_activity(&c, "Piano", "Training").unwrap();
        update_activity(&c, &ActivityEdit { id: a.id.clone(), name: "Piano practice".into(), category: "Health".into(), colour: Some("#AABBCC".into()), remind: false }).unwrap();
        let got = get(&c).unwrap().activities.into_iter().find(|x| x.id == a.id).unwrap();
        assert_eq!((got.name.as_str(), got.category.as_str(), got.colour.as_deref(), got.remind), ("Piano practice", "Health", Some("#aabbcc"), false));
        assert!(update_activity(&c, &ActivityEdit { id: a.id.clone(), name: "Piano".into(), category: "Work".into(), colour: Some("red".into()), remind: true }).is_err());
        save_range(&mut c, "B", &[0], 5, 6, &[a.id.clone()]).unwrap();
        assert!(delete_activity(&mut c, &a.id, None).is_err(), "used in week B only still counts");
        let other = add_activity(&c, "Guitar", "Training").unwrap().id;
        delete_activity(&mut c, &a.id, Some(&other)).unwrap();
        assert_eq!(count(&c, &format!("SELECT COUNT(*) FROM timetable_slots WHERE variant='B' AND weekday=0 AND slot_index=5 AND activity_id='{other}'")), 1);
        delete_activity(&mut c, &other, Some(&other)).unwrap_err();
        c.execute("DELETE FROM timetable_slots WHERE activity_id=?1", [&other]).unwrap();
        delete_activity(&mut c, &other, None).unwrap();
    }

    #[test]
    fn the_read_only_summary_lists_activities_and_merged_blocks_by_name_with_no_ids_and_leaves_gaps_out() {
        use serde_json::json;
        let c = fresh();
        let s = summary(&c).unwrap();
        let names: Vec<&str> = s["activities"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"Work") && names.contains(&"Bed time"));
        assert!(s["activities"][0].get("id").is_none(), "no ids leave the app");
        let mon = s["weeks"]["A"]["mon"].as_array().unwrap();
        assert!(mon.iter().any(|b| b["activities"] == json!(["Work"]) && b["start"] == "09:00" && b["end"] == "13:00"), "{mon:?}");
        assert!(mon.windows(2).all(|w| w[0]["end"].as_str().unwrap() <= w[1]["start"].as_str().unwrap()), "blocks are in order and do not overlap");
        // A gap is not listed, and a block is cut where the set of activities changes.
        c.execute("DELETE FROM timetable_slots WHERE variant='A' AND weekday=0 AND slot_index BETWEEN 18 AND 19", []).unwrap();
        let mon = summary(&c).unwrap()["weeks"]["A"]["mon"].clone();
        let starts: Vec<&str> = mon.as_array().unwrap().iter().map(|b| b["start"].as_str().unwrap()).collect();
        assert!(!starts.contains(&"09:00") && starts.contains(&"10:00"), "09:00-10:00 is now a gap: {starts:?}");
        assert!(summary(&c).unwrap()["weeks"]["B"]["sat"].is_array() && s["swap_ab"] == json!(false));
    }
}
