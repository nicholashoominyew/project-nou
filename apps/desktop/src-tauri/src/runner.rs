//! The built-in bot runner: while NOU is open (and its Local API is on), a small Node program watches the Bots Hub for tags and starts the bots
//! that were tagged. It is `tools/nou-claude/nou-claude.mjs`, embedded in the app and written to `<profile>/runner/` so the packaged app, which has no
//! tools folder, can run it. Every rule of the approval gateway still holds: the bots only post, queue and PROPOSE through their own tokens; only the
//! owner approves, in the app; and no token secret is ever written to a file, the log, the audit log or any screen.
//!
//! Tokens: two are minted in this process each time the runner starts ("Claude" and the shared "NOU relay") and their secrets live only in memory and in
//! the child's environment. Their ids are recorded in `runner.json`. Revoking a token cancels its pending proposals, so an old runner token is revoked
//! only when it has nothing pending or approved; otherwise it is left for a later start.
use crate::{gateway, gateway_http, Db};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

/// The two programs, built into the app.
const RUNNER_JS: &str = include_str!("../../../../tools/nou-claude/nou-claude.mjs");
const MCP_JS: &str = include_str!("../../../../tools/nou-mcp/nou-mcp.mjs");

const CLAUDE_TOKEN: &str = "Claude";
const RELAY_TOKEN: &str = "NOU relay";
const CLAUDE_SCOPES: [&str; 11] = ["notes:read", "databases:read", "notes:write", "databases:write", "chat:read", "chat:write", "queue:read", "queue:write", "timetable:read", "timetable:write", "home:write"];
const RELAY_SCOPES: [&str; 4] = ["chat:read", "chat:write", "queue:read", "queue:write"];

const LOG_CAP: u64 = 1_000_000;
const LOG_KEEP: u64 = 500_000;
const TAIL_BYTES: u64 = 8_000;
const PROBE_TTL: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const STOP_GRACE: Duration = Duration::from_secs(3);

// ---- the bots ----
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct BotInfo { pub name: &'static str, pub kind: &'static str, pub note: &'static str }
/// The bots the runner knows about. Kura is listed only so Claude knows it exists; the runner never polls or starts it.
pub const BOTS: [BotInfo; 4] = [
    BotInfo { name: "Claude", kind: "claude", note: "Starts Claude Code, replies and proposes" },
    BotInfo { name: "Kura", kind: "external", note: "Polls NOU itself, nothing to start here" },
    BotInfo { name: "xGrok", kind: "relay", note: "Adds a ready-to-paste card for you to send" },
    BotInfo { name: "GrokBots", kind: "relay", note: "Adds a ready-to-paste card for you to send" },
];
/// The generated `nou-bots.json`. It holds no secret: each bot only names the environment variable its token is passed in.
pub fn bots_json() -> Value {
    let list: Vec<Value> = BOTS.iter().map(|b| match b.kind {
        "claude" => json!({ "name": b.name, "tokenEnv": "NOU_TOKEN", "type": "claude", "allowFrom": [] }),
        "relay" => json!({ "name": b.name, "tokenEnv": "NOU_TOKEN_RELAY", "type": "relay", "allowFrom": ["Claude"] }),
        _ => json!({ "name": b.name, "type": b.kind }),
    }).collect();
    json!({ "bots": list })
}

// ---- settings: <profile>/runner.json ----
/// Whether the owner turned the runner on (default off) and the ids of the tokens minted for it (ids only, never secrets).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct RunnerConfig {
    #[serde(default)] pub enabled: bool,
    #[serde(default)] pub token_ids: Vec<String>,
}
/// Read tolerantly: a missing, empty or damaged file means "off, no tokens".
pub fn read_config(path: &Path) -> RunnerConfig { fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default() }
/// Write atomically (a temporary file in the same folder, then a rename), so a crash can never leave half a file.
pub fn write_config(path: &Path, cfg: &RunnerConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> { let mut f = fs::File::create(&tmp)?; f.write_all(text.as_bytes())?; f.sync_all()?; fs::rename(&tmp, path) })();
    if let Err(e) = result { let _ = fs::remove_file(&tmp); return Err(format!("Could not save the runner setting: {e}")); }
    Ok(())
}

// ---- files in <profile>/runner/ ----
pub struct Paths { pub config: PathBuf, pub dir: PathBuf, pub script: PathBuf, pub mcp: PathBuf, pub bots: PathBuf, pub state: PathBuf, pub log: PathBuf }
pub fn paths(data: &Path) -> Paths {
    let dir = data.join("runner");
    Paths { config: data.join("runner.json"), script: dir.join("nou-claude.mjs"), mcp: dir.join("nou-mcp.mjs"), bots: dir.join("nou-bots.json"), state: dir.join(".nou-bots-state.json"), log: dir.join("runner.log"), dir }
}
/// Write the embedded programs and the generated bots file. Nothing secret is written.
pub fn install_files(p: &Paths) -> Result<(), String> {
    fs::create_dir_all(&p.dir).map_err(|e| format!("Could not create the runner folder: {e}"))?;
    let put = |path: &Path, text: &str| fs::write(path, text).map_err(|e| format!("Could not write {}: {e}", path.display()));
    put(&p.script, RUNNER_JS)?; put(&p.mcp, MCP_JS)?;
    put(&p.bots, &serde_json::to_string_pretty(&bots_json()).map_err(|e| e.to_string())?)
}

