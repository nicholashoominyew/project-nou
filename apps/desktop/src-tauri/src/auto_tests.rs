use super::*;
use crate::gateway::{create_token, decide, get_proposal, list_proposals, mark_applied, propose, recent_audit, revoke_token};

const SIX: [&str; 6] = AUTO_OPS;

fn fresh() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
    c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
    crate::editor::upgrade(&c).unwrap();
    // Bots / Inbox / Daily, and a page outside.
    for (id, parent, title) in [("bots", None, "Bots"), ("inbox", Some("bots"), "Inbox"), ("daily", Some("inbox"), "Daily"), ("other", None, "Other")] { page(&c, id, parent, title); }
    c
}
fn page(c: &Connection, id: &str, parent: Option<&str>, title: &str) {
    let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
    c.execute("INSERT INTO pages(id,workspace_id,parent_id,title,sort_key) VALUES(?1,'personal',?2,?3,?4)", params![id, parent, title, format!("t{n:04}")]).unwrap();
    c.execute("INSERT INTO note_formats(page_id,format,legacy_text) VALUES(?1,'blocknote-v1','')", [id]).unwrap();
    c.execute("INSERT INTO page_search(page_id,title,body) VALUES(?1,?2,'')", params![id, title]).unwrap();
}
fn database(c: &Connection) {
    page(c, "db", Some("inbox"), "Results");
    c.execute("INSERT INTO databases(page_id) VALUES('db')", []).unwrap();
    for (id, name, kind) in [("score", "Score", "number"), ("rel", "Linked", "relation")] { c.execute("INSERT INTO db_properties(id,database_id,name,type,position) VALUES(?1,'db',?2,?3,0)", params![id, name, kind]).unwrap(); }
    page(c, "row1", Some("db"), "Monday");
    c.execute("INSERT INTO db_rows(page_id,database_id) VALUES('row1','db')", []).unwrap();
}
fn bot(c: &Connection, name: &str) -> String {
    create_token(c, name, &["notes:write".into(), "databases:write".into(), "timetable:write".into(), "home:write".into(), "notes:read".into()]).unwrap().secret
}
fn rule(c: &Connection, page: Option<&str>, ops: &[&str], source: Option<&str>) -> Rule {
    save_rule(c, Rule { id: String::new(), name: "Inbox rule".into(), page_id: page.map(Into::into), include_subtree: true, ops: ops.iter().map(|o| o.to_string()).collect(), source: source.map(Into::into), enabled: true, per_hour: 100 }).unwrap()
}
fn on(c: &Connection) { set_switches(c, true, false).unwrap(); }
fn ask(c: &Connection, secret: &str, op: &str, payload: Value) -> (String, bool) {
    let p = propose(c, secret, op, &payload, "please").unwrap();
    (p.id, p.auto)
}
fn append(c: &Connection, s: &str, page: &str, text: &str) -> (String, bool) { ask(c, s, "append_text", json!({ "page": page, "text": text })) }
fn status(c: &Connection, id: &str) -> String { get_proposal(c, id).unwrap().status }

