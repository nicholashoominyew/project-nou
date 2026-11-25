//! Auto-approval of low-risk proposals (docs/development/AUTO-APPROVE.md).
//!
//! The only way a proposal becomes approved without the owner's tap is `on_proposed`, which `gateway::propose` calls, and the app applies
//! one only after `claim` has checked the same rules again. Nothing here writes note content, and nothing here is reachable from the
//! local API or MCP: rules and switches are changed only by the Tauri commands at the bottom, which the app's own screens call.
//!
//! Never auto-approved, whatever the rules say: any operation outside `AUTO_OPS`; locked, system or trashed pages; anything that would
//! replace content (a cell that already holds a value, a rename of a page the same bot did not create or that has changed since);
//! relation cells (they write to other rows too).
use crate::{gateway, Db};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::State;
use uuid::Uuid;

pub const AUTO_OPS: [&str; 6] = ["create_page", "append_text", "add_checklist_item", "create_row", "set_value", "rename_page"];
/// An apply that was started but never reported back (NOU closed midway) is recorded as failed after this long, never run twice.
const STALE_CLAIM: &str = "-2 minutes";
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

fn e(error: rusqlite::Error) -> String { error.to_string() }

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Rule {
    #[serde(default)] pub id: String,
    pub name: String,
    /// None means any page.
    pub page_id: Option<String>,
    pub include_subtree: bool,
    pub ops: Vec<String>,
    /// The name of the token that must have asked; None means any.
    pub source: Option<String>,
    pub enabled: bool,
    pub per_hour: i64,
}
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Switches { pub feature_on: bool, pub paused: bool }

