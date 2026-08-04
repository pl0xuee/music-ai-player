//! Adopting audio files that are already on this machine.
//!
//! The other two sources *produce* files — the generator renders them, the
//! importer downloads them — and both write into the library directory. This
//! one only takes note of what is already there. Nothing is copied and nothing
//! is moved: a row points at the file where the user keeps it, and deleting the
//! row leaves the file untouched.
//!
//! That is the whole reason the media server resolves paths through the
//! database rather than serving a directory. A row here can point anywhere on
//! the filesystem, and it plays exactly like a generated one.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::library::{find_by_path, insert_local, Library, LocalTrack};

/// Emitted as the scan works through what it found.
pub const EV_PROGRESS: &str = "local:progress";

/// What counts as audio.
///
/// Every one of these decodes through GStreamer and has a content type the
/// media server knows, so anything matched here really is playable rather than
/// merely recognised.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav", "wave", "aiff", "aif", "wma",
    "alac", "ape", "mpc", "webm",
];

/// How deep a folder tree is followed.
///
/// Music collections nest a few levels — artist, album, disc — and stopping at
/// eight covers that with room to spare while putting a hard bound on a scan
/// pointed at a filesystem root.
const MAX_DEPTH: usize = 8;

/// Ceiling on one scan.
///
/// A folder chosen by mistake — a home directory, or `/` — should come back
/// with a clear answer rather than probing tens of thousands of files. The
/// report says when this was hit, so a truncated scan never looks complete.
const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub added: usize,
    /// Files already in the library, by path.
    pub skipped: usize,
    /// Files that looked like audio but could not be read as any.
    pub failed: usize,
    /// True when [`MAX_FILES`] stopped the walk before it ran out of folders.
    pub truncated: bool,
    /// First few failures, for a message the user can act on.
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
    /// Name of the file being probed, for something to show while it works.
    pub current: String,
}

/// Walk `paths` — files, folders, or a mix — and adopt every audio file found.
#[tauri::command(async)]
pub fn scan_local(
    app: AppHandle,
    lib: State<'_, Library>,
    paths: Vec<String>,
) -> Result<ScanReport, String> {
    let (files, truncated) = collect(&paths);
    let total = files.len();
    let conn = lib.connect()?;

    let mut report = ScanReport {
        added: 0,
        skipped: 0,
        failed: 0,
        truncated,
        errors: Vec::new(),
    };

    for (done, file) in files.iter().enumerate() {
        let _ = app.emit(
            EV_PROGRESS,
            ScanProgress {
                done,
                total,
                current: file_label(file),
            },
        );

        let path = file.to_string_lossy().into_owned();
        if find_by_path(&conn, &path)?.is_some() {
            report.skipped += 1;
            continue;
        }

        match probe(file) {
            // No duration means ffprobe could not find an audio stream, which
            // is the difference between a file named `.mp3` and a file that is
            // one. A ready row pointing at the former stalls a deck.
            None => {
                report.failed += 1;
                if report.errors.len() < 5 {
                    report.errors.push(format!("no audio in {}", file_label(file)));
                }
            }
            Some(found) => match insert_local(&conn, &found) {
                Ok(_) => report.added += 1,
                Err(err) => {
                    report.failed += 1;
                    if report.errors.len() < 5 {
                        report.errors.push(err);
                    }
                }
            },
        }
    }

    let _ = app.emit(
        EV_PROGRESS,
        ScanProgress {
            done: total,
            total,
            current: String::new(),
        },
    );
    Ok(report)
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/// Every audio file under `roots`, deduplicated, plus whether the walk was cut
/// short by [`MAX_FILES`].
fn collect(roots: &[String]) -> (Vec<PathBuf>, bool) {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = false;

    for root in roots {
        let path = PathBuf::from(root);
        walk(&path, 0, &mut found, &mut seen, &mut truncated);
    }

    // Alphabetical, so a scan of an album folder adds its tracks in the order
    // they appear on disk rather than whatever order the filesystem hands back.
    found.sort();
    (found, truncated)
}

fn walk(
    path: &Path,
    depth: usize,
    found: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
    truncated: &mut bool,
) {
    if found.len() >= MAX_FILES {
        *truncated = true;
        return;
    }

    // `symlink_metadata` rather than `metadata`: a symlink pointing back up its
    // own tree would otherwise be followed until the depth cap, adding every
    // file under it again on the way.
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }

    if meta.is_file() {
        if !is_audio(path) {
            return;
        }
        // Canonical, so the same file reached through two different folder
        // arguments is adopted once.
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if seen.insert(key.clone()) {
            found.push(key);
        }
        return;
    }

    if !meta.is_dir() || depth >= MAX_DEPTH {
        return;
    }
    // A dot-directory in a music folder is cache or metadata, never music.
    if depth > 0 && file_label(path).starts_with('.') {
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        walk(&entry.path(), depth + 1, found, seen, truncated);
    }
}

