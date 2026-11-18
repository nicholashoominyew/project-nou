//! Databases made before 11 Nov 2026 were created with the first version of migration 004, whose `db_properties` table only allowed the property
//! types up to "relation". Migration 004 was then edited in place to allow more (email, phone, created time, last edited time, rollup), so those
//! older databases no longer match the shipped schema, and the strict schema check (used before every upgrade and backup) refuses them.
//!
//! This rebuilds only that one table with the shipped definition and keeps every row. A full copy of the database is written first. It does nothing
//! to a database that already matches, or whose table differs in any way other than the list of allowed types.
use rusqlite::Connection;
use std::path::Path;

const SHIPPED: [&str; 4] = [
    include_str!("../../../../db/notes/001_initial.sql"),
    include_str!("../../../../db/notes/002_editor_formats.sql"),
    include_str!("../../../../db/notes/003_page_icons.sql"),
    include_str!("../../../../db/notes/004_databases.sql"),
];
pub const BACKUP_NAME: &str = "notes-before-property-repair.sqlite3";

fn squash(sql: &str) -> String { sql.split_whitespace().collect::<Vec<_>>().join(" ") }
/// The table definition with the list of allowed types cut out, so two definitions can be compared apart from that list.
fn without_types(sql: &str) -> Option<String> {
    let s = squash(sql);
    let start = s.find("type IN (")?;
    let end = start + s[start..].find(')')?;
    Some(format!("{}{}", &s[..start], &s[end..]))
}

/// Returns true when the table was rebuilt.
pub fn run(conn: &Connection, folder: &Path) -> Result<bool, String> {
    let current: Option<String> = conn.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='db_properties'", [], |r| r.get(0)).ok();
    let Some(current) = current else { return Ok(false) };
    let shipped = Connection::open_in_memory().map_err(|e| e.to_string())?;
    for sql in SHIPPED { shipped.execute_batch(sql).map_err(|e| e.to_string())?; }
    let table_sql: String = shipped.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='db_properties'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if squash(&current) == squash(&table_sql) { return Ok(false); }
    // Only the old list of types may differ. Anything else is not ours to touch.
    match (without_types(&current), without_types(&table_sql)) { (Some(a), Some(b)) if a == b => {}, _ => return Ok(false) }
    let indexes: Vec<String> = {
        let mut s = shipped.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='db_properties' AND sql IS NOT NULL ORDER BY name").map_err(|e| e.to_string())?;
        let rows = s.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };

    // A whole copy first, kept next to the database. VACUUM INTO refuses to overwrite, so an existing copy is left alone.
    let copy = folder.join(BACKUP_NAME);
    if !copy.exists() { conn.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()]).map_err(|e| format!("Could not copy the database before repairing it: {e}"))?; }

    // The rebuild: the other tables point at db_properties by name, so those references must not be rewritten (legacy_alter_table) and nothing may cascade (foreign_keys off).
    conn.pragma_update(None, "foreign_keys", "OFF").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "legacy_alter_table", "ON").map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
        let steps = (|| -> Result<(), String> {
            conn.execute_batch("ALTER TABLE db_properties RENAME TO db_properties_old").map_err(|e| e.to_string())?;
            conn.execute_batch(&table_sql).map_err(|e| e.to_string())?;
            conn.execute_batch("INSERT INTO db_properties SELECT * FROM db_properties_old").map_err(|e| e.to_string())?;
            conn.execute_batch("DROP TABLE db_properties_old").map_err(|e| e.to_string())?;
            for sql in &indexes { conn.execute_batch(sql).map_err(|e| e.to_string())?; }
            if conn.prepare("PRAGMA foreign_key_check").map_err(|e| e.to_string())?.exists([]).map_err(|e| e.to_string())? { return Err("Repair would leave broken references".into()); }
            Ok(())
        })();
        match steps {
            Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
            Err(e) => { let _ = conn.execute_batch("ROLLBACK"); Err(e) }
        }
    })();
    let _ = conn.pragma_update(None, "legacy_alter_table", "OFF");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    result.map(|_| true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn legacy_db(dir: &Path) -> Connection {
        let c = Connection::open(dir.join("notes.sqlite3")).unwrap();
        for (i, sql) in SHIPPED.iter().enumerate() {
            let sql = if i == 3 { sql.replace("'email','phone','created_time','last_edited_time','relation','rollup'", "'relation'") } else { sql.to_string() };
            c.execute_batch(&sql).unwrap();
        }
        c
    }
    fn temp() -> std::path::PathBuf { let d = std::env::temp_dir().join("nou-legacy-" .to_string() + &Uuid::new_v4().to_string()); std::fs::create_dir_all(&d).unwrap(); d }

    #[test]
    fn rebuilds_an_old_property_table_keeping_every_row_and_then_passes_the_schema_check() {
        let dir = temp();
        let c = legacy_db(&dir);
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).ok();
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('db','personal','Projects','a')", []).unwrap();
        c.execute("INSERT INTO databases(page_id) VALUES('db')", []).unwrap();
        c.execute("INSERT INTO db_properties(id,database_id,name,type,position) VALUES('p1','db','Name','text',0),('p2','db','Due','date',1)", []).unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        assert!(c.execute("INSERT INTO db_properties(id,database_id,name,type,position) VALUES('p3','db','Mail','email',2)", []).is_err(), "the old table refuses newer types");
        assert!(crate::recovery::validate_notes(&dir.join("notes.sqlite3")).is_err(), "and the strict check refuses it");

        assert_eq!(run(&c, &dir).unwrap(), true);
        assert!(dir.join(BACKUP_NAME).exists(), "a full copy was kept");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM db_properties", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        c.execute("INSERT INTO db_properties(id,database_id,name,type,position) VALUES('p3','db','Mail','email',2)", []).unwrap();
        let fk: String = c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0).map(|v| v.to_string())).unwrap();
        assert_eq!(fk, "1", "foreign keys are back on");
        drop(c);
        assert!(crate::recovery::validate_notes(&dir.join("notes.sqlite3")).is_ok(), "the schema now matches what ships");
        let c = Connection::open(dir.join("notes.sqlite3")).unwrap();
        assert_eq!(run(&c, &dir).unwrap(), false, "a second run does nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leaves_a_current_database_or_an_unexpected_table_alone() {
        let dir = temp();
        let c = Connection::open(dir.join("notes.sqlite3")).unwrap();
        for sql in SHIPPED { c.execute_batch(sql).unwrap(); }
        assert_eq!(run(&c, &dir).unwrap(), false);
        assert!(!dir.join(BACKUP_NAME).exists(), "no copy is made when nothing is repaired");
        c.execute_batch("DROP TABLE db_properties; CREATE TABLE db_properties (id TEXT PRIMARY KEY, other TEXT)").ok();
        assert_eq!(run(&c, &dir).unwrap(), false, "a table that differs in other ways is not touched");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
