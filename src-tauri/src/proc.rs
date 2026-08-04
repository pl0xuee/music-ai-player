//! Supervision primitives shared by every external process the app runs.
//!
//! Two subsystems spawn children — the ACE-Step generator (`engine.rs`) and the
//! YouTube importer (`youtube.rs`) — and both have the same failure mode: a
//! child that outlives the app. `start-api.sh` execs uvicorn and PyTorch forks
//! workers underneath it; `yt-dlp` forks `ffmpeg` to transcode. In both cases
//! killing the pid we happen to hold a handle for is not enough.
//!
//! Three independent guarantees, all provided here:
//!
//! 1. each child leads **its own process group**, so a signal reaches the whole
//!    tree rather than just the process we launched;
//! 2. each child sets **`PR_SET_PDEATHSIG = SIGKILL`**, so it dies even when the
//!    app is `SIGKILL`ed and no Rust shutdown code ever runs; and
//! 3. owners explicitly terminate their groups on `RunEvent::ExitRequested`
//!    (see `main.rs`) and again on `Drop`.
//!
//! Guarantee 2 is only sound if the thread that forked outlives the app, hence
//! [`Spawner`]: every child is forked from one dedicated, never-exiting thread.

use std::io::Read;
use std::process::{Child, Command};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Platform process control
// ---------------------------------------------------------------------------

/// Signals and process-group plumbing that `std::process` does not expose.
pub mod signals {
    use std::process::{Child, Command};

    #[cfg(unix)]
    pub const SIGINT: i32 = libc::SIGINT;
    #[cfg(unix)]
    pub const SIGTERM: i32 = libc::SIGTERM;
    #[cfg(unix)]
    pub const SIGKILL: i32 = libc::SIGKILL;

    #[cfg(not(unix))]
    pub const SIGINT: i32 = 2;
    #[cfg(not(unix))]
    pub const SIGTERM: i32 = 15;
    #[cfg(not(unix))]
    pub const SIGKILL: i32 = 9;

    /// Put the child in a fresh process group and ask the kernel to `SIGKILL`
    /// it the moment this process dies.
    ///
    /// `PR_SET_PDEATHSIG` is the only mechanism that survives the app being
    /// `SIGKILL`ed, an OOM kill or a hard crash — the cases where no amount of
    /// Rust shutdown code ever runs. It fires when the *forking thread* exits,
    /// which is why every child is forked from the long-lived [`super::Spawner`]
    /// thread and never from a Tauri command's worker.
    #[cfg(unix)]
    pub fn isolate(cmd: &mut Command) {
        use std::os::unix::process::CommandExt;

        // Own process group: `pgid == pid`, so signalling the group reaches
        // `start-api.sh` *and* the uvicorn process that replaced it, or `yt-dlp`
        // *and* the `ffmpeg` it forked to transcode.
        cmd.process_group(0);
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                // Between fork and prctl the parent may already have died; in
                // that case nothing will ever deliver the signal, so check.
                if libc::getppid() == 1 {
                    libc::_exit(0);
                }
                Ok(())
            });
        }
    }

    #[cfg(not(unix))]
    pub fn isolate(_cmd: &mut Command) {}

    /// `pgid` to signal for a child. Equal to the pid because of [`isolate`].
    pub fn group_of(child: &Child) -> i32 {
        child.id() as i32
    }

    /// Signal an entire process group. Errors are ignored: every caller is on a
    /// best-effort teardown path and a gone process is the desired outcome.
    #[cfg(unix)]
    pub fn signal_group(pgid: i32, sig: i32) {
        if pgid > 1 {
            unsafe { libc::killpg(pgid, sig) };
        }
    }

    #[cfg(not(unix))]
    pub fn signal_group(_pgid: i32, _sig: i32) {}
}

// ---------------------------------------------------------------------------
// Spawner: the one thread allowed to fork
// ---------------------------------------------------------------------------

type SpawnJob = Box<dyn FnOnce() -> std::io::Result<Child> + Send>;

