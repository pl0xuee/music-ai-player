//! Read/write access to the library SQLite database produced by
//! `engine/generate.py`.
//!
//! The player is deliberately decoupled from the generator: it never imports,
//! spawns or talks to the Python side. It only reads rows and plays files. If
//! the database does not exist yet, every command answers with an empty or
//! zeroed result so the UI can render a "nothing generated yet" state instead
//! of crashing.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

/// Overrides the auto-discovered database location. May point either at the
/// `library.db` file itself or at the directory that contains it.
pub const LIBRARY_ENV: &str = "MUSIC_AI_LIBRARY";

const DB_FILENAME: &str = "library.db";
const LIBRARY_DIRNAME: &str = "library";
/// Where imported audio lands, relative to the database's directory. Separate
/// from the generator's own output so a `rm -rf` of one never touches the other.
const TRACKS_DIRNAME: &str = "tracks";

/// Columns shared by every track query; keep in sync with `map_track`.
const TRACK_COLUMNS: &str = "id, title, genre, bpm, key_scale, prompt, duration, \
                             path, created_at, play_count, last_played, rating, \
                             source, video_id, url, uploader";

/// Value of `tracks.source` for rows the generator wrote.
pub const SOURCE_GENERATED: &str = "generated";
/// Value of `tracks.source` for rows imported from YouTube.
pub const SOURCE_YOUTUBE: &str = "youtube";
/// Value of `tracks.source` for audio files that were already on this machine.
///
/// These rows point *outside* the library directory and nothing is copied: the
/// file stays where the user keeps it, and deleting the row leaves it alone.
pub const SOURCE_LOCAL: &str = "local";

/// A playable row. Only `status = 'ready'` rows are ever handed to the UI, so
/// `status` / `task_id` / `error` are not part of this struct.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub genre: String,
    pub bpm: i64,
    pub key_scale: String,
    pub prompt: String,
    pub duration: Option<f64>,
    pub path: Option<String>,
    pub created_at: String,
    pub play_count: i64,
    pub last_played: Option<String>,
    pub rating: i64,
    /// `generated` or `youtube`. Decides what the UI shows in place of the
    /// tempo/key readouts a generated track has and an imported one does not.
    pub source: String,
    pub video_id: Option<String>,
    pub url: Option<String>,
    pub uploader: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub item_count: i64,
    /// Summed duration of the playlist's tracks, in seconds.
    pub seconds: f64,
}

/// A track as it appears inside a playlist: the row plus its place in the order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItem {
    /// `playlist_items.id`, which is what `remove_item` / `reorder_item` take.
    pub item_id: i64,
    pub position: i64,
    pub added_at: String,
    #[serde(flatten)]
    pub track: Track,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreCount {
    pub genre: String,
    pub count: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// False when no database file exists yet — the UI shows the onboarding
    /// message in that case rather than an empty library.
    pub available: bool,
    /// Absolute path we resolved, shown in the UI so a wrong working directory
    /// is diagnosable without a debugger.
    pub library_path: String,
    pub pending: i64,
    pub generating: i64,
    pub ready: i64,
    pub failed: i64,
    pub total: i64,
    /// Summed duration of `ready` tracks, in seconds.
    pub playable_seconds: f64,
    pub genres: Vec<GenreCount>,
}

/// Managed state: just the resolved database path. Connections are opened per
/// command rather than held open, because the generator writes to the same
/// file concurrently and WAL mode makes short-lived connections cheap.
///
/// Cloneable so the YouTube importer can hold one on its worker thread without
/// reaching back into Tauri's state registry from a plain `std::thread`.
#[derive(Debug, Clone)]
pub struct Library {
    db_path: PathBuf,
    /// Whether the schema migration has completed against this database.
    ///
    /// The migration is a *writer* (`ALTER TABLE tracks ADD COLUMN source …`),
    /// so it can lose a five-second race with the generator's `BEGIN IMMEDIATE`
    /// and fail. Every later query then dies on `no such column: source`, which
    /// the UI renders as an empty library over a full one. Remembering that it
    /// has not run is what lets the next command retry it and, failing that,
    /// report what actually went wrong.
    ///
    /// Shared across clones: the importer's worker holds its own `Library` and
    /// must not re-run a migration the UI thread already did.
    schema_ready: Arc<Mutex<bool>>,
}

/// Where an installed copy keeps its library: `$XDG_DATA_HOME/music-ai-player`,
/// or `~/.local/share/music-ai-player` when that is unset.
///
/// The `library/` level is kept rather than flattened because the tracks
/// directory is derived from the database's parent, so the layout on disc is
/// the same whether the app was installed or is being run from a checkout.
fn user_data_library() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("music-ai-player")
        .join(LIBRARY_DIRNAME)
        .join(DB_FILENAME)
}

impl Library {
    /// Resolve the database path once at startup.
    ///
    /// `MUSIC_AI_LIBRARY` wins if set. Otherwise we look for
    /// `library/library.db` in the working directory and then in each of its
    /// ancestors — `cargo tauri dev` runs the binary from `src-tauri/`, while a
    /// bundled build is usually launched from the project root, and both should
    /// find the same library.
    ///
    /// Falling back to the working directory is wrong for an installed bundle.
    /// An AppImage runs with its cwd inside its own read-only mount, so that
    /// fallback resolved to `/tmp/.mount_xxxx/usr/library` and every write
    /// failed with `Read-only file system` — the app opened, and nothing it did
    /// could persist. A checkout is recognised by an existing `library/`
    /// directory (the repository ships one); anything else is treated as an
    /// installed copy and gets the user's data directory.
    pub fn discover() -> Self {
        if let Some(raw) = std::env::var_os(LIBRARY_ENV) {
            let p = PathBuf::from(raw);
            let db_path = if p.is_dir() || p.extension().is_none() {
                p.join(DB_FILENAME)
            } else {
                p
            };
            return Self::at(db_path);
        }

        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        // An existing database wins outright, wherever it sits.
        for dir in cwd.ancestors() {
            let candidate = dir.join(LIBRARY_DIRNAME).join(DB_FILENAME);
            if candidate.is_file() {
                return Self::at(candidate);
            }
        }
        // No database yet. A `library/` directory means a checkout being run
        // in place, which should keep its library beside the source.
        for dir in cwd.ancestors() {
            let dir = dir.join(LIBRARY_DIRNAME);
            if dir.is_dir() {
                return Self::at(dir.join(DB_FILENAME));
            }
        }
        Self::at(user_data_library())
    }

