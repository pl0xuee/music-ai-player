//! Supervision of the two external processes the generator needs.
//!
//! The player itself never depends on any of this: `library.rs` reads rows and
//! plays files, and every command here degrades to a described-but-harmless
//! error when the venv, the scripts or the GPU server are missing. A build with
//! no `engine/` directory at all still plays music — the panel just says so.
//!
//! Two children are managed:
//!
//! * **the ACE-Step REST API** (`engine/start-api.sh`), which holds ~13 GB of
//!   VRAM once the weights are resident, and
//! * **a batch generation run** (`engine/generate.py`), which talks to that API
//!   and writes into the same `library.db` the player reads.
//!
//! Orphaning either of them is the failure mode that matters, so both are
//! spawned through [`crate::proc`], which owns the process-group, `PDEATHSIG`
//! and teardown guarantees — see that module for what they are and why the
//! forking thread has to outlive the app.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

// Every call site here reads `proc::SIGINT` / `proc::group_of`; aliasing the
// signals submodule keeps them saying exactly that after the move.
use crate::proc::signals as proc;
use crate::proc::{pump, slot, strip_ansi, terminate, wait_for_exit, Proc, Slot, Spawner};

/// Overrides the auto-discovered `engine/` directory.
pub const ENGINE_ENV: &str = "MUSIC_AI_ENGINE";

const ENGINE_DIRNAME: &str = "engine";
const API_HOST: &str = "127.0.0.1";
const API_PORT: u16 = 8001;
const HEALTH_PATH: &str = "/health";

