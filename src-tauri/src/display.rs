//! The interface, sized for the screen it is actually on.
//!
//! `styles.css` is written in pixels against one display: a 34" 3440x1440, a
//! shade over 110 pixels to the inch. On a denser panel every one of those
//! pixels is physically smaller, so the whole interface shrinks — the same
//! window dragged from that ultrawide onto a 27" 4K comes out around 15%
//! smaller, which is the difference between reading a row title and leaning in.
//!
//! The fix is not to rewrite the stylesheet in physical units. It is to leave
//! the stylesheet alone and tell the webview how big a CSS pixel should be,
//! which is exactly what page zoom is for. So: work out how dense the current
//! monitor is, divide by the density the design assumes, and hand the ratio to
//! WebKit. A pixel then means the same thing on all three screens.
//!
//! ## Why the density has to come from GTK
//!
//! Tauri's own monitor list carries resolution and scale factor but not the
//! panel's physical size, and without millimetres there is no density to
//! compute — 3840x2160 is a dense 27" monitor or a coarse 65" television, and
//! nothing in that number says which. GDK has the millimetres, straight out of
//! the EDID, and it will also name the monitor a *particular window* is on,
//! which saves us matching monitors up by name or by guessing from coordinates
//! the compositor may never tell us.
//!
//! One subtlety about what GDK's geometry means under Wayland: it reports the
//! monitor's *logical* size, the coordinate space the compositor lays windows
//! out in, not the mode. A 3840x2160 panel running at compositor scale 1.25
//! comes back as 3072x1728, and that is the number we want — logical pixels
//! are what a CSS pixel turns into. It is also why this stays right regardless
//! of the integer buffer scale GTK happens to pick for its own rendering.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// The display the stylesheet was drawn for, in pixels per inch.
const REFERENCE_DPI: f64 = 110.0;

/// Bounds on the result. A monitor dense enough to want more than 1.6 exists,
/// but so does an EDID that lies; past these the reading is more likely to be
/// wrong than the screen is to be unusual, and an interface that overflows its
/// own window is worse than one that is slightly small.
const MIN_SCALE: f64 = 0.8;
const MAX_SCALE: f64 = 1.6;

/// Densities outside this are taken as a broken EDID rather than a real panel.
/// Projectors and televisions that report their size as 16x9 *centimetres* are
/// the usual source, and they land far below the floor.
const PLAUSIBLE_DPI: std::ops::Range<f64> = 45.0..500.0;

/// Zoom is quantised to this before being applied. Two monitors of the same
/// nominal size rarely report identical millimetres, and without a step the
/// window would re-zoom by a percent on a move that should have changed
/// nothing. It also keeps the numbers ones a person could reason about.
const STEP: f64 = 0.05;

/// How often the window is asked which monitor it is on.
///
/// Wayland does not tell a client where its window is — there is no move event
/// to hang this off, and `WindowEvent::ScaleFactorChanged` only fires when the
/// *integer* buffer scale changes, which it does not here. So it is a poll.
/// The work is one GDK lookup, and it is skipped entirely while the window is
/// hidden in the tray.
const POLL: Duration = Duration::from_millis(1200);

/// Follow the window from monitor to monitor, re-zooming when it lands on one
/// of a different density.
///
/// Nothing here is fatal. A session where the density cannot be read, or where
/// the zoom will not take, is a session where the interface is sized the way it
/// always was — worth a line on stderr, not worth refusing to open a window
/// over.
pub fn follow_monitor(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("display: no main window to size");
        return;
    };

    // Seeded with the scale the window is really at, so the first probe applies
    // whatever the starting monitor asks for.
    let applied = Arc::new(Mutex::new(1.0_f64));

    // Before the poll, so a window that opens on the dense monitor is right the
    // first time it is painted rather than a second later.
    apply(&window, &applied);

    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(POLL);

            let Some(window) = handle.get_webview_window("main") else {
                return;
            };
            // Hidden in the tray: no monitor, nothing to size, and no reason to
            // wake the main thread for it.
            if !matches!(window.is_visible(), Ok(true)) {
                continue;
            }

            let applied = applied.clone();
            let probed = window.clone();
            // GTK is not thread-safe and neither is the webview; both calls
            // have to happen where the event loop lives. An error here means
            // the app is on its way down, so the thread goes with it.
            if window
                .run_on_main_thread(move || apply(&probed, &applied))
                .is_err()
            {
                return;
            }
        }
    });
}

