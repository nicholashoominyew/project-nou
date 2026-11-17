//! Search inside notes with a short excerpt around each match, for the sidebar search ("lines"). Reads only the search index, so locked notes
//! (whose text is not indexed) never appear and nothing is decrypted.
use crate::Db;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

/// Marks the matched words in an excerpt. Control characters, so they cannot be confused with anything a note contains.
pub const HIT_START: char = '\u{1}';
pub const HIT_END: char = '\u{2}';

#[derive(Serialize, Debug, PartialEq)]
pub struct LineHit { id: String, title: String, snippet: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }

/// Pages whose text contains the words, each with a short excerpt (about 12 words) where the match is marked. Trashed pages, databases and
/// database rows are left out. The query is quoted so user punctuation cannot change the search grammar.
pub fn lines(c: &Connection, query: &str, limit: u32) -> Result<Vec<LineHit>, String> {
    let q = query.trim();
    if q.is_empty() { return Ok(Vec::new()); }
    if q.chars().count() > 200 { return Err("Search query is too long".into()); }
    let exact = format!("\"{}\"", q.replace('"', "\"\""));
    let mut s = c.prepare(&format!(
        "SELECT p.id,p.title,snippet(page_search,2,char(1),char(2),'…',12) FROM page_search s JOIN pages p ON p.id=s.page_id
         WHERE page_search MATCH ?1 AND p.workspace_id='personal' AND p.deleted_at IS NULL
           AND p.id NOT IN (SELECT page_id FROM db_rows) AND p.id NOT IN (SELECT page_id FROM databases)
           AND length(s.body)>0
         ORDER BY bm25(page_search),p.title COLLATE NOCASE LIMIT ?2")).map_err(e)?;
    let it = s.query_map(rusqlite::params![exact, limit.clamp(1, 50)], |r| Ok(LineHit { id: r.get(0)?, title: r.get(1)?, snippet: r.get(2)? })).map_err(e)?;
    // A title-only match has an empty excerpt (the body did not match); the page list already covers titles.
    Ok(it.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?.into_iter().filter(|h| h.snippet.contains(HIT_START)).collect())
}

#[tauri::command]
pub fn search_lines(db: State<'_, Db>, query: String) -> Result<Vec<LineHit>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    lines(&c, &query, 20)
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
    fn page(c: &Connection, id: &str, title: &str, body: &str) {
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES(?1,'personal',?2,?1)", rusqlite::params![id, title]).unwrap();
        c.execute("INSERT INTO page_search(page_id,title,body) VALUES(?1,?2,?3)", rusqlite::params![id, title, body]).unwrap();
    }
    #[test]
    fn finds_the_line_with_the_match_marked_and_ignores_title_only_matches() {
        let c = fresh();
        page(&c, "a", "Trip plan", "Book the train to Kyoto before the cherry blossom week starts");
        page(&c, "b", "Zebra facts", "nothing relevant in here");
        let got = lines(&c, "kyoto", 10).unwrap();
        assert_eq!(got.len(), 1); assert_eq!(got[0].id, "a");
        assert!(got[0].snippet.contains(&format!("{HIT_START}Kyoto{HIT_END}")), "{}", got[0].snippet);
        assert!(lines(&c, "zebra", 10).unwrap().is_empty(), "a match in the title alone is not a line");
    }
    #[test]
    fn leaves_out_trash_databases_rows_and_empty_bodies_and_handles_odd_input() {
        let c = fresh();
        page(&c, "t", "Trashed", "kyoto trip"); page(&c, "d", "DB", "kyoto database"); page(&c, "r", "Row", "kyoto row"); page(&c, "e", "Empty", "");
        c.execute("UPDATE pages SET deleted_at='x' WHERE id='t'", []).unwrap();
        c.execute("INSERT INTO databases(page_id) VALUES('d')", []).unwrap();
        c.execute("INSERT INTO db_rows(page_id,database_id) VALUES('r','d')", []).unwrap();
        assert!(lines(&c, "kyoto", 10).unwrap().is_empty());
        for odd in ["\"", "OR AND", "a*", "(", "'; DROP TABLE pages;--"] { assert!(lines(&c, odd, 10).is_ok(), "{odd}"); }
        assert!(lines(&c, "", 10).unwrap().is_empty());
        assert!(lines(&c, &"x".repeat(201), 10).is_err());
    }
    #[test]
    fn a_locked_note_is_never_returned() {
        let c = fresh();
        page(&c, "l", "Secret", "");
        c.execute("INSERT INTO page_locks(page_id,salt,kdf_m,kdf_t,kdf_p,check_blob) VALUES('l',zeroblob(16),8192,1,1,zeroblob(30))", []).unwrap();
        assert!(lines(&c, "secret", 10).unwrap().is_empty());
    }
    #[test]
    fn limits_the_number_of_results() {
        let c = fresh();
        for i in 0..30 { page(&c, &format!("p{i:02}"), &format!("Page {i}"), "the shared word appears here"); }
        assert_eq!(lines(&c, "shared", 5).unwrap().len(), 5);
        assert_eq!(lines(&c, "shared", 500).unwrap().len(), 30.min(50));
    }
}
