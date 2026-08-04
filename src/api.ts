import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  DownloadJob,
  EngineStatus,
  GenerationProgress,
  GenStyle,
  GenTarget,
  ImportReport,
  LogLine,
  MediaKeys,
  Playlist,
  PlaylistItem,
  PruneReport,
  ScanReport,
  Stats,
  Track,
  YtTools,
} from "./types";
import { EMPTY_TOOLS, IDLE_RUN, OFFLINE_ENGINE } from "./types";
import { DEV_STYLES, devJobs, devSourceUrl, devStats, devTracks } from "./dev-fixtures";

/**
 * `npm run dev` can be opened in a plain browser, where there is no Tauri IPC
 * bridge. Every call degrades to an empty library instead of throwing, so the
 * UI is still developable outside the shell.
 */
function hasBridge(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export const IN_TAURI = hasBridge();

export function listTracks(genre: string | null): Promise<Track[]> {
  if (!IN_TAURI) {
    const tracks = devTracks();
    return Promise.resolve(
      genre === null || genre === "all" ? tracks : tracks.filter((t) => t.genre === genre),
    );
  }
  return invoke<Track[]>("list_tracks", { genre });
}

export function libraryStats(): Promise<Stats> {
  if (!IN_TAURI) return Promise.resolve(devStats());
  return invoke<Stats>("library_stats");
}

export function genres(): Promise<string[]> {
  if (!IN_TAURI) return Promise.resolve(devStats().genres.map((g) => g.genre));
  return invoke<string[]>("genres");
}

export function rateTrack(id: number, rating: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("rate_track", { id, rating });
}

/**
 * Drop rows whose audio file has gone.
 *
 * Files leave without the library hearing about it — a folder is tidied, a
 * disk is unplugged, test downloads are deleted by hand — and those rows are
 * already unplayable. This is how they stop taking up space in the list.
 */
export function pruneMissing(): Promise<PruneReport> {
  if (!IN_TAURI) return Promise.resolve({ checked: 0, removed: 0 });
  return invoke<PruneReport>("prune_missing");
}

export function markPlayed(id: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("mark_played", { id });
}

/**
 * URL prefix of the loopback media server, asked for once.
 *
 * The promise itself is the cache, not its result: two decks resolve their
 * sources concurrently on the first play, and awaiting a stored promise makes
 * that one IPC round trip instead of a race between two.
 *
 * `null` means the server did not come up. Rare — it is an ephemeral loopback
 * port — but it is a survivable state rather than a broken player, so it falls
 * through to `bufferedSourceUrl` below.
 */
let mediaBase: Promise<string | null> | null = null;

function streamBase(): Promise<string | null> {
  mediaBase ??= invoke<string | null>("media_base_url").catch(() => null);
  return mediaBase;
}

/**
 * Resolve a track to a URL the `<audio>` element can load.
 *
 * Tauri's own answer to this is the asset protocol: `track_source` hands back
 * an absolute path and widens the protocol scope to it, and `convertFileSrc`
 * rewrites that into `asset://localhost/…`. It does not work for media on
 * Linux. WebKitGTK plays `<audio>`/`<video>` through GStreamer, which resolves
 * the source URL itself and has no handler for WebKit's custom schemes, so
 * `asset://` answers `fetch` and range requests perfectly while every media
 * element built on it fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` and never
 * reports a duration. Measured on webkit2gtk 2.52.5 for every URL shape —
 * encoded path, literal path, no host, `http://asset.localhost` — with and
 * without `crossOrigin`. That is the whole reason this player had never made a
 * sound on Linux.
 *
 * HTTP is the transport GStreamer does speak, so the tracks come off a loopback
 * server instead (`src-tauri/src/stream.rs`), and this is a URL for it. Byte
 * ranges mean playback starts on the first few kilobytes and a seek is a fresh
 * request rather than a download, whatever the file weighs.
 *
 * `track_source` is still called, and still first: its filesystem check is what
 * distinguishes a dead row from a live one, and answering `null` here is how a
 * deck knows to skip rather than stall. The path it returns is only used by the
 * fallback.
 */
export async function trackSourceUrl(id: number): Promise<string | null> {
  // Outside the shell every deck loads the same stand-in tone, so the whole
  // transport can be exercised in a plain browser.
  if (!IN_TAURI) return devSourceUrl();

  const path = await invoke<string | null>("track_source", { id });
  if (path === null) {
    forgetBuffered(id);
    return null;
  }

  const base = await streamBase();
  if (base !== null) return `${base}/track/${id}`;

  return bufferedSourceUrl(id, path);
}

/**
 * How many buffered sources stay resident.
 *
 * Two decks are ever loaded at once; the third slot absorbs a preload racing a
 * click without evicting a URL a deck is still opening. Kept deliberately tight
 * because each entry is a whole file in memory — a 2-hour 272 MB mix really does
 * cost 272 MB here — so this is the ceiling on that, not a performance cache.
 */
const SOURCE_CACHE_LIMIT = 3;

/** Track id -> object URL, in least-recently-requested order. */
const sourceCache = new Map<number, string>();

/**
 * The fallback for a machine where the media server could not bind.
 *
 * Fetching through the asset protocol *does* work — it is only media elements
 * that cannot consume the URL — so the bytes are pulled here and handed over as
 * an object URL, which a media element loads normally. This is what shipped
 * before the server existed, and it plays.
 *
 * It is the fallback and not the default because it buffers the whole file
 * before the first sample: a 272 MB two-hour mix measured 5.6 s to first sound
 * and put the web process at 537 MB resident, and every seek is against a blob
 * that has to be complete.
 */
async function bufferedSourceUrl(id: number, path: string): Promise<string> {
  const cached = sourceCache.get(id);
  if (cached !== undefined) {
    // Re-insert so the deck that just asked for it is the last to be evicted.
    sourceCache.delete(id);
    sourceCache.set(id, cached);
    return cached;
  }

  const response = await fetch(convertFileSrc(path));
  if (!response.ok) {
    throw new Error(`the asset protocol answered ${response.status} for "${path}"`);
  }
  const url = URL.createObjectURL(await response.blob());
  sourceCache.set(id, url);

  // Bounded, because a long session would otherwise hold every track it has
  // played in memory. Revoking only stops *new* loads from the URL; a deck that
  // already opened it keeps its data.
  while (sourceCache.size > SOURCE_CACHE_LIMIT) {
    const oldest = sourceCache.keys().next();
    if (oldest.done === true) break;
    const stale = sourceCache.get(oldest.value);
    sourceCache.delete(oldest.value);
    if (stale !== undefined) URL.revokeObjectURL(stale);
  }

  return url;
}

/** Drop a buffered source whose file has gone, so it cannot play on out of memory. */
function forgetBuffered(id: number): void {
  const stale = sourceCache.get(id);
  if (stale === undefined) return;
  sourceCache.delete(id);
  URL.revokeObjectURL(stale);
}

// ---------------------------------------------------------------------------
// Local files
// ---------------------------------------------------------------------------

/**
 * Adopt every audio file under `paths`, which may be folders, files, or both.
 *
 * Nothing is copied. Each row points at the file where it already lives, so
 * removing a track from the library never touches the user's collection.
 */
export function scanLocal(paths: string[]): Promise<ScanReport> {
  if (!IN_TAURI || paths.length === 0) {
    return Promise.resolve({ added: 0, skipped: 0, failed: 0, truncated: false, errors: [] });
  }
  return invoke<ScanReport>("scan_local", { paths });
}

/**
 * Ask for folders to scan.
 *
 * Folders rather than files, because a music collection is a tree and picking
 * 400 tracks by hand is not a thing anyone should do. Dropping loose files onto
 * the window covers the one-off case.
 */
/** One folder, for choosing where downloads should land. */
export async function pickSaveFolder(current: string | null): Promise<string | null> {
  if (!IN_TAURI) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Save downloads to",
    defaultPath: current ?? undefined,
  });
  return typeof chosen === "string" ? chosen : null;
}

