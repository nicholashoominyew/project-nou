//! Local API for AI tools (ADR-004). Loopback only, off by default, token required. Reads need a scope; the only write
//! is *proposing* a change, which a human must approve in the app. Request handling is a pure function so it can be
//! tested without sockets; `serve` is a thin loop around it.
use crate::{databases, gateway, Db};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, thread::JoinHandle, time::{Duration, Instant}};
use tauri::{AppHandle, Manager, State};

pub const DEFAULT_PORT: u16 = 47651;
const MAX_BODY: usize = 70_000;
const MAX_TEXT: usize = 100_000;
const REQUESTS_PER_MINUTE: usize = 120;

#[derive(Debug, Clone, Default)]
pub struct ApiRequest { pub method: String, pub path: String, pub query: HashMap<String, String>, pub authorization: Option<String>, pub host: Option<String>, pub origin: Option<String>, pub body: Vec<u8> }
#[derive(Debug, Clone, PartialEq)]
pub struct ApiResponse { pub status: u16, pub body: Value }

fn reply(status: u16, body: Value) -> ApiResponse { ApiResponse { status, body } }
fn fail(status: u16, message: &str) -> ApiResponse { reply(status, json!({ "error": message })) }
/// Anything read through the API is data. It may contain text written to manipulate an AI; treat it as untrusted.
fn data(body: Value) -> ApiResponse { reply(200, json!({ "content_is_untrusted_data": true, "data": body })) }

fn bearer(req: &ApiRequest) -> Option<String> {
    let h = req.authorization.as_deref()?.trim();
    h.strip_prefix("Bearer ").or_else(|| h.strip_prefix("bearer ")).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}
fn needs(who: &gateway::Verified, scope: &str) -> Result<(), ApiResponse> {
    if who.scopes.iter().any(|s| s == scope) { Ok(()) } else { Err(fail(403, &format!("This token lacks the {scope} scope"))) }
}

