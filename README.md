# Music AI Player

A local desktop music player for long coding sessions — dark, tech-noir,
instrumental, endless-feeling. It is a Tauri app with a SQLite library, an
8-second equal-power crossfade between two decks, a shuffle bag that plays the
whole library before it repeats anything, playlists, and a reactive visualizer.

Three things can fill the library: an **ACE-Step generator** that renders original
music on the local GPU, a **YouTube importer** built on `yt-dlp`, and a **folder
scan** that adopts audio already on the machine. The first two write files into
the library directory; the third leaves them where they are and only records
where to find them. All three write rows into the same database, so once a track
is in the library nothing downstream cares where it came from.

```
  engine/    ──generate──▶  library/library.db  ──▶  Tauri app
  yt-dlp     ──import────▶  library/tracks/*.mp3     (always, no GPU)
```

The player has **zero runtime dependency** on the AI engine. It starts
instantly, works offline, and uses no GPU while you work.

---

## Prerequisites

Split by what each one is actually for. You only need the group for the path you
intend to use.

**The app** (required either way)

```bash
sudo pacman -S --needed rust nodejs npm webkit2gtk-4.1
```

**YouTube import**

```bash
sudo pacman -S --needed yt-dlp ffmpeg
```

**Local generation** (AMD GPU, ROCm)

```bash
sudo pacman -S --needed uv rocminfo rocm-smi-lib xdotool
```

The full `rocm-hip-sdk` is **not** required. PyTorch's ROCm wheels bundle their
own ROCm runtime; `rocminfo` and `rocm-smi-lib` are only there for GPU detection
and VRAM monitoring. Escalate to the full SDK only if `engine/setup.sh` fails its
GPU check.

Built for and verified on: **AMD Radeon RX 9070 XT** (RDNA4 / gfx1201, 16 GB),
CachyOS, ROCm 7.2, Python 3.11 via `uv`.

---

## Running the app

```bash
npm install
npm run tauri dev          # development
npm run tauri build        # bundled binary
```

It opens with an empty library and says so. Fill it using either path below.

The library is discovered at runtime: `MUSIC_AI_LIBRARY` if set (a directory, or
a path to a `.db` file), otherwise the first `library/library.db` found walking
up from the working directory, otherwise `./library/library.db`. Audio lives in
`tracks/` next to the database.