// ---- tokens ----
/// The secrets exist only here and in the child's environment. Deliberately not Debug or Serialize.
pub struct Minted { pub claude_id: String, pub claude_secret: String, pub relay_id: String, pub relay_secret: String }
pub fn mint_tokens(c: &Connection) -> Result<Minted, String> {
    let scopes = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let claude = gateway::create_token(c, CLAUDE_TOKEN, &scopes(&CLAUDE_SCOPES))?;
    let relay = gateway::create_token(c, RELAY_TOKEN, &scopes(&RELAY_SCOPES))?;
    Ok(Minted { claude_id: claude.info.id, claude_secret: claude.secret, relay_id: relay.info.id, relay_secret: relay.secret })
}
fn has_open_proposals(c: &Connection, id: &str) -> Result<bool, String> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM proposals WHERE token_id=?1 AND status IN ('pending','approved'))", [id], |r| r.get(0)).map_err(|e| e.to_string())
}
/// Revoke the old runner tokens that have nothing waiting, and return the ids that must be kept for later. Revoking cancels pending proposals, so a token with a
/// pending or approved proposal is left alone; an id whose token is already revoked (or gone) is dropped.
pub fn retire_idle(c: &Connection, ids: &[String]) -> Result<Vec<String>, String> {
    let mut keep = Vec::new();
    for id in ids {
        let state: Option<bool> = c.query_row("SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=?1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        match state {
            None | Some(true) => continue,
            Some(false) if has_open_proposals(c, id)? => keep.push(id.clone()),
            Some(false) => gateway::revoke_token(c, id)?,
        }
    }
    Ok(keep)
}
/// Start of a run: retire the idle old tokens, mint two new ones. Returns them and the ids to record (the ones kept, then the new ones).
pub fn begin_run(c: &Connection, recorded: &[String]) -> Result<(Minted, Vec<String>), String> {
    let mut ids = retire_idle(c, recorded)?;
    let minted = mint_tokens(c)?;
    ids.push(minted.claude_id.clone()); ids.push(minted.relay_id.clone());
    Ok((minted, ids))
}
/// What is written to the audit log. Ids and names only, never a secret.
pub fn audit_event(c: &Connection, actor: &str, action: &str, detail: Value) { let _ = gateway::audit(c, actor, action, detail); }

// ---- running the program ----
/// The environment the runner gets. The secrets are passed only here, never on the command line or in a file.
pub fn child_env(p: &Paths, port: u16, m: &Minted) -> Vec<(String, String)> {
    let s = |p: &Path| p.to_string_lossy().to_string();
    vec![
        ("NOU_API_URL".into(), format!("http://127.0.0.1:{port}")),
        ("NOU_BOTS_FILE".into(), s(&p.bots)), ("NOU_MCP_PATH".into(), s(&p.mcp)), ("NOU_CLAUDE_STATE".into(), s(&p.state)),
        ("NOU_RUNNER_PARENT_PIPE".into(), "1".into()),
        ("NOU_TOKEN".into(), m.claude_secret.clone()), ("NOU_TOKEN_RELAY".into(), m.relay_secret.clone()),
    ]
}
/// Replace every secret in a line of output with a marker (the runner never prints one; this is a second lock on the door).
pub fn redact(line: &str, secrets: &[String]) -> String {
    let mut out = line.to_string();
    for s in secrets.iter().filter(|s| s.len() >= 8) { out = out.replace(s.as_str(), "[token]"); }
    out
}
fn clock() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) % 86_400;
    format!("{:02}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
}
static LOG_LOCK: Mutex<()> = Mutex::new(());
/// Keep the tail of an over-long log: about 1 MB is the cap, about half is kept, starting at a line.
pub fn trim_log(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= LOG_CAP { return; }
    let Ok(bytes) = fs::read(path) else { return };
    let from = bytes.len().saturating_sub(LOG_KEEP as usize);
    let start = bytes[from..].iter().position(|b| *b == b'\n').map(|i| from + i + 1).unwrap_or(from);
    let _ = fs::write(path, &bytes[start..]);
}
fn append_log(path: &Path, line: &str) {
    let _guard = LOG_LOCK.lock();
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) { let _ = writeln!(f, "{line}"); }
    trim_log(path);
}
/// The last part of the log, from the start of a line.
pub fn log_tail(path: &Path) -> String {
    let Ok(mut f) = fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(TAIL_BYTES);
    if std::io::Seek::seek(&mut f, std::io::SeekFrom::Start(from)).is_err() { return String::new(); }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() { return String::new(); }
    let text = String::from_utf8_lossy(&buf).to_string();
    if from > 0 { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { text }
}

/// A started runner process. Its stdin is held open: that is the "parent pipe" the runner watches, so it stops when NOU does, even after a crash.
pub struct Handle { child: Child, stdin: Option<ChildStdin>, pub minted_ids: Vec<String> }
impl Handle {
    pub fn pid(&self) -> u32 { self.child.id() }
    /// Still running? (Reads the exit status if it has finished.)
    pub fn exited(&mut self) -> Option<std::process::ExitStatus> { self.child.try_wait().ok().flatten() }
    /// Close the pipe so the runner stops its bot processes and exits by itself; if it has not within a few seconds, end it and everything it started.
    pub fn terminate(&mut self) {
        drop(self.stdin.take());
        let end = Instant::now() + STOP_GRACE;
        while Instant::now() < end { if self.exited().is_some() { return; } std::thread::sleep(Duration::from_millis(50)); }
        #[cfg(windows)]
        { let mut k = Command::new("taskkill"); k.args(["/PID", &self.child.id().to_string(), "/T", "/F"]); hide(&mut k); let _ = k.output(); }
        let _ = self.child.kill(); let _ = self.child.wait();
    }
}
#[cfg(windows)]
fn hide(c: &mut Command) { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); } // CREATE_NO_WINDOW, as in background_task.rs
#[cfg(not(windows))]
fn hide(_: &mut Command) {}

