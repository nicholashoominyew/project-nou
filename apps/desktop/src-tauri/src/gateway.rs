//! Approval gateway core (ADR-004). Clients hold a token and can only *propose* changes; a human approves or rejects
//! each one in the app, and the app itself applies it. Nothing in this module writes note content.
use crate::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

pub const SCOPES: [&str; 4] = ["notes:read", "databases:read", "notes:write", "databases:write"];
pub const OPS: [&str; 6] = ["create_page", "append_text", "rename_page", "create_row", "set_value", "add_checklist_item"];
const MAX_PENDING_PER_TOKEN: i64 = 50;
const MAX_PAYLOAD: usize = 60_000;
const EXPIRY: &str = "-7 days";

fn e(error: rusqlite::Error) -> String { error.to_string() }
fn sha256_hex(data: &[u8]) -> String { Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect() }

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TokenInfo { pub id: String, pub name: String, pub scopes: Vec<String>, pub created_at: String, pub last_used_at: Option<String>, pub revoked_at: Option<String> }
/// The secret is returned exactly once, at creation. Only its SHA-256 hash is stored.
#[derive(Serialize, Debug)]
pub struct CreatedToken { pub info: TokenInfo, pub secret: String }
#[derive(Debug, Clone)]
pub struct Verified { pub id: String, pub scopes: Vec<String> }
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Proposal { pub id: String, pub token_id: String, pub token_name: String, pub op: String, pub payload: Value, pub summary: String, pub status: String, pub created_at: String, pub decided_at: Option<String>, pub applied_at: Option<String>, pub result: Option<String> }
#[derive(Serialize, Debug, PartialEq)]
pub struct Proposed { pub id: String, pub existing: bool }
#[derive(Serialize, Debug)]
pub struct AuditEntry { pub id: i64, pub at: String, pub actor: String, pub action: String, pub detail: Value }

pub fn audit(c: &Connection, actor: &str, action: &str, detail: Value) -> Result<(), String> {
    c.execute("INSERT INTO audit_log(actor,action,detail) VALUES(?1,?2,?3)", params![actor, action, detail.to_string()]).map_err(e)?;
    Ok(())
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if n.is_empty() || n.chars().count() > 60 || n.chars().any(char::is_control) { return Err("A token needs a name of 1 to 60 characters".into()); }
    Ok(n)
}

fn token_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TokenInfo> {
    let scopes: String = r.get(2)?;
    Ok(TokenInfo { id: r.get(0)?, name: r.get(1)?, scopes: serde_json::from_str(&scopes).unwrap_or_default(), created_at: r.get(3)?, last_used_at: r.get(4)?, revoked_at: r.get(5)? })
}

