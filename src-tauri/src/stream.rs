//! A loopback HTTP server that streams library audio to the webview.
//!
//! # Why this exists
//!
//! WebKitGTK does not decode media in the web process. It hands `<audio>` and
//! `<video>` to GStreamer, which resolves the source URL *itself* and has no
//! handler for WebKit's custom schemes. So `asset://` — which answers `fetch`
//! and range requests perfectly — fails every media element outright with
//! `MEDIA_ERR_SRC_NOT_SUPPORTED` and never reports a duration. That is the whole
//! reason this player could not make a sound on Linux.
//!
//! The first fix was to `fetch` the bytes in the frontend and hand the deck an
//! object URL. It worked, but it buffers the entire file before the first
//! sample: a 272 MB two-hour mix took 5.6 s to start and put the web process at
//! 537 MB resident, and every seek was against a blob that had to be whole.
//!
//! HTTP is the one transport GStreamer already speaks. Serving the same files
//! over loopback puts the deck back on a plain `<audio src>` with byte ranges,
//! so playback starts after a few kilobytes, seeking is a fresh range request
//! rather than a download, and the web process holds nothing but its own decode
//! buffer. Nothing in `player.ts` changes — it is still a media element behind
//! `createMediaElementSource`, so the crossfade and the visualiser are untouched.
//!
//! # What guards it
//!
//! The listener binds `127.0.0.1` only, so nothing off-machine can reach it. To
//! stop *other local processes* from reading the library, every URL carries a
//! 128-bit token minted at startup: the port is guessable by anyone who can run
//! `ss -tlnp`, the token is not. Beyond that the server exposes exactly one
//! shape of thing — a track id, resolved through the same `ready` query the UI
//! uses — so there is no path to a file the library does not already list.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use http_range::{HttpRange, HttpRangeParseError};

use crate::library::{ready_path, Library};

/// Ceiling on a request head. GStreamer's is a few hundred bytes; anything
/// approaching this is a client that will never send `\r\n\r\n`.
const MAX_HEAD: usize = 8 * 1024;

/// Slots for `httparse`. Same reasoning: real requests here carry five or six.
const MAX_HEADERS: usize = 32;

/// How long a connection may take to finish sending its request head.
///
/// Deliberately *not* applied to the response. A media element reads only as
/// fast as it plays, so a healthy connection routinely blocks in `write` for
/// minutes at a time with a full client-side buffer; a write timeout would
/// abort playback of long tracks and look exactly like a decode failure.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Copy granularity. Large enough that a 20 MB track is ~320 writes, small
/// enough that abandoning a response after a seek wastes nothing.
const CHUNK: usize = 64 * 1024;

/// Backstop on connection threads.
///
/// Two decks, each of which may hold an open connection and open another to
/// seek, so the working set is about four. This is set well above that to
/// absorb the abandoned-but-not-yet-closed connections a burst of seeking
/// leaves behind, and only exists so a misbehaving client cannot spawn threads
/// without bound.
const MAX_CONNECTIONS: usize = 24;

/// Managed state: the URL prefix the frontend prepends to `/track/{id}`.
///
/// `None` means the listener could not be bound. That is not fatal — the
/// frontend keeps the object-URL path as a fallback — so it is a state the type
/// can represent rather than a startup failure.
pub struct MediaServer {
    base: Option<String>,
}

/// Everything a connection thread needs. Shared behind an `Arc` because
/// `Library` opens its own connection per query and holds no borrow.
struct Routes {
    lib: Library,
    token: String,
}

impl MediaServer {
    /// Bind an ephemeral loopback port and start accepting.
    ///
    /// Returns once the socket is listening, so the URL handed to the frontend
    /// is live before the window can ask for it.
    pub fn start(lib: Library) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let token = secret_token();
        let base = format!("http://127.0.0.1:{port}/{token}");

        let routes = Arc::new(Routes { lib, token });
        let live = Arc::new(AtomicUsize::new(0));
        std::thread::Builder::new()
            .name("media-server".into())
            .spawn(move || accept_loop(&listener, &routes, &live))?;

        Ok(Self { base: Some(base) })
    }

    /// The state to manage when [`Self::start`] failed, so the command below
    /// can answer honestly instead of the app having to run without it.
    pub fn unavailable() -> Self {
        Self { base: None }
    }

    pub fn base_url(&self) -> Option<&str> {
        self.base.as_deref()
    }
}

