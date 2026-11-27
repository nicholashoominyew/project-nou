//! The Daily page: one page per date (docs/development/DAILY.md). Only the app's own screens call these commands; no assistant can
//! read or write any of it yet (no gateway operation and no MCP tool exists for it). Nothing is overwritten or hard deleted by an
//! import: an entry already there (same section and text) is skipped, and a journal that is already written is kept.
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

/// The journal's blocks, in the order shown.
pub const BLOCKS: [&str; 6] = ["agenda", "goals", "win", "quote", "learn", "notes"];
/// The one section list, shared with the screens.
const REGISTRY: &str = include_str!("../../src/daily/section-registry.json");
const MAX_LINES: usize = 200;
const MAX_LINE: usize = 2000;
const MAX_ENTRY: usize = 4000;
const MAX_IMPORT_DAYS: usize = 1500;

fn e(x: rusqlite::Error) -> String { x.to_string() }
fn valid_day(c: &Connection, day: &str) -> bool {
    day.len() == 10 && c.query_row("SELECT date(?1) IS ?1", [day], |r| r.get::<_, bool>(0)).unwrap_or(false)
}
fn check_day(c: &Connection, day: &str) -> Result<(), String> { if valid_day(c, day) { Ok(()) } else { Err("That is not a date".into()) } }
/// Section ids that can hold entries (the journal is stored apart).
fn sections() -> Vec<String> {
    let v: Value = serde_json::from_str(REGISTRY).unwrap_or_default();
    v["sections"].as_array().map(|a| a.iter().filter_map(|s| s["id"].as_str()).filter(|id| *id != "journal").map(str::to_string).collect()).unwrap_or_default()
}
/// Creating a day is idempotent: the date is the key.
fn ensure_day(c: &Connection, day: &str) -> Result<(), String> {
    c.execute("INSERT OR IGNORE INTO daily_days(day) VALUES(?1)", [day]).map_err(e)?;
    c.execute("INSERT OR IGNORE INTO daily_summaries(day) VALUES(?1)", [day]).map_err(e)?;
    Ok(())
}

pub type Journal = std::collections::BTreeMap<String, Vec<String>>;
fn clean_journal(journal: &Journal) -> Result<Journal, String> {
    let mut out = Journal::new();
    for (block, lines) in journal {
        if !BLOCKS.contains(&block.as_str()) { return Err("Unknown journal block".into()); }
        if lines.len() > MAX_LINES || lines.iter().any(|l| l.chars().count() > MAX_LINE) { return Err("The journal is too long to save; shorten it".into()); }
        out.insert(block.clone(), lines.clone());
    }
    Ok(out)
}
fn written(journal: &Journal, block: &str) -> i64 { journal.get(block).map(|l| l.iter().filter(|x| !x.trim().is_empty()).count() as i64).unwrap_or(0) }

fn read_journal(c: &Connection, day: &str) -> Result<Option<Journal>, String> {
    let body: Option<String> = c.query_row("SELECT body FROM daily_journals WHERE day=?1", [day], |r| r.get(0)).optional().map_err(e)?;
    body.map(|b| serde_json::from_str(&b).map_err(|x| format!("This day's journal cannot be read: {x}"))).transpose()
}

