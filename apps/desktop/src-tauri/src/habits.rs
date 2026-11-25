//! Habits and timetable check-ins. A habit is something to do each day (Exercise, Anki, Reading...). The log holds at most one entry per habit per day: done, skipped,
//! or no answer (a check-in pop-up left alone for 2 hours); a day with no entry is just empty, and any entry can be changed or removed by hand. A check-in ties a habit to a
//! timetable block (weekday, start and end half-hour slot, week A or B): the page shows a pop-up when that block starts. Days are the device's local calendar days, sent by the
//! page ("2026-11-24"), and times are seconds since 1970 sent by the page too, so the page's simulated clock works for testing. A habit is archived, not deleted, so its history stays.
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

const MAX_HABITS: i64 = 40;
/// A pop-up left unanswered for this long is logged as "no answer".
pub const EXPIRY_SECS: i64 = 2 * 3600;
const MAX_IMPORT: usize = 50_000;

fn e(x: rusqlite::Error) -> String { x.to_string() }
/// A real calendar day written YYYY-MM-DD.
fn valid_day(c: &Connection, day: &str) -> bool {
    day.len() == 10 && c.query_row("SELECT date(?1) IS ?1", [day], |r| r.get::<_, bool>(0)).unwrap_or(false)
}
fn iso(c: &Connection, secs: i64) -> Result<String, String> {
    c.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?1, 'unixepoch')", [secs], |r| r.get::<_, Option<String>>(0)).map_err(e)?.ok_or_else(|| "Invalid time".to_string())
}
fn clean_name(name: &str) -> Result<String, String> {
    let n = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if n.is_empty() || n.chars().count() > 60 || n.chars().any(char::is_control) { return Err("A habit needs a name of 1 to 60 characters".into()); }
    Ok(n)
}