#[test]
fn the_schema_19_step_keeps_the_automatic_history() {
    let c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
    c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
    for sql in [include_str!("../../../../db/notes/002_editor_formats.sql"), include_str!("../../../../db/notes/003_page_icons.sql"), include_str!("../../../../db/notes/004_databases.sql"),
        include_str!("../../../../db/notes/005_page_links.sql"), include_str!("../../../../db/notes/006_gateway.sql"), include_str!("../../../../db/notes/007_linked_todos.sql"), include_str!("../../../../db/notes/008_page_locks.sql"),
        include_str!("../../../../db/notes/009_bot_chat.sql"), include_str!("../../../../db/notes/010_life_timetable.sql"), include_str!("../../../../db/notes/011_timetable_variants.sql"), include_str!("../../../../db/notes/012_bots_hub.sql"),
        include_str!("../../../../db/notes/013_chart_views.sql"), include_str!("../../../../db/notes/014_inhouse_chats.sql"), include_str!("../../../../db/notes/015_proposal_ops.sql"), include_str!("../../../../db/notes/016_habits.sql"),
        include_str!("../../../../db/notes/017_habit_activities.sql"), include_str!("../../../../db/notes/018_auto_approve.sql")] { c.execute_batch(sql).unwrap(); }
    c.execute("INSERT INTO api_tokens(id,name,token_hash,scopes) VALUES('t','Claude',?1,'[]')", ["a".repeat(64)]).unwrap();
    c.execute("INSERT INTO proposals(id,token_id,op,payload,summary,dedupe_key,status) VALUES('p','t','append_text','{}','s',?1,'applied')", ["b".repeat(64)]).unwrap();
    c.execute("INSERT INTO auto_log(proposal_id,rule_id,rule_name,source,op,change_text) VALUES('p','r','Rule','Claude','append_text','Add text')", []).unwrap();
    c.execute_batch(include_str!("../../../../db/notes/019_transcript_requests.sql")).unwrap();
    let kept: i64 = c.query_row("SELECT COUNT(*) FROM auto_log l JOIN proposals p ON p.id=l.proposal_id", [], |r| r.get(0)).unwrap();
    assert_eq!(kept, 1);
    assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    c.execute("DELETE FROM proposals WHERE id='p'", []).unwrap();
    assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM auto_log", [], |r| r.get(0)).unwrap(), 0, "the link to proposals still works");
}

#[test]
fn nothing_is_automatic_until_the_feature_is_on_and_a_rule_exists() {
    let c = fresh(); let s = bot(&c, "Claude");
    assert_eq!(switches(&c).unwrap(), Switches { feature_on: false, paused: false });
    assert!(!append(&c, &s, "inbox", "a").1, "off by default");
    rule(&c, None, &SIX, None);
    assert!(!append(&c, &s, "inbox", "b").1, "a rule alone does nothing while the feature is off");
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    assert!(!append(&c, &s, "inbox", "c").1, "on, but no rules");
    assert_eq!(list_proposals(&c, Some("pending"), 50).unwrap().len(), 1);
}

#[test]
fn a_rule_covers_the_page_and_everything_under_it_by_the_real_tree() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    rule(&c, Some("inbox"), &["append_text", "create_page"], None);
    for page in ["inbox", "daily"] { assert!(append(&c, &s, page, page).1, "{page}"); }
    for page in ["bots", "other"] { assert!(!append(&c, &s, page, page).1, "{page}"); }
    assert!(ask(&c, &s, "create_page", json!({ "title": "x", "parent": "daily" })).1);
    assert!(!ask(&c, &s, "create_page", json!({ "title": "top level" })).1, "the top level is only covered by an any-page rule");
    assert!(!ask(&c, &s, "create_page", json!({ "title": "x", "parent": "inbox", "claimed_path": "Bots/Inbox" })).0.is_empty());
    assert!(!ask(&c, &s, "append_text", json!({ "page": "other", "text": "t", "parent": "inbox" })).1, "what the bot says about the tree is ignored");
    // Moved out of the subtree: no longer covered.
    c.execute("UPDATE pages SET parent_id='other',sort_key='zz' WHERE id='daily'", []).unwrap();
    assert!(!append(&c, &s, "daily", "after the move").1);
}

#[test]
fn without_subpages_only_that_page() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    let mut r = rule(&c, Some("inbox"), &["append_text", "create_page"], None); r.include_subtree = false; save_rule(&c, r).unwrap();
    assert!(append(&c, &s, "inbox", "a").1 && !append(&c, &s, "daily", "b").1);
    assert!(ask(&c, &s, "create_page", json!({ "title": "child", "parent": "inbox" })).1);
}