// ---- looking at pages (only what is stored; nothing the client says about positions is used) ----
/// A live, ordinary page of the personal workspace: not trashed, not a system page, not locked.
fn usable(c: &Connection, id: &str) -> bool {
    c.query_row("SELECT EXISTS(SELECT 1 FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL AND system_key IS NULL)", [id], |r| r.get::<_, bool>(0)).unwrap_or(false)
        && !crate::locks::is_locked(c, id).unwrap_or(true)
}
/// The page and then each page above it.
fn chain(c: &Connection, id: &str) -> Vec<String> {
    let mut out = vec![id.to_string()];
    while out.len() < 200 {
        let parent: Option<String> = c.query_row("SELECT parent_id FROM pages WHERE id=?1", [out.last().unwrap()], |r| r.get(0)).optional().ok().flatten().flatten();
        match parent { Some(p) if !out.contains(&p) => out.push(p), _ => break }
    }
    out
}
fn title_and_body(c: &Connection, id: &str) -> Option<(String, String)> {
    c.query_row("SELECT p.title,COALESCE((SELECT body FROM page_search WHERE page_id=p.id),'') FROM pages p WHERE p.id=?1 AND p.deleted_at IS NULL", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten()
}
fn title(c: &Connection, id: &str) -> String { title_and_body(c, id).map(|t| t.0).unwrap_or_else(|| "a page".into()) }
fn short(s: &str) -> String { let t: String = s.split_whitespace().collect::<Vec<_>>().join(" "); if t.chars().count() > 80 { t.chars().take(80).collect::<String>() + "…" } else { t } }

/// The page is one this bot made, and nobody else has changed it since.
fn clean_bot_page(c: &Connection, page: &str, source: &str) -> bool {
    let Some((t, b)) = title_and_body(c, page) else { return false };
    c.query_row("SELECT EXISTS(SELECT 1 FROM auto_bot_pages WHERE page_id=?1 AND source=?2 AND title=?3 AND body=?4)", params![page, source, t, b], |r| r.get(0)).unwrap_or(false)
}
fn remember_bot_page(c: &Connection, page: &str, source: &str) -> Result<(), String> {
    let Some((t, b)) = title_and_body(c, page) else { return Ok(()) };
    c.execute("INSERT INTO auto_bot_pages(page_id,source,title,body) VALUES(?1,?2,?3,?4) ON CONFLICT(page_id) DO UPDATE SET source=excluded.source,title=excluded.title,body=excluded.body", params![page, source, t, b]).map_err(e)?;
    Ok(())
}

/// A property of this database that a bot may fill without a tap: it exists, is not computed, and is not a relation.
fn plain_property(c: &Connection, database: &str, property: &str) -> bool {
    c.query_row("SELECT EXISTS(SELECT 1 FROM db_properties WHERE id=?1 AND database_id=?2 AND deleted_at IS NULL AND type NOT IN ('relation','rollup','created_time','last_edited_time'))", params![property, database], |r| r.get(0)).unwrap_or(false)
}

/// Where an eligible request would land.
struct Target {
    /// The page rules are matched against (its ancestors count for subtree rules). None is the top level.
    position: Option<String>,
    /// Pages a rule without "include subpages" may name exactly.
    exact: Vec<String>,
    /// The existing page that would change (None for a new page or row).
    page: Option<String>,
    text: String,
}

/// None means "never without the owner": the request goes to the manual queue.
fn target(c: &Connection, op: &str, d: &Value, source: &str) -> Option<Target> {
    let id = |k: &str| d.get(k).and_then(Value::as_str).filter(|v| !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    let text = |k: &str, max: usize| d.get(k).and_then(Value::as_str).filter(|v| !v.trim().is_empty() && v.chars().count() <= max);
    let on = |page: &str, text: String| Target { position: Some(page.to_string()), exact: vec![page.to_string()], page: Some(page.to_string()), text };
    match op {
        "create_page" => {
            let name = text("title", 200)?;
            match d.get("parent") {
                None | Some(Value::Null) => Some(Target { position: None, exact: vec![], page: None, text: format!("Create the page “{}” at the top level", short(name)) }),
                Some(_) => { let parent = id("parent")?; if !usable(c, parent) { return None; }
                    Some(Target { position: Some(parent.into()), exact: vec![parent.into()], page: None, text: format!("Create the page “{}” under “{}”", short(name), title(c, parent)) }) }
            }
        }
        "rename_page" => {
            let (page, name) = (id("page")?, text("title", 200)?);
            if !usable(c, page) || !clean_bot_page(c, page, source) { return None; }
            Some(on(page, format!("Rename “{}” to “{}”", title(c, page), short(name))))
        }
        "append_text" | "add_checklist_item" => {
            let page = id("page")?;
            let words = text("text", if op == "append_text" { 20_000 } else { 500 })?;
            let rich: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM note_formats WHERE page_id=?1)", [page], |r| r.get(0)).unwrap_or(false);
            if !usable(c, page) || !rich { return None; }
            Some(on(page, format!("{} “{}”: {}", if op == "append_text" { "Add text to" } else { "Add a to-do to" }, title(c, page), short(words))))
        }
        "create_row" => {
            let database = id("database")?;
            let is_database: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM databases WHERE page_id=?1)", [database], |r| r.get(0)).unwrap_or(false);
            if !usable(c, database) || !is_database { return None; }
            match d.get("values") { None => {}, Some(Value::Object(v)) => if !v.keys().all(|p| plain_property(c, database, p)) { return None }, _ => return None }
            let name = match d.get("title") { None => "Untitled", Some(_) => text("title", 200)? };
            Some(Target { position: Some(database.into()), exact: vec![database.into()], page: None, text: format!("Add the row “{}” to “{}”", short(name), title(c, database)) })
        }
        "set_value" => {
            let (row, property) = (id("row")?, id("property")?);
            let value = d.get("value").filter(|v| !v.is_null())?;
            let database: String = c.query_row("SELECT database_id FROM db_rows WHERE page_id=?1", [row], |r| r.get(0)).optional().ok().flatten()?;
            if !usable(c, row) || !usable(c, &database) || !plain_property(c, &database, property) { return None; }
            // Only an empty cell: anything already there would be overwritten.
            let filled: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM db_values WHERE row_id=?1 AND property_id=?2)", params![row, property], |r| r.get(0)).unwrap_or(true);
            if filled { return None; }
            let column: String = c.query_row("SELECT name FROM db_properties WHERE id=?1", [property], |r| r.get(0)).ok()?;
            let mut t = on(row, format!("Fill the empty “{}” of “{}” with {}", column, title(c, row), short(&value.to_string())));
            t.exact.push(database);
            Some(t)
        }
        _ => None,
    }
}

