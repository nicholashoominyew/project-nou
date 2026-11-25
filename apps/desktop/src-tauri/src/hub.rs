//! Bots Hub: the bot queue (what each assistant is working on), the private in-house channel with the local model, and who is in the room.
//! Like the chat, all of it is plain text and data: nothing here changes a note, and an assistant can only write under its own token's name.
use crate::chat::clean;
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

const PER_MINUTE: i64 = 30;
const KEEP_DONE: i64 = 300;
/// A token seen in the last 5 minutes counts as online; the local model's runner is RUNNING under 30 seconds, SLEEPING under 10 minutes.
const ONLINE_SECS: i64 = 300;
const RUNNING_SECS: i64 = 30;
const SLEEPING_SECS: i64 = 600;

fn e(error: rusqlite::Error) -> String { error.to_string() }
fn short(text: &str, max: usize, what: &str) -> Result<String, String> {
    let t: String = text.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    if t.is_empty() || t.chars().count() > max { return Err(format!("{what} must be 1 to {max} characters")); }
    Ok(t)
}

// ---- the queue ----
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct QueueItem { pub id: i64, pub title: String, pub bot: String, pub status: String, pub room: String, pub created_at: String, pub updated_at: String, pub approval_message_id: Option<i64> }
fn item(r: &rusqlite::Row<'_>) -> rusqlite::Result<QueueItem> {
    Ok(QueueItem { id: r.get(0)?, title: r.get(1)?, bot: r.get(2)?, status: r.get(3)?, room: r.get(4)?, created_at: r.get(5)?, updated_at: r.get(6)?, approval_message_id: r.get(7)? })
}
const ITEM: &str = "SELECT q.id,q.title,q.bot,q.status,r.slug,q.created_at,q.updated_at,(SELECT id FROM bot_messages WHERE queue_item_id=q.id AND type='approval' ORDER BY id LIMIT 1) FROM bot_queue_items q JOIN bot_rooms r ON r.id=q.room_id";

