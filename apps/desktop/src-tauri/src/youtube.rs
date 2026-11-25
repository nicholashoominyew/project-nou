//! YouTube transcripts: runs the bundled Python worker (tools/youtube-transcripts) as a child process and passes what it says to the window.
//! The worker never touches NOU's data: the window stores each finished video through NOU's ordinary commands.
//!
//! Heavy Python libraries are only imported by the worker when a job runs, so NOU starts as fast as before.
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

const CORE: &str = include_str!("../../../../tools/youtube-transcripts/yt_core.py");
const WORKER: &str = include_str!("../../../../tools/youtube-transcripts/yt_worker.py");
const REQUIREMENTS: &str = include_str!("../../../../tools/youtube-transcripts/requirements.txt");
/// How long a cancelled job may take to tidy up before it is stopped by force.
const CANCEL_GRACE: Duration = Duration::from_secs(10);

pub struct Running { child: Arc<Mutex<Child>>, stdin: Arc<Mutex<Option<ChildStdin>>> }
#[derive(Default)]
pub struct YouTubeState(pub Arc<Mutex<Option<Running>>>);

fn folder(app: &AppHandle) -> Result<PathBuf, String> { Ok(crate::data_dir(app.path()).map_err(|e| e.to_string())?.join("youtube")) }

/// Write the bundled scripts next to the profile, so the installed app has them.
fn install(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for (name, text) in [("yt_core.py", CORE), ("yt_worker.py", WORKER), ("requirements.txt", REQUIREMENTS)] {
        let path = dir.join(name);
        if fs::read_to_string(&path).ok().as_deref() != Some(text) { fs::write(&path, text).map_err(|e| format!("The transcript worker could not be written: {e}"))?; }
    }
    Ok(())
}

fn command(program: &str, args: &[&str]) -> Command {
    let mut c = Command::new(program);
    c.args(args).env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8").env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1");
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); } // no console window
    c
}

/// Where Python might be, best first: the path the owner typed, NOU's own virtual environment, then the system's Pythons.
fn candidates(dir: &Path, chosen: &str) -> Vec<(String, Vec<&'static str>)> {
    let mut out = Vec::new();
    if !chosen.trim().is_empty() { out.push((chosen.trim().trim_matches('"').to_string(), vec![])); return out; }
    let venv = dir.join("venv").join("Scripts").join("python.exe");
    if venv.is_file() { out.push((venv.to_string_lossy().into_owned(), vec![])); }
    out.push(("py".into(), vec!["-3.12"]));
    out.push(("py".into(), vec!["-3.13"]));
    out.push(("py".into(), vec!["-3"]));
    out.push(("python".into(), vec![]));
    out
}

/// What `--check` of one Python says, or None when it cannot be started or does not answer in time.
fn probe(program: &str, pre: &[&str], dir: &Path) -> Option<Value> {
    let script = dir.join("yt_worker.py");
    let mut args: Vec<&str> = pre.to_vec();
    let script = script.to_string_lossy().into_owned();
    args.push(&script); args.push("--check");
    let mut child = command(program, &args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let start = Instant::now();
    while child.try_wait().ok()?.is_none() { if start.elapsed() > Duration::from_secs(30) { let _ = child.kill(); return None; } std::thread::sleep(Duration::from_millis(50)); }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    out.lines().find_map(|l| serde_json::from_str::<Value>(l).ok().filter(|v| v["type"] == "check"))
}

/// The first Python with everything installed; otherwise the first that runs, with what it lacks.
fn find_python(dir: &Path, chosen: &str) -> Option<(String, Vec<&'static str>, Value)> {
    let mut partial = None;
    for (program, pre) in candidates(dir, chosen) {
        let Some(found) = probe(&program, &pre, dir) else { continue };
        if found["missing"].as_array().is_some_and(|m| m.is_empty()) { return Some((program, pre, found)); }
        if partial.is_none() { partial = Some((program, pre, found)); }
    }
    partial
}

/// What is installed and, when something is missing, the exact commands that install it into a folder of NOU's own.
pub fn check_in(dir: &Path, chosen: &str) -> Result<Value, String> {
    install(dir)?;
    let venv = dir.join("venv");
    let steps = json!([
        format!("py -3.12 -m venv \"{}\"", venv.display()),
        format!("& \"{}\" -m pip install -r \"{}\"", venv.join("Scripts").join("python.exe").display(), dir.join("requirements.txt").display()),
    ]);
    Ok(match find_python(dir, chosen) {
        Some((_, _, mut found)) => { let ok = found["missing"].as_array().is_some_and(|m| m.is_empty()); found["ok"] = json!(ok); found["install"] = steps; found }
        None => json!({ "ok": false, "python": null, "missing": ["Python 3.10 or newer"], "install": steps }),
    })
}

#[tauri::command]
pub async fn yt_check(app: AppHandle, python: String) -> Result<Value, String> {
    let dir = folder(&app)?;
    tauri::async_runtime::spawn_blocking(move || check_in(&dir, &python)).await.map_err(|e| e.to_string())?
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = command("taskkill", &["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
}

/// Start one job. What the worker says arrives in the window as `yt-event`; the last event is always `exit`.
#[tauri::command]
pub async fn yt_start(app: AppHandle, state: State<'_, YouTubeState>, python: String, job: Value) -> Result<(), String> {
    if state.0.lock().map_err(|_| "State lock poisoned")?.is_some() { return Err("A transcript job is already running".into()); }
    let dir = folder(&app)?;
    let (program, pre) = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, Vec<&'static str>), String> {
            install(&dir)?;
            let (program, pre, found) = find_python(&dir, &python).ok_or("Python was not found. Install Python 3.12, then use Check again.")?;
            let missing: Vec<&str> = found["missing"].as_array().map(|m| m.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            if !missing.is_empty() { return Err(format!("Missing Python packages: {}. See \"What is needed\" for the commands.", missing.join(", "))); }
            Ok((program, pre))
        }).await.map_err(|e| e.to_string())??
    };
    // Every temporary file of this job (audio, subtitles) goes in one folder of its own, removed when the job ends however it ends.
    let tmp = dir.join("tmp").join(uuid::Uuid::new_v4().simple().to_string());
    let _ = fs::remove_dir_all(dir.join("tmp"));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let script = dir.join("yt_worker.py").to_string_lossy().into_owned();
    let mut args: Vec<&str> = pre.clone(); args.push(&script);
    let mut child = command(&program, &args).current_dir(&dir).env("TMP", &tmp).env("TEMP", &tmp).env("TMPDIR", &tmp)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("The transcript worker could not start: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("No input pipe")?;
    stdin.write_all(format!("{}\n", job).as_bytes()).map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("No output pipe")?;
    let stderr = child.stderr.take().ok_or("No error pipe")?;
    let child = Arc::new(Mutex::new(child));
    let slot = state.0.clone();
    *slot.lock().map_err(|_| "State lock poisoned")? = Some(Running { child: child.clone(), stdin: Arc::new(Mutex::new(Some(stdin))) });
    // The end of what went to stderr explains a crash.
    let errors = std::thread::spawn(move || {
        let mut last: Vec<String> = Vec::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) { last.push(line.chars().take(300).collect()); if last.len() > 8 { last.remove(0); } }
        last.join("\n")
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<Value>(&line) { let _ = app.emit("yt-event", event); }
        }
        let status = child.lock().ok().and_then(|mut c| c.wait().ok());
        let tail = errors.join().unwrap_or_default();
        let _ = fs::remove_dir_all(&tmp);
        if let Ok(mut running) = slot.lock() { *running = None; }
        let ok = status.is_some_and(|s| s.success());
        let _ = app.emit("yt-event", json!({ "type": "exit", "ok": ok, "error": if ok { String::new() } else { tail } }));
    });
    Ok(())
}