// ---- habits ----
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Habit { pub id: String, pub name: String, pub days: i64, pub sort_order: i64, pub created_at: String, pub category: String }
const HABIT: &str = "SELECT id,name,days,sort_order,created_at,category FROM habits";
fn habit_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Habit> { Ok(Habit { id: r.get(0)?, name: r.get(1)?, days: r.get(2)?, sort_order: r.get(3)?, created_at: r.get(4)?, category: r.get(5)? }) }
fn habit_get(c: &Connection, id: &str) -> Result<Habit, String> {
    c.query_row(&format!("{HABIT} WHERE id=?1 AND archived_at IS NULL"), [id], habit_row).optional().map_err(e)?.ok_or_else(|| "Habit not found".to_string())
}
/// The live habits in the order they are shown.
pub fn habits_list(c: &Connection) -> Result<Vec<Habit>, String> {
    let mut s = c.prepare(&format!("{HABIT} WHERE archived_at IS NULL ORDER BY sort_order, name COLLATE NOCASE")).map_err(e)?;
    let rows = s.query_map([], habit_row).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
fn check_days(days: i64) -> Result<i64, String> { if (1..=127).contains(&days) { Ok(days) } else { Err("Pick at least one day the habit applies to".into()) } }
/// The habit types are the timetable's categories, so a habit's blocks take its colour.
pub const TYPES: [&str; 7] = ["Work", "Training", "Leisure", "Health", "Travel", "Chores", "Rest"];
fn check_type(t: &str) -> Result<(), String> { if TYPES.contains(&t) { Ok(()) } else { Err("Unknown habit type".into()) } }
/// Add a habit (`days` is a bit per weekday, Monday = 1 ... Sunday = 64; default every day; `category` is its type, default Health). A name that was deleted before is brought back
/// with its history. It also appears in the Life Timetable's activities (an activity of the same name is taken over, so nothing is listed twice and its blocks stay).
pub fn habit_add(c: &Connection, name: &str, days: Option<i64>, category: Option<&str>) -> Result<Habit, String> {
    let name = clean_name(name)?; let days = check_days(days.unwrap_or(127))?; let category = category.unwrap_or("Health"); check_type(category)?;
    let live: i64 = c.query_row("SELECT COUNT(*) FROM habits WHERE archived_at IS NULL", [], |r| r.get(0)).map_err(e)?;
    if live >= MAX_HABITS { return Err("Too many habits; delete some first".into()); }
    let order: i64 = c.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM habits", [], |r| r.get(0)).map_err(e)?;
    let old: Option<String> = c.query_row("SELECT id FROM habits WHERE name=?1 AND archived_at IS NOT NULL ORDER BY archived_at DESC", [&name], |r| r.get(0)).optional().map_err(e)?;
    let id = match old {
        Some(id) => { c.execute("UPDATE habits SET archived_at=NULL,days=?1,sort_order=?2,category=?3 WHERE id=?4", params![days, order, category, id]).map_err(e)?; id }
        None => {
            let id = Uuid::new_v4().to_string();
            c.execute("INSERT INTO habits(id,name,days,sort_order,category) VALUES(?1,?2,?3,?4,?5)", params![id, name, days, order, category])
                .map_err(|x| if x.to_string().contains("UNIQUE") { "A habit with that name already exists".to_string() } else { x.to_string() })?;
            id
        }
    };
    let h = habit_get(c, &id)?; ensure_activity(c, &h)?; sync_checkins(c)?;
    Ok(h)
}
/// Rename a habit, change its days or its type. The timetable activity follows (name and colour).
pub fn habit_update(c: &Connection, id: &str, name: Option<&str>, days: Option<i64>, category: Option<&str>) -> Result<Habit, String> {
    habit_get(c, id)?;
    if let Some(n) = name {
        let n = clean_name(n)?;
        c.execute("UPDATE habits SET name=?1 WHERE id=?2", params![n, id]).map_err(|x| if x.to_string().contains("UNIQUE") { "A habit with that name already exists".to_string() } else { x.to_string() })?;
    }
    if let Some(d) = days { c.execute("UPDATE habits SET days=?1 WHERE id=?2", params![check_days(d)?, id]).map_err(e)?; }
    if let Some(t) = category { check_type(t)?; c.execute("UPDATE habits SET category=?1 WHERE id=?2", params![t, id]).map_err(e)?; }
    let h = habit_get(c, id)?; ensure_activity(c, &h)?; sync_checkins(c)?;
    Ok(h)
}
/// Put the habits in the given order (ids not listed keep their place after the listed ones).
pub fn habits_reorder(c: &mut Connection, ids: &[String]) -> Result<(), String> {
    let tx = c.transaction().map_err(e)?;
    let mut order = 0i64; let mut seen = std::collections::HashSet::new();
    for id in ids { if !seen.insert(id.clone()) { continue; } habit_get(&tx, id)?; tx.execute("UPDATE habits SET sort_order=?1 WHERE id=?2", params![order, id]).map_err(e)?; order += 1; }
    let rest: Vec<String> = { let mut s = tx.prepare("SELECT id FROM habits WHERE archived_at IS NULL ORDER BY sort_order, name COLLATE NOCASE").map_err(e)?; let r = s.query_map([], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<Vec<String>>>().map_err(e)?; r };
    for id in rest { if seen.contains(&id) { continue; } tx.execute("UPDATE habits SET sort_order=?1 WHERE id=?2", params![order, id]).map_err(e)?; order += 1; }
    tx.commit().map_err(e)
}
/// Remove a habit from the page and from the timetable's check-ins. Its history is kept and comes back if the same name is added again. Its timetable activity stays (with its blocks) as an ordinary activity.
pub fn habit_delete(c: &Connection, id: &str) -> Result<(), String> {
    habit_get(c, id)?;
    c.execute("UPDATE timetable_activities SET habit_id=NULL WHERE habit_id=?1", [id]).map_err(e)?;
    c.execute("DELETE FROM checkins WHERE habit_id=?1", [id]).map_err(e)?;
    c.execute("UPDATE checkin_events SET state='lapsed' WHERE habit_id=?1 AND state='shown'", [id]).map_err(e)?;
    c.execute("UPDATE habits SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [id]).map_err(e)?;
    Ok(())
}

/// A read-only picture of the habits for an assistant: name, type, the days it counts and how many of the last 14 days (up to `today`) were done. No ids.
pub fn summary(c: &Connection) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let today: String = c.query_row("SELECT date('now','localtime')", [], |r| r.get(0)).map_err(e)?;
    let mut out = Vec::new();
    for h in habits_list(c)? {
        let done: i64 = c.query_row("SELECT COUNT(*) FROM habit_log WHERE habit_id=?1 AND state='done' AND day BETWEEN date(?2,'-13 days') AND ?2", params![h.id, today], |r| r.get(0)).map_err(e)?;
        let days: Vec<&str> = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].iter().enumerate().filter(|(i, _)| h.days & (1 << i) != 0).map(|(_, d)| *d).collect();
        out.push(json!({ "name": h.name, "type": h.category, "days": days, "done_last_14_days": done }));
    }
    Ok(json!(out))
}

// ---- habits in the timetable ----
/// Make sure the habit has its activity in the timetable and that the two agree on name and type. An activity that already has the habit's name (in any category) is taken over,
/// so it is not listed twice and the blocks already placed stay where they are.
pub fn ensure_activity(c: &Connection, h: &Habit) -> Result<(), String> {
    let linked: Option<String> = c.query_row("SELECT id FROM timetable_activities WHERE habit_id=?1", [&h.id], |r| r.get(0)).optional().map_err(e)?;
    if let Some(aid) = linked {
        c.execute("UPDATE timetable_activities SET name=?1,category=?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?3", params![h.name, h.category, aid])
            .map_err(|x| if x.to_string().contains("UNIQUE") { "A timetable activity with that name already exists".to_string() } else { x.to_string() })?;
        return Ok(());
    }
    let same: Option<(String, Option<String>)> = c.query_row("SELECT id,habit_id FROM timetable_activities WHERE name=?1 COLLATE NOCASE", [&h.name], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?;
    match same {
        Some((aid, None)) => { c.execute("UPDATE timetable_activities SET habit_id=?1,name=?2,category=?3,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?4", params![h.id, h.name, h.category, aid]).map_err(e)?; }
        Some((_, Some(_))) => return Err("A timetable activity with that name already belongs to another habit".into()),
        None => {
            let order: i64 = c.query_row("SELECT COALESCE(MAX(sort_order),-1)+1 FROM timetable_activities", [], |r| r.get(0)).map_err(e)?;
            c.execute("INSERT INTO timetable_activities(id,name,category,sort_order,habit_id,remind) VALUES(?1,?2,?3,?4,?5,0)", params![Uuid::new_v4().to_string(), h.name, h.category, order, h.id]).map_err(e)?;
        }
    }
    Ok(())
}
/// After upgrading to schema 17: every habit gets its activity.
pub fn link_all(c: &Connection) -> Result<(), String> {
    for h in habits_list(c)? { ensure_activity(c, &h)?; }
    sync_checkins(c)
}
/// Rebuild the check-ins from the timetable: each stretch of consecutive half-hours holding a habit's activity, on one weekday of one week, is one check-in at its start.
/// Check-ins that did not change keep their id (so today's pop-up history stays attached); the others are removed or added.
pub fn sync_checkins(c: &Connection) -> Result<(), String> {
    let mut want: std::collections::BTreeSet<(String, String, i64, i64, i64)> = Default::default();
    {
        let mut s = c.prepare("SELECT a.habit_id,t.variant,t.weekday,t.slot_index FROM timetable_slots t JOIN timetable_activities a ON a.id=t.activity_id JOIN habits h ON h.id=a.habit_id WHERE h.archived_at IS NULL ORDER BY a.habit_id,t.variant,t.weekday,t.slot_index").map_err(e)?;
        let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
        let mut i = 0;
        while i < rows.len() {
            let (h, v, d, st) = rows[i].clone(); let mut end = st + 1; i += 1;
            while i < rows.len() && rows[i].0 == h && rows[i].1 == v && rows[i].2 == d && rows[i].3 == end { end += 1; i += 1; }
            want.insert((h, v, d, st, end));
        }
    }
    let have: Vec<(String, (String, String, i64, i64, i64))> = {
        let mut s = c.prepare("SELECT id,habit_id,variant,weekday,start_slot,end_slot FROM checkins").map_err(e)?;
        let r = s.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?)))).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?; r
    };
    let mut kept = std::collections::BTreeSet::new();
    for (id, k) in &have { if want.contains(k) { kept.insert(k.clone()); } else { c.execute("DELETE FROM checkins WHERE id=?1", [id]).map_err(e)?; } }
    for k in want.difference(&kept) { c.execute("INSERT INTO checkins(id,habit_id,variant,weekday,start_slot,end_slot) VALUES(?1,?2,?3,?4,?5,?6)", params![Uuid::new_v4().to_string(), k.0, k.1, k.2, k.3, k.4]).map_err(e)?; }
    Ok(())
}