fn covers(c: &Connection, rule: &Rule, op: &str, source: &str, t: &Target) -> bool {
    if !rule.enabled || !rule.ops.iter().any(|o| o == op) || rule.source.as_deref().is_some_and(|s| s != source) { return false; }
    let Some(page) = rule.page_id.as_deref() else { return true };
    if rule.include_subtree { t.position.as_deref().is_some_and(|p| chain(c, p).iter().any(|x| x == page)) } else { t.exact.iter().any(|x| x == page) }
}

pub fn switches(c: &Connection) -> Result<Switches, String> {
    c.query_row("SELECT feature_on,paused FROM auto_state WHERE id=1", [], |r| Ok(Switches { feature_on: r.get(0)?, paused: r.get(1)? })).map_err(e)
}

pub fn rules(c: &Connection) -> Result<Vec<Rule>, String> {
    let mut s = c.prepare("SELECT id,name,page_id,include_subtree,ops,source,enabled,per_hour FROM auto_rules ORDER BY created_at,id").map_err(e)?;
    let it = s.query_map([], |r| { let ops: String = r.get(4)?; Ok(Rule { id: r.get(0)?, name: r.get(1)?, page_id: r.get(2)?, include_subtree: r.get(3)?, ops: serde_json::from_str(&ops).unwrap_or_default(), source: r.get(5)?, enabled: r.get(6)?, per_hour: r.get(7)? }) }).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

fn used_last_hour(c: &Connection, rule: &str) -> i64 {
    c.query_row("SELECT COUNT(*) FROM auto_log WHERE rule_id=?1 AND approved_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')", [rule], |r| r.get(0)).unwrap_or(i64::MAX)
}

/// Called by `gateway::propose` for a request it has just stored as pending. True when a rule approved it. Any doubt leaves it pending.
pub fn on_proposed(c: &Connection, proposal: &str, source: &str, op: &str, payload: &Value) -> Result<bool, String> {
    let s = switches(c)?;
    if !s.feature_on || s.paused || !AUTO_OPS.contains(&op) { return Ok(false); }
    let Some(t) = target(c, op, payload, source) else { return Ok(false) };
    let Some(rule) = rules(c)?.into_iter().find(|r| covers(c, r, op, source, &t) && used_last_hour(c, &r.id) < r.per_hour) else { return Ok(false) };
    c.execute(&format!("UPDATE proposals SET status='approved',decided_at={NOW} WHERE id=?1 AND status='pending'"), [proposal]).map_err(e)?;
    c.execute("INSERT INTO auto_log(proposal_id,rule_id,rule_name,source,op,page_id,change_text) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![proposal, rule.id, rule.name, source, op, t.page, t.text]).map_err(e)?;
    gateway::audit(c, "system", "proposal.auto_approved", json!({ "proposal_id": proposal, "op": op, "rule_id": rule.id }))?;
    Ok(true)
}

pub fn is_auto(c: &Connection, proposal: &str) -> bool {
    c.query_row("SELECT EXISTS(SELECT 1 FROM auto_log WHERE proposal_id=?1)", [proposal], |r| r.get(0)).unwrap_or(false)
}

/// Back to the manual queue, as if no rule had matched.
fn withdraw(c: &Connection, proposal: &str, why: &str) -> Result<(), String> {
    c.execute("UPDATE proposals SET status='pending',decided_at=NULL WHERE id=?1 AND status='approved'", [proposal]).map_err(e)?;
    c.execute("DELETE FROM auto_log WHERE proposal_id=?1 AND claimed_at IS NULL", [proposal]).map_err(e)?;
    gateway::audit(c, "system", "proposal.auto_withdrawn", json!({ "proposal_id": proposal, "why": why }))
}

fn unclaimed(c: &Connection) -> Result<Vec<String>, String> {
    let mut s = c.prepare("SELECT l.proposal_id FROM auto_log l JOIN proposals p ON p.id=l.proposal_id WHERE p.status='approved' AND l.claimed_at IS NULL ORDER BY l.approved_at,l.rowid").map_err(e)?;
    let it = s.query_map([], |r| r.get(0)).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

/// Change the switches. Turning the feature off or pausing returns everything not yet being applied to the manual queue at once.
pub fn set_switches(c: &Connection, feature_on: bool, paused: bool) -> Result<Switches, String> {
    let before = switches(c)?;
    c.execute("UPDATE auto_state SET feature_on=?1,paused=?2 WHERE id=1", params![feature_on, paused]).map_err(e)?;
    if before.feature_on != feature_on { gateway::audit(c, "owner", if feature_on { "auto.enabled" } else { "auto.disabled" }, json!({}))?; }
    if before.paused != paused { gateway::audit(c, "owner", if paused { "auto.paused" } else { "auto.resumed" }, json!({}))?; }
    if !feature_on || paused { for id in unclaimed(c)? { withdraw(c, &id, "switched off")?; } }
    switches(c)
}

pub fn save_rule(c: &Connection, mut rule: Rule) -> Result<Rule, String> {
    rule.name = rule.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if rule.name.is_empty() || rule.name.chars().count() > 60 { return Err("Give the rule a name of 1 to 60 characters".into()); }
    let chosen: Vec<String> = AUTO_OPS.iter().filter(|o| rule.ops.iter().any(|x| x == *o)).map(|o| o.to_string()).collect();
    if chosen.is_empty() || rule.ops.iter().any(|o| !AUTO_OPS.contains(&o.as_str())) { return Err("Tick at least one kind of change. Only the six page changes can be automatic.".into()); }
    rule.ops = chosen;
    if let Some(p) = &rule.page_id { if !usable(c, p) { return Err("Choose a page that exists and is not locked".into()); } }
    if rule.source.as_ref().is_some_and(|s| s.is_empty() || s.chars().count() > 60) { return Err("Choose which bot the rule is for".into()); }
    if !(1..=1000).contains(&rule.per_hour) { return Err("The limit must be 1 to 1000 changes an hour".into()); }
    let new = rule.id.is_empty();
    if new { rule.id = Uuid::new_v4().to_string(); }
    let ops = json!(rule.ops).to_string();
    let values = params![rule.id, rule.name, rule.page_id, rule.include_subtree, ops, rule.source, rule.enabled, rule.per_hour];
    if new { c.execute("INSERT INTO auto_rules(id,name,page_id,include_subtree,ops,source,enabled,per_hour) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", values).map_err(e)?; }
    else if c.execute("UPDATE auto_rules SET name=?2,page_id=?3,include_subtree=?4,ops=?5,source=?6,enabled=?7,per_hour=?8 WHERE id=?1", values).map_err(e)? != 1 { return Err("That rule no longer exists".into()); }
    gateway::audit(c, "owner", if new { "auto.rule_added" } else { "auto.rule_changed" }, serde_json::to_value(&rule).unwrap_or(Value::Null))?;
    Ok(rule)
}

pub fn delete_rule(c: &Connection, id: &str) -> Result<(), String> {
    if c.execute("DELETE FROM auto_rules WHERE id=?1", [id]).map_err(e)? != 1 { return Err("That rule no longer exists".into()); }
    gateway::audit(c, "owner", "auto.rule_deleted", json!({ "rule_id": id }))
}

/// What the app should apply now. Also closes applies that never reported back.
pub fn pending(c: &Connection) -> Result<Vec<String>, String> {
    let stale: Vec<String> = {
        let mut s = c.prepare(&format!("SELECT l.proposal_id FROM auto_log l JOIN proposals p ON p.id=l.proposal_id WHERE p.status='approved' AND l.claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','{STALE_CLAIM}')")).map_err(e)?;
        let it = s.query_map([], |r| r.get(0)).map_err(e)?;
        it.collect::<rusqlite::Result<_>>().map_err(e)?
    };
    for id in stale { gateway::mark_applied(c, &id, false, "NOU closed while applying this. Check the page: it may or may not have been changed.")?; }
    unclaimed(c)
}

/// The last check, immediately before the app writes. Returns the proposal only if the switches, the rule, the token and the page
/// still allow it; otherwise it goes back to the manual queue. A proposal can be claimed once.
pub fn claim(c: &Connection, proposal: &str) -> Result<Option<gateway::Proposal>, String> {
    if !unclaimed(c)?.iter().any(|x| x == proposal) { return Ok(None); }
    let p = gateway::get_proposal(c, proposal)?;
    let (rule_id, source): (String, String) = c.query_row("SELECT rule_id,source FROM auto_log WHERE proposal_id=?1", [proposal], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
    let s = switches(c)?;
    let revoked: bool = c.query_row("SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=?1", [&p.token_id], |r| r.get(0)).map_err(e)?;
    let still = s.feature_on && !s.paused && !revoked
        && target(c, &p.op, &p.payload, &source).is_some_and(|t| rules(c).unwrap_or_default().iter().any(|r| r.id == rule_id && covers(c, r, &p.op, &source, &t)));
    if !still { withdraw(c, proposal, "no longer allowed when it was about to be applied")?; return Ok(None); }
    // What undo will need, read before anything changes.
    let page = p.payload.get("page").and_then(Value::as_str).unwrap_or("");
    let before = json!({ "title": if p.op == "rename_page" { Some(title(c, page)) } else { None }, "bot_page": clean_bot_page(c, page, &source) });
    c.execute(&format!("UPDATE auto_log SET claimed_at={NOW},undo=?2 WHERE proposal_id=?1"), params![proposal, json!({ "before": before }).to_string()]).map_err(e)?;
    Ok(Some(p))
}

/// After a proposal was applied by the app (manually or automatically): a page a bot created is remembered as that bot's.
pub fn note_created(c: &Connection, p: &gateway::Proposal, result: &str) -> Result<(), String> {
    if p.op != "create_page" { return Ok(()); }
    let Some(page) = result.strip_prefix("Created page ").map(str::trim) else { return Ok(()) };
    remember_bot_page(c, page, &p.token_name)
}

/// The app reports an automatic apply. `after` holds what undo needs: `page` (a created page or row) or `blocks` (added blocks and their text).
pub fn applied(c: &Connection, proposal: &str, ok: bool, result: &str, after: &Value) -> Result<(), String> {
    let (source, op, page, undo): (String, String, Option<String>, String) = c.query_row("SELECT source,op,page_id,undo FROM auto_log WHERE proposal_id=?1 AND claimed_at IS NOT NULL", [proposal], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|_| "This automatic change was not started".to_string())?;
    gateway::mark_applied(c, proposal, ok, result)?;
    let mut undo: Map<String, Value> = serde_json::from_str(&undo).unwrap_or_default();
    if let Value::Object(more) = after { undo.extend(more.clone()); }
    let made = after.get("page").and_then(Value::as_str).filter(|p| title_and_body(c, p).is_some()).map(str::to_string);
    let page = page.or(made);
    if ok {
        c.execute(&format!("UPDATE auto_log SET applied_at={NOW},undo=?2,page_id=?3 WHERE proposal_id=?1"), params![proposal, Value::Object(undo.clone()).to_string(), page]).map_err(e)?;
        // The bot's own change keeps its page "its own"; anyone else's change before it does not get adopted.
        let was_bots = undo.get("before").and_then(|b| b.get("bot_page")).and_then(Value::as_bool) == Some(true);
        if let Some(p) = &page { if was_bots && matches!(op.as_str(), "rename_page" | "append_text" | "add_checklist_item") { remember_bot_page(c, p, &source)?; } }
    }
    Ok(())
}

/// How to take a change back, or why it cannot be taken back safely. Nothing is changed here.
pub fn undo_plan(c: &Connection, proposal: &str) -> Result<Value, String> {
    let (op, page, undo, done): (String, Option<String>, String, bool) = c.query_row("SELECT op,page_id,undo,applied_at IS NOT NULL AND undone_at IS NULL FROM auto_log WHERE proposal_id=?1", [proposal], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|_| "That change is not in the list".to_string())?;
    if !done { return Err("This change was not made, or was already undone".into()); }
    let p = gateway::get_proposal(c, proposal)?;
    let undo: Value = serde_json::from_str(&undo).unwrap_or(Value::Null);
    let page = page.ok_or("There is nothing recorded to undo")?;
    let changed = "You or someone else changed it since, so it was left as it is.";
    let (now_title, body) = title_and_body(c, &page).ok_or("The page is already gone (it may be in Trash)")?;
    if crate::locks::is_locked(c, &page)? { return Err("The page is locked now".into()); }
    let wanted = p.payload.get("title").and_then(Value::as_str).map(str::trim);
    match op.as_str() {
        "create_page" | "create_row" => {
            let children: i64 = c.query_row("SELECT COUNT(*) FROM pages WHERE parent_id=?1 AND deleted_at IS NULL", [&page], |r| r.get(0)).map_err(e)?;
            if now_title != wanted.unwrap_or("Untitled") || !body.trim().is_empty() || children > 0 { return Err(format!("It has content now. {changed} Move it to Trash yourself if you want it gone.")); }
            let mut s = c.prepare("SELECT property_id,value FROM db_values WHERE row_id=?1").map_err(e)?;
            let cells: Vec<(String, String)> = s.query_map([&page], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<rusqlite::Result<_>>().map_err(e)?;
            if cells.iter().any(|(k, v)| p.payload.get("values").and_then(|m| m.get(k)) != serde_json::from_str::<Value>(v).ok().as_ref()) { return Err(changed.into()); }
            Ok(json!({ "kind": "trash", "page": page }))
        }
        "rename_page" => {
            if Some(now_title.as_str()) != wanted { return Err(changed.into()); }
            let old = undo.get("before").and_then(|b| b.get("title")).and_then(Value::as_str).ok_or("The old title was not recorded")?;
            Ok(json!({ "kind": "rename", "page": page, "title": old }))
        }
        "set_value" => {
            let property = p.payload.get("property").and_then(Value::as_str).unwrap_or("");
            let now: Option<String> = c.query_row("SELECT value FROM db_values WHERE row_id=?1 AND property_id=?2", params![page, property], |r| r.get(0)).optional().map_err(e)?;
            if now.and_then(|v| serde_json::from_str::<Value>(&v).ok()).as_ref() != p.payload.get("value") { return Err(changed.into()); }
            Ok(json!({ "kind": "clear", "row": page, "property": property }))
        }
        _ => match undo.get("blocks") {
            Some(Value::Array(blocks)) if !blocks.is_empty() => Ok(json!({ "kind": "blocks", "page": page, "blocks": blocks })),
            _ => Err("Nothing was added, so there is nothing to undo".into()),
        },
    }
}

/// Recorded after the app has taken the change back.
pub fn undone(c: &Connection, proposal: &str) -> Result<(), String> {
    if c.execute(&format!("UPDATE auto_log SET undone_at={NOW},seen=1 WHERE proposal_id=?1 AND applied_at IS NOT NULL AND undone_at IS NULL"), [proposal]).map_err(e)? != 1 { return Err("This change was already undone".into()); }
    gateway::audit(c, "owner", "proposal.undone", json!({ "proposal_id": proposal }))
}

#[derive(Serialize, Debug)]
pub struct Recent { pub proposal_id: String, pub at: String, pub source: String, pub op: String, pub rule_name: String, pub page_id: Option<String>, pub page_title: Option<String>, pub change_text: String, pub summary: String, pub status: String, pub result: Option<String>, pub undone_at: Option<String>, pub seen: bool }
pub fn recent(c: &Connection, limit: u32) -> Result<Vec<Recent>, String> {
    let mut s = c.prepare("SELECT l.proposal_id,l.approved_at,l.source,l.op,l.rule_name,l.page_id,(SELECT title FROM pages WHERE id=l.page_id AND deleted_at IS NULL),l.change_text,p.summary,p.status,p.result,l.undone_at,l.seen FROM auto_log l JOIN proposals p ON p.id=l.proposal_id ORDER BY l.approved_at DESC,l.rowid DESC LIMIT ?1").map_err(e)?;
    let it = s.query_map([limit.clamp(1, 200)], |r| Ok(Recent { proposal_id: r.get(0)?, at: r.get(1)?, source: r.get(2)?, op: r.get(3)?, rule_name: r.get(4)?, page_id: r.get(5)?, page_title: r.get(6)?, change_text: r.get(7)?, summary: r.get(8)?, status: r.get(9)?, result: r.get(10)?, undone_at: r.get(11)?, seen: r.get(12)? })).map_err(e)?;
    it.collect::<rusqlite::Result<_>>().map_err(e)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Unseen { pub count: i64, pub pages: Vec<String> }
/// Changes made automatically that the owner has not looked at: how many, and which pages carry a badge.
pub fn unseen(c: &Connection) -> Result<Unseen, String> {
    let count = c.query_row("SELECT COUNT(*) FROM auto_log WHERE seen=0 AND applied_at IS NOT NULL", [], |r| r.get(0)).map_err(e)?;
    let mut s = c.prepare("SELECT DISTINCT l.page_id FROM auto_log l JOIN pages p ON p.id=l.page_id WHERE l.seen=0 AND l.applied_at IS NOT NULL AND p.deleted_at IS NULL").map_err(e)?;
    let pages = s.query_map([], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<_>>().map_err(e)?;
    Ok(Unseen { count, pages })
}
/// Opening a page clears its badge; opening the list clears them all.
pub fn mark_seen(c: &Connection, page: Option<&str>) -> Result<(), String> {
    c.execute("UPDATE auto_log SET seen=1 WHERE applied_at IS NOT NULL AND (?1 IS NULL OR page_id=?1)", [page]).map_err(e)?;
    Ok(())
}

#[derive(Serialize)]
pub struct Overview { pub feature_on: bool, pub paused: bool, pub rules: Vec<Rule>, pub sources: Vec<String> }
pub fn overview(c: &Connection) -> Result<Overview, String> {
    let s = switches(c)?;
    let mut q = c.prepare("SELECT DISTINCT name FROM api_tokens WHERE revoked_at IS NULL ORDER BY name COLLATE NOCASE").map_err(e)?;
    let sources = q.query_map([], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<_>>().map_err(e)?;
    Ok(Overview { feature_on: s.feature_on, paused: s.paused, rules: rules(c)?, sources })
}

// ---- commands used by the app's own screens (the owner). Clients never reach these. ----
fn with<T>(db: &State<'_, Db>, write: bool, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let c = db.0.lock().map_err(|_| "Database lock poisoned")?;
    if write { db.writable()?; }
    f(&c)
}
#[tauri::command] pub fn auto_overview(db: State<'_, Db>) -> Result<Overview, String> { with(&db, false, overview) }
#[tauri::command] pub fn auto_set_switches(db: State<'_, Db>, feature_on: bool, paused: bool) -> Result<Switches, String> { with(&db, true, |c| set_switches(c, feature_on, paused)) }
#[tauri::command] pub fn auto_rule_save(db: State<'_, Db>, rule: Rule) -> Result<Rule, String> { with(&db, true, |c| save_rule(c, rule)) }
#[tauri::command] pub fn auto_rule_delete(db: State<'_, Db>, id: String) -> Result<(), String> { with(&db, true, |c| delete_rule(c, &id)) }
#[tauri::command] pub fn auto_pending(db: State<'_, Db>) -> Result<Vec<String>, String> { with(&db, true, pending) }
#[tauri::command] pub fn auto_claim(db: State<'_, Db>, id: String) -> Result<Option<gateway::Proposal>, String> { with(&db, true, |c| claim(c, &id)) }
#[tauri::command] pub fn auto_applied(db: State<'_, Db>, id: String, ok: bool, result: String, after: Value) -> Result<(), String> { with(&db, true, |c| applied(c, &id, ok, &result, &after)) }
#[tauri::command] pub fn auto_undo_plan(db: State<'_, Db>, id: String) -> Result<Value, String> { with(&db, true, |c| undo_plan(c, &id)) }
#[tauri::command] pub fn auto_undone(db: State<'_, Db>, id: String) -> Result<(), String> { with(&db, true, |c| undone(c, &id)) }
#[tauri::command] pub fn auto_recent(db: State<'_, Db>, limit: Option<u32>) -> Result<Vec<Recent>, String> { with(&db, false, |c| recent(c, limit.unwrap_or(50))) }
#[tauri::command] pub fn auto_unseen(db: State<'_, Db>) -> Result<Unseen, String> { with(&db, false, unseen) }
#[tauri::command] pub fn auto_seen(db: State<'_, Db>, page_id: Option<String>) -> Result<(), String> { with(&db, true, |c| mark_seen(c, page_id.as_deref())) }

#[cfg(test)]
#[path = "auto_tests.rs"]
mod tests;