pub fn create_token(c: &Connection, name: &str, scopes: &[String]) -> Result<CreatedToken, String> {
    let name = clean_name(name)?;
    if scopes.is_empty() { return Err("Choose at least one scope".into()); }
    let mut chosen: Vec<String> = Vec::new();
    for s in scopes {
        if !SCOPES.contains(&s.as_str()) { return Err(format!("Unknown scope: {s}")); }
        if !chosen.contains(s) { chosen.push(s.clone()); }
    }
    let secret = format!("nou_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let id = Uuid::new_v4().to_string();
    c.execute("INSERT INTO api_tokens(id,name,token_hash,scopes) VALUES(?1,?2,?3,?4)", params![id, name, sha256_hex(secret.as_bytes()), json!(chosen).to_string()]).map_err(e)?;
    audit(c, "owner", "token.created", json!({ "token_id": id, "name": name, "scopes": chosen }))?;
    let info = c.query_row("SELECT id,name,scopes,created_at,last_used_at,revoked_at FROM api_tokens WHERE id=?1", [&id], token_row).map_err(e)?;
    Ok(CreatedToken { info, secret })
}

pub fn list_tokens(c: &Connection) -> Result<Vec<TokenInfo>, String> {
    let mut s = c.prepare("SELECT id,name,scopes,created_at,last_used_at,revoked_at FROM api_tokens ORDER BY created_at DESC,id").map_err(e)?;
    let it = s.query_map([], token_row).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

/// Revoke a token at once and cancel everything it still has pending.
pub fn revoke_token(c: &Connection, id: &str) -> Result<(), String> {
    let n = c.execute("UPDATE api_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND revoked_at IS NULL", [id]).map_err(e)?;
    if n != 1 { return Err("Token not found or already revoked".into()); }
    let cancelled = c.execute("UPDATE proposals SET status='cancelled',decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_id=?1 AND status IN ('pending','approved')", [id]).map_err(e)?;
    audit(c, "owner", "token.revoked", json!({ "token_id": id, "cancelled_proposals": cancelled }))
}

/// Check a presented secret. Revoked or unknown tokens are refused with the same message.
pub fn verify_token(c: &Connection, secret: &str) -> Result<Verified, String> {
    let row: Option<(String, String, Option<String>)> = c.query_row("SELECT id,scopes,revoked_at FROM api_tokens WHERE token_hash=?1", [sha256_hex(secret.as_bytes())], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(e)?;
    match row {
        Some((id, scopes, None)) => {
            c.execute("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1", [&id]).map_err(e)?;
            Ok(Verified { id, scopes: serde_json::from_str(&scopes).unwrap_or_default() })
        }
        _ => Err("Invalid or revoked token".into()),
    }
}

fn scope_for(op: &str) -> &'static str { match op { "create_row" | "set_value" => "databases:write", _ => "notes:write" } }

/// A client asks for a change. This only queues it; it never touches notes.
pub fn propose(c: &Connection, secret: &str, op: &str, payload: &Value, summary: &str) -> Result<Proposed, String> {
    let who = verify_token(c, secret)?;
    if !OPS.contains(&op) { return Err(format!("Unsupported operation: {op}")); }
    if !who.scopes.iter().any(|s| s == scope_for(op)) { return Err(format!("This token lacks the {} scope", scope_for(op))); }
    if !payload.is_object() { return Err("The payload must be a JSON object".into()); }
    let body = payload.to_string();
    if body.len() > MAX_PAYLOAD { return Err("The payload is too large".into()); }
    let summary = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    if summary.is_empty() || summary.chars().count() > 500 || summary.chars().any(char::is_control) { return Err("A summary of 1 to 500 characters is required".into()); }
    let key = sha256_hex(format!("{op}\n{body}").as_bytes());
    // The same pending request from the same token is returned, not duplicated.
    let existing: Option<String> = c.query_row("SELECT id FROM proposals WHERE token_id=?1 AND dedupe_key=?2 AND status='pending'", params![who.id, key], |r| r.get(0)).optional().map_err(e)?;
    if let Some(id) = existing { return Ok(Proposed { id, existing: true }); }
    let pending: i64 = c.query_row("SELECT COUNT(*) FROM proposals WHERE token_id=?1 AND status='pending'", [&who.id], |r| r.get(0)).map_err(e)?;
    if pending >= MAX_PENDING_PER_TOKEN { return Err("Too many pending proposals for this token; approve or reject some first".into()); }
    let id = Uuid::new_v4().to_string();
    c.execute("INSERT INTO proposals(id,token_id,op,payload,summary,dedupe_key) VALUES(?1,?2,?3,?4,?5,?6)", params![id, who.id, op, body, summary, key]).map_err(e)?;
    audit(c, &format!("token:{}", who.id), "proposal.created", json!({ "proposal_id": id, "op": op }))?;
    Ok(Proposed { id, existing: false })
}

fn proposal_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Proposal> {
    let payload: String = r.get(4)?;
    Ok(Proposal { id: r.get(0)?, token_id: r.get(1)?, token_name: r.get(2)?, op: r.get(3)?, payload: serde_json::from_str(&payload).unwrap_or(Value::Null), summary: r.get(5)?, status: r.get(6)?, created_at: r.get(7)?, decided_at: r.get(8)?, applied_at: r.get(9)?, result: r.get(10)? })
}
const PROPOSAL_SELECT: &str = "SELECT p.id,p.token_id,t.name,p.op,p.payload,p.summary,p.status,p.created_at,p.decided_at,p.applied_at,p.result FROM proposals p JOIN api_tokens t ON t.id=p.token_id";

pub fn get_proposal(c: &Connection, id: &str) -> Result<Proposal, String> {
    c.query_row(&format!("{PROPOSAL_SELECT} WHERE p.id=?1"), [id], proposal_row).optional().map_err(e)?.ok_or_else(|| "Proposal not found".to_string())
}

pub fn list_proposals(c: &Connection, status: Option<&str>, limit: u32) -> Result<Vec<Proposal>, String> {
    expire_old(c)?;
    let sql = format!("{PROPOSAL_SELECT} WHERE (?1 IS NULL OR p.status=?1) ORDER BY p.created_at DESC,p.id LIMIT ?2");
    let mut s = c.prepare(&sql).map_err(e)?;
    let it = s.query_map(params![status, limit.clamp(1, 200)], proposal_row).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

/// Pending proposals older than seven days can no longer be approved.
pub fn expire_old(c: &Connection) -> Result<usize, String> {
    let n = c.execute(&format!("UPDATE proposals SET status='expired',decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','{EXPIRY}')"), []).map_err(e)?;
    if n > 0 { audit(c, "system", "proposals.expired", json!({ "count": n }))?; }
    Ok(n)
}

/// The human's decision. A proposal can be decided once, only while pending, and only if its token is still valid.
pub fn decide(c: &Connection, id: &str, approve: bool) -> Result<Proposal, String> {
    expire_old(c)?;
    let current = get_proposal(c, id)?;
    if current.status != "pending" { return Err(format!("This proposal is already {}", current.status)); }
    let revoked: bool = c.query_row("SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=?1", [&current.token_id], |r| r.get(0)).map_err(e)?;
    if revoked { return Err("The token that made this proposal has been revoked".into()); }
    let status = if approve { "approved" } else { "rejected" };
    c.execute("UPDATE proposals SET status=?1,decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2 AND status='pending'", params![status, id]).map_err(e)?;
    audit(c, "owner", if approve { "proposal.approved" } else { "proposal.rejected" }, json!({ "proposal_id": id, "op": current.op }))?;
    get_proposal(c, id)
}

/// Recorded by the app after it tried to apply an approved proposal through the normal editing path.
pub fn mark_applied(c: &Connection, id: &str, ok: bool, result: &str) -> Result<Proposal, String> {
    let current = get_proposal(c, id)?;
    if current.status != "approved" { return Err(format!("Only an approved proposal can be applied (this one is {})", current.status)); }
    let text: String = result.chars().take(4000).collect();
    c.execute("UPDATE proposals SET status=?1,applied_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),result=?2 WHERE id=?3", params![if ok { "applied" } else { "failed" }, text, id]).map_err(e)?;
    audit(c, "app", if ok { "proposal.applied" } else { "proposal.failed" }, json!({ "proposal_id": id, "op": current.op }))?;
    get_proposal(c, id)
}

pub fn recent_audit(c: &Connection, limit: u32) -> Result<Vec<AuditEntry>, String> {
    let mut s = c.prepare("SELECT id,at,actor,action,detail FROM audit_log ORDER BY id DESC LIMIT ?1").map_err(e)?;
    let it = s.query_map([limit.clamp(1, 500)], |r| { let d: String = r.get(4)?; Ok(AuditEntry { id: r.get(0)?, at: r.get(1)?, actor: r.get(2)?, action: r.get(3)?, detail: serde_json::from_str(&d).unwrap_or(Value::Null) }) }).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

// ---- commands used by the app's own UI (the owner). Clients never reach these. ----
#[tauri::command]
pub fn gateway_create_token(db: State<'_, Db>, name: String, scopes: Vec<String>) -> Result<CreatedToken, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; create_token(&c, &name, &scopes)
}
#[tauri::command]
pub fn gateway_list_tokens(db: State<'_, Db>) -> Result<Vec<TokenInfo>, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; list_tokens(&c) }
#[tauri::command]
pub fn gateway_revoke_token(db: State<'_, Db>, id: String) -> Result<(), String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; revoke_token(&c, &id) }
#[tauri::command]
pub fn gateway_list_proposals(db: State<'_, Db>, status: Option<String>, limit: Option<u32>) -> Result<Vec<Proposal>, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; list_proposals(&c, status.as_deref(), limit.unwrap_or(50))
}
#[tauri::command]
pub fn gateway_decide(db: State<'_, Db>, id: String, approve: bool) -> Result<Proposal, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; decide(&c, &id, approve) }
#[tauri::command]
pub fn gateway_mark_applied(db: State<'_, Db>, id: String, ok: bool, result: String) -> Result<Proposal, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; db.writable()?; mark_applied(&c, &id, ok, &result) }
#[tauri::command]
pub fn gateway_audit(db: State<'_, Db>, limit: Option<u32>) -> Result<Vec<AuditEntry>, String> { let c = db.0.lock().map_err(|_| "Database lock poisoned")?; recent_audit(&c, limit.unwrap_or(100)) }

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
    fn token(c: &Connection, scopes: &[&str]) -> CreatedToken { create_token(c, "Claude", &scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap() }
    fn audit_actions(c: &Connection) -> Vec<String> { recent_audit(c, 100).unwrap().into_iter().rev().map(|a| a.action).collect() }

    #[test]
    fn secrets_are_shown_once_and_only_their_hash_is_stored() {
        let c = fresh();
        let t = token(&c, &["notes:read"]);
        assert!(t.secret.starts_with("nou_") && t.secret.len() > 60);
        let stored: String = c.query_row("SELECT token_hash FROM api_tokens WHERE id=?1", [&t.info.id], |r| r.get(0)).unwrap();
        assert_eq!(stored, sha256_hex(t.secret.as_bytes()));
        assert!(!stored.contains(&t.secret));
        let everything = format!("{:?}{:?}", list_tokens(&c).unwrap(), recent_audit(&c, 100).unwrap());
        assert!(!everything.contains(&t.secret), "the secret must never appear in listings or the audit log");
        assert_eq!(verify_token(&c, &t.secret).unwrap().scopes, ["notes:read"]);
        assert!(verify_token(&c, "nou_not-a-real-token").is_err());
    }
    #[test]
    fn token_names_and_scopes_are_validated() {
        let c = fresh();
        assert!(create_token(&c, "  ", &["notes:read".into()]).is_err());
        assert!(create_token(&c, "ok", &[]).is_err());
        assert!(create_token(&c, "ok", &["admin".into()]).is_err());
        assert!(create_token(&c, &"x".repeat(61), &["notes:read".into()]).is_err());
        assert_eq!(create_token(&c, " Grok  bot ", &["notes:read".into(), "notes:read".into()]).unwrap().info.scopes, ["notes:read"]);
    }
    #[test]
    fn proposing_needs_the_right_scope_a_known_operation_and_a_sane_payload() {
        let c = fresh();
        let reader = token(&c, &["notes:read"]);
        assert!(propose(&c, &reader.secret, "create_page", &json!({"title":"x"}), "make a page").is_err(), "read scope cannot even propose writes");
        let writer = token(&c, &["notes:write"]);
        assert!(propose(&c, &writer.secret, "create_page", &json!({"title":"x"}), "make a page").is_ok());
        assert!(propose(&c, &writer.secret, "set_value", &json!({}), "edit a cell").is_err(), "database ops need the databases:write scope");
        assert!(propose(&c, &writer.secret, "drop_everything", &json!({}), "x").is_err());
        assert!(propose(&c, &writer.secret, "create_page", &json!(["not", "an", "object"]), "x").is_err());
        assert!(propose(&c, &writer.secret, "create_page", &json!({"title":"x".repeat(70_000)}), "x").is_err());
        assert!(propose(&c, &writer.secret, "create_page", &json!({"title":"y"}), "  ").is_err());
        assert!(propose(&c, "nou_bogus", "create_page", &json!({"title":"y"}), "x").is_err());
    }
    #[test]
    fn identical_pending_proposals_are_not_duplicated_and_pending_is_capped() {
        let c = fresh();
        let w = token(&c, &["notes:write"]);
        let a = propose(&c, &w.secret, "add_checklist_item", &json!({"text":"Call Sam","page":"p1"}), "Add a to-do").unwrap();
        let b = propose(&c, &w.secret, "add_checklist_item", &json!({"page":"p1","text":"Call Sam"}), "Add a to-do again").unwrap();
        assert!(!a.existing && b.existing && a.id == b.id, "same operation and payload returns the original proposal");
        for i in 0..49 { propose(&c, &w.secret, "create_page", &json!({"title": format!("t{i}")}), "page").unwrap(); }
        assert!(propose(&c, &w.secret, "create_page", &json!({"title":"one too many"}), "page").is_err());
    }
    #[test]
    fn a_proposal_is_decided_once_and_only_applied_after_approval() {
        let c = fresh();
        let w = token(&c, &["notes:write"]);
        let id = propose(&c, &w.secret, "rename_page", &json!({"page":"p","title":"New"}), "Rename a page").unwrap().id;
        assert!(mark_applied(&c, &id, true, "done").is_err(), "cannot apply before approval");
        assert_eq!(decide(&c, &id, true).unwrap().status, "approved");
        assert!(decide(&c, &id, false).is_err(), "no second decision");
        let applied = mark_applied(&c, &id, true, "renamed").unwrap();
        assert_eq!((applied.status.as_str(), applied.result.as_deref()), ("applied", Some("renamed")));
        assert!(mark_applied(&c, &id, true, "again").is_err(), "cannot apply twice");
        let rejected = propose(&c, &w.secret, "create_page", &json!({"title":"no"}), "Make a page").unwrap().id;
        assert_eq!(decide(&c, &rejected, false).unwrap().status, "rejected");
        assert!(mark_applied(&c, &rejected, true, "x").is_err(), "a rejected proposal can never be applied");
        assert_eq!(audit_actions(&c), ["token.created", "proposal.created", "proposal.approved", "proposal.applied", "proposal.created", "proposal.rejected"]);
    }
    #[test]
    fn revoking_a_token_blocks_it_and_cancels_its_open_proposals() {
        let c = fresh();
        let w = token(&c, &["notes:write"]);
        let pending = propose(&c, &w.secret, "create_page", &json!({"title":"a"}), "p").unwrap().id;
        let approved = propose(&c, &w.secret, "create_page", &json!({"title":"b"}), "p").unwrap().id;
        decide(&c, &approved, true).unwrap();
        revoke_token(&c, &w.info.id).unwrap();
        assert!(verify_token(&c, &w.secret).is_err());
        assert!(propose(&c, &w.secret, "create_page", &json!({"title":"c"}), "p").is_err());
        assert_eq!(get_proposal(&c, &pending).unwrap().status, "cancelled");
        assert_eq!(get_proposal(&c, &approved).unwrap().status, "cancelled", "an approved but not yet applied change is cancelled too");
        assert!(decide(&c, &pending, true).is_err());
        assert!(revoke_token(&c, &w.info.id).is_err(), "revoking twice is refused");
    }
    #[test]
    fn old_pending_proposals_expire_and_cannot_be_approved() {
        let c = fresh();
        let w = token(&c, &["notes:write"]);
        let id = propose(&c, &w.secret, "create_page", &json!({"title":"old"}), "p").unwrap().id;
        c.execute("UPDATE proposals SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?1", [&id]).unwrap();
        assert!(decide(&c, &id, true).is_err());
        assert_eq!(get_proposal(&c, &id).unwrap().status, "expired");
        assert!(audit_actions(&c).contains(&"proposals.expired".to_string()));
        assert_eq!(list_proposals(&c, Some("pending"), 10).unwrap().len(), 0);
    }
    #[test]
    fn the_audit_log_cannot_be_edited_or_erased() {
        let c = fresh();
        token(&c, &["notes:read"]);
        assert!(c.execute("UPDATE audit_log SET action='x'", []).is_err());
        assert!(c.execute("DELETE FROM audit_log", []).is_err());
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
        // a token with history cannot be deleted out from under its proposals
        let w = token(&c, &["notes:write"]);
        propose(&c, &w.secret, "create_page", &json!({"title":"a"}), "p").unwrap();
        assert!(c.execute("DELETE FROM api_tokens WHERE id=?1", [&w.info.id]).is_err());
    }
}
