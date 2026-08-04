//! Importing audio from YouTube URLs into the local library.
//!
//! The app plays local files and nothing else. This module is the on-ramp: a
//! pasted URL becomes an mp3 in `library/tracks/` and a `ready` row in the same
//! `tracks` table the generator writes, after which the existing player,
//! crossfade, shuffle bag and visualiser handle it with no idea where it came
//! from. There is exactly one playback path in this app and this is not it.
//!
//! Downloading is delegated wholesale to `yt-dlp`, which is spawned through
//! [`crate::proc`] for the same reason the generator is: `yt-dlp` forks
//! `ffmpeg` to transcode, so killing the pid we hold leaves the transcode
//! running. The process group is what actually gets cancelled.
//!
//! Two invariants hold the library together:
//!
//! * **`status = 'ready'` is written only after the file is on disk and
//!   non-empty.** A cancelled or failed download leaves no row at all, because
//!   the shuffle bag would otherwise hand the player a track it can never load.
//! * **A `video_id` appears at most once.** Re-pasting a URL is a no-op that
//!   says so, and expanding a playlist skips what is already held.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::library::{
    append_to_playlist, find_by_video_id, imported_video_ids, insert_imported, ImportedTrack,
    Library,
};
use crate::proc::signals as proc;
use crate::proc::{
    pump, slot, strip_ansi, terminate, terminate_group, wait_for_exit, Proc, Slot, Spawner,
};

/// Full snapshot of the download queue. Payload: `Vec<DownloadJob>`.
pub const EV_JOBS: &str = "youtube:jobs";

/// Overrides the `yt-dlp` binary that would otherwise be found on `PATH`.
pub const YTDLP_ENV: &str = "MUSIC_AI_YTDLP";

/// Markers we ask `yt-dlp` to print so its output can be parsed without
/// guessing. Chosen not to collide with anything it emits itself.
const META_TAG: &str = "MAIP-META ";
const FILE_TAG: &str = "MAIP-FILE ";

/// Scratch directory for part-files and pre-transcode intermediates. Keeping it
/// out of `tracks/` is what guarantees a cancelled download cannot leave a
/// half-written `.mp3` sitting next to the real ones.
const INCOMING_DIRNAME: &str = ".incoming";

/// Ceiling on how many entries one pasted playlist may expand to. A pasted
/// 2000-video mix should not silently become a two-day download.
const PLAYLIST_CAP: u32 = 200;

/// Finished jobs kept in the queue view before the oldest are dropped.
const HISTORY: usize = 40;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/// A YouTube video ID is always 11 characters of URL-safe base64.
const ID_LEN: usize = 11;

/// The placeholder YouTube puts where the video ID goes in a playlist embed:
/// `/embed/videoseries?list=…`. It is itself exactly 11 URL-safe characters, so
/// nothing but an explicit exclusion keeps it from parsing as a video.
const PLAYLIST_PLACEHOLDER: &str = "videoseries";

/// What a pasted string turned out to point at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A single video.
    Video(String),
    /// A video reached through a playlist, i.e. carrying both `v=` and `list=`.
    /// The user decides which of the two they meant.
    VideoInPlaylist { id: String, list: String },
    /// A playlist with no video of its own.
    Playlist(String),
}

impl Target {
    /// The video this points at, if it points at one.
    pub fn video_id(&self) -> Option<&str> {
        match self {
            Self::Video(id) | Self::VideoInPlaylist { id, .. } => Some(id),
            Self::Playlist(_) => None,
        }
    }

    /// Whether resolving this needs `yt-dlp` to expand a playlist.
    fn needs_playlist(&self, user_wants_playlist: bool) -> bool {
        match self {
            Self::Playlist(_) => true,
            Self::VideoInPlaylist { .. } => user_wants_playlist,
            Self::Video(_) => false,
        }
    }
}

fn is_id(s: &str) -> bool {
    s.len() == ID_LEN && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_list(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Strip the punctuation a URL picks up from the prose around it.
///
/// Trailing `-` and `_` are deliberately left alone: both are legal inside a
/// video ID and an ID may genuinely end in either.
fn tidy(raw: &str) -> &str {
    raw.trim()
        .trim_start_matches(['<', '(', '[', '"', '\''])
        .trim_end_matches(['>', ')', ']', '"', '\'', ',', ';', '.', '!'])
}

/// Parse one pasted string into a [`Target`].
///
/// Accepts every shape YouTube hands out — `watch?v=`, `youtu.be/`, `/shorts/`,
/// `/live/`, `/embed/`, `/v/`, `youtube-nocookie.com`, `music.`/`m.`/`www.`
/// subdomains, with or without a scheme, with any number of extra query
/// parameters — plus a bare 11-character ID. Anything else is an error with the
/// offending text in it, because the bulk-paste path reports per line and
/// "invalid" on its own is useless when 40 lines went in.
pub fn parse_target(raw: &str) -> Result<Target, String> {
    let input = tidy(raw);
    if input.is_empty() {
        return Err("empty".into());
    }

    // A bare ID has no scheme, host or separators, so it can be recognised
    // before any URL work. `youtube.com` is also 11 characters, but the `.`
    // is not in the ID alphabet, so it cannot be mistaken for one.
    if is_id(input) {
        return Ok(Target::Video(input.to_string()));
    }

    let rest = match input.split_once("://") {
        Some((scheme, rest)) => {
            let scheme = scheme.to_ascii_lowercase();
            if scheme != "http" && scheme != "https" {
                return Err(format!("not an http(s) link: {input}"));
            }
            rest
        }
        // Protocol-relative, or a bare `youtu.be/…` with no scheme at all.
        None => input.trim_start_matches("//"),
    };

    let (authority, tail) = match rest.find(['/', '?', '#']) {
        Some(cut) => rest.split_at(cut),
        None => (rest, ""),
    };

    // Drop userinfo and port, then the subdomains that are pure routing.
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let host = host
        .strip_prefix("www.")
        .or_else(|| host.strip_prefix("music."))
        .or_else(|| host.strip_prefix("m."))
        .unwrap_or(&host);

    let short = match host {
        "youtu.be" => true,
        "youtube.com" | "youtube-nocookie.com" => false,
        _ => return Err(format!("not a YouTube link: {input}")),
    };

    // Fragment first — `#t=30` is not part of the query.
    let tail = tail.split('#').next().unwrap_or("");
    let (path, query) = match tail.split_once('?') {
        Some((path, query)) => (path, query),
        None => (tail, ""),
    };

    let mut v: Option<&str> = None;
    let mut list: Option<&str> = None;
    for pair in query.split(['&', ';']) {
        match pair.split_once('=') {
            Some(("v", value)) => v = Some(value),
            Some(("list", value)) => list = Some(value),
            _ => {}
        }
    }

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    let id = if short {
        // `youtu.be/<id>` — the whole path is the ID.
        segments.first().copied()
    } else {
        match segments.first().copied() {
            Some("watch") => v,
            // `/embed/videoseries?list=…` lands here with a non-ID segment; it
            // falls through to the playlist branch below.
            Some("shorts") | Some("live") | Some("embed") | Some("v") => segments.get(1).copied(),
            Some("playlist") => None,
            // `youtube.com/watch/<id>` is not a real form, and neither is a
            // bare `/<id>` — that path space is channel handles.
            _ => v,
        }
    };

    let id = id
        .filter(|s| is_id(s) && *s != PLAYLIST_PLACEHOLDER)
        .map(str::to_string);
    let list = list.filter(|s| is_list(s)).map(str::to_string);

    match (id, list) {
        (Some(id), Some(list)) => Ok(Target::VideoInPlaylist { id, list }),
        (Some(id), None) => Ok(Target::Video(id)),
        (None, Some(list)) => Ok(Target::Playlist(list)),
        (None, None) => Err(format!("no video or playlist ID in: {input}")),
    }
}

/// Pull the usable links out of a pasted blob.
///
/// Bulk paste is rarely a clean column of URLs — it is copied out of a video
/// description, a chat log or a numbered list, and a single-line input field
/// turns a multi-line paste into one space-separated run. So each line is
/// scanned token by token and *every* token that parses is taken:
/// `12. https://youtu.be/… — Some Title` yields the one URL rather than five
/// rejections, and `https://youtu.be/a https://youtu.be/b` yields both.
///
/// A line with nothing usable is passed through whole, so the report can name
/// it and say why instead of silently dropping it.
pub fn candidates(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let hits = line
            .split_whitespace()
            .filter(|token| parse_target(token).is_ok())
            .map(str::to_string);
        let before = out.len();
        out.extend(hits);
        if out.len() == before {
            out.push(line.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// External tools
// ---------------------------------------------------------------------------

/// Where the two binaries the import path needs were found, if at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub ytdlp_path: Option<String>,
    pub ffmpeg_path: Option<String>,
    /// `yt-dlp --version`, so a stale install is diagnosable from the panel.
    pub version: Option<String>,
    /// The single reason importing cannot work, if there is one.
    pub blocker: Option<String>,
    pub tracks_dir: String,
}

/// First match for `name` on `PATH`.
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn find_ytdlp(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        return p.is_file().then(|| p.to_path_buf());
    }
    if let Some(raw) = std::env::var_os(YTDLP_ENV) {
        let p = PathBuf::from(raw);
        return p.is_file().then_some(p);
    }
    which("yt-dlp")
}

/// `yt-dlp --version`, memoised against the binary's identity.
///
/// The probe is a fork, an exec and a Python interpreter start — measured at
/// 133 ms — and `youtube_status` runs it every time the import drawer opens.
/// Keying the cache on the path, size and mtime keeps what the uncached version
/// was for: a `yt-dlp` installed or upgraded while the app is open still gets
/// re-probed, because its identity changed.
fn ytdlp_version(bin: &Path) -> Option<String> {
    /// Path, length and mtime — enough to notice an upgrade in place.
    type Stamp = (PathBuf, u64, Option<std::time::SystemTime>);
    static CACHE: Mutex<Option<(Stamp, Option<String>)>> = Mutex::new(None);

    let meta = std::fs::metadata(bin).ok();
    let stamp: Stamp = (
        bin.to_path_buf(),
        meta.as_ref().map(|m| m.len()).unwrap_or(0),
        meta.as_ref().and_then(|m| m.modified().ok()),
    );

    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, version)) = cache.as_ref() {
        if *cached == stamp {
            return version.clone();
        }
    }

    let version = crate::proc::external(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!text.is_empty()).then_some(text)
        });
    *cache = Some((stamp, version.clone()));
    version
}

