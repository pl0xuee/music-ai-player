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
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::library::{find_by_path, insert_local, update_local_meta, Library, LocalTrack};

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
    /// Rows already held whose title was repaired from the file's own tags.
    /// See [`needs_retitle`].
    pub updated: usize,
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

    // Committed in batches rather than per row. SQLite gives every unwrapped
    // INSERT its own transaction, and therefore its own fsync: adopting a real
    // music collection of several thousand files that way takes minutes of
    // pure disk sync. Batching keeps the write lock short enough that the
    // generator can still get in between batches, and means an interrupted
    // scan keeps everything up to the last commit rather than nothing.
    const BATCH: usize = 200;
    let mut open_batch = false;
    let begin = |conn: &rusqlite::Connection| -> Result<(), String> {
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())
    };
    let commit = |conn: &rusqlite::Connection| -> Result<(), String> {
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())
    };

    let mut report = ScanReport {
        added: 0,
        skipped: 0,
        updated: 0,
        failed: 0,
        truncated,
        errors: Vec::new(),
    };

    for (done, file) in files.iter().enumerate() {
        if !open_batch {
            begin(&conn)?;
            open_batch = true;
        }
        let _ = app.emit(
            EV_PROGRESS,
            ScanProgress {
                done,
                total,
                current: file_label(file),
            },
        );

        let path = file.to_string_lossy().into_owned();
        // No `continue` anywhere in here: it would jump the batch check at the
        // bottom, and a scan that is mostly files already held would then keep
        // one transaction open from beginning to end — the exact lock the
        // batching exists to avoid.
        match find_by_path(&conn, &path)? {
            Some((id, title)) if needs_retitle(file, &title) => {
                match probe(file) {
                    // Leave the row exactly as it is. A file that would not
                    // probe this time is a network share gone quiet, not a
                    // reason to throw away the only title the row has.
                    None => report.skipped += 1,
                    Some(found) => match update_local_meta(&conn, id, &found) {
                        Ok(()) => report.updated += 1,
                        Err(err) => {
                            report.failed += 1;
                            if report.errors.len() < 5 {
                                report.errors.push(err);
                            }
                        }
                    },
                }
            }
            Some(_) => report.skipped += 1,
            None => match probe(file) {
                // No duration means ffprobe found no audio stream, which is the
                // difference between a file named `.mp3` and a file that is one.
                // A ready row pointing at the former stalls a deck.
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
            },
        }

        if (done + 1) % BATCH == 0 {
            commit(&conn)?;
            open_batch = false;
        }
    }

    if open_batch {
        commit(&conn)?;
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

/// Whether a row already in the library is worth probing a second time.
///
/// Re-scanning a folder is meant to be cheap: a path already held is a database
/// lookup and nothing else, which is what lets a twenty-thousand-file collection
/// be re-scanned without twenty thousand `ffprobe` runs. This is the one
/// exception, and it is drawn as narrowly as it can be — the stored title has to
/// be *verbatim* the filename, and that filename has to carry a video ID.
///
/// That is exactly the shape left behind by the scanner reading only container
/// tags: every `.opus` yt-dlp wrote was adopted under its own filename, ID and
/// all. Nothing a user has renamed and nothing tagged matches, and the repair
/// does not repeat — once the title is the real one it no longer equals the
/// stem, so the next scan skips the row for good.
fn needs_retitle(file: &Path, stored: &str) -> bool {
    let raw = stem(file);
    stored == raw && strip_video_id(&raw).is_some()
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
///
/// Tags are asked for on the *stream* as well as the container, because where
/// they live depends on the format. MP3 keeps ID3 in the container, so ffprobe
/// reports it under `format.tags`; Ogg, Opus and FLAC carry Vorbis comments on
/// the audio stream, and for those `format.tags` is empty. Reading only the
/// container is why every `.opus` fell through to its filename — which, for
/// anything yt-dlp wrote, means an eleven-character video ID on screen.
fn probe(file: &Path) -> Option<LocalTrack> {
    const WANTED: &str = "title,artist,album_artist,genre";

    let out = crate::proc::external("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            &format!("format=duration:format_tags={WANTED}:stream_tags={WANTED}"),
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

    // Container first, then the stream: a file carrying both is being explicit
    // about the container copy, and only one of the two is ever populated in
    // practice anyway.
    let sources = [
        format.get("tags"),
        parsed
            .get("streams")
            .and_then(|streams| streams.get(0))
            .and_then(|stream| stream.get("tags")),
    ];
    let tag = |name: &str| -> Option<String> {
        sources.iter().flatten().find_map(|tags| lookup(tags, name))
    };

    Some(LocalTrack {
        // An untagged file still has a name, and a filename is very often the
        // only title a downloaded or ripped track ever had.
        title: tag("title").unwrap_or_else(|| title_from_name(file)),
        artist: tag("artist").or_else(|| tag("album_artist")),
        genre: tag("genre"),
        duration,
        path: file.to_string_lossy().into_owned(),
    })
}

/// One tag out of an ffprobe `tags` object, ignoring case.
///
/// The same tag comes back spelled differently per format — `title` out of an
/// Ogg comment, `TITLE` out of a FLAC one — and a case-sensitive lookup silently
/// finds nothing for half of them.
fn lookup(tags: &serde_json::Value, name: &str) -> Option<String> {
    tags.as_object()?
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_label(path))
}

/// The filename as a title, with the marks of the downloader taken back out.
///
/// A file with no tags gets its name shown, and two things about a name written
/// by `yt-dlp` are not part of anyone's title: the video ID it puts in front,
/// and the lookalike characters it substitutes for the ones a filesystem will
/// not take. Both are undone here rather than in the scanner so that every
/// route to a filename-derived title gets the same treatment.
fn title_from_name(path: &Path) -> String {
    let raw = stem(path);
    restore_reserved(strip_video_id(&raw).unwrap_or(&raw))
}

/// A YouTube video ID is eleven characters of URL-safe base64, and `yt-dlp`'s
/// output template puts one in front of the title: `dQw4w9WgXcQ-Some Title`.
const ID_LEN: usize = 11;

/// The title out of `<id>-<title>`, if the name really is in that shape.
///
/// Deliberately strict — exactly eleven characters from the ID alphabet, a
/// hyphen, and something left over — so that an ordinary `Artist-Track` name is
/// not mistaken for one. A track genuinely called `Eleven char-…` loses nothing
/// it will miss, and the alternative is leaving an ID on screen for every file
/// in a downloaded folder.
fn strip_video_id(stem: &str) -> Option<&str> {
    if !stem.is_char_boundary(ID_LEN) {
        return None;
    }
    let (id, rest) = stem.split_at(ID_LEN);
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    rest.strip_prefix('-').filter(|title| !title.is_empty())
}

/// The characters a filesystem reserves, and the lookalikes `yt-dlp` writes in
/// their place, so `AC/DC | Live` reaches the disk as `AC⧸DC ｜ Live`.
///
/// Both directions of this table live here on purpose. [`crate::youtube`] mints
/// names with [`filename_safe`] and this module reads them back with
/// [`restore_reserved`]; they are one table read two ways, and two tables would
/// drift. The mapping is `yt-dlp`'s rather than one of our own so that a folder
/// the user filled with their *own* `yt-dlp` reads back just as well.
const RESERVED: &[(char, char)] = &[
    ('/', '⧸'),
    ('\\', '⧹'),
    ('|', '｜'),
    (':', '：'),
    ('?', '？'),
    ('*', '＊'),
    ('<', '＜'),
    ('>', '＞'),
    ('"', '＂'),
];

/// A filename read back as the title it was made from. Shown verbatim the
/// lookalikes are mojibake; put back, the line is the one YouTube had.
fn restore_reserved(name: &str) -> String {
    name.chars()
        .map(|c| {
            RESERVED
                .iter()
                .find(|(_, stand_in)| *stand_in == c)
                .map_or(c, |(reserved, _)| *reserved)
        })
        .collect()
}

/// A title turned into one filename component, or `None` if nothing usable
/// survives — a title of nothing but dots and slashes leaves no name at all,
/// and the caller keeps whatever it already had.
///
/// `max_bytes` bounds the result the way `yt-dlp`'s own `.80B` conversion does,
/// on a character boundary so the name stays valid UTF-8.
///
/// What is taken out, beyond the reserved characters: control characters, which
/// no filename should carry; and leading dots, which would hide the file from
/// the user and from the scanner's own idea of what a dot-name means.
pub fn filename_safe(title: &str, max_bytes: usize) -> Option<String> {
    let swapped: String = title
        .chars()
        .map(|c| {
            if c.is_control() {
                ' '
            } else {
                RESERVED
                    .iter()
                    .find(|(reserved, _)| *reserved == c)
                    .map_or(c, |(_, stand_in)| *stand_in)
            }
        })
        .collect();

    // Trimmed after the cut, so a truncation landing mid-word cannot leave a
    // trailing space behind, and never before it, so the cut cannot re-introduce
    // one at the end.
    let cut = truncate_bytes(&swapped, max_bytes);
    let trimmed = cut.trim_matches(|c: char| c == '.' || c.is_whitespace());
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// The longest prefix of `s` that fits in `max` bytes without splitting a
/// character.
fn truncate_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
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

    #[test]
    fn a_downloaded_name_loses_its_video_id() {
        assert_eq!(
            title_from_name(Path::new("/m/NmrSeXD6LVI-Showtek - The F Track.opus")),
            "Showtek - The F Track"
        );
        // Hyphens and underscores are in the ID alphabet, so an ID may contain
        // them and the split still has to land on the eleventh character.
        assert_eq!(
            title_from_name(Path::new("/m/pG2aljzW-T8-No One Came To Mourn Me.opus")),
            "No One Came To Mourn Me"
        );
    }

    #[test]
    fn an_ordinary_name_keeps_every_character_of_itself() {
        for name in [
            "Nine Inch Nails - Closer.mp3",
            // Eleven characters, but no hyphen after them.
            "Elevenchars Track.flac",
            // A hyphen in the right place, but the run before it is not an ID.
            "Some Title -Remix.mp3",
            // Nothing left over once the ID and hyphen are taken.
            "dQw4w9WgXcQ-.opus",
            // Too short to hold one at all.
            "short-a.mp3",
        ] {
            let expected = name.rsplit_once('.').expect("has an extension").0;
            assert_eq!(title_from_name(Path::new(name)), expected, "{name}");
        }
    }

    /// The two halves of [`RESERVED`] have to stay inverses of each other: the
    /// importer names a file with one and the scanner reads it back with the
    /// other, and a title that does not survive the trip is a title shown wrong.
    #[test]
    fn a_title_survives_being_made_into_a_filename_and_read_back() {
        for title in [
            "AC/DC | Live: 1978?",
            "Where? * When < Then > Now",
            "Say \"hello\" \\ goodbye",
            "Nothing reserved in here at all",
            "Показать кириллицу тоже",
        ] {
            let name = filename_safe(title, 80).expect("a usable name");
            let path = PathBuf::from(format!("/m/{name}.opus"));
            assert_eq!(title_from_name(&path), title, "{title}");
        }
    }

    /// The one place the round trip does not close, recorded rather than
    /// pretended away: a title that already contains a stand-in character comes
    /// back as the reserved one it stands for. `yt-dlp` reads its own names the
    /// same way, there is nothing in the name to tell the two apart, and a title
    /// genuinely containing U+29F8 is a price worth paying for reading every
    /// ordinary one correctly.
    #[test]
    fn a_title_already_holding_a_stand_in_is_read_as_the_character_it_stands_for() {
        assert_eq!(title_from_name(Path::new("/m/A ⧸ B.opus")), "A / B");
    }

    #[test]
    fn a_title_that_is_no_filename_at_all_yields_none() {
        assert_eq!(filename_safe("...", 80), None);
        assert_eq!(filename_safe("   ", 80), None);
        assert_eq!(filename_safe("", 80), None);
        // A leading dot would hide the file; the rest of the name still stands.
        assert_eq!(filename_safe(".hidden", 80).as_deref(), Some("hidden"));
    }

    #[test]
    fn the_characters_a_filesystem_refused_come_back() {
        assert_eq!(
            title_from_name(Path::new("/m/zMbwjGa7UJs-Hardstyle ｜ Euphoric ⧸ Melodic.opus")),
            "Hardstyle | Euphoric / Melodic"
        );
    }

    /// The regression this module's tag handling exists for.
    ///
    /// An Ogg container keeps its comments on the audio stream, so a probe that
    /// reads only `format.tags` finds nothing in one and titles the track from
    /// its filename instead. That is what put a video ID on screen for every
    /// `.opus` the importer had written. Built with the real ffmpeg, because the
    /// point of the test is where a real encoder puts the tags.
    ///
    /// `#[ignore]`d so the normal suite does not depend on ffmpeg being
    /// installed; ffprobe alone is enough for the rest. Run it deliberately:
    /// `cargo test --bin music-ai-player -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a real ffmpeg to build the fixture"]
    fn tags_are_read_out_of_an_ogg_stream_not_just_the_container() {
        let t = tree("opus-tags");
        let file = t.0.join("dQw4w9WgXcQ-a name nobody should see.opus");
        let built = crate::proc::external("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1"])
            .args(["-metadata", "title=The Real Title"])
            .args(["-metadata", "artist=The Real Artist"])
            .args(["-metadata", "genre=Hardstyle", "-y"])
            .arg(&file)
            .stdin(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(built, "could not build the fixture");

        let found = probe(&file).expect("a real opus file probes");
        assert_eq!(found.title, "The Real Title");
        assert_eq!(found.artist.as_deref(), Some("The Real Artist"));
        assert_eq!(found.genre.as_deref(), Some("Hardstyle"));
    }

    /// The repair pass is the one thing that makes a re-scan cost anything, so
    /// it has to stay pinned to the rows it was written for.
    #[test]
    fn only_a_title_that_is_still_a_downloaded_filename_is_reprobed() {
        let file = Path::new("/m/NmrSeXD6LVI-Showtek - The F Track.opus");
        assert!(needs_retitle(file, "NmrSeXD6LVI-Showtek - The F Track"));
        // Already repaired — and this is what stops it repeating every scan.
        assert!(!needs_retitle(file, "Showtek - The F Track"));
        // A title the user typed, or one that came off a tag, is not ours.
        assert!(!needs_retitle(file, "The F Track"));
        // Same shape of title, but the file it points at never had an ID.
        let plain = Path::new("/m/Showtek - The F Track.opus");
        assert!(!needs_retitle(plain, "Showtek - The F Track"));
    }
}
