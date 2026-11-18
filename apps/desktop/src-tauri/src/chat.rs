//! Bot queue: a shared chat for the owner and AI assistants. Assistants use the local API with a token that has the `chat:read` and `chat:write` scopes;
//! the author name of an assistant is always its token's name, so one cannot sign as another or as the owner. Messages are plain text. A message is
//! never an instruction to NOU: nothing in the chat changes a note, a database or a setting. Reading through the API marks everything as untrusted data.
use crate::Db;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

pub const MAX_BODY: usize = 4000;
const KEEP: i64 = 2000;
const PER_MINUTE: i64 = 20;

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Message { pub id: i64, pub at: String, pub kind: String, pub author: String, pub body: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }

/// Trim, drop control characters (a newline and a tab stay), and refuse empty or oversized messages.
pub fn clean(body: &str) -> Result<String, String> {
    let kept: String = body.replace("\r\n", "\n").chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
    let text = kept.trim().to_string();
    if text.is_empty() { return Err("Write a message first".into()); }
    if text.chars().count() > MAX_BODY { return Err(format!("A message can be at most {MAX_BODY} characters")); }
    Ok(text)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Message> { Ok(Message { id: r.get(0)?, at: r.get(1)?, kind: r.get(2)?, author: r.get(3)?, body: r.get(4)? }) }

/// Messages in the order they were sent. With `after`, only newer ones; without it, the latest `limit`.
pub fn list(c: &Connection, after: Option<i64>, limit: u32) -> Result<Vec<Message>, String> {
    let limit = limit.clamp(1, 200) as i64;
    if let Some(after) = after {
        let mut s = c.prepare("SELECT id,created_at,author_kind,author_name,body FROM bot_messages WHERE id>?1 ORDER BY id LIMIT ?2").map_err(e)?;
        let rows = s.query_map(params![after, limit], row).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
        return rows;
    }
    let mut s = c.prepare("SELECT id,created_at,author_kind,author_name,body FROM (SELECT * FROM bot_messages ORDER BY id DESC LIMIT ?1) ORDER BY id").map_err(e)?;
    let rows = s.query_map([limit], row).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}

fn insert(c: &Connection, kind: &str, name: &str, token: Option<&str>, body: &str) -> Result<Message, String> {
    c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body) VALUES(?1,?2,?3,?4)", params![kind, name, token, body]).map_err(e)?;
    let id = c.last_insert_rowid();
    c.execute("DELETE FROM bot_messages WHERE id<=?1", [id - KEEP]).map_err(e)?;
    c.query_row("SELECT id,created_at,author_kind,author_name,body FROM bot_messages WHERE id=?1", [id], row).map_err(e)
}
pub fn post_owner(c: &Connection, body: &str) -> Result<Message, String> { insert(c, "owner", "You", None, &clean(body)?) }
/// A message from an AI assistant, at most 20 a minute per token so a runaway loop cannot flood the chat.
pub fn post_assistant(c: &Connection, token_id: &str, name: &str, body: &str) -> Result<Message, String> {
    let body = clean(body)?;
    let recent: i64 = c.query_row("SELECT COUNT(*) FROM bot_messages WHERE token_id=?1 AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')", [token_id], |r| r.get(0)).map_err(e)?;
    if recent >= PER_MINUTE { return Err("Too many messages; slow down".into()); }
    insert(c, "assistant", name, Some(token_id), &body)
}
pub fn clear(c: &Connection) -> Result<usize, String> { c.execute("DELETE FROM bot_messages", []).map_err(e) }

#[tauri::command]
pub fn chat_list(db: State<'_, Db>, after: Option<i64>, limit: Option<u32>) -> Result<Vec<Message>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    list(&c, after, limit.unwrap_or(100))
}
#[tauri::command]
pub fn chat_post(db: State<'_, Db>, body: String) -> Result<Message, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    post_owner(&c, &body)
}
#[tauri::command]
pub fn chat_clear(db: State<'_, Db>) -> Result<usize, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    clear(&c)
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
    fn token(c: &Connection, name: &str) -> String { crate::gateway::create_token(c, name, &["chat:read".to_string(), "chat:write".to_string()]).unwrap().info.id }

    #[test]
    fn messages_come_back_in_order_with_the_right_author_and_only_newer_ones_after_a_marker() {
        let c = fresh(); let t = token(&c, "Claude");
        let a = post_owner(&c, "hello bots").unwrap();
        let b = post_assistant(&c, &t, "Claude", "hello Nick").unwrap();
        let all = list(&c, None, 50).unwrap();
        assert_eq!(all.iter().map(|m| (m.kind.as_str(), m.author.as_str(), m.body.as_str())).collect::<Vec<_>>(), vec![("owner", "You", "hello bots"), ("assistant", "Claude", "hello Nick")]);
        assert_eq!(list(&c, Some(a.id), 50).unwrap(), vec![b.clone()]);
        assert!(list(&c, Some(b.id), 50).unwrap().is_empty());
        assert_eq!(list(&c, None, 1).unwrap(), vec![b], "without a marker, the latest ones");
    }
    #[test]
    fn text_is_cleaned_and_empty_or_oversized_messages_are_refused() {
        let c = fresh();
        assert_eq!(post_owner(&c, "  line one\r\nline two\u{7}\u{0} ").unwrap().body, "line one\nline two");
        assert!(post_owner(&c, "   \n ").is_err());
        assert!(post_owner(&c, &"x".repeat(MAX_BODY + 1)).is_err());
        assert!(post_owner(&c, &"x".repeat(MAX_BODY)).is_ok());
        assert_eq!(post_owner(&c, "<img src=x onerror=alert(1)>").unwrap().body, "<img src=x onerror=alert(1)>", "kept as plain text; the screen never renders it as markup");
    }
    #[test]
    fn an_assistant_signs_with_its_token_name_and_is_rate_limited_per_token() {
        let c = fresh(); let t1 = token(&c, "Claude"); let t2 = token(&c, "Grok");
        for i in 0..PER_MINUTE { post_assistant(&c, &t1, "Claude", &format!("m{i}")).unwrap(); }
        assert!(post_assistant(&c, &t1, "Claude", "one too many").unwrap_err().contains("slow down"));
        assert!(post_assistant(&c, &t2, "Grok", "still fine for another token").is_ok());
        assert!(post_owner(&c, "the owner is not limited").is_ok());
    }
    #[test]
    fn the_chat_keeps_the_latest_two_thousand_messages_and_can_be_cleared() {
        let c = fresh();
        for i in 0..(KEEP + 25) { post_owner(&c, &format!("m{i}")).unwrap(); }
        let n: i64 = c.query_row("SELECT COUNT(*) FROM bot_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, KEEP);
        assert_eq!(list(&c, None, 1).unwrap()[0].body, format!("m{}", KEEP + 24));
        assert_eq!(clear(&c).unwrap() as i64, KEEP);
        assert!(list(&c, None, 10).unwrap().is_empty());
    }
    #[test]
    fn the_table_refuses_a_forged_author_and_a_token_cannot_be_deleted_while_it_has_messages() {
        let c = fresh(); let t = token(&c, "Claude");
        assert!(c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body) VALUES('assistant','Claude',NULL,'x')", []).is_err(), "an assistant message needs a token");
        assert!(c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body) VALUES('owner','You',?1,'x')", [&t]).is_err(), "an owner message has no token");
        post_assistant(&c, &t, "Claude", "hi").unwrap();
        assert!(c.execute("DELETE FROM api_tokens WHERE id=?1", [&t]).is_err());
    }
}