#[test]
fn action_source_and_enabled_all_have_to_match() {
    let c = fresh(); let claude = bot(&c, "Claude"); let grok = bot(&c, "Grok"); on(&c);
    let r = rule(&c, Some("inbox"), &["append_text"], Some("Claude"));
    assert!(append(&c, &claude, "inbox", "a").1);
    assert!(!append(&c, &grok, "inbox", "a").1, "another bot");
    assert!(!ask(&c, &claude, "add_checklist_item", json!({ "page": "inbox", "text": "t" })).1, "not ticked");
    save_rule(&c, Rule { enabled: false, ..r.clone() }).unwrap();
    assert!(!append(&c, &claude, "inbox", "b").1, "disabled");
    delete_rule(&c, &r.id).unwrap();
    assert!(rules(&c).unwrap().is_empty() && !append(&c, &claude, "inbox", "c").1);
}

#[test]
fn only_the_six_page_changes_can_be_automatic_and_protected_pages_never_are() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    rule(&c, None, &SIX, None);
    for (op, payload) in [("timetable_add_activity", json!({ "name": "x", "category": "Work" })), ("home_set_widgets", json!({ "show": ["weather"] })), ("habit_add", json!({ "name": "x" })),
        ("todo_reorder", json!({ "order": ["a"] })), ("append_embed", json!({ "page": "inbox", "url": "https://claude.ai/artifact/a" })), ("attach_html", json!({ "page": "inbox", "title": "t", "html": "<p>" }))] {
        assert!(!ask(&c, &s, op, payload).1, "{op}");
    }
    assert!(save_rule(&c, Rule { id: String::new(), name: "x".into(), page_id: None, include_subtree: true, ops: vec!["attach_html".into()], source: None, enabled: true, per_hour: 1 }).is_err());
    assert!(!SIX.iter().any(|o| o.contains("delete") || o.contains("trash")));
    let system: String = c.query_row("SELECT id FROM pages WHERE system_key IS NOT NULL", [], |r| r.get(0)).unwrap();
    assert!(!append(&c, &s, &system, "x").1, "system page");
    c.execute("UPDATE pages SET deleted_at='2026-01-01' WHERE id='other'", []).unwrap();
    assert!(!append(&c, &s, "other", "x").1, "trashed page");
    assert!(!append(&c, &s, "nope", "x").1, "no such page");
    c.execute("INSERT INTO page_locks(page_id,salt,kdf_m,kdf_t,kdf_p,check_blob) VALUES('daily',zeroblob(16),8192,1,1,zeroblob(32))", []).unwrap();
    assert!(!append(&c, &s, "daily", "x").1, "locked page");
    c.execute("DELETE FROM note_formats WHERE page_id='inbox'", []).unwrap();
    assert!(!append(&c, &s, "inbox", "x").1, "an old plain-text note");
}

#[test]
fn a_cell_is_filled_only_when_empty_and_relations_never() {
    let c = fresh(); database(&c); let s = bot(&c, "Claude"); on(&c);
    rule(&c, Some("inbox"), &SIX, None);
    assert!(ask(&c, &s, "set_value", json!({ "row": "row1", "property": "score", "value": 3 })).1);
    c.execute("INSERT INTO db_values(row_id,property_id,value) VALUES('row1','score','2')", []).unwrap();
    assert!(!ask(&c, &s, "set_value", json!({ "row": "row1", "property": "score", "value": 4 })).1, "would overwrite");
    c.execute("DELETE FROM db_values", []).unwrap();
    assert!(!ask(&c, &s, "set_value", json!({ "row": "row1", "property": "score", "value": null })).1, "clearing is not filling");
    assert!(!ask(&c, &s, "set_value", json!({ "row": "row1", "property": "rel", "value": ["inbox"] })).1);
    assert!(ask(&c, &s, "create_row", json!({ "database": "db", "values": { "score": 1 } })).1);
    assert!(!ask(&c, &s, "create_row", json!({ "database": "db", "values": { "rel": ["inbox"] } })).1);
    assert!(!ask(&c, &s, "create_row", json!({ "database": "inbox" })).1, "not a database");
}