/// Start `program script` with the given environment, stdin piped and held open, output into the log (secrets removed).
pub fn spawn_child(program: &str, script: &Path, env: Vec<(String, String)>, log: &Path, secrets: Vec<String>) -> Result<Handle, String> {
    let mut cmd = Command::new(program);
    cmd.arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in &env { cmd.env(k, v); }
    hide(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {program}: {e}"))?;
    let stdin = child.stdin.take();
    let secrets_shared = Arc::new(secrets.clone());
    append_log(log, &format!("[{}] Runner starting (process {}).", clock(), child.id()));
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)].into_iter().flatten() {
        let (log, secrets) = (log.to_path_buf(), secrets_shared.clone());
        std::thread::spawn(move || { for line in BufReader::new(pipe).lines().map_while(Result::ok) { append_log(&log, &format!("[{}] {}", clock(), redact(&line, &secrets))); } });
    }
    Ok(Handle { child, stdin, minted_ids: Vec::new() })
}

// ---- checks: is Node there, is the Claude Code CLI there ----
/// Run a program quietly and return its first line of output, or None if it is missing, fails or takes too long.
fn probe(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    hide(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let end = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait().ok()? {
            Some(status) => {
                if !status.success() { return None; }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return out.lines().next().map(|l| l.trim().to_string());
            }
            None if Instant::now() >= end => { let _ = child.kill(); let _ = child.wait(); return None; }
            None => std::thread::sleep(Duration::from_millis(30)),
        }
    }
}
/// "v22.1.0" gives 22.
pub fn parse_node_major(text: &str) -> Option<u32> { text.trim().trim_start_matches('v').split('.').next()?.parse().ok() }
pub fn node_ok() -> bool { probe("node", &["--version"]).and_then(|v| parse_node_major(&v)).is_some_and(|m| m >= 18) }
/// `claude` is a script (claude.cmd) on Windows, which only the command shell can run.
pub fn claude_ok() -> bool {
    #[cfg(windows)] { probe("cmd", &["/d", "/s", "/c", "claude --version"]).is_some() }
    #[cfg(not(windows))] { probe("claude", &["--version"]).is_some() }
}