pub fn handle(c: &Connection, req: &ApiRequest, port: u16) -> ApiResponse {
    // A web page in the user's browser must never be able to talk to this API (CSRF / DNS rebinding).
    if req.origin.is_some() { return fail(403, "Browser requests are not allowed"); }
    let host_ok = req.host.as_deref().is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if !host_ok { return fail(403, "Unexpected host"); }
    if req.body.len() > MAX_BODY { return fail(413, "The request is too large"); }
    let Some(secret) = bearer(req) else { return fail(401, "A bearer token is required") };
    let who = match gateway::verify_token(c, &secret) { Ok(w) => w, Err(_) => return fail(401, "Invalid or revoked token") };
    let segments: Vec<&str> = req.path.trim_matches('/').split('/').collect();
    match (req.method.as_str(), segments.as_slice()) {
        ("GET", ["v1", "status"]) => reply(200, json!({ "ok": true, "scopes": who.scopes })),
        // A read-only picture of the Life Timetable (activity names and, per week and day, the blocks), so an assistant can propose changes in the names it sees.
        ("GET", ["v1", "timetable"]) => {
            if let Err(r) = needs(&who, "timetable:read") { return r; }
            match crate::timetable::summary(c) { Ok(v) => data(v), Err(_) => fail(500, "The timetable could not be read") }
        }
        // Habits (name, type, days and how many of the last 14 days were done) and Today's tasks (text and whether done, in the owner's order): read-only, no ids.
        ("GET", ["v1", "habits"]) => {
            if let Err(r) = needs(&who, "timetable:read") { return r; }
            match crate::habits::summary(c) { Ok(v) => data(v), Err(_) => fail(500, "The habits could not be read") }
        }
        ("GET", ["v1", "todos"]) => {
            if let Err(r) = needs(&who, "notes:read") { return r; }
            match crate::todos::list(c, "") { Ok(v) => data(json!(v.iter().map(|t| json!({ "text": t.text(), "done": t.checked() })).collect::<Vec<_>>())), Err(_) => fail(500, "The tasks could not be read") }
        }
        ("GET", ["v1", "search"]) => {
            if let Err(r) = needs(&who, "notes:read") { return r; }
            let q = req.query.get("q").map(|s| s.trim()).unwrap_or("");
            if q.is_empty() || q.chars().count() > 200 { return fail(400, "q must be 1 to 200 characters"); }
            let exact = format!("\"{}\"", q.replace('"', "\"\""));
            let found: Result<Vec<Value>, rusqlite::Error> = (|| {
                let mut s = c.prepare("SELECT p.id,p.title FROM page_search s JOIN pages p ON p.id=s.page_id WHERE page_search MATCH ?1 AND p.workspace_id='personal' AND p.deleted_at IS NULL ORDER BY bm25(page_search),p.title COLLATE NOCASE LIMIT 20")?;
                let rows = s.query_map([exact], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)? })))?;
                rows.collect()
            })();
            match found { Ok(list) => data(json!(list)), Err(_) => fail(400, "That search could not be run") }
        }
        ("GET", ["v1", "chat"]) => {
            if let Err(r) = needs(&who, "chat:read") { return r; }
            let after = req.query.get("after").and_then(|v| v.parse::<i64>().ok());
            let limit = req.query.get("limit").and_then(|v| v.parse::<u32>().ok()).unwrap_or(50);
            let room = req.query.get("room").map(String::as_str);
            let found = match req.query.get("mentioning").filter(|n| !n.trim().is_empty()) {
                Some(name) => crate::chat::list_mentioning(c, after, limit, room, name),
                None => crate::chat::list(c, after, limit, room),
            };
            match found { Ok(list) => data(serde_json::to_value(list).unwrap_or(Value::Null)), Err(m) if m == "Unknown room" => fail(404, &m), Err(_) => fail(500, "The chat could not be read") }
        }
        ("GET", ["v1", "rooms"]) => {
            if let Err(r) = needs(&who, "chat:read") { return r; }
            match crate::chat::rooms(c) { Ok(list) => data(serde_json::to_value(list).unwrap_or(Value::Null)), Err(_) => fail(500, "The rooms could not be read") }
        }
        ("POST", ["v1", "chat"]) => {
            if let Err(r) = needs(&who, "chat:write") { return r; }
            let Ok(body) = serde_json::from_slice::<Value>(&req.body) else { return fail(400, "The body must be JSON") };
            let Some(text) = body.get("body").and_then(Value::as_str) else { return fail(400, "body is required") };
            let (room, role) = (body.get("room").and_then(Value::as_str), body.get("role").and_then(Value::as_str));
            let made = match body.get("type").and_then(Value::as_str).unwrap_or("message") {
                "message" | "handoff" => { let ty = body.get("type").and_then(Value::as_str).unwrap_or("message");
                    crate::chat::post_to_room(c, &who.id, &who.name, room, ty, role, body.get("to").and_then(Value::as_str), body.get("task_ref").and_then(Value::as_str), text) }
                // An approval card also makes a queue item, so it needs the queue scope as well.
                "approval" => { if let Err(r) = needs(&who, "queue:write") { return r; }
                    crate::chat::post_approval_ref(c, &who.id, &who.name, room, text, body.get("queue_title").and_then(Value::as_str), role, body.get("task_ref").and_then(Value::as_str)) }
                _ => return fail(400, "type must be message, handoff or approval"),
            };
            match made {
                Ok(m) => reply(201, json!({ "id": m.id, "at": m.at, "author": m.author, "room": m.room, "type": m.ty, "queue_item_id": m.queue_item_id })),
                Err(m) if m.contains("slow down") => fail(429, &m),
                Err(m) if m == "Unknown room" => fail(404, &m),
                Err(m) => fail(400, &m),
            }
        }
        ("GET", ["v1", "queue"]) => {
            if let Err(r) = needs(&who, "queue:read") { return r; }
            let limit = req.query.get("limit").and_then(|v| v.parse::<u32>().ok()).unwrap_or(100);
            let status = req.query.get("status").map(String::as_str);
            if status.is_some_and(|s| !matches!(s, "queued" | "running" | "needs_nick" | "done")) { return fail(400, "status must be queued, running, needs_nick or done"); }
            match crate::hub::queue_list(c, status, limit) { Ok(list) => data(serde_json::to_value(list).unwrap_or(Value::Null)), Err(_) => fail(500, "The queue could not be read") }
        }
        ("GET", ["v1", "queue", id]) => {
            if let Err(r) = needs(&who, "queue:read") { return r; }
            let Ok(id) = id.parse::<i64>() else { return fail(404, "Queue item not found") };
            // An approval item also reports how the owner decided, so the bot that asked can find out.
            match crate::hub::queue_get(c, id) {
                Ok(item) => { let decision = item.approval_message_id.and_then(|m| crate::chat::get(c, m).ok()).map(|m| json!({ "status": m.approval, "decided_at": m.decided_at }));
                    data(json!({ "item": item, "approval": decision })) }
                Err(_) => fail(404, "Queue item not found"),
            }
        }
        ("POST", ["v1", "queue"]) => {
            if let Err(r) = needs(&who, "queue:write") { return r; }
            let Ok(body) = serde_json::from_slice::<Value>(&req.body) else { return fail(400, "The body must be JSON") };
            let Some(title) = body.get("title").and_then(Value::as_str) else { return fail(400, "title is required") };
            match crate::hub::queue_create(c, &who.id, &who.name, title, body.get("status").and_then(Value::as_str), body.get("room").and_then(Value::as_str)) {
                Ok(item) => reply(201, json!({ "id": item.id, "status": item.status })),
                Err(m) if m.contains("slow down") => fail(429, &m),
                Err(m) if m == "Unknown room" => fail(404, &m),
                Err(m) => fail(400, &m),
            }
        }
        ("PATCH", ["v1", "queue", id]) => {
            if let Err(r) = needs(&who, "queue:write") { return r; }
            let Ok(id) = id.parse::<i64>() else { return fail(404, "Queue item not found") };
            let Ok(body) = serde_json::from_slice::<Value>(&req.body) else { return fail(400, "The body must be JSON") };
            let Some(status) = body.get("status").and_then(Value::as_str) else { return fail(400, "status is required") };
            match crate::hub::queue_set(c, &who.id, id, status) {
                Ok(item) => reply(200, json!({ "id": item.id, "status": item.status })),
                Err(m) if m.contains("not found") => fail(404, &m),
                Err(m) if m.contains("waiting for the owner") => fail(409, &m),
                Err(m) => fail(400, &m),
            }
        }
        ("GET", ["v1", "pages", id]) => {
            if let Err(r) = needs(&who, "notes:read") { return r; }
            if crate::locks::is_locked(c, id).unwrap_or(false) { return fail(423, "This note is locked"); }
            let row: Option<(String, String, String)> = c.query_row("SELECT title,updated_at,COALESCE((SELECT body FROM page_search WHERE page_id=pages.id),'') FROM pages WHERE id=?1 AND workspace_id='personal' AND deleted_at IS NULL", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().unwrap_or(None);
            match row { Some((title, updated, text)) => data(json!({ "id": id, "title": title, "updated_at": updated, "text": text.chars().take(MAX_TEXT).collect::<String>() })), None => fail(404, "Page not found") }
        }
        ("GET", ["v1", "databases", id]) => {
            if let Err(r) = needs(&who, "databases:read") { return r; }
            match databases::database_view(c, id) { Ok(Some(view)) => data(serde_json::to_value(view).unwrap_or(Value::Null)), Ok(None) => fail(404, "Database not found"), Err(_) => fail(500, "The database could not be read") }
        }
        ("POST", ["v1", "proposals"]) => {
            let Ok(body) = serde_json::from_slice::<Value>(&req.body) else { return fail(400, "The body must be JSON") };
            let (Some(op), Some(payload), Some(summary)) = (body.get("op").and_then(Value::as_str), body.get("payload"), body.get("summary").and_then(Value::as_str)) else { return fail(400, "op, payload and summary are required") };
            match gateway::propose(c, &secret, op, payload, summary) {
                Ok(p) if p.auto => reply(if p.existing { 200 } else { 201 }, json!({ "id": p.id, "existing": p.existing, "status": "approved", "auto": true, "note": "Approved automatically by one of the owner's rules. NOU is applying it now." })),
                Ok(p) => reply(if p.existing { 200 } else { 201 }, json!({ "id": p.id, "existing": p.existing, "status": "pending", "auto": false, "note": "A person must approve this in NOU before anything changes." })),
                Err(m) if m.contains("lacks") => fail(403, &m),
                Err(m) if m.starts_with("Too many") => fail(429, &m),
                Err(m) => fail(400, &m),
            }
        }
        ("GET", ["v1", "proposals", id]) => {
            // A client may only look at its own proposals.
            match gateway::get_proposal(c, id) {
                Ok(p) if p.token_id == who.id => reply(200, json!({ "id": p.id, "op": p.op, "status": p.status, "result": p.result, "decided_at": p.decided_at, "auto": crate::auto::is_auto(c, id) })),
                _ => fail(404, "Proposal not found"),
            }
        }
        ("GET" | "POST" | "PATCH", _) => fail(404, "Unknown endpoint"),
        _ => fail(405, "Method not allowed"),
    }
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    let decode = |s: &str| -> String {
        let bytes = s.replace('+', " ").into_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let Ok(v) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16) { out.push(v); i += 3; continue; }
            }
            out.push(bytes[i]); i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    };
    raw.split('&').filter(|p| !p.is_empty()).filter_map(|p| { let (k, v) = p.split_once('=').unwrap_or((p, "")); Some((decode(k), decode(v))) }).collect()
}