#[test]
fn rename_is_automatic_only_for_the_bots_own_untouched_page() {
    let c = fresh(); let claude = bot(&c, "Claude"); let grok = bot(&c, "Grok"); on(&c);
    rule(&c, None, &SIX, None);
    let rename = |s: &str, title: &str| ask(&c, s, "rename_page", json!({ "page": "mine", "title": title })).1;
    assert!(!ask(&c, &claude, "rename_page", json!({ "page": "inbox", "title": "Hijack" })).1, "the owner's page");
    // Claude creates a page (through the automatic path) and the app applies it.
    let (id, auto) = ask(&c, &claude, "create_page", json!({ "title": "Mine", "parent": "inbox" })); assert!(auto);
    claim(&c, &id).unwrap().unwrap();
    page(&c, "mine", Some("inbox"), "Mine");
    applied(&c, &id, true, "Created page mine", &json!({ "page": "mine" })).unwrap();
    assert!(!rename(&grok, "Grok's"), "another bot");
    assert!(rename(&claude, "Mine v2"));
    c.execute("UPDATE page_search SET body='the owner wrote here' WHERE page_id='mine'", []).unwrap();
    assert!(!rename(&claude, "Mine v3"), "changed since");
}

#[test]
fn a_page_created_by_hand_approval_also_counts_as_the_bots() {
    let c = fresh(); let claude = bot(&c, "Claude");
    let (id, auto) = ask(&c, &claude, "create_page", json!({ "title": "Mine" })); assert!(!auto);
    decide(&c, &id, true).unwrap(); page(&c, "mine", None, "Mine"); mark_applied(&c, &id, true, "Created page mine").unwrap();
    on(&c); rule(&c, None, &SIX, None);
    assert!(ask(&c, &claude, "rename_page", json!({ "page": "mine", "title": "Mine v2" })).1);
}

#[test]
fn over_the_hourly_limit_requests_wait_for_the_owner() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    let r = rule(&c, Some("inbox"), &["append_text"], None); save_rule(&c, Rule { per_hour: 2, ..r }).unwrap();
    let got: Vec<bool> = (0..4).map(|i| append(&c, &s, "inbox", &format!("line {i}")).1).collect();
    assert_eq!(got, [true, true, false, false]);
    c.execute("UPDATE auto_log SET approved_at='2020-01-01T00:00:00.000Z'", []).unwrap();
    assert!(append(&c, &s, "inbox", "an hour later").1);
}

#[test]
fn pausing_returns_unapplied_changes_to_the_queue_at_once() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    rule(&c, Some("inbox"), &["append_text"], None);
    let (a, _) = append(&c, &s, "inbox", "a"); let (b, _) = append(&c, &s, "inbox", "b");
    claim(&c, &a).unwrap().unwrap(); // already being written
    set_switches(&c, true, true).unwrap();
    assert_eq!(status(&c, &b), "pending");
    assert_eq!(status(&c, &a), "approved", "the one being written finishes and stays listed");
    assert!(pending(&c).unwrap().is_empty() && claim(&c, &b).unwrap().is_none());
    assert!(!append(&c, &s, "inbox", "c").1);
    assert!(decide(&c, &b, true).is_ok(), "the owner can still approve it by hand");
}

#[test]
fn claim_checks_everything_again_and_only_once() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    let r = rule(&c, Some("inbox"), &["append_text"], None);
    let (ok, _) = append(&c, &s, "inbox", "fine");
    assert!(claim(&c, &ok).unwrap().is_some());
    assert!(claim(&c, &ok).unwrap().is_none(), "not twice");
    let (disabled, _) = append(&c, &s, "inbox", "x"); save_rule(&c, Rule { enabled: false, ..r.clone() }).unwrap();
    assert!(claim(&c, &disabled).unwrap().is_none()); assert_eq!(status(&c, &disabled), "pending");
    save_rule(&c, r.clone()).unwrap();
    let (moved, _) = append(&c, &s, "daily", "y"); c.execute("UPDATE pages SET parent_id='other',sort_key='zz' WHERE id='daily'", []).unwrap();
    assert!(claim(&c, &moved).unwrap().is_none()); assert_eq!(status(&c, &moved), "pending");
}