// ---- the log ----
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LogEntry { pub day: String, pub habit_id: String, pub state: String, pub answered_at: Option<String>, pub source: String }
/// Entries of the live habits from one day to another (inclusive).
pub fn log_list(c: &Connection, from: &str, to: &str) -> Result<Vec<LogEntry>, String> {
    if !valid_day(c, from) || !valid_day(c, to) { return Err("Days must be written like 2026-11-24".into()); }
    let mut s = c.prepare("SELECT l.day,l.habit_id,l.state,l.answered_at,l.source FROM habit_log l JOIN habits h ON h.id=l.habit_id WHERE h.archived_at IS NULL AND l.day BETWEEN ?1 AND ?2 ORDER BY l.day, h.sort_order").map_err(e)?;
    let rows = s.query_map(params![from, to], |r| Ok(LogEntry { day: r.get(0)?, habit_id: r.get(1)?, state: r.get(2)?, answered_at: r.get(3)?, source: r.get(4)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
/// Tick, skip or clear one habit on one day by hand. Today and earlier days only. A pop-up for that day and habit that is still open is closed.
pub fn log_set(c: &Connection, day: &str, habit_id: &str, state: Option<&str>, today: &str, now: i64) -> Result<(), String> {
    if !valid_day(c, day) || !valid_day(c, today) { return Err("Days must be written like 2026-11-24".into()); }
    if day > today { return Err("A day that has not happened yet cannot be logged".into()); }
    habit_get(c, habit_id)?;
    match state {
        Some("done") | Some("skipped") => { c.execute("INSERT INTO habit_log(day,habit_id,state,answered_at,source) VALUES(?1,?2,?3,?4,'manual') ON CONFLICT(day,habit_id) DO UPDATE SET state=excluded.state,answered_at=excluded.answered_at,source='manual'", params![day, habit_id, state.unwrap(), iso(c, now)?]).map_err(e)?; }
        None => { c.execute("DELETE FROM habit_log WHERE day=?1 AND habit_id=?2", params![day, habit_id]).map_err(e)?; }
        _ => return Err("A day can be marked done, skipped, or cleared".into()),
    }
    c.execute("UPDATE checkin_events SET state='answered' WHERE day=?1 AND habit_id=?2 AND state='shown'", params![day, habit_id]).map_err(e)?;
    Ok(())
}

#[derive(Deserialize, Debug)]
pub struct ImportRow { pub day: String, pub habit: String, pub done: bool }
#[derive(Serialize, Debug, PartialEq)]
pub struct Imported { pub habits_added: usize, pub entries_added: usize, pub entries_kept: usize }
/// Bring in earlier history (for example from a Notion table with one checkbox per habit per day). Habits that do not exist yet are created; only ticks are written (an empty
/// box stays empty); existing entries are never overwritten; each habit in the file counts from the first day in it (like the columns of the table it came from), so days before that do not lower its progress.
pub fn import_log(c: &mut Connection, rows: &[ImportRow]) -> Result<Imported, String> {
    if rows.len() > MAX_IMPORT { return Err(format!("At most {MAX_IMPORT} entries can be imported at once")); }
    let tx = c.transaction().map_err(e)?;
    for r in rows { if !valid_day(&tx, &r.day) { return Err(format!("“{}” is not a day written like 2026-11-24", r.day)); } clean_name(&r.habit)?; }
    let (mut habits_added, mut entries_added, mut entries_kept) = (0, 0, 0);
    let mut ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for r in rows {
        let name = clean_name(&r.habit)?; let key = name.to_lowercase();
        if !ids.contains_key(&key) {
            let existing: Option<String> = tx.query_row("SELECT id FROM habits WHERE name=?1 AND archived_at IS NULL", [&name], |x| x.get(0)).optional().map_err(e)?;
            let id = match existing { Some(id) => id, None => { habits_added += 1; habit_add(&tx, &name, None, None)?.id } };
            ids.insert(key.clone(), id);
        }
        if !r.done { continue; }
        let id = &ids[&key];
        let n = tx.execute("INSERT OR IGNORE INTO habit_log(day,habit_id,state,answered_at,source) VALUES(?1,?2,'done',NULL,'import')", params![r.day, id]).map_err(e)?;
        if n == 1 { entries_added += 1 } else { entries_kept += 1 }
        tx.execute("UPDATE habits SET created_at=?1 WHERE id=?2 AND substr(created_at,1,10)>?3", params![format!("{}T00:00:00.000Z", r.day), id, r.day]).map_err(e)?;
    }
    // A habit with no tick in the file still counts from the earliest day in it.
    if let Some(first) = rows.iter().map(|r| r.day.as_str()).min() {
        for id in ids.values() { tx.execute("UPDATE habits SET created_at=?1 WHERE id=?2 AND substr(created_at,1,10)>?3", params![format!("{first}T00:00:00.000Z"), id, first]).map_err(e)?; }
    }
    tx.commit().map_err(e)?;
    Ok(Imported { habits_added, entries_added, entries_kept })
}

// ---- check-ins on timetable blocks ----
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Checkin { pub id: String, pub habit_id: String, pub weekday: i64, pub start_slot: i64, pub end_slot: i64, pub variant: String }
pub fn checkin_list(c: &Connection) -> Result<Vec<Checkin>, String> {
    let mut s = c.prepare("SELECT k.id,k.habit_id,k.weekday,k.start_slot,k.end_slot,k.variant FROM checkins k JOIN habits h ON h.id=k.habit_id WHERE h.archived_at IS NULL ORDER BY k.variant,k.weekday,k.start_slot,h.sort_order").map_err(e)?;
    let rows = s.query_map([], |r| Ok(Checkin { id: r.get(0)?, habit_id: r.get(1)?, weekday: r.get(2)?, start_slot: r.get(3)?, end_slot: r.get(4)?, variant: r.get(5)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
// ---- pop-ups ----
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Event { pub checkin_id: String, pub day: String, pub habit_id: String, pub habit: String, pub block: String, pub start_slot: i64, pub end_slot: i64, pub shown_at: i64, pub expires_at: i64, pub state: String }
const EVENT: &str = "SELECT v.checkin_id,v.day,v.habit_id,h.name,v.block,v.start_slot,v.end_slot,v.shown_at,v.expires_at,v.state FROM checkin_events v JOIN habits h ON h.id=v.habit_id";
fn event_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Event> { Ok(Event { checkin_id: r.get(0)?, day: r.get(1)?, habit_id: r.get(2)?, habit: r.get(3)?, block: r.get(4)?, start_slot: r.get(5)?, end_slot: r.get(6)?, shown_at: r.get(7)?, expires_at: r.get(8)?, state: r.get(9)? }) }
/// A check-in's block is running: record the pop-up (once per check-in per day). It stays open for two hours, or until the block ends (`until`, seconds) if that is later. Nothing is shown when the habit is already logged for the day.
pub fn event_show(c: &Connection, checkin_id: &str, day: &str, block: &str, now: i64, until: i64) -> Result<Option<Event>, String> {
    if !valid_day(c, day) { return Err("Days must be written like 2026-11-24".into()); }
    let k: Option<(String, i64, i64)> = c.query_row("SELECT k.habit_id,k.start_slot,k.end_slot FROM checkins k JOIN habits h ON h.id=k.habit_id WHERE k.id=?1 AND h.archived_at IS NULL", [checkin_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(e)?;
    let Some((habit_id, start, end)) = k else { return Err("Check-in not found".into()) };
    let logged: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM habit_log WHERE day=?1 AND habit_id=?2)", params![day, habit_id], |r| r.get(0)).map_err(e)?;
    if logged { return Ok(None); }
    let block: String = block.chars().filter(|ch| !ch.is_control()).take(200).collect();
    let n = c.execute("INSERT OR IGNORE INTO checkin_events(checkin_id,day,habit_id,block,start_slot,end_slot,shown_at,expires_at,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'shown')", params![checkin_id, day, habit_id, block, start, end, now, (now + EXPIRY_SECS).max(until)]).map_err(e)?;
    if n == 0 { return Ok(None); }
    c.query_row(&format!("{EVENT} WHERE v.checkin_id=?1 AND v.day=?2"), params![checkin_id, day], event_row).optional().map_err(e)
}
/// Pop-ups that are open: shown and not yet answered or expired.
pub fn events_pending(c: &Connection, now: i64) -> Result<Vec<Event>, String> {
    let mut s = c.prepare(&format!("{EVENT} WHERE v.state='shown' AND v.expires_at>?1 ORDER BY v.shown_at, h.sort_order")).map_err(e)?;
    let rows = s.query_map([now], event_row).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
/// One tap on a pop-up: "done" or "skipped". It is logged for that day with the time answered. Refused once the pop-up has expired (tick it on the Habits page instead).
pub fn event_answer(c: &Connection, checkin_id: &str, day: &str, answer: &str, now: i64) -> Result<LogEntry, String> {
    if answer != "done" && answer != "skipped" { return Err("Answer Checked in or Skipping".into()); }
    let ev: Option<(String, String, i64)> = c.query_row("SELECT habit_id,state,expires_at FROM checkin_events WHERE checkin_id=?1 AND day=?2", params![checkin_id, day], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(e)?;
    let Some((habit_id, state, expires)) = ev else { return Err("Pop-up not found".into()) };
    if state != "shown" { return Err("This pop-up was already answered or has closed. You can still change the day on the Habits page.".into()); }
    if now >= expires { return Err("This pop-up has expired. You can tick the habit on the Habits page.".into()); }
    habit_get(c, &habit_id)?;
    let when = iso(c, now)?;
    c.execute("INSERT INTO habit_log(day,habit_id,state,answered_at,source) VALUES(?1,?2,?3,?4,'popup') ON CONFLICT(day,habit_id) DO UPDATE SET state=excluded.state,answered_at=excluded.answered_at,source='popup'", params![day, habit_id, answer, when]).map_err(e)?;
    c.execute("UPDATE checkin_events SET state='answered' WHERE checkin_id=?1 AND day=?2", params![checkin_id, day]).map_err(e)?;
    Ok(LogEntry { day: day.into(), habit_id, state: answer.into(), answered_at: Some(when), source: "popup".into() })
}
/// Close pop-ups whose 2 hours are up. While NOU was running they become "no answer" (unless the day is already logged); when NOU was closed (`closed`) they are only marked
/// lapsed, with nothing logged, so the habit can be ticked by hand. Returns how many were closed.
pub fn events_sweep(c: &Connection, now: i64, closed: bool) -> Result<usize, String> {
    let due: Vec<(String, String, String)> = {
        let mut s = c.prepare("SELECT checkin_id,day,habit_id FROM checkin_events WHERE state='shown' AND expires_at<=?1").map_err(e)?;
        let rows = s.query_map([now], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?; rows
    };
    for (checkin, day, habit) in &due {
        if closed { c.execute("UPDATE checkin_events SET state='lapsed' WHERE checkin_id=?1 AND day=?2", params![checkin, day]).map_err(e)?; continue; }
        c.execute("INSERT OR IGNORE INTO habit_log(day,habit_id,state,answered_at,source) VALUES(?1,?2,'no_answer',?3,'timeout')", params![day, habit, iso(c, now)?]).map_err(e)?;
        c.execute("UPDATE checkin_events SET state='expired' WHERE checkin_id=?1 AND day=?2", params![checkin, day]).map_err(e)?;
    }
    Ok(due.len())
}

// ---- commands ----
macro_rules! locked { ($db:expr) => { $db.0.lock().map_err(|_| "Database lock poisoned")? }; }
#[tauri::command]
pub fn habits_list_cmd(db: State<'_, Db>) -> Result<Vec<Habit>, String> { let c = locked!(db); habits_list(&c) }
#[tauri::command]
pub fn habit_add_cmd(db: State<'_, Db>, name: String, days: Option<i64>, category: Option<String>) -> Result<Habit, String> { let c = locked!(db); db.writable()?; habit_add(&c, &name, days, category.as_deref()) }
#[tauri::command]
pub fn habit_update_cmd(db: State<'_, Db>, id: String, name: Option<String>, days: Option<i64>, category: Option<String>) -> Result<Habit, String> { let c = locked!(db); db.writable()?; habit_update(&c, &id, name.as_deref(), days, category.as_deref()) }
#[tauri::command]
pub fn habits_reorder_cmd(db: State<'_, Db>, ids: Vec<String>) -> Result<(), String> { let mut c = locked!(db); db.writable()?; habits_reorder(&mut c, &ids) }
#[tauri::command]
pub fn habit_delete_cmd(db: State<'_, Db>, id: String) -> Result<(), String> { let c = locked!(db); db.writable()?; habit_delete(&c, &id) }
#[tauri::command]
pub fn habit_log_list_cmd(db: State<'_, Db>, from: String, to: String) -> Result<Vec<LogEntry>, String> { let c = locked!(db); log_list(&c, &from, &to) }
#[tauri::command]
pub fn habit_log_set_cmd(db: State<'_, Db>, day: String, habit_id: String, state: Option<String>, today: String, now: i64) -> Result<(), String> { let c = locked!(db); db.writable()?; log_set(&c, &day, &habit_id, state.as_deref(), &today, now) }
#[tauri::command]
pub fn habit_import_cmd(db: State<'_, Db>, rows: Vec<ImportRow>) -> Result<Imported, String> { let mut c = locked!(db); db.writable()?; import_log(&mut c, &rows) }
#[tauri::command]
pub fn checkin_list_cmd(db: State<'_, Db>) -> Result<Vec<Checkin>, String> { let c = locked!(db); checkin_list(&c) }
#[tauri::command]
pub fn checkin_event_show_cmd(db: State<'_, Db>, checkin_id: String, day: String, block: String, now: i64, until: i64) -> Result<Option<Event>, String> { let c = locked!(db); db.writable()?; event_show(&c, &checkin_id, &day, &block, now, until) }
#[tauri::command]
pub fn checkin_events_pending_cmd(db: State<'_, Db>, now: i64) -> Result<Vec<Event>, String> { let c = locked!(db); events_pending(&c, now) }
#[tauri::command]
pub fn checkin_event_answer_cmd(db: State<'_, Db>, checkin_id: String, day: String, answer: String, now: i64) -> Result<LogEntry, String> { let c = locked!(db); db.writable()?; event_answer(&c, &checkin_id, &day, &answer, now) }
#[tauri::command]
pub fn checkin_events_sweep_cmd(db: State<'_, Db>, now: i64, closed: bool) -> Result<usize, String> { let c = locked!(db); db.writable()?; events_sweep(&c, now, closed) }

#[cfg(test)]
mod tests {
    use super::*;
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        c.execute("DELETE FROM timetable_slots", []).unwrap(); // start from an empty grid: the shipped plan already holds activities named like the test habits
        c
    }
    /// Put the habits' timetable activities on a stretch of the grid (what the Life Timetable does when a block holding them is saved), then rebuild the check-ins.
    fn block(c: &Connection, variant: &str, days: &[i64], start: i64, end: i64, habits: &[String]) {
        for h in habits { let aid: String = c.query_row("SELECT id FROM timetable_activities WHERE habit_id=?1", [h], |r| r.get(0)).unwrap(); for d in days { for sl in start..end { c.execute("INSERT OR IGNORE INTO timetable_slots(variant,weekday,slot_index,activity_id) VALUES(?1,?2,?3,?4)", params![variant, d, sl, aid]).unwrap(); } } }
        sync_checkins(c).unwrap();
    }
    const T0: i64 = 1_800_000_000; // 2027-01-15 08:00:00 UTC
    const TODAY: &str = "2027-01-15";
    fn state_of(c: &Connection, day: &str, habit: &str) -> Option<(String, String)> { c.query_row("SELECT state,source FROM habit_log WHERE day=?1 AND habit_id=?2", params![day, habit], |r| Ok((r.get(0)?, r.get(1)?))).optional().unwrap() }

    #[test]
    fn habits_are_added_renamed_and_deleted_without_losing_history() {
        let mut c = fresh();
        let ex = habit_add(&c, "  Exercise ", None, None).unwrap(); assert_eq!((ex.name.as_str(), ex.days), ("Exercise", 127));
        let anki = habit_add(&c, "Anki", Some(31), None).unwrap(); assert_eq!(anki.days, 31);
        assert!(habit_add(&c, "exercise", None, None).unwrap_err().contains("already exists"), "names are unique, ignoring case");
        for bad in ["", "   ", &"x".repeat(61), "a\u{7}b"] { assert!(habit_add(&c, bad, None, None).is_err(), "{bad:?}"); }
        assert!(habit_add(&c, "Reading", Some(0), None).is_err() && habit_add(&c, "Reading", Some(128), None).is_err());
        assert_eq!(habits_list(&c).unwrap().iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), vec!["Exercise", "Anki"], "in the order they were added");
        assert_eq!(habit_update(&c, &anki.id, Some("Anki cards"), Some(127), None).unwrap().name, "Anki cards"); assert!(habit_update(&c, &anki.id, Some("EXERCISE"), None, None).is_err() && habit_update(&c, "nope", None, None, None).is_err());
        // Deleting keeps the history and takes the habit out of the check-ins; adding the name again brings it back.
        log_set(&c, TODAY, &ex.id, Some("done"), TODAY, T0).unwrap();
        block(&c, "A", &[0], 10, 11, &[ex.id.clone(), anki.id.clone()]);
        habit_delete(&c, &ex.id).unwrap();
        assert_eq!(checkin_list(&c).unwrap().iter().map(|k| k.habit_id.as_str()).collect::<Vec<_>>(), vec![anki.id.as_str()], "its check-ins are removed, the other habit's stay");
        assert!(habit_delete(&c, &ex.id).is_err() && habits_list(&c).unwrap().len() == 1);
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM habit_log", [], |r| r.get(0)).unwrap(), 1, "the log row is still there");
        assert!(log_list(&c, TODAY, TODAY).unwrap().is_empty(), "but it is not shown while the habit is deleted");
        let back = habit_add(&c, "exercise", None, None).unwrap(); assert_eq!(back.id, ex.id, "the same habit, with its history");
        assert_eq!(log_list(&c, TODAY, TODAY).unwrap().len(), 1);
        for i in 0..(MAX_HABITS - 2) { habit_add(&c, &format!("H{i}"), None, None).unwrap(); }
        assert!(habit_add(&c, "One too many", None, None).unwrap_err().contains("Too many"));
    }

    #[test]
    fn a_day_is_ticked_skipped_or_cleared_by_hand_but_never_in_the_future() {
        let c = fresh(); let h = habit_add(&c, "Reading", None, None).unwrap();
        log_set(&c, "2027-01-10", &h.id, Some("done"), TODAY, T0).unwrap();
        assert_eq!(state_of(&c, "2027-01-10", &h.id), Some(("done".into(), "manual".into())));
        log_set(&c, "2027-01-10", &h.id, Some("skipped"), TODAY, T0).unwrap(); assert_eq!(state_of(&c, "2027-01-10", &h.id).unwrap().0, "skipped", "it can be changed");
        log_set(&c, "2027-01-10", &h.id, None, TODAY, T0).unwrap(); assert_eq!(state_of(&c, "2027-01-10", &h.id), None, "and cleared");
        log_set(&c, TODAY, &h.id, Some("done"), TODAY, T0).unwrap();
        assert!(log_set(&c, "2027-01-16", &h.id, Some("done"), TODAY, T0).unwrap_err().contains("not happened yet"));
        for bad in ["2027-02-30", "27-01-10", "2027/01/10", "", "2027-1-1"] { assert!(log_set(&c, bad, &h.id, Some("done"), TODAY, T0).is_err(), "{bad}"); }
        assert!(log_set(&c, TODAY, &h.id, Some("no_answer"), TODAY, T0).is_err() && log_set(&c, TODAY, &h.id, Some("maybe"), TODAY, T0).is_err(), "no answer is only ever written by a timed-out pop-up");
        assert!(log_set(&c, TODAY, "nope", Some("done"), TODAY, T0).is_err());
        assert!(log_list(&c, "2027-02-30", TODAY).is_err());
        assert_eq!(log_list(&c, "2027-01-01", "2027-01-31").unwrap().len(), 1);
        assert_eq!(log_list(&c, "2027-01-16", "2027-01-31").unwrap().len(), 0, "the range limits what is returned");
    }

    #[test]
    fn check_ins_come_from_where_a_habit_sits_in_the_timetable() {
        let c = fresh(); let ex = habit_add(&c, "Exercise", None, Some("Training")).unwrap().id; let anki = habit_add(&c, "Anki", None, None).unwrap().id;
        // Exercise and Anki both sit on the 05:00-05:30 block (slot 10), Monday to Friday, in week A.
        block(&c, "A", &[0, 1, 2, 3, 4], 10, 11, &[ex.clone(), anki.clone()]);
        let list = checkin_list(&c).unwrap(); assert_eq!(list.len(), 10); assert!(list.iter().all(|k| k.variant == "A" && k.start_slot == 10 && k.end_slot == 11));
        assert_eq!(list.iter().filter(|k| k.weekday == 2).map(|k| k.habit_id.as_str()).collect::<Vec<_>>(), vec![ex.as_str(), anki.as_str()], "both habits at the same block, in habit order");
        // A longer stretch is one check-in at its start; a gap makes two.
        block(&c, "A", &[0], 11, 13, &[ex.clone()]); let mon: Vec<_> = checkin_list(&c).unwrap().into_iter().filter(|k| k.weekday == 0 && k.habit_id == ex).collect();
        assert_eq!((mon.len(), mon[0].start_slot, mon[0].end_slot), (1, 10, 13), "05:00-06:30 is one stretch");
        block(&c, "B", &[5], 18, 20, &[ex.clone()]); block(&c, "B", &[5], 24, 26, &[ex.clone()]);
        assert_eq!(checkin_list(&c).unwrap().iter().filter(|k| k.variant == "B").map(|k| (k.start_slot, k.end_slot)).collect::<Vec<_>>(), vec![(18, 20), (24, 26)], "week B is separate and a gap makes two check-ins");
        // An unchanged check-in keeps its id (so its pop-up history stays attached); clearing the slots removes it.
        let ids: Vec<String> = checkin_list(&c).unwrap().into_iter().map(|k| k.id).collect(); sync_checkins(&c).unwrap();
        assert_eq!(checkin_list(&c).unwrap().into_iter().map(|k| k.id).collect::<Vec<_>>(), ids);
        c.execute("DELETE FROM timetable_slots WHERE variant='B'", []).unwrap(); sync_checkins(&c).unwrap();
        assert_eq!(checkin_list(&c).unwrap().iter().filter(|k| k.variant == "B").count(), 0);
        // Renaming or retyping a habit changes its timetable activity too.
        habit_update(&c, &ex, Some("Workout"), None, Some("Health")).unwrap();
        let (n, cat): (String, String) = c.query_row("SELECT name,category FROM timetable_activities WHERE habit_id=?1", [&ex], |r| Ok((r.get(0)?, r.get(1)?))).unwrap(); assert_eq!((n.as_str(), cat.as_str()), ("Workout", "Health"));
        assert!(habit_update(&c, &ex, None, None, Some("Nope")).is_err());
    }

    #[test]
    fn a_habit_takes_over_an_activity_with_the_same_name_and_the_order_can_be_changed() {
        let mut c = fresh();
        c.execute("INSERT INTO timetable_activities(id,name,category,sort_order) VALUES('mine','Meditate','Leisure',99)", []).unwrap();
        c.execute("INSERT INTO timetable_slots(variant,weekday,slot_index,activity_id) VALUES('A',0,20,'mine')", []).unwrap();
        let h = habit_add(&c, "meditate", None, Some("Health")).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM timetable_activities WHERE name='Meditate' COLLATE NOCASE", [], |r| r.get(0)).unwrap(); assert_eq!(n, 1, "listed once");
        let (id, cat, hid): (String, String, Option<String>) = c.query_row("SELECT id,category,habit_id FROM timetable_activities WHERE name='meditate' COLLATE NOCASE", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((id.as_str(), cat.as_str(), hid.as_deref()), ("mine", "Health", Some(h.id.as_str())), "same activity, now the habit's type");
        assert_eq!(checkin_list(&c).unwrap().len(), 1, "its block at 10:00 now checks in");
        let a = habit_add(&c, "Anki", None, None).unwrap(); let b = habit_add(&c, "Reading", None, None).unwrap();
        habits_reorder(&mut c, &[b.id.clone(), a.id.clone()]).unwrap();
        assert_eq!(habits_list(&c).unwrap().iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["Reading", "Anki", "meditate"], "listed first, then the rest");
        assert!(habits_reorder(&mut c, &["nope".into()]).is_err());
        habit_delete(&c, &h.id).unwrap();
        let hid: Option<String> = c.query_row("SELECT habit_id FROM timetable_activities WHERE id='mine'", [], |r| r.get(0)).unwrap(); assert!(hid.is_none(), "the activity stays, as an ordinary one");
        assert!(checkin_list(&c).unwrap().is_empty());
    }

    #[test]
    fn a_pop_up_is_recorded_once_a_day_is_answered_with_one_tap_and_an_answered_habit_is_not_asked_again() {
        let mut c = fresh(); let ex = habit_add(&c, "Exercise", None, None).unwrap(); let anki = habit_add(&c, "Anki", None, None).unwrap();
        block(&c, "A", &[4], 10, 11, &[ex.id.clone(), anki.id.clone()]);
        let ks = checkin_list(&c).unwrap(); let (k_ex, k_anki) = (&ks[0], &ks[1]);
        // Both habits get their own pop-up for the same block, once.
        let e1 = event_show(&c, &k_ex.id, TODAY, "Shower + Breakfast, Exercise", T0, 0).unwrap().unwrap();
        assert_eq!((e1.habit.as_str(), e1.state.as_str(), e1.expires_at - e1.shown_at, e1.start_slot, e1.end_slot), ("Exercise", "shown", EXPIRY_SECS, 10, 11));
        assert!(event_show(&c, &k_ex.id, TODAY, "x", T0 + 5, 0).unwrap().is_none(), "the same check-in does not pop up twice in a day");
        assert!(event_show(&c, &k_anki.id, TODAY, "x", T0, 0).unwrap().is_some()); assert_eq!(events_pending(&c, T0 + 10).unwrap().len(), 2);
        assert!(event_show(&c, "nope", TODAY, "x", T0, 0).is_err() && event_show(&c, &k_ex.id, "2027-02-30", "x", T0, 0).is_err());
        // One tap: Checked in. It is logged with the time answered, and the pop-up closes.
        let log = event_answer(&c, &k_ex.id, TODAY, "done", T0 + 300).unwrap();
        assert_eq!((log.state.as_str(), log.source.as_str(), log.answered_at.as_deref()), ("done", "popup", Some("2027-01-15T08:05:00Z")));
        assert_eq!(events_pending(&c, T0 + 400).unwrap().iter().map(|e| e.habit.as_str()).collect::<Vec<_>>(), vec!["Anki"]);
        assert!(event_answer(&c, &k_ex.id, TODAY, "skipped", T0 + 310).is_err(), "answered once; change it on the Habits page");
        assert!(event_answer(&c, &k_anki.id, TODAY, "maybe", T0 + 310).is_err());
        event_answer(&c, &k_anki.id, TODAY, "skipped", T0 + 320).unwrap(); assert_eq!(state_of(&c, TODAY, &anki.id), Some(("skipped".into(), "popup".into())));
        // A habit that is already logged for the day is not asked about.
        log_set(&c, "2027-01-22", &ex.id, Some("done"), "2027-01-22", T0).unwrap();
        assert!(event_show(&c, &k_ex.id, "2027-01-22", "x", T0, 0).unwrap().is_none());
    }

    #[test]
    fn an_unanswered_pop_up_is_no_answer_after_two_hours_if_nou_was_open_and_only_lapsed_if_it_was_closed() {
        let mut c = fresh(); let ex = habit_add(&c, "Exercise", None, None).unwrap(); let anki = habit_add(&c, "Anki", None, None).unwrap(); let rd = habit_add(&c, "Reading", None, None).unwrap();
        block(&c, "A", &[4], 10, 11, &[ex.id.clone(), anki.id.clone(), rd.id.clone()]);
        let ks = checkin_list(&c).unwrap();
        for k in &ks { event_show(&c, &k.id, TODAY, "block", T0, 0).unwrap().unwrap(); }
        assert_eq!(events_sweep(&c, T0 + EXPIRY_SECS - 1, false).unwrap(), 0, "not before two hours");
        assert!(event_answer(&c, &ks[2].id, TODAY, "done", T0 + EXPIRY_SECS - 1).is_ok(), "an answer just before is fine");
        // The reading tick came by hand before the sweep for Anki; the sweep must not overwrite it.
        log_set(&c, TODAY, &anki.id, Some("done"), TODAY, T0 + 100).unwrap();
        assert_eq!(events_sweep(&c, T0 + EXPIRY_SECS, false).unwrap(), 1, "only Exercise was still open");
        assert_eq!(state_of(&c, TODAY, &ex.id), Some(("no_answer".into(), "timeout".into())), "logged as no answer, never as done");
        assert_eq!(state_of(&c, TODAY, &anki.id), Some(("done".into(), "manual".into()))); assert_eq!(state_of(&c, TODAY, &rd.id).unwrap().0, "done");
        assert!(events_pending(&c, T0 + EXPIRY_SECS + 1).unwrap().is_empty());
        assert!(event_answer(&c, &ks[0].id, TODAY, "done", T0 + EXPIRY_SECS + 5).is_err(), "too late: tick it by hand");
        log_set(&c, TODAY, &ex.id, Some("done"), TODAY, T0 + EXPIRY_SECS + 60).unwrap(); assert_eq!(state_of(&c, TODAY, &ex.id), Some(("done".into(), "manual".into())), "no answer can be corrected by hand");
        // While NOU was closed: lapsed, nothing logged, so the habit can be ticked by hand.
        event_show(&c, &ks[0].id, "2027-01-22", "block", T0, 0).unwrap().unwrap();
        assert_eq!(events_sweep(&c, T0 + 10 * EXPIRY_SECS, true).unwrap(), 1);
        assert_eq!(state_of(&c, "2027-01-22", &ex.id), None); assert_eq!(c.query_row::<String, _, _>("SELECT state FROM checkin_events WHERE day='2027-01-22'", [], |r| r.get(0)).unwrap(), "lapsed");
        assert_eq!(events_sweep(&c, T0 + 10 * EXPIRY_SECS, false).unwrap(), 0, "a closed pop-up is not swept again");
        // Deleting a habit closes its open pop-ups.
        event_show(&c, &ks[1].id, "2027-01-29", "block", T0, 0).unwrap().unwrap(); habit_delete(&c, &anki.id).unwrap(); assert!(events_pending(&c, T0 + 1).unwrap().is_empty());
    }

    #[test]
    fn a_pop_up_for_a_long_block_stays_open_until_the_block_ends() {
        let c = fresh(); let ex = habit_add(&c, "Exercise", None, None).unwrap(); block(&c, "A", &[4], 10, 16, &[ex.id.clone()]); let k = checkin_list(&c).unwrap().remove(0);
        let e1 = event_show(&c, &k.id, TODAY, "block", T0, T0 + 3 * 3600).unwrap().unwrap(); // a 3-hour block
        assert_eq!(e1.expires_at, T0 + 3 * 3600, "open for the whole block, which is longer than two hours");
        assert_eq!(events_pending(&c, T0 + 2 * 3600 + 60).unwrap().len(), 1); assert_eq!(events_sweep(&c, T0 + 2 * 3600 + 60, false).unwrap(), 0);
        assert_eq!(events_sweep(&c, T0 + 3 * 3600, false).unwrap(), 1, "no answer once the block and the allowance are over");
    }
    #[test]
    fn a_manual_tick_closes_the_matching_pop_up() {
        let mut c = fresh(); let ex = habit_add(&c, "Exercise", None, None).unwrap();
        block(&c, "A", &[4], 10, 11, &[ex.id.clone()]); let k = checkin_list(&c).unwrap().remove(0);
        event_show(&c, &k.id, TODAY, "block", T0, 0).unwrap().unwrap(); assert_eq!(events_pending(&c, T0 + 1).unwrap().len(), 1);
        log_set(&c, TODAY, &ex.id, Some("done"), TODAY, T0 + 60).unwrap();
        assert!(events_pending(&c, T0 + 61).unwrap().is_empty(), "ticking it yourself closes the pop-up");
        assert_eq!(events_sweep(&c, T0 + EXPIRY_SECS + 1, false).unwrap(), 0);
    }

    #[test]
    fn history_can_be_imported_without_overwriting_and_counts_from_its_first_day() {
        let mut c = fresh();
        let existing = habit_add(&c, "Anki", None, None).unwrap(); log_set(&c, "2020-01-05", &existing.id, Some("skipped"), TODAY, T0).unwrap();
        let rows = |v: &[(&str, &str, bool)]| v.iter().map(|(d, h, x)| ImportRow { day: d.to_string(), habit: h.to_string(), done: *x }).collect::<Vec<_>>();
        let out = import_log(&mut c, &rows(&[("2020-01-04", "Anki", true), ("2020-01-05", "Anki", true), ("2020-01-05", "Exercise", true), ("2020-01-05", "reading", false), ("2020-01-06", "exercise", true)])).unwrap();
        assert_eq!(out, Imported { habits_added: 2, entries_added: 3, entries_kept: 1 }, "Exercise and Reading are new; 2020-01-05 Anki was already logged and is kept");
        assert_eq!(state_of(&c, "2020-01-05", &existing.id).unwrap().0, "skipped", "never overwritten");
        let h = habits_list(&c).unwrap(); let by = |n: &str| h.iter().find(|x| x.name.eq_ignore_ascii_case(n)).unwrap();
        assert!(h.iter().all(|x| x.created_at.starts_with("2020-01-04")), "every habit in the file counts from the first day in it, like the columns of the table it came from: {h:?}");
        assert_eq!(state_of(&c, "2020-01-06", &by("Exercise").id), Some(("done".into(), "import".into())));
        assert_eq!(state_of(&c, "2020-01-05", &by("Reading").id), None, "an empty box stays empty");
        // Bad rows refuse the whole import and change nothing.
        let before = c.query_row::<i64, _, _>("SELECT COUNT(*) FROM habit_log", [], |r| r.get(0)).unwrap();
        assert!(import_log(&mut c, &rows(&[("2020-01-07", "Anki", true), ("2027-02-30", "Anki", true)])).is_err() && import_log(&mut c, &rows(&[("2020-01-07", "", true)])).is_err());
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM habit_log", [], |r| r.get(0)).unwrap(), before);
        assert!(import_log(&mut c, &(0..=MAX_IMPORT).map(|_| ImportRow { day: "2020-01-01".into(), habit: "Anki".into(), done: true }).collect::<Vec<_>>()).is_err());
    }

    #[test]
    fn the_schema_16_tables_refuse_bad_data_directly() {
        let c = fresh(); let h = habit_add(&c, "Anki", None, None).unwrap();
        assert!(c.execute("INSERT INTO habit_log(day,habit_id,state,source) VALUES('2027-01-01',?1,'maybe','manual')", [&h.id]).is_err());
        assert!(c.execute("INSERT INTO habit_log(day,habit_id,state,source) VALUES('yesterday',?1,'done','manual')", [&h.id]).is_err());
        assert!(c.execute("INSERT INTO habit_log(day,habit_id,state,source) VALUES('2027-01-01','nope','done','manual')", []).is_err(), "a log entry needs a real habit");
        assert!(c.execute("INSERT INTO checkins(id,habit_id,weekday,start_slot,end_slot,variant) VALUES('k',?1,0,10,10,'A')", [&h.id]).is_err(), "an empty block");
        assert!(c.execute("UPDATE habits SET days=0 WHERE id=?1", [&h.id]).is_err());
        assert!(c.execute("DELETE FROM habits WHERE id=?1", [&h.id]).is_ok(), "a habit with no history can really be deleted");
        let h2 = habit_add(&c, "Reading", None, None).unwrap(); log_set(&c, TODAY, &h2.id, Some("done"), TODAY, T0).unwrap();
        assert!(c.execute("DELETE FROM habits WHERE id=?1", [&h2.id]).is_err(), "but history is protected");
    }
}