/// The accept loop. `handler` turns a parsed request into a response (it owns database access). Stops when `stop` is set.
pub fn serve(server: tiny_http::Server, stop: Arc<AtomicBool>, port: u16, handler: Arc<dyn Fn(&ApiRequest, u16) -> ApiResponse + Send + Sync>) {
    let mut window: Vec<Instant> = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        let Ok(Some(mut request)) = server.recv_timeout(Duration::from_millis(400)) else { continue };
        let now = Instant::now();
        window.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        let response = if window.len() >= REQUESTS_PER_MINUTE { fail(429, "Too many requests; slow down") } else {
            window.push(now);
            fn header(r: &tiny_http::Request, name: &'static str) -> Option<String> { r.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string()) }
            let (authorization, host, origin) = (header(&request, "Authorization"), header(&request, "Host"), header(&request, "Origin"));
            let method = request.method().as_str().to_uppercase();
            let url = request.url().to_string();
            let (path, query) = url.split_once('?').map(|(p, q)| (p.to_string(), parse_query(q))).unwrap_or((url.clone(), HashMap::new()));
            let mut body = Vec::new();
            let declared = request.body_length().unwrap_or(0);
            if declared > MAX_BODY { fail(413, "The request is too large") } else {
                use std::io::Read;
                let _ = request.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body);
                handler(&ApiRequest { method, path, query, authorization, host, origin, body }, port)
            }
        };
        let mut out = tiny_http::Response::from_string(response.body.to_string()).with_status_code(response.status);
        for (k, v) in [("Content-Type", "application/json; charset=utf-8"), ("X-Content-Type-Options", "nosniff"), ("Cache-Control", "no-store")] {
            if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) { out.add_header(h); }
        }
        let _ = request.respond(out);
    }
}

// ---- running the listener inside the app ----
/// Stored in the profile folder (not the database): whether the owner turned the local API on.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ApiConfig { pub enabled: bool, pub port: u16 }
impl Default for ApiConfig { fn default() -> Self { ApiConfig { enabled: false, port: DEFAULT_PORT } } }