impl Tools {
    /// Re-resolved on every status call rather than cached at startup, so
    /// installing `yt-dlp` while the app is open is noticed without a restart.
    /// Only the `--version` probe is memoised; see [`ytdlp_version`].
    fn discover(lib: &Library, override_path: Option<&Path>) -> Self {
        let ytdlp = find_ytdlp(override_path);
        let ffmpeg = which("ffmpeg");

        let blocker = if ytdlp.is_none() {
            Some(
                "yt-dlp is not installed. Install it (`sudo pacman -S yt-dlp`, or \
                 `pipx install yt-dlp`) and reopen this panel — nothing else needs \
                 to change."
                    .to_string(),
            )
        } else if ffmpeg.is_none() {
            Some(
                "ffmpeg is not installed. yt-dlp needs it to extract audio \
                 (`sudo pacman -S ffmpeg`)."
                    .to_string(),
            )
        } else {
            None
        };

        let version = ytdlp.as_deref().and_then(ytdlp_version);

        Self {
            ytdlp_path: ytdlp.as_ref().map(|p| p.display().to_string()),
            ffmpeg_path: ffmpeg.as_ref().map(|p| p.display().to_string()),
            version,
            blocker,
            tracks_dir: lib.tracks_dir().display().to_string(),
        }
    }
}