/// URL prefix for streaming track audio, or `null` if the server is not up.
///
/// Asked once and cached by the frontend. A `null` sends it down the
/// object-URL fallback, which is slower and memory-hungry but still plays.
#[tauri::command]
pub fn media_base_url(server: tauri::State<'_, MediaServer>) -> Option<String> {
    server.base_url().map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

fn accept_loop(listener: &TcpListener, routes: &Arc<Routes>, live: &Arc<AtomicUsize>) {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            // A failed accept is usually per-connection (the peer went away
            // between the SYN and here) and the listener is still good. Pausing
            // keeps a persistent failure — out of file descriptors, say — from
            // becoming a spin loop on a core.
            Err(_) => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };

        if live.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            let mut stream = stream;
            let _ = respond(&mut stream, 503, "Service Unavailable", &[]);
            continue;
        }

        live.fetch_add(1, Ordering::Relaxed);
        let routes = Arc::clone(routes);
        let held = Arc::clone(live);
        let spawned = std::thread::Builder::new()
            .name("media-conn".into())
            .spawn(move || {
                serve(stream, &routes);
                held.fetch_sub(1, Ordering::Relaxed);
            });
        // Nothing is going to decrement the count if the thread never started.
        if spawned.is_err() {
            live.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// One request, one response, then close.
///
/// Keep-alive would save a connection setup per seek, which on loopback is
/// worth nothing, and would mean tracking where one request's body ends and the
/// next begins. `Connection: close` costs a few hundred microseconds and makes
/// the whole exchange a straight line.
fn serve(mut stream: TcpStream, routes: &Routes) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HEAD_TIMEOUT));

    let head = match read_head(&mut stream) {
        Ok(head) => head,
        Err(_) => return,
    };

    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut parsed = httparse::Request::new(&mut headers);
    if parsed.parse(&head).is_err() {
        let _ = respond(&mut stream, 400, "Bad Request", &[]);
        return;
    }
    let (Some(method), Some(target)) = (parsed.method, parsed.path) else {
        let _ = respond(&mut stream, 400, "Bad Request", &[]);
        return;
    };
    let range = header(&parsed, "range").map(str::to_owned);

    // Every path below has already answered the client or failed writing to a
    // socket that is going away, so there is nothing left to report.
    let _ = dispatch(&mut stream, routes, method, target, range.as_deref());
}

fn dispatch(
    stream: &mut TcpStream,
    routes: &Routes,
    method: &str,
    target: &str,
    range: Option<&str>,
) -> io::Result<()> {
    // Media elements never preflight a range request, but a `fetch` from the
    // frontend would, and answering is cheaper than debugging why it did.
    if method == "OPTIONS" {
        return respond(stream, 204, "No Content", &[]);
    }
    if method != "GET" && method != "HEAD" {
        return respond(stream, 405, "Method Not Allowed", &[("Allow", "GET, HEAD, OPTIONS")]);
    }

    // A wrong token and a nonexistent track are the same 404 on purpose: a
    // distinguishable "bad token" reply would confirm the port is ours and turn
    // the token into something worth guessing at.
    let Some(id) = routes.track_id(target) else {
        return respond(stream, 404, "Not Found", &[]);
    };
    let path = match ready_path(&routes.lib, id) {
        Ok(Some(path)) => path,
        Ok(None) => return respond(stream, 404, "Not Found", &[]),
        Err(err) => {
            eprintln!("media server: cannot resolve track {id}: {err}");
            return respond(stream, 500, "Internal Server Error", &[]);
        }
    };

    send_file(stream, Path::new(&path), method, range)
}

impl Routes {
    /// `/{token}/track/{id}` -> `id`. Anything else is `None`.
    fn track_id(&self, target: &str) -> Option<i64> {
        let path = target.split(['?', '#']).next()?;
        let (token, rest) = path.strip_prefix('/')?.split_once('/')?;
        if !token_eq(token, &self.token) {
            return None;
        }
        rest.strip_prefix("track/")?.parse().ok()
    }
}

// ---------------------------------------------------------------------------
// Serving a file
// ---------------------------------------------------------------------------

