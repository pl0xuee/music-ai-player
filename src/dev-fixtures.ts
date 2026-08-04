import type { DownloadJob, GenStyle, Playlist, Stats, Track } from "./types";

/**
 * Which surface to open on load, from the URL hash — `#generate`, `#import`,
 * `#playlists`.
 *
 * Only consulted outside the Tauri shell. Drawers are the half of the
 * interface that cannot be reviewed by loading a page, and reaching them
 * through a hash is the difference between checking their layout in a second
 * and not checking it at all.
 */
export function devPanel(): string {
  if (typeof window === "undefined") return "";
  return window.location.hash.replace("#", "");
}

/**
 * A queue covering every job state, so the import drawer can be reviewed in
 * the states that matter — a failure with its retry, a run in progress, and a
 * finished one — rather than only in the empty state.
 */
export function devJobs(): DownloadJob[] {
  const base = {
    playlistId: null,
    wholePlaylist: false,
    destination: null,
    added: 0,
    skipped: 0,
    failed: 0,
    trackIds: [],
  };
  return [
    {
      ...base,
      id: 1,
      url: "https://youtu.be/aaaaaaaaaaa",
      label: "Nocturne for Empty Offices",
      phase: "done",
      percent: 100,
      detail: "added 1 track",
      added: 1,
    },
    {
      ...base,
      id: 2,
      url: "https://youtu.be/bbbbbbbbbbb",
      label: "Deep Focus — 3 Hour Mix",
      phase: "running",
      percent: 42.7,
      detail: "downloading 42.7% of 214MiB at 5.1MiB/s",
    },
    {
      ...base,
      id: 3,
      url: "https://youtu.be/ccccccccccc",
      label: "Signal Decay (Extended)",
      phase: "failed",
      percent: 0,
      detail: "Postprocessing: module mutagen was not found",
      failed: 1,
    },
  ];
}

/** Seconds of audio the stand-in source carries. Matches the fixture rows. */
const DEV_SECONDS = 30;

let cachedSource: string | null = null;

/**
 * A real, playable source for the browser: a quiet two-tone drone as a `data:`
 * WAV.
 *
 * Without this the decks outside the shell have nothing to load, `play()`
 * rejects, and every part of the interface that only exists during playback —
 * the scrub, the crossfade, the spectrum — cannot be looked at at all. 4 kHz
 * 8-bit mono is inaudibly bad and about 120 kB, which is the right trade for
 * something that never ships.
 */
export function devSourceUrl(): string {
  if (cachedSource !== null) return cachedSource;

  const rate = 4000;
  const count = rate * DEV_SECONDS;
  const bytes = new Uint8Array(44 + count);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + count, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits
  ascii(36, "data");
  view.setUint32(40, count, true);

  for (let i = 0; i < count; i += 1) {
    const t = i / rate;
    // Two tones plus a slow pulse, so the spectrum has more than one column and
    // the kick detector has an onset to find.
    const wave =
      Math.sin(2 * Math.PI * 110 * t) * 0.5 +
      Math.sin(2 * Math.PI * 440 * t) * 0.25 +
      Math.sin(2 * Math.PI * 55 * t) * Math.max(0, 1 - ((t * 2) % 1)) * 0.5;
    bytes[44 + i] = Math.max(0, Math.min(255, Math.round(128 + wave * 60)));
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  cachedSource = `data:audio/wav;base64,${btoa(binary)}`;
  return cachedSource;
}

/**
 * A stand-in library for `npm run dev` opened in a plain browser.
 *
 * `api.ts` has always degraded to empty results outside the Tauri shell so the
 * UI stays developable without the window. Empty is the one state that cannot
 * be designed against, though, so outside the shell it degrades to *this*
 * instead: three rows, one from each source, which is enough to exercise every
 * branch the library list and the stage have.
 *
 * Never reached inside the app — `IN_TAURI` is true there, in dev and in a
 * bundled build alike.
 */
// Durations match the stand-in source, so the crossfade triggers where the
// interface says it will.
const TITLES: [string, string, number, number][] = [
  ["Subroutine 78", "dark techno", 128, 30],
  ["Dormant Protocol", "dark techno", 124, 30],
  ["Night Shift Assembly", "ambient techno", 118, 30],
  ["Cold Boot Sequence", "dark techno", 132, 30],
  ["\ud83d\udd34 PROTOCOL: RED CORE \u26a1 Dark Hacker Music for Coding & Focus 2026", "ambient techno", 96, 30],
  ["Kernel Panic Lullaby", "dark techno", 140, 30],
];

export function devTracks(): Track[] {
  return TITLES.map(([title, genre, bpm, duration], i) => {
    const source = i % 3 === 1 ? "youtube" : i % 3 === 2 ? "local" : "generated";
    return {
      id: i + 1,
      title,
      genre: source === "generated" ? genre : source === "youtube" ? "youtube" : "Electronic",
      bpm: source === "generated" ? bpm : 0,
      keyScale: source === "generated" ? (i % 2 === 0 ? "a:min" : "d:min") : "",
      prompt:
        source === "generated"
          ? "dark techno, industrial, driving, hypnotic, analogue hardware, no vocals"
          : "",
      duration,
      path: `/library/${i + 1}.mp3`,
      createdAt: "2026-08-01T12:00:00+00:00",
      playCount: i * 3,
      lastPlayed: null,
      rating: i === 2 ? 1 : 0,
      source,
      videoId: source === "youtube" ? "dQw4w9WgXcQ" : null,
      url: null,
      uploader:
        source === "youtube" ? "VIBE MOTORS" : source === "local" ? "Nils Frahm" : null,
    };
  });
}

export function devStats(): Stats {
  const tracks = devTracks();
  return {
    available: true,
    libraryPath: "/library/library.db",
    ready: tracks.length,
    pending: 0,
    generating: 0,
    failed: 0,
    total: tracks.length,
    playableSeconds: tracks.reduce((total, t) => total + (t.duration ?? 0), 0),
    genres: [
      { genre: "dark techno", count: 3 },
      { genre: "ambient techno", count: 2 },
      { genre: "Electronic", count: 1 },
    ],
  };
}

/** The styles the real prompt bank carries, for reviewing the picker. */
export const DEV_STYLES: GenStyle[] = [
  { name: "cyberpunk techno", share: 42, bpm: [80, 100] },
  { name: "tech-noir darksynth", share: 28, bpm: [76, 96] },
  { name: "industrial cyberpunk", share: 20, bpm: [82, 100] },
  { name: "deep cyberpunk", share: 10, bpm: [74, 88] },
];

/**
 * A few playlists, so the add-to-playlist menu on a library row can be reviewed
 * with something in it.
 *
 * Names of realistic length on purpose: the menu has to truncate a long one
 * without pushing the count off the end, and a list of short names would never
 * show whether it does.
 */
export function devPlaylists(): Playlist[] {
  return [
    { id: 1, name: "Deep focus", createdAt: "2026-07-02T09:00:00Z", itemCount: 24, seconds: 7_800 },
    { id: 2, name: "Late shift", createdAt: "2026-07-14T22:10:00Z", itemCount: 8, seconds: 2_400 },
    {
      id: 3,
      name: "Rainy night city — long mixes",
      createdAt: "2026-07-28T18:30:00Z",
      itemCount: 131,
      seconds: 41_000,
    },
  ];
}