    /// Point at an explicit `library.db`. Used by tests and by the importer's
    /// own worker, which is handed a resolved path rather than re-discovering.
    pub fn at(db_path: PathBuf) -> Self {
        Self {
            db_path,
            schema_ready: Arc::new(Mutex::new(false)),
        }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Directory that holds the database, and by convention the audio files.
    pub fn media_root(&self) -> Option<&Path> {
        self.db_path.parent()
    }

    /// Where the YouTube importer writes finished mp3s.
    pub fn tracks_dir(&self) -> PathBuf {
        match self.media_root() {
            Some(root) => root.join(TRACKS_DIRNAME),
            None => PathBuf::from(TRACKS_DIRNAME),
        }
    }

    /// `None` means "no library yet" rather than "error" — callers degrade to
    /// an empty result.
    fn open(&self) -> Result<Option<Connection>, String> {
        if !self.db_path.is_file() {
            return Ok(None);
        }
        Ok(Some(self.connect()?))
    }

    /// Open for writing, creating the database if it is not there yet, with the
    /// schema guaranteed to be current.
    ///
    /// Unlike [`Self::open`] this never answers "no library": the import path
    /// has to be able to fill an empty install, so the file is brought into
    /// existence rather than reported missing.
    pub fn connect(&self) -> Result<Connection, String> {
        self.ensure_schema()?;
        self.open_conn()
    }

    /// A connection with no schema guarantee behind it.
    ///
    /// Only the migration itself may use this: it cannot wait on its own
    /// completion. Everything else goes through [`Self::connect`], so no query
    /// can ever run against the half-migrated schema a failed `ALTER TABLE`
    /// leaves behind.
    fn open_conn(&self) -> Result<Connection, String> {
        if let Some(root) = self.media_root() {
            std::fs::create_dir_all(root)
                .map_err(|e| format!("cannot create {}: {e}", root.display()))?;
        }
        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("cannot open {}: {e}", self.db_path.display()))?;
        // The generator may hold a write lock mid-batch; wait it out instead of
        // failing the command.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        // Per-connection, so this has to be set on every handle rather than
        // once at migration time. Without it `ON DELETE CASCADE` is inert and
        // deleting a playlist would leave its rows behind.
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    /// Run the migration unless it has already succeeded against this database.
    ///
    /// Called before every connection, so a migration that failed at startup —
    /// because the generator was mid-batch and holding the write lock — is
    /// retried by the next command instead of leaving every query to fail on a
    /// column that was never added. If it still cannot run, the caller gets the
    /// real reason rather than an empty result set.
    pub fn ensure_schema(&self) -> Result<(), String> {
        let mut ready = self.schema_ready.lock().unwrap_or_else(|e| e.into_inner());
        if *ready {
            return Ok(());
        }
        self.run_migration().map_err(|err| {
            format!(
                "the library database at {} could not be prepared: {err}",
                self.db_path.display()
            )
        })?;
        *ready = true;
        Ok(())
    }

    /// Bring the schema up to date, whether or not it already is. Called once at
    /// startup, before anything reads or writes.
    ///
    /// Every step is additive and idempotent: the user already has a populated
    /// `library.db` written by `engine/generate.py`, and the generator keeps
    /// writing to it independently. Nothing here drops, rewrites or reorders an
    /// existing table.
    pub fn migrate(&self) -> Result<(), String> {
        let mut ready = self.schema_ready.lock().unwrap_or_else(|e| e.into_inner());
        *ready = false;
        self.run_migration()?;
        *ready = true;
        Ok(())
    }

    /// The DDL itself. Runs under the `schema_ready` lock in both entry points,
    /// so two threads can never race two `ALTER TABLE`s against each other.
    fn run_migration(&self) -> Result<(), String> {
        let conn = self.open_conn()?;

        // WAL is what lets the generator write while the player reads. The
        // generator sets it too; setting it again is a no-op.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("cannot enable WAL on {}: {e}", self.db_path.display()))?;

        // Only creates anything on a fresh install — this mirrors the DDL in
        // `engine/generate.py` so an import can populate a library that has
        // never had the generator run against it.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tracks (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 title       TEXT    NOT NULL,
                 genre       TEXT    NOT NULL,
                 bpm         INTEGER NOT NULL,
                 key_scale   TEXT    NOT NULL,
                 prompt      TEXT    NOT NULL,
                 duration    REAL,
                 status      TEXT    NOT NULL DEFAULT 'pending',
                 path        TEXT,
                 task_id     TEXT,
                 error       TEXT,
                 created_at  TEXT    NOT NULL,
                 play_count  INTEGER NOT NULL DEFAULT 0,
                 last_played TEXT,
                 rating      INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_status ON tracks(status);
             CREATE INDEX IF NOT EXISTS idx_genre  ON tracks(genre);
             CREATE INDEX IF NOT EXISTS idx_bpm    ON tracks(bpm);",
        )
        .map_err(|e| format!("cannot create the tracks table: {e}"))?;

        // `ALTER TABLE … ADD COLUMN` errors rather than no-ops when the column
        // is already there, and SQLite has no `IF NOT EXISTS` for it, so ask
        // first. A NOT NULL column needs a default to be addable at all.
        add_column(
            &conn,
            "tracks",
            "source",
            &format!("TEXT NOT NULL DEFAULT '{SOURCE_GENERATED}'"),
        )?;
        add_column(&conn, "tracks", "video_id", "TEXT")?;
        add_column(&conn, "tracks", "url", "TEXT")?;
        add_column(&conn, "tracks", "uploader", "TEXT")?;

        conn.execute_batch(
            // Partial index: the generator's rows all have a NULL video_id and
            // must not collide with each other. This is what makes re-importing
            // the same video a no-op at the storage layer as well as the UI one.
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_video_id
                 ON tracks(video_id) WHERE video_id IS NOT NULL;

             CREATE TABLE IF NOT EXISTS playlists (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 name       TEXT NOT NULL UNIQUE,
                 created_at TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS playlist_items (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                 track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
                 position    INTEGER NOT NULL,
                 added_at    TEXT NOT NULL,
                 UNIQUE(playlist_id, track_id)
             );
             CREATE INDEX IF NOT EXISTS idx_playlist_items
                 ON playlist_items(playlist_id, position);",
        )
        .map_err(|e| format!("cannot create the playlist tables: {e}"))?;

        std::fs::create_dir_all(self.tracks_dir())
            .map_err(|e| format!("cannot create {}: {e}", self.tracks_dir().display()))?;

        Ok(())
    }
}

/// Add a column only if `table` does not already have it.
fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let existing: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>("name"))
        .and_then(|rows| rows.collect())
        .map_err(|e| e.to_string())?;
    if existing.iter().any(|name| name == column) {
        return Ok(());
    }
    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])
        .map_err(|e| format!("cannot add {table}.{column}: {e}"))?;
    Ok(())
}

/// SQLite-side timestamp in the same ISO-8601 UTC shape the generator writes
/// (`2026-08-03T21:10:00+00:00`), so rows from both producers sort together.
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')";

