//! Bots Hub collaboration room: a shared chat for the owner and AI assistants, in rooms. Assistants use the local API with a token that has the `chat:read` and
//! `chat:write` scopes; the author name of an assistant is always its token's name, so one cannot sign as another or as the owner. Messages are plain text.
//! A message is never an instruction to NOU: nothing in the chat changes a note, a database or a setting. Reading through the API marks everything as untrusted data.
//! Besides normal messages there are hand-off lines and approval cards. An approval card is a question to the owner; only the owner can decide it (an app
//! command, never an API call) and deciding it closes its queue item.
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use tauri::State;

pub const MAX_BODY: usize = 4000;
const KEEP: i64 = 2000;
const PER_MINUTE: i64 = 20;
const MAX_ROOMS: i64 = 12;

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Message {
    pub id: i64, pub at: String, pub kind: String, pub author: String, pub body: String,
    pub room: String,
    #[serde(rename = "type")] pub ty: String,
    pub role: Option<String>, pub from: Option<String>, pub to: Option<String>, pub task_ref: Option<String>,
    pub approval: Option<String>, pub queue_item_id: Option<i64>, pub decided_at: Option<String>,
}
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Room { pub id: i64, pub name: String, pub slug: String }

fn e(error: rusqlite::Error) -> String { error.to_string() }
const COLS: &str = "m.id,m.created_at,m.author_kind,m.author_name,m.body,r.slug,m.type,m.role,m.handoff_from,m.handoff_to,m.task_ref,m.approval_status,m.queue_item_id,m.decided_at";
const FROM: &str = "FROM bot_messages m JOIN bot_rooms r ON r.id=m.room_id";

/// Trim, drop control characters (a newline and a tab stay), and refuse empty or oversized messages.
pub fn clean(body: &str) -> Result<String, String> {
    let kept: String = body.replace("\r\n", "\n").chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
    let text = kept.trim().to_string();
    if text.is_empty() { return Err("Write a message first".into()); }
    if text.chars().count() > MAX_BODY { return Err(format!("A message can be at most {MAX_BODY} characters")); }
    Ok(text)
}
/// A short single-line label (a role, a task reference, a name): control characters dropped, 1 to `max` characters.
fn short(text: &str, max: usize, what: &str) -> Result<String, String> {
    let t: String = text.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    if t.is_empty() || t.chars().count() > max { return Err(format!("{what} must be 1 to {max} characters")); }
    Ok(t)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message { id: r.get(0)?, at: r.get(1)?, kind: r.get(2)?, author: r.get(3)?, body: r.get(4)?, room: r.get(5)?, ty: r.get(6)?, role: r.get(7)?, from: r.get(8)?, to: r.get(9)?, task_ref: r.get(10)?, approval: r.get(11)?, queue_item_id: r.get(12)?, decided_at: r.get(13)? })
}

// ---- rooms ----
pub fn rooms(c: &Connection) -> Result<Vec<Room>, String> {
    let mut s = c.prepare("SELECT id,name,slug FROM bot_rooms ORDER BY sort_order,id").map_err(e)?;
    let rows = s.query_map([], |r| Ok(Room { id: r.get(0)?, name: r.get(1)?, slug: r.get(2)? })).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
pub fn room_id(c: &Connection, slug: Option<&str>) -> Result<i64, String> {
    let slug = slug.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("general");
    c.query_row("SELECT id FROM bot_rooms WHERE slug=?1", [slug.to_lowercase()], |r| r.get(0)).optional().map_err(e)?.ok_or_else(|| "Unknown room".to_string())
}
/// "NOU build" becomes `nou-build`.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_alphanumeric() { out.push(ch); } else if !out.ends_with('-') && !out.is_empty() { out.push('-'); }
    }
    out.trim_end_matches('-').chars().take(40).collect()
}
/// The owner adds a room. Bots cannot make rooms.
pub fn create_room(c: &Connection, name: &str) -> Result<Room, String> {
    let name = short(name, 40, "A room name")?; let slug = slugify(&name);
    if slug.is_empty() { return Err("A room name needs a letter or a number".into()); }
    let n: i64 = c.query_row("SELECT COUNT(*) FROM bot_rooms", [], |r| r.get(0)).map_err(e)?;
    if n >= MAX_ROOMS { return Err(format!("At most {MAX_ROOMS} rooms")); }
    let order: i64 = c.query_row("SELECT COALESCE(MAX(sort_order),0)+1 FROM bot_rooms", [], |r| r.get(0)).map_err(e)?;
    c.execute("INSERT INTO bot_rooms(name,slug,sort_order) VALUES(?1,?2,?3)", params![name, slug, order]).map_err(|x| if x.to_string().contains("UNIQUE") { "A room with that name already exists".to_string() } else { x.to_string() })?;
    Ok(Room { id: c.last_insert_rowid(), name, slug })
}

