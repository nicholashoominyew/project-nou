//! Bots Hub: the bot queue (what each assistant is working on), the private in-house channel with the local model, and who is in the room.
//! Like the chat, all of it is plain text and data: nothing here changes a note, and an assistant can only write under its own token's name.
use crate::chat::clean;
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

const PER_MINUTE: i64 = 30;
const KEEP_DONE: i64 = 300;
const KEEP_INHOUSE: i64 = 1000;
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

// ---- in-house channel ----
const KEEP_CHATS: i64 = 100;
const KEEP_HARNESSES: i64 = 30;
const MAX_INSTRUCTIONS: usize = 4000;
const MAX_COMBINED: usize = 8000;
const NEW_CHAT: &str = "New chat";
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct InhouseMessage { pub id: i64, pub at: String, pub author: String, pub body: String, pub chat_id: i64 }
fn ih(r: &rusqlite::Row<'_>) -> rusqlite::Result<InhouseMessage> { Ok(InhouseMessage { id: r.get(0)?, at: r.get(1)?, author: r.get(2)?, body: r.get(3)?, chat_id: r.get(4)? }) }
/// Messages of one chat (or of every chat when `chat` is None). After a marker: the next ones, oldest first. Otherwise the latest `limit`.
pub fn inhouse_list(c: &Connection, chat: Option<i64>, after: Option<i64>, limit: u32) -> Result<Vec<InhouseMessage>, String> {
    let limit = limit.clamp(1, 200) as i64;
    if let Some(after) = after {
        let mut s = c.prepare("SELECT id,created_at,author,body,chat_id FROM inhouse_messages WHERE (?1 IS NULL OR chat_id=?1) AND id>?2 ORDER BY id LIMIT ?3").map_err(e)?;
        let rows = s.query_map(params![chat, after, limit], ih).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
        return rows;
    }
    let mut s = c.prepare("SELECT id,created_at,author,body,chat_id FROM (SELECT * FROM inhouse_messages WHERE (?1 IS NULL OR chat_id=?1) ORDER BY id DESC LIMIT ?2) ORDER BY id").map_err(e)?;
    let rows = s.query_map(params![chat, limit], ih).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e);
    rows
}
fn ih_insert(c: &Connection, chat: i64, author: &str, token: Option<&str>, body: &str) -> Result<InhouseMessage, String> {
    c.execute("INSERT INTO inhouse_messages(author,token_id,body,chat_id) VALUES(?1,?2,?3,?4)", params![author, token, body, chat]).map_err(e)?;
    let id = c.last_insert_rowid();
    c.execute("DELETE FROM inhouse_messages WHERE id<=?1", [id - KEEP_INHOUSE]).map_err(e)?;
    c.execute("UPDATE inhouse_chats SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [chat]).map_err(e)?;
    if author == "owner" { // an untitled chat takes its name from the first thing the owner says in it
        let title: String = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect();
        if !title.is_empty() { c.execute("UPDATE inhouse_chats SET title=?1 WHERE id=?2 AND title=?3", params![title, chat, NEW_CHAT]).map_err(e)?; }
    }
    c.query_row("SELECT id,created_at,author,body,chat_id FROM inhouse_messages WHERE id=?1", [id], ih).map_err(e)
}
/// The owner writes to the local model, in one chat. Plain text, up to the same 4,000 characters as the room.
pub fn inhouse_post_owner(c: &Connection, chat: i64, body: &str) -> Result<InhouseMessage, String> { ih_insert(c, chat, "owner", None, &clean(body)?) }
/// The local model's runner answers, under its token, in the given chat (by default the chat of the owner's latest message). At most 20 a minute.
pub fn inhouse_post_bot(c: &Connection, token_id: &str, chat: Option<i64>, body: &str) -> Result<InhouseMessage, String> {
    let body = clean(body)?;
    let recent: i64 = c.query_row("SELECT COUNT(*) FROM inhouse_messages WHERE token_id=?1 AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')", [token_id], |r| r.get(0)).map_err(e)?;
    if recent >= 20 { return Err("Too many messages; slow down".into()); }
    let chat = match chat { Some(id) => id, None => c.query_row("SELECT chat_id FROM inhouse_messages WHERE author='owner' ORDER BY id DESC LIMIT 1", [], |r| r.get(0)).optional().map_err(e)?.unwrap_or(1) };
    ih_insert(c, chat, "bot", Some(token_id), &body)
}
/// Empty one chat. The chat itself, its name and its harnesses stay.
pub fn inhouse_clear(c: &Connection, chat: i64) -> Result<usize, String> { c.execute("DELETE FROM inhouse_messages WHERE chat_id=?1", [chat]).map_err(e) }

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct InhouseChat { pub id: i64, pub title: String, pub created_at: String, pub updated_at: String, pub messages: i64, pub harnesses: Vec<i64> }
fn chat_get(c: &Connection, id: i64) -> Result<InhouseChat, String> {
    let (title, created_at, updated_at, messages): (String, String, String, i64) = c.query_row(
        "SELECT title,created_at,updated_at,(SELECT COUNT(*) FROM inhouse_messages WHERE chat_id=inhouse_chats.id) FROM inhouse_chats WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional().map_err(e)?.ok_or("Chat not found")?;
    let mut s = c.prepare("SELECT harness_id FROM inhouse_chat_harnesses WHERE chat_id=?1 ORDER BY harness_id").map_err(e)?;
    let harnesses = s.query_map([id], |r| r.get::<_, i64>(0)).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    Ok(InhouseChat { id, title, created_at, updated_at, messages, harnesses })
}
/// The chats, most recently used first.
pub fn chats_list(c: &Connection) -> Result<Vec<InhouseChat>, String> {
    let mut s = c.prepare("SELECT id FROM inhouse_chats ORDER BY updated_at DESC, (SELECT COALESCE(MAX(m.id),0) FROM inhouse_messages m WHERE m.chat_id=inhouse_chats.id) DESC, id DESC" /* two chats can share a timestamp on a coarse clock (Windows): the one with the newest message wins */).map_err(e)?;
    let ids = s.query_map([], |r| r.get::<_, i64>(0)).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    ids.into_iter().map(|id| chat_get(c, id)).collect()
}
pub fn chat_create(c: &Connection, title: Option<&str>) -> Result<InhouseChat, String> {
    let n: i64 = c.query_row("SELECT COUNT(*) FROM inhouse_chats", [], |r| r.get(0)).map_err(e)?;
    if n >= KEEP_CHATS { return Err("Too many chats; delete some first".into()); }
    let title = match title { Some(t) if !t.trim().is_empty() => short(t, 80, "A chat name")?, _ => NEW_CHAT.to_string() };
    c.execute("INSERT INTO inhouse_chats(title) VALUES(?1)", [&title]).map_err(e)?;
    chat_get(c, c.last_insert_rowid())
}
pub fn chat_rename(c: &Connection, id: i64, title: &str) -> Result<InhouseChat, String> {
    let title = short(title, 80, "A chat name")?;
    if c.execute("UPDATE inhouse_chats SET title=?1 WHERE id=?2", params![title, id]).map_err(e)? != 1 { return Err("Chat not found".into()); }
    chat_get(c, id)
}
/// Delete a chat with its messages. When it was the last one, a fresh empty chat takes its place, so there is always one to type in.
pub fn chat_delete(c: &mut Connection, id: i64) -> Result<(), String> {
    let tx = c.transaction().map_err(e)?;
    tx.execute("DELETE FROM inhouse_messages WHERE chat_id=?1", [id]).map_err(e)?;
    if tx.execute("DELETE FROM inhouse_chats WHERE id=?1", [id]).map_err(e)? != 1 { return Err("Chat not found".into()); }
    let left: i64 = tx.query_row("SELECT COUNT(*) FROM inhouse_chats", [], |r| r.get(0)).map_err(e)?;
    if left == 0 { tx.execute("INSERT INTO inhouse_chats(title) VALUES(?1)", [NEW_CHAT]).map_err(e)?; }
    tx.commit().map_err(e)
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Harness { pub id: i64, pub name: String, pub instructions: String, pub always: bool }
fn harness_get(c: &Connection, id: i64) -> Result<Harness, String> {
    c.query_row("SELECT id,name,instructions,always FROM inhouse_harnesses WHERE id=?1", [id], |r| Ok(Harness { id: r.get(0)?, name: r.get(1)?, instructions: r.get(2)?, always: r.get::<_, i64>(3)? != 0 })).optional().map_err(e)?.ok_or_else(|| "Harness not found".to_string())
}
pub fn harness_list(c: &Connection) -> Result<Vec<Harness>, String> {
    let mut s = c.prepare("SELECT id FROM inhouse_harnesses ORDER BY name COLLATE NOCASE, id").map_err(e)?;
    let ids = s.query_map([], |r| r.get::<_, i64>(0)).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    ids.into_iter().map(|id| harness_get(c, id)).collect()
}
/// Instructions are plain text with line breaks and tabs kept; other control characters are dropped.
fn clean_instructions(text: &str) -> Result<String, String> {
    let t: String = text.replace("\r\n", "\n").chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect::<String>().trim().to_string();
    if t.is_empty() || t.chars().count() > MAX_INSTRUCTIONS { return Err(format!("Instructions must be 1 to {MAX_INSTRUCTIONS} characters")); }
    Ok(t)
}
/// Add a harness (`id` None) or change one. `always` makes it apply to every chat.
pub fn harness_save(c: &Connection, id: Option<i64>, name: &str, instructions: &str, always: bool) -> Result<Harness, String> {
    let name = short(name, 60, "A harness name")?; let text = clean_instructions(instructions)?;
    let taken = |x: rusqlite::Error| if x.to_string().contains("UNIQUE") { "A harness with that name already exists".to_string() } else { x.to_string() };
    match id {
        Some(id) => {
            let n = c.execute("UPDATE inhouse_harnesses SET name=?1,instructions=?2,always=?3,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?4", params![name, text, always as i64, id]).map_err(taken)?;
            if n != 1 { return Err("Harness not found".into()); }
            harness_get(c, id)
        }
        None => {
            let n: i64 = c.query_row("SELECT COUNT(*) FROM inhouse_harnesses", [], |r| r.get(0)).map_err(e)?;
            if n >= KEEP_HARNESSES { return Err("Too many harnesses; delete some first".into()); }
            c.execute("INSERT INTO inhouse_harnesses(name,instructions,always) VALUES(?1,?2,?3)", params![name, text, always as i64]).map_err(taken)?;
            harness_get(c, c.last_insert_rowid())
        }
    }
}
pub fn harness_delete(c: &Connection, id: i64) -> Result<(), String> {
    if c.execute("DELETE FROM inhouse_harnesses WHERE id=?1", [id]).map_err(e)? != 1 { return Err("Harness not found".into()); }
    Ok(())
}
/// Replace the set of harnesses a chat uses (besides the "always" ones).
pub fn chat_set_harnesses(c: &mut Connection, chat: i64, ids: &[i64]) -> Result<InhouseChat, String> {
    let tx = c.transaction().map_err(e)?;
    let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM inhouse_chats WHERE id=?1)", [chat], |r| r.get(0)).map_err(e)?;
    if !known { return Err("Chat not found".into()); }
    tx.execute("DELETE FROM inhouse_chat_harnesses WHERE chat_id=?1", [chat]).map_err(e)?;
    for id in ids.iter().collect::<std::collections::BTreeSet<_>>() {
        let ok: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM inhouse_harnesses WHERE id=?1)", [id], |r| r.get(0)).map_err(e)?;
        if !ok { return Err("Harness not found".into()); }
        tx.execute("INSERT INTO inhouse_chat_harnesses(chat_id,harness_id) VALUES(?1,?2)", params![chat, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    chat_get(c, chat)
}
/// What the model is given on top of its usual instructions for this chat: the harnesses marked "always", then the ones chosen for the chat, each under its
/// name. Returns the names and the combined text (at most 8,000 characters). Empty when there are none.
pub fn chat_instructions(c: &Connection, chat: i64) -> Result<(Vec<String>, String), String> {
    let known: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM inhouse_chats WHERE id=?1)", [chat], |r| r.get(0)).map_err(e)?;
    if !known { return Err("Chat not found".into()); }
    let mut s = c.prepare("SELECT name,instructions FROM inhouse_harnesses WHERE always=1 OR id IN (SELECT harness_id FROM inhouse_chat_harnesses WHERE chat_id=?1) ORDER BY always DESC, id").map_err(e)?;
    let rows = s.query_map([chat], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    let names = rows.iter().map(|(n, _)| n.clone()).collect();
    let text: String = rows.iter().map(|(n, t)| format!("## {n}\n{t}")).collect::<Vec<_>>().join("\n\n").chars().take(MAX_COMBINED).collect();
    Ok((names, text))
}
/// RUNNING when a token that may read and write the in-house channel was used in the last 30 seconds, SLEEPING within 10 minutes, otherwise OFFLINE.
pub fn inhouse_state(c: &Connection) -> Result<&'static str, String> {
    let age: Option<i64> = c.query_row(
        "SELECT CAST((julianday('now')-julianday(MAX(last_used_at)))*86400 AS INTEGER) FROM api_tokens WHERE revoked_at IS NULL AND last_used_at IS NOT NULL
         AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value='inhouse:read') AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value='inhouse:write')", [], |r| r.get(0)).map_err(e)?;
    Ok(match age { Some(s) if s <= RUNNING_SECS => "running", Some(s) if s <= SLEEPING_SECS => "sleeping", _ => "offline" })
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
         AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value IN ('chat:read','chat:write','queue:read','queue:write','inhouse:read','inhouse:write')) ORDER BY created_at,rowid").map_err(e)?;
    for r in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(e)? { let (name, age) = r.map_err(e)?; out.push(Participant { code: code_of(&name), name, online: age <= ONLINE_SECS, you: false }); }
    Ok(out)
}
#[derive(Serialize, Debug)]
pub struct Summary { pub rooms: Vec<crate::chat::Room>, pub participants: Vec<Participant>, pub bots_online: usize, pub inhouse_state: String, pub waiting: i64, pub open: i64 }
pub fn summary(c: &Connection) -> Result<Summary, String> {
    let participants = participants(c)?;
    let bots_online = participants.iter().filter(|p| !p.you && p.online).count();
    let waiting: i64 = c.query_row("SELECT COUNT(*) FROM bot_queue_items WHERE status='needs_nick'", [], |r| r.get(0)).map_err(e)?;
    let open: i64 = c.query_row("SELECT COUNT(*) FROM bot_queue_items WHERE status<>'done'", [], |r| r.get(0)).map_err(e)?;
    Ok(Summary { rooms: crate::chat::rooms(c)?, participants, bots_online, inhouse_state: inhouse_state(c)?.to_string(), waiting, open })
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
    let kura = gateway::create_token(c, "Kura", &scopes(&["chat:read", "chat:write", "queue:read", "queue:write", "inhouse:read", "inhouse:write"]))?.info.id;
    let xgrok = gateway::create_token(c, "XGrok", &scopes(&chat_scopes))?.info.id;
    let fresh = |id: &str, secs: i64| c.execute("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?1) WHERE id=?2", params![format!("-{secs} seconds"), id]).map(|_| ()).map_err(e);
    fresh(&claude, 20)?; fresh(&gpt, 40)?; fresh(&kura, 5)?; fresh(&xgrok, 7200)?;
    let room = Some("draftbot");
    chat::post_owner(c, "@Claude plan the DraftBot dimension tool for this week. @ChatGPT takes the Grasshopper side.", room)?;
    chat::post_to_room(c, &claude, "Claude", room, "message", Some("router"), None, None, "Splitting it in three: dimension rules spec, the C# component, then a test on the tied arch deck. I will write the spec and hand the component to ChatGPT.")?;
    chat::post_to_room(c, &claude, "Claude", room, "handoff", None, Some("ChatGPT"), Some("C# dimension component"), "Handed over")?;
    chat::post_to_room(c, &gpt, "ChatGPT", room, "message", Some("executor"), None, None, "Picked it up. The draft reads curves from the selected layer and places aligned dimensions. I need the default text height before going further.")?;
    chat::post_to_room(c, &kura, "Kura", room, "message", Some("local"), None, None, "From your notes in NOU: drawing text height is 2.5 mm at paper scale.")?;
    chat::post_approval_ref(c, &claude, "Claude", room, "Spec is ready. Approve it so ChatGPT can build against it?", Some("Approve dimension spec"), Some("router"), Some("DraftBot dimension spec"))?;
    queue_create(c, &claude, "Claude", "Spec DraftBot dimension rules", Some("running"), room)?;
    queue_create(c, &gpt, "ChatGPT", "C# dimension component", Some("running"), room)?;
    queue_create(c, &xgrok, "XGrok", "Harvest Vanguard tier posts", Some("queued"), room)?;
    queue_create(c, &kura, "Kura", "Pick today's five teachings", Some("done"), room)?;
    inhouse_post_owner(c, 1, "What is left on today's list?")?;
    inhouse_post_bot(c, &kura, Some(1), "Three things: N3 kanji set, the NOU sidebar fix, and the morning workout. The workout is first.")?;
    inhouse_post_owner(c, 1, "Move the sidebar fix to tonight.")?;
    inhouse_post_bot(c, &kura, Some(1), "Done. It now sits in the 20:00 block.")?;
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
#[tauri::command]
pub fn inhouse_messages(db: State<'_, Db>, chat_id: Option<i64>, after: Option<i64>, limit: Option<u32>) -> Result<Vec<InhouseMessage>, String> { let c = locked!(db); inhouse_list(&c, chat_id, after, limit.unwrap_or(100)) }
#[tauri::command]
pub fn inhouse_send(db: State<'_, Db>, chat_id: i64, body: String) -> Result<InhouseMessage, String> { let c = locked!(db); db.writable()?; inhouse_post_owner(&c, chat_id, &body) }
#[tauri::command]
pub fn inhouse_clear_chat(db: State<'_, Db>, chat_id: i64) -> Result<usize, String> { let c = locked!(db); db.writable()?; inhouse_clear(&c, chat_id) }
#[tauri::command]
pub fn inhouse_chats(db: State<'_, Db>) -> Result<Vec<InhouseChat>, String> { let c = locked!(db); chats_list(&c) }
#[tauri::command]
pub fn inhouse_chat_create(db: State<'_, Db>, title: Option<String>) -> Result<InhouseChat, String> { let c = locked!(db); db.writable()?; chat_create(&c, title.as_deref()) }
#[tauri::command]
pub fn inhouse_chat_rename(db: State<'_, Db>, chat_id: i64, title: String) -> Result<InhouseChat, String> { let c = locked!(db); db.writable()?; chat_rename(&c, chat_id, &title) }
#[tauri::command]
pub fn inhouse_chat_delete(db: State<'_, Db>, chat_id: i64) -> Result<(), String> { let mut c = locked!(db); db.writable()?; chat_delete(&mut c, chat_id) }
#[tauri::command]
pub fn inhouse_harnesses(db: State<'_, Db>) -> Result<Vec<Harness>, String> { let c = locked!(db); harness_list(&c) }
#[tauri::command]
pub fn inhouse_harness_save(db: State<'_, Db>, id: Option<i64>, name: String, instructions: String, always: bool) -> Result<Harness, String> { let c = locked!(db); db.writable()?; harness_save(&c, id, &name, &instructions, always) }
#[tauri::command]
pub fn inhouse_harness_delete(db: State<'_, Db>, id: i64) -> Result<(), String> { let c = locked!(db); db.writable()?; harness_delete(&c, id) }
#[tauri::command]
pub fn inhouse_chat_harnesses(db: State<'_, Db>, chat_id: i64, ids: Vec<i64>) -> Result<InhouseChat, String> { let mut c = locked!(db); db.writable()?; chat_set_harnesses(&mut c, chat_id, &ids) }

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
    fn the_in_house_chat_is_private_to_its_own_table() {
        let c = fresh(); let runner = token(&c, "Kura", &["inhouse:read", "inhouse:write"]); let other = token(&c, "Claude", &["chat:read", "chat:write"]);
        let q = inhouse_post_owner(&c, 1, "What is left on today's list?").unwrap();
        let a = inhouse_post_bot(&c, &runner, None, "Three things.").unwrap();
        assert_eq!(inhouse_list(&c, None, None, 50).unwrap().iter().map(|m| (m.author.as_str(), m.body.as_str())).collect::<Vec<_>>(), vec![("owner", "What is left on today's list?"), ("bot", "Three things.")]);
        assert_eq!(inhouse_list(&c, None, Some(q.id), 50).unwrap(), vec![a]);
        // Nothing of it is in the room: the room's list, the API's chat and a mention filter never see it.
        assert!(crate::chat::list(&c, None, 50, None).unwrap().is_empty());
        assert!(crate::chat::list_mentioning(&c, None, 50, None, "Kura").unwrap().is_empty());
        let n: i64 = c.query_row("SELECT COUNT(*) FROM bot_messages WHERE body LIKE '%today%' OR body LIKE '%Three things%'", [], |r| r.get(0)).unwrap(); assert_eq!(n, 0);
        crate::chat::post_assistant(&c, &other, "Claude", "hello room").unwrap();
        assert_eq!(inhouse_list(&c, None, None, 50).unwrap().len(), 2, "room messages do not leak into the private channel either");
        assert!(c.execute("INSERT INTO inhouse_messages(author,token_id,body) VALUES('bot',NULL,'x')", []).is_err(), "a bot reply needs a token");
        assert!(c.execute("INSERT INTO inhouse_messages(author,token_id,body) VALUES('owner',?1,'x')", [&runner]).is_err(), "an owner message has no token");
        assert!(inhouse_post_owner(&c, 1, "  ").is_err());
        assert_eq!(inhouse_clear(&c, 1).unwrap(), 2); assert!(inhouse_list(&c, None, None, 50).unwrap().is_empty());
    }
    #[test]
    fn the_local_model_shows_running_sleeping_or_offline_from_when_its_token_was_last_used() {
        let c = fresh();
        assert_eq!(inhouse_state(&c).unwrap(), "offline", "no runner token yet");
        let t = token(&c, "Kura", &["inhouse:read", "inhouse:write"]);
        assert_eq!(inhouse_state(&c).unwrap(), "offline", "never used");
        let set = |secs: i64| c.execute("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?1) WHERE id=?2", params![format!("-{secs} seconds"), t]).unwrap();
        set(5); assert_eq!(inhouse_state(&c).unwrap(), "running");
        set(120); assert_eq!(inhouse_state(&c).unwrap(), "sleeping");
        set(3600); assert_eq!(inhouse_state(&c).unwrap(), "offline");
        let only_read = token(&c, "Spy", &["inhouse:read"]); c.execute("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [&only_read]).unwrap();
        assert_eq!(inhouse_state(&c).unwrap(), "offline", "a token that cannot also reply does not count as the runner");
        set(2); crate::gateway::revoke_token(&c, &t).unwrap(); assert_eq!(inhouse_state(&c).unwrap(), "offline", "a revoked runner is offline");
    }
    #[test]
    fn the_development_sample_data_loads_once_and_looks_like_the_mockup() {
        let c = fresh();
        seed_demo(&c).unwrap();
        assert!(seed_demo(&c).unwrap_err().contains("already"));
        let s = summary(&c).unwrap();
        assert_eq!((s.rooms.len(), s.bots_online, s.waiting, s.open, s.inhouse_state.as_str()), (3, 3, 1, 4, "running"));
        assert_eq!(crate::chat::list(&c, None, 50, Some("draftbot")).unwrap().iter().map(|m| m.ty.as_str()).collect::<Vec<_>>(), vec!["message", "message", "handoff", "message", "message", "approval"]);
        assert_eq!(inhouse_list(&c, None, None, 50).unwrap().len(), 4);
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

    #[test]
    fn there_can_be_several_chats_each_with_its_own_messages_and_a_name_taken_from_the_first_question() {
        let mut c = fresh();
        let first = chats_list(&c).unwrap(); assert_eq!(first.len(), 1); assert_eq!((first[0].id, first[0].title.as_str(), first[0].messages), (1, "New chat", 0));
        let other = chat_create(&c, None).unwrap(); assert_eq!(other.title, "New chat");
        let named = chat_create(&c, Some("  Kanji plan  ")).unwrap(); assert_eq!(named.title, "Kanji plan");
        inhouse_post_owner(&c, 1, "What   is left\non today's list? This sentence is much longer than forty characters in total.").unwrap();
        assert_eq!(chat_get(&c, 1).unwrap().title, "What is left on today's list? This sente", "an untitled chat is named after its first question, whitespace tidied, at most 40 characters");
        inhouse_post_owner(&c, 1, "second question").unwrap();
        assert!(chat_get(&c, 1).unwrap().title.starts_with("What is left"), "it keeps that name afterwards");
        inhouse_post_owner(&c, named.id, "hello").unwrap(); assert_eq!(chat_get(&c, named.id).unwrap().title, "Kanji plan", "a chat you named is not renamed");
        let runner = token(&c, "Kura", &["inhouse:read", "inhouse:write"]);
        inhouse_post_owner(&c, other.id, "a question in the other chat").unwrap();
        // The runner's reply goes where it says, or by default to the chat of the owner's latest question.
        assert_eq!(inhouse_post_bot(&c, &runner, None, "default").unwrap().chat_id, other.id);
        assert_eq!(inhouse_post_bot(&c, &runner, Some(1), "explicit").unwrap().chat_id, 1);
        assert!(inhouse_post_bot(&c, &runner, Some(999), "x").is_err() && inhouse_post_owner(&c, 999, "x").is_err(), "an unknown chat is refused");
        assert_eq!(inhouse_list(&c, Some(1), None, 50).unwrap().iter().map(|m| m.body.as_str()).collect::<Vec<_>>().len(), 3);
        assert_eq!(inhouse_list(&c, Some(other.id), None, 50).unwrap().len(), 2);
        assert_eq!(inhouse_list(&c, None, None, 50).unwrap().len(), 6, "no chat given: every chat");
        inhouse_post_owner(&c, other.id, "latest").unwrap(); // the last message decides, whatever the clock resolution
        assert_eq!(chats_list(&c).unwrap()[0].id, other.id, "the most recently used chat comes first");
        c.execute("UPDATE inhouse_chats SET updated_at='2026-01-01T00:00:00.000Z'", []).unwrap(); // every chat on the very same instant, as on a coarse clock
        assert_eq!(chats_list(&c).unwrap()[0].id, other.id, "with equal timestamps the chat with the newest message still comes first");
        assert_eq!(chat_rename(&c, other.id, " Plan ").unwrap().title, "Plan"); assert!(chat_rename(&c, other.id, "  ").is_err() && chat_rename(&c, 999, "x").is_err());
        // Clearing one chat leaves the others, its name and its place in the list.
        assert_eq!(inhouse_clear(&c, 1).unwrap(), 3);
        assert!(inhouse_list(&c, Some(1), None, 50).unwrap().is_empty()); assert_eq!(inhouse_list(&c, Some(other.id), None, 50).unwrap().len(), 3); assert_eq!(chats_list(&c).unwrap().len(), 3);
        // Deleting a chat deletes its messages; deleting the last chat leaves a fresh one.
        chat_delete(&mut c, other.id).unwrap(); assert!(inhouse_list(&c, Some(other.id), None, 50).unwrap().is_empty()); assert!(chat_delete(&mut c, other.id).is_err());
        chat_delete(&mut c, 1).unwrap(); chat_delete(&mut c, named.id).unwrap();
        let left = chats_list(&c).unwrap(); assert_eq!(left.len(), 1); assert_eq!(left[0].title, "New chat");
        for _ in 0..(KEEP_CHATS - 1) { chat_create(&c, None).unwrap(); } assert!(chat_create(&c, None).is_err(), "there is a limit on chats");
    }
    #[test]
    fn harnesses_are_named_extra_instructions_that_apply_to_every_chat_or_only_to_chosen_ones() {
        let mut c = fresh();
        assert_eq!(chat_instructions(&c, 1).unwrap(), (vec![], String::new()));
        let style = harness_save(&c, None, " Plain style ", "  Answer in two sentences.\r\nNo lists.  ", true).unwrap();
        assert_eq!((style.name.as_str(), style.instructions.as_str(), style.always), ("Plain style", "Answer in two sentences.\nNo lists.", true), "trimmed, line breaks kept");
        let timetable = harness_save(&c, None, "Timetable", "You help plan the Life Timetable: half-hour blocks, Week A and Week B.", false).unwrap();
        let notes = harness_save(&c, None, "Notes", "Pages and databases live in NOU.", false).unwrap();
        assert!(harness_save(&c, None, "timetable", "x", false).unwrap_err().contains("already exists"), "names are unique, ignoring case");
        assert!(harness_save(&c, None, "  ", "x", false).is_err() && harness_save(&c, None, "Empty", "   ", false).is_err() && harness_save(&c, None, "Long", &"x".repeat(4001), false).is_err());
        assert_eq!(harness_list(&c).unwrap().iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), vec!["Notes", "Plain style", "Timetable"]);
        // Only the always-on one applies until a chat chooses more.
        assert_eq!(chat_instructions(&c, 1).unwrap(), (vec!["Plain style".to_string()], "## Plain style\nAnswer in two sentences.\nNo lists.".to_string()));
        let chat = chat_create(&c, None).unwrap();
        assert_eq!(chat_set_harnesses(&mut c, chat.id, &[notes.id, timetable.id, notes.id]).unwrap().harnesses, vec![timetable.id.min(notes.id), timetable.id.max(notes.id)], "duplicates collapse");
        let (names, text) = chat_instructions(&c, chat.id).unwrap();
        assert_eq!(names, vec!["Plain style", "Timetable", "Notes"], "always-on first, then the chosen ones in the order they were made");
        assert!(text.starts_with("## Plain style\n") && text.contains("\n\n## Timetable\nYou help plan") && text.ends_with("Pages and databases live in NOU."));
        assert_eq!(chat_instructions(&c, 1).unwrap().0, vec!["Plain style"], "another chat is not affected");
        // Editing, switching off "always", and unknown ids.
        let edited = harness_save(&c, Some(style.id), "Plain style", "Be brief.", false).unwrap(); assert!(!edited.always && edited.instructions == "Be brief.");
        assert!(chat_instructions(&c, 1).unwrap().0.is_empty());
        assert!(harness_save(&c, Some(999), "x", "y", false).is_err() && chat_set_harnesses(&mut c, chat.id, &[999]).is_err() && chat_set_harnesses(&mut c, 999, &[]).is_err() && chat_instructions(&c, 999).is_err());
        assert_eq!(chat_get(&c, chat.id).unwrap().harnesses.len(), 2, "a refused change leaves the choice as it was");
        // Deleting a harness takes it out of every chat; deleting a chat leaves the harness.
        harness_delete(&c, notes.id).unwrap(); assert_eq!(chat_get(&c, chat.id).unwrap().harnesses, vec![timetable.id]); assert!(harness_delete(&c, notes.id).is_err());
        chat_delete(&mut c, chat.id).unwrap(); assert_eq!(harness_list(&c).unwrap().len(), 2);
        let long = harness_save(&c, None, "Long", &"y".repeat(4000), true).unwrap(); let _ = harness_save(&c, None, "Longer", &"z".repeat(4000), true).unwrap(); let _ = harness_save(&c, None, "Longest", &"w".repeat(4000), true).unwrap();
        assert!(chat_instructions(&c, 1).unwrap().1.chars().count() <= 8000, "the combined text is capped"); let _ = long;
    }
}