export async function pickMusicFolders(): Promise<string[]> {
  if (!IN_TAURI) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({ directory: true, multiple: true, title: "Add music from a folder" });
  if (chosen === null) return [];
  return Array.isArray(chosen) ? chosen : [chosen];
}

/**
 * Files and folders dragged onto the window.
 *
 * This is the webview's own drag-drop event rather than the DOM's: a file
 * dropped on a Tauri window never reaches the page as a `DragEvent`, and the
 * paths it carries are real filesystem paths, which is what the scanner needs.
 *
 * `over` fires continuously while something is held over the window, so the UI
 * can show where to let go.
 */
export function onFileDrop(handlers: {
  over: (active: boolean) => void;
  drop: (paths: string[]) => void;
}): () => void {
  if (!IN_TAURI) return () => {};

  // Four separate events, not one with a discriminated payload. Getting that
  // wrong fails silently — the listener attaches to a name nothing ever emits
  // — so the names come from `TauriEvent` in @tauri-apps/api rather than from
  // memory.
  const offs: UnlistenFn[] = [];
  let cancelled = false;

  const sub = <T,>(name: string, handle: (payload: T) => void): void => {
    void listen<T>(name, (event) => handle(event.payload))
      .then((off) => {
        if (cancelled) off();
        else offs.push(off);
      })
      .catch(() => {
        /* a window with no drag-drop support simply never fires */
      });
  };

  sub("tauri://drag-enter", () => handlers.over(true));
  // `over` fires continuously while something is held over the window. It is
  // redundant after `enter`, and it is also the one that still arrives if the
  // pointer entered before the listener was attached.
  sub("tauri://drag-over", () => handlers.over(true));
  sub("tauri://drag-leave", () => handlers.over(false));
  sub<{ paths?: string[] }>("tauri://drag-drop", (payload) => {
    handlers.over(false);
    handlers.drop(payload.paths ?? []);
  });

  return () => {
    cancelled = true;
    for (const off of offs) off();
  };
}

