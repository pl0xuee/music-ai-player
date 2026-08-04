import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  DownloadJob,
  EngineStatus,
  GenerationProgress,
  GenTarget,
  ImportReport,
  LogLine,
  MediaKeys,
  Playlist,
  PlaylistItem,
  Stats,
  Track,
  YtTools,
} from "./types";
import { EMPTY_STATS, EMPTY_TOOLS, IDLE_RUN, OFFLINE_ENGINE } from "./types";

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
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<Track[]>("list_tracks", { genre });
}

export function libraryStats(): Promise<Stats> {
  if (!IN_TAURI) return Promise.resolve(EMPTY_STATS);
  return invoke<Stats>("library_stats");
}

export function genres(): Promise<string[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<string[]>("genres");
}

export function rateTrack(id: number, rating: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("rate_track", { id, rating });
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
  if (!IN_TAURI) return null;

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

export function generationStart(target: GenTarget): Promise<GenerationProgress> {
  if (!IN_TAURI) return Promise.reject(new Error("not running inside the desktop shell"));
  return invoke<GenerationProgress>("generation_start", { target });
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
  if (!IN_TAURI) return Promise.resolve([]);
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
): Promise<ImportReport> {
  if (!IN_TAURI) return Promise.reject(new Error("not running inside the desktop shell"));
  return invoke<ImportReport>("youtube_import", { text, playlistId, wholePlaylist });
}

export function youtubeCancel(jobId: number): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke<void>("youtube_cancel", { jobId });
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