What the shell gives you beyond the window: a tray icon with Play/Pause, Next,
Show/Hide and Quit; close-to-tray (the tray's Quit is the only real exit); and
global media keys (`XF86AudioPlay` / `Next` / `Prev`) where the session lets them
be claimed.

---

## Path 1 — import from YouTube

The reliable way to get music you actually like into the library.

Open the **Import** panel and paste URLs — one per line, or a whole messy block;
every recognisable link on a line is picked out and the rest is reported back
with a reason.

Accepted: `watch?v=`, `youtu.be/…`, `/shorts/`, `/live/`, `/embed/`, a bare
11-character video ID, and playlist links (capped at 200 entries per paste).
Not accepted: channel URLs, search terms, plain text.

What happens per item:

- `yt-dlp -f bestaudio/best -x --audio-format best`, which keeps the stream
  YouTube actually served — usually Opus around 160 kbps — instead of re-encoding
  it to mp3. Transcoding only ever subtracts, and the file is roughly half the
  size for the same audio.
- No cover art is embedded. Writing it into Opus or M4A needs the `mutagen`
  Python module, and a missing one fails the whole postprocessing step, so the
  file lands but the importer is never told where. Nothing here shows artwork.
- Lands in `library/tracks/` as `<video-id>-<title>.<ext>`; the extension follows
  the source codec, and the media server maps each one to its own content type.
- A row is inserted with `source = 'youtube'`, `genre = 'youtube'`, the real
  duration measured by `ffprobe`, plus `video_id`, `url` and `uploader`.
- Duration matters: the crossfade schedule is computed from it, which is why it
  is measured from the written file rather than trusted from the video metadata.

Downloads run **one at a time** — two concurrent transcodes saturate the disk for
no wall-clock gain, and a single slot makes "cancel" unambiguous. Partial files
live in `library/tracks/.incoming/` and are wiped before each job, after each
job, and on quit, so a cancelled download never leaves a half-written mp3 beside
real ones.

Re-importing a video you already have is detected before `yt-dlp` is even
spawned, and a unique index on `video_id` enforces it at the storage layer.

The queue is in memory only. Pending items are lost on quit; already-imported
tracks are not.

---

## Path 2 — generate locally with ACE-Step

One-time setup (~15 GB: Python 3.11, the ACE-Step checkout, torch-rocm):

```bash
./engine/setup.sh
```

It verifies the GPU with a real matmul at the end and prints a wheel fallback
ladder if anything fails.

Then either use the **Generate** panel in the app — which starts the engine,
streams progress, and stops it again — or drive it from a terminal:

```bash
./engine/start-api.sh                  # terminal 1 — leave running
```

```bash
./engine/generate.py --tracks 10       # a sample — LISTEN before the big run
./engine/generate.py --hours 24        # the full library (~432 tracks)
./engine/generate.py --status          # what's in the library
./engine/generate.py --resume          # continue after an interruption

# Restrict a run to one or more styles from the prompt bank. Repeatable; an
# unknown name is refused rather than silently ignored. The Generate drawer
# offers the same choice as chips.
./engine/generate.py --tracks 10 --genre "deep cyberpunk"
```

The first `start-api.sh` downloads ~4 GB of model weights and takes a while.
Ctrl-C during a run is safe: the in-flight row returns to `pending` and
`--resume` picks it up. Everything already downloaded is kept. The app's Cancel
button sends the same SIGINT for the same reason.

Stop the engine when you are done generating; the player does not need it, and
it holds ~13 GB of VRAM while resident.

### Sizing

| | |
|---|---|
| Track length | 200 s (3:20) |
| 24 h of music | ~432 tracks |
| Time to generate | ~54 s per track, so ~6.5 h — an overnight run |
| Disk | ~3.2 MB per track, ~1.4 GB for the full library |

`--batch-size` is the lever to shorten a run, but note what it does: it produces
N variations of the *same* prompt, not N different tracks. It trades library
diversity for speed. Start at 1.

### Audio format

**mp3, not opus.** `opus` cannot be written on this install: torchaudio 2.10
dropped its own encoders and delegates to torchcodec, which is not present, and
the soundfile fallback does not recognise OPUS as a container. The render
succeeds, the file write fails silently, and the task reports success with an
empty path — so you download nothing. `aac` fails the same way and `ogg` is
silently downgraded to flac.

mp3 at 128 kbps lands the full library in the same ballpark opus would have, so
nothing was lost. `flac` also works if you want lossless (~8.7 MB per track).

---

## Tuning the sound

Everything that decides what the generated library sounds like lives in **one
file: `engine/prompts.toml`** — the genre definitions and their weights, BPM
ranges, mood/atmosphere/production fragment pools, key weighting, and the
title word bank.

Captions are assembled as **prose, not tag lists**. ACE-Step was trained on
descriptive paragraphs; a comma-separated tag list is out-of-distribution and
produces incoherent output. Fragments in the bank must be grammatical standalone
sentences, because they are concatenated verbatim.

`lyrics` is always empty — that is what makes the output instrumental. Do not
populate it.

### Check the result with measurements, not ears

```bash
./engine/analyze.py <reference-audio> [<dir-or-file> ...]
```

`engine/analyze.py` measures a reference track you are aiming at, then measures
your output against it, and prints the **per-octave delta in dB** plus the three
biggest gaps — along with spectral centroid, 85% rolloff, flatness, percussive
fraction, crest factor, stereo width and tempo candidates.

```bash
./engine/analyze.py ~/Music/reference.mp3 library/tracks
```

This is the difference between tuning and guessing. Judging by ear across a
432-track library does not work; a number that says "62 Hz is 5.9 dB too loud"
does. It is how the corrective mastering chain in `generate.py`
(`MASTER_CHAIN`) was derived, and it is how you check that a change to
`prompts.toml` did what you wanted.

It needs `ffmpeg`, `ffprobe` and numpy. If your system `python3` has no numpy it
re-execs itself under the engine venv
(`engine/ACE-Step-1.5/venv_rocm/bin/python`) automatically.

Read the docstring before adding a metric — it records one that was removed for
being actively misleading, and why it must not come back.

---

## State of things

The **app is complete and verified**: playback, crossfade, shuffle, playlists,
ratings, the visualizer, the tray, media keys, the YouTube importer and the
generation panel all work.

The **generated music was never dialled in** to a standard the author was happy
with. Several rounds of prompt restructuring and a measured corrective mastering
chain closed most of the spectral gap against the reference, but the result
still is not the thing it was aiming at. **YouTube import is the reliable path
to music you actually want to hear.** Generation is worth keeping and worth
more tuning; it is not the reason to use this yet.

---

## Layout

```
engine/
  setup.sh          one-time environment setup
  start-api.sh      launches the ACE-Step REST API (RDNA4-corrected)
  generate.py       batch library generator — writes audio + library.db
  analyze.py        measure output against a reference track
  prompts.toml      ← the file you tune
  smoke-test.sh     one-track API check (see the note below)
  NOTES.md          RDNA4 gotchas, env vars, API contract, benchmarks
library/            library.db + tracks/*.mp3 (gitignored)
src/                React frontend — player, visualizer, panels
src-tauri/src/
  library.rs        SQLite: tracks, playlists, migration
  youtube.rs        yt-dlp import: parsing, queue, progress, cancel
  engine.rs         ACE-Step supervision + generation runs
  desktop.rs        tray, media keys, close-to-tray
  proc.rs           process-group teardown shared by both subsystems
```

**Read `engine/NOTES.md` before touching `start-api.sh`.** The vendored
`start_api_server_rocm.sh` is written for RDNA3 and sets an
`HSA_OVERRIDE_GFX_VERSION` that is wrong for this GPU.

Environment overrides, all optional: `MUSIC_AI_LIBRARY` (database location),
`MUSIC_AI_ENGINE` (engine directory), `MUSIC_AI_YTDLP` (path to a specific
`yt-dlp` binary).

---

## Troubleshooting

**GLib dependency security alert (RUSTSEC-2024-0429)** — the app uses a checked-in
copy of glib 0.18.5 with the upstream iterator safety fix backported, because
Tauri's GTK stack still requires the 0.18 bindings. See
[the backport notes](src-tauri/vendor/README.md) for provenance, tests and the
conditions for removing it. Existing installed builds need an updated release
to receive this fix.

**A YouTube import fails with a bare exit status and no detail** — `yt-dlp` is
out of date. It breaks periodically as YouTube changes; this is normal and
expected maintenance, not a bug in the app.

```bash
sudo pacman -Syu yt-dlp
```

Detection re-runs on every status call, so you do not need to restart the player
after updating. The Import panel shows the version it is actually using.

**A specific video fails with a real message** — messages like
`Video unavailable`, `Private video. Sign in if you've been granted access` or
`Video is not available in your country` come straight from `yt-dlp` and mean
what they say. No cookie flags are passed, so age-restricted, members-only and
private videos will always fail.

**The engine will not start / generation is unavailable** — the panel says which
of the three it is: `generate.py` missing, the venv missing (run
`engine/setup.sh` once), or `start-api.sh` missing. It re-checks on every poll,
so fixing it is noticed without a restart.

**Generation needs ~13 GB of VRAM.** Nothing else GPU-heavy can be running
alongside it. If the app finds a server already answering on 127.0.0.1:8001 it
adopts it rather than starting a second one and fighting over the VRAM.

**Server starts, then the first request hangs for minutes** — `MIOPEN_FIND_MODE`
is not set to `FAST`. By far the most likely cause. `start-api.sh` sets it; a
hand-rolled launch may not.

**Out of memory during a batch** — lower `--batch-size`, confirm
`PYTORCH_HIP_ALLOC_CONF=expandable_segments:True`, and check no leftover engine
process is still holding VRAM (`ps aux | grep api_server`).

**`torch.cuda.is_available()` is False** — walk the wheel ladder in
`engine/NOTES.md`, confirm `rocminfo | grep gfx1201`, and check the user is in
the `render` and `video` groups.

**Media keys do nothing** — on a native Wayland session the grab goes through
XWayland, so it only fires while an X11 client has focus. Registration still
succeeds, which is why the app cannot simply report failure; it warns instead.
Some desktops (GNOME's own media handler, another player that registered first)
also claim the keys before the app can. The tray menu always works.

**`engine/smoke-test.sh` fails to download** — it still requests
`"audio_format": "opus"`, which cannot be written on this install (see above), so
it dies at the download step. Use `./engine/generate.py --tracks 1` as the
end-to-end check instead.

---

## Licence

This project is MIT-licensed — see [LICENSE](LICENSE). Use it, change it, ship
it; keep the copyright notice.

The rest of this section is about the *audio*, which the licence above does not
speak to.

ACE-Step 1.5 is MIT-licensed and runs entirely locally; generated audio is
yours. No API keys, no per-track cost, no network needed after setup.

Imported audio is subject to whatever terms apply to its source. The importer is
for material you have the right to keep a local copy of.