fn send_file(
    stream: &mut TcpStream,
    path: &Path,
    method: &str,
    range: Option<&str>,
) -> io::Result<()> {
    // The row said `ready` and the file existed a moment ago in `ready_path`;
    // losing it in between is a race with a deletion, not a server fault.
    let Ok(mut file) = File::open(path) else {
        return respond(stream, 404, "Not Found", &[]);
    };
    let len = file.metadata()?.len();

    let (status, reason, start, count, content_range) = match resolve_range(range, len) {
        Ok(Some(HttpRange { start, length })) => (
            206,
            "Partial Content",
            start,
            length,
            Some(format!("bytes {start}-{}/{len}", start + length - 1)),
        ),
        Ok(None) => (200, "OK", 0, len, None),
        Err(()) => {
            // RFC 7233 wants the valid range space back on a refusal, which is
            // what lets a client that guessed past the end correct itself.
            let unsatisfiable = format!("bytes */{len}");
            return respond(
                stream,
                416,
                "Range Not Satisfiable",
                &[("Content-Range", &unsatisfiable)],
            );
        }
    };

    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    head.push_str(&format!("Content-Type: {}\r\n", content_type(path)));
    head.push_str(&format!("Content-Length: {count}\r\n"));
    // Advertised on every response, including the 200. This is the header that
    // tells the media element seeking is possible at all; without it WebKit
    // will play the track through but refuse to scrub it.
    head.push_str("Accept-Ranges: bytes\r\n");
    if let Some(content_range) = &content_range {
        head.push_str(&format!("Content-Range: {content_range}\r\n"));
    }
    push_common_headers(&mut head);
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;

    if method == "HEAD" {
        return stream.flush();
    }

    file.seek(SeekFrom::Start(start))?;
    copy_exact(&mut file, stream, count)
}

/// `Ok(Some(range))` to serve a 206, `Ok(None)` to serve the whole file,
/// `Err(())` to refuse with a 416.
///
/// The distinction that matters is RFC 7233's: a Range header we cannot parse
/// must be *ignored*, because a client that sent nonsense still wants the file,
/// while a range that is syntactically fine but lies outside the file must be
/// refused, because serving something else would silently corrupt what the
/// client assembles. `http-range` reports these as two different errors, which
/// is the reason it is here.
///
/// Multiple ranges collapse to the first. Answering properly means a
/// `multipart/byteranges` body, and nothing in this app asks for one — a media
/// element requests a single open-ended range and re-requests on seek.
fn resolve_range(range: Option<&str>, len: u64) -> Result<Option<HttpRange>, ()> {
    let Some(range) = range else {
        return Ok(None);
    };
    match HttpRange::parse(range, len) {
        Ok(ranges) => Ok(ranges.first().copied()),
        Err(HttpRangeParseError::NoOverlap) => Err(()),
        Err(HttpRangeParseError::InvalidRange) => Ok(None),
    }
}

/// Stream exactly `count` bytes, or stop early if the client hung up.
///
/// Abandoned responses are the normal case, not an error: every seek drops the
/// connection it was reading from mid-body. Reporting those would fill the log
/// with noise from a working player.
fn copy_exact(file: &mut File, stream: &mut TcpStream, count: u64) -> io::Result<()> {
    let mut buf = vec![0u8; CHUNK];
    let mut left = count;
    while left > 0 {
        let want = usize::try_from(left.min(CHUNK as u64)).unwrap_or(CHUNK);
        let read = file.read(&mut buf[..want])?;
        if read == 0 {
            // The file shrank under us. The head has already promised
            // `Content-Length`, so there is no way to correct the story now;
            // closing short is what tells the client something went wrong.
            break;
        }
        match stream.write_all(&buf[..read]) {
            Ok(()) => {}
            Err(err) if client_gone(&err) => return Ok(()),
            Err(err) => return Err(err),
        }
        left -= read as u64;
    }
    match stream.flush() {
        Err(err) if client_gone(&err) => Ok(()),
        other => other,
    }
}

fn client_gone(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
    )
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/// Headers common to every response.
///
/// The CORS grant is load-bearing rather than boilerplate. The window is
/// `tauri://localhost` and this server is `http://127.0.0.1:{port}`, so every
/// track is a cross-origin load; `player.ts` sets `crossOrigin = "anonymous"`
/// because a `MediaElementAudioSourceNode` fed by an opaque cross-origin
/// response outputs silence. That request only succeeds if this header is here,
/// which makes it the difference between sound and none.
///
/// `no-store` because a track file can be replaced under a stable id — a
/// re-import of the same video writes the same row — and a cached body would
/// keep playing the old bytes.
fn push_common_headers(head: &mut String) {
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
    head.push_str("Access-Control-Allow-Headers: Range\r\n");
    head.push_str("Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\n");
    head.push_str("Cache-Control: no-store\r\n");
    head.push_str("Connection: close\r\n");
}

