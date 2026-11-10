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
        ("GET", ["v1", "pages", id]) => {
            if let Err(r) = needs(&who, "notes:read") { return r; }
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
                Ok(p) => reply(if p.existing { 200 } else { 201 }, json!({ "id": p.id, "existing": p.existing, "status": "pending", "note": "A person must approve this in NOU before anything changes." })),
                Err(m) if m.contains("lacks") => fail(403, &m),
                Err(m) if m.starts_with("Too many") => fail(429, &m),
                Err(m) => fail(400, &m),
            }
        }
        ("GET", ["v1", "proposals", id]) => {
            // A client may only look at its own proposals.
            match gateway::get_proposal(c, id) {
                Ok(p) if p.token_id == who.id => reply(200, json!({ "id": p.id, "op": p.op, "status": p.status, "result": p.result, "decided_at": p.decided_at })),
                _ => fail(404, "Proposal not found"),
            }
        }
        ("GET" | "POST", _) => fail(404, "Unknown endpoint"),
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
        if req.method == "POST" && db.writable().is_err() { return fail(503, "NOU is waiting for you to review a restore; try again later"); }
        let guard = db.0.lock();
        let out = match &guard { Ok(c) => handle_request(c, req, p), Err(_) => fail(500, "The database is unavailable") };
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
        let pages_before: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
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
}