// ---- state kept by the app ----
#[derive(Default)]
pub struct RunnerState { handle: Mutex<Option<Handle>>, probes: Mutex<Option<(Instant, bool, bool)>>, last_error: Mutex<Option<String>> }
impl RunnerState {
    fn set_error(&self, message: Option<String>) { if let Ok(mut e) = self.last_error.lock() { *e = message; } }
    /// Node and Claude Code checks, remembered for 30 seconds (the Claude Code check can take a second or two).
    fn probes(&self, force: bool) -> (bool, bool) {
        if let Ok(slot) = self.probes.lock() { if let Some((at, n, c)) = *slot { if !force && at.elapsed() < PROBE_TTL { return (n, c); } } }
        let (n, c) = (node_ok(), claude_ok());
        if let Ok(mut slot) = self.probes.lock() { *slot = Some((Instant::now(), n, c)); }
        (n, c)
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> { crate::data_dir(app.path()).map_err(|e| e.to_string()) }
fn api_on(app: &AppHandle) -> bool { app.try_state::<gateway_http::ApiServer>().and_then(|s| s.0.lock().ok().map(|g| g.is_some())).unwrap_or(false) }

/// Start the runner if it should run: the owner switched it on AND the Local API is on. Never starts a second one.
fn start(app: &AppHandle) -> Result<(), String> {
    let data = data_dir(app)?; let p = paths(&data);
    let state = app.state::<RunnerState>();
    let mut slot = state.handle.lock().map_err(|_| "Runner state lock poisoned".to_string())?;
    if let Some(h) = slot.as_mut() { if h.exited().is_none() { return Ok(()); } slot.take(); }
    let db = app.state::<Db>();
    db.writable()?; // a restore waits for review: nothing may write until it is dealt with
    if !state.probes(true).0 { return Err("Node.js 18 or newer was not found. Install it from nodejs.org, then switch the runner off and on again.".into()); }
    install_files(&p)?;
    let _ = fs::remove_file(&p.state); // a fresh start never replays old tags: it begins after the newest message
    let port = gateway_http::read_config(&data.join("gateway.json")).port;
    let mut cfg = read_config(&p.config);
    let minted = { let c = db.0.lock().map_err(|_| "Database lock poisoned".to_string())?;
        let (m, ids) = begin_run(&c, &cfg.token_ids)?; cfg.token_ids = ids; write_config(&p.config, &cfg)?; m };
    let env = child_env(&p, port, &minted);
    let secrets = vec![minted.claude_secret.clone(), minted.relay_secret.clone()];
    let mut handle = spawn_child("node", &p.script, env, &p.log, secrets)?;
    handle.minted_ids = vec![minted.claude_id.clone(), minted.relay_id.clone()];
    if let Ok(c) = db.0.lock() { audit_event(&c, "runner", "runner.started", json!({ "pid": handle.pid(), "claude_token_id": minted.claude_id, "relay_token_id": minted.relay_id })); }
    *slot = Some(handle);
    state.set_error(None);
    Ok(())
}
/// Stop the runner and its bots. With `tidy`, also revoke the tokens it used if nothing of theirs is waiting.
fn stop(app: &AppHandle, tidy: bool) {
    let Some(state) = app.try_state::<RunnerState>() else { return };
    let taken = state.handle.lock().ok().and_then(|mut s| s.take());
    let Some(mut handle) = taken else { return };
    handle.terminate();
    let Some(db) = app.try_state::<Db>() else { return };
    // At exit the database lock is only tried, never waited for.
    let guard = if tidy { db.0.lock().ok() } else { db.0.try_lock().ok() };
    if let Some(c) = guard {
        audit_event(&c, "runner", "runner.stopped", json!({ "claude_token_id": handle.minted_ids.first(), "relay_token_id": handle.minted_ids.get(1) }));
        if tidy && db.writable().is_ok() {
            if let Ok(data) = data_dir(app) { let p = paths(&data); let mut cfg = read_config(&p.config);
                if let Ok(keep) = retire_idle(&c, &cfg.token_ids) { cfg.token_ids = keep; let _ = write_config(&p.config, &cfg); } }
        }
    }
}
/// Make the runner match the settings: running exactly when it is switched on and the Local API is on. Called at startup and whenever either switch changes.
pub fn sync(app: &AppHandle, api_is_on: bool) -> Result<(), String> {
    let on = data_dir(app).map(|d| read_config(&paths(&d).config).enabled).unwrap_or(false);
    let state = app.state::<RunnerState>();
    if on && api_is_on {
        let result = start(app);
        if let Err(e) = &result { state.set_error(Some(e.clone())); }
        result
    } else { stop(app, true); state.set_error(None); Ok(()) }
}
/// Called from `setup()` after the Local API has been started.
pub fn start_if_enabled(app: &AppHandle) { if let Err(e) = sync(app, api_on(app)) { eprintln!("Bot runner not started: {e}"); } }
/// Called when NOU exits: stop the runner and its bots.
pub fn shutdown(app: &AppHandle) { stop(app, false); }

#[derive(Serialize)]
pub struct RunnerStatus { enabled: bool, running: bool, api_on: bool, port: u16, node_ok: bool, claude_ok: bool, bots: Vec<BotInfo>, log_tail: String, last_error: Option<String> }
fn status(app: &AppHandle, force_probe: bool) -> Result<RunnerStatus, String> {
    let data = data_dir(app)?; let p = paths(&data);
    let state = app.state::<RunnerState>();
    let running = {
        let mut slot = state.handle.lock().map_err(|_| "Runner state lock poisoned".to_string())?;
        match slot.as_mut().map(|h| h.exited()) {
            Some(Some(code)) => { slot.take(); state.set_error(Some(format!("The runner stopped by itself ({code}). The log below says why. Switch it off and on to try again."))); false }
            Some(None) => true,
            None => false,
        }
    };
    let (node, claude) = state.probes(force_probe);
    let last_error = state.last_error.lock().ok().and_then(|e| e.clone());
    Ok(RunnerStatus { enabled: read_config(&p.config).enabled, running, api_on: api_on(app), port: gateway_http::read_config(&data.join("gateway.json")).port, node_ok: node, claude_ok: claude, bots: BOTS.to_vec(), log_tail: log_tail(&p.log), last_error })
}

#[tauri::command]
pub async fn runner_status(app: AppHandle) -> Result<RunnerStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app, false)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn runner_set_enabled(app: AppHandle, db: State<'_, Db>, enabled: bool) -> Result<RunnerStatus, String> {
    // Refuse early, with a clear message, while a restore waits for review.
    db.writable()?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let data = data_dir(&handle)?; let p = paths(&data);
        let mut cfg = read_config(&p.config);
        cfg.enabled = enabled;
        write_config(&p.config, &cfg)?;
        if let Some(db) = handle.try_state::<Db>() { if let Ok(c) = db.0.lock() { audit_event(&c, "owner", if enabled { "runner.enabled" } else { "runner.disabled" }, json!({})); } }
        // A failure to start (Node missing, for example) is shown in the status, not thrown: the switch is still on.
        let _ = sync(&handle, api_on(&handle));
        status(&handle, true)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(include_str!("../../../../db/notes/001_initial.sql")).unwrap();
        c.execute("INSERT INTO workspaces(id,title) VALUES('personal','Personal')", []).unwrap();
        crate::editor::upgrade(&c).unwrap();
        c
    }
    fn tmp() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("nou-runner-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d); fs::create_dir_all(&d).unwrap(); d
    }
    fn everything_in(c: &Connection) -> String {
        let mut text = serde_json::to_string(&gateway::list_tokens(c).unwrap()).unwrap();
        text += &serde_json::to_string(&gateway::recent_audit(c, 500).unwrap()).unwrap();
        text
    }
    fn revoked(c: &Connection, id: &str) -> bool { c.query_row("SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=?1", [id], |r| r.get(0)).unwrap() }

