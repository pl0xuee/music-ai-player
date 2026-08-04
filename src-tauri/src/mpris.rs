//! MPRIS, so the desktop's media keys reach this window.
//!
//! # Why this is hand-written
//!
//! WebKitGTK already publishes an MPRIS service for a playing `<audio>`
//! element, which is why the keys worked occasionally. It is not enough: that
//! service is anonymous — no `DesktopEntry`, empty metadata — and it sits on
//! the session bus beside every browser that happens to be open. With five
//! players registered the desktop has no reason to route a key here rather than
//! to a browser, and nothing to show in its panel if it does.
//!
//! `souvlaki` is the obvious crate for this and it does not work in this build.
//! Its zbus backend drives the connection with `pollster`, while zbus here is
//! compiled with its `tokio` feature — pulled in by the desktop portal that the
//! file picker needs — so the connection future never progresses. `new` and
//! `attach` both return `Ok` and no bus name is ever registered. Its libdbus
//! backend is silent in the same way. So the two interfaces are served
//! directly, on Tauri's own tokio runtime, where the future is actually polled.
//!
//! # How it joins the rest of the app
//!
//! Not by reaching into the player. A key press is emitted as the same
//! `transport:*` event the tray menu and the global shortcuts already emit, so
//! there is one definition of what "next" means regardless of which surface
//! asked for it. State flows the other way: the frontend reports what it is
//! playing, and that is what the desktop displays.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::{connection, interface};

use crate::desktop::{EV_NEXT, EV_PLAY_PAUSE, EV_PREVIOUS};

/// Bus name. The desktop matches `DesktopEntry` below against the installed
/// `.desktop` file, which is named after the identifier in tauri.conf.json.
const BUS_NAME: &str = "org.mpris.MediaPlayer2.music_ai_player";
const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
const DESKTOP_ENTRY: &str = "io.github.pl0xuee.musicaiplayer";

/// What the frontend reports about the current track.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    /// Channel, artist, or the genre a generated track was rendered for.
    pub artist: String,
    pub playing: bool,
    /// Seconds.
    pub position: f64,
    /// Seconds; 0 when unknown.
    pub duration: f64,
    /// Row id, so the track identity changes when the track does.
    pub id: i64,
}

type Shared = Arc<Mutex<NowPlaying>>;

/// Managed handle. Holding the connection is what keeps the name claimed.
pub struct Mpris {
    state: Shared,
    connection: Mutex<Option<zbus::Connection>>,
}

