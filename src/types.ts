/** Where a row came from. Mirrors `SOURCE_*` in `src-tauri/src/library.rs`. */
export type TrackSource = "generated" | "youtube";

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
  /** An import has no tempo, key or prompt; the UI shows the channel instead. */
  source: TrackSource;
  videoId: string | null;
  url: string | null;
  uploader: string | null;
}

/** True for rows imported from YouTube, which carry no tempo or key. */
export function isImported(track: Track): boolean {
  return track.source === "youtube";
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