/// A dedicated thread that outlives the application and forks every child.
///
/// `PR_SET_PDEATHSIG` fires when the forking *thread* dies, not the process, so
/// forking from a Tokio worker or a Tauri command thread would kill the child
/// the moment that pool recycled its threads. This thread never returns, which
/// makes the death signal mean what it looks like it means.
pub struct Spawner {
    tx: mpsc::Sender<(SpawnJob, mpsc::Sender<std::io::Result<Child>>)>,
}

impl Spawner {
    pub fn start(name: &str) -> Self {
        let (tx, rx) = mpsc::channel::<(SpawnJob, mpsc::Sender<std::io::Result<Child>>)>();
        thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                while let Ok((job, reply)) = rx.recv() {
                    let _ = reply.send(job());
                }
                // Unreachable while an owner holds the sender, but parking
                // rather than returning keeps the PDEATHSIG contract intact
                // even if that ever changes.
                loop {
                    thread::park();
                }
            })
            .expect("spawner thread");
        Self { tx }
    }

    pub fn spawn(&self, mut cmd: Command) -> std::io::Result<Child> {
        signals::isolate(&mut cmd);
        let (reply_tx, reply_rx) = mpsc::channel();
        let job: SpawnJob = Box::new(move || cmd.spawn());
        self.tx
            .send((job, reply_tx))
            .map_err(|_| std::io::Error::other("spawner thread is gone"))?;
        reply_rx
            .recv()
            .map_err(|_| std::io::Error::other("spawner thread stopped responding"))?
    }
}

// ---------------------------------------------------------------------------
// A supervised child
// ---------------------------------------------------------------------------

pub struct Proc {
    pub child: Child,
    pub pgid: i32,
}

// ---------------------------------------------------------------------------
// Bundle environment
// ---------------------------------------------------------------------------

/// Colon-separated search paths an AppImage points at its own bundled copies.
///
/// The `_1_0` spellings are not redundant: the GStreamer bundling hook exports
/// both, and a child that reads only the suffixed one would still be steered
/// into the bundle. Taken from the environment of a running AppImage rather
/// than from memory.
const BUNDLE_PATH_LISTS: [&str; 5] = [
    "LD_LIBRARY_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_PATH",
    "GST_PLUGIN_PATH_1_0",
];

/// Single-file variables pointing into the bundle.
const BUNDLE_FILES: [&str; 2] = ["GST_PLUGIN_SCANNER", "GST_PLUGIN_SCANNER_1_0"];

/// A `Command` for a tool that belongs to the host, not to this bundle.
pub fn external(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    unbundle(&mut cmd);
    cmd
}

/// Remove this bundle's library paths from a child's environment.
///
/// An AppImage runs its own binary against the libraries it ships by exporting
/// `LD_LIBRARY_PATH`, and a child inherits it. Every tool here is the host's —
/// `ffprobe`, `ffmpeg`, `yt-dlp`, `python` — so they get loaded against a
/// mixture of the host's libraries and the bundle's, which is a combination
/// nobody built or tested. On this machine that was:
///
///     ffprobe: symbol lookup error: /usr/lib/libopenmpt.so.0:
///              undefined symbol: mpg123_open_handle64
///
/// The host's `libopenmpt` resolved against the bundle's older `libmpg123`.
/// `ffprobe` died, and because a probe that cannot run is indistinguishable
/// from a file that is not audio, a scan of a perfectly good folder reported
/// "no audio in …" for every track in it. `yt-dlp` reaches `ffmpeg` the same
/// way, so imports broke identically and just as silently.
///
/// Only entries inside `APPDIR` are dropped, so anything the user set for their
/// own reasons survives. Outside an AppImage there is no `APPDIR` and this does
/// nothing at all.
pub fn unbundle(cmd: &mut Command) {
    let Some(appdir) = std::env::var_os("APPDIR") else {
        return;
    };
    let appdir = std::path::PathBuf::from(appdir);

    for var in BUNDLE_PATH_LISTS {
        let Some(value) = std::env::var_os(var) else {
            continue;
        };
        match outside_bundle(&value, &appdir) {
            Some(kept) => cmd.env(var, kept),
            None => cmd.env_remove(var),
        };
    }

    for var in BUNDLE_FILES {
        if let Some(value) = std::env::var_os(var) {
            if std::path::Path::new(&value).starts_with(&appdir) {
                cmd.env_remove(var);
            }
        }
    }
}

