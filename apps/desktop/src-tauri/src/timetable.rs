//! Life Timetable: the weekly routine, stored in the notes database so it can be queried and timed reliably.
//! A slot is one half hour of one weekday (0 = Monday ... 6 = Sunday, slot 0 = 00:00); one slot may hold several activities.
//! The built-in "Life Timetable" page is a row in `pages` with `system_key='life_timetable'`; the commands here and the triggers in
//! migration 010 both refuse to rename, trash, move, re-parent or delete it.
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

pub const SYSTEM_KEY: &str = "life_timetable";
pub const SYSTEM_PAGE_ID: &str = "system-life-timetable";
const SEED: &str = include_str!("../seed/life_timetable.json");
const CATEGORIES: [&str; 7] = ["Work", "Rest", "Leisure", "Travel", "Chores", "Training", "Health"];
const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_PER_SLOT: usize = 12;
const MAX_ACTIVITIES: i64 = 200;

fn e(error: rusqlite::Error) -> String { error.to_string() }

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Activity { pub id: String, name: String, category: String, colour: Option<String>, remind: bool, sort_order: i64 }
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Slot { weekday: i64, slot_index: i64, activity_id: String }
#[derive(Serialize, Debug)]
pub struct Timetable { system_page_id: Option<String>, activities: Vec<Activity>, slots: Vec<Slot> }

#[derive(Deserialize)]
struct SeedActivity { name: String, category: String, remind: bool }
#[derive(Deserialize)]
struct SeedFile { activities: Vec<SeedActivity>, days: std::collections::HashMap<String, Vec<(String, String, Vec<String>)>> }