#[test]
fn revoking_a_token_cancels_its_automatic_changes() {
    let c = fresh(); let made = create_token(&c, "Claude", &["notes:write".into()]).unwrap(); on(&c);
    rule(&c, None, &["append_text"], None);
    let (id, auto) = append(&c, &made.secret, "inbox", "a"); assert!(auto);
    revoke_token(&c, &made.info.id).unwrap();
    assert_eq!(status(&c, &id), "cancelled");
    assert!(claim(&c, &id).unwrap().is_none() && pending(&c).unwrap().is_empty());
}

#[test]
fn a_repeat_of_a_request_waiting_to_be_applied_is_not_applied_twice() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    rule(&c, None, &["append_text"], None);
    let first = propose(&c, &s, "append_text", &json!({ "page": "inbox", "text": "same" }), "x").unwrap();
    let again = propose(&c, &s, "append_text", &json!({ "page": "inbox", "text": "same" }), "x").unwrap();
    assert_eq!((again.id, again.existing, again.auto), (first.id, true, true));
    assert_eq!(pending(&c).unwrap().len(), 1);
}

#[test]
fn an_interrupted_apply_is_recorded_as_failed_and_never_rerun() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    rule(&c, None, &["append_text"], None);
    let (id, _) = append(&c, &s, "inbox", "a"); claim(&c, &id).unwrap();
    c.execute("UPDATE auto_log SET claimed_at='2020-01-01T00:00:00.000Z'", []).unwrap();
    assert!(pending(&c).unwrap().is_empty());
    assert_eq!(status(&c, &id), "failed");
}

#[test]
fn the_list_badges_and_audit_record_what_happened() {
    let c = fresh(); let s = bot(&c, "Claude"); on(&c);
    rule(&c, Some("inbox"), &["append_text"], None);
    let (id, _) = append(&c, &s, "daily", "Today's result: 7");
    assert_eq!(unseen(&c).unwrap().count, 0, "nothing is badged before it is applied");
    claim(&c, &id).unwrap(); applied(&c, &id, true, "Added 1 block", &json!({ "blocks": [{ "id": "b1", "text": "Today's result: 7" }] })).unwrap();
    let list = recent(&c, 10).unwrap();
    assert_eq!((list[0].source.as_str(), list[0].page_title.as_deref(), list[0].rule_name.as_str(), list[0].status.as_str()), ("Claude", Some("Daily"), "Inbox rule", "applied"));
    assert!(list[0].change_text.contains("Add text to “Daily”") && list[0].change_text.contains("result: 7"));
    assert_eq!(unseen(&c).unwrap(), Unseen { count: 1, pages: vec!["daily".into()] });
    mark_seen(&c, Some("daily")).unwrap(); assert_eq!(unseen(&c).unwrap().count, 0);
    let actions: Vec<String> = recent_audit(&c, 50).unwrap().into_iter().map(|a| a.action).collect();
    for a in ["auto.enabled", "auto.rule_added", "proposal.auto_approved", "proposal.applied"] { assert!(actions.iter().any(|x| x == a), "{a}"); }
}