/// Bring a day's calendar record up to date. "full" is a journal with three goals, a small win and a learning; "part" is anything written.
fn refresh_summary(c: &Connection, day: &str) -> Result<(), String> {
    let journal = read_journal(c, day)?.unwrap_or_default();
    let (goals, win, learn) = (written(&journal, "goals"), written(&journal, "win") > 0, written(&journal, "learn") > 0);
    let any = BLOCKS.iter().any(|b| written(&journal, b) > 0);
    let state = if goals >= 3 && win && learn { "full" } else if any { "part" } else { "none" };
    c.execute(
        "UPDATE daily_summaries SET journal=?2,goals=?3,win=?4,learn=?5,
          open_todos=(SELECT COUNT(*) FROM daily_entries WHERE day=?1 AND section='todo_list' AND done=0 AND deleted_at IS NULL),
          sections=(SELECT COUNT(DISTINCT section) FROM daily_entries WHERE day=?1 AND deleted_at IS NULL)
         WHERE day=?1", params![day, state, goals, win, learn]).map_err(e)?;
    Ok(())
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Entry { pub id: String, pub section: String, pub time: String, pub source: String, pub topic: String, pub text: String, pub link: String, pub done: bool }
#[derive(Serialize, Debug)]
pub struct Day { pub day: String, pub exists: bool, pub notion_page_id: Option<String>, pub entries: Vec<Entry>, pub journal: Journal }

/// One day's page. Reading never creates it.
pub fn get(c: &Connection, day: &str) -> Result<Day, String> {
    check_day(c, day)?;
    let page: Option<Option<String>> = c.query_row("SELECT notion_page_id FROM daily_days WHERE day=?1", [day], |r| r.get(0)).optional().map_err(e)?;
    let mut s = c.prepare("SELECT id,section,time,source,topic,text,link,done FROM daily_entries WHERE day=?1 AND deleted_at IS NULL ORDER BY section,position,created_at,id").map_err(e)?;
    let entries = s.query_map([day], |r| Ok(Entry { id: r.get(0)?, section: r.get(1)?, time: r.get(2)?, source: r.get(3)?, topic: r.get(4)?, text: r.get(5)?, link: r.get(6)?, done: r.get(7)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    Ok(Day { day: day.into(), exists: page.is_some(), notion_page_id: page.flatten(), entries, journal: read_journal(c, day)?.unwrap_or_default() })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Summary { pub day: String, pub journal: String, pub goals: i64, pub win: bool, pub learn: bool, pub open_todos: i64, pub sections: i64 }
/// The calendar's records for a range of days. No page or journal text is read.
pub fn summaries(c: &Connection, from: &str, to: &str) -> Result<Vec<Summary>, String> {
    check_day(c, from)?; check_day(c, to)?;
    let mut s = c.prepare("SELECT day,journal,goals,win,learn,open_todos,sections FROM daily_summaries WHERE day BETWEEN ?1 AND ?2 ORDER BY day").map_err(e)?;
    let rows = s.query_map([from, to], |r| Ok(Summary { day: r.get(0)?, journal: r.get(1)?, goals: r.get(2)?, win: r.get(3)?, learn: r.get(4)?, open_todos: r.get(5)?, sections: r.get(6)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}

/// Save the owner's journal for a day (creating the page if it is not there yet).
pub fn journal_save(c: &mut Connection, day: &str, journal: &Journal) -> Result<(), String> {
    check_day(c, day)?;
    let journal = clean_journal(journal)?;
    let body = serde_json::to_string(&journal).map_err(|x| x.to_string())?;
    let tx = c.transaction().map_err(e)?;
    ensure_day(&tx, day)?;
    tx.execute("INSERT INTO daily_journals(day,body) VALUES(?1,?2) ON CONFLICT(day) DO UPDATE SET body=excluded.body,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", params![day, body]).map_err(e)?;
    refresh_summary(&tx, day)?;
    tx.commit().map_err(e)
}

/// Tick or untick one to-do.
pub fn todo_set(c: &mut Connection, id: &str, done: bool) -> Result<(), String> {
    let tx = c.transaction().map_err(e)?;
    let day: String = tx.query_row("SELECT day FROM daily_entries WHERE id=?1 AND section='todo_list' AND deleted_at IS NULL", [id], |r| r.get(0)).optional().map_err(e)?.ok_or("That to-do is no longer there")?;
    tx.execute("UPDATE daily_entries SET done=?2 WHERE id=?1", params![id, done]).map_err(e)?;
    refresh_summary(&tx, &day)?;
    tx.commit().map_err(e)
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct ImportEntry { pub section: String, #[serde(default)] pub time: String, #[serde(default)] pub source: String, #[serde(default)] pub topic: String, pub text: String, #[serde(default)] pub link: String, #[serde(default)] pub done: bool }
#[derive(Deserialize, Debug, Clone, Default)]
pub struct ImportDay { pub day: String, #[serde(default)] pub notion_page_id: Option<String>, #[serde(default)] pub entries: Vec<ImportEntry>, #[serde(default)] pub journal: Journal }
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Imported { pub days: usize, pub entries_added: usize, pub entries_skipped: usize, pub journals_added: usize, pub journals_kept: usize }

/// What makes two entries the same: the section and the words, not the time or who wrote them.
pub fn entry_hash(section: &str, text: &str) -> String {
    let words = text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    format!("{:x}", Sha256::digest(format!("{section}\n{words}").as_bytes()))
}
fn short(s: &str, n: usize) -> String { s.trim().chars().take(n).collect() }

/// Bring in days from a history file. Everything or nothing.
pub fn import(c: &mut Connection, days: &[ImportDay]) -> Result<Imported, String> {
    if days.len() > MAX_IMPORT_DAYS { return Err("That file has too many days; split it".into()); }
    let known = sections();
    let tx = c.transaction().map_err(e)?;
    let mut out = Imported::default();
    for d in days {
        check_day(&tx, &d.day)?;
        ensure_day(&tx, &d.day)?;
        out.days += 1;
        if let Some(id) = d.notion_page_id.as_deref().map(|s| short(s, 64)).filter(|s| !s.is_empty()) {
            tx.execute("UPDATE daily_days SET notion_page_id=?2 WHERE day=?1 AND notion_page_id IS NULL", params![d.day, id]).map_err(e)?;
        }
        for entry in &d.entries {
            if !known.contains(&entry.section) { return Err(format!("Unknown section: {}", short(&entry.section, 40))); }
            let text = short(&entry.text, MAX_ENTRY);
            if text.is_empty() { continue; }
            let hash = entry_hash(&entry.section, &text);
            // A removed entry counts too: importing again does not bring it back.
            let there: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM daily_entries WHERE day=?1 AND section=?2 AND hash=?3)", params![d.day, entry.section, hash], |r| r.get(0)).map_err(e)?;
            if there { out.entries_skipped += 1; continue; }
            let position: i64 = tx.query_row("SELECT COALESCE(MAX(position),-1)+1 FROM daily_entries WHERE day=?1 AND section=?2", params![d.day, entry.section], |r| r.get(0)).map_err(e)?;
            let time = Some(short(&entry.time, 5)).filter(|t| t.len() == 5 && t.as_bytes()[2] == b':').unwrap_or_default();
            tx.execute("INSERT INTO daily_entries(id,day,section,position,time,source,topic,text,link,done,hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![Uuid::new_v4().to_string(), d.day, entry.section, position, time, short(&entry.source, 60), short(&entry.topic, 60), text, short(&entry.link, 2000), entry.done, hash]).map_err(e)?;
            out.entries_added += 1;
        }
        let incoming = clean_journal(&d.journal)?;
        if BLOCKS.iter().any(|b| written(&incoming, b) > 0) {
            let current = read_journal(&tx, &d.day)?.unwrap_or_default();
            if BLOCKS.iter().any(|b| written(&current, b) > 0) {
                out.journals_kept += 1;
            } else {
                let body = serde_json::to_string(&incoming).map_err(|x| x.to_string())?;
                tx.execute("INSERT INTO daily_journals(day,body) VALUES(?1,?2) ON CONFLICT(day) DO UPDATE SET body=excluded.body", params![d.day, body]).map_err(e)?;
                out.journals_added += 1;
            }
        }
        refresh_summary(&tx, &d.day)?;
    }
    tx.commit().map_err(e)?;
    Ok(out)
}

macro_rules! locked { ($db:expr) => { $db.0.lock().map_err(|_| "Database lock poisoned")? }; }
#[tauri::command]
pub fn daily_get_cmd(db: State<'_, Db>, day: String) -> Result<Day, String> { let c = locked!(db); get(&c, &day) }
#[tauri::command]
pub fn daily_summaries_cmd(db: State<'_, Db>, from: String, to: String) -> Result<Vec<Summary>, String> { let c = locked!(db); summaries(&c, &from, &to) }
#[tauri::command]
pub fn daily_journal_save_cmd(db: State<'_, Db>, day: String, journal: Journal) -> Result<(), String> { let mut c = locked!(db); db.writable()?; journal_save(&mut c, &day, &journal) }
#[tauri::command]
pub fn daily_todo_set_cmd(db: State<'_, Db>, id: String, done: bool) -> Result<(), String> { let mut c = locked!(db); db.writable()?; todo_set(&mut c, &id, done) }
#[tauri::command]
pub fn daily_import_cmd(db: State<'_, Db>, days: Vec<ImportDay>) -> Result<Imported, String> { let mut c = locked!(db); db.writable()?; import(&mut c, &days) }

#[cfg(test)]
mod tests {
    use super::*;
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/021_daily.sql")).unwrap();
        c
    }
    fn journal(pairs: &[(&str, &[&str])]) -> Journal { pairs.iter().map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect())).collect() }
    fn entry(section: &str, text: &str) -> ImportEntry { ImportEntry { section: section.into(), text: text.into(), ..Default::default() } }
    fn count(c: &Connection, sql: &str) -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() }

    #[test]
    fn a_day_is_made_once_and_reading_never_makes_it() {
        let mut c = fresh();
        assert!(!get(&c, "2026-11-27").unwrap().exists);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM daily_days"), 0);
        for _ in 0..2 { journal_save(&mut c, "2026-11-27", &journal(&[("notes", &["x"])])).unwrap(); }
        assert_eq!(count(&c, "SELECT COUNT(*) FROM daily_days"), 1);
        assert!(get(&c, "2026-13-01").is_err());
        assert!(journal_save(&mut c, "2026-11-27", &journal(&[("secret", &["x"])])).is_err());
    }

    #[test]
    fn the_summary_follows_the_journal_and_the_todos() {
        let mut c = fresh();
        journal_save(&mut c, "2026-11-27", &journal(&[("goals", &["a", " ", "b"])])).unwrap();
        let s = &summaries(&c, "2026-11-01", "2026-11-30").unwrap()[0];
        assert_eq!((s.journal.as_str(), s.goals, s.win, s.open_todos), ("part", 2, false, 0));
        journal_save(&mut c, "2026-11-27", &journal(&[("goals", &["a", "b", "c"]), ("win", &["w"]), ("learn", &["l"])])).unwrap();
        import(&mut c, &[ImportDay { day: "2026-11-27".into(), entries: vec![entry("todo_list", "Pay bill"), entry("todo_list", "Post parcel"), entry("daily_updates", "Done")], ..Default::default() }]).unwrap();
        let s = &summaries(&c, "2026-11-27", "2026-11-27").unwrap()[0];
        assert_eq!((s.journal.as_str(), s.open_todos, s.sections), ("full", 2, 2));
        let id = get(&c, "2026-11-27").unwrap().entries.into_iter().find(|x| x.text == "Pay bill").unwrap().id;
        todo_set(&mut c, &id, true).unwrap();
        assert_eq!(summaries(&c, "2026-11-27", "2026-11-27").unwrap()[0].open_todos, 1);
        journal_save(&mut c, "2026-11-27", &journal(&[("goals", &[""])])).unwrap();
        assert_eq!(summaries(&c, "2026-11-27", "2026-11-27").unwrap()[0].journal, "none");
    }

    #[test]
    fn importing_again_adds_nothing_and_never_replaces_a_written_journal() {
        let mut c = fresh();
        let day = ImportDay { day: "2026-11-02".into(), notion_page_id: Some("abc".into()), entries: vec![entry("todo_list", "[Bills] Check"), entry("daily_updates", "First"), entry("daily_updates", "Second")], journal: journal(&[("notes", &["from file"])]) };
        assert_eq!(import(&mut c, &[day.clone()]).unwrap(), Imported { days: 1, entries_added: 3, entries_skipped: 0, journals_added: 1, journals_kept: 0 });
        let order: Vec<String> = get(&c, "2026-11-02").unwrap().entries.into_iter().filter(|x| x.section == "daily_updates").map(|x| x.text).collect();
        assert_eq!(order, ["First", "Second"], "the file's order is kept");
        journal_save(&mut c, "2026-11-02", &journal(&[("notes", &["mine"])])).unwrap();
        let again = import(&mut c, &[ImportDay { entries: vec![entry("daily_updates", "  first ")], ..day.clone() }]).unwrap();
        assert_eq!((again.entries_added, again.entries_skipped, again.journals_kept), (0, 1, 1));
        let got = get(&c, "2026-11-02").unwrap();
        assert_eq!(got.journal["notes"], ["mine"]);
        assert_eq!(got.notion_page_id.as_deref(), Some("abc"));
    }

    #[test]
    fn an_import_with_a_bad_row_changes_nothing() {
        let mut c = fresh();
        let bad = ImportDay { day: "2026-11-03".into(), entries: vec![entry("daily_updates", "ok"), entry("journal", "sneaky")], ..Default::default() };
        assert!(import(&mut c, &[bad]).is_err());
        assert_eq!(count(&c, "SELECT COUNT(*) FROM daily_days"), 0);
        assert!(sections().contains(&"todo_list".to_string()) && !sections().contains(&"journal".to_string()));
    }
}