/// Real duration of a finished file.
///
/// yt-dlp reports the *video's* duration, which is not always the duration of
/// the audio it extracted. The crossfade schedules itself off this number, so a
/// value that is a few seconds out makes the handover start in the wrong place;
/// measure the file we actually wrote.
fn probe_duration(file: &Path) -> Option<f64> {
    let out = crate::proc::external("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    (value.is_finite() && value > 0.0).then_some(value)
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobPhase {
    Queued,
    Running,
    /// Finished; `added` says how much of it landed.
    Done,
    /// yt-dlp failed, or every entry in it did.
    Failed,
    Cancelled,
    /// Everything it pointed at was already in the library.
    Skipped,
}

impl JobPhase {
    fn settled(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: u64,
    pub url: String,
    /// Video title once yt-dlp reports one, else the URL as pasted.
    pub label: String,
    pub phase: JobPhase,
    /// 0-100 for the entry currently downloading.
    pub percent: f64,
    /// Last interesting line, or the terminal message once settled.
    pub detail: String,
    pub playlist_id: Option<i64>,
    pub whole_playlist: bool,
    /// Where the audio is written, when the user picked somewhere.
    ///
    /// `None` means the library's own `tracks/` directory. Carried per job
    /// rather than held as one global setting so a queue built across two
    /// different choices still puts each item where it was asked to go — and so
    /// a retry lands in the same place as the attempt it replaces.
    pub destination: Option<String>,
    /// Rows committed by this job.
    pub added: u32,
    /// Entries already in the library.
    pub skipped: u32,
    /// Entries yt-dlp could not fetch — private, removed, region-blocked.
    pub failed: u32,
    pub track_ids: Vec<i64>,
}

/// Outcome of one line of a bulk paste.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLine {
    pub input: String,
    pub accepted: bool,
    pub reason: String,
    pub job_id: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub lines: Vec<ImportLine>,
    pub queued: u32,
    pub rejected: u32,
    pub duplicates: u32,
}

/// The subset of yt-dlp's info dict we ask for, as a one-line JSON object.
#[derive(Debug, Clone, Deserialize)]
struct Meta {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    uploader: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    webpage_url: Option<String>,
}

impl Meta {
    fn title(&self) -> String {
        match self.title.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() => t.to_string(),
            // A title is `NOT NULL`; the ID is at least identifying.
            _ => self.id.clone(),
        }
    }

    fn uploader(&self) -> Option<String> {
        self.uploader
            .clone()
            .or_else(|| self.channel.clone())
            .filter(|s| !s.trim().is_empty())
    }

    fn url(&self) -> String {
        self.webpage_url
            .clone()
            .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", self.id))
    }
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/// `[download]  42.3% of  1.23MiB at 900KiB/s ETA 00:01`
fn parse_percent(line: &str) -> Option<f64> {
    let rest = line.trim().strip_prefix("[download]")?;
    let token = rest.split_whitespace().next()?;
    let value: f64 = token.strip_suffix('%')?.parse().ok()?;
    value.is_finite().then(|| value.clamp(0.0, 100.0))
}

/// `[download] jNQXAC9IVRw: has already been recorded in the archive`
///
/// Current yt-dlp puts the title between the ID and the phrase:
/// `[download] jNQXAC9IVRw: Me at the zoo has already been recorded in the archive`
/// so the phrase is matched at the end of the line rather than the start of the
/// tail — otherwise every playlist entry already held is counted as neither
/// added nor skipped, and the panel reports nothing about it.
fn parse_archived(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("[download]")?.trim();
    let (id, tail) = rest.split_once(": ")?;
    tail.ends_with("has already been recorded in the archive")
        .then(|| id.to_string())
}

/// `ERROR: [youtube] abc: Video unavailable` -> `Video unavailable`.
///
/// yt-dlp prefixes the extractor and the ID; both are already on screen, and
/// the part after them is the only bit that tells the user what to do.
fn parse_error(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("ERROR:")?.trim();
    let rest = match rest.strip_prefix('[') {
        Some(after) => match after.split_once(']') {
            Some((_, tail)) => tail.trim_start().trim_start_matches(':').trim(),
            None => rest,
        },
        None => rest,
    };
    // Drop a leading `<id>: `, which is the same 11 characters yet again.
    let rest = match rest.split_once(": ") {
        Some((head, tail)) if is_id(head) => tail,
        _ => rest,
    };
    (!rest.is_empty()).then(|| rest.to_string())
}

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------

struct Request {
    url: String,
    playlist_id: Option<i64>,
    whole_playlist: bool,
    /// Where to write the audio; `None` is the library's own `tracks/`.
    destination: Option<String>,
}

struct Queue {
    jobs: Vec<DownloadJob>,
    requests: std::collections::HashMap<u64, Request>,
    pending: VecDeque<u64>,
    /// Jobs the user cancelled. Checked before starting and while running.
    cancelled: std::collections::HashSet<u64>,
    stop: bool,
}

/// The job that owns the running `yt-dlp`, together with its process group.
///
/// The two are stored as one value so a cancel can establish "this really is
/// the job the user named" and capture what to signal under a single lock. Read
/// separately, the job could exit and the next one start in between, and the
/// signal would land on the wrong download.
#[derive(Debug, Clone, Copy)]
struct Active {
    job_id: u64,
    pgid: i32,
}

pub struct Inner {
    lib: Library,
    spawner: Spawner,
    state: Mutex<Queue>,
    wake: Condvar,
    /// The one running yt-dlp. Downloads run one at a time on purpose: two
    /// concurrent transcodes saturate the disk for no wall-clock gain, and a
    /// single slot makes "cancel" and "clean up partials" unambiguous.
    active: Slot,
    active_job: Mutex<Option<Active>>,
    next_id: AtomicU64,
    /// Test hook: forces the binary instead of resolving one from `PATH`.
    ytdlp_override: Option<PathBuf>,
}

/// Handle to the import queue. Cloneable so the worker thread and the exit hook
/// can hold one; Tauri manages a single instance.
#[derive(Clone)]
pub struct Downloads(Arc<Inner>);

impl std::ops::Deref for Downloads {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl Downloads {
    pub fn new(lib: Library) -> Self {
        Self::with_ytdlp(lib, None)
    }

    pub fn with_ytdlp(lib: Library, ytdlp_override: Option<PathBuf>) -> Self {
        Downloads(Arc::new(Inner {
            lib,
            spawner: Spawner::start("download-spawner"),
            state: Mutex::new(Queue {
                jobs: Vec::new(),
                requests: std::collections::HashMap::new(),
                pending: VecDeque::new(),
                cancelled: std::collections::HashSet::new(),
                stop: false,
            }),
            wake: Condvar::new(),
            active: slot(),
            active_job: Mutex::new(None),
            next_id: AtomicU64::new(1),
            ytdlp_override,
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn jobs(&self) -> Vec<DownloadJob> {
        self.lock().jobs.clone()
    }

    pub fn tools(&self) -> Tools {
        Tools::discover(&self.lib, self.ytdlp_override.as_deref())
    }

    fn publish<R: Runtime>(&self, app: &AppHandle<R>) {
        let _ = app.emit(EV_JOBS, self.jobs());
    }

    /// Mutate one job in place, then hand the caller the fresh snapshot.
    fn with_job(&self, id: u64, edit: impl FnOnce(&mut DownloadJob)) {
        let mut guard = self.lock();
        if let Some(job) = guard.jobs.iter_mut().find(|j| j.id == id) {
            edit(job);
        }
    }

    fn is_cancelled(&self, id: u64) -> bool {
        self.lock().cancelled.contains(&id)
    }

    // -- enqueue ------------------------------------------------------------

    /// Turn a pasted blob into queued jobs, reporting on every line.
    pub fn enqueue<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        text: &str,
        playlist_id: Option<i64>,
        whole_playlist: bool,
        destination: Option<String>,
    ) -> Result<ImportReport, String> {
        let conn = self.lib.connect()?;
        let mut report = ImportReport::default();

        for input in candidates(text) {
            let target = match parse_target(&input) {
                Ok(t) => t,
                Err(reason) => {
                    report.rejected += 1;
                    report.lines.push(ImportLine {
                        input,
                        accepted: false,
                        reason,
                        job_id: None,
                    });
                    continue;
                }
            };

            // A single video can be checked against the library before yt-dlp
            // is ever started, which turns the common "did I already add this?"
            // into instant feedback. Playlist expansion cannot be pre-checked —
            // the download archive handles that case instead.
            let expands = target.needs_playlist(whole_playlist);
            if !expands {
                if let Some(id) = target.video_id() {
                    if let Some(existing) = find_by_video_id(&conn, id)? {
                        let mut reason = "already in the library".to_string();
                        if let Some(pl) = playlist_id {
                            if append_to_playlist(&conn, pl, existing)? {
                                reason = "already in the library — added to the playlist".into();
                            }
                        }
                        report.duplicates += 1;
                        report.lines.push(ImportLine {
                            input,
                            accepted: false,
                            reason,
                            job_id: None,
                        });
                        continue;
                    }
                }
            }

            let job_id = self.next_id.fetch_add(1, Ordering::SeqCst);
            {
                let mut guard = self.lock();
                guard.jobs.push(DownloadJob {
                    id: job_id,
                    url: input.clone(),
                    label: input.clone(),
                    phase: JobPhase::Queued,
                    percent: 0.0,
                    detail: if expands {
                        format!("queued — playlist, up to {PLAYLIST_CAP} items")
                    } else {
                        "queued".into()
                    },
                    playlist_id,
                    whole_playlist: expands,
                    destination: destination.clone(),
                    added: 0,
                    skipped: 0,
                    failed: 0,
                    track_ids: Vec::new(),
                });
                guard.requests.insert(
                    job_id,
                    Request {
                        url: input.clone(),
                        playlist_id,
                        whole_playlist: expands,
                        destination: destination.clone(),
                    },
                );
                guard.pending.push_back(job_id);
                trim_history(&mut guard);
            }
            self.wake.notify_one();

            report.queued += 1;
            report.lines.push(ImportLine {
                input,
                accepted: true,
                reason: if expands {
                    "queued as a playlist".into()
                } else {
                    "queued".into()
                },
                job_id: Some(job_id),
            });
        }

        self.publish(app);
        Ok(report)
    }

    // -- cancellation -------------------------------------------------------

    pub fn cancel<R: Runtime>(&self, app: &AppHandle<R>, job_id: u64) {
        {
            let mut guard = self.lock();
            // An id that was never issued must not be recorded: `cancelled` is
            // only pruned against live jobs, so the entry would survive and
            // cancel a later job that happens to be given the same number
            // before it ever starts.
            if !guard.jobs.iter().any(|j| j.id == job_id) {
                return;
            }
            guard.cancelled.insert(job_id);
            guard.pending.retain(|id| *id != job_id);
            if let Some(job) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
                if job.phase == JobPhase::Queued {
                    job.phase = JobPhase::Cancelled;
                    job.detail = "cancelled before it started".into();
                }
            }
        }
        self.publish(app);

        // Only the running job needs a signal, and only off the caller's thread:
        // `terminate` waits out the grace period and this arrives on the UI one.
        //
        // The pgid is captured under the same lock as the ownership check, and
        // re-checked against the slot before anything is signalled. Without
        // that, a job that exits naturally between the check and the signal lets
        // the worker start the next one and this kills *that* download instead.
        let target = {
            let guard = self.active_job.lock().unwrap_or_else(|e| e.into_inner());
            guard.filter(|a| a.job_id == job_id).map(|a| a.pgid)
        };
        if let Some(pgid) = target {
            let dl = self.clone();
            thread::spawn(move || {
                // SIGINT first: yt-dlp unwinds, removes its own part-file and
                // lets ffmpeg close the container it is writing.
                terminate_group(&dl.active, Some(pgid), proc::SIGINT, Duration::from_secs(5));
            });
        }
    }

    pub fn cancel_all<R: Runtime>(&self, app: &AppHandle<R>) {
        let ids: Vec<u64> = {
            let guard = self.lock();
            guard
                .jobs
                .iter()
                .filter(|j| !j.phase.settled())
                .map(|j| j.id)
                .collect()
        };
        for id in ids {
            self.cancel(app, id);
        }
    }

    /// Forget everything that has finished, so the panel does not grow forever.
    /// Queue a settled job's URL again, dropping the attempt it replaces.
    ///
    /// A download fails for reasons that pass: the network drops, YouTube rate
    /// limits, a postprocessor is missing a module. None of those are reasons
    /// to make the user find and paste the link a second time.
    ///
    /// The old entry is removed rather than left beside the new one, so the
    /// queue shows one row per thing the user asked for instead of a history of
    /// attempts. Only settled jobs qualify — retrying something still running
    /// would leave two yt-dlp processes writing the same file.
    ///
    /// Re-enqueueing goes through [`Self::enqueue`], which checks the library
    /// first. A job that failed wrote no row, so it queues; one that actually
    /// succeeded comes back as a duplicate and is refused, which is the honest
    /// answer to retrying something already held.
    pub fn retry<R: Runtime>(&self, app: &AppHandle<R>, job_id: u64) -> Result<ImportReport, String> {
        let (url, playlist_id, whole_playlist, destination) = {
            let mut guard = self.lock();
            let Some(job) = guard.jobs.iter().find(|j| j.id == job_id) else {
                return Err("that download is no longer in the queue".into());
            };
            if !job.phase.settled() {
                return Err("that download has not finished yet".into());
            }
            let taken = (
                job.url.clone(),
                job.playlist_id,
                job.whole_playlist,
                job.destination.clone(),
            );
            guard.jobs.retain(|j| j.id != job_id);
            guard.requests.remove(&job_id);
            guard.cancelled.remove(&job_id);
            taken
        };

        // Published before the new job is queued so the row disappears even if
        // the re-enqueue then fails; otherwise a rejected retry would leave the
        // old attempt looking as though it had been picked up.
        self.publish(app);
        self.enqueue(app, &url, playlist_id, whole_playlist, destination)
    }

    pub fn clear_finished<R: Runtime>(&self, app: &AppHandle<R>) {
        {
            let mut guard = self.lock();
            guard.jobs.retain(|j| !j.phase.settled());
            let live: Vec<u64> = guard.jobs.iter().map(|j| j.id).collect();
            guard.requests.retain(|id, _| live.contains(id));
            guard.cancelled.retain(|id| live.contains(id));
        }
        self.publish(app);
    }

    /// Called on app exit. Must not block for long.
    pub fn shutdown(&self) {
        {
            let mut guard = self.lock();
            guard.stop = true;
            guard.pending.clear();
        }
        self.wake.notify_all();
        terminate(&self.active, proc::SIGTERM, Duration::from_secs(3));
        clear_dir(&self.incoming_dir());
    }

    fn incoming_dir(&self) -> PathBuf {
        self.lib.tracks_dir().join(INCOMING_DIRNAME)
    }

    // -- the worker ---------------------------------------------------------

    fn run<R: Runtime>(self, app: AppHandle<R>) {
        loop {
            let job_id = {
                let mut guard = self.lock();
                loop {
                    if guard.stop {
                        return;
                    }
                    if let Some(id) = guard.pending.pop_front() {
                        break id;
                    }
                    guard = self.wake.wait(guard).unwrap_or_else(|e| e.into_inner());
                }
            };
            self.run_job(&app, job_id);
        }
    }

    fn run_job<R: Runtime>(&self, app: &AppHandle<R>, job_id: u64) {
        let Some((url, playlist_id, whole_playlist, destination)) = ({
            let guard = self.lock();
            guard
                .requests
                .get(&job_id)
                .map(|r| {
                    (
                        r.url.clone(),
                        r.playlist_id,
                        r.whole_playlist,
                        r.destination.clone(),
                    )
                })
        }) else {
            return;
        };

        if self.is_cancelled(job_id) {
            self.settle(app, job_id, JobPhase::Cancelled, "cancelled".into());
            return;
        }

        let tools = self.tools();
        let (Some(ytdlp), None) = (tools.ytdlp_path.clone(), tools.blocker.clone()) else {
            let reason = tools
                .blocker
                .unwrap_or_else(|| "yt-dlp is unavailable".into());
            self.settle(app, job_id, JobPhase::Failed, reason);
            return;
        };

        self.with_job(job_id, |job| {
            job.phase = JobPhase::Running;
            job.detail = "resolving…".into();
        });
        self.publish(app);

        match self.spawn_and_pump(
            app,
            job_id,
            &ytdlp,
            &url,
            playlist_id,
            whole_playlist,
            destination.as_deref(),
        ) {
            Ok(()) => {}
            Err(message) => {
                self.settle(app, job_id, JobPhase::Failed, message);
            }
        }

        // Whatever happened, nothing half-written may survive into `tracks/`.
        clear_dir(&self.incoming_dir());
        *self.active_job.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.publish(app);
    }

    fn spawn_and_pump<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        job_id: u64,
        ytdlp: &str,
        url: &str,
        playlist_id: Option<i64>,
        whole_playlist: bool,
        destination: Option<&str>,
    ) -> Result<(), String> {
        // Where the finished audio lands. A chosen folder is created if it is
        // not there yet, and a folder that cannot be created is an error rather
        // than a silent fall back to the library — a download the user believes
        // went somewhere else is worse than one that refused to start.
        let tracks_dir = match destination {
            None => self.lib.tracks_dir(),
            Some(dir) => {
                let path = PathBuf::from(dir);
                std::fs::create_dir_all(&path)
                    .map_err(|e| format!("cannot write to {}: {e}", path.display()))?;
                path
            }
        };
        // The scratch directory goes *inside* the destination, not beside the
        // library, so that finishing a download is a rename.
        //
        // yt-dlp finishes with `shutil.move`, which is only `os.rename` when
        // both ends are on one filesystem; across two it copies and then calls
        // `copystat` to carry the timestamps and mode over. A network mount is
        // where that stops being free — an SMB share over kio-fuse copies the
        // bytes happily and then refuses the metadata:
        //
        //     Inappropriate ioctl for device: '…/Vibe Motors/….opus'
        //
        // The file was already there and complete; only the stat call failed,
        // and the whole download was reported as failed because of it. Keeping
        // the scratch space on the destination means there is nothing to copy
        // and no stat to carry, whatever the destination happens to be.
        let incoming = tracks_dir.join(INCOMING_DIRNAME);
        std::fs::create_dir_all(&incoming)
            .map_err(|e| format!("cannot create {}: {e}", incoming.display()))?;
        clear_dir(&incoming);

        // The archive is rebuilt from the database every run rather than kept
        // as a file, so the library stays the single source of truth. It is what
        // makes expanding a playlist skip the entries already held.
        let archive = incoming.join("archive.txt");
        {
            let conn = self.lib.connect()?;
            let ids = imported_video_ids(&conn)?;
            let body: String = ids.iter().map(|id| format!("youtube {id}\n")).collect();
            std::fs::write(&archive, body)
                .map_err(|e| format!("cannot write {}: {e}", archive.display()))?;
        }

        let mut cmd = crate::proc::external(ytdlp);
        cmd.args([
            // Best audio-only stream, and then *keep* it.
            //
            // Forcing mp3 here used to cost a generation: YouTube serves Opus
            // at around 160 kbps, and re-encoding that to mp3 — however high
            // the bitrate — only ever subtracts. `--audio-format best` remuxes
            // into a fitting container without touching the samples, so what
            // lands on disk is bit-for-bit what YouTube sent.
            //
            // The library has not cared about the extension since the media
            // server started serving files itself; it maps opus, m4a, flac and
            // the rest to their own content types, and GStreamer decodes all of
            // them. `--audio-quality` still applies to the formats that do get
            // re-encoded, so it stays at best.
            "-f",
            "bestaudio/best",
            "-x",
            "--audio-format",
            "best",
            "--audio-quality",
            "0",
            "--embed-metadata",
            // Do not stamp the file with the upload date. Setting times is one
            // of the things a network mount is most likely not to implement —
            // an SMB share over kio-fuse refuses it with `Inappropriate ioctl
            // for device` — and the date is of no use here anyway, because the
            // library keeps its own record of when a track arrived.
            "--no-mtime",
            // No `--embed-thumbnail`. Writing cover art into Opus or M4A needs
            // the `mutagen` Python module, which mp3 did not, so keeping the
            // native codec turned an optional nicety into a hard dependency —
            // and a missing one fails the *whole* postprocessing step. The file
            // is extracted correctly and then `after_move` never fires, so the
            // importer is never told where it landed and no row is written:
            // a download that visibly succeeded and silently imported nothing.
            //
            // Nothing in this player displays artwork, so this only ever cost
            // bytes. Verified against a real download: without it the file
            // lands, the path is printed, and no .webp/.png debris is left in
            // the library directory.
            "--newline",
            "--no-colors",
            // `--print` implies quiet; both of these undo just enough of that to
            // leave the archive-skip line visible without the full log.
            "--no-quiet",
            "--no-warnings",
            "--no-simulate",
            // A file with no row behind it is debris from an interrupted run,
            // and re-fetching is the correct recovery. Dedup is the archive's
            // job, not the filesystem's.
            "--force-overwrites",
            "--retries",
            "3",
            "--socket-timeout",
            "30",
        ]);
        if whole_playlist {
            cmd.args(["--yes-playlist", "-I", &format!(":{PLAYLIST_CAP}")]);
        } else {
            cmd.arg("--no-playlist");
        }
        cmd.arg("--download-archive").arg(&archive);
        cmd.arg("--print").arg(format!(
            "{META_TAG}%(.{{id,title,uploader,channel,duration,webpage_url}})j"
        ));
        // `after_move` is the only hook that fires once the finished mp3 is at
        // its final path — before it, `filepath` still points into the temp dir.
        cmd.arg("--print").arg(format!("after_move:{FILE_TAG}%(filepath)s"));
        cmd.arg("-P").arg(format!("home:{}", tracks_dir.display()));
        cmd.arg("-P").arg(format!("temp:{}", incoming.display()));
        cmd.arg("-o").arg("%(id)s-%(title).80B.%(ext)s");
        // Stop a URL that begins with `-` from being read as a flag.
        cmd.arg("--").arg(url);

        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = self
            .spawner
            .spawn(cmd)
            .map_err(|e| format!("cannot run {ytdlp}: {e}"))?;

        let pgid = proc::group_of(&child);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(Proc { child, pgid });
        *self.active_job.lock().unwrap_or_else(|e| e.into_inner()) = Some(Active { job_id, pgid });

        // A cancel that arrived between the check at the top of `run_job` and
        // the slot being filled would otherwise have signalled nothing.
        if self.is_cancelled(job_id) {
            terminate_group(&self.active, Some(pgid), proc::SIGINT, Duration::from_secs(5));
        }

        let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        // Kept rather than detached: the collected lines are read below, and a
        // pump still in flight has not collected them yet.
        let stderr_pump = stderr.map(|stderr| {
            let errors = Arc::clone(&errors);
            thread::spawn(move || {
                pump(stderr, |raw| {
                    let line = strip_ansi(&raw).trim_end().to_string();
                    if let Some(message) = parse_error(&line) {
                        errors
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(message);
                    }
                });
            })
        });

        // --- the per-job state machine -------------------------------------
        //
        // yt-dlp emits, per entry: one META line, then progress lines, then one
        // FILE line once the mp3 has been transcoded and moved into place. A
        // playlist repeats that block per entry. `pending` therefore holds the
        // entry currently in flight, and a FILE line without one is ignored
        // rather than guessed at.
        let mut pending: Option<Meta> = None;
        let mut last_sent = -1.0_f64;

        if let Some(stdout) = stdout {
            pump(stdout, |raw| {
                let line = strip_ansi(&raw).trim_end().to_string();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return;
                }

                if let Some(json) = trimmed.strip_prefix(META_TAG) {
                    match serde_json::from_str::<Meta>(json) {
                        Ok(meta) => {
                            let title = meta.title();
                            self.with_job(job_id, |job| {
                                job.label = title.clone();
                                job.detail = "downloading…".into();
                                job.percent = 0.0;
                            });
                            last_sent = -1.0;
                            pending = Some(meta);
                            self.publish(app);
                        }
                        Err(err) => {
                            self.with_job(job_id, |job| {
                                job.detail = format!("could not read yt-dlp's metadata: {err}");
                            });
                        }
                    }
                    return;
                }

                if let Some(path) = trimmed.strip_prefix(FILE_TAG) {
                    let Some(meta) = pending.take() else { return };
                    match self.commit(&meta, path.trim(), playlist_id) {
                        Ok(track_id) => self.with_job(job_id, |job| {
                            job.added += 1;
                            job.percent = 100.0;
                            job.track_ids.push(track_id);
                            job.detail = format!("added \"{}\"", meta.title());
                        }),
                        Err(message) => self.with_job(job_id, |job| {
                            job.failed += 1;
                            job.detail = message.clone();
                        }),
                    }
                    self.publish(app);
                    return;
                }

                if parse_archived(trimmed).is_some() {
                    pending = None;
                    self.with_job(job_id, |job| {
                        job.skipped += 1;
                        job.detail = "already in the library".into();
                    });
                    self.publish(app);
                    return;
                }

                if let Some(percent) = parse_percent(trimmed) {
                    // One event per whole percent: the progress line arrives
                    // dozens of times a second and every emit crosses the IPC
                    // bridge and re-renders the panel.
                    if percent >= last_sent + 1.0 || percent >= 100.0 {
                        last_sent = percent;
                        self.with_job(job_id, |job| job.percent = percent);
                        self.publish(app);
                    }
                }
            });
        }

        let status = wait_for_exit(&self.active);
        let code = status.and_then(|s| s.code());
        // `wait_for_exit` returns the moment the child is reaped, which on a
        // cancel or a fast failure is immediately — while the last `ERROR:` line
        // is still crossing the pipe. Reading the buffer before the pump has
        // drained it is what turned "Private video" into the exit code nobody
        // can act on. Joining costs nothing: the pipe is closed by the same
        // process death that ended the wait.
        if let Some(handle) = stderr_pump {
            let _ = handle.join();
        }
        let errors = errors.lock().unwrap_or_else(|e| e.into_inner()).clone();

        // An entry that errored mid-playlist never produced a FILE line, so the
        // in-flight metadata is still sitting there; count it as failed.
        if pending.is_some() {
            self.with_job(job_id, |job| job.failed += 1);
        }

        let snapshot = {
            let guard = self.lock();
            guard.jobs.iter().find(|j| j.id == job_id).cloned()
        };
        let (added, skipped, failed) = snapshot
            .map(|j| (j.added, j.skipped, j.failed))
            .unwrap_or((0, 0, 0));

        if self.is_cancelled(job_id) {
            let kept = if added > 0 {
                format!(" — kept the {added} already finished")
            } else {
                String::new()
            };
            self.settle(app, job_id, JobPhase::Cancelled, format!("cancelled{kept}"));
        } else if added > 0 {
            let mut detail = format!("added {added}");
            if skipped > 0 {
                detail.push_str(&format!(", {skipped} already held"));
            }
            if failed > 0 {
                detail.push_str(&format!(", {failed} unavailable"));
            }
            self.settle(app, job_id, JobPhase::Done, detail);
        } else if skipped > 0 && failed == 0 {
            self.settle(
                app,
                job_id,
                JobPhase::Skipped,
                format!("already in the library ({skipped})"),
            );
        } else {
            // Surface yt-dlp's own words — "Video unavailable", "Private
            // video", "Video is not available in your country" — rather than an
            // exit code the user cannot act on.
            let reason = errors.first().cloned().unwrap_or_else(|| match code {
                Some(c) => format!("yt-dlp exited with status {c}"),
                None => "yt-dlp was terminated".into(),
            });
            self.settle(app, job_id, JobPhase::Failed, reason);
        }

        Ok(())
    }

    /// Record a finished file as a playable row.
    ///
    /// The existence and size checks are the gate on `status = 'ready'`: this is
    /// the only place that status is written, and it is written only once the
    /// bytes are demonstrably on disk.
    ///
    /// File and row are all-or-nothing in both directions. If the row cannot be
    /// written — the database is locked by a generation run, or the playlist the
    /// import was aimed at has since been deleted — the mp3 goes with it: it
    /// sits in `tracks/`, which `clear_dir` never sweeps (only `.incoming` is
    /// scratch), so nothing would ever collect it, and `--force-overwrites`
    /// means a later re-import would not even notice it was there.
    fn commit(&self, meta: &Meta, path: &str, playlist_id: Option<i64>) -> Result<i64, String> {
        let file = Path::new(path);
        let size = std::fs::metadata(file)
            .map_err(|e| format!("\"{}\" did not land on disk: {e}", meta.title()))?
            .len();
        if size == 0 {
            let _ = std::fs::remove_file(file);
            return Err(format!("\"{}\" downloaded as an empty file", meta.title()));
        }

        match self.record(meta, file, playlist_id) {
            Ok(track_id) => Ok(track_id),
            Err(message) => {
                let _ = std::fs::remove_file(file);
                Err(message)
            }
        }
    }

    /// The database half of [`Self::commit`], in one transaction.
    ///
    /// The transaction is what makes the failure arm of `commit` safe to delete
    /// the file from: a playlist insert that fails after the track row was
    /// written would otherwise leave a `ready` row pointing at an mp3 the caller
    /// is about to remove — the exact "row the player can never load" this
    /// module exists to prevent, arrived at from the other side.
    fn record(&self, meta: &Meta, file: &Path, playlist_id: Option<i64>) -> Result<i64, String> {
        let duration = probe_duration(file).or(meta.duration);
        let mut conn = self.lib.connect()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // Belt to the archive's braces: if the row somehow already exists, add
        // it to the playlist rather than creating a second row for one file.
        if let Some(existing) = find_by_video_id(&tx, &meta.id)? {
            if let Some(pl) = playlist_id {
                append_to_playlist(&tx, pl, existing)?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(existing);
        }

        let track_id = insert_imported(
            &tx,
            &ImportedTrack {
                video_id: meta.id.clone(),
                title: meta.title(),
                uploader: meta.uploader(),
                url: meta.url(),
                duration,
                path: file.display().to_string(),
            },
        )?;
        if let Some(pl) = playlist_id {
            append_to_playlist(&tx, pl, track_id)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(track_id)
    }

    fn settle<R: Runtime>(&self, app: &AppHandle<R>, job_id: u64, phase: JobPhase, detail: String) {
        self.with_job(job_id, |job| {
            job.phase = phase;
            job.detail = detail;
            if phase != JobPhase::Done {
                job.percent = 0.0;
            }
        });
        self.publish(app);
    }
}

fn trim_history(queue: &mut Queue) {
    let settled: Vec<u64> = queue
        .jobs
        .iter()
        .filter(|j| j.phase.settled())
        .map(|j| j.id)
        .collect();
    if settled.len() <= HISTORY {
        return;
    }
    let drop: std::collections::HashSet<u64> =
        settled[..settled.len() - HISTORY].iter().copied().collect();
    queue.jobs.retain(|j| !drop.contains(&j.id));
    queue.requests.retain(|id, _| !drop.contains(id));
    queue.cancelled.retain(|id| !drop.contains(id));
}

/// Empty a directory without removing it. Best effort: a file we cannot delete
/// is not worth failing an import over.
fn clear_dir(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Start the download worker. Called once from `setup`.
pub fn spawn_worker<R: Runtime>(downloads: Downloads, app: AppHandle<R>) {
    thread::Builder::new()
        .name("download-worker".into())
        .spawn(move || downloads.run(app))
        .expect("download worker thread");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `(async)` on the two commands that leave the process: `youtube_status` walks
/// `PATH` and may fork `yt-dlp --version`, and `youtube_import` opens the
/// database and writes to it. A plain `#[tauri::command]` runs inline on the
/// IPC thread — the GTK main thread — so either of those stalls the window. See
/// the note above the commands in `library.rs`. The other three only touch the
/// in-memory queue and are genuinely instant.
#[tauri::command(async)]
pub fn youtube_status(downloads: State<'_, Downloads>) -> Tools {
    downloads.tools()
}

#[tauri::command]
pub fn youtube_jobs(downloads: State<'_, Downloads>) -> Vec<DownloadJob> {
    downloads.jobs()
}

#[tauri::command(async)]
pub fn youtube_import(
    app: AppHandle,
    downloads: State<'_, Downloads>,
    text: String,
    playlist_id: Option<i64>,
    whole_playlist: bool,
    destination: Option<String>,
) -> Result<ImportReport, String> {
    downloads.enqueue(&app, &text, playlist_id, whole_playlist, destination)
}

/// Queue a failed or cancelled download again. Async: `enqueue` opens the
/// database to check what is already held.
#[tauri::command(async)]
pub fn youtube_retry(
    app: AppHandle,
    downloads: State<'_, Downloads>,
    job_id: u64,
) -> Result<ImportReport, String> {
    downloads.retry(&app, job_id)
}

#[tauri::command]
pub fn youtube_cancel(app: AppHandle, downloads: State<'_, Downloads>, job_id: u64) {
    downloads.cancel(&app, job_id);
}

#[tauri::command]
pub fn youtube_cancel_all(app: AppHandle, downloads: State<'_, Downloads>) {
    downloads.cancel_all(&app);
}

#[tauri::command]
pub fn youtube_clear_finished(app: AppHandle, downloads: State<'_, Downloads>) {
    downloads.clear_finished(&app);
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn video(id: &str) -> Target {
        Target::Video(id.into())
    }

    const ID: &str = "dQw4w9WgXcQ";

    /// Every shape YouTube hands out, plus the ones people paste by hand.
    #[test]
    fn parses_every_youtube_url_shape() {
        let accepted: &[(&str, Target)] = &[
            // canonical
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            ("http://www.youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            ("https://youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            // no scheme at all, and protocol-relative
            ("youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            ("www.youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            ("//www.youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            // short
            ("https://youtu.be/dQw4w9WgXcQ", video(ID)),
            ("youtu.be/dQw4w9WgXcQ", video(ID)),
            ("https://youtu.be/dQw4w9WgXcQ?t=42", video(ID)),
            ("https://youtu.be/dQw4w9WgXcQ#t=42", video(ID)),
            // the other player paths
            ("https://www.youtube.com/shorts/dQw4w9WgXcQ", video(ID)),
            ("https://www.youtube.com/live/dQw4w9WgXcQ", video(ID)),
            ("https://www.youtube.com/embed/dQw4w9WgXcQ", video(ID)),
            ("https://www.youtube.com/v/dQw4w9WgXcQ", video(ID)),
            ("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", video(ID)),
            // mobile and music subdomains
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            ("https://music.youtube.com/watch?v=dQw4w9WgXcQ", video(ID)),
            // extra parameters, in either order
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s", video(ID)),
            ("https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ", video(ID)),
            (
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=1m2s",
                video(ID),
            ),
            // a bare ID, and one that uses both of the non-alphanumeric characters
            ("dQw4w9WgXcQ", video(ID)),
            ("_-aB9cD1e2F", video("_-aB9cD1e2F")),
            // punctuation picked up from the surrounding prose
            ("(https://youtu.be/dQw4w9WgXcQ),", video(ID)),
            ("<https://youtu.be/dQw4w9WgXcQ>", video(ID)),
            ("  https://youtu.be/dQw4w9WgXcQ.  ", video(ID)),
            // playlists
            (
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123",
                Target::VideoInPlaylist {
                    id: ID.into(),
                    list: "PLabc123".into(),
                },
            ),
            (
                "https://www.youtube.com/playlist?list=PLabc123",
                Target::Playlist("PLabc123".into()),
            ),
            // a playlist embed carries no video of its own
            (
                "https://www.youtube.com/embed/videoseries?list=PLabc123",
                Target::Playlist("PLabc123".into()),
            ),
        ];

        for (input, expected) in accepted {
            assert_eq!(parse_target(input).as_ref(), Ok(expected), "input: {input}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        let rejected = [
            "",
            "   ",
            "not a url",
            "https://vimeo.com/123456789",
            // right shape, wrong host — this is the one that would be a security
            // problem if the host check were a `contains`
            "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
            "javascript:alert(1)",
            // IDs of the wrong length
            "https://www.youtube.com/watch?v=short",
            "https://youtu.be/waytoolongvideoid",
            "dQw4w9WgXc",
            "dQw4w9WgXcQQ",
            // a channel, not a video
            "https://www.youtube.com/@somechannel",
            "https://www.youtube.com/c/somechannel",
        ];
        for input in rejected {
            assert!(parse_target(input).is_err(), "should reject: {input}");
        }
    }

    /// Bulk paste is copied out of prose as often as it is out of a clean list.
    #[test]
    fn pulls_candidates_out_of_pasted_prose() {
        let blob = "\
https://youtu.be/dQw4w9WgXcQ
2. https://www.youtube.com/watch?v=aaaaaaaaaaa — Some Title

   check this out https://youtu.be/bbbbbbbbbbb it is good
total nonsense on this line
";
        let found = candidates(blob);
        assert_eq!(found.len(), 4);
        assert_eq!(
            found
                .iter()
                .filter_map(|c| parse_target(c).ok())
                .filter_map(|t| t.video_id().map(str::to_string))
                .collect::<Vec<_>>(),
            vec!["dQw4w9WgXcQ", "aaaaaaaaaaa", "bbbbbbbbbbb"]
        );
        assert!(
            parse_target(&found[3]).is_err(),
            "the junk line is kept so the report can name it"
        );
    }

    /// A single-line input field flattens a multi-line paste into one
    /// space-separated run, so every link on a line has to be taken, not just
    /// the first.
    #[test]
    fn takes_every_link_on_one_line() {
        let found = candidates("https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb ccccccccccc");
        assert_eq!(
            found
                .iter()
                .filter_map(|c| parse_target(c).ok())
                .filter_map(|t| t.video_id().map(str::to_string))
                .collect::<Vec<_>>(),
            vec!["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]
        );
    }

    #[test]
    fn reads_ytdlp_progress_and_status_lines() {
        assert_eq!(
            parse_percent("[download]   0.4% of  246.27KiB at  948.51KiB/s ETA 00:00"),
            Some(0.4)
        );
        assert_eq!(
            parse_percent("[download] 100% of  246.27KiB in 00:00:00 at 4.48MiB/s"),
            Some(100.0)
        );
        assert_eq!(parse_percent("[youtube] Extracting URL: https://…"), None);

        assert_eq!(
            parse_archived("[download] jNQXAC9IVRw: has already been recorded in the archive"),
            Some("jNQXAC9IVRw".into())
        );
        // What yt-dlp actually prints today: the title sits between the ID and
        // the phrase. Verified against yt-dlp 2026.07.04.
        assert_eq!(
            parse_archived(
                "[download] jNQXAC9IVRw: Me at the zoo has already been recorded in the archive"
            ),
            Some("jNQXAC9IVRw".into())
        );
        assert_eq!(parse_archived("[download] Destination: foo.mp3"), None);

        // The extractor tag and the ID are already on screen; only the tail is
        // worth showing the user.
        assert_eq!(
            parse_error("ERROR: [youtube] aaaaaaaaaaa: Video unavailable"),
            Some("Video unavailable".into())
        );
        assert_eq!(
            parse_error(
                "ERROR: [youtube] bbbbbbbbbbb: Private video. Sign in if you've been granted access"
            ),
            Some("Private video. Sign in if you've been granted access".into())
        );
        assert_eq!(parse_error("[download] 50% of 1MiB"), None);
    }

    // -- the download path ---------------------------------------------------

    struct Fixture {
        root: PathBuf,
        lib: Library,
        ytdlp: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// A stand-in for `yt-dlp` that prints exactly the lines the real one
    /// prints, in the order the real one prints them, with no network in sight.
    #[cfg(target_os = "linux")]
    fn fixture(tag: &str, script: &str) -> Fixture {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "music-ai-yt-{tag}-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mkdir");

        let lib = Library::at(root.join("library").join("library.db"));
        lib.migrate().expect("migrate");

        // `Tools::discover` probes `--version` before every job, exactly as it
        // does against the real binary, so the fake has to answer it and exit
        // rather than starting a download.
        let ytdlp = root.join("fake-yt-dlp");
        let guarded = format!(
            "#!/bin/sh\ncase \"$1\" in --version) echo 2026.07.04; exit 0;; esac\n{}",
            script.trim_start_matches("#!/bin/sh\n")
        );
        std::fs::write(&ytdlp, guarded).expect("write script");
        std::fs::set_permissions(&ytdlp, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        Fixture { root, lib, ytdlp }
    }

    #[cfg(target_os = "linux")]
    fn wait_until(label: &str, mut predicate: impl FnMut() -> bool) {
        for _ in 0..400 {
            if predicate() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("timed out waiting for {label}");
    }

    #[cfg(target_os = "linux")]
    fn ready_rows(lib: &Library) -> Vec<(String, String)> {
        let conn = lib.connect().expect("connect");
        let mut stmt = conn
            .prepare("SELECT video_id, path FROM tracks WHERE status = 'ready' ORDER BY id")
            .expect("prepare");
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .and_then(|rows| rows.collect())
            .expect("rows")
    }

    /// The invariant the whole module exists to protect: a download that is
    /// cancelled part way through leaves the finished entry in the library and
    /// leaves *nothing at all* for the entry that was still in flight — no row,
    /// no stray file, and no surviving grandchild process.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_cancelled_download_commits_only_what_finished() {
        if which("ffmpeg").is_none() {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        }

        let tracks = std::env::temp_dir().join(format!(
            "music-ai-yt-cancel-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let home = tracks.join("library").join("tracks");
        let incoming = home.join(INCOMING_DIRNAME);
        let pidfile = tracks.join("grandchild.pid");

        let script = format!(
            r#"#!/bin/sh
# First entry: metadata, progress, a real file, then the after_move line.
printf 'MAIP-META {{"id": "aaaaaaaaaaa", "title": "First", "uploader": "chan", "duration": 10, "webpage_url": "https://youtu.be/aaaaaaaaaaa"}}\n'
printf '[download]  50.0%% of 1.00MiB at 1.00MiB/s ETA 00:01\n'
mkdir -p '{home}'
printf 'not silence, but bytes' > '{home}/aaaaaaaaaaa-First.mp3'
printf 'MAIP-FILE {home}/aaaaaaaaaaa-First.mp3\n'
# Second entry: announced, then interrupted mid-download.
printf 'MAIP-META {{"id": "bbbbbbbbbbb", "title": "Second", "uploader": "chan", "duration": 10, "webpage_url": "https://youtu.be/bbbbbbbbbbb"}}\n'
printf '[download]  20.0%% of 1.00MiB at 1.00MiB/s ETA 00:04\n'
mkdir -p '{incoming}'
printf 'half a file' > '{incoming}/bbbbbbbbbbb-Second.mp3.part'
# Stand-in for the ffmpeg yt-dlp forks: it inherits stdout, so only a group
# signal closes the pipe and lets the reader finish.
sleep 300 &
echo $! > '{pidfile}'
wait
"#,
            home = home.display(),
            incoming = incoming.display(),
            pidfile = pidfile.display(),
        );

        let fx = fixture("cancel", &script);
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let downloads = Downloads::with_ytdlp(fx.lib.clone(), Some(fx.ytdlp.clone()));
        spawn_worker(downloads.clone(), handle.clone());

        let report = downloads
            .enqueue(&handle, "https://youtu.be/aaaaaaaaaaa", None, false, None)
            .expect("enqueue");
        assert_eq!(report.queued, 1);
        let job_id = report.lines[0].job_id.expect("job id");

        wait_until("the first entry to commit", || {
            downloads.jobs().iter().any(|j| j.id == job_id && j.added == 1)
        });
        wait_until("the grandchild to start", || pidfile.is_file());
        let grandchild: i32 = std::fs::read_to_string(&pidfile)
            .expect("pidfile")
            .trim()
            .parse()
            .expect("pid");

        downloads.cancel(&handle, job_id);
        wait_until("the job to settle as cancelled", || {
            downloads
                .jobs()
                .iter()
                .any(|j| j.id == job_id && j.phase == JobPhase::Cancelled)
        });

        // Only the entry that finished is playable.
        let rows = ready_rows(&fx.lib);
        assert_eq!(rows.len(), 1, "exactly one row survived: {rows:?}");
        assert_eq!(rows[0].0, "aaaaaaaaaaa");
        assert!(
            Path::new(&rows[0].1).is_file(),
            "a ready row must point at a real file"
        );

        // Nothing at all for the interrupted one — not even a failed row.
        let conn = fx.lib.connect().expect("connect");
        assert_eq!(
            find_by_video_id(&conn, "bbbbbbbbbbb").expect("lookup"),
            None,
            "the interrupted entry left no row behind"
        );

        // The part-file was swept, and it never reached `tracks/` to begin with.
        assert!(
            std::fs::read_dir(&incoming)
                .map(|mut d| d.next().is_none())
                .unwrap_or(true),
            "the scratch directory was not cleared"
        );
        let strays: Vec<String> = std::fs::read_dir(&home)
            .expect("read tracks dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name != INCOMING_DIRNAME && name != "aaaaaaaaaaa-First.mp3")
            .collect();
        assert!(strays.is_empty(), "left debris in tracks/: {strays:?}");

        // And the transcode stand-in went with the process group.
        wait_until("the grandchild to die", || {
            !crate::proc::still_running(grandchild)
        });

        downloads.shutdown();
        let _ = std::fs::remove_dir_all(&tracks);
    }

    /// yt-dlp failing outright — a removed, private or region-blocked video —
    /// must leave the library exactly as it was, and must say why.
    ///
    /// The ERROR line is deliberately emitted *after* yt-dlp itself exits, from
    /// a subshell that does not hold stdout. That is the real shape of the race:
    /// `wait_for_exit` returns the instant the child is reaped, and reading the
    /// collected errors before the stderr pump has drained gives the user
    /// "yt-dlp exited with status 1" instead of the reason.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_failed_download_leaves_no_row() {
        if which("ffmpeg").is_none() {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        }

        let script = r#"#!/bin/sh
printf 'MAIP-META {"id": "aaaaaaaaaaa", "title": "Gone", "duration": 10}\n'
( sleep 0.4; printf 'ERROR: [youtube] aaaaaaaaaaa: Video unavailable\n' >&2 ) >/dev/null &
exit 1
"#;
        let fx = fixture("failed", script);
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let downloads = Downloads::with_ytdlp(fx.lib.clone(), Some(fx.ytdlp.clone()));
        spawn_worker(downloads.clone(), handle.clone());

        let report = downloads
            .enqueue(&handle, "https://youtu.be/aaaaaaaaaaa", None, false, None)
            .expect("enqueue");
        let job_id = report.lines[0].job_id.expect("job id");

        wait_until("the job to fail", || {
            downloads
                .jobs()
                .iter()
                .any(|j| j.id == job_id && j.phase == JobPhase::Failed)
        });

        let job = downloads
            .jobs()
            .into_iter()
            .find(|j| j.id == job_id)
            .expect("job");
        assert_eq!(
            job.detail, "Video unavailable",
            "yt-dlp's own words reach the user, even when the line lands after \
             the process is already reaped"
        );
        assert_eq!(job.added, 0);
        assert!(ready_rows(&fx.lib).is_empty(), "no row for a failed fetch");

        downloads.shutdown();
    }

    /// Re-pasting a URL already in the library is answered immediately, without
    /// yt-dlp being started at all.
    #[cfg(target_os = "linux")]
    #[test]
    fn re_adding_a_known_video_is_reported_not_repeated() {
        // The script would create a second row if it ever ran; it must not.
        let script = r#"#!/bin/sh
printf 'MAIP-META {"id": "aaaaaaaaaaa", "title": "Should never run"}\n'
exit 0
"#;
        let fx = fixture("dedup", script);
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let existing = {
            let conn = fx.lib.connect().expect("connect");
            insert_imported(
                &conn,
                &ImportedTrack {
                    video_id: "aaaaaaaaaaa".into(),
                    title: "Already here".into(),
                    uploader: None,
                    url: "https://youtu.be/aaaaaaaaaaa".into(),
                    duration: Some(60.0),
                    path: "/tmp/already.mp3".into(),
                },
            )
            .expect("seed")
        };

        let downloads = Downloads::with_ytdlp(fx.lib.clone(), Some(fx.ytdlp.clone()));
        let playlist = {
            let conn = fx.lib.connect().expect("connect");
            crate::library::new_playlist(&conn, "Mix").expect("playlist")
        };

        let report = downloads
            .enqueue(
                &handle,
                "https://www.youtube.com/watch?v=aaaaaaaaaaa",
                Some(playlist),
                false,
                None,
            )
            .expect("enqueue");

        assert_eq!(report.queued, 0, "nothing was queued");
        assert_eq!(report.duplicates, 1);
        assert!(!report.lines[0].accepted);
        assert!(
            report.lines[0].reason.contains("added to the playlist"),
            "a known video still joins the playlist: {}",
            report.lines[0].reason
        );
        assert!(downloads.jobs().is_empty(), "no job was created");

        // It is in the playlist exactly once, and there is still one row.
        let conn = fx.lib.connect().expect("connect");
        let items = crate::library::playlist_items(&conn, playlist).expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].track.id, existing);
    }

    /// The real thing, against the real network: 19 seconds of public-domain
    /// video, downloaded with the exact argument list the app builds.
    ///
    /// `#[ignore]`d so the normal suite neither touches the network nor depends
    /// on yt-dlp being installed. Run it deliberately:
    /// `cargo test --bin music-ai-player -- --ignored --nocapture`
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "hits the network and needs a real yt-dlp"]
    fn end_to_end_against_the_real_ytdlp() {
        let Some(ytdlp) = which("yt-dlp") else {
            eprintln!("skipping: yt-dlp is not installed");
            return;
        };

        let root = std::env::temp_dir().join(format!("music-ai-yt-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let lib = Library::at(root.join("library").join("library.db"));
        lib.migrate().expect("migrate");

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let downloads = Downloads::with_ytdlp(lib.clone(), Some(ytdlp));
        spawn_worker(downloads.clone(), handle.clone());

        // "Me at the zoo" — the first video uploaded to YouTube, 19 seconds.
        let report = downloads
            .enqueue(&handle, "https://youtu.be/jNQXAC9IVRw", None, false, None)
            .expect("enqueue");
        let job_id = report.lines[0].job_id.expect("job id");

        for _ in 0..600 {
            if let Some(job) = downloads.jobs().into_iter().find(|j| j.id == job_id) {
                if job.phase.settled() {
                    assert_eq!(job.phase, JobPhase::Done, "detail: {}", job.detail);
                    break;
                }
            }
            thread::sleep(Duration::from_millis(100));
        }

        let rows = ready_rows(&lib);
        assert_eq!(rows.len(), 1, "one row: {rows:?}");
        assert_eq!(rows[0].0, "jNQXAC9IVRw");

        let conn = lib.connect().expect("connect");
        let (title, uploader, duration, path): (String, Option<String>, Option<f64>, String) = conn
            .query_row(
                "SELECT title, uploader, duration, path FROM tracks WHERE video_id = 'jNQXAC9IVRw'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("row");

        eprintln!("title={title:?} uploader={uploader:?} duration={duration:?} path={path}");
        assert!(!title.is_empty() && title != "jNQXAC9IVRw", "a real title");
        assert!(uploader.is_some(), "the channel came through");
        // ffprobe measured the file we actually wrote, not the video length.
        let seconds = duration.expect("duration");
        assert!(
            (18.0..21.0).contains(&seconds),
            "duration should be ~19s, got {seconds}"
        );
        assert!(Path::new(&path).is_file(), "the mp3 is on disk");
        assert!(
            std::fs::metadata(&path).expect("stat").len() > 10_000,
            "and it has audio in it"
        );

        downloads.shutdown();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A finished mp3 whose row cannot be written must not be left behind.
    ///
    /// `clear_dir` only ever sweeps `.incoming`, so a file that reached
    /// `tracks/` with no row behind it is never collected — and it is reachable:
    /// `lib.connect()` fails while a generation run holds the write lock, and
    /// the playlist the import was aimed at can be deleted mid-download. A
    /// dangling foreign key stands in for both here, because it fails *after*
    /// the track row has already been inserted, which is the arm that has to
    /// roll back rather than leave a `ready` row pointing at a deleted file.
    #[test]
    fn a_failed_commit_leaves_no_orphaned_file() {
        let root = std::env::temp_dir().join(format!(
            "music-ai-yt-orphan-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let lib = Library::at(root.join("library").join("library.db"));
        lib.migrate().expect("migrate");

        let file = lib.tracks_dir().join("aaaaaaaaaaa-Orphan.mp3");
        std::fs::write(&file, b"not silence, but bytes").expect("write");

        let downloads = Downloads::with_ytdlp(lib.clone(), Some(PathBuf::from("/nonexistent")));
        let meta = Meta {
            id: "aaaaaaaaaaa".into(),
            title: Some("Orphan".into()),
            uploader: None,
            channel: None,
            duration: Some(10.0),
            webpage_url: None,
        };

        // No playlist 9999: the append fails once the track row is already in.
        let err = downloads
            .commit(&meta, &file.display().to_string(), Some(9999))
            .expect_err("the commit cannot succeed");

        assert!(
            !file.exists(),
            "a commit that failed left the mp3 in tracks/ forever: {err}"
        );
        let conn = lib.connect().expect("connect");
        assert_eq!(
            find_by_video_id(&conn, "aaaaaaaaaaa").expect("lookup"),
            None,
            "the failed commit must not leave a row either"
        );

        downloads.shutdown();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// With no `yt-dlp` on the machine the panel has to say what to install,
    /// not fail with a bare ENOENT.
    #[test]
    fn a_missing_ytdlp_is_an_actionable_message() {
        let lib = Library::at(std::env::temp_dir().join("music-ai-nonexistent/library.db"));
        let tools = Tools::discover(&lib, Some(Path::new("/nonexistent/yt-dlp")));
        assert!(tools.ytdlp_path.is_none());
        let blocker = tools.blocker.expect("a blocker");
        assert!(blocker.contains("yt-dlp"), "{blocker}");
        assert!(blocker.contains("install"), "{blocker}");
    }
}