#[test]
fn undo_is_offered_only_while_the_change_is_untouched() {
    let c = fresh(); database(&c); let s = bot(&c, "Claude"); on(&c);
    rule(&c, None, &SIX, None);
    let run = |op: &str, payload: Value, after: Value, result: &str, change: &dyn Fn()| -> String {
        let (id, auto) = ask(&c, &s, op, payload); assert!(auto, "{op}");
        claim(&c, &id).unwrap().unwrap(); change(); applied(&c, &id, true, result, &after).unwrap(); id
    };
    // a cell
    let cell = run("set_value", json!({ "row": "row1", "property": "score", "value": 5 }), json!({}), "Updated a cell", &|| { c.execute("INSERT INTO db_values(row_id,property_id,value) VALUES('row1','score','5')", []).unwrap(); });
    assert_eq!(undo_plan(&c, &cell).unwrap(), json!({ "kind": "clear", "row": "row1", "property": "score" }));
    c.execute("UPDATE db_values SET value='6'", []).unwrap();
    assert!(undo_plan(&c, &cell).unwrap_err().contains("changed it since"));
    // a new page
    let made = run("create_page", json!({ "title": "New", "parent": "inbox" }), json!({ "page": "new" }), "Created page new", &|| page(&c, "new", Some("inbox"), "New"));
    assert_eq!(undo_plan(&c, &made).unwrap(), json!({ "kind": "trash", "page": "new" }));
    c.execute("UPDATE page_search SET body='written' WHERE page_id='new'", []).unwrap();
    assert!(undo_plan(&c, &made).unwrap_err().contains("has content now"));
    c.execute("UPDATE page_search SET body='' WHERE page_id='new'", []).unwrap();
    // a rename of that page
    let renamed = run("rename_page", json!({ "page": "new", "title": "Renamed" }), json!({}), "Renamed page new", &|| { c.execute("UPDATE pages SET title='Renamed' WHERE id='new'", []).unwrap(); });
    assert_eq!(undo_plan(&c, &renamed).unwrap(), json!({ "kind": "rename", "page": "new", "title": "New" }));
    // added text
    let added = run("append_text", json!({ "page": "inbox", "text": "hi" }), json!({ "blocks": [{ "id": "b", "text": "hi" }] }), "Added 1 block", &|| {});
    assert_eq!(undo_plan(&c, &added).unwrap()["kind"], "blocks");
    undone(&c, &added).unwrap();
    assert!(undone(&c, &added).is_err() && undo_plan(&c, &added).is_err(), "once");
}

#[test]
fn a_bot_cannot_reach_rules_or_switches_through_the_local_api() {
    use crate::gateway_http::{handle, ApiRequest};
    let c = fresh(); let s = bot(&c, "Claude");
    for method in ["GET", "POST", "PATCH", "PUT", "DELETE"] {
        for path in ["/v1/auto", "/v1/auto/rules", "/v1/rules", "/v1/settings", "/v1/auto/state"] {
            let r = handle(&c, &ApiRequest { method: method.into(), path: path.into(), authorization: Some("Bearer ".to_string() + &s), host: Some("127.0.0.1:47651".into()), body: br#"{"feature_on":true,"paused":false}"#.to_vec(), ..Default::default() }, 47651);
            assert!(r.status == 404 || r.status == 405, "{method} {path} {}", r.status);
        }
    }
    // Proposing something that looks like a settings change is refused outright.
    for op in ["auto_rule_save", "auto_set_switches", "set_rule"] { assert!(propose(&c, &s, op, &json!({}), "x").is_err()); }
    assert_eq!(switches(&c).unwrap(), Switches { feature_on: false, paused: false });
}

#[test]
fn the_local_api_reports_automatic_approval_with_a_flag() {
    use crate::gateway_http::{handle, ApiRequest};
    let c = fresh(); let s = bot(&c, "Claude");
    let call = |method: &str, path: &str, body: Value| handle(&c, &ApiRequest { method: method.into(), path: path.into(), authorization: Some("Bearer ".to_string() + &s), host: Some("127.0.0.1:47651".into()), body: body.to_string().into_bytes(), ..Default::default() }, 47651).body;
    let manual = call("POST", "/v1/proposals", json!({ "op": "append_text", "payload": { "page": "inbox", "text": "m" }, "summary": "x" }));
    assert_eq!((&manual["status"], &manual["auto"]), (&json!("pending"), &json!(false)));
    on(&c); rule(&c, None, &["append_text"], None);
    let auto = call("POST", "/v1/proposals", json!({ "op": "append_text", "payload": { "page": "inbox", "text": "a" }, "summary": "x" }));
    assert_eq!((&auto["status"], &auto["auto"]), (&json!("approved"), &json!(true)));
    let read = call("GET", &format!("/v1/proposals/{}", auto["id"].as_str().unwrap()), json!(null));
    assert_eq!((&read["status"], &read["auto"]), (&json!("approved"), &json!(true)));
}