fn map_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get("id")?,
        title: row.get("title")?,
        genre: row.get("genre")?,
        bpm: row.get("bpm")?,
        key_scale: row.get("key_scale")?,
        prompt: row.get("prompt")?,
        duration: row.get("duration")?,
        path: row.get("path")?,
        created_at: row.get("created_at")?,
        play_count: row.get("play_count")?,
        last_played: row.get("last_played")?,
        rating: row.get("rating")?,
        source: row.get("source")?,
        video_id: row.get("video_id")?,
        url: row.get("url")?,
        uploader: row.get("uploader")?,
    })
}

/// Empty string and `"all"` both mean "no filter" so the UI can bind a
/// `<select>` directly.
fn normalize_genre(genre: Option<String>) -> Option<String> {
    genre.filter(|g| !g.trim().is_empty() && g != "all")
}

// ---------------------------------------------------------------------------
// Commands
//
// Every one of these carries `(async)`, and none of them may lose it.
//
// `tauri-macros` runs a plain `#[tauri::command]` *inline on the IPC thread*,
// which on Linux is the GTK main thread — the one that draws the window. Every
// command here opens a SQLite connection, and `Library::connect` sets a
// five-second `busy_timeout` because the generator holds `BEGIN IMMEDIATE` for
// whole batches while it plans prompts. Under WAL a reader sails past that, but
// a writer waits, and `mark_played` fires on every track change: without
// `(async)` the window froze for five seconds at each handover during a
// generation run. The reads are in the same boat because `connect` may have to
// retry the migration, which is itself a writer.
//
// `(async)` needs no signature change — Tauri moves the sync body onto the
// async runtime's pool. `engine_stop` solves the same problem by hand.
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn list_tracks(lib: State<'_, Library>, genre: Option<String>) -> Result<Vec<Track>, String> {
    let Some(conn) = lib.open()? else {
        return Ok(Vec::new());
    };
    let genre = normalize_genre(genre);

    let mut sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks WHERE status = 'ready' AND path IS NOT NULL"
    );
    if genre.is_some() {
        sql.push_str(" AND genre = ?1");
    }
    sql.push_str(" ORDER BY id");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let tracks = match &genre {
        Some(g) => stmt
            .query_map(rusqlite::params![g], map_track)
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()),
        None => stmt
            .query_map(rusqlite::params![], map_track)
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()),
    }
    .map_err(|e| e.to_string())?;

    Ok(tracks)
}