/**
 * Tell the desktop what is playing, so its media keys, panel applet and lock
 * screen have something real to work with.
 *
 * Fire-and-forget: this is presentation for another process, and failing to
 * update it must never surface as an error in the player.
 */
export function reportNowPlaying(now: {
  title: string;
  artist: string;
  playing: boolean;
  position: number;
  duration: number;
  id: number;
}): void {
  if (!IN_TAURI) return;
  void invoke("mpris_now_playing", { now }).catch(() => {
    /* no MPRIS on this desktop */
  });
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** What a check found, or null when this build is already the newest. */
export interface UpdateInfo {
  version: string;
  notes: string;
  date: string | null;
}

/**
 * Ask the release channel whether there is a newer build.
 *
 * The manifest is signed and the plugin verifies it against the public key in
 * `tauri.conf.json` before it will report anything, so an endpoint that has
 * been tampered with fails the check rather than offering a payload.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!IN_TAURI) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const found = await check();
  if (found === null) return null;
  return { version: found.version, notes: found.body ?? "", date: found.date ?? null };
}

/**
 * Download the new build, install it, and relaunch into it.
 *
 * `onProgress` reports 0..1 while the bytes come down. Installing an AppImage
 * replaces the running image in place, so the relaunch is what actually puts
 * the user on the new version — without it they keep using the old one until
 * they quit.
 */
export async function installUpdate(onProgress: (fraction: number) => void): Promise<void> {
  if (!IN_TAURI) throw new Error("not running inside the desktop shell");
  const { check } = await import("@tauri-apps/plugin-updater");
  const found = await check();
  if (found === null) throw new Error("there is no update to install");

  let total = 0;
  let seen = 0;
  await found.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(0);
    } else if (event.event === "Progress") {
      seen += event.data.chunkLength;
      if (total > 0) onProgress(Math.min(seen / total, 1));
    } else if (event.event === "Finished") {
      onProgress(1);
    }
  });

  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** The running build, from Cargo.toml via Tauri. */
export async function appVersion(): Promise<string> {
  if (!IN_TAURI) return "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Names must match the `EV_*` constants in the Rust modules. */
export const EVENTS = {
  engineStatus: "engine:status",
  engineLog: "engine:log",
  generation: "generation:progress",
  generationLog: "generation:log",
  playPause: "transport:play-pause",
  next: "transport:next",
  previous: "transport:previous",
  visibility: "window:visibility",
  downloads: "youtube:jobs",
  localScan: "local:progress",
} as const;

/**
 * Subscribe to a backend event, returning a synchronous unsubscribe.
 *
 * `listen()` resolves asynchronously, so an effect that unmounts before the
 * promise settles would otherwise leak a listener; the `cancelled` flag closes
 * that window. Outside Tauri this is a no-op, which keeps every caller free of
 * environment checks.
 */
export function onBackendEvent<T>(name: string, handler: (payload: T) => void): () => void {
  if (!IN_TAURI) return () => {};
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void listen<T>(name, (event) => handler(event.payload))
    .then((off) => {
      if (cancelled) {
        off();
      } else {
        unlisten = off;
      }
    })
    .catch(() => {
      /* A window torn down mid-subscribe is not an error worth surfacing. */
    });
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

/** Convenience wrapper for the payload-less transport events. */
export function onTransport(name: string, handler: () => void): () => void {
  return onBackendEvent<null>(name, () => handler());
}

export function onEngineStatus(handler: (status: EngineStatus) => void): () => void {
  return onBackendEvent<EngineStatus>(EVENTS.engineStatus, handler);
}

export function onGeneration(handler: (progress: GenerationProgress) => void): () => void {
  return onBackendEvent<GenerationProgress>(EVENTS.generation, handler);
}

export function onEngineLog(handler: (entry: LogLine) => void): () => void {
  return onBackendEvent<LogLine>(EVENTS.engineLog, handler);
}

export function onGenerationLog(handler: (entry: LogLine) => void): () => void {
  return onBackendEvent<LogLine>(EVENTS.generationLog, handler);
}

// ---------------------------------------------------------------------------
// Generator control
// ---------------------------------------------------------------------------

export function engineStatus(): Promise<EngineStatus> {
  if (!IN_TAURI) return Promise.resolve(OFFLINE_ENGINE);
  return invoke<EngineStatus>("engine_status");
}

export function engineStart(): Promise<EngineStatus> {
  if (!IN_TAURI) return Promise.reject(new Error("not running inside the desktop shell"));
  return invoke<EngineStatus>("engine_start");
}

export function engineStop(): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("engine_stop");
}

export function generationState(): Promise<GenerationProgress> {
  if (!IN_TAURI) return Promise.resolve(IDLE_RUN);
  return invoke<GenerationProgress>("generation_state");
}

/**
 * Start a run, optionally restricted to named styles.
 *
 * An empty list means the prompt bank's own weights decide the mix, which is
 * the default and what an untargeted run has always done.
 */
export function generationStart(
  target: GenTarget,
  styles: string[],
): Promise<GenerationProgress> {
  if (!IN_TAURI) return Promise.reject(new Error("not running inside the desktop shell"));
  return invoke<GenerationProgress>("generation_start", { target, styles });
}

/** The styles `engine/prompts.toml` can render, with their default share. */
export function generationStyles(): Promise<GenStyle[]> {
  if (!IN_TAURI) return Promise.resolve(DEV_STYLES);
  return invoke<GenStyle[]>("generation_styles");
}

export function generationCancel(): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("generation_cancel");
}