/// The entries of a search path that do not live inside `appdir`, or `None`
/// when that leaves nothing — in which case the variable should be unset rather
/// than set to the empty string, which some loaders read as "the current
/// directory" rather than "no preference".
fn outside_bundle(value: &std::ffi::OsStr, appdir: &std::path::Path) -> Option<std::ffi::OsString> {
    let kept: Vec<_> = std::env::split_paths(value)
        .filter(|entry| !entry.as_os_str().is_empty() && !entry.starts_with(appdir))
        .collect();
    if kept.is_empty() {
        return None;
    }
    std::env::join_paths(kept).ok()
}

/// Shorthand for the shared slot a supervised child lives in.
///
/// The `Child` deliberately stays inside the mutex for its whole life: reaping
/// only ever happens while the lock is held, so a signal can never be delivered
/// to a recycled pid. That is worth the 100 ms polling loop it costs.
pub type Slot = Arc<Mutex<Option<Proc>>>;

pub fn slot() -> Slot {
    Arc::new(Mutex::new(None))
}

/// Block until the child in `slot` exits, reaping it and clearing the slot.
/// Returns `None` if someone else (a terminate call) got there first.
pub fn wait_for_exit(slot: &Slot) -> Option<std::process::ExitStatus> {
    loop {
        {
            let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            let p = guard.as_mut()?;
            match p.child.try_wait() {
                Ok(Some(status)) => {
                    *guard = None;
                    return Some(status);
                }
                Ok(None) => {}
                Err(_) => {
                    *guard = None;
                    return None;
                }
            }
        }
        thread::sleep(Duration::from_millis(120));
    }
}

/// Signal the child's process group, escalating to `SIGKILL` if it has not gone
/// within `grace`. Safe to call when nothing is running.
pub fn terminate(slot: &Slot, first: i32, grace: Duration) {
    terminate_group(slot, None, first, grace);
}