    #[test]
    fn the_generated_bots_file_lists_the_four_bots_and_holds_no_secret() {
        let v = bots_json(); let bots = v["bots"].as_array().unwrap();
        assert_eq!(bots.iter().map(|b| (b["name"].as_str().unwrap(), b["type"].as_str().unwrap())).collect::<Vec<_>>(), vec![("Claude", "claude"), ("Kura", "external"), ("xGrok", "relay"), ("GrokBots", "relay")]);
        assert_eq!(bots[0]["tokenEnv"], "NOU_TOKEN"); assert_eq!(bots[0]["allowFrom"], json!([]));
        assert!(bots[1].get("tokenEnv").is_none(), "Kura has no token here: the runner never polls it");
        for relay in &bots[2..] { assert_eq!((relay["tokenEnv"].as_str(), &relay["allowFrom"]), (Some("NOU_TOKEN_RELAY"), &json!(["Claude"]))); }
        let text = v.to_string(); assert!(!text.contains("nou_") && !text.to_lowercase().contains("secret"));
        assert_eq!(BOTS.iter().map(|b| b.note).filter(|n| n.is_empty()).count(), 0, "every bot has a one-line note for the screen");
    }

    #[test]
    fn settings_default_to_off_are_read_tolerantly_and_written_atomically() {
        let dir = tmp(); let path = dir.join("runner.json");
        assert_eq!(read_config(&path), RunnerConfig { enabled: false, token_ids: vec![] }, "no file: off");
        fs::write(&path, "").unwrap(); assert!(!read_config(&path).enabled, "empty file: off");
        fs::write(&path, "{ not json").unwrap(); assert!(!read_config(&path).enabled, "damaged file: off");
        fs::write(&path, r#"{"enabled": true}"#).unwrap(); assert_eq!(read_config(&path), RunnerConfig { enabled: true, token_ids: vec![] }, "token_ids may be missing");
        fs::write(&path, r#"{"enabled": true, "token_ids": ["a"], "future": 1}"#).unwrap(); assert_eq!(read_config(&path).token_ids, vec!["a"], "unknown fields are ignored");
        fs::write(&path, r#"{"enabled": "yes"}"#).unwrap(); assert!(!read_config(&path).enabled, "a wrong type is a damaged file");
        let cfg = RunnerConfig { enabled: true, token_ids: vec!["t1".into(), "t2".into()] };
        write_config(&path, &cfg).unwrap(); assert_eq!(read_config(&path), cfg);
        assert!(!dir.join("runner.json.tmp").exists(), "the temporary file is renamed away");
        write_config(&path, &RunnerConfig::default()).unwrap(); assert_eq!(read_config(&path), RunnerConfig::default(), "it replaces an existing file");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_embedded_programs_and_bots_file_are_written_without_any_secret() {
        let dir = tmp(); let p = paths(&dir);
        let c = fresh(); let (m, _) = begin_run(&c, &[]).unwrap();
        install_files(&p).unwrap();
        assert_eq!(fs::read_to_string(&p.script).unwrap(), RUNNER_JS); assert_eq!(fs::read_to_string(&p.mcp).unwrap(), MCP_JS);
        assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(&p.bots).unwrap()).unwrap(), bots_json());
        write_config(&p.config, &RunnerConfig { enabled: true, token_ids: vec![m.claude_id.clone(), m.relay_id.clone()] }).unwrap();
        for entry in [&p.script, &p.mcp, &p.bots, &p.config] {
            let text = fs::read_to_string(entry).unwrap();
            assert!(!text.contains(&m.claude_secret) && !text.contains(&m.relay_secret), "{} holds a secret", entry.display());
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_generated_bots_file_is_accepted_by_the_real_runner() {
        if !node_ok() { eprintln!("skipped: Node.js 18 or newer is not installed here"); return; }
        let dir = tmp(); let p = paths(&dir); install_files(&p).unwrap();
        let check = dir.join("check.mjs");
        fs::write(&check, "import { pathToFileURL } from 'node:url';\nconst { config } = await import(pathToFileURL(process.env.RUNNER).href);\nconst c = config(process.env);\nconsole.log(JSON.stringify(c.bots.map(b => [b.name, b.type, b.tokenEnv, !!b.token, b.allowFrom])));").unwrap();
        let out = Command::new("node").arg(&check).env("RUNNER", &p.script).env("NOU_BOTS_FILE", &p.bots).env("NOU_API_URL", "http://127.0.0.1:47651").env("NOU_TOKEN", "t1").env("NOU_TOKEN_RELAY", "t2").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let got: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(got, json!([["Claude", "claude", "NOU_TOKEN", true, []], ["Kura", "external", "NOU_TOKEN", false, []], ["xGrok", "relay", "NOU_TOKEN_RELAY", true, ["Claude"]], ["GrokBots", "relay", "NOU_TOKEN_RELAY", true, ["Claude"]]]));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn two_tokens_are_minted_with_exactly_the_scopes_asked_and_no_secret_reaches_listings_or_the_audit_log() {
        let c = fresh(); let m = mint_tokens(&c).unwrap();
        assert!(m.claude_secret.starts_with("nou_") && m.relay_secret.starts_with("nou_") && m.claude_secret != m.relay_secret);
        let tokens = gateway::list_tokens(&c).unwrap();
        let by = |n: &str| tokens.iter().find(|t| t.name == n).unwrap();
        assert_eq!(by("Claude").scopes, CLAUDE_SCOPES.to_vec()); assert_eq!(by("NOU relay").scopes, RELAY_SCOPES.to_vec());
        assert!(!by("NOU relay").scopes.iter().any(|s| s.starts_with("notes") || s.starts_with("databases")), "the relay token cannot touch notes");
        audit_event(&c, "runner", "runner.started", json!({ "pid": 1, "claude_token_id": m.claude_id, "relay_token_id": m.relay_id }));
        audit_event(&c, "runner", "runner.stopped", json!({ "claude_token_id": m.claude_id }));
        audit_event(&c, "owner", "runner.enabled", json!({})); audit_event(&c, "owner", "runner.disabled", json!({}));
        let all = everything_in(&c);
        assert!(!all.contains(&m.claude_secret) && !all.contains(&m.relay_secret), "no secret in a token listing or the audit log");
        let actions: Vec<_> = gateway::recent_audit(&c, 50).unwrap().into_iter().rev().map(|a| a.action).collect();
        assert_eq!(actions, vec!["token.created", "token.created", "runner.started", "runner.stopped", "runner.enabled", "runner.disabled"]);
    }

    #[test]
    fn an_old_runner_token_is_revoked_only_when_nothing_of_its_is_waiting() {
        let c = fresh();
        let (run1, ids1) = begin_run(&c, &[]).unwrap();
        assert_eq!(ids1, vec![run1.claude_id.clone(), run1.relay_id.clone()]);
        // Claude proposes something and the owner has not decided yet.
        let proposal = gateway::propose(&c, &run1.claude_secret, "create_page", &json!({ "title": "Plan" }), "Create Plan").unwrap();
        // Second start: the idle relay token goes, the token with a pending proposal stays valid, and the proposal is not cancelled.
        let (run2, ids2) = begin_run(&c, &ids1).unwrap();
        assert!(revoked(&c, &run1.relay_id) && !revoked(&c, &run1.claude_id));
        assert_eq!(gateway::get_proposal(&c, &proposal.id).unwrap().status, "pending", "the pending proposal survives");
        assert_eq!(ids2, vec![run1.claude_id.clone(), run2.claude_id.clone(), run2.relay_id.clone()], "the kept id is remembered for a later start");
        assert!(gateway::verify_token(&c, &run1.claude_secret).is_ok() && gateway::verify_token(&c, &run1.relay_secret).is_err());
        // An approved proposal that is not applied yet also counts as waiting.
        gateway::decide(&c, &proposal.id, true).unwrap();
        let (_run3, ids3) = begin_run(&c, &ids2).unwrap();
        assert!(!revoked(&c, &run1.claude_id), "approved but not applied: still kept");
        assert!(ids3.contains(&run1.claude_id) && revoked(&c, &run2.claude_id) && revoked(&c, &run2.relay_id), "the idle second-run tokens are retired");
        // Once it is applied, the old token is finally retired.
        gateway::mark_applied(&c, &proposal.id, true, "done").unwrap();
        let (_run4, ids4) = begin_run(&c, &ids3).unwrap();
        assert!(revoked(&c, &run1.claude_id) && !ids4.contains(&run1.claude_id));
        // A declined proposal does not hold a token either; unknown and already revoked ids are dropped.
        assert_eq!(retire_idle(&c, &["no-such-token".into(), run1.claude_id.clone()]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn retiring_leaves_every_other_token_alone_even_one_with_the_same_name() {
        let c = fresh();
        let mine = gateway::create_token(&c, "Claude", &["chat:read".to_string()]).unwrap(); // a token the owner made by hand
        let (run, ids) = begin_run(&c, &[]).unwrap();
        retire_idle(&c, &ids).unwrap();
        assert!(!revoked(&c, &mine.info.id), "only recorded runner tokens are ever revoked");
        assert!(revoked(&c, &run.claude_id) && revoked(&c, &run.relay_id));
        assert!(gateway::verify_token(&c, &mine.secret).is_ok());
    }

    #[test]
    fn the_runner_gets_the_api_address_files_parent_pipe_and_both_secrets_only_in_its_environment() {
        let c = fresh(); let m = mint_tokens(&c).unwrap(); let p = paths(Path::new("/data"));
        let env: std::collections::HashMap<_, _> = child_env(&p, 47652, &m).into_iter().collect();
        assert_eq!(env["NOU_API_URL"], "http://127.0.0.1:47652"); assert_eq!(env["NOU_RUNNER_PARENT_PIPE"], "1");
        assert_eq!(env["NOU_TOKEN"], m.claude_secret); assert_eq!(env["NOU_TOKEN_RELAY"], m.relay_secret);
        for k in ["NOU_BOTS_FILE", "NOU_MCP_PATH", "NOU_CLAUDE_STATE"] { assert!(env[k].contains("runner"), "{k} points into the runner folder"); }
        assert_eq!(env.len(), 7);
        assert!(env.iter().filter(|(k, _)| !k.starts_with("NOU_TOKEN")).all(|(_, v)| !v.contains(&m.claude_secret) && !v.contains(&m.relay_secret)), "a secret is in no other variable");
    }

    #[test]
    fn secrets_are_removed_from_log_lines_and_the_log_is_capped_to_its_tail() {
        assert_eq!(redact("Bearer nou_abcdefgh1234 and nou_abcdefgh1234 again", &["nou_abcdefgh1234".to_string()]), "Bearer [token] and [token] again");
        assert_eq!(redact("x", &["abc".to_string()]), "x"); assert_eq!(redact("short abc", &["abc".to_string()]), "short abc", "very short strings are not treated as secrets");
        let dir = tmp(); let log = dir.join("runner.log");
        assert_eq!(log_tail(&log), "");
        for i in 0..30_000 { append_log(&log, &format!("line {i:06} {}", "x".repeat(60))); }
        let size = fs::metadata(&log).unwrap().len(); assert!(size <= LOG_CAP, "capped near 1 MB, was {size}");
        let tail = log_tail(&log); assert!(tail.len() as u64 <= TAIL_BYTES && tail.lines().last().unwrap().starts_with("line 029999"), "the newest line is kept");
        assert!(tail.starts_with("line "), "the tail starts at a line");
        assert!(fs::read_to_string(&log).unwrap().starts_with("line "), "trimming keeps whole lines");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn node_versions_are_read_and_18_is_the_minimum() {
        assert_eq!((parse_node_major("v22.1.0"), parse_node_major("18.0.0\n"), parse_node_major("v16.20.2"), parse_node_major("nope")), (Some(22), Some(18), Some(16), None));
    }

    #[test]
    fn a_real_child_process_logs_without_secrets_stops_when_its_pipe_closes_and_leaves_nothing_behind() {
        if !node_ok() { eprintln!("skipped: Node.js 18 or newer is not installed here"); return; }
        let dir = tmp(); let script = dir.join("fake-runner.mjs"); let log = dir.join("runner.log");
        fs::write(&script, "console.log('hello ' + process.env.NOU_TOKEN + ' ' + process.env.NOU_RUNNER_PARENT_PIPE);\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { console.log('bye'); process.exit(0); });\nsetInterval(() => {}, 1000);").unwrap();
        let secret = "nou_0123456789abcdef".to_string();
        let mut h = spawn_child("node", &script, vec![("NOU_TOKEN".into(), secret.clone()), ("NOU_RUNNER_PARENT_PIPE".into(), "1".into())], &log, vec![secret.clone()]).unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while !fs::read_to_string(&log).unwrap_or_default().contains("hello") && Instant::now() < end { std::thread::sleep(Duration::from_millis(50)); }
        assert!(h.exited().is_none(), "running while the pipe is open");
        let started = Instant::now(); h.terminate();
        assert!(started.elapsed() < Duration::from_secs(3), "it stopped by itself when the pipe closed, not by force");
        assert!(h.exited().is_some());
        std::thread::sleep(Duration::from_millis(300));
        let text = fs::read_to_string(&log).unwrap();
        assert!(text.contains("hello [token] 1") && text.contains("bye") && !text.contains(&secret), "{text}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_program_that_ignores_its_pipe_is_ended_by_force() {
        if !node_ok() { eprintln!("skipped: Node.js 18 or newer is not installed here"); return; }
        let dir = tmp(); let script = dir.join("stubborn.mjs"); let log = dir.join("runner.log");
        fs::write(&script, "setInterval(() => {}, 1000);").unwrap();
        let mut h = spawn_child("node", &script, vec![], &log, vec![]).unwrap();
        let started = Instant::now(); h.terminate();
        assert!(h.exited().is_some() && started.elapsed() < Duration::from_secs(8));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_program_is_a_clear_error() {
        let dir = tmp();
        assert!(spawn_child("definitely-not-a-program-nou", &dir.join("x.mjs"), vec![], &dir.join("l.log"), vec![]).err().unwrap().contains("Could not start"));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The whole chain against the REAL local API handler (not a fake): the embedded runner, started the way the app starts it with minted tokens, sees a tag in the
    /// Bots Hub and posts a "ready to paste" approval card, which the owner decides. Needs Node.js; skipped without it. The real `claude` CLI is not involved.
    #[test]
    fn a_tag_of_a_relay_bot_becomes_an_approval_card_through_the_real_api() {
        if !node_ok() { eprintln!("skipped: Node.js 18 or newer is not installed here"); return; }
        use std::sync::atomic::AtomicBool;
        let conn = Arc::new(Mutex::new(fresh()));
        let server = tiny_http::Server::http(("127.0.0.1", 0)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Arc<dyn Fn(&gateway_http::ApiRequest, u16) -> gateway_http::ApiResponse + Send + Sync> = { let conn = conn.clone(); Arc::new(move |req, p| gateway_http::handle(&conn.lock().unwrap(), req, p)) };
        let api = { let stop = stop.clone(); std::thread::spawn(move || gateway_http::serve(server, stop, port, handler)) };
        let dir = tmp(); let p = paths(&dir); install_files(&p).unwrap();
        let (m, _) = begin_run(&conn.lock().unwrap(), &[]).unwrap();
        let mut env = child_env(&p, port, &m); env.push(("NOU_CLAUDE_POLL_MS".into(), "1000".into()));
        let mut h = spawn_child("node", &p.script, env, &p.log, vec![m.claude_secret.clone(), m.relay_secret.clone()]).unwrap();
        let wait = |what: &str, check: &dyn Fn() -> bool| { let end = Instant::now() + Duration::from_secs(20); while Instant::now() < end { if check() { return; } std::thread::sleep(Duration::from_millis(100)); } panic!("timed out waiting for {what}\n{}", log_tail(&p.log)); };
        wait("the runner's baseline", &|| fs::read_to_string(&p.log).unwrap_or_default().contains("starting after message"));
        // The owner tags xGrok, and Claude hands work to GrokBots (allowed: both relays have allowFrom Claude). Kura's tag and a stranger bot's tag must do nothing.
        let long = format!("@xGrok read this {}", "word ".repeat(794)); // 3,987 characters: allowed in the room, but too long once the card heading is added
        let claude_id = m.claude_id.clone();
        { let c = conn.lock().unwrap();
          crate::chat::post_owner(&c, &long, None).unwrap();
          crate::chat::post_to_room(&c, &claude_id, "Claude", None, "handoff", None, Some("GrokBots"), Some("tier posts"), "@GrokBots please take the tier posts @grokbots").unwrap();
          crate::chat::post_owner(&c, "@Kura just talking", None).unwrap(); }
        let cards = || crate::chat::list(&conn.lock().unwrap(), None, 200, None).unwrap().into_iter().filter(|x| x.ty == "approval").collect::<Vec<_>>();
        wait("two cards", &|| cards().len() >= 2);
        std::thread::sleep(Duration::from_millis(2500)); // two more polls: nothing is posted twice
        let found = cards(); assert_eq!(found.len(), 2, "one card per tag: {:?}", found.iter().map(|c| &c.body[..40.min(c.body.len())]).collect::<Vec<_>>());
        for card in &found { assert_eq!(card.author, "NOU relay"); assert_eq!(card.approval.as_deref(), Some("open")); assert!(card.body.chars().count() <= 4000); }
        let by = |name: &str| found.iter().find(|c| c.body.starts_with(&format!("Ready to paste into {name}"))).unwrap_or_else(|| panic!("no card for {name}"));
        let x = by("xGrok"); assert!(x.body.contains("[shortened to fit]") && !x.body.to_lowercase().contains("@xgrok") && x.body.starts_with("Ready to paste into xGrok\n\nread this word"));
        let g = by("GrokBots"); assert_eq!(g.body, "Ready to paste into GrokBots\n\nplease take the tier posts");
        let queue = crate::hub::queue_list(&conn.lock().unwrap(), None, 50).unwrap();
        let titles: Vec<_> = queue.iter().map(|q| (q.bot.as_str(), q.status.as_str(), q.title.as_str())).collect();
        assert!(titles.iter().any(|t| t.0 == "NOU relay" && t.1 == "needs_nick" && t.2.starts_with("Paste into xGrok: read this word")), "{titles:?}");
        assert!(titles.iter().any(|t| t.2 == "Paste into GrokBots: please take the tier posts"), "{titles:?}");
        // Only the owner decides the card; approving it means "pasted".
        { let c = conn.lock().unwrap(); let done = crate::chat::decide_approval(&c, x.id, true).unwrap(); assert_eq!(done.approval.as_deref(), Some("approved")); }
        // Nothing the runner did touched a note, and no secret is in the log or the audit trail.
        { let c = conn.lock().unwrap();
          assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM proposals", [], |r| r.get(0)).unwrap(), 0);
          let all = everything_in(&c); assert!(!all.contains(&m.claude_secret) && !all.contains(&m.relay_secret)); }
        h.terminate(); std::thread::sleep(Duration::from_millis(300));
        let log = fs::read_to_string(&p.log).unwrap(); assert!(!log.contains(&m.claude_secret) && !log.contains(&m.relay_secret), "{log}");
        assert!(log.contains("posted a \"ready to paste\" card"), "{log}");
        stop.store(true, Ordering::SeqCst); api.join().unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }
}