/// Ask the worker to stop; if it has not within a few seconds (a model still loading, say), stop it and its children by force.
#[tauri::command]
pub fn yt_cancel(state: State<'_, YouTubeState>) -> Result<(), String> {
    let slot = state.0.lock().map_err(|_| "State lock poisoned")?;
    let Some(running) = slot.as_ref() else { return Ok(()) };
    if let Ok(mut stdin) = running.stdin.lock() { if let Some(pipe) = stdin.as_mut() { let _ = pipe.write_all(b"cancel\n"); let _ = pipe.flush(); } }
    let child = running.child.clone();
    let all = state.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CANCEL_GRACE);
        // Only if the same job is still there.
        let same = all.lock().ok().is_some_and(|s| s.as_ref().is_some_and(|r| Arc::ptr_eq(&r.child, &child)));
        if same { if let Ok(mut c) = child.try_lock() { kill_tree(&mut c); } else { /* the reader thread is already waiting for it to end */ } }
    });
    Ok(())
}

/// NOU is closing: nothing of the job is left running.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<YouTubeState>() else { return };
    let taken = state.0.lock().ok().and_then(|mut s| s.take());
    if let Some(running) = taken {
        if let Ok(mut stdin) = running.stdin.lock() { stdin.take(); } // a closed pipe tells the worker to stop
        std::thread::sleep(Duration::from_millis(300));
        if let Ok(mut c) = running.child.try_lock() { if c.try_wait().ok().flatten().is_none() { kill_tree(&mut c); } };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_scripts_are_written_out_and_the_chosen_python_wins() {
        let dir = std::env::temp_dir().join(format!("nou-yt-{}", uuid::Uuid::new_v4().simple()));
        install(&dir).unwrap();
        assert!(fs::read_to_string(dir.join("yt_worker.py")).unwrap().contains("NOU's YouTube transcript worker"));
        assert!(fs::read_to_string(dir.join("requirements.txt")).unwrap().contains("faster-whisper"));
        assert_eq!(candidates(&dir, " \"C:\\py\\python.exe\" "), vec![("C:\\py\\python.exe".to_string(), vec![])]);
        assert_eq!(candidates(&dir, "")[0], ("py".to_string(), vec!["-3.12"]));
        fs::create_dir_all(dir.join("venv").join("Scripts")).unwrap(); fs::write(dir.join("venv").join("Scripts").join("python.exe"), b"").unwrap();
        assert!(candidates(&dir, "")[0].0.ends_with("python.exe") && candidates(&dir, "")[0].0.contains("venv"));
        let none = check_in(&dir, "C:\\definitely\\not\\python.exe").unwrap();
        assert_eq!(none["ok"], json!(false));
        assert!(none["install"][1].as_str().unwrap().contains("requirements.txt"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