#[tauri::command(async)]
pub fn library_stats(lib: State<'_, Library>) -> Result<Stats, String> {
    let mut stats = Stats {
        library_path: lib.db_path().display().to_string(),
        ..Stats::default()
    };

    let Some(conn) = lib.open()? else {
        return Ok(stats);
    };
    stats.available = true;

    let mut stmt = conn
        .prepare(
            "SELECT status, COUNT(*) AS n, COALESCE(SUM(duration), 0) AS secs \
             FROM tracks GROUP BY status",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![], |row| {
            Ok((
                row.get::<_, String>("status")?,
                row.get::<_, i64>("n")?,
                row.get::<_, f64>("secs")?,
            ))
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| e.to_string())?;

    for (status, count, seconds) in rows {
        stats.total += count;
        match status.as_str() {
            "pending" => stats.pending = count,
            "generating" => stats.generating = count,
            "ready" => {
                stats.ready = count;
                stats.playable_seconds = seconds;
            }
            "failed" => stats.failed = count,
            _ => {}
        }
    }

    let mut stmt = conn
        .prepare(
            "SELECT genre, COUNT(*) AS n FROM tracks WHERE status = 'ready' \
             GROUP BY genre ORDER BY n DESC, genre",
        )
        .map_err(|e| e.to_string())?;
    stats.genres = stmt
        .query_map(rusqlite::params![], |row| {
            Ok(GenreCount {
                genre: row.get("genre")?,
                count: row.get("n")?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| e.to_string())?;

    Ok(stats)
}

#[tauri::command(async)]
pub fn genres(lib: State<'_, Library>) -> Result<Vec<String>, String> {
    let Some(conn) = lib.open()? else {
        return Ok(Vec::new());
    };
    let mut stmt = conn
        .prepare("SELECT DISTINCT genre FROM tracks WHERE status = 'ready' ORDER BY genre")
        .map_err(|e| e.to_string())?;
    let list = stmt
        .query_map(rusqlite::params![], |row| row.get::<_, String>(0))
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| e.to_string())?;
    Ok(list)
}

#[tauri::command(async)]
pub fn rate_track(lib: State<'_, Library>, id: i64, rating: i64) -> Result<(), String> {
    let Some(conn) = lib.open()? else {
        return Ok(());
    };
    // The schema documents -1/0/1; clamp rather than trust the webview.
    let rating = rating.clamp(-1, 1);
    conn.execute(
        "UPDATE tracks SET rating = ?1 WHERE id = ?2",
        rusqlite::params![rating, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn mark_played(lib: State<'_, Library>, id: i64) -> Result<(), String> {
    let Some(conn) = lib.open()? else {
        return Ok(());
    };
    // Timestamp is produced by SQLite in the same ISO-8601 UTC shape the
    // generator writes (`2026-08-03T21:10:00+00:00`).
    conn.execute(
        "UPDATE tracks SET play_count = play_count + 1, \
         last_played = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now') WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Absolute filesystem path of a ready track whose file is still on disk.
///
/// `None` covers every way a track can turn out to have no source — no such
/// ready row, a row with a NULL path, and a row whose file has since been
/// deleted or moved. Only a genuine failure, meaning the query itself, is an
/// error.
///
/// Free-standing and `AppHandle`-free so the media server in [`crate::stream`]
/// can call it from its own connection threads, which have no Tauri runtime in
/// scope and want none: resolving an id to a path is a library question, and
/// the webview permission dance below is not part of it.
pub fn ready_path(lib: &Library, id: i64) -> Result<Option<String>, String> {
    let Some(conn) = lib.open()? else {
        return Ok(None);
    };
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM tracks WHERE id = ?1 AND status = 'ready'",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;

    let Some(path) = path else {
        return Ok(None);
    };
    if !Path::new(&path).is_file() {
        return Ok(None);
    }
    Ok(Some(path))
}

/// [`ready_path`], plus a grant of asset-protocol access to that exact file.
///
/// The frontend no longer builds a media URL out of this — the media server
/// does that, because `asset://` cannot drive an `<audio>` element under
/// WebKitGTK at all (see [`crate::stream`]). What the frontend still needs from
/// this command is the *question it answers*: is there a playable file behind
/// this id right now? A `null` is what makes a deck skip a track whose file has
/// been deleted instead of stalling on it.
///
/// The scope widening stays because `fetch`ing an `asset://` URL does work, and
/// that is still the path any non-media read of a track file would take.
///
/// The frontend's `SourceResolver` is typed `Promise<string | null>` and both of
/// its call sites already handle `null` by leaving the deck empty and moving on;
/// the missing-file case used to be an `Err` instead, which crosses the bridge
/// as a rejected promise nothing is waiting to catch. A genuine failure — the
/// query, or the scope widening — is still an error.
fn source_path<R: Runtime>(
    app: &AppHandle<R>,
    lib: &Library,
    id: i64,
) -> Result<Option<String>, String> {
    let Some(path) = ready_path(lib, id)? else {
        return Ok(None);
    };

    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("cannot expose {path} to the webview: {e}"))?;

    Ok(Some(path))
}

/// What a cleanup pass found.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    /// Ready rows whose file was checked.
    pub checked: usize,
    /// Rows dropped because the file behind them has gone.
    pub removed: usize,
}

/// Drop every ready row whose audio file is no longer on disk.
///
/// Files leave without the library being told: a scanned folder is tidied, an
/// external disk is unplugged, test downloads are deleted by hand. Those rows
/// are already unplayable — a deck skips them and moves on — but they still
/// fill the list, count toward the shuffle bag and sit in playlists.
///
/// Only `ready` rows are considered. A pending or generating row has no file
/// *yet*, and deleting it would cancel work in flight by proxy.
///
/// Deletion cascades into `playlist_items` through the schema's foreign key,
/// which is the correct outcome: a playlist entry pointing at nothing is not
/// worth keeping either.
#[tauri::command(async)]
pub fn prune_missing(lib: State<'_, Library>) -> Result<PruneReport, String> {
    let Some(conn) = lib.open()? else {
        return Ok(PruneReport {
            checked: 0,
            removed: 0,
        });
    };

    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, path FROM tracks WHERE status = 'ready' AND path IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        mapped.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let checked = rows.len();
    let gone: Vec<i64> = rows
        .into_iter()
        .filter(|(_, path)| !Path::new(path).is_file())
        .map(|(id, _)| id)
        .collect();

    if gone.is_empty() {
        return Ok(PruneReport {
            checked,
            removed: 0,
        });
    }

    // One transaction, so a failure part-way leaves the library exactly as it
    // was rather than half-pruned.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for id in &gone {
        tx.execute("DELETE FROM tracks WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| format!("cannot remove track {id}: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(PruneReport {
        checked,
        removed: gone.len(),
    })
}

#[tauri::command(async)]
pub fn track_source(
    app: AppHandle,
    lib: State<'_, Library>,
    id: i64,
) -> Result<Option<String>, String> {
    source_path(&app, lib.inner(), id)
}

// ---------------------------------------------------------------------------
// Imported tracks
// ---------------------------------------------------------------------------

/// Everything the importer knows about a finished download.
#[derive(Debug, Clone)]
pub struct ImportedTrack {
    pub video_id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub url: String,
    pub duration: Option<f64>,
    /// Absolute path of the finished mp3. Verified to exist and be non-empty
    /// by the caller *before* this is called.
    pub path: String,
}

/// Row id of an existing import of `video_id`, if there is one.
pub fn find_by_video_id(conn: &Connection, video_id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM tracks WHERE video_id = ?1",
        rusqlite::params![video_id],
        |row| row.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

/// Row id of a track already pointing at this exact path, if there is one.
///
/// How a re-scan of the same folder stays idempotent. Matching on the path
/// rather than on the audio means a file the user has since renamed comes in
/// again as a second row, which is the safer way round: a duplicate is visible
/// and deletable, a silently skipped file looks like the scanner is broken.
pub fn find_by_path(conn: &Connection, path: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM tracks WHERE path = ?1",
        rusqlite::params![path],
        |row| row.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

/// Everything worth knowing about an audio file found on disk.
#[derive(Debug, Clone)]
pub struct LocalTrack {
    pub title: String,
    /// The `artist` tag, or `None`. Shown where an import shows its channel.
    pub artist: Option<String>,
    /// The `genre` tag if the file carries one, so the genre filter is useful
    /// on a real music collection rather than listing everything as "local".
    pub genre: Option<String>,
    pub duration: Option<f64>,
    pub path: String,
}

/// Commit a file that is already on disk as a playable row.
///
/// Mirrors [`insert_imported`], including its reason for existing: `status` is
/// set to `ready` only here, and only after the caller has confirmed the file
/// is really there and really has audio in it.
pub fn insert_local(conn: &Connection, t: &LocalTrack) -> Result<i64, String> {
    conn.execute(
        &format!(
            "INSERT INTO tracks
                 (title, genre, bpm, key_scale, prompt, duration, status, path,
                  created_at, source, video_id, url, uploader)
             VALUES (?1, ?2, 0, '', '', ?3, 'ready', ?4, {NOW}, '{SOURCE_LOCAL}', NULL, NULL, ?5)"
        ),
        rusqlite::params![
            t.title,
            t.genre.as_deref().unwrap_or(SOURCE_LOCAL),
            t.duration,
            t.path,
            t.artist,
        ],
    )
    .map_err(|e| format!("cannot record {}: {e}", t.path))?;
    Ok(conn.last_insert_rowid())
}

/// Every `video_id` already imported. Handed to `yt-dlp --download-archive` so
/// expanding a playlist skips what we already have instead of re-fetching it.
pub fn imported_video_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT video_id FROM tracks WHERE video_id IS NOT NULL")
        .map_err(|e| e.to_string())?;
    stmt.query_map([], |row| row.get::<_, String>(0))
        .and_then(|rows| rows.collect())
        .map_err(|e| e.to_string())
}

/// Commit a finished download as a playable row.
///
/// `status` is set to `ready` here and only here, which is why the caller must
/// have confirmed the file is on disk first: a `ready` row pointing at a
/// missing or half-written file would be drawn by the shuffle bag and stall
/// playback on a deck that can never load it.
///
/// The generated-track columns have no meaning for an import but are `NOT NULL`
/// in the generator's schema, so they get neutral values and the UI keys off
/// `source` rather than trying to interpret a 0 BPM.
pub fn insert_imported(conn: &Connection, t: &ImportedTrack) -> Result<i64, String> {
    conn.execute(
        &format!(
            "INSERT INTO tracks
                 (title, genre, bpm, key_scale, prompt, duration, status, path,
                  created_at, source, video_id, url, uploader)
             VALUES (?1, ?2, 0, '', '', ?3, 'ready', ?4, {NOW}, '{SOURCE_YOUTUBE}', ?5, ?6, ?7)"
        ),
        rusqlite::params![
            t.title,
            SOURCE_YOUTUBE,
            t.duration,
            t.path,
            t.video_id,
            t.url,
            t.uploader,
        ],
    )
    .map_err(|e| format!("cannot record {}: {e}", t.video_id))?;
    Ok(conn.last_insert_rowid())
}


// ---------------------------------------------------------------------------
// Playlists
//
// The SQL lives in free functions over a `&Connection` and the `#[tauri::command]`s
// are one-line wrappers around them. That split is what lets the reorder and
// cascade behaviour be tested against a real temp database without standing up
// a Tauri app to hand out `State`.
// ---------------------------------------------------------------------------

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a playlist needs a name".into());
    }
    if name.chars().count() > 120 {
        return Err("that playlist name is too long".into());
    }
    Ok(name.to_string())
}

/// `UNIQUE` violations are the one error worth rewriting: the raw SQLite text
/// names an index the user has never heard of.
fn map_name_clash(err: rusqlite::Error, name: &str) -> String {
    if matches!(
        err.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ConstraintViolation)
    ) {
        format!("there is already a playlist called \"{name}\"")
    } else {
        err.to_string()
    }
}

pub fn all_playlists(conn: &Connection) -> Result<Vec<Playlist>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, p.created_at,
                    COUNT(i.id)                  AS item_count,
                    COALESCE(SUM(t.duration), 0) AS seconds
             FROM playlists p
             LEFT JOIN playlist_items i ON i.playlist_id = p.id
             LEFT JOIN tracks t         ON t.id = i.track_id AND t.status = 'ready'
             GROUP BY p.id
             ORDER BY p.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    stmt.query_map([], |row| {
        Ok(Playlist {
            id: row.get("id")?,
            name: row.get("name")?,
            created_at: row.get("created_at")?,
            item_count: row.get("item_count")?,
            seconds: row.get("seconds")?,
        })
    })
    .and_then(|rows| rows.collect())
    .map_err(|e| e.to_string())
}

pub fn new_playlist(conn: &Connection, name: &str) -> Result<i64, String> {
    let name = clean_name(name)?;
    conn.execute(
        &format!("INSERT INTO playlists (name, created_at) VALUES (?1, {NOW})"),
        rusqlite::params![name],
    )
    .map_err(|e| map_name_clash(e, &name))?;
    Ok(conn.last_insert_rowid())
}

pub fn playlist_items(conn: &Connection, playlist_id: i64) -> Result<Vec<PlaylistItem>, String> {
    // Every track column has to be qualified once the join is in play, so the
    // shared list is rewritten rather than duplicated with `t.` baked in.
    let columns = TRACK_COLUMNS
        .split(", ")
        .map(|c| format!("t.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT i.id AS item_id, i.position, i.added_at, {columns}
             FROM playlist_items i
             JOIN tracks t ON t.id = i.track_id
             WHERE i.playlist_id = ?1
             ORDER BY i.position, i.id"
        ))
        .map_err(|e| e.to_string())?;
    stmt.query_map(rusqlite::params![playlist_id], |row| {
        Ok(PlaylistItem {
            item_id: row.get("item_id")?,
            position: row.get("position")?,
            added_at: row.get("added_at")?,
            track: map_track(row)?,
        })
    })
    .and_then(|rows| rows.collect())
    .map_err(|e| e.to_string())
}

/// Append to a playlist, ignoring a track that is already in it.
///
/// Returns whether a row was actually added, so the importer can say "already
/// in this playlist" rather than silently doing nothing.
pub fn append_to_playlist(
    conn: &Connection,
    playlist_id: i64,
    track_id: i64,
) -> Result<bool, String> {
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id = ?1",
            rusqlite::params![playlist_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            &format!(
                "INSERT OR IGNORE INTO playlist_items
                     (playlist_id, track_id, position, added_at)
                 VALUES (?1, ?2, ?3, {NOW})"
            ),
            rusqlite::params![playlist_id, track_id, next],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub fn drop_item(conn: &Connection, item_id: i64) -> Result<(), String> {
    let playlist_id: Option<i64> = conn
        .query_row(
            "SELECT playlist_id FROM playlist_items WHERE id = ?1",
            rusqlite::params![item_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    let Some(playlist_id) = playlist_id else {
        return Ok(());
    };
    conn.execute(
        "DELETE FROM playlist_items WHERE id = ?1",
        rusqlite::params![item_id],
    )
    .map_err(|e| e.to_string())?;
    // Close the gap so positions stay a dense 0..n-1 run.
    let order = current_order(conn, playlist_id)?;
    write_order(conn, &order)
}

/// Move an item to `new_position`, sliding everything between out of the way.
///
/// The order is read out, permuted in memory and written back whole rather than
/// patched in place: the "shift a range with one UPDATE, then set one row"
/// version needs opposite SQL for moving up versus down, and any gap left by an
/// earlier interrupted write silently breaks it. A playlist is small enough that
/// rewriting the column is the cheaper thing to get right.
pub fn move_item(conn: &mut Connection, item_id: i64, new_position: i64) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let playlist_id: Option<i64> = tx
        .query_row(
            "SELECT playlist_id FROM playlist_items WHERE id = ?1",
            rusqlite::params![item_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    let Some(playlist_id) = playlist_id else {
        return Err("that item is no longer in the playlist".into());
    };

    let mut order = current_order(&tx, playlist_id)?;
    let Some(from) = order.iter().position(|id| *id == item_id) else {
        return Err("that item is no longer in the playlist".into());
    };
    // An out-of-range target clamps to the ends instead of failing: the UI's
    // up/down buttons run off the edge by one on the first and last rows.
    let to = new_position.clamp(0, order.len() as i64 - 1) as usize;
    let moved = order.remove(from);
    order.insert(to, moved);

    write_order(&tx, &order)?;
    tx.commit().map_err(|e| e.to_string())
}

fn current_order(conn: &Connection, playlist_id: i64) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM playlist_items WHERE playlist_id = ?1 ORDER BY position, id")
        .map_err(|e| e.to_string())?;
    stmt.query_map(rusqlite::params![playlist_id], |row| row.get(0))
        .and_then(|rows| rows.collect())
        .map_err(|e| e.to_string())
}

fn write_order(conn: &Connection, order: &[i64]) -> Result<(), String> {
    let mut stmt = conn
        .prepare("UPDATE playlist_items SET position = ?1 WHERE id = ?2")
        .map_err(|e| e.to_string())?;
    for (index, id) in order.iter().enumerate() {
        stmt.execute(rusqlite::params![index as i64, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// -- commands ---------------------------------------------------------------

#[tauri::command(async)]
pub fn list_playlists(lib: State<'_, Library>) -> Result<Vec<Playlist>, String> {
    all_playlists(&lib.connect()?)
}

#[tauri::command(async)]
pub fn create_playlist(lib: State<'_, Library>, name: String) -> Result<i64, String> {
    new_playlist(&lib.connect()?, &name)
}

#[tauri::command(async)]
pub fn rename_playlist(lib: State<'_, Library>, id: i64, name: String) -> Result<(), String> {
    let name = clean_name(&name)?;
    let conn = lib.connect()?;
    let changed = conn
        .execute(
            "UPDATE playlists SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )
        .map_err(|e| map_name_clash(e, &name))?;
    if changed == 0 {
        return Err("that playlist no longer exists".into());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn delete_playlist(lib: State<'_, Library>, id: i64) -> Result<(), String> {
    // The items go with it via ON DELETE CASCADE; the tracks themselves do not.
    // Deleting a playlist must never delete audio.
    lib.connect()?
        .execute("DELETE FROM playlists WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn clear_playlist(lib: State<'_, Library>, id: i64) -> Result<(), String> {
    lib.connect()?
        .execute(
            "DELETE FROM playlist_items WHERE playlist_id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn list_playlist_items(
    lib: State<'_, Library>,
    playlist_id: i64,
) -> Result<Vec<PlaylistItem>, String> {
    playlist_items(&lib.connect()?, playlist_id)
}

#[tauri::command(async)]
pub fn add_to_playlist(
    lib: State<'_, Library>,
    playlist_id: i64,
    track_id: i64,
) -> Result<bool, String> {
    append_to_playlist(&lib.connect()?, playlist_id, track_id)
}

#[tauri::command(async)]
pub fn remove_item(lib: State<'_, Library>, item_id: i64) -> Result<(), String> {
    drop_item(&lib.connect()?, item_id)
}

#[tauri::command(async)]
pub fn reorder_item(lib: State<'_, Library>, item_id: i64, new_position: i64) -> Result<(), String> {
    move_item(&mut lib.connect()?, item_id, new_position)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A migrated database in its own temp directory, removed on drop.
    struct TempLib {
        root: PathBuf,
        lib: Library,
    }

    impl Drop for TempLib {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "music-ai-lib-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn temp_lib(tag: &str) -> TempLib {
        let root = temp_root(tag);
        let lib = Library::at(root.join(LIBRARY_DIRNAME).join(DB_FILENAME));
        lib.migrate().expect("migrate");
        TempLib { root, lib }
    }

    fn add_track(conn: &Connection, video_id: &str, title: &str) -> i64 {
        insert_imported(
            conn,
            &ImportedTrack {
                video_id: video_id.into(),
                title: title.into(),
                uploader: Some("channel".into()),
                url: format!("https://www.youtube.com/watch?v={video_id}"),
                duration: Some(123.0),
                path: format!("/tmp/{video_id}.mp3"),
            },
        )
        .expect("insert")
    }

    fn positions(conn: &Connection, playlist_id: i64) -> Vec<(String, i64)> {
        playlist_items(conn, playlist_id)
            .expect("items")
            .into_iter()
            .map(|i| (i.track.title, i.position))
            .collect()
    }

    /// The migration has to be safe to run against the database the generator
    /// already wrote, and safe to run twice.
    #[test]
    fn migration_is_additive_and_repeatable() {
        let tmp = temp_lib("migrate");

        // Stand in for a generator-written row that predates the import columns.
        {
            let conn = tmp.lib.connect().expect("connect");
            conn.execute(
                "INSERT INTO tracks (title, genre, bpm, key_scale, prompt, status, path, created_at)
                 VALUES ('Old', 'techno', 128, 'A minor', 'dark', 'ready', '/tmp/old.mp3', '2026-01-01T00:00:00+00:00')",
                [],
            )
            .expect("legacy row");
        }

        tmp.lib.migrate().expect("second migrate");
        tmp.lib.migrate().expect("third migrate");

        let conn = tmp.lib.connect().expect("connect");
        let (source, video): (String, Option<String>) = conn
            .query_row(
                "SELECT source, video_id FROM tracks WHERE title = 'Old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("legacy row survives");
        assert_eq!(source, SOURCE_GENERATED, "existing rows default to generated");
        assert_eq!(video, None);
    }

    /// Run the migration against a real `library.db` — the one the generator
    /// actually wrote — rather than a synthetic one.
    ///
    /// `#[ignore]`d because it needs a database to point at. Verify a copy
    /// before trusting an upgrade with the original:
    /// `MUSIC_AI_MIGRATE_CHECK=/path/to/library.db \
    ///    cargo test --bin music-ai-player -- --ignored migrates_a_real`
    #[test]
    #[ignore = "needs MUSIC_AI_MIGRATE_CHECK pointing at a real library.db"]
    fn migrates_a_real_library() {
        let Some(path) = std::env::var_os("MUSIC_AI_MIGRATE_CHECK") else {
            eprintln!("skipping: set MUSIC_AI_MIGRATE_CHECK");
            return;
        };
        let lib = Library::at(PathBuf::from(path));

        let before: Vec<(i64, String, String)> = {
            let conn = lib.connect().expect("connect");
            let mut stmt = conn
                .prepare("SELECT id, title, status FROM tracks ORDER BY id")
                .expect("prepare");
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .and_then(|rows| rows.collect())
                .expect("rows")
        };

        lib.migrate().expect("migrate");
        lib.migrate().expect("migrate again");

        let conn = lib.connect().expect("connect");
        let after: Vec<(i64, String, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, title, status FROM tracks ORDER BY id")
                .expect("prepare");
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .and_then(|rows| rows.collect())
                .expect("rows")
        };
        assert_eq!(before, after, "migration must not touch existing rows");

        // The new surface is all there and the playlist tables work.
        let playlist = new_playlist(&conn, "smoke test").expect("create");
        assert!(all_playlists(&conn).expect("list").iter().any(|p| p.id == playlist));
        conn.execute("DELETE FROM playlists WHERE id = ?1", rusqlite::params![playlist])
            .expect("cleanup");

        let journal: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        assert_eq!(journal.to_lowercase(), "wal");
        eprintln!("migrated {} rows, journal_mode={journal}", after.len());
    }

    #[test]
    fn create_add_reorder_remove_then_cascade() {
        let tmp = temp_lib("playlist");
        let mut conn = tmp.lib.connect().expect("connect");

        let playlist = new_playlist(&conn, "  Night shift  ").expect("create");
        assert_eq!(
            all_playlists(&conn).expect("list")[0].name,
            "Night shift",
            "the name is trimmed"
        );
        assert!(
            new_playlist(&conn, "Night shift").is_err(),
            "names are unique"
        );

        let a = add_track(&conn, "aaaaaaaaaaa", "A");
        let b = add_track(&conn, "bbbbbbbbbbb", "B");
        let c = add_track(&conn, "ccccccccccc", "C");
        for track in [a, b, c] {
            assert!(append_to_playlist(&conn, playlist, track).expect("append"));
        }
        assert!(
            !append_to_playlist(&conn, playlist, a).expect("re-append"),
            "a track is only in a playlist once"
        );
        assert_eq!(
            positions(&conn, playlist),
            vec![("A".into(), 0), ("B".into(), 1), ("C".into(), 2)]
        );

        let listed = playlist_items(&conn, playlist).expect("items");
        let third = listed[2].item_id;
        let first = listed[0].item_id;

        // Last to first, then first to last: both directions, and the rows in
        // between have to shuffle the opposite way each time.
        move_item(&mut conn, third, 0).expect("move up");
        assert_eq!(
            positions(&conn, playlist),
            vec![("C".into(), 0), ("A".into(), 1), ("B".into(), 2)]
        );
        move_item(&mut conn, first, 99).expect("move down, clamped");
        assert_eq!(
            positions(&conn, playlist),
            vec![("C".into(), 0), ("B".into(), 1), ("A".into(), 2)]
        );

        // A removal must not leave a hole in the position sequence.
        drop_item(&conn, third).expect("remove");
        assert_eq!(
            positions(&conn, playlist),
            vec![("B".into(), 0), ("A".into(), 1)]
        );

        let summary = &all_playlists(&conn).expect("list")[0];
        assert_eq!(summary.item_count, 2);
        assert_eq!(summary.seconds, 246.0);

        // Deleting the playlist takes its items and nothing else.
        conn.execute("DELETE FROM playlists WHERE id = ?1", rusqlite::params![playlist])
            .expect("delete");
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_items", [], |row| row.get(0))
            .expect("count items");
        assert_eq!(orphans, 0, "ON DELETE CASCADE removed the items");
        let tracks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .expect("count tracks");
        assert_eq!(tracks, 3, "deleting a playlist must never delete audio");
    }

    /// Deleting a track has to take its playlist entries with it, or the join
    /// in `playlist_items` would silently drop rows and the positions would rot.
    #[test]
    fn deleting_a_track_cascades_into_playlists() {
        let tmp = temp_lib("cascade");
        let conn = tmp.lib.connect().expect("connect");
        let playlist = new_playlist(&conn, "Mix").expect("create");
        let a = add_track(&conn, "aaaaaaaaaaa", "A");
        add_track(&conn, "bbbbbbbbbbb", "B");
        append_to_playlist(&conn, playlist, a).expect("append");

        conn.execute("DELETE FROM tracks WHERE id = ?1", rusqlite::params![a])
            .expect("delete track");
        assert!(playlist_items(&conn, playlist).expect("items").is_empty());
    }

    #[test]
    fn a_video_id_can_only_be_imported_once() {
        let tmp = temp_lib("dedup");
        let conn = tmp.lib.connect().expect("connect");

        let first = add_track(&conn, "jNQXAC9IVRw", "Me at the zoo");
        assert_eq!(
            find_by_video_id(&conn, "jNQXAC9IVRw").expect("lookup"),
            Some(first)
        );
        assert_eq!(find_by_video_id(&conn, "aaaaaaaaaaa").expect("lookup"), None);

        let again = insert_imported(
            &conn,
            &ImportedTrack {
                video_id: "jNQXAC9IVRw".into(),
                title: "Me at the zoo".into(),
                uploader: None,
                url: "https://youtu.be/jNQXAC9IVRw".into(),
                duration: None,
                path: "/tmp/dupe.mp3".into(),
            },
        );
        assert!(again.is_err(), "the unique index rejects a second import");

        assert_eq!(
            imported_video_ids(&conn).expect("ids"),
            vec!["jNQXAC9IVRw".to_string()]
        );
    }

    // -- M4: nothing that touches the database may run on the IPC thread ------

    /// The `#[tauri::command…]` attribute immediately above `pub fn {name}`.
    ///
    /// Read out of the source because that attribute is the whole fix: it is
    /// what makes `tauri-macros` emit `body_async` instead of `body_blocking`,
    /// and nothing about the function's own signature records the difference.
    fn command_attr(src: &str, name: &str) -> String {
        let needle = format!("\npub fn {name}(");
        let at = src
            .find(&needle)
            .unwrap_or_else(|| panic!("no `pub fn {name}(` in the source"));
        let head = &src[..at + 1];
        let attr_at = head
            .rfind("#[tauri::command")
            .unwrap_or_else(|| panic!("{name} is not a command"));
        let attr = head[attr_at..].lines().next().expect("attribute line").trim();
        assert!(
            head[attr_at + attr.len()..].trim().is_empty(),
            "{name} does not directly follow its own #[tauri::command] attribute"
        );
        attr.to_string()
    }

    /// A plain `#[tauri::command]` is run inline on the IPC thread, which on
    /// Linux is the GTK thread that draws the window. Every command listed here
    /// opens a SQLite connection carrying a five-second `busy_timeout`, and a
    /// writer that lands while `generate.py` holds `BEGIN IMMEDIATE` waits out
    /// every one of those seconds — reproduced as a five-second freeze at each
    /// track handover, because `mark_played` fires on every one.
    ///
    /// Losing `(async)` on any of them brings that straight back, so the
    /// attribute is asserted rather than trusted to survive an edit.
    #[test]
    fn every_database_command_is_dispatched_off_the_ipc_thread() {
        let library_src = include_str!("library.rs");
        let library_commands = [
            // writers
            "rate_track",
            "mark_played",
            "create_playlist",
            "rename_playlist",
            "delete_playlist",
            "clear_playlist",
            "add_to_playlist",
            "remove_item",
            "reorder_item",
            // readers: `connect` retries the migration, which is itself a write
            "list_tracks",
            "library_stats",
            "genres",
            "track_source",
            "prune_missing",
            "list_playlists",
            "list_playlist_items",
        ];
        for name in library_commands {
            assert_eq!(
                command_attr(library_src, name),
                "#[tauri::command(async)]",
                "library::{name} would block the UI thread on the database"
            );
        }

        // The importer's two: one writes rows, the other forks `yt-dlp
        // --version` (133 ms) every time the import drawer opens.
        let youtube_src = include_str!("youtube.rs");
        for name in ["youtube_status", "youtube_import"] {
            assert_eq!(
                command_attr(youtube_src, name),
                "#[tauri::command(async)]",
                "youtube::{name} would block the UI thread"
            );
        }
    }

    /// Why the attribute above matters: a write really does sit and wait.
    ///
    /// `generate.py` holds `BEGIN IMMEDIATE` across the insert of every planned
    /// prompt. Under WAL a reader is unaffected, but a writer blocks until the
    /// transaction ends — it succeeds, which is what the five-second
    /// `busy_timeout` is for, but only after the wait. Whichever thread issues
    /// it is stalled for the duration, and that thread must never be the one
    /// drawing the window.
    #[test]
    fn a_write_waits_for_the_generator_s_transaction_instead_of_failing() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let tmp = temp_lib("busy");
        let id = {
            let conn = tmp.lib.connect().expect("connect");
            add_track(&conn, "aaaaaaaaaaa", "Held")
        };

        // Stand in for the generator mid-batch.
        let holder = tmp.lib.connect().expect("holder");
        holder.execute_batch("BEGIN IMMEDIATE").expect("begin");

        let (ready_tx, ready_rx) = mpsc::channel();
        let lib = tmp.lib.clone();
        let writer = std::thread::spawn(move || {
            let conn = lib.connect().expect("connect");
            ready_tx.send(()).expect("signal");
            let started = Instant::now();
            let result = conn.execute(
                "UPDATE tracks SET play_count = play_count + 1 WHERE id = ?1",
                rusqlite::params![id],
            );
            (result, started.elapsed())
        });

        ready_rx.recv().expect("the writer connected");
        std::thread::sleep(Duration::from_millis(250));
        holder.execute_batch("COMMIT").expect("commit");

        let (result, waited) = writer.join().expect("writer thread");
        result.expect("the write waited out the lock rather than failing");
        assert!(
            waited >= Duration::from_millis(100),
            "the write returned in {waited:?} — it did not block, so this test \
             is no longer measuring what it claims to"
        );
    }

    // -- M5: a migration that could not run is not an empty library ----------

    /// A failed migration must surface as an error, not as "your library is
    /// empty" over a full one.
    ///
    /// The `ALTER TABLE tracks ADD COLUMN source` is a writer, so it loses to a
    /// generation run that is planning prompts at launch. `TRACK_COLUMNS` names
    /// `source`, so *every* track query then fails with `no such column`, the
    /// frontend catches it, and the user is shown the onboarding screen with a
    /// full library on disk. Restarting fixes it and nothing says so.
    ///
    /// A read-only file stands in for the lock: same failure, no five-second
    /// wait to sit through.
    #[test]
    fn a_failed_migration_is_reported_rather_than_read_as_an_empty_library() {
        let root = temp_root("half-migrated");
        let db = root.join(LIBRARY_DIRNAME).join(DB_FILENAME);
        std::fs::create_dir_all(db.parent().expect("parent")).expect("mkdir");

        // The generator's schema as it was before the import columns existed,
        // with rows in it.
        {
            let conn = Connection::open(&db).expect("create");
            conn.execute_batch(
                "CREATE TABLE tracks (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     title TEXT NOT NULL, genre TEXT NOT NULL, bpm INTEGER NOT NULL,
                     key_scale TEXT NOT NULL, prompt TEXT NOT NULL, duration REAL,
                     status TEXT NOT NULL DEFAULT 'pending', path TEXT, task_id TEXT,
                     error TEXT, created_at TEXT NOT NULL,
                     play_count INTEGER NOT NULL DEFAULT 0, last_played TEXT,
                     rating INTEGER NOT NULL DEFAULT 0
                 );
                 INSERT INTO tracks
                     (title, genre, bpm, key_scale, prompt, status, path, created_at)
                 VALUES
                     ('One', 'techno', 128, 'A minor', 'dark', 'ready', '/tmp/one.mp3',
                      '2026-01-01T00:00:00+00:00'),
                     ('Two', 'techno', 128, 'A minor', 'dark', 'ready', '/tmp/two.mp3',
                      '2026-01-01T00:00:00+00:00');",
            )
            .expect("legacy schema");
        }
        let tmp = TempLib {
            root,
            lib: Library::at(db.clone()),
        };

        let readonly = |yes: bool| {
            let mut perms = std::fs::metadata(&db).expect("stat").permissions();
            perms.set_readonly(yes);
            std::fs::set_permissions(&db, perms).expect("chmod");
        };

        readonly(true);
        let failure = tmp.lib.migrate().expect_err("the migration cannot run");
        assert!(
            failure.contains("readonly") || failure.contains("read-only"),
            "the real reason has to survive: {failure}"
        );

        let app = tauri::test::mock_app();
        app.manage(tmp.lib.clone());

        let err = list_tracks(app.state::<Library>(), None)
            .expect_err("a half-migrated schema must not read as an empty library");
        assert!(
            !err.contains("no such column"),
            "the query ran against the half-migrated schema instead of being \
             stopped by the migration that failed: {err}"
        );
        assert!(
            err.contains(&db.display().to_string()),
            "the error names the database it could not prepare: {err}"
        );
        library_stats(app.state::<Library>()).expect_err("stats must not report zero either");

        // And once the obstacle is gone, the next command migrates and reads —
        // no restart, which is the only recovery there used to be.
        readonly(false);
        let tracks = list_tracks(app.state::<Library>(), None).expect("the retry succeeds");
        assert_eq!(tracks.len(), 2, "the library was there the whole time");
        assert_eq!(tracks[0].source, SOURCE_GENERATED);
        assert_eq!(
            library_stats(app.state::<Library>()).expect("stats").ready,
            2
        );
    }

    // -- C1: no source is `None`, not an error -------------------------------

    /// Every "there is nothing to play here" answer is `Ok(None)`.
    ///
    /// The frontend's `SourceResolver` is typed `Promise<string | null>` and
    /// both call sites branch on `url === null`. A missing file used to be an
    /// `Err` instead, which arrives as a rejected promise nothing catches — so
    /// a track whose mp3 had been deleted or moved broke the deck rather than
    /// being skipped.
    #[test]
    fn a_track_with_no_playable_file_resolves_to_none() {
        let tmp = temp_lib("source");
        let conn = tmp.lib.connect().expect("connect");

        let missing = tmp.root.join("deleted-since.mp3");
        assert!(!missing.exists());
        let gone = insert_imported(
            &conn,
            &ImportedTrack {
                video_id: "aaaaaaaaaaa".into(),
                title: "Gone".into(),
                uploader: None,
                url: "https://youtu.be/aaaaaaaaaaa".into(),
                duration: Some(60.0),
                path: missing.display().to_string(),
            },
        )
        .expect("insert");

        let present = tmp.root.join("still-here.mp3");
        std::fs::write(&present, b"bytes").expect("write");
        let here = insert_imported(
            &conn,
            &ImportedTrack {
                video_id: "bbbbbbbbbbb".into(),
                title: "Here".into(),
                uploader: None,
                url: "https://youtu.be/bbbbbbbbbbb".into(),
                duration: Some(60.0),
                path: present.display().to_string(),
            },
        )
        .expect("insert");

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        assert_eq!(
            source_path(&handle, &tmp.lib, gone).expect("a missing file is not an error"),
            None
        );
        assert_eq!(
            source_path(&handle, &tmp.lib, 999_999).expect("an unknown id is not an error"),
            None
        );
        assert_eq!(
            source_path(&handle, &tmp.lib, here).expect("resolve"),
            Some(present.display().to_string()),
            "a track that is on disk still resolves"
        );
    }

    /// The generator's rows all carry a NULL `video_id`; the partial unique
    /// index must not treat them as colliding with each other.
    #[test]
    fn generated_rows_do_not_collide_on_a_null_video_id() {
        let tmp = temp_lib("nulls");
        let conn = tmp.lib.connect().expect("connect");
        for title in ["One", "Two", "Three"] {
            conn.execute(
                "INSERT INTO tracks (title, genre, bpm, key_scale, prompt, status, created_at)
                 VALUES (?1, 'techno', 128, 'A minor', 'dark', 'pending', '2026-01-01T00:00:00+00:00')",
                rusqlite::params![title],
            )
            .expect("generated row");
        }
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .expect("count");
        assert_eq!(n, 3);
    }
}