// ---- reading ----
/// Messages of one room (General by default) in the order they were sent. With `after`, only newer ones; without it, the latest `limit`.
pub fn list(c: &Connection, after: Option<i64>, limit: u32, room: Option<&str>) -> Result<Vec<Message>, String> {
    let limit = limit.clamp(1, 200) as i64; let rid = room_id(c, room)?;
    if let Some(after) = after {
        let mut s = c.prepare(&format!("SELECT {COLS} {FROM} WHERE m.room_id=?3 AND m.id>?1 ORDER BY m.id LIMIT ?2")).map_err(e)?;
        let rows = s.query_map(params![after, limit, rid], row).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
        return rows;
    }
    let mut s = c.prepare(&format!("SELECT {COLS} FROM (SELECT * FROM bot_messages WHERE room_id=?2 ORDER BY id DESC LIMIT ?1) m JOIN bot_rooms r ON r.id=m.room_id ORDER BY m.id")).map_err(e)?;
    let rows = s.query_map(params![limit, rid], row).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
/// True when `body` contains `@name` as a whole word (so @Claude does not match @ClaudeCode).
pub fn mentions(body: &str, name: &str) -> bool {
    let (b, n) = (body.to_lowercase(), format!("@{}", name.trim().to_lowercase()));
    let mut from = 0;
    while let Some(i) = b[from..].find(&n) {
        let end = from + i + n.len();
        if b[end..].chars().next().map_or(true, |c| !(c.is_alphanumeric() || c == '_')) { return true; }
        from = end;
    }
    false
}
/// Only the messages that @mention `name`: this is how a bot is handed work, because nothing is pushed to it.
pub fn list_mentioning(c: &Connection, after: Option<i64>, limit: u32, room: Option<&str>, name: &str) -> Result<Vec<Message>, String> {
    Ok(list(c, after, 200, room)?.into_iter().filter(|m| mentions(&m.body, name)).take(limit.clamp(1, 200) as usize).collect())
}
pub fn get(c: &Connection, id: i64) -> Result<Message, String> {
    c.query_row(&format!("SELECT {COLS} {FROM} WHERE m.id=?1"), [id], row).optional().map_err(e)?.ok_or_else(|| "Message not found".to_string())
}

// ---- writing ----
struct New<'a> { kind: &'a str, name: &'a str, token: Option<&'a str>, room_id: i64, ty: &'a str, role: Option<&'a str>, from: Option<&'a str>, to: Option<&'a str>, task_ref: Option<&'a str>, approval: Option<&'a str>, queue_item_id: Option<i64>, body: &'a str }
fn insert(c: &Connection, n: &New) -> Result<Message, String> {
    c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body,room_id,type,role,handoff_from,handoff_to,task_ref,approval_status,queue_item_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![n.kind, n.name, n.token, n.body, n.room_id, n.ty, n.role, n.from, n.to, n.task_ref, n.approval, n.queue_item_id]).map_err(e)?;
    let id = c.last_insert_rowid();
    c.execute("DELETE FROM bot_messages WHERE id<=?1", [id - KEEP]).map_err(e)?;
    get(c, id)
}
fn plain(kind: &str, name: &str, token: Option<&str>, room_id: i64, body: &str) -> Message_ { Message_ { kind: kind.into(), name: name.into(), token: token.map(Into::into), room_id, body: body.into() } }
struct Message_ { kind: String, name: String, token: Option<String>, room_id: i64, body: String }
fn insert_plain(c: &Connection, m: Message_, role: Option<&str>) -> Result<Message, String> {
    insert(c, &New { kind: &m.kind, name: &m.name, token: m.token.as_deref(), room_id: m.room_id, ty: "message", role, from: None, to: None, task_ref: None, approval: None, queue_item_id: None, body: &m.body })
}
/// The owner writes in a room (General by default).
pub fn post_owner(c: &Connection, body: &str, room: Option<&str>) -> Result<Message, String> {
    let rid = room_id(c, room)?;
    insert_plain(c, plain("owner", "You", None, rid, &clean(body)?), Some("YOU"))
}
fn limited(c: &Connection, token_id: &str) -> Result<(), String> {
    let recent: i64 = c.query_row("SELECT COUNT(*) FROM bot_messages WHERE token_id=?1 AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')", [token_id], |r| r.get(0)).map_err(e)?;
    if recent >= PER_MINUTE { Err("Too many messages; slow down".into()) } else { Ok(()) }
}
/// A message from an AI assistant in General, at most 20 a minute per token so a runaway loop cannot flood the chat.
pub fn post_assistant(c: &Connection, token_id: &str, name: &str, body: &str) -> Result<Message, String> {
    post_to_room(c, token_id, name, None, "message", None, None, None, body)
}
/// A message, hand-off line or (through `post_approval`) approval card from an assistant. The author is always the token's name.
/// `role` is a short label such as ROUTER or EXECUTOR; for a hand-off `to` names the bot taking over and `task_ref` what was handed over.
pub fn post_to_room(c: &Connection, token_id: &str, name: &str, room: Option<&str>, ty: &str, role: Option<&str>, to: Option<&str>, task_ref: Option<&str>, body: &str) -> Result<Message, String> {
    let rid = room_id(c, room)?;
    let role = match role { Some(r) => Some(short(r, 20, "A role")?.to_uppercase()), None => None };
    limited(c, token_id)?;
    match ty {
        "message" => insert_plain(c, plain("assistant", name, Some(token_id), rid, &clean(body)?), role.as_deref()),
        "handoff" => {
            let to = short(to.ok_or("A hand-off needs a bot to hand over to")?, 60, "The bot handed over to")?;
            let what = match task_ref { Some(t) => short(t, 160, "The task")?, None => short(body, 160, "The task")? };
            let text = clean(body).unwrap_or_else(|_| what.clone());
            insert(c, &New { kind: "assistant", name, token: Some(token_id), room_id: rid, ty: "handoff", role: role.as_deref(), from: Some(name), to: Some(&to), task_ref: Some(&what), approval: None, queue_item_id: None, body: &text })
        }
        _ => Err("type must be message or handoff here".into()),
    }
}
/// An approval card: a question for the owner. It makes a queue item that needs the owner's decision. Returns the card.
pub fn post_approval(c: &Connection, token_id: &str, name: &str, room: Option<&str>, question: &str, queue_title: Option<&str>, role: Option<&str>) -> Result<Message, String> {
    post_approval_ref(c, token_id, name, room, question, queue_title, role, None)
}
/// The same, with an optional reference to the thing being approved (the title of a NOU page holding the spec), which the card offers to open.
pub fn post_approval_ref(c: &Connection, token_id: &str, name: &str, room: Option<&str>, question: &str, queue_title: Option<&str>, role: Option<&str>, task_ref: Option<&str>) -> Result<Message, String> {
    let rid = room_id(c, room)?;
    let task_ref = match task_ref { Some(t) => Some(short(t, 160, "The reference")?), None => None };
    let question = clean(question)?;
    let role = match role { Some(r) => Some(short(r, 20, "A role")?.to_uppercase()), None => None };
    let title = match queue_title { Some(t) => short(t, 160, "The queue title")?, None => question.chars().take(120).collect::<String>().replace('\n', " ") };
    limited(c, token_id)?;
    c.execute_batch("SAVEPOINT approval").map_err(e)?;
    let made = (|| -> Result<Message, String> {
        let item = crate::hub::queue_make(c, Some(token_id), name, &title, "needs_nick", rid)?;
        insert(c, &New { kind: "assistant", name, token: Some(token_id), room_id: rid, ty: "approval", role: role.as_deref(), from: None, to: None, task_ref: task_ref.as_deref(), approval: Some("open"), queue_item_id: Some(item), body: &question })
    })();
    match made { Ok(m) => { c.execute_batch("RELEASE approval").map_err(e)?; Ok(m) } Err(x) => { let _ = c.execute_batch("ROLLBACK TO approval; RELEASE approval"); Err(x) } }
}
/// The owner decides an open approval card. Approving (or declining) closes the card and marks its queue item Done. Nothing else changes.
pub fn decide_approval(c: &Connection, id: i64, approve: bool) -> Result<Message, String> {
    let (ty, status, item): (String, Option<String>, Option<i64>) = c.query_row("SELECT type,approval_status,queue_item_id FROM bot_messages WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(e)?.ok_or("Message not found")?;
    if ty != "approval" { return Err("That message is not an approval card".into()); }
    if status.as_deref() != Some("open") { return Err("That approval has already been decided".into()); }
    c.execute_batch("SAVEPOINT decide").map_err(e)?;
    let done = (|| -> Result<(), String> {
        c.execute("UPDATE bot_messages SET approval_status=?1,decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2", params![if approve { "approved" } else { "declined" }, id]).map_err(e)?;
        if let Some(item) = item { c.execute("UPDATE bot_queue_items SET status='done',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [item]).map_err(e)?; }
        crate::gateway::audit(c, "owner", "approval.decided", json!({ "message_id": id, "approved": approve, "queue_item_id": item }))
    })();
    match done { Ok(()) => c.execute_batch("RELEASE decide").map_err(e)?, Err(x) => { let _ = c.execute_batch("ROLLBACK TO decide; RELEASE decide"); return Err(x); } }
    get(c, id)
}
/// Delete every message in every room. Queue items are left alone.
pub fn clear(c: &Connection) -> Result<usize, String> { c.execute("DELETE FROM bot_messages", []).map_err(e) }

#[tauri::command]
pub fn chat_list(db: State<'_, Db>, after: Option<i64>, limit: Option<u32>, room: Option<String>) -> Result<Vec<Message>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    list(&c, after, limit.unwrap_or(100), room.as_deref())
}
#[tauri::command]
pub fn chat_post(db: State<'_, Db>, body: String, room: Option<String>) -> Result<Message, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    post_owner(&c, &body, room.as_deref())
}
#[tauri::command]
pub fn chat_clear(db: State<'_, Db>) -> Result<usize, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    db.writable()?;
    clear(&c)
}
#[tauri::command]
pub fn chat_rooms(db: State<'_, Db>) -> Result<Vec<Room>, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; rooms(&c) }
#[tauri::command]
pub fn chat_room_create(db: State<'_, Db>, name: String) -> Result<Room, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; create_room(&c, &name) }
#[tauri::command]
pub fn chat_decide_approval(db: State<'_, Db>, id: i64, approve: bool) -> Result<Message, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; decide_approval(&c, id, approve) }

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
    fn token(c: &Connection, name: &str) -> String { crate::gateway::create_token(c, name, &["chat:read".to_string(), "chat:write".to_string(), "queue:write".to_string()]).unwrap().info.id }

    #[test]
    fn messages_come_back_in_order_with_the_right_author_and_only_newer_ones_after_a_marker() {
        let c = fresh(); let t = token(&c, "Claude");
        let a = post_owner(&c, "hello bots", None).unwrap();
        let b = post_assistant(&c, &t, "Claude", "hello Nick").unwrap();
        let all = list(&c, None, 50, None).unwrap();
        assert_eq!(all.iter().map(|m| (m.kind.as_str(), m.author.as_str(), m.body.as_str(), m.room.as_str(), m.ty.as_str())).collect::<Vec<_>>(), vec![("owner", "You", "hello bots", "general", "message"), ("assistant", "Claude", "hello Nick", "general", "message")]);
        assert_eq!(list(&c, Some(a.id), 50, None).unwrap(), vec![b.clone()]);
        assert!(list(&c, Some(b.id), 50, None).unwrap().is_empty());
        assert_eq!(list(&c, None, 1, None).unwrap(), vec![b], "without a marker, the latest ones");
    }
    #[test]
    fn text_is_cleaned_and_empty_or_oversized_messages_are_refused() {
        let c = fresh();
        assert_eq!(post_owner(&c, "  line one\r\nline two\u{7}\u{0} ", None).unwrap().body, "line one\nline two");
        assert!(post_owner(&c, "   \n ", None).is_err());
        assert!(post_owner(&c, &"x".repeat(MAX_BODY + 1), None).is_err());
        assert!(post_owner(&c, &"x".repeat(MAX_BODY), None).is_ok());
        assert_eq!(post_owner(&c, "<img src=x onerror=alert(1)>", None).unwrap().body, "<img src=x onerror=alert(1)>", "kept as plain text; the screen never renders it as markup");
    }
    #[test]
    fn an_assistant_signs_with_its_token_name_and_is_rate_limited_per_token() {
        let c = fresh(); let t1 = token(&c, "Claude"); let t2 = token(&c, "Grok");
        for i in 0..PER_MINUTE { post_assistant(&c, &t1, "Claude", &format!("m{i}")).unwrap(); }
        assert!(post_assistant(&c, &t1, "Claude", "one too many").unwrap_err().contains("slow down"));
        assert!(post_assistant(&c, &t2, "Grok", "still fine for another token").is_ok());
        assert!(post_owner(&c, "the owner is not limited", None).is_ok());
    }
    #[test]
    fn the_chat_keeps_the_latest_two_thousand_messages_and_can_be_cleared() {
        let c = fresh();
        for i in 0..(KEEP + 25) { post_owner(&c, &format!("m{i}"), None).unwrap(); }
        let n: i64 = c.query_row("SELECT COUNT(*) FROM bot_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, KEEP);
        assert_eq!(list(&c, None, 1, None).unwrap()[0].body, format!("m{}", KEEP + 24));
        assert_eq!(clear(&c).unwrap() as i64, KEEP);
        assert!(list(&c, None, 10, None).unwrap().is_empty());
    }
    #[test]
    fn the_table_refuses_a_forged_author_and_a_token_cannot_be_deleted_while_it_has_messages() {
        let c = fresh(); let t = token(&c, "Claude");
        assert!(c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body) VALUES('assistant','Claude',NULL,'x')", []).is_err(), "an assistant message needs a token");
        assert!(c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body) VALUES('owner','You',?1,'x')", [&t]).is_err(), "an owner message has no token");
        post_assistant(&c, &t, "Claude", "hi").unwrap();
        assert!(c.execute("DELETE FROM api_tokens WHERE id=?1", [&t]).is_err());
    }

    #[test]
    fn rooms_start_with_general_and_the_owner_can_add_more_but_bots_cannot_make_them() {
        let c = fresh(); let t = token(&c, "Claude");
        assert_eq!(rooms(&c).unwrap().iter().map(|r| r.slug.as_str()).collect::<Vec<_>>(), vec!["general"]);
        let r = create_room(&c, "NOU build").unwrap(); assert_eq!(r.slug, "nou-build");
        assert!(create_room(&c, "nou  BUILD").is_err(), "a room with the same slug exists");
        assert!(create_room(&c, "  ").is_err()); assert!(create_room(&c, "!!!").is_err());
        let m = post_to_room(&c, &t, "Claude", Some("NOU-build"), "message", None, None, None, "in the build room").unwrap();
        assert_eq!(m.room, "nou-build");
        assert_eq!(list(&c, None, 50, Some("nou-build")).unwrap().len(), 1); assert!(list(&c, None, 50, None).unwrap().is_empty(), "General is separate");
        assert!(post_to_room(&c, &t, "Claude", Some("nowhere"), "message", None, None, None, "x").is_err(), "an unknown room is refused, not created");
        assert!(c.execute("DELETE FROM bot_rooms WHERE id=1", []).is_err()); assert!(c.execute("DELETE FROM bot_rooms WHERE slug='nou-build'", []).is_err(), "a room with messages stays");
        for i in 0..MAX_ROOMS { let _ = create_room(&c, &format!("room {i}")); }
        assert!(create_room(&c, "one more").is_err());
    }
    #[test]
    fn messages_written_before_the_upgrade_move_into_general() {
        // A schema 11 database with two old messages, upgraded.
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        for sql in [include_str!("../../../../db/notes/002_editor_formats.sql"), include_str!("../../../../db/notes/003_page_icons.sql"), include_str!("../../../../db/notes/004_databases.sql"), include_str!("../../../../db/notes/005_page_links.sql"), include_str!("../../../../db/notes/006_gateway.sql"), include_str!("../../../../db/notes/007_linked_todos.sql"), include_str!("../../../../db/notes/008_page_locks.sql"), include_str!("../../../../db/notes/009_bot_chat.sql"), include_str!("../../../../db/notes/010_life_timetable.sql"), include_str!("../../../../db/notes/011_timetable_variants.sql")] { c.execute_batch(sql).unwrap(); }
        let t = crate::gateway::create_token(&c, "Claude", &["chat:write".to_string()]).unwrap().info.id;
        c.execute("INSERT INTO bot_messages(author_kind,author_name,body) VALUES('owner','You','old one')", []).unwrap();
        c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body) VALUES('assistant','Claude',?1,'old two')", [&t]).unwrap();
        crate::editor::upgrade(&c).unwrap();
        let all = list(&c, None, 50, Some("general")).unwrap();
        assert_eq!(all.iter().map(|m| (m.body.as_str(), m.room.as_str(), m.ty.as_str())).collect::<Vec<_>>(), vec![("old one", "general", "message"), ("old two", "general", "message")]);
    }

    #[test]
    fn a_hand_off_is_signed_by_the_token_and_names_who_takes_over() {
        let c = fresh(); let t = token(&c, "Claude");
        let m = post_to_room(&c, &t, "Claude", None, "handoff", Some("router"), Some("ChatGPT"), Some("C# dimension component"), "").unwrap();
        assert_eq!((m.ty.as_str(), m.from.as_deref(), m.to.as_deref(), m.task_ref.as_deref(), m.role.as_deref()), ("handoff", Some("Claude"), Some("ChatGPT"), Some("C# dimension component"), Some("ROUTER")));
        assert!(post_to_room(&c, &t, "Claude", None, "handoff", None, None, Some("x"), "").is_err(), "needs someone to hand over to");
        assert!(post_to_room(&c, &t, "Claude", None, "approval", None, None, None, "x").is_err(), "approvals have their own call");
        assert!(c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body,type) VALUES('assistant','Claude',?1,'x','handoff')", [&t]).is_err(), "the table refuses a hand-off without both sides");
    }
    #[test]
    fn mentions_match_whole_names_only() {
        assert!(mentions("@Claude plan it", "claude")); assert!(mentions("ask @Claude, then @ChatGPT.", "ChatGPT")); assert!(mentions("@claude", "Claude"));
        assert!(!mentions("@ClaudeCode plan it", "Claude")); assert!(!mentions("hello Claude", "Claude"));
        let c = fresh(); let t = token(&c, "Claude");
        post_owner(&c, "@Claude plan the DraftBot tool. @ChatGPT takes Grasshopper.", None).unwrap(); post_owner(&c, "nothing for anyone", None).unwrap(); post_assistant(&c, &t, "Claude", "on it").unwrap();
        assert_eq!(list_mentioning(&c, None, 50, None, "ChatGPT").unwrap().len(), 1);
        assert_eq!(list_mentioning(&c, None, 50, None, "Kura").unwrap().len(), 0);
    }
    #[test]
    fn an_approval_card_makes_a_queue_item_and_only_the_owner_decides_it() {
        let c = fresh(); let t = token(&c, "Claude");
        let card = post_approval(&c, &t, "Claude", None, "Spec is ready. Approve it so ChatGPT can build against it?", Some("Approve dimension spec"), Some("router")).unwrap();
        assert_eq!((card.ty.as_str(), card.approval.as_deref(), card.role.as_deref()), ("approval", Some("open"), Some("ROUTER")));
        let item = crate::hub::queue_list(&c, None, 50).unwrap().into_iter().find(|q| Some(q.id) == card.queue_item_id).unwrap();
        assert_eq!((item.title.as_str(), item.bot.as_str(), item.status.as_str()), ("Approve dimension spec", "Claude", "needs_nick"));
        let done = decide_approval(&c, card.id, true).unwrap();
        assert_eq!(done.approval.as_deref(), Some("approved")); assert!(done.decided_at.is_some());
        assert_eq!(crate::hub::queue_list(&c, Some("done"), 50).unwrap().len(), 1, "the queue row is Done");
        assert!(decide_approval(&c, card.id, false).unwrap_err().contains("already"), "a decision is final");
        assert!(decide_approval(&c, 9999, true).is_err());
        let plain = post_owner(&c, "not a card", None).unwrap(); assert!(decide_approval(&c, plain.id, true).is_err());
        // Declining closes it as well.
        let two = post_approval(&c, &t, "Claude", None, "Ship it?", None, None).unwrap();
        assert_eq!(crate::hub::queue_list(&c, Some("needs_nick"), 50).unwrap()[0].title, "Ship it?", "the question becomes the title when none is given");
        assert_eq!(decide_approval(&c, two.id, false).unwrap().approval.as_deref(), Some("declined"));
        assert!(crate::hub::queue_list(&c, Some("needs_nick"), 50).unwrap().is_empty());
        assert!(c.execute("INSERT INTO bot_messages(author_kind,author_name,token_id,body,type) VALUES('assistant','Claude',?1,'x','approval')", [&t]).is_err(), "the table refuses an approval without a status");
    }
    #[test]
    fn an_approval_can_carry_a_reference_to_the_spec_it_asks_about() {
        let c = fresh(); let t = token(&c, "Claude");
        let card = post_approval_ref(&c, &t, "Claude", None, "Approve the spec?", None, None, Some("DraftBot dimension spec")).unwrap();
        assert_eq!(card.task_ref.as_deref(), Some("DraftBot dimension spec"));
        assert!(post_approval_ref(&c, &t, "Claude", None, "x", None, None, Some(&"y".repeat(161))).is_err());
    }
    #[test]
    fn a_failed_approval_leaves_no_queue_item_behind() {
        let c = fresh(); let t = token(&c, "Claude");
        assert!(post_approval(&c, &t, "Claude", Some("nowhere"), "q", None, None).is_err());
        assert!(post_approval(&c, &t, "Claude", None, "   ", None, None).is_err());
        assert!(crate::hub::queue_list(&c, None, 50).unwrap().is_empty());
    }
}