fn is_audio(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    AUDIO_EXTENSIONS.contains(&ext.as_str())
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/// Duration and tags in one pass, or `None` if this is not really audio.
///
/// The duration is what the crossfade schedules itself against, so it is
/// measured rather than guessed; a file with no readable duration is refused
/// outright instead of becoming a row that stalls a deck at the handover.
fn probe(file: &Path) -> Option<LocalTrack> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration:format_tags=title,artist,album_artist,genre",
            "-of",
            "json",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }

    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let format = parsed.get("format")?;
    let duration: Option<f64> = format
        .get("duration")
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse().ok())
        .filter(|d: &f64| d.is_finite() && *d > 0.0);
    duration?;

    let tag = |name: &str| -> Option<String> {
        format
            .get("tags")
            .and_then(|t| t.get(name))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };

    Some(LocalTrack {
        // An untagged file still has a name, and a filename is very often the
        // only title a downloaded or ripped track ever had.
        title: tag("title").unwrap_or_else(|| stem(file)),
        artist: tag("artist").or_else(|| tag("album_artist")),
        genre: tag("genre"),
        duration,
        path: file.to_string_lossy().into_owned(),
    })
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_label(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempTree(PathBuf);

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tree(tag: &str) -> TempTree {
        let root = std::env::temp_dir().join(format!(
            "music-ai-local-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create");
        TempTree(root)
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, b"not audio, just bytes").expect("write");
    }

    #[test]
    fn finds_audio_and_ignores_everything_else() {
        let t = tree("walk");
        touch(&t.0.join("a.mp3"));
        touch(&t.0.join("b.FLAC"));
        touch(&t.0.join("Album/c.opus"));
        touch(&t.0.join("Album/cover.jpg"));
        touch(&t.0.join("notes.txt"));
        touch(&t.0.join(".cache/d.mp3"));

        let (files, truncated) = collect(&[t.0.to_string_lossy().into_owned()]);
        let names: Vec<String> = files.iter().map(|f| file_label(f)).collect();

        assert!(names.contains(&"a.mp3".to_string()));
        assert!(names.contains(&"b.FLAC".to_string()), "extension match is case-insensitive");
        assert!(names.contains(&"c.opus".to_string()), "nested folders are walked");
        assert!(!names.contains(&"cover.jpg".to_string()));
        assert!(!names.contains(&"notes.txt".to_string()));
        assert!(!names.contains(&"d.mp3".to_string()), "dot-directories are cache, not music");
        assert!(!truncated);
    }

    #[test]
    fn the_same_file_reached_twice_is_collected_once() {
        let t = tree("dedup");
        touch(&t.0.join("Album/a.mp3"));
        let root = t.0.to_string_lossy().into_owned();
        let album = t.0.join("Album").to_string_lossy().into_owned();

        // The folder and one of its children, both passed at once — which is
        // exactly what a multi-select drop produces.
        let (files, _) = collect(&[root, album]);
        assert_eq!(files.len(), 1, "got {files:?}");
    }

    #[test]
    fn a_file_passed_directly_is_taken() {
        let t = tree("direct");
        let file = t.0.join("one.mp3");
        touch(&file);
        let (files, _) = collect(&[file.to_string_lossy().into_owned()]);
        assert_eq!(files.len(), 1);
    }

    /// Named like audio, but with no audio in it. `probe` is what keeps these
    /// out, and it has to, because a `ready` row that cannot decode stalls a
    /// deck instead of being skipped.
    #[test]
    fn a_file_that_is_not_really_audio_is_refused() {
        let t = tree("fake");
        let file = t.0.join("lying.mp3");
        touch(&file);
        assert!(probe(&file).is_none());
    }

    #[test]
    fn a_missing_path_is_not_an_error() {
        let (files, truncated) = collect(&["/nonexistent/nowhere".into()]);
        assert!(files.is_empty());
        assert!(!truncated);
    }
}
