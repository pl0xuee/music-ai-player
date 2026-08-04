# Music AI Player

An endless-feeling player for AI-generated dark techno, hardstyle and adjacent
hard electronic music — in the spirit of a 24/7 "hacker music for coding
sessions" stream, except the music is generated locally on your own GPU.

Music is **batch-generated** into a library, then played back with crossfades
and a reactive visualizer. The player has **zero runtime dependency** on the AI
engine: it starts instantly, works offline, and uses no GPU while you work.

```
  engine/  ──generate──▶  library/  ──play──▶  Tauri app
  (GPU, occasional)       (~1.4 GB)            (always, no GPU)
```

## Requirements

Built for and verified on: **AMD Radeon RX 9070 XT** (RDNA4 / gfx1201),
CachyOS, ROCm 7.2, Python 3.11 via `uv`.

```bash
sudo pacman -S --needed uv rocminfo rocm-smi-lib xdotool
```

The full `rocm-hip-sdk` is **not** required — PyTorch's ROCm wheels bundle their
own runtime.

## Setup

```bash
./engine/setup.sh          # ~15 GB: Python 3.11, ACE-Step, torch-rocm
```

Verifies the GPU with a real matmul at the end, and prints a wheel fallback
ladder if anything fails.

## Generating music

Start the engine (first run downloads ~4 GB of model weights):

```bash
./engine/start-api.sh                  # terminal 1 — leave running
```

Then, in another terminal:

```bash
./engine/smoke-test.sh                 # one track, end to end + benchmark
./engine/generate.py --tracks 10       # sample — LISTEN before the big run
./engine/generate.py --hours 24        # the full library (~432 tracks)
./engine/generate.py --status          # what's in the library
./engine/generate.py --resume          # continue after an interruption
```

Ctrl-C during a run is safe — in-flight work returns to `pending` and
`--resume` picks it up. Everything already downloaded is kept.

Stop the engine when you're done generating; the player doesn't need it.

### Sizing

| | |
|---|---|
| Track length | ~200 s (3:20) |
| 24 h of music | ~432 tracks |
| Disk (opus) | ~1.4 GB |

`--batch-size` (max 4 with the LM enabled on 16 GB) trades diversity for speed:
it produces N variations of the *same* prompt, so higher values generate faster
but make the library more repetitive. Start at 1.

## Tuning what it sounds like

Everything that decides the character of the library lives in one file:
**`engine/prompts.toml`**. Genres and their weights, BPM ranges, mood/texture/
space modifier pools, key weighting, and track-title words.

- too samey → add `signature` entries, widen `bpm`
- not dark enough → trim upbeat moods, shift `weight` to industrial/dark techno
- want more hardstyle → raise its `weight`

Prompts are assembled combinatorially, so the space is far larger than 432
tracks. `lyrics` is always empty — that's what makes output instrumental.

## Layout

```
engine/
  setup.sh          one-time environment setup
  start-api.sh      launches the ACE-Step REST API (RDNA4-corrected)
  smoke-test.sh     Phase 0 gate + batch benchmark
  generate.py       batch library generator
  prompts.toml      ← the file you actually tune
  NOTES.md          RDNA4 gotchas, env vars, API contract, troubleshooting
library/            generated audio + library.db (gitignored)
src/, src-tauri/    the player (in progress)
```

**Read `engine/NOTES.md` before touching `start-api.sh`.** The vendored
`start_api_server_rocm.sh` is written for RDNA3 and sets an
`HSA_OVERRIDE_GFX_VERSION` that is wrong for this GPU.

## Licence note

ACE-Step 1.5 is MIT-licensed and runs entirely locally; generated audio is
yours. No API keys, no per-track cost, no network needed after setup.