/// [`terminate`], restricted to one specific process group.
///
/// Callers that supervise a *queue* decide which child to signal under some
/// other lock — the importer asks "is the running job the one the user
/// cancelled?" — and between that decision and this call the child can exit on
/// its own and the worker can install the next one. `only` is re-checked inside
/// the slot's own lock at every step, so a cancel that loses that race signals
/// nothing at all instead of killing whichever download started next.
pub fn terminate_group(slot: &Slot, only: Option<i32>, first: i32, grace: Duration) {
    let owned = |p: &Proc| match only {
        Some(want) => p.pgid == want,
        None => true,
    };

    let pgid = {
        let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(p) if owned(p) => p.pgid,
            _ => return,
        }
    };
    signals::signal_group(pgid, first);

    let deadline = Instant::now() + grace;
    loop {
        {
            let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_mut() {
                // Empty, or already refilled with a child this call has no
                // claim on: either way there is nothing left to wait for.
                None => break,
                Some(p) if !owned(p) => break,
                Some(p) => {
                    if matches!(p.child.try_wait(), Ok(Some(_)) | Err(_)) {
                        *guard = None;
                        break;
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(p) = guard.as_mut() {
                if owned(p) {
                    signals::signal_group(p.pgid, signals::SIGKILL);
                    // SIGKILL is not catchable, so this returns immediately.
                    let _ = p.child.wait();
                    *guard = None;
                }
            }
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    // The child we held a handle for is gone — but it is not the only member of
    // its group. `yt-dlp` forks `ffmpeg`, `start-api.sh` execs uvicorn which
    // forks workers, and a child that handles the first signal by exiting drops
    // its own children on the floor: they are reparented to init and keep
    // running, still holding the pipes this process is reading. Without this
    // sweep the reader thread blocks on a pipe that will never close, and the
    // transcode carries on burning CPU with nothing left to receive it.
    //
    // Sent after the reap rather than before, so it costs nothing in the common
    // case where the group is already empty and `killpg` just returns ESRCH.
    signals::signal_group(pgid, signals::SIGKILL);
}

// ---------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------

/// Strip SGR escape sequences.
///
/// `generate.py` colours unconditionally — it never checks `isatty` — and
/// `yt-dlp` needs `--no-colors` asked for explicitly, so neither stream can be
/// trusted to be plain text.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
        }
        // Consume through the final byte of the escape sequence.
        for c2 in chars.by_ref() {
            if ('\u{40}'..='\u{7e}').contains(&c2) {
                break;
            }
        }
    }
    out
}

/// Split a byte stream into lines on `\n` **and** `\r`.
///
/// Both children overwrite an in-flight status line with `\r` rather than
/// ending it: the generator's `submitting…` and yt-dlp's progress bar. A
/// `\n`-only reader would sit on those until the next whole item finished and
/// the UI would lag a full track behind.
pub fn pump<R: Read>(mut reader: R, mut on_line: impl FnMut(String)) {
    let mut buf = [0u8; 4096];
    let mut acc: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &byte in &buf[..n] {
                    if byte == b'\n' || byte == b'\r' {
                        if !acc.is_empty() {
                            on_line(String::from_utf8_lossy(&acc).into_owned());
                            acc.clear();
                        }
                    } else {
                        acc.push(byte);
                    }
                }
            }
        }
    }
    if !acc.is_empty() {
        on_line(String::from_utf8_lossy(&acc).into_owned());
    }
}