/// A bodyless response. `Content-Length: 0` rather than nothing, so the client
/// knows the exchange is over without waiting on the close.
fn respond(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    extra: &[(&str, &str)],
) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\n");
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    push_common_headers(&mut head);
    head.push_str("\r\n");
    match stream.write_all(head.as_bytes()).and_then(|()| stream.flush()) {
        Err(err) if client_gone(&err) => Ok(()),
        other => other,
    }
}

// ---------------------------------------------------------------------------
// Request head
// ---------------------------------------------------------------------------

/// Read until the blank line that ends the head.
///
/// Reading in chunks can overshoot into a request body, which is fine here:
/// neither GET nor HEAD has one, and the connection closes after a single
/// exchange either way.
fn read_head(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(512);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before the request head",
            ));
        }
        head.extend_from_slice(&chunk[..read]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(head);
        }
        if head.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request head is too large",
            ));
        }
    }
}

fn header<'a>(req: &httparse::Request<'a, '_>, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case(name))
        .and_then(|h| std::str::from_utf8(h.value).ok())
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

/// What GStreamer keys off to pick a demuxer. Getting this wrong is not fatal —
/// it will sniff the container — but a correct type skips the guess and, for
/// mp3, avoids a needless seek to the end of the file.
fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

/// Compared without an early return.
///
/// The exchange is loopback and the attacker would have to be a local process,
/// so the timing channel here is thin. It is also free to close, and this token
/// is the only thing standing between any process on the machine and the whole
/// library.
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 128 bits of URL-safe secret.
fn secret_token() -> String {
    let mut bytes = [0u8; 16];
    if File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_err()
    {
        // No `/dev/urandom` means this is not the Linux target, and the app is
        // reaching for its last resort rather than a fresh dependency.
        // `RandomState` is seeded from the OS, which is the property that
        // matters; it is only weaker in that repeated calls share that seed.
        for (i, half) in [weak_random(0), weak_random(1)].into_iter().enumerate() {
            bytes[i * 8..(i + 1) * 8].copy_from_slice(&half.to_le_bytes());
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn weak_random(salt: u64) -> u64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(salt);
    hasher.write_u32(std::process::id());
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{insert_imported, ImportedTrack};
    use std::io::BufRead;
    use std::io::BufReader;
    use std::path::PathBuf;

    // -- pure units ---------------------------------------------------------

    #[test]
    fn routes_only_match_the_token() {
        let routes = Routes {
            lib: Library::at(PathBuf::from("/nonexistent/library.db")),
            token: "abc123".into(),
        };

        assert_eq!(routes.track_id("/abc123/track/42"), Some(42));
        // A query string is what a cache-buster would add; it must not change
        // which track is served.
        assert_eq!(routes.track_id("/abc123/track/42?t=9"), Some(42));

        assert_eq!(routes.track_id("/wrong/track/42"), None);
        assert_eq!(routes.track_id("/track/42"), None);
        assert_eq!(routes.track_id("/abc123/track/notanumber"), None);
        assert_eq!(routes.track_id("/abc123/../../etc/passwd"), None);
        assert_eq!(routes.track_id("/abc123/track/"), None);
    }

    #[test]
    fn tokens_are_unpredictable_and_url_safe() {
        let (a, b) = (secret_token(), secret_token());
        assert_ne!(a, b, "two startups must not share a token");
        assert_eq!(a.len(), 32, "128 bits, hex encoded");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// The RFC 7233 split that `http-range` is here for.
    #[test]
    fn malformed_ranges_are_ignored_but_impossible_ones_are_refused() {
        // No header: whole file.
        assert!(matches!(resolve_range(None, 100), Ok(None)));

        let Ok(Some(r)) = resolve_range(Some("bytes=0-9"), 100) else {
            panic!("a plain range must be served");
        };
        assert_eq!((r.start, r.length), (0, 10));

        // Open-ended, which is what a media element opens a track with.
        let Ok(Some(r)) = resolve_range(Some("bytes=50-"), 100) else {
            panic!("an open-ended range must be served");
        };
        assert_eq!((r.start, r.length), (50, 50));

        // Suffix: the last 10 bytes, where mp3 tags live.
        let Ok(Some(r)) = resolve_range(Some("bytes=-10"), 100) else {
            panic!("a suffix range must be served");
        };
        assert_eq!((r.start, r.length), (90, 10));

        // An end past the file is clamped, not refused.
        let Ok(Some(r)) = resolve_range(Some("bytes=95-500"), 100) else {
            panic!("an overlong end must be clamped");
        };
        assert_eq!((r.start, r.length), (95, 5));

        // Ignored: syntactically wrong, so the client still gets the file.
        assert!(matches!(resolve_range(Some("kilobytes=0-9"), 100), Ok(None)));
        assert!(matches!(resolve_range(Some("bytes=abc"), 100), Ok(None)));

        // Refused: syntactically fine, but there is nothing there.
        assert!(matches!(resolve_range(Some("bytes=100-"), 100), Err(())));
        assert!(matches!(resolve_range(Some("bytes=0-"), 0), Err(())));
    }

    #[test]
    fn audio_extensions_get_real_media_types() {
        assert_eq!(content_type(Path::new("/x/a.mp3")), "audio/mpeg");
        assert_eq!(content_type(Path::new("/x/a.MP3")), "audio/mpeg");
        assert_eq!(content_type(Path::new("/x/a.flac")), "audio/flac");
        assert_eq!(content_type(Path::new("/x/a.opus")), "audio/ogg");
        assert_eq!(content_type(Path::new("/x/a.m4a")), "audio/mp4");
        assert_eq!(content_type(Path::new("/x/noext")), "application/octet-stream");
    }

    #[test]
    fn token_comparison_rejects_near_misses() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
        assert!(!token_eq("", "a"));
    }

    // -- over a real socket -------------------------------------------------

    struct TempLib {
        root: PathBuf,
        lib: Library,
        audio: PathBuf,
    }

    impl Drop for TempLib {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// A library with one ready row pointing at a real file of known bytes.
    fn temp_lib(tag: &str) -> TempLib {
        let root = std::env::temp_dir().join(format!(
            "music-ai-stream-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("library")).expect("create root");

        let audio = root.join("library").join("track.mp3");
        // Not real audio: every assertion here is about bytes on the wire, and
        // a recognisable ramp makes an off-by-one in a range obvious.
        let body: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&audio, &body).expect("write audio");

        let lib = Library::at(root.join("library").join("library.db"));
        lib.migrate().expect("migrate");
        let conn = lib.connect().expect("connect");
        insert_imported(
            &conn,
            &ImportedTrack {
                video_id: "vid".into(),
                title: "Track".into(),
                uploader: None,
                url: "https://example.invalid/vid".into(),
                duration: Some(1.0),
                path: audio.to_string_lossy().into_owned(),
            },
        )
        .expect("insert");

        TempLib { root, lib, audio }
    }

    fn expected_body() -> Vec<u8> {
        (0..1000u32).map(|i| (i % 251) as u8).collect()
    }

    struct Response {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Response {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    /// Speak HTTP at the server the same way GStreamer would.
    fn request(base: &str, path: &str, extra: &[(&str, &str)], method: &str) -> Response {
        let addr = base
            .trim_start_matches("http://")
            .split('/')
            .next()
            .expect("authority");
        let stream = TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        let mut stream = stream;

        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\n");
        for (name, value) in extra {
            req.push_str(&format!("{name}: {value}\r\n"));
        }
        req.push_str("Connection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).expect("write request");

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).expect("status line");
        let status: u16 = line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| panic!("no status in {line:?}"));

        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("header line");
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            let (name, value) = line.split_once(':').expect("header shape");
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }

        let mut body = Vec::new();
        reader.read_to_end(&mut body).expect("body");

        Response {
            status,
            headers,
            body,
        }
    }

    fn serve_temp(tag: &str) -> (TempLib, String) {
        let temp = temp_lib(tag);
        let server = MediaServer::start(temp.lib.clone()).expect("bind loopback");
        let base = server.base_url().expect("a started server has a base").to_owned();
        // The server owns its listener on a detached thread, so dropping the
        // handle here does not stop it; the test wants the URL, not the struct.
        (temp, base)
    }

    #[test]
    fn serves_a_whole_track() {
        let (temp, base) = serve_temp("whole");
        let res = request(&base, &format!("{}/track/1", path_of(&base)), &[], "GET");

        assert_eq!(res.status, 200);
        assert_eq!(res.body, expected_body());
        assert_eq!(res.header("Content-Type"), Some("audio/mpeg"));
        assert_eq!(res.header("Content-Length"), Some("1000"));
        // Without this the media element plays but will not scrub.
        assert_eq!(res.header("Accept-Ranges"), Some("bytes"));
        // Without this `createMediaElementSource` outputs silence.
        assert_eq!(res.header("Access-Control-Allow-Origin"), Some("*"));
        drop(temp);
    }

    #[test]
    fn serves_a_byte_range() {
        let (temp, base) = serve_temp("range");
        let res = request(
            &base,
            &format!("{}/track/1", path_of(&base)),
            &[("Range", "bytes=100-199")],
            "GET",
        );

        assert_eq!(res.status, 206);
        assert_eq!(res.body, expected_body()[100..200]);
        assert_eq!(res.header("Content-Length"), Some("100"));
        assert_eq!(res.header("Content-Range"), Some("bytes 100-199/1000"));
        drop(temp);
    }

    /// The shape a media element actually opens a track with.
    #[test]
    fn serves_an_open_ended_range() {
        let (temp, base) = serve_temp("open");
        let res = request(
            &base,
            &format!("{}/track/1", path_of(&base)),
            &[("Range", "bytes=900-")],
            "GET",
        );

        assert_eq!(res.status, 206);
        assert_eq!(res.body, expected_body()[900..]);
        assert_eq!(res.header("Content-Range"), Some("bytes 900-999/1000"));
        drop(temp);
    }

    #[test]
    fn refuses_a_range_past_the_end() {
        let (temp, base) = serve_temp("past-end");
        let res = request(
            &base,
            &format!("{}/track/1", path_of(&base)),
            &[("Range", "bytes=5000-6000")],
            "GET",
        );

        assert_eq!(res.status, 416);
        assert_eq!(res.header("Content-Range"), Some("bytes */1000"));
        drop(temp);
    }

    #[test]
    fn head_reports_the_length_without_the_body() {
        let (temp, base) = serve_temp("head");
        let res = request(&base, &format!("{}/track/1", path_of(&base)), &[], "HEAD");

        assert_eq!(res.status, 200);
        assert_eq!(res.header("Content-Length"), Some("1000"));
        assert!(res.body.is_empty(), "HEAD must not send a body");
        drop(temp);
    }

    #[test]
    fn a_wrong_token_reads_nothing() {
        let (temp, base) = serve_temp("token");
        let res = request(&base, "/00000000000000000000000000000000/track/1", &[], "GET");

        assert_eq!(res.status, 404);
        assert!(res.body.is_empty());
        drop(temp);
    }

    #[test]
    fn a_missing_track_is_a_404_not_a_hang() {
        let (temp, base) = serve_temp("missing");
        let res = request(&base, &format!("{}/track/999", path_of(&base)), &[], "GET");

        assert_eq!(res.status, 404);
        drop(temp);
    }

    /// A row can outlive its file — the importer's scratch directory gets
    /// cleared, or the user deletes an mp3 by hand. The deck needs a refusal it
    /// can skip past, not a stall.
    #[test]
    fn a_deleted_file_is_a_404() {
        let (temp, base) = serve_temp("deleted");
        std::fs::remove_file(&temp.audio).expect("remove");
        let res = request(&base, &format!("{}/track/1", path_of(&base)), &[], "GET");

        assert_eq!(res.status, 404);
        drop(temp);
    }

    #[test]
    fn other_methods_are_refused_and_preflight_is_allowed() {
        let (temp, base) = serve_temp("methods");
        let target = format!("{}/track/1", path_of(&base));

        let res = request(&base, &target, &[], "DELETE");
        assert_eq!(res.status, 405);
        assert_eq!(res.header("Allow"), Some("GET, HEAD, OPTIONS"));

        let res = request(&base, &target, &[], "OPTIONS");
        assert_eq!(res.status, 204);
        assert_eq!(res.header("Access-Control-Allow-Headers"), Some("Range"));
        drop(temp);
    }

    /// Two decks plus a preload means overlapping connections are the norm.
    #[test]
    fn concurrent_requests_all_get_their_bytes() {
        let (temp, base) = serve_temp("concurrent");
        let target = format!("{}/track/1", path_of(&base));

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let base = base.clone();
                let target = target.clone();
                std::thread::spawn(move || {
                    let start = i * 100;
                    let range = format!("bytes={start}-{}", start + 99);
                    let res = request(&base, &target, &[("Range", &range)], "GET");
                    assert_eq!(res.status, 206);
                    assert_eq!(res.body, expected_body()[start..start + 100]);
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("a concurrent request panicked");
        }
        drop(temp);
    }

    /// `/{token}` out of `http://127.0.0.1:{port}/{token}`.
    fn path_of(base: &str) -> &str {
        let after_scheme = "http://".len();
        let slash = base[after_scheme..].find('/').expect("token in base") + after_scheme;
        &base[slash..]
    }
}