fn minutes(text: &str) -> Result<i64, String> {
    let (h, m) = text.split_once(':').ok_or("Bad seed time")?;
    let v = h.parse::<i64>().map_err(|_| "Bad seed time")? * 60 + m.parse::<i64>().map_err(|_| "Bad seed time")?;
    if v % 30 != 0 || !(0..=1440).contains(&v) { return Err(format!("Seed time {text} is not on a half hour")); }
    Ok(v)
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

/// Seed the starting timetable, only when no activity or slot exists. Edits made later are never overwritten.
pub fn seed(c: &Connection) -> Result<bool, String> {
    ensure_system_page(c)?;
    let have: i64 = c.query_row("SELECT (SELECT COUNT(*) FROM timetable_activities)+(SELECT COUNT(*) FROM timetable_slots)", [], |r| r.get(0)).map_err(e)?;
    if have > 0 { return Ok(false); }
    let file: SeedFile = serde_json::from_str(SEED).map_err(|x| format!("Seed data is invalid: {x}"))?;
    c.execute_batch("SAVEPOINT timetable_seed").map_err(e)?;
    let result = (|| -> Result<(), String> {
        let mut ids = std::collections::HashMap::new();
        for (i, a) in file.activities.iter().enumerate() {
            let id = Uuid::new_v4().to_string();
            c.execute("INSERT INTO timetable_activities(id,name,category,remind,sort_order) VALUES(?1,?2,?3,?4,?5)", params![id, a.name, a.category, a.remind as i64, i as i64]).map_err(e)?;
            ids.insert(a.name.clone(), id);
        }
        for (d, day) in DAYS.iter().enumerate() {
            for (start, end, names) in file.days.get(*day).ok_or("Seed is missing a day")? {
                for slot in (minutes(start)? / 30)..(minutes(end)? / 30) {
                    for n in names {
                        let id = ids.get(n).ok_or_else(|| format!("Seed uses an unknown activity: {n}"))?;
                        c.execute("INSERT OR IGNORE INTO timetable_slots(weekday,slot_index,activity_id) VALUES(?1,?2,?3)", params![d as i64, slot, id]).map_err(e)?;
                    }
                }
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => { c.execute_batch("RELEASE timetable_seed").map_err(e)?; Ok(true) }
        Err(x) => { let _ = c.execute_batch("ROLLBACK TO timetable_seed; RELEASE timetable_seed"); Err(x) }
    }
}

/// Refuse any change to a built-in page. Used by the page commands before they touch a row.
pub fn refuse_system(c: &Connection, page_id: &str) -> Result<(), String> {
    let has: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('pages') WHERE name='system_key')", [], |r| r.get(0)).map_err(e)?;
    if !has { return Ok(()); }
    let key: Option<Option<String>> = c.query_row("SELECT system_key FROM pages WHERE id=?1", [page_id], |r| r.get(0)).optional().map_err(e)?;
    if matches!(key, Some(Some(_))) { return Err("The Life Timetable is a built-in page: it cannot be renamed, moved, trashed or deleted".into()); }
    Ok(())
}

pub fn get(c: &Connection) -> Result<Timetable, String> {
    let system_page_id = c.query_row("SELECT id FROM pages WHERE system_key=?1", [SYSTEM_KEY], |r| r.get(0)).optional().map_err(e)?;
    let mut s = c.prepare("SELECT id,name,category,colour,remind,sort_order FROM timetable_activities ORDER BY sort_order,name COLLATE NOCASE,id").map_err(e)?;
    let activities = s.query_map([], |r| Ok(Activity { id: r.get(0)?, name: r.get(1)?, category: r.get(2)?, colour: r.get(3)?, remind: r.get::<_, i64>(4)? != 0, sort_order: r.get(5)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    let mut s = c.prepare("SELECT weekday,slot_index,activity_id FROM timetable_slots ORDER BY weekday,slot_index,activity_id").map_err(e)?;
    let slots = s.query_map([], |r| Ok(Slot { weekday: r.get(0)?, slot_index: r.get(1)?, activity_id: r.get(2)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    Ok(Timetable { system_page_id, activities, slots })
}

/// Replace what the given slots of one day hold with exactly these activities (an empty list clears them).
pub fn set_slots(c: &mut Connection, weekday: i64, slot_indexes: &[i64], activity_ids: &[String]) -> Result<(), String> {
    if !(0..=6).contains(&weekday) { return Err("Weekday must be 0 (Monday) to 6 (Sunday)".into()); }
    if slot_indexes.is_empty() || slot_indexes.len() > 48 || slot_indexes.iter().any(|s| !(0..=47).contains(s)) { return Err("Slots must be between 0 and 47".into()); }
    if activity_ids.len() > MAX_PER_SLOT { return Err(format!("A slot can hold at most {MAX_PER_SLOT} activities")); }
    let tx = c.transaction().map_err(e)?;
    for a in activity_ids {
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM timetable_activities WHERE id=?1)", [a], |r| r.get(0)).map_err(e)?;
        if !known { return Err("Unknown activity".into()); }
    }
    for s in slot_indexes {
        tx.execute("DELETE FROM timetable_slots WHERE weekday=?1 AND slot_index=?2", params![weekday, s]).map_err(e)?;
        for a in activity_ids { tx.execute("INSERT OR IGNORE INTO timetable_slots(weekday,slot_index,activity_id) VALUES(?1,?2,?3)", params![weekday, s, a]).map_err(e)?; }
    }
    tx.commit().map_err(e)
}

/// Make the target days an exact copy of the source day.
pub fn copy_day(c: &mut Connection, from: i64, to: &[i64]) -> Result<(), String> {
    if !(0..=6).contains(&from) || to.is_empty() || to.len() > 6 || to.iter().any(|d| !(0..=6).contains(d) || *d == from) { return Err("Choose other days to copy to".into()); }
    let tx = c.transaction().map_err(e)?;
    for d in to {
        tx.execute("DELETE FROM timetable_slots WHERE weekday=?1", [d]).map_err(e)?;
        tx.execute("INSERT INTO timetable_slots(weekday,slot_index,activity_id) SELECT ?1,slot_index,activity_id FROM timetable_slots WHERE weekday=?2", params![d, from]).map_err(e)?;
    }
    tx.commit().map_err(e)
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
    Ok(Activity { id, name, category: category.into(), colour: None, remind: true, sort_order: order })
}

#[derive(Deserialize)]
pub struct ActivityEdit { id: String, name: String, category: String, colour: Option<String>, remind: bool }
pub fn update_activity(c: &Connection, a: &ActivityEdit) -> Result<(), String> {
    let name = clean_name(&a.name)?; clean_category(&a.category)?; let colour = clean_colour(&a.colour)?;
    let n = c.execute("UPDATE timetable_activities SET name=?1,category=?2,colour=?3,remind=?4,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?5", params![name, a.category, colour, a.remind as i64, a.id])
        .map_err(|x| if x.to_string().contains("UNIQUE") { "An activity with that name already exists".to_string() } else { x.to_string() })?;
    if n != 1 { return Err("Activity not found".into()); }
    Ok(())
}

/// Delete an activity. If it is still used in the timetable it is refused, unless `reassign_to` names another activity to take its slots.
pub fn delete_activity(c: &mut Connection, id: &str, reassign_to: Option<&str>) -> Result<(), String> {
    let tx = c.transaction().map_err(e)?;
    let used: i64 = tx.query_row("SELECT COUNT(*) FROM timetable_slots WHERE activity_id=?1", [id], |r| r.get(0)).map_err(e)?;
    if used > 0 {
        let to = reassign_to.filter(|t| *t != id).ok_or_else(|| format!("This activity is used in {used} slots. Pick another activity to take them over, or clear them first"))?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM timetable_activities WHERE id=?1)", [to], |r| r.get(0)).map_err(e)?;
        if !known { return Err("The activity to reassign to does not exist".into()); }
        tx.execute("INSERT OR IGNORE INTO timetable_slots(weekday,slot_index,activity_id) SELECT weekday,slot_index,?2 FROM timetable_slots WHERE activity_id=?1", params![id, to]).map_err(e)?;
        tx.execute("DELETE FROM timetable_slots WHERE activity_id=?1", [id]).map_err(e)?;
    }
    if tx.execute("DELETE FROM timetable_activities WHERE id=?1", [id]).map_err(e)? != 1 { return Err("Activity not found".into()); }
    tx.commit().map_err(e)
}

#[tauri::command]
pub fn timetable_get(db: State<'_, Db>) -> Result<Timetable, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; get(&c) }
#[tauri::command]
pub fn timetable_set_slots(db: State<'_, Db>, weekday: i64, slots: Vec<i64>, activity_ids: Vec<String>) -> Result<(), String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; set_slots(&mut c, weekday, &slots, &activity_ids)
}
#[tauri::command]
pub fn timetable_copy_day(db: State<'_, Db>, from: i64, to: Vec<i64>) -> Result<(), String> {
    let mut c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; copy_day(&mut c, from, &to)
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
    use std::collections::{HashMap, HashSet};

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        c
    }
    fn count(c: &Connection, sql: &str) -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() }

    #[test]
    fn the_upgrade_creates_the_tables_the_system_page_and_the_seed() {
        let c = fresh();
        assert_eq!(count(&c, "SELECT MAX(version) FROM schema_migrations"), 10);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM pages WHERE system_key='life_timetable' AND title='Life Timetable' AND parent_id IS NULL"), 1);
        assert!(count(&c, "SELECT COUNT(*) FROM timetable_activities") >= 30);
    }
    #[test]
    fn every_day_of_the_seed_fills_exactly_48_slots_and_uses_known_activities() {
        let c = fresh();
        for d in 0..7 {
            assert_eq!(count(&c, &format!("SELECT COUNT(DISTINCT slot_index) FROM timetable_slots WHERE weekday={d}")), 48, "day {d}");
        }
        // The seed file itself: each day is a contiguous run from 00:00 to 24:00 with known activity names.
        let file: SeedFile = serde_json::from_str(SEED).unwrap();
        let names: HashSet<_> = file.activities.iter().map(|a| a.name.clone()).collect();
        for day in DAYS {
            let runs = &file.days[day]; let mut at = 0;
            for (s, en, who) in runs { assert_eq!(minutes(s).unwrap(), at, "{day} has a gap or overlap at {s}"); at = minutes(en).unwrap(); assert!(who.iter().all(|n| names.contains(n))); }
            assert_eq!(at, 1440, "{day} ends at midnight");
        }
    }
    #[test]
    fn spot_checks_against_the_notion_timetable() {
        let c = fresh();
        let t = get(&c).unwrap();
        let name: HashMap<_, _> = t.activities.iter().map(|a| (a.id.clone(), a.name.clone())).collect();
        let at = |d: i64, s: i64| -> Vec<String> { let mut v: Vec<_> = t.slots.iter().filter(|x| x.weekday == d && x.slot_index == s).map(|x| name[&x.activity_id].clone()).collect(); v.sort(); v };
        assert_eq!(at(0, 10), vec!["JP Anki", "Japanese Study", "Shower + Breakfast", "Walk"], "Monday 05:00 uses Walk");
        assert_eq!(at(1, 10), vec!["Exercise", "JP Anki", "Japanese Study", "Shower + Breakfast"]);
        assert_eq!(at(2, 38), vec!["Deep learning (library)", "Japanese Study"], "Wednesday 19:00");
        assert_eq!(at(3, 38), vec!["Riftbound", "Vanguard"]);
        assert_eq!(at(4, 43), vec!["Read"], "Friday 21:30");
        assert_eq!(at(4, 44), vec!["Bed time"], "Friday 22:00");
        assert_eq!(at(5, 23), vec!["Dark Sphere / Library deep learning (alternating)"]);
        assert_eq!(at(6, 24), vec!["Grocery run"], "Sunday 12:00");
    }
    #[test]
    fn seeding_runs_only_on_empty_tables_and_never_overwrites_edits() {
        let mut c = fresh();
        let before = count(&c, "SELECT COUNT(*) FROM timetable_slots");
        set_slots(&mut c, 0, &[0], &[]).unwrap();
        assert!(!seed(&c).unwrap(), "a second run does nothing");
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots"), before - 1, "the edit survives");
        // The rule is "only when both tables are empty", so a timetable cleared completely is seeded again on the next upgrade or start.
        c.execute_batch("DELETE FROM timetable_slots; DELETE FROM timetable_activities;").unwrap();
        assert!(seed(&c).unwrap());
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
        assert_eq!(count(&c, "SELECT COUNT(*) FROM pages WHERE system_key='life_timetable' AND title='Life Timetable' AND deleted_at IS NULL"), 1);
        // Ordinary pages are unaffected.
        c.execute("UPDATE pages SET title='Renamed' WHERE id='other'", []).unwrap();
        c.execute("DELETE FROM pages WHERE id='other'", []).unwrap();
    }
    #[test]
    fn the_relocate_and_create_paths_refuse_the_system_page_as_the_moved_page_or_as_a_parent() {
        let mut c = fresh();
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('other','personal','Other','a')", []).unwrap();
        assert!(crate::workspace_commands::relocate(&mut c, SYSTEM_PAGE_ID, None, None).is_err(), "moving the system page");
        assert!(crate::workspace_commands::relocate(&mut c, SYSTEM_PAGE_ID, Some("other"), None).is_err(), "moving it into a page");
        assert!(crate::workspace_commands::relocate(&mut c, "other", Some(SYSTEM_PAGE_ID), None).is_err(), "moving a page into it");
        let tx = c.transaction().unwrap();
        assert!(crate::insert_page(&tx, Some(SYSTEM_PAGE_ID.into()), "Child", &[1]).is_err(), "creating a page inside it");
    }
    #[test]
    fn editing_slots_copying_a_day_and_clearing() {
        let mut c = fresh();
        let id = add_activity(&c, "Piano", "Training").unwrap().id;
        set_slots(&mut c, 2, &[0, 1], &[id.clone()]).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE weekday=2 AND slot_index IN (0,1)"), 2, "replaced, not added to");
        copy_day(&mut c, 2, &[3, 4]).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE weekday=3 AND activity_id IN (SELECT activity_id FROM timetable_slots WHERE weekday=2)") , count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE weekday=2"));
        set_slots(&mut c, 2, &[0, 1], &[]).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM timetable_slots WHERE weekday=2 AND slot_index IN (0,1)"), 0);
        assert!(set_slots(&mut c, 7, &[0], &[]).is_err()); assert!(set_slots(&mut c, 0, &[48], &[]).is_err());
        assert!(set_slots(&mut c, 0, &[0], &["nope".to_string()]).is_err());
        assert!(copy_day(&mut c, 2, &[2]).is_err());
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
        set_slots(&mut c, 0, &[5], &[a.id.clone()]).unwrap();
        assert!(delete_activity(&mut c, &a.id, None).is_err(), "used");
        let other = add_activity(&c, "Guitar", "Training").unwrap().id;
        delete_activity(&mut c, &a.id, Some(&other)).unwrap();
        assert_eq!(count(&c, &format!("SELECT COUNT(*) FROM timetable_slots WHERE weekday=0 AND slot_index=5 AND activity_id='{other}'")), 1);
        delete_activity(&mut c, &other, Some(&other)).unwrap_err();
        c.execute("DELETE FROM timetable_slots WHERE activity_id=?1", [&other]).unwrap();
        delete_activity(&mut c, &other, None).unwrap();
    }
}