/// Is `pid` still a live process?
///
/// A zombie counts as dead for our purposes: it holds no resources and init
/// will reap it. `/proc/<pid>/stat` is `pid (comm) STATE …`, and `comm` may
/// itself contain spaces and brackets, so scan back from the last `)`.
///
/// Test-only, but shared: every subsystem that spawns children asserts on it.
#[cfg(all(test, target_os = "linux"))]
pub fn still_running(pid: i32) -> bool {
    let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some(close) = text.rfind(')') else {
        return false;
    };
    !matches!(text[close + 1..].trim().chars().next(), Some('Z') | None)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::Path;
    use std::process::Stdio;

    /// The bug this exists to prevent: the bundle's own library directory
    /// reaching `ffprobe`, which then loads a mixture of the host's libraries
    /// and ours and dies on a missing symbol. A scan of good files then reports
    /// every one of them as "no audio".
    #[test]
    fn drops_bundle_entries_from_a_search_path() {
        let appdir = Path::new("/tmp/.mount_abc");
        let value = OsString::from("/tmp/.mount_abc/usr/lib:/usr/lib:/tmp/.mount_abc/lib");
        assert_eq!(
            outside_bundle(&value, appdir),
            Some(OsString::from("/usr/lib"))
        );
    }

    /// A path made up entirely of bundle entries must unset the variable. An
    /// empty `LD_LIBRARY_PATH` is not the same as an absent one — the loader
    /// reads the empty entry as the current directory.
    #[test]
    fn unsets_a_search_path_that_was_all_bundle() {
        let appdir = Path::new("/tmp/.mount_abc");
        let value = OsString::from("/tmp/.mount_abc/usr/lib:/tmp/.mount_abc/lib");
        assert_eq!(outside_bundle(&value, appdir), None);
    }

    /// Anything the user set for their own reasons is theirs to keep.
    #[test]
    fn keeps_paths_that_are_not_ours() {
        let appdir = Path::new("/tmp/.mount_abc");
        let value = OsString::from("/opt/cuda/lib64:/usr/local/lib");
        assert_eq!(outside_bundle(&value, appdir), Some(value.clone()));
    }

    /// A prefix match on the string would strip this; a path match must not.
    #[test]
    fn does_not_strip_a_directory_that_merely_starts_with_the_same_text() {
        let appdir = Path::new("/tmp/.mount_abc");
        let value = OsString::from("/tmp/.mount_abcdef/lib");
        assert_eq!(outside_bundle(&value, appdir), Some(value.clone()));
    }

    #[test]
    fn strips_colour_codes() {
        let raw = "  [3/10] dark techno       124bpm  \u{1b}[1;32mok\u{1b}[0m 1 track(s)";
        assert_eq!(
            strip_ansi(raw).trim(),
            "[3/10] dark techno       124bpm  ok 1 track(s)"
        );
    }

    #[test]
    fn splits_on_carriage_returns() {
        let data = b"one\rtwo\nthree" as &[u8];
        let mut seen = Vec::new();
        pump(data, |line| seen.push(line));
        assert_eq!(seen, vec!["one", "two", "three"]);
    }

    /// The orphan guarantee, tested on the mechanism rather than on any one
    /// child: `start-api.sh` execs uvicorn and PyTorch forks workers underneath,
    /// `yt-dlp` forks `ffmpeg` — so killing the pid we spawned is never enough,
    /// the whole group has to go.
    #[cfg(target_os = "linux")]
    #[test]
    fn terminate_takes_down_the_whole_process_group() {
        let spawner = Spawner::start("test-spawner");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 60 & echo $!; wait")
            .stdin(Stdio::null())
            .stdout(Stdio::piped());

        let mut child = spawner.spawn(cmd).expect("spawn shell");
        let mut stdout = child.stdout.take().expect("stdout");
        let mut buf = [0u8; 32];
        let read = stdout.read(&mut buf).expect("grandchild pid");
        let grandchild: i32 = String::from_utf8_lossy(&buf[..read])
            .trim()
            .parse()
            .expect("pid");

        let pgid = signals::group_of(&child);
        assert_eq!(pgid, child.id() as i32, "child should lead its own group");

        let holder = slot();
        holder.lock().expect("lock").replace(Proc { child, pgid });

        terminate(&holder, signals::SIGTERM, Duration::from_secs(5));
        assert!(holder.lock().expect("lock").is_none(), "child was not reaped");

        // The grandchild is reparented on the shell's death; give init a moment.
        for _ in 0..50 {
            if !still_running(grandchild) {
                return;
            }
            thread::sleep(Duration::from_millis(40));
        }
        panic!("sleep {grandchild} survived the group kill");
    }

    /// A cancel names one job, but the signal is delivered from another thread
    /// a moment later. If the named job finished on its own in between and the
    /// worker started the next one, the successor must survive: `terminate_group`
    /// re-checks the pgid inside the slot's lock rather than killing whatever it
    /// finds there.
    #[cfg(target_os = "linux")]
    #[test]
    fn terminate_leaves_a_process_group_it_was_not_asked_for_alone() {
        let spawner = Spawner::start("test-spawner-mismatch");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("sleep 30").stdin(Stdio::null());

        let child = spawner.spawn(cmd).expect("spawn shell");
        let pid = child.id() as i32;
        let pgid = signals::group_of(&child);

        let holder = slot();
        holder.lock().expect("lock").replace(Proc { child, pgid });

        // Stands in for a job that has already exited. `1` is below the floor
        // `signal_group` will send to, so even a total regression here cannot
        // land a signal on an unrelated process group.
        terminate_group(&holder, Some(1), signals::SIGTERM, Duration::from_millis(200));
        assert!(
            holder.lock().expect("lock").is_some(),
            "the running child was reaped on behalf of a job that had already gone"
        );
        assert!(still_running(pid), "the wrong process group was signalled");

        // Named correctly, it goes.
        terminate_group(&holder, Some(pgid), signals::SIGTERM, Duration::from_secs(5));
        assert!(holder.lock().expect("lock").is_none(), "child was not reaped");
    }
}
