/** Where a row came from. Mirrors `SOURCE_*` in `src-tauri/src/library.rs`. */
export type TrackSource = "generated" | "youtube" | "local";

/** Mirrors `src-tauri/src/library.rs`. Only `status = 'ready'` rows reach the UI. */
export interface Track {
  id: number;
  title: string;
  genre: string;
  bpm: number;
  keyScale: string;
  prompt: string;
  duration: number | null;
  path: string | null;
  createdAt: string;
  playCount: number;
  lastPlayed: string | null;
  /** -1 buried, 0 unrated, 1 starred. */
  rating: number;
  /**
   * Only a generated row carries tempo, key and prompt. The other two show
   * who made the audio in that space instead — a channel, or an artist.
   */
  source: TrackSource;
  videoId: string | null;
  url: string | null;
  /** Channel for a YouTube import, `artist` tag for a local file. */
  uploader: string | null;
}

/** True for rows imported from YouTube, which carry no tempo or key. */
export function isImported(track: Track): boolean {
  return track.source === "youtube";
}

/**
 * True when the generator wrote this row, and therefore when tempo, key and
 * prompt mean anything. Both other sources leave those columns at 0 and "".
 */
export function isGenerated(track: Track): boolean {
  return track.source === "generated";
}

/** Who to credit, and under what heading. */
export function creditFor(track: Track): { label: string; value: string } {
  if (track.source === "youtube") {
    return { label: "Channel", value: track.uploader ?? "unknown" };
  }
  return { label: "Artist", value: track.uploader ?? "unknown" };
}

export const SOURCE_LABEL: Record<TrackSource, string> = {
  generated: "Generated",
  youtube: "YouTube",
  local: "On disk",
};

/**
 * The genre, when it says something the source has not already said.
 *
 * Imports get `genre = 'youtube'` and untagged local files get `'local'`, so
 * showing the column verbatim puts "Genre: youtube" next to "YouTube" and
 * calls it information. `null` means there is nothing worth a column.
 */
export function meaningfulGenre(track: Track): string | null {
  const genre = track.genre.trim();
  if (genre === "" || genre.toLowerCase() === track.source) return null;
  return genre;
}

/** One style the prompt bank can render. Mirrors `GenStyle` in `engine.rs`. */
export interface GenStyle {
  name: string;
  /** Share of an untargeted run, as a percentage. */
  share: number;
  /** The tempo range this style is written for, `[low, high]`. */
  bpm: [number, number];
}

// ---------------------------------------------------------------------------
// Local files — mirrors `src-tauri/src/local.rs`
// ---------------------------------------------------------------------------

/** Outcome of one folder scan. */
export interface ScanReport {
  added: number;
  /** Already in the library, matched by path. */
  skipped: number;
  /** Looked like audio, but nothing could decode it. */
  failed: number;
  /** True when the scan hit its file ceiling before running out of folders. */
  truncated: boolean;
  errors: string[];
}

/** Outcome of a cleanup pass over the library. */
export interface PruneReport {
  /** Ready rows whose file was checked. */
  checked: number;
  /** Rows dropped because the file behind them has gone. */
  removed: number;
}

export interface ScanProgress {
  done: number;
  total: number;
  current: string;
}

// ---------------------------------------------------------------------------
// Playlists — mirrors the playlist section of `src-tauri/src/library.rs`
// ---------------------------------------------------------------------------

export interface Playlist {
  id: number;
  name: string;
  createdAt: string;
  itemCount: number;
  seconds: number;
}

/** A track in a playlist. The Rust side flattens `Track` into this. */
export interface PlaylistItem extends Track {
  /** `playlist_items.id` — what remove and reorder take, *not* the track id. */
  itemId: number;
  position: number;
  addedAt: string;
}

// ---------------------------------------------------------------------------
// YouTube import — mirrors `src-tauri/src/youtube.rs`
// ---------------------------------------------------------------------------

export interface YtTools {
  ytdlpPath: string | null;
  ffmpegPath: string | null;
  version: string | null;
  /** Non-null when importing cannot work at all; shown instead of the form. */
  blocker: string | null;
  tracksDir: string;
}

export type JobPhase = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";

