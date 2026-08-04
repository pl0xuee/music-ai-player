//! Desktop shell: tray icon, tray menu, global media keys, close-to-tray.
//!
//! Everything here funnels into three transport events the frontend already
//! knows how to act on, so the tray menu and the media keys are the same code
//! path — there is exactly one place that decides what "next track" means.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

/// Toggle playback. Payload: none.
pub const EV_PLAY_PAUSE: &str = "transport:play-pause";
/// Advance to the next track. Payload: none.
pub const EV_NEXT: &str = "transport:next";
/// Restart the current track, or step back if it just started. Payload: none.
pub const EV_PREVIOUS: &str = "transport:previous";
/// Fired when the window is hidden or shown. Payload: `bool`, true for visible.
///
/// Emitted on tray show/hide and on close-to-tray. It is an offer, not a
/// contract: nothing in the backend changes behaviour with visibility and
/// nothing here requires a listener, so a UI that ignores it entirely is fully
/// functional. If a listener is ever added, this is the signal to hang
/// "pause the work that only matters while the window is on screen" off.
pub const EV_VISIBILITY: &str = "window:visibility";

const MAIN_WINDOW: &str = "main";

const MENU_PLAY: &str = "tray-play-pause";
const MENU_NEXT: &str = "tray-next";
const MENU_TOGGLE: &str = "tray-toggle-window";
const MENU_QUIT: &str = "tray-quit";

/// Set to true only by [`quit`], so the close handler can tell "user asked to
/// exit" apart from "user clicked the X".
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Set once the tray icon really exists. Without it, hiding on close would trap
/// the app with no window and no menu to bring it back.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
}

fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = app.emit(EV_VISIBILITY, true);
    }
}

fn conceal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
        let _ = app.emit(EV_VISIBILITY, false);
    }
}

fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    let visible = main_window(app)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        conceal(app);
    } else {
        reveal(app);
    }
}

/// Whether closing the window should hide it instead of ending the app.
///
/// False once Quit has been chosen, and false on a session with no tray, where
/// hiding would leave the user with nothing to click.
pub fn should_hide_on_close() -> bool {
    TRAY_READY.load(Ordering::SeqCst) && !QUITTING.load(Ordering::SeqCst)
}

fn quit<R: Runtime>(app: &AppHandle<R>) {
    QUITTING.store(true, Ordering::SeqCst);
    // `exit` triggers RunEvent::ExitRequested, which is where the engine
    // children are killed — see main.rs. Do not call std::process::exit here.
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let play = MenuItem::with_id(app, MENU_PLAY, "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, MENU_NEXT, "Next track", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, MENU_TOGGLE, "Show / Hide window", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &play,
            &next,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Music AI Player")
        .menu(&menu)
        // The menu is the only interaction on the left button for GNOME-style
        // trays; keep the left click free for show/hide instead.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    TRAY_READY.store(true, Ordering::SeqCst);
    Ok(())
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_PLAY => {
            let _ = app.emit(EV_PLAY_PAUSE, ());
        }
        MENU_NEXT => {
            let _ = app.emit(EV_NEXT, ());
        }
        MENU_TOGGLE => toggle_window(app),
        MENU_QUIT => quit(app),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Global media keys
// ---------------------------------------------------------------------------

/// Whether the OS-level media keys actually bound, so the UI can say so
/// instead of leaving the user pressing a dead key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaKeys {
    /// Keys another application already owns.
    pub unclaimed: Vec<String>,
    /// True under a native Wayland session, where the grab is made through
    /// XWayland and therefore only fires while an X11 client has focus. The
    /// registration still succeeds, so this is the only way to warn.
    pub wayland: bool,
}

#[tauri::command]
pub fn media_key_status(keys: State<'_, MediaKeys>) -> MediaKeys {
    keys.inner().clone()
}

/// Register the three transport media keys.
///
/// Returns the shortcuts that could not be claimed rather than failing: on a
/// desktop where the session already owns `XF86AudioPlay` (GNOME's own media
/// handler, or another player registered first) the player must still start —
/// only the OS-level binding is lost, and the UI says so.
pub fn register_media_keys<R: Runtime>(app: &AppHandle<R>) -> MediaKeys {
    let bindings: [(&str, Code, &str); 3] = [
        ("MediaPlayPause", Code::MediaPlayPause, EV_PLAY_PAUSE),
        ("MediaTrackNext", Code::MediaTrackNext, EV_NEXT),
        ("MediaTrackPrevious", Code::MediaTrackPrevious, EV_PREVIOUS),
    ];

    let manager = app.global_shortcut();
    let mut failed = Vec::new();

    for (name, code, event) in bindings {
        // `Modifiers::empty()` and not `None`: a bare media key must not match
        // the same key with Shift or Super held.
        let shortcut = Shortcut::new(Some(Modifiers::empty()), code);
        let event = event.to_string();
        let handler = move |app: &AppHandle<R>, _shortcut: &Shortcut, fired: ShortcutEvent| {
            // Media keys autorepeat while held; act on the press edge only.
            if fired.state == ShortcutState::Pressed {
                let _ = app.emit(event.as_str(), ());
            }
        };
        if manager.on_shortcut(shortcut, handler).is_err() {
            failed.push(name.to_string());
        }
    }

    MediaKeys {
        unclaimed: failed,
        wayland: std::env::var_os("WAYLAND_DISPLAY").is_some(),
    }
}