impl Mpris {
    fn snapshot(&self) -> NowPlaying {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

// ---------------------------------------------------------------------------
// org.mpris.MediaPlayer2
// ---------------------------------------------------------------------------

struct Root<R: Runtime> {
    app: AppHandle<R>,
}

#[interface(name = "org.mpris.MediaPlayer2")]
impl<R: Runtime> Root<R> {
    /// Bring the window back. The tray does the same thing.
    fn raise(&self) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    fn quit(&self) {
        self.app.exit(0);
    }

    #[zbus(property)]
    fn can_quit(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_raise(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn identity(&self) -> String {
        "Music AI Player".to_string()
    }

    /// The whole point of writing this by hand: without it the desktop cannot
    /// tie the service to the installed application, which is what it uses to
    /// decide who owns the media keys.
    #[zbus(property)]
    fn desktop_entry(&self) -> String {
        DESKTOP_ENTRY.to_string()
    }

    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        Vec::new()
    }

    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        Vec::new()
    }
}

// ---------------------------------------------------------------------------
// org.mpris.MediaPlayer2.Player
// ---------------------------------------------------------------------------

struct Player<R: Runtime> {
    app: AppHandle<R>,
    state: Shared,
}

impl<R: Runtime> Player<R> {
    fn now(&self) -> NowPlaying {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl<R: Runtime> Player<R> {
    fn play_pause(&self) {
        let _ = self.app.emit(EV_PLAY_PAUSE, ());
    }

    /// Play and Pause both toggle rather than forcing a direction.
    ///
    /// The desktop sends whichever it believes is right for the state it last
    /// saw, and that belief can be stale — a Play arriving while the track is
    /// already running would otherwise do nothing at all, which reads as a dead
    /// key. The frontend owns the real state and toggles from it.
    fn play(&self) {
        if !self.now().playing {
            let _ = self.app.emit(EV_PLAY_PAUSE, ());
        }
    }

    fn pause(&self) {
        if self.now().playing {
            let _ = self.app.emit(EV_PLAY_PAUSE, ());
        }
    }

    /// Deliberately a pause. This player has no stopped state a listener would
    /// recognise, and losing the queue to a stray key press is worse.
    fn stop(&self) {
        self.pause();
    }

    fn next(&self) {
        let _ = self.app.emit(EV_NEXT, ());
    }

    fn previous(&self) {
        let _ = self.app.emit(EV_PREVIOUS, ());
    }

    #[zbus(property)]
    fn playback_status(&self) -> String {
        let now = self.now();
        if now.title.is_empty() {
            "Stopped".into()
        } else if now.playing {
            "Playing".into()
        } else {
            "Paused".into()
        }
    }

    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let now = self.now();
        let mut map: HashMap<String, OwnedValue> = HashMap::new();
        if now.title.is_empty() {
            return map;
        }

        // A track id that changes with the track, which is how a desktop knows
        // one song ended and another began rather than one song being edited.
        let track_id = format!("/io/github/pl0xuee/musicaiplayer/track/{}", now.id.max(0));
        if let Ok(path) = ObjectPath::try_from(track_id) {
            if let Ok(value) = OwnedValue::try_from(Value::from(path)) {
                map.insert("mpris:trackid".into(), value);
            }
        }
        if now.duration > 0.0 {
            // MPRIS counts in microseconds.
            let micros = (now.duration * 1_000_000.0) as i64;
            if let Ok(value) = OwnedValue::try_from(Value::from(micros)) {
                map.insert("mpris:length".into(), value);
            }
        }
        if let Ok(value) = OwnedValue::try_from(Value::from(now.title.clone())) {
            map.insert("xesam:title".into(), value);
        }
        if !now.artist.is_empty() {
            if let Ok(value) = OwnedValue::try_from(Value::from(vec![now.artist.clone()])) {
                map.insert("xesam:artist".into(), value);
            }
        }
        map
    }

    #[zbus(property)]
    fn position(&self) -> i64 {
        (self.now().position * 1_000_000.0) as i64
    }

    #[zbus(property)]
    fn volume(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn set_volume(&self, _volume: f64) {}

    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }

    /// Seeking is not offered: the desktop would drive it against a position we
    /// only report once a second, and a control that lands somewhere other than
    /// where it was aimed is worse than one that is absent.
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/// Claim the bus name and serve both interfaces.
///
/// Failure is reported and never fatal: without MPRIS the tray menu and the
/// in-window keys still work, and the app must open regardless.
pub fn attach<R: Runtime>(app: &AppHandle<R>) {
    let state: Shared = Arc::new(Mutex::new(NowPlaying::default()));
    app.manage(Mpris {
        state: state.clone(),
        connection: Mutex::new(None),
    });

    let handle = app.clone();
    // Tauri's runtime is tokio, which is what zbus was compiled for here. This
    // is the whole reason the hand-written version works where souvlaki did not.
    tauri::async_runtime::spawn(async move {
        let root = Root {
            app: handle.clone(),
        };
        let player = Player {
            app: handle.clone(),
            state,
        };

        let built = connection::Builder::session()
            .and_then(|b| b.name(BUS_NAME))
            .and_then(|b| b.serve_at(OBJECT_PATH, root))
            .and_then(|b| b.serve_at(OBJECT_PATH, player));

        match built {
            Err(err) => eprintln!("mpris unavailable: {err}"),
            Ok(builder) => match builder.build().await {
                Err(err) => eprintln!("mpris could not claim {BUS_NAME}: {err}"),
                Ok(connection) => {
                    println!("mpris: {BUS_NAME}");
                    if let Some(mpris) = handle.try_state::<Mpris>() {
                        *mpris
                            .connection
                            .lock()
                            .unwrap_or_else(|e| e.into_inner()) = Some(connection);
                    }
                }
            },
        }
    });
}

/// Push the current track and playback state to the desktop.
///
/// Called on every track change and play/pause, and once a second while playing
/// so the position stays honest. The property-changed signals are what make a
/// panel applet update without polling.
#[tauri::command]
pub fn mpris_now_playing<R: Runtime>(
    app: AppHandle<R>,
    mpris: State<'_, Mpris>,
    now: NowPlaying,
) {
    {
        let mut guard = mpris.state.lock().unwrap_or_else(|e| e.into_inner());
        *guard = now;
    }
    let Some(connection) = mpris
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    else {
        return;
    };
    let _ = app;

    tauri::async_runtime::spawn(async move {
        let Ok(path) = ObjectPath::try_from(OBJECT_PATH) else {
            return;
        };
        let Ok(iface) = connection
            .object_server()
            .interface::<_, Player<R>>(&path)
            .await
        else {
            return;
        };
        let emitter = SignalEmitter::new(&connection, &path).ok();
        if let Some(emitter) = emitter {
            let player = iface.get().await;
            let _ = player.playback_status_changed(&emitter).await;
            let _ = player.metadata_changed(&emitter).await;
        }
    });
}
