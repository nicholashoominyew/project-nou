//! Data for the home page widgets that need more than the page list the app already holds.
use crate::Db;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, PartialEq)]
pub struct Recent { id: String, title: String, updated_at: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }

/// Most recently edited pages, newest first. Trashed pages and hidden database rows/databases are left out.
pub fn recent_pages(c: &Connection, limit: u32) -> Result<Vec<Recent>, String> {
    let mut s = c.prepare(
        "SELECT id,title,updated_at FROM pages
         WHERE workspace_id='personal' AND deleted_at IS NULL
           AND id NOT IN (SELECT page_id FROM db_rows) AND id NOT IN (SELECT page_id FROM databases)
         ORDER BY updated_at DESC,id LIMIT ?1").map_err(e)?;
    let it = s.query_map([limit.clamp(1, 50)], |r| Ok(Recent { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)? })).map_err(e)?;
    it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

/// A page the home screen suggests revisiting, and why.
#[derive(Serialize, Debug, PartialEq)]
pub struct Resurfaced { id: String, title: String, updated_at: String, created_at: String, reason: String, years_ago: Option<i64> }

const STALE_DAYS: i64 = 30;
/// Notes shorter than this (in characters of text) are not worth bringing back.
const MIN_BODY: i64 = 40;

/// Pages worth another look, for the local date `today` (`YYYY-MM-DD`, supplied by the caller so the answer is the same all day and testable).
/// Two kinds: "anniversary" (created on this month and day in an earlier year) and "stale" (not edited for 30+ days). Stale picks are chosen
/// by a stable pseudo-random order that changes each day, so the same note does not nag every day and each old note gets its turn.
/// Trashed pages, databases, database rows, locked notes and near-empty notes are never suggested.
pub fn resurface(c: &Connection, today: &str, stale_limit: u32, anniversary_limit: u32) -> Result<Vec<Resurfaced>, String> {
    use sha2::{Digest, Sha256};
    let valid = today.len() == 10 && today.as_bytes()[4] == b'-' && today.as_bytes()[7] == b'-' && today.bytes().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !valid { return Err("today must be a date like 2026-11-17".into()); }
    let eligible = "p.workspace_id='personal' AND p.deleted_at IS NULL AND p.id NOT IN (SELECT page_id FROM db_rows) AND p.id NOT IN (SELECT page_id FROM databases)
                    AND NOT EXISTS (SELECT 1 FROM page_locks l WHERE l.page_id=p.id)
                    AND length(COALESCE((SELECT body FROM page_search WHERE page_id=p.id),''))>=?2";
    let year: i64 = today[..4].parse().map_err(|_| "bad year")?;
    let mut out = Vec::new();

    let mut s = c.prepare(&format!(
        "SELECT p.id,p.title,p.updated_at,p.created_at,CAST(substr(p.created_at,1,4) AS INTEGER) FROM pages p
         WHERE {eligible} AND substr(p.created_at,6,5)=substr(?1,6,5) AND CAST(substr(p.created_at,1,4) AS INTEGER)<?3
         ORDER BY p.created_at,p.id LIMIT ?4")).map_err(e)?;
    let it = s.query_map(rusqlite::params![today, MIN_BODY, year, anniversary_limit.clamp(0, 20)], |r| Ok(Resurfaced { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)?, created_at: r.get(3)?, reason: "anniversary".into(), years_ago: Some(year - r.get::<_, i64>(4)?) })).map_err(e)?;
    for row in it { out.push(row.map_err(e)?); }

    let mut s = c.prepare(&format!(
        "SELECT p.id,p.title,p.updated_at,p.created_at FROM pages p
         WHERE {eligible} AND substr(p.updated_at,1,10)<date(?1,'-{STALE_DAYS} days')
         ORDER BY p.id LIMIT 2000")).map_err(e)?;
    let mut stale: Vec<Resurfaced> = s.query_map(rusqlite::params![today, MIN_BODY], |r| Ok(Resurfaced { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)?, created_at: r.get(3)?, reason: "stale".into(), years_ago: None })).map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    let key = |id: &str| -> [u8; 8] { let d = Sha256::digest(format!("{today}|{id}").as_bytes()); let mut k = [0u8; 8]; k.copy_from_slice(&d[..8]); k };
    stale.sort_by_key(|p| key(&p.id));
    let taken: std::collections::HashSet<String> = out.iter().map(|p| p.id.clone()).collect();
    out.extend(stale.into_iter().filter(|p| !taken.contains(&p.id)).take(stale_limit.clamp(0, 20) as usize));
    Ok(out)
}

#[tauri::command]
pub fn list_resurfaced_pages(db: State<'_, Db>, today: String, stale_limit: Option<u32>, anniversary_limit: Option<u32>) -> Result<Vec<Resurfaced>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    resurface(&c, &today, stale_limit.unwrap_or(3), anniversary_limit.unwrap_or(3))
}

#[tauri::command]
pub fn list_recent_pages(db: State<'_, Db>, limit: Option<u32>) -> Result<Vec<Recent>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    recent_pages(&c, limit.unwrap_or(8))
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
    fn page(c: &Connection, id: &str, key: &str, updated: &str) {
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key,updated_at) VALUES(?1,'personal',?1,?2,?3)", rusqlite::params![id, key, updated]).unwrap();
    }
    #[test]
    fn recent_pages_are_newest_first_and_skip_trash_databases_and_rows() {
        let c = fresh();
        page(&c, "old", "1", "2026-11-01T00:00:00.000Z");
        page(&c, "new", "2", "2026-11-10T00:00:00.000Z");
        page(&c, "mid", "3", "2026-11-05T00:00:00.000Z");
        page(&c, "gone", "4", "2026-11-11T00:00:00.000Z");
        page(&c, "db", "5", "2026-11-11T01:00:00.000Z");
        page(&c, "row", "6", "2026-11-11T02:00:00.000Z");
        c.execute("UPDATE pages SET deleted_at='t' WHERE id='gone'", []).unwrap();
        c.execute("INSERT INTO databases(page_id) VALUES('db')", []).unwrap();
        c.execute("INSERT INTO db_rows(page_id,database_id) VALUES('row','db')", []).unwrap();
        let ids: Vec<String> = recent_pages(&c, 10).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["new", "mid", "old"]);
        assert_eq!(recent_pages(&c, 2).unwrap().len(), 2);
        assert_eq!(recent_pages(&c, 0).unwrap().len(), 1, "the limit is clamped to at least one");
        assert_eq!(recent_pages(&c, 9999).unwrap().len(), 3, "and to at most fifty");
    }

    fn rich(c: &Connection, id: &str, key: &str, created: &str, updated: &str, body: &str) {
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key,created_at,updated_at) VALUES(?1,'personal',?1,?2,?3,?4)", rusqlite::params![id, key, created, updated]).unwrap();
        c.execute("INSERT INTO page_search(page_id,title,body) VALUES(?1,?1,?2)", rusqlite::params![id, body]).unwrap();
    }
    const TEXT: &str = "A note with enough text in it to be worth looking at again someday.";
    #[test]
    fn old_notes_are_suggested_but_recent_short_trashed_locked_and_database_pages_are_not() {
        let c = fresh();
        rich(&c, "old", "1", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", TEXT);
        rich(&c, "recent", "2", "2026-01-01T00:00:00.000Z", "2026-11-10T00:00:00.000Z", TEXT);
        rich(&c, "short", "3", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "tiny");
        rich(&c, "trashed", "4", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", TEXT);
        rich(&c, "locked", "5", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", TEXT);
        rich(&c, "db", "6", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", TEXT);
        rich(&c, "row", "7", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", TEXT);
        c.execute("UPDATE pages SET deleted_at='x' WHERE id='trashed'", []).unwrap();
        c.execute("INSERT INTO page_locks(page_id,salt,kdf_m,kdf_t,kdf_p,check_blob) VALUES('locked',zeroblob(16),8192,1,1,zeroblob(30))", []).unwrap();
        c.execute("INSERT INTO databases(page_id) VALUES('db')", []).unwrap();
        c.execute("INSERT INTO db_rows(page_id,database_id) VALUES('row','db')", []).unwrap();
        let got = resurface(&c, "2026-11-17", 10, 10).unwrap();
        assert_eq!(got.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["old"]);
        assert_eq!(got[0].reason, "stale");
    }
    #[test]
    fn the_thirty_day_line_is_exact() {
        let c = fresh();
        rich(&c, "edge", "1", "2026-01-01T00:00:00.000Z", "2026-10-18T23:00:00.000Z", TEXT);   // 30 days before 17 Nov: not older than the line
        rich(&c, "past", "2", "2026-01-01T00:00:00.000Z", "2026-10-17T23:00:00.000Z", TEXT);   // 31 days: stale
        let got = resurface(&c, "2026-11-17", 10, 0).unwrap();
        assert_eq!(got.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["past"]);
    }
    #[test]
    fn anniversaries_match_month_and_day_in_an_earlier_year_and_come_first() {
        let c = fresh();
        rich(&c, "a1", "1", "2025-11-17T09:00:00.000Z", "2026-11-01T00:00:00.000Z", TEXT);
        rich(&c, "a2", "2", "2023-11-17T09:00:00.000Z", "2026-11-01T00:00:00.000Z", TEXT);
        rich(&c, "thisyear", "3", "2026-11-17T09:00:00.000Z", "2026-11-17T09:00:00.000Z", TEXT);
        rich(&c, "other", "4", "2025-11-18T09:00:00.000Z", "2026-11-01T00:00:00.000Z", TEXT);
        rich(&c, "stale", "5", "2025-03-03T09:00:00.000Z", "2026-01-01T00:00:00.000Z", TEXT);
        let got = resurface(&c, "2026-11-17", 5, 5).unwrap();
        assert_eq!(got.iter().map(|p| (p.id.as_str(), p.reason.as_str(), p.years_ago)).collect::<Vec<_>>(),
            vec![("a2", "anniversary", Some(3)), ("a1", "anniversary", Some(1)), ("stale", "stale", None)]);
    }
    #[test]
    fn the_stale_pick_is_stable_within_a_day_changes_across_days_and_respects_the_limit() {
        let c = fresh();
        for i in 0..30 { rich(&c, &format!("p{i:02}"), &format!("{i:02}"), "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z", TEXT); }
        let a = resurface(&c, "2026-11-17", 3, 0).unwrap();
        assert_eq!(a.len(), 3);
        assert_eq!(a, resurface(&c, "2026-11-17", 3, 0).unwrap(), "the same all day");
        let ids = |d: &str| resurface(&c, d, 3, 0).unwrap().into_iter().map(|p| p.id).collect::<Vec<_>>();
        let days: std::collections::HashSet<Vec<String>> = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"].iter().map(|d| ids(d)).collect();
        assert!(days.len() > 1, "different days show different notes");
        assert_eq!(resurface(&c, "2026-11-17", 0, 0).unwrap().len(), 0);
    }
    #[test]
    fn an_anniversary_page_is_not_repeated_as_stale_and_bad_dates_are_refused() {
        let c = fresh();
        rich(&c, "both", "1", "2024-11-17T00:00:00.000Z", "2025-01-01T00:00:00.000Z", TEXT);
        let got = resurface(&c, "2026-11-17", 5, 5).unwrap();
        assert_eq!(got.len(), 1); assert_eq!(got[0].reason, "anniversary");
        for bad in ["", "2026-1-7", "2026/11/17", "17-11-2026", "2026-11-1x", "2026-11-17 "] { assert!(resurface(&c, bad, 1, 1).is_err(), "{bad}"); }
    }
}
