// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod engine;
mod library;
mod proc;
mod youtube;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            let lib = library::Library::discover();
            println!("library database: {}", lib.db_path().display());

            // Additive and idempotent: the user's database is already populated
            // by the generator, which keeps writing to it independently. This
            // only adds the import columns and the playlist tables.
            //
            // It is also a *writer*, so it can lose the five-second race with a
            // generation run that is mid-batch. That is not fatal — the window
            // must still open — but it is not swallowed either: the failure is
            // recorded on the `Library`, every command retries the migration
            // before it queries, and until one succeeds the UI is handed the
            // real error instead of an empty library over a full one.
            if let Err(err) = lib.migrate() {
                eprintln!("library migration failed: {err}");
                eprintln!("the library commands will retry it and report it until it succeeds");
            }

            // tauri.conf.json enables the asset protocol but leaves its scope
            // empty, because the library location is only known at runtime
            // (`MUSIC_AI_LIBRARY`, or discovered relative to the working dir).
            // Widening the scope here keeps it to exactly one directory instead
            // of a static `$HOME/**` glob.
            if let Some(root) = lib.media_root() {
                if let Err(err) = app.asset_protocol_scope().allow_directory(root, true) {
                    eprintln!("could not allow {}: {err}", root.display());
                }
            }
            // Imported audio lives under the library root, so the same scope
            // widening covers it; `track_source` still grants per-file access
            // for libraries pointed elsewhere.
            let downloads = youtube::Downloads::new(lib.clone());
            youtube::spawn_worker(downloads.clone(), handle.clone());
            app.manage(downloads);
            app.manage(lib);

            // The engine is optional by design: discovery never fails, it only
            // records *why* generation is unavailable. The player is unaffected
            // by a missing venv, a missing engine/ directory or a dead GPU.
            let eng = engine::Engine::discover();
            println!("engine directory: {}", eng.paths().engine_dir.display());
            engine::spawn_status_poller(eng.clone(), handle.clone());
            app.manage(eng);

            if let Err(err) = desktop::build_tray(&handle) {
                // A session with no StatusNotifierItem host (bare WM, no tray)
                // must not stop the player from opening.
                eprintln!("tray unavailable: {err}");
            }

            let keys = desktop::register_media_keys(&handle);
            if !keys.unclaimed.is_empty() {
                eprintln!(
                    "media keys already claimed by another application: {}",
                    keys.unclaimed.join(", ")
                );
            }
            app.manage(keys);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Close hides to the tray; only the tray's Quit really exits.
                // On a session with no tray it closes for real, because there
                // would be nothing left to click to bring the window back.
                if desktop::should_hide_on_close() {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.app_handle().emit(desktop::EV_VISIBILITY, false);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            library::list_tracks,
            library::library_stats,
            library::genres,
            library::rate_track,
            library::mark_played,
            library::track_source,
            library::list_playlists,
            library::create_playlist,
            library::rename_playlist,
            library::delete_playlist,
            library::clear_playlist,
            library::list_playlist_items,
            library::add_to_playlist,
            library::remove_item,
            library::reorder_item,
            youtube::youtube_status,
            youtube::youtube_jobs,
            youtube::youtube_import,
            youtube::youtube_cancel,
            youtube::youtube_cancel_all,
            youtube::youtube_clear_finished,
            desktop::media_key_status,
            engine::engine_status,
            engine::engine_start,
            engine::engine_stop,
            engine::generation_state,
            engine::generation_start,
            engine::generation_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Music AI Player");

    app.run(|handle, event| {
        // Leaving a ~13 GB ACE-Step process resident after the window is gone
        // is the one unforgivable bug in this app, so both exit events tear the
        // children down. `shutdown` is idempotent and safe to run twice.
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(eng) = handle.try_state::<engine::Engine>() {
                eng.shutdown();
            }
            // yt-dlp forks ffmpeg; leaving a transcode running after the window
            // is gone is the same unforgivable bug in a smaller package.
            if let Some(dl) = handle.try_state::<youtube::Downloads>() {
                dl.shutdown();
            }
        }
    });
}