/// Probe the window's monitor and, if it wants a different zoom than the one
/// in force, apply it. Must run on the main thread.
fn apply(window: &tauri::WebviewWindow, applied: &Mutex<f64>) {
    let Some(density) = density(window) else {
        return;
    };

    let scale = scale_for(density);
    let mut last = match applied.lock() {
        Ok(last) => last,
        Err(poisoned) => poisoned.into_inner(),
    };
    if (scale - *last).abs() < STEP / 2.0 {
        return;
    }

    match window.set_zoom(scale) {
        Ok(()) => {
            println!("display: {density:.0} ppi, interface at {scale:.2}x");
            *last = scale;
        }
        // Left unrecorded in `applied`, so the next poll tries again rather
        // than deciding a zoom that never took effect is the current one.
        Err(err) => eprintln!("display: could not zoom to {scale:.2}x: {err}"),
    }
}

/// The zoom that makes a CSS pixel the same physical size it is on the display
/// the stylesheet was written against.
fn scale_for(dpi: f64) -> f64 {
    let raw = (dpi / REFERENCE_DPI).clamp(MIN_SCALE, MAX_SCALE);
    (raw / STEP).round() * STEP
}

/// Pixels per inch of the monitor this window is currently on, or None when
/// that cannot be established.
///
/// Measured on the diagonal rather than across the width, because that is the
/// one reading a rotated monitor cannot get wrong. GDK reports geometry in the
/// rotated frame — the portrait screen here is 1440x2560 — while the
/// millimetres come from the EDID in the panel's own frame, and pairing width
/// with width would then be off by the aspect ratio. The diagonal is the same
/// line whichever way up the monitor is.
#[cfg(target_os = "linux")]
fn density(window: &tauri::WebviewWindow) -> Option<f64> {
    use gtk::gdk::prelude::MonitorExt;
    use gtk::prelude::WidgetExt;

    let gtk_window = window.gtk_window().ok()?;
    // None until the window is realised, and again once it is hidden.
    let gdk_window = gtk_window.window()?;
    let monitor = gtk_window.display().monitor_at_window(&gdk_window)?;

    let geometry = monitor.geometry();
    let pixels = f64::from(geometry.width()).hypot(f64::from(geometry.height()));
    let millimetres = f64::from(monitor.width_mm()).hypot(f64::from(monitor.height_mm()));
    if pixels <= 0.0 || millimetres <= 0.0 {
        return None;
    }

    let dpi = pixels / (millimetres / 25.4);
    PLAUSIBLE_DPI.contains(&dpi).then_some(dpi)
}

/// Every other platform already resolves this itself — Windows and macOS scale
/// the webview by the display's own factor — so there is nothing to correct.
#[cfg(not(target_os = "linux"))]
fn density(_window: &tauri::WebviewWindow) -> Option<f64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reference_display_is_left_alone() {
        assert_eq!(scale_for(REFERENCE_DPI), 1.0);
        // A 27" 1440p and a 34" ultrawide are both within a hair of 110ppi, and
        // neither should move the interface.
        assert_eq!(scale_for(108.0), 1.0);
        assert_eq!(scale_for(112.0), 1.0);
    }

    #[test]
    fn a_denser_panel_gets_a_larger_interface() {
        // 27" 4K at compositor scale 1.25: 3072x1728 logical over 600x340mm.
        let dpi = 3072.0_f64.hypot(1728.0) / (600.0_f64.hypot(340.0) / 25.4);
        assert!((scale_for(dpi) - 1.20).abs() < 1e-9, "{dpi} ppi");
    }

    #[test]
    fn rotation_does_not_change_the_reading() {
        let landscape = 2560.0_f64.hypot(1440.0) / (600.0_f64.hypot(340.0) / 25.4);
        let portrait = 1440.0_f64.hypot(2560.0) / (340.0_f64.hypot(600.0) / 25.4);
        assert_eq!(scale_for(landscape), scale_for(portrait));
    }

    #[test]
    fn an_implausible_panel_is_refused_rather_than_clamped() {
        // A television reporting 16x9 centimetres as its physical size.
        assert!(
            !PLAUSIBLE_DPI.contains(&(3840.0_f64.hypot(2160.0) / (160.0_f64.hypot(90.0) / 25.4)))
        );
    }

    #[test]
    fn the_scale_stays_within_its_bounds() {
        assert_eq!(scale_for(46.0), MIN_SCALE);
        assert_eq!(scale_for(499.0), MAX_SCALE);
    }
}