export function mediaKeyStatus(): Promise<MediaKeys> {
  if (!IN_TAURI) return Promise.resolve({ unclaimed: [], wayland: false });
  return invoke<MediaKeys>("media_key_status");
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export function listPlaylists(): Promise<Playlist[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<Playlist[]>("list_playlists");
}

export function createPlaylist(name: string): Promise<number> {
  if (!IN_TAURI) return Promise.reject(new Error("not running inside the desktop shell"));
  return invoke<number>("create_playlist", { name });
}

export function renamePlaylist(id: number, name: string): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("rename_playlist", { id, name });
}

export function deletePlaylist(id: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("delete_playlist", { id });
}

export function clearPlaylist(id: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("clear_playlist", { id });
}

export function listPlaylistItems(playlistId: number): Promise<PlaylistItem[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<PlaylistItem[]>("list_playlist_items", { playlistId });
}

export function addToPlaylist(playlistId: number, trackId: number): Promise<boolean> {
  if (!IN_TAURI) return Promise.resolve(false);
  return invoke<boolean>("add_to_playlist", { playlistId, trackId });
}

/** `itemId` is `playlist_items.id`, not a track id. */
export function removeItem(itemId: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("remove_item", { itemId });
}

export function reorderItem(itemId: number, newPosition: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("reorder_item", { itemId, newPosition });
}

// ---------------------------------------------------------------------------
// YouTube import
// ---------------------------------------------------------------------------

export function youtubeStatus(): Promise<YtTools> {
  if (!IN_TAURI) return Promise.resolve(EMPTY_TOOLS);
  return invoke<YtTools>("youtube_status");
}

export function youtubeJobs(): Promise<DownloadJob[]> {
  if (!IN_TAURI) return Promise.resolve(devJobs());
  return invoke<DownloadJob[]>("youtube_jobs");
}

/**
 * Queue a pasted blob of URLs.
 *
 * `wholePlaylist` only decides what to do with a link that carries *both* a
 * video and a `list=`; a bare playlist URL always expands, and a bare video URL
 * never does.
 */
export function youtubeImport(
  text: string,
  playlistId: number | null,
  wholePlaylist: boolean,
  /** Where to write the audio; null is the library's own `tracks/`. */
  destination: string | null,
): Promise<ImportReport> {
  if (!IN_TAURI) return Promise.reject(new Error("not running inside the desktop shell"));
  return invoke<ImportReport>("youtube_import", {
    text,
    playlistId,
    wholePlaylist,
    destination,
  });
}

export function youtubeCancel(jobId: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("youtube_cancel", { jobId });
}

/**
 * Queue a failed or cancelled download again, replacing the attempt it retries.
 *
 * Rejects with the reason when it will not queue — most usefully when the video
 * turns out to be in the library after all.
 */
export function youtubeRetry(jobId: number): Promise<ImportReport> {
  if (!IN_TAURI) return Promise.reject(new Error("not running inside the desktop shell"));
  return invoke<ImportReport>("youtube_retry", { jobId });
}

export function youtubeCancelAll(): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("youtube_cancel_all");
}

export function youtubeClearFinished(): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("youtube_clear_finished");
}

export function onDownloads(handler: (jobs: DownloadJob[]) => void): () => void {
  return onBackendEvent<DownloadJob[]>(EVENTS.downloads, handler);
}