/// Emitted whenever the engine's reachability changes. Payload: [`EngineStatus`].
pub const EV_ENGINE_STATUS: &str = "engine:status";
/// One line of `start-api.sh` output. Payload: [`LogLine`].
pub const EV_ENGINE_LOG: &str = "engine:log";
/// Emitted on every parsed generator line. Payload: [`GenerationProgress`].
pub const EV_GENERATION: &str = "generation:progress";
/// One raw line of `generate.py` output. Payload: [`LogLine`].
pub const EV_GENERATION_LOG: &str = "generation:log";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineState {
    /// Nothing is listening on the API port and we are not starting anything.
    Offline,
    /// We spawned the server; it is loading weights and not answering yet.
    Starting,
    /// `GET /health` came back.
    Online,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    /// True when this app owns the server process, i.e. Stop can work. A server
    /// the user started in a terminal shows `online` but not `supervised`.
    pub supervised: bool,
    /// Human-readable one-liner: the last interesting log line while starting,
    /// otherwise a fixed description.
    pub detail: String,
    /// Set when generation cannot work at all — missing venv, missing scripts.
    /// The UI shows this instead of a Start button.
    pub blocker: Option<String>,
    pub api_url: String,
    /// Absolute paths, echoed so a wrong working directory is diagnosable
    /// without attaching a debugger.
    pub script_path: String,
    pub python_path: String,
    pub generator_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunPhase {
    /// No run has been started in this session.
    Idle,
    /// Process spawned, no `[i/n]` line seen yet (planning + prompt insert).
    Planning,
    Running,
    /// SIGINT sent, waiting for the generator to unwind cleanly.
    Cancelling,
    /// Ran to completion.
    Done,
    /// Cancelled by the user. Pending rows survive; `--resume` continues.
    Cancelled,
    /// Non-zero exit, or the process could not be spawned.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationProgress {
    pub phase: RunPhase,
    pub running: bool,
    /// Prompts finished (0-based until the first line lands).
    pub current: u32,
    /// Prompts planned for this run. 0 until the generator announces it.
    pub total: u32,
    pub ok: u32,
    pub failed: u32,
    pub genre: Option<String>,
    pub bpm: Option<u32>,
    /// The generator's own ETA when it prints one, else extrapolated from the
    /// mean prompt time so far.
    pub eta_seconds: Option<u64>,
    pub elapsed_seconds: u64,
    /// Last non-empty generator line, ANSI stripped.
    pub line: String,
    /// What was asked for, e.g. `"10 tracks"` — echoed back for the UI header.
    pub target: Option<String>,
    /// Terminal message once `phase` is Done/Cancelled/Failed.
    pub message: Option<String>,
    pub exit_code: Option<i32>,
}

impl Default for GenerationProgress {
    fn default() -> Self {
        Self {
            phase: RunPhase::Idle,
            running: false,
            current: 0,
            total: 0,
            ok: 0,
            failed: 0,
            genre: None,
            bpm: None,
            eta_seconds: None,
            elapsed_seconds: 0,
            line: String::new(),
            target: None,
            message: None,
            exit_code: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub line: String,
    /// True for stderr, so the UI can tint it without parsing.
    pub stderr: bool,
}

/// What the user asked for. Mirrors the mutually exclusive flags of
/// `generate.py`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum GenTarget {
    Tracks(u32),
    Hours(f64),
    Resume,
}

impl GenTarget {
    fn args(self) -> Vec<String> {
        match self {
            Self::Tracks(n) => vec!["--tracks".into(), n.to_string()],
            Self::Hours(h) => vec!["--hours".into(), format_hours(h)],
            Self::Resume => vec!["--resume".into()],
        }
    }

    fn label(self) -> String {
        match self {
            Self::Tracks(n) => format!("{n} tracks"),
            Self::Hours(h) => format!("{} h", format_hours(h)),
            Self::Resume => "resume".into(),
        }
    }

    fn validate(self) -> Result<Self, String> {
        match self {
            Self::Tracks(n) if !(1..=5000).contains(&n) => {
                Err(format!("track count out of range: {n}"))
            }
            Self::Hours(h) if !(h.is_finite() && h > 0.0 && h <= 240.0) => {
                Err(format!("hours out of range: {h}"))
            }
            other => Ok(other),
        }
    }
}

/// `1`, `0.5`, `24` — never `24.0000001`, which argparse would take but which
/// reads badly in the UI.
fn format_hours(h: f64) -> String {
    if (h - h.round()).abs() < 1e-9 {
        format!("{}", h.round() as i64)
    } else {
        format!("{h:.2}")
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Paths {
    pub project_root: PathBuf,
    pub engine_dir: PathBuf,
    pub start_script: PathBuf,
    pub generator: PathBuf,
    pub python: PathBuf,
}

impl Paths {
    /// Same strategy as `Library::discover`: honour the env var, else walk up
    /// from the working directory, because `cargo tauri dev` runs the binary
    /// from `src-tauri/` while a bundled build runs from the project root.
    fn discover() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

        let engine_dir = std::env::var_os(ENGINE_ENV)
            .map(PathBuf::from)
            .or_else(|| {
                cwd.ancestors()
                    .map(|dir| dir.join(ENGINE_DIRNAME))
                    .find(|candidate| candidate.join("generate.py").is_file())
            })
            .unwrap_or_else(|| cwd.join(ENGINE_DIRNAME));

        let project_root = engine_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| cwd.clone());

        Self {
            start_script: engine_dir.join("start-api.sh"),
            generator: engine_dir.join("generate.py"),
            python: engine_dir
                .join("ACE-Step-1.5")
                .join("venv_rocm")
                .join("bin")
                .join("python"),
            engine_dir,
            project_root,
        }
    }

    /// The single reason generation cannot work, if there is one. Checked on
    /// every status poll so plugging the venv in is noticed without a restart.
    fn blocker(&self) -> Option<String> {
        if !self.generator.is_file() {
            return Some(format!(
                "generator not found at {} — the player works, generation does not.",
                self.generator.display()
            ));
        }
        if !self.python.is_file() {
            return Some(format!(
                "Python venv missing at {} — run engine/setup.sh once to create it.",
                self.python.display()
            ));
        }
        if !self.start_script.is_file() {
            return Some(format!("start script missing at {}", self.start_script.display()));
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

/// Minimal HTTP/1.1 GET against loopback.
///
/// A real HTTP client would drag in `reqwest`, TLS and a second async runtime
/// for one unauthenticated request to `127.0.0.1`. Any status line at all means
/// the ASGI app is serving, which is exactly the question being asked.
fn probe_health(addr: SocketAddr, timeout: Duration) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err() || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return false;
    }
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: music-ai-player\r\n\
         Accept: */*\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 128];
    let Ok(n) = stream.read(&mut head) else {
        return false;
    };
    String::from_utf8_lossy(&head[..n]).starts_with("HTTP/")
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/// Inverse of the generator's `fmt_hms`: `1h05m`, `6m12s`, `54s`.
fn parse_hms(token: &str) -> Option<u64> {
    let mut total = 0u64;
    let mut digits = String::new();
    let mut matched = false;
    for ch in token.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        let value: u64 = digits.parse().ok()?;
        digits.clear();
        total += match ch {
            'h' => value * 3600,
            'm' => value * 60,
            's' => value,
            _ => return None,
        };
        matched = true;
    }
    // A trailing bare number is not a duration.
    if digits.is_empty() && matched {
        Some(total)
    } else {
        None
    }
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Working,
    Ok,
    Failed,
}

#[derive(Debug, PartialEq)]
struct Step {
    current: u32,
    total: u32,
    genre: String,
    bpm: Option<u32>,
    eta: Option<u64>,
    outcome: Outcome,
}

/// Parse a per-prompt line, e.g.
/// `[3/10] dark techno        124bpm  ok 1 track(s) in 54s  eta 6m12s`.
fn parse_step(line: &str) -> Option<Step> {
    let line = line.trim();
    let rest = line.strip_prefix('[')?;
    let close = rest.find(']')?;
    let (cur, tot) = rest[..close].split_once('/')?;
    let current: u32 = cur.trim().parse().ok()?;
    let total: u32 = tot.trim().parse().ok()?;

    let mut genre = String::new();
    let mut tail = String::new();
    let mut bpm = None;
    for token in rest[close + 1..].split_whitespace() {
        if bpm.is_none() {
            if let Some(number) = token.strip_suffix("bpm") {
                if let Ok(value) = number.parse::<u32>() {
                    bpm = Some(value);
                    continue;
                }
            }
            if !genre.is_empty() {
                genre.push(' ');
            }
            genre.push_str(token);
        } else {
            if !tail.is_empty() {
                tail.push(' ');
            }
            tail.push_str(token);
        }
    }

    let eta = tail
        .split_whitespace()
        .skip_while(|t| *t != "eta")
        .nth(1)
        .and_then(parse_hms);

    let outcome = if tail.starts_with("ok") {
        Outcome::Ok
    } else if tail.contains("failed") {
        Outcome::Failed
    } else {
        Outcome::Working
    };

    Some(Step { current, total, genre, bpm, eta, outcome })
}

/// `==> Generating 10 prompt(s) — Ctrl-C is safe` / `==> Resuming — 7 track(s)…`
fn parse_announced_total(line: &str) -> Option<u32> {
    let rest = line.strip_prefix("==>")?.trim();
    let words: Vec<&str> = rest.split_whitespace().collect();
    for pair in words.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if b.starts_with("prompt(s)") || b.starts_with("track(s)") {
            if let Ok(value) = a.parse::<u32>() {
                return Some(value);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

pub struct Inner {
    paths: Paths,
    spawner: Spawner,
    server: Slot,
    run: Slot,
    status: Mutex<EngineStatus>,
    progress: Mutex<GenerationProgress>,
    /// Set while a cancel is in flight so the exit is reported as "cancelled"
    /// rather than "failed", whatever exit code the generator chooses.
    cancelling: AtomicBool,
    /// Bumped per run so a late line from a finished run cannot clobber a newer
    /// one's progress.
    run_seq: AtomicU64,
    api_addr: SocketAddr,
}

/// Handle to the engine supervisor. Cloneable so worker threads and the
/// `RunEvent` hook can hold one; Tauri manages a single instance.
#[derive(Clone)]
pub struct Engine(Arc<Inner>);

impl Deref for Engine {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl Drop for Inner {
    /// Belt to the `RunEvent::ExitRequested` braces in `main.rs`. Reached on a
    /// clean teardown; a hard kill is covered by `PR_SET_PDEATHSIG` instead.
    fn drop(&mut self) {
        terminate(&self.run, proc::SIGKILL, Duration::ZERO);
        terminate(&self.server, proc::SIGKILL, Duration::ZERO);
    }
}

impl Engine {
    pub fn discover() -> Self {
        let addr: SocketAddr = (
            API_HOST.parse::<std::net::IpAddr>().expect("API host"),
            API_PORT,
        )
            .into();
        Self::new(Paths::discover(), addr)
    }

    /// The address is a parameter only so the end-to-end test can point a fake
    /// engine at an ephemeral port; production always uses `discover`, because
    /// `generate.py` hardcodes `127.0.0.1:8001` and the two must agree.
    fn new(paths: Paths, api_addr: SocketAddr) -> Self {
        let status = EngineStatus {
            state: EngineState::Offline,
            supervised: false,
            detail: "not started".into(),
            blocker: paths.blocker(),
            api_url: format!("http://{api_addr}"),
            script_path: paths.start_script.display().to_string(),
            python_path: paths.python.display().to_string(),
            generator_path: paths.generator.display().to_string(),
        };
        Engine(Arc::new(Inner {
            paths,
            spawner: Spawner::start("engine-spawner"),
            server: slot(),
            run: slot(),
            status: Mutex::new(status),
            progress: Mutex::new(GenerationProgress::default()),
            cancelling: AtomicBool::new(false),
            run_seq: AtomicU64::new(0),
            api_addr,
        }))
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    fn supervising_server(&self) -> bool {
        self.server
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    fn generation_running(&self) -> bool {
        self.run.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    pub fn status(&self) -> EngineStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn progress(&self) -> GenerationProgress {
        self.progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set_detail(&self, detail: String) {
        let mut guard = self.status.lock().unwrap_or_else(|e| e.into_inner());
        guard.detail = detail;
    }

    /// Re-derive reachability. Called only from the poller thread, which keeps
    /// the (blocking, up to `timeout`) socket work off the UI thread — commands
    /// read the cached value instead.
    fn refresh_status(&self) -> EngineStatus {
        let supervised = self.supervising_server();
        let online = probe_health(self.api_addr, Duration::from_millis(1200));
        let blocker = self.paths.blocker();

        let mut guard = self.status.lock().unwrap_or_else(|e| e.into_inner());
        guard.blocker = blocker;
        guard.supervised = supervised;
        guard.state = if online {
            EngineState::Online
        } else if supervised {
            EngineState::Starting
        } else {
            EngineState::Offline
        };
        if online {
            guard.detail = if supervised {
                "serving — started by the player".into()
            } else {
                "serving — started outside the player".into()
            };
        } else if !supervised && !guard.detail.starts_with("exited") {
            guard.detail = "not running".into();
        }
        guard.clone()
    }

    /// Background reachability poller. One per app, started in `setup`.
    fn poll_status<R: Runtime>(self, app: AppHandle<R>) {
        let mut last: Option<EngineStatus> = None;
        loop {
            let next = self.refresh_status();
            if last.as_ref() != Some(&next) {
                let _ = app.emit(EV_ENGINE_STATUS, &next);
                last = Some(next.clone());
            }
            thread::sleep(match next.state {
                // While weights load the user is staring at the indicator.
                EngineState::Starting => Duration::from_millis(1000),
                EngineState::Online => Duration::from_millis(3000),
                EngineState::Offline => Duration::from_millis(2500),
            });
        }
    }

    // -- server ------------------------------------------------------------

    fn start_server<R: Runtime>(&self, app: &AppHandle<R>) -> Result<EngineStatus, String> {
        if let Some(blocker) = self.paths.blocker() {
            return Err(blocker);
        }
        if self.supervising_server() {
            return Ok(self.status());
        }
        if probe_health(self.api_addr, Duration::from_millis(600)) {
            // Somebody already has it up — adopt it rather than fighting for
            // the port and the VRAM.
            return Ok(self.refresh_status());
        }

        let mut cmd = Command::new(&self.paths.start_script);
        cmd.current_dir(&self.paths.project_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = self
            .spawner
            .spawn(cmd)
            .map_err(|e| format!("cannot start {}: {e}", self.paths.start_script.display()))?;

        let pgid = proc::group_of(&child);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        self.server
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(Proc { child, pgid });

        self.set_detail("starting — loading model weights (first run is slow)".into());
        let _ = app.emit(EV_ENGINE_STATUS, &self.status());

        // The startup banner and the ROCm/torch diagnostics both matter, and
        // they land on different pipes; surface each line either way.
        let mut streams: Vec<(Box<dyn Read + Send>, bool)> = Vec::new();
        if let Some(out) = stdout {
            streams.push((Box::new(out), false));
        }
        if let Some(err) = stderr {
            streams.push((Box::new(err), true));
        }
        for (stream, is_err) in streams {
            let engine = self.clone();
            let app = app.clone();
            thread::spawn(move || {
                pump(stream, |raw| {
                    let line = strip_ansi(&raw).trim_end().to_string();
                    if line.trim().is_empty() {
                        return;
                    }
                    engine.set_detail(line.clone());
                    let _ = app.emit(EV_ENGINE_LOG, LogLine { line, stderr: is_err });
                });
            });
        }

        // Reaper: keeps the slot honest so `supervised` flips back to false and
        // the poller reports `offline` rather than a permanent `starting`.
        let engine = self.clone();
        let app_for_exit = app.clone();
        thread::spawn(move || {
            let status = wait_for_exit(&engine.server);
            let code = status.and_then(|s| s.code());
            engine.set_detail(match code {
                Some(0) | None => "exited".into(),
                Some(c) => format!("exited with status {c} — see the log above"),
            });
            let _ = app_for_exit.emit(EV_ENGINE_STATUS, &engine.refresh_status());
        });

        Ok(self.status())
    }

    fn stop_server(&self) {
        // SIGTERM lets uvicorn close the port and free VRAM; SIGKILL is the
        // backstop if a CUDA/HIP call has the process wedged.
        terminate(&self.server, proc::SIGTERM, Duration::from_secs(6));
    }

    // -- generation --------------------------------------------------------

    fn start_generation<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        target: GenTarget,
    ) -> Result<GenerationProgress, String> {
        let target = target.validate()?;
        if let Some(blocker) = self.paths.blocker() {
            return Err(blocker);
        }
        if self.generation_running() {
            return Err("a generation run is already in progress".into());
        }
        // generate.py plans and INSERTs its pending rows *before* it checks the
        // API, so launching it against a dead engine leaves phantom rows behind
        // and dies. Refuse early instead.
        if !probe_health(self.api_addr, Duration::from_millis(1500)) {
            return Err("the ACE-Step engine is not answering — start it first".into());
        }

        let seq = self.run_seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.cancelling.store(false, Ordering::SeqCst);

        let mut cmd = Command::new(&self.paths.python);
        cmd.current_dir(&self.paths.project_root)
            // -u plus PYTHONUNBUFFERED: without them CPython block-buffers a
            // pipe and progress lines arrive one whole track late.
            .arg("-u")
            .arg(&self.paths.generator)
            .args(target.args())
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = self
            .spawner
            .spawn(cmd)
            .map_err(|e| format!("cannot run {}: {e}", self.paths.generator.display()))?;

        let pgid = proc::group_of(&child);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        self.run
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(Proc { child, pgid });

        let started = Instant::now();
        let initial = GenerationProgress {
            phase: RunPhase::Planning,
            running: true,
            target: Some(target.label()),
            line: "starting generator…".into(),
            ..GenerationProgress::default()
        };
        *self.progress.lock().unwrap_or_else(|e| e.into_inner()) = initial.clone();
        let _ = app.emit(EV_GENERATION, &initial);

        if let Some(stderr) = stderr {
            let app = app.clone();
            thread::spawn(move || {
                pump(stderr, |raw| {
                    let line = strip_ansi(&raw).trim_end().to_string();
                    if !line.trim().is_empty() {
                        let _ = app.emit(EV_GENERATION_LOG, LogLine { line, stderr: true });
                    }
                });
            });
        }

        let engine = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            if let Some(stdout) = stdout {
                let engine = engine.clone();
                let app = app.clone();
                pump(stdout, |raw| engine.absorb_line(&app, seq, started, &raw));
            }
            engine.finish_run(&app, seq, started);
        });

        Ok(initial)
    }

    /// Fold one generator stdout line into the shared progress snapshot.
    fn absorb_line<R: Runtime>(&self, app: &AppHandle<R>, seq: u64, started: Instant, raw: &str) {
        let line = strip_ansi(raw).trim_end().to_string();
        if line.trim().is_empty() {
            return;
        }
        let _ = app.emit(EV_GENERATION_LOG, LogLine { line: line.clone(), stderr: false });

        if seq != self.run_seq.load(Ordering::SeqCst) {
            return;
        }

        let mut guard = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        guard.elapsed_seconds = started.elapsed().as_secs();
        guard.line = line.trim().to_string();

        if let Some(total) = parse_announced_total(line.trim()) {
            guard.total = guard.total.max(total);
        }

        if let Some(step) = parse_step(&line) {
            guard.total = step.total;
            if guard.phase == RunPhase::Planning {
                guard.phase = RunPhase::Running;
            }
            if !step.genre.is_empty() {
                guard.genre = Some(step.genre);
            }
            guard.bpm = step.bpm;
            match step.outcome {
                Outcome::Working => {
                    // `[3/10] … submitting…` — three are done, the fourth is in
                    // flight; report the completed count.
                    guard.current = step.current.saturating_sub(1);
                }
                Outcome::Ok => {
                    guard.current = step.current;
                    guard.ok += 1;
                }
                Outcome::Failed => {
                    guard.current = step.current;
                    guard.failed += 1;
                }
            }
            guard.eta_seconds = step.eta.or_else(|| {
                // The generator only prints an ETA on success; extrapolate for
                // the rest so the readout never blanks mid-run.
                let done = guard.current.max(1) as u64;
                let remaining = guard.total.saturating_sub(guard.current) as u64;
                (remaining > 0).then(|| guard.elapsed_seconds * remaining / done)
            });
        }

        let snapshot = guard.clone();
        drop(guard);
        let _ = app.emit(EV_GENERATION, &snapshot);
    }

    /// Wait for the generator to exit and publish the terminal snapshot.
    fn finish_run<R: Runtime>(&self, app: &AppHandle<R>, seq: u64, started: Instant) {
        let status = wait_for_exit(&self.run);
        if seq != self.run_seq.load(Ordering::SeqCst) {
            return;
        }
        let code = status.and_then(|s| s.code());
        let cancelled = self.cancelling.swap(false, Ordering::SeqCst);

        let mut guard = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        guard.running = false;
        guard.elapsed_seconds = started.elapsed().as_secs();
        guard.eta_seconds = None;
        guard.exit_code = code;
        if cancelled {
            guard.phase = RunPhase::Cancelled;
            guard.message = Some(
                "Cancelled. Unfinished prompts stayed pending — Resume picks up where this left off."
                    .into(),
            );
        } else if code == Some(0) {
            guard.phase = RunPhase::Done;
            guard.message = Some(format!(
                "Run complete — {} ok, {} failed in {}.",
                guard.ok,
                guard.failed,
                human_duration(guard.elapsed_seconds)
            ));
        } else {
            guard.phase = RunPhase::Failed;
            guard.message = Some(match code {
                Some(c) => format!("Generator exited with status {c}. Last line: {}", guard.line),
                None => "Generator was terminated.".into(),
            });
        }
        let snapshot = guard.clone();
        drop(guard);
        let _ = app.emit(EV_GENERATION, &snapshot);
    }

    fn cancel_generation<R: Runtime>(&self, app: &AppHandle<R>) {
        if !self.generation_running() {
            return;
        }
        self.cancelling.store(true, Ordering::SeqCst);
        {
            let mut guard = self.progress.lock().unwrap_or_else(|e| e.into_inner());
            guard.phase = RunPhase::Cancelling;
            guard.line = "interrupt sent — finishing the current track safely…".into();
            let snapshot = guard.clone();
            drop(guard);
            let _ = app.emit(EV_GENERATION, &snapshot);
        }

        // SIGINT is what makes a run resumable: the generator's handler returns
        // the in-flight row to `pending` and unwinds. It polls the task API
        // every 3 s, so 20 s is generous; after that we stop being polite.
        let engine = self.clone();
        thread::spawn(move || {
            terminate(&engine.run, proc::SIGINT, Duration::from_secs(20));
        });
    }

    /// Kill both children. Called on app exit; must not block for long.
    pub fn shutdown(&self) {
        // The generator first, so it stops submitting work to a server that is
        // about to disappear. SIGINT gives it a moment to release its rows.
        self.cancelling.store(true, Ordering::SeqCst);
        terminate(&self.run, proc::SIGINT, Duration::from_secs(3));
        terminate(&self.server, proc::SIGTERM, Duration::from_secs(3));
    }
}

fn human_duration(seconds: u64) -> String {
    let (h, m, s) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60);
    if h > 0 {
        format!("{h}h{m:02}m")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

/// Start the reachability poller. Called once from `setup`.
pub fn spawn_status_poller<R: Runtime>(engine: Engine, app: AppHandle<R>) {
    thread::Builder::new()
        .name("engine-status".into())
        .spawn(move || engine.poll_status(app))
        .expect("engine status thread");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn engine_status(engine: State<'_, Engine>) -> EngineStatus {
    engine.status()
}

#[tauri::command]
pub fn engine_start(app: AppHandle, engine: State<'_, Engine>) -> Result<EngineStatus, String> {
    engine.start_server(&app)
}

#[tauri::command]
pub fn engine_stop(engine: State<'_, Engine>) -> Result<(), String> {
    // Returns immediately: terminate() waits up to six seconds and Tauri runs
    // synchronous commands on the main thread, which is the UI thread.
    let engine = engine.inner().clone();
    thread::spawn(move || engine.stop_server());
    Ok(())
}

#[tauri::command]
pub fn generation_state(engine: State<'_, Engine>) -> GenerationProgress {
    engine.progress()
}

#[tauri::command]
pub fn generation_start(
    app: AppHandle,
    engine: State<'_, Engine>,
    target: GenTarget,
) -> Result<GenerationProgress, String> {
    engine.start_generation(&app, target)
}

#[tauri::command]
pub fn generation_cancel(app: AppHandle, engine: State<'_, Engine>) -> Result<(), String> {
    engine.cancel_generation(&app);
    Ok(())
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use crate::proc::still_running;

    #[test]
    fn parses_a_finished_step() {
        let step = parse_step("[3/10] dark techno       124bpm  ok 1 track(s) in 54s  eta 6m12s")
            .expect("step");
        assert_eq!(step.current, 3);
        assert_eq!(step.total, 10);
        assert_eq!(step.genre, "dark techno");
        assert_eq!(step.bpm, Some(124));
        assert_eq!(step.eta, Some(372));
        assert_eq!(step.outcome, Outcome::Ok);
    }

    #[test]
    fn parses_an_in_flight_step() {
        let step = parse_step("[4/10] acid              132bpm  submitting…").expect("step");
        assert_eq!(step.current, 4);
        assert_eq!(step.outcome, Outcome::Working);
        assert_eq!(step.eta, None);
    }

    #[test]
    fn parses_a_failure() {
        let step = parse_step("[2/10] ambient            88bpm  failed after 12s").expect("step");
        assert_eq!(step.outcome, Outcome::Failed);
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_hms("54s"), Some(54));
        assert_eq!(parse_hms("6m12s"), Some(372));
        assert_eq!(parse_hms("1h05m"), Some(3900));
        assert_eq!(parse_hms("12"), None);
    }

    #[test]
    fn reads_the_announced_total() {
        assert_eq!(
            parse_announced_total("==> Generating 10 prompt(s) — Ctrl-C is safe"),
            Some(10)
        );
        assert_eq!(
            parse_announced_total("==> Resuming — 7 track(s) still to generate"),
            Some(7)
        );
        assert_eq!(parse_announced_total("  prompts ok    3"), None);
    }

    /// Any HTTP status line means the ASGI app is serving, which is the actual
    /// question. A 404 from a build without `/health` still counts as online.
    #[test]
    fn health_probe_accepts_any_http_response() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut scratch = [0u8; 512];
                let _ = socket.read(&mut scratch);
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });
        assert!(probe_health(addr, Duration::from_secs(3)));
        server.join().expect("server thread");
    }

    #[test]
    fn health_probe_reports_a_closed_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);
        assert!(!probe_health(addr, Duration::from_millis(400)));
    }

    // -- end-to-end ---------------------------------------------------------

    /// Stand-in for `engine/`, wired the same way but with no GPU in sight: the
    /// "API server" is `http.server` and the "generator" prints exactly the
    /// lines `generate.py` prints, at a pace a test can outrun.
    #[cfg(target_os = "linux")]
    struct FakeEngine {
        root: PathBuf,
        paths: Paths,
        addr: SocketAddr,
    }

    #[cfg(target_os = "linux")]
    impl Drop for FakeEngine {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(target_os = "linux")]
    fn write_script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, body).expect("write");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    #[cfg(target_os = "linux")]
    fn fake_engine() -> FakeEngine {
        // Ephemeral port so the test never collides with a real ACE-Step on
        // 8001; bind-then-drop leaves a tiny race the kernel makes unlikely.
        let addr = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            probe.local_addr().expect("addr")
        };

        let root = std::env::temp_dir().join(format!("music-ai-engine-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let engine_dir = root.join("engine");

        write_script(
            &engine_dir.join("start-api.sh"),
            &format!(
                "#!/bin/sh\necho 'fake ACE-Step starting'\nexec python3 -u -m http.server {} --bind 127.0.0.1\n",
                addr.port()
            ),
        );
        write_script(
            &engine_dir.join("ACE-Step-1.5/venv_rocm/bin/python"),
            "#!/bin/sh\nexec python3 \"$@\"\n",
        );
        write_script(
            &engine_dir.join("generate.py"),
            r#"#!/usr/bin/env python3
import signal, sys, time
stop = False
def on_int(_s, _f):
    global stop
    stop = True
signal.signal(signal.SIGINT, on_int)
total = 4
print("\n\033[1;32m==>\033[0m \033[1mGenerating %d prompt(s) - Ctrl-C is safe\033[0m" % total, flush=True)
for i in range(1, total + 1):
    if stop:
        break
    print("  [%d/%d] dark techno       124bpm  \033[2msubmitting...\033[0m" % (i, total), end="\r", flush=True)
    for _ in range(20):
        if stop:
            break
        time.sleep(0.05)
    if stop:
        break
    print("  [%d/%d] dark techno       124bpm  \033[1;32mok\033[0m 1 track(s) in 1s  \033[2meta 3s\033[0m" % (i, total))
print("\n\033[1;32m==>\033[0m \033[1m%s\033[0m" % ("Interrupted - progress saved" if stop else "Run complete"), flush=True)
sys.exit(0)
"#,
        );

        let paths = Paths {
            project_root: root.clone(),
            start_script: engine_dir.join("start-api.sh"),
            generator: engine_dir.join("generate.py"),
            python: engine_dir.join("ACE-Step-1.5/venv_rocm/bin/python"),
            engine_dir,
        };
        FakeEngine { root, paths, addr }
    }

    #[cfg(target_os = "linux")]
    fn wait_until(label: &str, mut predicate: impl FnMut() -> bool) {
        for _ in 0..300 {
            if predicate() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("timed out waiting for {label}");
    }

    /// The whole supervision path with no GPU: spawn the server, watch the
    /// health probe flip to online, run the generator, parse its progress,
    /// cancel it mid-flight and confirm nothing is left behind.
    #[cfg(target_os = "linux")]
    #[test]
    fn supervises_a_run_from_start_to_cancel() {
        let fake = fake_engine();
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let engine = Engine::new(fake.paths.clone(), fake.addr);

        assert_eq!(engine.paths.blocker(), None, "fake engine should look complete");
        assert_eq!(engine.refresh_status().state, EngineState::Offline);

        engine.start_server(&handle).expect("start server");
        let server_pgid = engine
            .server
            .lock()
            .expect("lock")
            .as_ref()
            .map(|p| p.pgid)
            .expect("server child");
        wait_until("engine online", || {
            engine.refresh_status().state == EngineState::Online
        });
        assert!(engine.status().supervised);

        engine
            .start_generation(&handle, GenTarget::Tracks(4))
            .expect("start generation");
        let run_pgid = engine
            .run
            .lock()
            .expect("lock")
            .as_ref()
            .map(|p| p.pgid)
            .expect("generator child");

        // Progress has to arrive from the parser, not from the spawn call.
        wait_until("first prompt", || {
            let p = engine.progress();
            p.total == 4 && p.ok >= 1 && p.phase == RunPhase::Running
        });

        engine.cancel_generation(&handle);
        wait_until("cancelled", || {
            let p = engine.progress();
            !p.running && p.phase == RunPhase::Cancelled
        });
        let after = engine.progress();
        assert!(after.ok >= 1, "should keep the prompts it finished");
        assert!(after.ok < 4, "cancel should land before the run completes");

        engine.shutdown();
        assert!(engine.run.lock().expect("lock").is_none());
        assert!(engine.server.lock().expect("lock").is_none());
        wait_until("engine offline", || {
            engine.refresh_status().state == EngineState::Offline
        });

        // Nothing may outlive the app: check the groups themselves, not just
        // the two pids we happened to hold handles for.
        for pgid in [server_pgid, run_pgid] {
            assert!(!still_running(pgid), "process {pgid} survived shutdown");
            assert_eq!(
                unsafe { libc::killpg(pgid, 0) },
                -1,
                "process group {pgid} survived shutdown"
            );
        }
    }
}