fn config_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(crate::data_dir(app.path()).map_err(|e| e.to_string())?.join("gateway.json")) }
pub fn read_config(path: &std::path::Path) -> ApiConfig {
    let mut cfg: ApiConfig = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if let Some(p) = std::env::var("NOU_API_PORT").ok().and_then(|p| p.parse::<u16>().ok()) { cfg.port = p; }
    if cfg.port < 1024 { cfg.port = DEFAULT_PORT; }
    cfg
}
fn write_config(path: &std::path::Path, cfg: &ApiConfig) -> Result<(), String> { std::fs::write(path, serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }

pub struct Running { stop: Arc<AtomicBool>, thread: Option<JoinHandle<()>>, pub port: u16 }
impl Running { fn shut_down(&mut self) { self.stop.store(true, Ordering::SeqCst); if let Some(t) = self.thread.take() { let _ = t.join(); } } }
#[derive(Default)]
pub struct ApiServer(pub Mutex<Option<Running>>);

fn start(app: &AppHandle, port: u16) -> Result<Running, String> {
    // Loopback only: the listener can never be reached from another device.
    let server = tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| format!("Could not listen on 127.0.0.1:{port}: {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let handle = app.clone();
    let handler: Arc<dyn Fn(&ApiRequest, u16) -> ApiResponse + Send + Sync> = Arc::new(move |req, p| {
        let db = handle.state::<Db>();
        if (req.method == "POST" || req.method == "PATCH") && db.writable().is_err() { return fail(503, "NOU is waiting for you to review a restore; try again later"); }
        let guard = db.0.lock();
        let out = match &guard { Ok(c) => handle_request(c, req, p), Err(_) => fail(500, "The database is unavailable") };
        // Tell the window there is something to apply, so it does not wait for its next look.
        if out.body.get("auto").and_then(Value::as_bool) == Some(true) && req.method == "POST" { use tauri::Emitter; let _ = handle.emit("auto-approved", ()); }
        out
    });
    let thread = { let stop = stop.clone(); std::thread::spawn(move || serve(server, stop, port, handler)) };
    Ok(Running { stop, thread: Some(thread), port })
}
fn handle_request(c: &Connection, req: &ApiRequest, port: u16) -> ApiResponse { handle(c, req, port) }

/// Called once at startup: the API only runs if the owner enabled it earlier.
pub fn start_if_enabled(app: &AppHandle) {
    let Ok(path) = config_path(app) else { return };
    let cfg = read_config(&path);
    if !cfg.enabled { return; }
    match start(app, cfg.port) {
        Ok(running) => { if let Some(state) = app.try_state::<ApiServer>() { if let Ok(mut slot) = state.0.lock() { *slot = Some(running); } } }
        Err(e) => eprintln!("Local API not started: {e}"),
    }
}

#[derive(Serialize)]
pub struct ApiStatus { enabled: bool, running: bool, port: u16, address: String }
fn status_of(cfg: &ApiConfig, running: bool) -> ApiStatus { ApiStatus { enabled: cfg.enabled, running, port: cfg.port, address: format!("http://127.0.0.1:{}", cfg.port) } }

#[tauri::command]
pub fn gateway_api_status(app: AppHandle, server: State<'_, ApiServer>) -> Result<ApiStatus, String> {
    let cfg = read_config(&config_path(&app)?);
    let running = server.0.lock().map_err(|_| "State lock poisoned")?.is_some();
    Ok(status_of(&cfg, running))
}

#[tauri::command]
pub fn gateway_api_set_enabled(app: AppHandle, db: State<'_, Db>, server: State<'_, ApiServer>, enabled: bool) -> Result<ApiStatus, String> {
    db.writable()?;
    let path = config_path(&app)?;
    let mut cfg = read_config(&path);
    let mut slot = server.0.lock().map_err(|_| "State lock poisoned")?;
    if enabled {
        if slot.is_none() { *slot = Some(start(&app, cfg.port)?); }
    } else if let Some(mut running) = slot.take() { running.shut_down(); }
    cfg.enabled = enabled;
    write_config(&path, &ApiConfig { enabled, port: cfg.port })?;
    if let Ok(c) = db.0.lock() { let _ = gateway::audit(&c, "owner", if enabled { "api.enabled" } else { "api.disabled" }, json!({ "port": cfg.port })); }
    // The bot runner follows the Local API: it starts when the API comes on (if its own switch is on) and stops when the API goes off.
    // A runner that cannot start (Node missing, say) is shown on the AI access screen; it does not stop the API from being switched.
    let _ = crate::runner::sync(&app, slot.is_some());
    Ok(status_of(&cfg, slot.is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    const PORT: u16 = 47651;
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        c.execute("INSERT INTO pages(id,workspace_id,title,sort_key) VALUES('p1','personal','Project plan','1'),('p2','personal','Secret trash','2')", []).unwrap();
        c.execute("INSERT INTO page_search(page_id,title,body) VALUES('p1','Project plan','launch the zebra project in spring'),('p2','Secret trash','zebra in the bin')", []).unwrap();
        c.execute("UPDATE pages SET deleted_at='t' WHERE id='p2'", []).unwrap();
        c
    }
    fn req(method: &str, path: &str, token: Option<&str>) -> ApiRequest {
        let (p, q) = path.split_once('?').map(|(a, b)| (a.to_string(), parse_query(b))).unwrap_or((path.to_string(), HashMap::new()));
        ApiRequest { method: method.into(), path: p, query: q, authorization: token.map(|t| format!("Bearer {t}")), host: Some(format!("127.0.0.1:{PORT}")), origin: None, body: vec![] }
    }
    fn token(c: &Connection, scopes: &[&str]) -> String { gateway::create_token(c, "t", &scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap().secret }

    #[test]
    fn browser_origins_foreign_hosts_and_missing_or_bad_tokens_are_refused_before_anything_else() {
        let c = fresh();
        let t = token(&c, &["notes:read"]);
        let mut r = req("GET", "/v1/status", Some(&t));
        r.origin = Some("https://evil.example".into());
        assert_eq!(handle(&c, &r, PORT).status, 403);
        let mut r = req("GET", "/v1/status", Some(&t));
        r.host = Some("evil.example:47651".into());
        assert_eq!(handle(&c, &r, PORT).status, 403, "DNS rebinding: the Host header must be loopback");
        assert_eq!(handle(&c, &req("GET", "/v1/status", None), PORT).status, 401);
        assert_eq!(handle(&c, &req("GET", "/v1/status", Some("nou_wrong")), PORT).status, 401);
        assert_eq!(handle(&c, &req("GET", "/v1/status", Some(&t)), PORT).status, 200);
        let mut big = req("POST", "/v1/proposals", Some(&t));
        big.body = vec![b'x'; MAX_BODY + 1];
        assert_eq!(handle(&c, &big, PORT).status, 413);
    }
    #[test]
    fn reads_need_the_right_scope_and_never_return_trashed_pages() {
        let c = fresh();
        let reader = token(&c, &["notes:read"]);
        let none = token(&c, &["databases:read"]);
        assert_eq!(handle(&c, &req("GET", "/v1/search?q=zebra", Some(&none)), PORT).status, 403);
        let hit = handle(&c, &req("GET", "/v1/search?q=zebra", Some(&reader)), PORT);
        assert_eq!(hit.status, 200);
        assert_eq!(hit.body["content_is_untrusted_data"], true);
        assert_eq!(hit.body["data"], json!([{ "id": "p1", "title": "Project plan" }]), "the trashed page must not appear");
        let page = handle(&c, &req("GET", "/v1/pages/p1", Some(&reader)), PORT);
        assert_eq!(page.body["data"]["text"], "launch the zebra project in spring");
        assert_eq!(handle(&c, &req("GET", "/v1/pages/p2", Some(&reader)), PORT).status, 404);
        assert_eq!(handle(&c, &req("GET", "/v1/search?q=", Some(&reader)), PORT).status, 400);
        assert_eq!(handle(&c, &req("GET", "/v1/search?q=%22OR%201%3D1", Some(&reader)), PORT).status, 200, "quotes and operators are treated as plain text");
    }
    #[test]
    fn database_reads_need_their_own_scope_and_404_for_non_databases() {
        let c = fresh();
        let notes = token(&c, &["notes:read"]);
        let dbs = token(&c, &["databases:read"]);
        assert_eq!(handle(&c, &req("GET", "/v1/databases/p1", Some(&notes)), PORT).status, 403);
        assert_eq!(handle(&c, &req("GET", "/v1/databases/p1", Some(&dbs)), PORT).status, 404);
        c.execute("INSERT INTO databases(page_id) VALUES('p1')", []).unwrap();
        let ok = handle(&c, &req("GET", "/v1/databases/p1", Some(&dbs)), PORT);
        assert_eq!(ok.status, 200);
        assert_eq!(ok.body["data"]["title"], "Project plan");
    }
    #[test]
    fn proposing_queues_a_request_and_never_changes_notes() {
        let c = fresh();
        let w = token(&c, &["notes:write"]);
        let read_only = token(&c, &["notes:read"]);
        let mut r = req("POST", "/v1/proposals", Some(&w));
        r.body = json!({ "op": "create_page", "payload": { "title": "From AI" }, "summary": "Make a page" }).to_string().into_bytes();
        let made = handle(&c, &r, PORT);
        assert_eq!(made.status, 201);
        assert_eq!(made.body["status"], "pending");
        let pages_before: i64 = c.query_row("SELECT COUNT(*) FROM pages WHERE system_key IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(pages_before, 2, "a proposal must not create the page");
        assert_eq!(handle(&c, &r, PORT).status, 200, "the same request again returns the existing proposal");
        let mut denied = r.clone();
        denied.authorization = Some(format!("Bearer {read_only}"));
        assert_eq!(handle(&c, &denied, PORT).status, 403);
        let mut bad = r.clone(); bad.body = b"not json".to_vec();
        assert_eq!(handle(&c, &bad, PORT).status, 400);
        let mut missing = r.clone(); missing.body = json!({ "op": "create_page" }).to_string().into_bytes();
        assert_eq!(handle(&c, &missing, PORT).status, 400);
        let mut unknown = r.clone(); unknown.body = json!({ "op": "drop_table", "payload": {}, "summary": "x" }).to_string().into_bytes();
        assert_eq!(handle(&c, &unknown, PORT).status, 400);
    }
    #[test]
    fn a_client_only_sees_the_status_of_its_own_proposals() {
        let c = fresh();
        let a = token(&c, &["notes:write"]);
        let b = token(&c, &["notes:write"]);
        let mut r = req("POST", "/v1/proposals", Some(&a));
        r.body = json!({ "op": "create_page", "payload": { "title": "x" }, "summary": "s" }).to_string().into_bytes();
        let id = handle(&c, &r, PORT).body["id"].as_str().unwrap().to_string();
        assert_eq!(handle(&c, &req("GET", &format!("/v1/proposals/{id}"), Some(&a)), PORT).body["status"], "pending");
        assert_eq!(handle(&c, &req("GET", &format!("/v1/proposals/{id}"), Some(&b)), PORT).status, 404);
        gateway::decide(&c, &id, true).unwrap();
        assert_eq!(handle(&c, &req("GET", &format!("/v1/proposals/{id}"), Some(&a)), PORT).body["status"], "approved");
    }
    #[test]
    fn the_api_is_off_by_default_and_a_bad_config_file_falls_back_to_that() {
        let dir = std::env::temp_dir().join(format!("nou-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gateway.json");
        assert!(!read_config(&path).enabled);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_config(&path), ApiConfig::default());
        write_config(&path, &ApiConfig { enabled: true, port: 50000 }).unwrap();
        assert_eq!(read_config(&path), ApiConfig { enabled: true, port: 50000 });
        std::fs::write(&path, "{\"enabled\":true,\"port\":80}").unwrap();
        assert_eq!(read_config(&path).port, DEFAULT_PORT, "privileged ports are not accepted");
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn unknown_routes_and_methods_are_rejected() {
        let c = fresh();
        let t = token(&c, &["notes:read"]);
        assert_eq!(handle(&c, &req("GET", "/v1/nothing", Some(&t)), PORT).status, 404);
        assert_eq!(handle(&c, &req("DELETE", "/v1/pages/p1", Some(&t)), PORT).status, 405);
        assert_eq!(handle(&c, &req("PUT", "/v1/pages/p1", Some(&t)), PORT).status, 405);
        assert_eq!(parse_query("q=a%20b+c&x=%E3%81%82").get("q").unwrap(), "a b c");
        assert_eq!(parse_query("x=%E3%81%82").get("x").unwrap(), "あ");
    }
    #[test]
    fn the_listener_answers_over_a_real_socket_and_stops_when_asked() {
        use std::io::{Read, Write};
        let conn = Arc::new(Mutex::new(fresh()));
        let secret = token(&conn.lock().unwrap(), &["notes:read"]);
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Arc<dyn Fn(&ApiRequest, u16) -> ApiResponse + Send + Sync> = { let conn = conn.clone(); Arc::new(move |r, p| handle(&conn.lock().unwrap(), r, p)) };
        let thread = { let stop = stop.clone(); std::thread::spawn(move || serve(server, stop, port, handler)) };
        let ask = |extra: &str| -> String {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            write!(s, "GET /v1/search?q=zebra HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Connection: close\r\n\r\n").unwrap();
            let mut out = String::new(); let _ = s.read_to_string(&mut out); out
        };
        let ok = ask(&format!("Authorization: Bearer {secret}\r\n"));
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains("Project plan") && ok.to_lowercase().contains("x-content-type-options: nosniff"));
        assert!(ask("").starts_with("HTTP/1.1 401"));
        assert!(ask(&format!("Authorization: Bearer {secret}\r\nOrigin: https://evil.example\r\n")).starts_with("HTTP/1.1 403"));
        stop.store(true, Ordering::SeqCst);
        thread.join().unwrap();
    }
    #[test]
    fn the_chat_endpoints_need_their_scopes_sign_with_the_token_name_and_mark_everything_as_untrusted() {
        let c = fresh();
        let none = token(&c, &["notes:read"]);
        assert_eq!(handle(&c, &req("GET", "/v1/chat", Some(&none)), PORT).status, 403);
        let mut post = req("POST", "/v1/chat", Some(&none)); post.body = json!({ "body": "hi" }).to_string().into_bytes();
        assert_eq!(handle(&c, &post, PORT).status, 403);
        let w = token(&c, &["chat:read", "chat:write"]);
        let mut ok = req("POST", "/v1/chat", Some(&w)); ok.body = json!({ "body": "  hello team
" }).to_string().into_bytes();
        let sent = handle(&c, &ok, PORT);
        assert_eq!(sent.status, 201);
        assert_eq!(sent.body["author"], "t", "the author is the token's name, never something the client chooses");
        let mut forged = req("POST", "/v1/chat", Some(&w)); forged.body = json!({ "body": "x", "author": "You", "kind": "owner" }).to_string().into_bytes();
        assert_eq!(handle(&c, &forged, PORT).status, 201);
        let got = handle(&c, &req("GET", "/v1/chat", Some(&w)), PORT);
        assert_eq!(got.status, 200);
        assert_eq!(got.body["content_is_untrusted_data"], true);
        let list = got.body["data"].as_array().unwrap();
        assert_eq!(list.len(), 2); assert!(list.iter().all(|m| m["kind"] == "assistant" && m["author"] == "t"));
        assert_eq!(list[0]["body"], "hello team");
        let first = list[0]["id"].as_i64().unwrap();
        let newer = handle(&c, &req("GET", &format!("/v1/chat?after={first}"), Some(&w)), PORT);
        assert_eq!(newer.body["data"].as_array().unwrap().len(), 1);
        for bad in [json!({}), json!({ "body": 5 }), json!({ "body": "   " })] {
            let mut r = req("POST", "/v1/chat", Some(&w)); r.body = bad.to_string().into_bytes();
            assert_eq!(handle(&c, &r, PORT).status, 400);
        }
        let mut junk = req("POST", "/v1/chat", Some(&w)); junk.body = b"not json".to_vec();
        assert_eq!(handle(&c, &junk, PORT).status, 400);
        let mut flood = req("POST", "/v1/chat", Some(&w)); flood.body = json!({ "body": "spam" }).to_string().into_bytes();
        let mut last = 0; for _ in 0..30 { last = handle(&c, &flood, PORT).status; }
        assert_eq!(last, 429);
    }
}

#[cfg(test)]
mod hub_tests {
    use super::*;
    const PORT: u16 = 47651;
    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        c
    }
    fn secret(c: &Connection, name: &str, scopes: &[&str]) -> String { gateway::create_token(c, name, &scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap().secret }
    fn call(c: &Connection, method: &str, path: &str, token: &str, body: Option<Value>) -> ApiResponse {
        let (p, q) = path.split_once('?').map(|(a, b)| (a.to_string(), parse_query(b))).unwrap_or((path.to_string(), HashMap::new()));
        handle(c, &ApiRequest { method: method.into(), path: p, query: q, authorization: Some(format!("Bearer {token}")), host: Some(format!("127.0.0.1:{PORT}")), origin: None, body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default() }, PORT)
    }
    const ALL: [&str; 6] = ["chat:read", "chat:write", "queue:read", "queue:write", "notes:read", "databases:read"];

    #[test]
    fn a_bot_posts_a_message_a_hand_off_and_an_approval_to_a_room_and_each_comes_back_in_its_own_shape() {
        let c = fresh(); let claude = secret(&c, "Claude", &ALL);
        crate::chat::create_room(&c, "DraftBot").unwrap();
        let m = call(&c, "POST", "/v1/chat", &claude, Some(json!({ "body": "Splitting it in three.", "room": "draftbot", "role": "router" })));
        assert_eq!((m.status, m.body["type"].as_str(), m.body["room"].as_str()), (201, Some("message"), Some("draftbot")));
        let h = call(&c, "POST", "/v1/chat", &claude, Some(json!({ "type": "handoff", "room": "draftbot", "to": "ChatGPT", "task_ref": "C# dimension component", "body": "Handed over" })));
        assert_eq!(h.status, 201);
        let a = call(&c, "POST", "/v1/chat", &claude, Some(json!({ "type": "approval", "room": "draftbot", "body": "Spec is ready. Approve it?", "queue_title": "Approve dimension spec" })));
        assert_eq!(a.status, 201); assert!(a.body["queue_item_id"].is_i64());
        let got = call(&c, "GET", "/v1/chat?room=draftbot", &claude, None);
        assert_eq!(got.body["content_is_untrusted_data"], true);
        let items = got.body["data"].as_array().unwrap();
        assert_eq!(items.iter().map(|i| i["type"].as_str().unwrap()).collect::<Vec<_>>(), vec!["message", "handoff", "approval"]);
        assert_eq!((items[0]["author"].as_str(), items[0]["role"].as_str()), (Some("Claude"), Some("ROUTER")));
        assert_eq!((items[1]["from"].as_str(), items[1]["to"].as_str(), items[1]["task_ref"].as_str()), (Some("Claude"), Some("ChatGPT"), Some("C# dimension component")), "the sender of a hand-off is the token, not a field");
        assert_eq!((items[2]["approval"].as_str(), items[2]["queue_item_id"].is_i64()), (Some("open"), true));
        assert!(call(&c, "GET", "/v1/chat", &claude, None).body["data"].as_array().unwrap().is_empty(), "General has none of them");
        assert_eq!(call(&c, "GET", "/v1/chat?room=nowhere", &claude, None).status, 404);
        assert_eq!(call(&c, "POST", "/v1/chat", &claude, Some(json!({ "body": "x", "room": "nowhere" }))).status, 404, "a bot cannot make a room by posting to it");
        assert_eq!(call(&c, "POST", "/v1/chat", &claude, Some(json!({ "body": "x", "type": "poll" }))).status, 400);
        assert_eq!(call(&c, "POST", "/v1/chat", &claude, Some(json!({ "type": "handoff", "body": "x" }))).status, 400, "a hand-off needs someone to hand over to");
        let rooms = call(&c, "GET", "/v1/rooms", &claude, None); assert_eq!(rooms.body["data"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn an_approval_needs_the_queue_scope_too_and_the_bot_learns_the_decision_through_the_queue() {
        let c = fresh(); let chat_only = secret(&c, "Chatty", &["chat:read", "chat:write"]); let claude = secret(&c, "Claude", &ALL);
        let denied = call(&c, "POST", "/v1/chat", &chat_only, Some(json!({ "type": "approval", "body": "ok?" })));
        assert_eq!(denied.status, 403); assert!(denied.body["error"].as_str().unwrap().contains("queue:write"));
        let card = call(&c, "POST", "/v1/chat", &claude, Some(json!({ "type": "approval", "body": "Approve the spec?", "queue_title": "Approve spec" })));
        let (id, item) = (card.body["id"].as_i64().unwrap(), card.body["queue_item_id"].as_i64().unwrap());
        let open = call(&c, "GET", &format!("/v1/queue/{item}"), &claude, None);
        assert_eq!((open.body["data"]["item"]["status"].as_str(), open.body["data"]["approval"]["status"].as_str()), (Some("needs_nick"), Some("open")));
        // Only the owner (an app command) decides; there is no API route for it.
        assert_eq!(call(&c, "POST", &format!("/v1/chat/{id}/approve"), &claude, Some(json!({}))).status, 404);
        assert_eq!(call(&c, "PATCH", &format!("/v1/queue/{item}"), &claude, Some(json!({ "status": "done" }))).status, 409, "the bot cannot close its own card");
        crate::chat::decide_approval(&c, id, true).unwrap();
        let done = call(&c, "GET", &format!("/v1/queue/{item}"), &claude, None);
        assert_eq!((done.body["data"]["item"]["status"].as_str(), done.body["data"]["approval"]["status"].as_str()), (Some("done"), Some("approved")), "the bot sees the decision");
    }
    #[test]
    fn the_queue_endpoints_need_their_scopes_and_a_bot_can_only_change_its_own_items() {
        let c = fresh(); let a = secret(&c, "Claude", &ALL); let b = secret(&c, "ChatGPT", &ALL); let reader = secret(&c, "Reader", &["notes:read"]);
        assert_eq!(call(&c, "GET", "/v1/queue", &reader, None).status, 403); assert_eq!(call(&c, "POST", "/v1/queue", &reader, Some(json!({ "title": "x" }))).status, 403);
        let made = call(&c, "POST", "/v1/queue", &a, Some(json!({ "title": "Spec DraftBot dimension rules", "status": "running" }))); assert_eq!(made.status, 201);
        let id = made.body["id"].as_i64().unwrap();
        assert_eq!(call(&c, "PATCH", &format!("/v1/queue/{id}"), &a, Some(json!({ "status": "done" }))).body["status"], "done");
        assert_eq!(call(&c, "PATCH", &format!("/v1/queue/{id}"), &b, Some(json!({ "status": "queued" }))).status, 404, "another bot's item");
        assert_eq!(call(&c, "PATCH", &format!("/v1/queue/{id}"), &a, Some(json!({ "status": "needs_nick" }))).status, 400);
        assert_eq!(call(&c, "POST", "/v1/queue", &a, Some(json!({ "title": "x", "status": "needs_nick" }))).status, 400);
        assert_eq!(call(&c, "POST", "/v1/queue", &a, Some(json!({}))).status, 400);
        assert_eq!(call(&c, "GET", "/v1/queue?status=bogus", &a, None).status, 400);
        let list = call(&c, "GET", "/v1/queue?status=done", &b, None); assert_eq!(list.body["data"].as_array().unwrap().len(), 1); assert_eq!(list.body["content_is_untrusted_data"], true);
        assert_eq!(call(&c, "GET", "/v1/queue/999", &a, None).status, 404); assert_eq!(call(&c, "GET", "/v1/queue/abc", &a, None).status, 404);
    }
    #[test]
    fn mentioning_filters_the_room_to_what_was_handed_to_that_bot() {
        let c = fresh(); let gpt = secret(&c, "ChatGPT", &ALL);
        crate::chat::post_owner(&c, "@Claude plan the tool. @ChatGPT takes the Grasshopper side.", None).unwrap(); crate::chat::post_owner(&c, "unrelated", None).unwrap();
        let mine = call(&c, "GET", "/v1/chat?mentioning=ChatGPT", &gpt, None);
        assert_eq!(mine.body["data"].as_array().unwrap().len(), 1);
        assert_eq!(call(&c, "GET", "/v1/chat?mentioning=Kura", &gpt, None).body["data"].as_array().unwrap().len(), 0);
    }
    #[test]
    fn the_timetable_can_be_read_only_with_its_scope_and_the_listing_has_no_ids() {
        let c = fresh(); let reader = secret(&c, "Claude", &["timetable:read"]); let other = secret(&c, "Other", &ALL);
        assert_eq!(call(&c, "GET", "/v1/timetable", &other, None).status, 403, "no other scope opens it");
        let r = call(&c, "GET", "/v1/timetable", &reader, None);
        assert_eq!(r.status, 200); assert_eq!(r.body["content_is_untrusted_data"], json!(true));
        let data = &r.body["data"]; assert!(data["activities"].as_array().unwrap().len() > 3 && data["weeks"]["A"]["mon"].is_array() && data["weeks"]["B"]["sun"].is_array());
        assert!(!data.to_string().contains("\"id\""), "no ids in the listing");
        assert_eq!(call(&c, "POST", "/v1/timetable", &reader, Some(json!({}))).status, 404, "it can only be read");
    }

    #[test]
    fn habits_and_tasks_can_be_read_with_the_timetable_and_notes_read_scopes_without_ids() {
        let c = fresh(); let tt = secret(&c, "Claude", &["timetable:read"]); let notes = secret(&c, "Notes", &["notes:read"]);
        crate::habits::habit_add(&c, "Reading", Some(31), Some("Leisure")).unwrap();
        crate::todos::create(&c, "Call Sam").unwrap(); crate::todos::create(&c, "Water plants").unwrap();
        assert_eq!(call(&c, "GET", "/v1/habits", &notes, None).status, 403); assert_eq!(call(&c, "GET", "/v1/todos", &tt, None).status, 403);
        let h = call(&c, "GET", "/v1/habits", &tt, None); assert_eq!(h.status, 200);
        let row = &h.body["data"].as_array().unwrap().iter().find(|x| x["name"] == "Reading").unwrap().clone();
        assert_eq!((row["type"].clone(), row["days"].clone(), row["done_last_14_days"].clone()), (json!("Leisure"), json!(["Mon", "Tue", "Wed", "Thu", "Fri"]), json!(0)));
        assert!(!h.body["data"].to_string().contains("\"id\""));
        let t = call(&c, "GET", "/v1/todos", &notes, None); assert_eq!(t.status, 200);
        assert_eq!(t.body["data"], json!([{ "text": "Call Sam", "done": false }, { "text": "Water plants", "done": false }]));
        assert_eq!(call(&c, "POST", "/v1/habits", &tt, Some(json!({}))).status, 404, "read only");
    }
}