export interface DownloadJob {
  id: number;
  url: string;
  label: string;
  phase: JobPhase;
  percent: number;
  detail: string;
  playlistId: number | null;
  wholePlaylist: boolean;
  /** Chosen download folder, or null for the library's own `tracks/`. */
  destination: string | null;
  added: number;
  skipped: number;
  failed: number;
  trackIds: number[];
}

/** A job nobody is waiting on any more. */
export function isSettled(job: DownloadJob): boolean {
  return job.phase !== "queued" && job.phase !== "running";
}

export interface ImportLine {
  input: string;
  accepted: boolean;
  reason: string;
  jobId: number | null;
}

export interface ImportReport {
  lines: ImportLine[];
  queued: number;
  rejected: number;
  duplicates: number;
}

export const EMPTY_TOOLS: YtTools = {
  ytdlpPath: null,
  ffmpegPath: null,
  version: null,
  blocker: "not running inside the desktop shell",
  tracksDir: "",
};

export interface GenreCount {
  genre: string;
  count: number;
}

export interface Stats {
  /** False when no `library.db` exists yet. */
  available: boolean;
  libraryPath: string;
  pending: number;
  generating: number;
  ready: number;
  failed: number;
  total: number;
  playableSeconds: number;
  genres: GenreCount[];
}

export const EMPTY_STATS: Stats = {
  available: false,
  libraryPath: "",
  pending: 0,
  generating: 0,
  ready: 0,
  failed: 0,
  total: 0,
  playableSeconds: 0,
  genres: [],
};

// ---------------------------------------------------------------------------
// Generator — mirrors `src-tauri/src/engine.rs`
// ---------------------------------------------------------------------------

/** `starting` means we spawned the server and it is still loading weights. */
export type EngineState = "offline" | "starting" | "online";

export interface EngineStatus {
  state: EngineState;
  /** True when this app owns the server process, i.e. Stop can work. */
  supervised: boolean;
  detail: string;
  /** Non-null when generation is impossible at all (no venv, no scripts). */
  blocker: string | null;
  apiUrl: string;
  scriptPath: string;
  pythonPath: string;
  generatorPath: string;
}

export type RunPhase =
  | "idle"
  | "planning"
  | "running"
  | "cancelling"
  | "done"
  | "cancelled"
  | "failed";

export interface GenerationProgress {
  phase: RunPhase;
  running: boolean;
  /** Prompts finished. */
  current: number;
  /** Prompts planned; 0 until the generator announces the number. */
  total: number;
  ok: number;
  failed: number;
  genre: string | null;
  bpm: number | null;
  etaSeconds: number | null;
  elapsedSeconds: number;
  line: string;
  target: string | null;
  message: string | null;
  exitCode: number | null;
}

/** Mirrors the mutually exclusive flags of `engine/generate.py`. */
export type GenTarget =
  | { kind: "tracks"; value: number }
  | { kind: "hours"; value: number }
  | { kind: "resume" };

export interface LogLine {
  line: string;
  stderr: boolean;
}

/** Mirrors `src-tauri/src/desktop.rs`. */
export interface MediaKeys {
  /** Keys another application already owns; the tray menu still works. */
  unclaimed: string[];
  /** Native Wayland session — the X11 grab only fires for X11 clients. */
  wayland: boolean;
}

export const OFFLINE_ENGINE: EngineStatus = {
  state: "offline",
  supervised: false,
  detail: "not running",
  blocker: null,
  apiUrl: "http://127.0.0.1:8001",
  scriptPath: "",
  pythonPath: "",
  generatorPath: "",
};

export const IDLE_RUN: GenerationProgress = {
  phase: "idle",
  running: false,
  current: 0,
  total: 0,
  ok: 0,
  failed: 0,
  genre: null,
  bpm: null,
  etaSeconds: null,
  elapsedSeconds: 0,
  line: "",
  target: null,
  message: null,
  exitCode: null,
};

/** Where `curation_export` put the files it wrote. */
export interface CurationExport {
  dir: string;
  libraryFile: string;
  promptFile: string;
  planFile: string;
  tracks: number;
}

/**
 * What applying a plan did.
 *
 * Every field is reported rather than assumed: a plan is written elsewhere, by
 * something this app cannot check, so "it worked" is not a useful answer.
 */
export interface CurationReport {
  created: string[];
  appended: string[];
  added: number;
  alreadyIn: number;
  unknownIds: number;
  errors: string[];
}