/// Items that need the owner come first, then running, queued and done; newest first within a group.
pub fn queue_list(c: &Connection, status: Option<&str>, limit: u32) -> Result<Vec<QueueItem>, String> {
    let limit = limit.clamp(1, 300) as i64;
    let sql = format!("{ITEM} WHERE (?1 IS NULL OR q.status=?1) ORDER BY CASE q.status WHEN 'needs_nick' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, q.updated_at DESC, q.id DESC LIMIT ?2");
    let mut s = c.prepare(&sql).map_err(e)?;
    let rows = s.query_map(params![status, limit], item).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
pub fn queue_get(c: &Connection, id: i64) -> Result<QueueItem, String> {
    c.query_row(&format!("{ITEM} WHERE q.id=?1"), [id], item).optional().map_err(e)?.ok_or_else(|| "Queue item not found".to_string())
}
/// Used by approval cards (status needs_nick) and by the API (queued, running, done). Old finished items are pruned so the list stays short.
pub fn queue_make(c: &Connection, token_id: Option<&str>, bot: &str, title: &str, status: &str, room_id: i64) -> Result<i64, String> {
    if let Some(t) = token_id {
        let recent: i64 = c.query_row("SELECT COUNT(*) FROM bot_queue_items WHERE token_id=?1 AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')", [t], |r| r.get(0)).map_err(e)?;
        if recent >= PER_MINUTE { return Err("Too many queue items; slow down".into()); }
    }
    c.execute("INSERT INTO bot_queue_items(title,bot,token_id,status,room_id) VALUES(?1,?2,?3,?4,?5)", params![title, bot, token_id, status, room_id]).map_err(e)?;
    let id = c.last_insert_rowid();
    c.execute("DELETE FROM bot_queue_items WHERE status='done' AND id NOT IN (SELECT id FROM bot_queue_items WHERE status='done' ORDER BY updated_at DESC,id DESC LIMIT ?1) AND id NOT IN (SELECT queue_item_id FROM bot_messages WHERE queue_item_id IS NOT NULL)", [KEEP_DONE]).map_err(e)?;
    Ok(id)
}
/// An assistant adds an item. It can start as queued, running or done; only an approval card can make an item that waits for the owner.
pub fn queue_create(c: &Connection, token_id: &str, bot: &str, title: &str, status: Option<&str>, room: Option<&str>) -> Result<QueueItem, String> {
    let status = status.unwrap_or("queued");
    if !matches!(status, "queued" | "running" | "done") { return Err("status must be queued, running or done".into()); }
    let rid = crate::chat::room_id(c, room)?;
    let id = queue_make(c, Some(token_id), bot, &short(title, 160, "The title")?, status, rid)?;
    queue_get(c, id)
}
/// An assistant moves one of its own items between queued, running and done. It cannot touch another bot's item, and it cannot close an item that is
/// waiting for the owner: only the owner's decision does that.
pub fn queue_set(c: &Connection, token_id: &str, id: i64, status: &str) -> Result<QueueItem, String> {
    if !matches!(status, "queued" | "running" | "done") { return Err("status must be queued, running or done".into()); }
    let (owner, current): (Option<String>, String) = c.query_row("SELECT token_id,status FROM bot_queue_items WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?.ok_or("Queue item not found")?;
    if owner.as_deref() != Some(token_id) { return Err("Queue item not found".into()); }
    if current == "needs_nick" { return Err("This item is waiting for the owner to decide".into()); }
    c.execute("UPDATE bot_queue_items SET status=?1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2", params![status, id]).map_err(e)?;
    queue_get(c, id)
}

// ---- who is here ----
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Participant { pub name: String, pub code: String, pub online: bool, pub you: bool }
/// Two letters for an avatar: the first two letters of the name, upper case.
pub fn code_of(name: &str) -> String { let l: String = name.chars().filter(|c| c.is_alphabetic()).take(2).collect::<String>().to_uppercase(); if l.is_empty() { "??".into() } else { l } }
pub fn participants(c: &Connection) -> Result<Vec<Participant>, String> {
    let mut out = vec![Participant { name: "You".into(), code: "YO".into(), online: true, you: true }];
    let mut s = c.prepare(
        "SELECT name, COALESCE(CAST((julianday('now')-julianday(last_used_at))*86400 AS INTEGER),999999) FROM api_tokens WHERE revoked_at IS NULL
         AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value IN ('chat:read','chat:write','queue:read','queue:write')) ORDER BY created_at,rowid").map_err(e)?;
    for r in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(e)? { let (name, age) = r.map_err(e)?; out.push(Participant { code: code_of(&name), name, online: age <= ONLINE_SECS, you: false }); }
    Ok(out)
}
#[derive(Serialize, Debug)]
pub struct Summary { pub rooms: Vec<crate::chat::Room>, pub participants: Vec<Participant>, pub bots_online: usize, pub waiting: i64, pub open: i64 }
pub fn summary(c: &Connection) -> Result<Summary, String> {
    let participants = participants(c)?;
    let bots_online = participants.iter().filter(|p| !p.you && p.online).count();
    let waiting: i64 = c.query_row("SELECT COUNT(*) FROM bot_queue_items WHERE status='needs_nick'", [], |r| r.get(0)).map_err(e)?;
    let open: i64 = c.query_row("SELECT COUNT(*) FROM bot_queue_items WHERE status<>'done'", [], |r| r.get(0)).map_err(e)?;
    Ok(Summary { rooms: crate::chat::rooms(c)?, participants, bots_online, waiting, open })
}

/// Development builds only: the mockup's sample conversation, so the page can be looked at with something in it. It makes sample bot tokens (their secrets are
/// thrown away, so nothing can use them), the DraftBot and NOU build rooms, messages, a hand-off, an open approval card, queue items and a private chat.
pub fn seed_demo(c: &Connection) -> Result<(), String> {
    use crate::{chat, gateway};
    if chat::rooms(c)?.iter().any(|r| r.slug == "draftbot") { return Err("The sample data is already loaded".into()); }
    chat::create_room(c, "DraftBot")?; chat::create_room(c, "NOU build")?;
    let scopes = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let chat_scopes = ["chat:read", "chat:write", "queue:read", "queue:write"];
    let claude = gateway::create_token(c, "Claude", &scopes(&chat_scopes))?.info.id;
    let gpt = gateway::create_token(c, "ChatGPT", &scopes(&chat_scopes))?.info.id;
    let xgrok = gateway::create_token(c, "XGrok", &scopes(&chat_scopes))?.info.id;
    let fresh = |id: &str, secs: i64| c.execute("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?1) WHERE id=?2", params![format!("-{secs} seconds"), id]).map(|_| ()).map_err(e);
    fresh(&claude, 20)?; fresh(&gpt, 40)?; fresh(&xgrok, 7200)?;
    let room = Some("draftbot");
    chat::post_owner(c, "@Claude plan the DraftBot dimension tool for this week. @ChatGPT takes the Grasshopper side.", room)?;
    chat::post_to_room(c, &claude, "Claude", room, "message", Some("router"), None, None, "Splitting it in three: dimension rules spec, the C# component, then a test on the tied arch deck. I will write the spec and hand the component to ChatGPT.")?;
    chat::post_to_room(c, &claude, "Claude", room, "handoff", None, Some("ChatGPT"), Some("C# dimension component"), "Handed over")?;
    chat::post_to_room(c, &gpt, "ChatGPT", room, "message", Some("executor"), None, None, "Picked it up. The draft reads curves from the selected layer and places aligned dimensions. I need the default text height before going further.")?;
    chat::post_approval_ref(c, &claude, "Claude", room, "Spec is ready. Approve it so ChatGPT can build against it?", Some("Approve dimension spec"), Some("router"), Some("DraftBot dimension spec"))?;
    queue_create(c, &claude, "Claude", "Spec DraftBot dimension rules", Some("running"), room)?;
    queue_create(c, &gpt, "ChatGPT", "C# dimension component", Some("running"), room)?;
    queue_create(c, &xgrok, "XGrok", "Harvest Vanguard tier posts", Some("queued"), room)?;
    Ok(())
}
#[tauri::command]
pub fn hub_seed_demo(db: State<'_, Db>) -> Result<(), String> {
    if !cfg!(debug_assertions) { return Err("Sample data is for development builds only".into()); }
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; seed_demo(&c)
}
#[tauri::command]
pub fn hub_summary(db: State<'_, Db>) -> Result<Summary, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; summary(&c) }
#[tauri::command]
pub fn queue_items(db: State<'_, Db>, status: Option<String>) -> Result<Vec<QueueItem>, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; queue_list(&c, status.as_deref(), 300) }
macro_rules! locked { ($db:expr) => { $db.0.lock().map_err(|_| "Database lock poisoned")? }; }
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
    fn token(c: &Connection, name: &str, scopes: &[&str]) -> String { crate::gateway::create_token(c, name, &scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap().info.id }

    #[test]
    fn an_assistant_manages_only_its_own_items_and_cannot_close_one_that_waits_for_the_owner() {
        let c = fresh(); let a = token(&c, "Claude", &["queue:write"]); let b = token(&c, "ChatGPT", &["queue:write", "chat:write"]);
        let mine = queue_create(&c, &a, "Claude", "Spec dimension rules", None, None).unwrap();
        assert_eq!((mine.status.as_str(), mine.bot.as_str(), mine.room.as_str()), ("queued", "Claude", "general"));
        assert_eq!(queue_set(&c, &a, mine.id, "running").unwrap().status, "running");
        assert_eq!(queue_set(&c, &a, mine.id, "done").unwrap().status, "done");
        assert!(queue_set(&c, &b, mine.id, "queued").unwrap_err().contains("not found"), "another bot's item looks like it does not exist");
        assert!(queue_create(&c, &a, "Claude", "x", Some("needs_nick"), None).is_err(), "only an approval card makes an item that waits for the owner");
        assert!(queue_set(&c, &a, mine.id, "needs_nick").is_err()); assert!(queue_create(&c, &a, "Claude", "  ", None, None).is_err());
        assert!(queue_create(&c, &a, "Claude", "x", None, Some("nowhere")).is_err());
        let card = crate::chat::post_approval(&c, &b, "ChatGPT", None, "OK to build?", Some("Approve the build"), None).unwrap();
        assert!(queue_set(&c, &b, card.queue_item_id.unwrap(), "done").unwrap_err().contains("waiting for the owner"), "a bot cannot approve its own card by closing the item");
        crate::chat::decide_approval(&c, card.id, true).unwrap();
        assert_eq!(queue_get(&c, card.queue_item_id.unwrap()).unwrap().status, "done");
    }
    #[test]
    fn the_list_puts_the_owners_items_first_and_filters_by_status() {
        let c = fresh(); let a = token(&c, "Claude", &["queue:write", "chat:write"]);
        let q = queue_create(&c, &a, "Claude", "queued one", None, None).unwrap(); let r = queue_create(&c, &a, "Claude", "running one", Some("running"), None).unwrap();
        queue_create(&c, &a, "Claude", "done one", Some("done"), None).unwrap();
        let card = crate::chat::post_approval(&c, &a, "Claude", None, "Approve?", Some("needs me"), None).unwrap();
        let all = queue_list(&c, None, 50).unwrap();
        assert_eq!(all.iter().map(|x| x.status.as_str()).collect::<Vec<_>>(), vec!["needs_nick", "running", "queued", "done"]);
        assert_eq!(all[0].approval_message_id, Some(card.id));
        assert_eq!(queue_list(&c, Some("running"), 50).unwrap().iter().map(|x| x.id).collect::<Vec<_>>(), vec![r.id]);
        assert_eq!(queue_list(&c, Some("queued"), 50).unwrap()[0].id, q.id);
        let s = summary(&c).unwrap(); assert_eq!((s.waiting, s.open), (1, 3));
    }
    #[test]
    fn queue_creation_is_rate_limited_and_finished_items_are_pruned() {
        let c = fresh(); let a = token(&c, "Claude", &["queue:write"]);
        for i in 0..PER_MINUTE { queue_create(&c, &a, "Claude", &format!("t{i}"), Some("done"), None).unwrap(); }
        assert!(queue_create(&c, &a, "Claude", "one too many", None, None).unwrap_err().contains("slow down"));
        let n: i64 = c.query_row("SELECT COUNT(*) FROM bot_queue_items", [], |r| r.get(0)).unwrap(); assert_eq!(n, PER_MINUTE);
    }

    #[test]
    fn the_development_sample_data_loads_once_and_looks_like_the_mockup() {
        let c = fresh();
        seed_demo(&c).unwrap();
        assert!(seed_demo(&c).unwrap_err().contains("already"));
        let s = summary(&c).unwrap();
        assert_eq!((s.rooms.len(), s.bots_online, s.waiting, s.open), (3, 2, 1, 4));
        assert_eq!(crate::chat::list(&c, None, 50, Some("draftbot")).unwrap().iter().map(|m| m.ty.as_str()).collect::<Vec<_>>(), vec!["message", "message", "handoff", "message", "approval"]);
    }
    #[test]
    fn participants_come_from_tokens_that_can_use_the_hub_and_online_means_seen_in_five_minutes() {
        let c = fresh();
        let a = token(&c, "Claude", &["chat:write"]); let b = token(&c, "XGrok", &["chat:read"]); token(&c, "Reader", &["notes:read"]);
        c.execute("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 seconds') WHERE id=?1", [&a]).unwrap();
        c.execute("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours') WHERE id=?1", [&b]).unwrap();
        let p = participants(&c).unwrap();
        assert_eq!(p.iter().map(|x| (x.name.as_str(), x.code.as_str(), x.online)).collect::<Vec<_>>(), vec![("You", "YO", true), ("Claude", "CL", true), ("XGrok", "XG", false)], "a notes-only token is not in the room");
        assert_eq!(summary(&c).unwrap().bots_online, 1);
        assert_eq!((code_of("ChatGPT"), code_of("  k"), code_of("123")), ("CH".to_string(), "K".to_string(), "??".to_string()));
    }

}
