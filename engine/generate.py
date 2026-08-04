#!/usr/bin/env python3
"""
Batch-generate the Music AI Player library with ACE-Step 1.5.

Reads the tag bank from prompts.toml, plans a genre-balanced run, and drives the
ACE-Step REST API until the library is full. Writes both the audio files and the
SQLite database that the player reads.

    ./engine/generate.py --tracks 10        # Phase 1 sample — LISTEN BEFORE THE BIG RUN
    ./engine/generate.py --hours 24         # the full library (~432 tracks)
    ./engine/generate.py --resume           # pick up an interrupted run
    ./engine/generate.py --status           # what's in the library right now

Interrupting with Ctrl-C is safe: in-flight rows are returned to `pending` and
--resume continues from there. Everything already downloaded is kept.

Requires the API to be running:  ./engine/start-api.sh
"""

from __future__ import annotations

import argparse
import json
import math
import random
import signal
import sqlite3
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = ENGINE_DIR.parent
DEFAULT_DB = PROJECT_DIR / "library" / "library.db"
DEFAULT_OUT = PROJECT_DIR / "library" / "tracks"
BANK_PATH = ENGINE_DIR / "prompts.toml"

API = "http://127.0.0.1:8001"
POLL_INTERVAL = 3.0
POLL_TIMEOUT = 1800  # 30 min per task; a stuck task shouldn't wedge the run

# opus and aac CANNOT be written on this install (see submit() for why), and
# ogg is silently downgraded to flac. mp3 and flac are the real options.
AUDIO_FORMAT = "mp3"

# Set by the SIGINT handler so the main loop can unwind cleanly.
_INTERRUPTED = False


# ------------------------------------------------------------------------------
# Terminal niceties
# ------------------------------------------------------------------------------
class C:
    G = "\033[1;32m"
    Y = "\033[1;33m"
    R = "\033[1;31m"
    B = "\033[1m"
    D = "\033[2m"
    X = "\033[0m"


def say(msg: str) -> None:
    print(f"\n{C.G}==>{C.X} {C.B}{msg}{C.X}", flush=True)


def warn(msg: str) -> None:
    print(f"{C.Y}[warn]{C.X} {msg}", flush=True)


def die(msg: str) -> None:
    print(f"\n{C.R}[error]{C.X} {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def fmt_hms(seconds: float) -> str:
    seconds = int(max(0, seconds))
    h, m, s = seconds // 3600, (seconds % 3600) // 60, seconds % 60
    return f"{h}h{m:02d}m" if h else (f"{m}m{s:02d}s" if m else f"{s}s")


# ------------------------------------------------------------------------------
# HTTP — stdlib only, so this runs under any Python 3.11+ without extra deps
# ------------------------------------------------------------------------------
def post(path: str, payload: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def api_alive() -> bool:
    try:
        with urllib.request.urlopen(f"{API}/docs", timeout=10):
            return True
    except Exception:
        return False


def find_audio_urls(obj) -> list[str]:
    """Collect audio URLs from a task result.

    `result` arrives as a JSON-encoded *string* containing an array with one
    element per rendered audio (so batch_size N yields N entries). Each carries
    a `file` field that is already a percent-encoded relative URL, e.g.
    "/v1/audio?path=%2Fhome%2F...mp3" — append it to the base URL as-is; do not
    re-encode. `wave` is a dead legacy field and is always "".
    """
    urls: list[str] = []

    def walk(o):
        if isinstance(o, dict):
            f = o.get("file")
            if isinstance(f, str) and f.strip():
                urls.append(f)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(obj)
    return list(dict.fromkeys(urls))


# Corrective mastering chain, derived by MEASURING the reference against our
# output (scratchpad/analyze2.py) rather than by ear:
#
#   octave gap before:  31Hz -5.7dB   62Hz +6.5dB   4kHz +5.4dB   8kHz +5.2dB
#   octave gap after:   31Hz -3.1dB   62Hz +3.9dB   4kHz +2.8dB   8kHz +3.2dB
#   centroid  2018 -> 1708 Hz  (reference 1652)
#   flatness 0.423 -> 0.376    (reference 0.364)
#
# The model's bass peaks an octave too high (62 Hz vs the reference's 31 Hz) and
# it runs too bright. Asking for "infrasonic sub-bass" in the caption is
# unreliable; correcting the spectrum afterwards is not.
MASTER_CHAIN = (
    "equalizer=f=31:t=o:w=1.2:g=6,"      # lift the true sub the model under-delivers
    "equalizer=f=62:t=o:w=1.0:g=-6.5,"   # pull down the octave it over-delivers
    "equalizer=f=125:t=o:w=1.0:g=-2.5,"
    "equalizer=f=4000:t=o:w=1.2:g=-5.5,"  # darken -- reference rolls off hard
    "equalizer=f=9000:t=o:w=1.5:g=-5,"
    "acompressor=threshold=0.05:ratio=4:attack=20:release=250,"  # crest 14.5 -> ~10 dB
    "alimiter=limit=0.95"
)


def master(src: Path) -> bool:
    """Apply the corrective chain in place. Returns False if ffmpeg fails."""
    tmp = src.with_suffix(".mastering.mp3")
    try:
        r = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(src), "-af", MASTER_CHAIN,
             "-b:a", "128k", "-y", str(tmp)],
            capture_output=True, timeout=300)
    except Exception as e:
        warn(f"mastering failed for {src.name}: {e}")
        tmp.unlink(missing_ok=True)
        return False
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        warn(f"mastering failed for {src.name}: {r.stderr.decode()[:160]}")
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(src)
    return True


def download(file_url: str, dest: Path) -> bool:
    url = f"{API}{file_url}" if file_url.startswith("/") else file_url
    try:
        with urllib.request.urlopen(url, timeout=300) as r:
            data = r.read()
    except Exception as e:
        warn(f"download failed for {file_url[:80]}: {e}")
        return False
    if not data:
        warn(f"empty download for {file_url[:80]}")
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return True


# ------------------------------------------------------------------------------
# Prompt bank
# ------------------------------------------------------------------------------
@dataclass
class Plan:
    title: str
    genre: str
    bpm: int
    key_scale: str
    prompt: str


class Bank:
    def __init__(self, path: Path, only: list[str] | None = None):
        if not path.exists():
            die(f"prompt bank not found: {path}")
        with path.open("rb") as f:
            self.raw = tomllib.load(f)

        self.defaults = self.raw.get("defaults", {})
        self.genres = self.raw.get("genre", [])
        self.mods = self.raw.get("modifiers", {})
        self.titles = self.raw.get("titles", {})
        keys = self.raw.get("key", [])

        if not self.genres:
            die("prompt bank has no [[genre]] entries")

        # Restrict the run to the named styles, if any were asked for. Matching
        # is case-insensitive because these names come from a UI, and an
        # unknown one is fatal rather than silently ignored: a run that quietly
        # used every genre after being told to use one would be discovered only
        # after an hour of GPU time.
        if only:
            wanted = {name.strip().lower() for name in only if name.strip()}
            known = {g["name"].lower(): g["name"] for g in self.genres}
            missing = sorted(wanted - known.keys())
            if missing:
                die(
                    f"unknown genre(s): {', '.join(missing)}. "
                    f"Available: {', '.join(sorted(known.values()))}"
                )
            self.genres = [g for g in self.genres if g["name"].lower() in wanted]

        self.key_names = [k["name"] for k in keys] or ["A Minor"]
        self.key_weights = [k.get("weight", 1) for k in keys] or [1]

    def pick_genre_quota(self, n_prompts: int) -> list[dict]:
        """Deterministic genre quotas, then shuffled.

        Sampling randomly per-track would let a run drift to 60% hardstyle by
        luck. Quotas guarantee the library is balanced the way the bank says.
        """
        weights = [g.get("weight", 1) for g in self.genres]
        total = sum(weights)
        counts = [max(1, round(n_prompts * w / total)) for w in weights]

        # Correct rounding drift against the exact target.
        while sum(counts) > n_prompts:
            counts[counts.index(max(counts))] -= 1
        while sum(counts) < n_prompts:
            counts[counts.index(min(counts))] += 1

        out: list[dict] = []
        for genre, count in zip(self.genres, counts):
            out.extend([genre] * count)
        random.shuffle(out)
        return out

    def make_title(self) -> str:
        t = self.titles
        heads = t.get("compound_head") or ["Void"]
        tails = t.get("compound_tail") or ["walker"]
        adjs = t.get("adjective") or ["Hollow"]
        nouns = t.get("noun") or ["Circuit"]

        style = random.random()
        if style < 0.45:
            return random.choice(heads) + random.choice(tails).lower()
        if style < 0.85:
            return f"{random.choice(adjs)} {random.choice(nouns)}"
        return f"{random.choice(nouns)} {random.randint(2, 99):02d}"

    def build(self, genre: dict) -> Plan:
        """Assemble a prose caption in the model's native register.

        ACE-Step was trained on descriptive paragraphs (see
        examples/text2music/), NOT comma-separated tags. A tag list is
        out-of-distribution and yields incoherent output, so we build a
        paragraph from per-genre sentence fragments instead.
        """
        lo, hi = genre.get("bpm", [110, 130])
        bpm = random.randint(lo, hi)

        # Ambient and hardstyle carry their own mood pools — the shared one is
        # too combative for one and too bleak-generic for the other.
        moods = genre.get("mood_override") or self.mods.get("mood", [])
        picked = random.sample(moods, min(2, len(moods))) if moods else []
        mood_str = ", ".join(picked)

        phrase = random.choice(genre["genre_phrase"])
        lead = f"{mood_str} {phrase}" if mood_str else phrase
        article = "An" if lead[:1].lower() in "aeiou" else "A"

        caption = " ".join([
            f"{article} {lead} at {bpm} BPM.",
            random.choice(genre["foundation"]),
            random.choice(self.mods["bass"]),
            random.choice(self.mods["atmosphere"]),
            random.choice(genre["mid_layer"]),
            random.choice(genre["development"]),
            f"The production is {random.choice(genre['production'])}.",
            f"The overall mood is {random.choice(self.mods['closing'])}.",
            "Fully instrumental with no vocals.",
        ])

        key = random.choices(self.key_names, weights=self.key_weights, k=1)[0]
        return Plan(
            title=self.make_title(),
            genre=genre["name"],
            bpm=bpm,
            key_scale=key,
            prompt=caption,
        )


# ------------------------------------------------------------------------------
# Library database — shared with the Tauri player
# ------------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    genre       TEXT    NOT NULL,
    bpm         INTEGER NOT NULL,
    key_scale   TEXT    NOT NULL,
    prompt      TEXT    NOT NULL,
    duration    REAL,
    status      TEXT    NOT NULL DEFAULT 'pending',  -- pending|generating|ready|failed
    path        TEXT,
    task_id     TEXT,
    error       TEXT,
    created_at  TEXT    NOT NULL,
    -- player state
    play_count  INTEGER NOT NULL DEFAULT 0,
    last_played TEXT,
    rating      INTEGER NOT NULL DEFAULT 0           -- -1 down, 0 none, 1 up
);
CREATE INDEX IF NOT EXISTS idx_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_genre  ON tracks(genre);
CREATE INDEX IF NOT EXISTS idx_bpm    ON tracks(bpm);
"""


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    # WAL lets the player read while a generation run writes.
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    db.commit()
    return db


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def show_status(db: sqlite3.Connection) -> None:
    rows = db.execute(
        "SELECT status, COUNT(*) n, COALESCE(SUM(duration),0) secs "
        "FROM tracks GROUP BY status"
    ).fetchall()
    if not rows:
        print("\n  Library is empty. Run with --tracks 10 to start.\n")
        return

    say("Library status")
    total_secs = 0.0
    for r in rows:
        extra = f"  ({fmt_hms(r['secs'])})" if r["secs"] else ""
        print(f"  {r['status']:<11} {r['n']:>5}{extra}")
        if r["status"] == "ready":
            total_secs = r["secs"]

    print(f"\n  {C.B}playable: {fmt_hms(total_secs)}{C.X}")

    genres = db.execute(
        "SELECT genre, COUNT(*) n FROM tracks WHERE status='ready' "
        "GROUP BY genre ORDER BY n DESC"
    ).fetchall()
    if genres:
        print("\n  by genre:")
        for g in genres:
            print(f"    {g['genre']:<20} {g['n']:>4}")
    print()


# ------------------------------------------------------------------------------
# Generation
# ------------------------------------------------------------------------------
def submit(plan_row: sqlite3.Row, duration: int, batch: int, model: str) -> str | None:
    payload = {
        "prompt": plan_row["prompt"],
        "lyrics": "",  # EMPTY ⇒ instrumental. The whole vocals decision.
        "audio_duration": duration,
        "bpm": plan_row["bpm"],
        "key_scale": plan_row["key_scale"],
        "time_signature": "4/4",

        # mp3, NOT opus. torchaudio 2.10 delegates encoding to torchcodec,
        # which isn't installed, and the soundfile fallback doesn't know OPUS
        # as a container -- the render succeeds but the file write fails
        # silently and you get an empty path back. mp3 goes through system
        # ffmpeg and lands at ~3.2 MB per 200 s, same ballpark as opus anyway.
        # flac also works if you want lossless (~8.7 MB/track).
        "audio_format": AUDIO_FORMAT,

        # Random seed per track. With a pinned seed the output filename is a
        # deterministic hash of the params, so identical prompts would silently
        # overwrite each other.
        "seed": -1,
        "use_random_seed": True,

        # ---- keep the LM away from our prompt --------------------------------
        # use_cot_caption defaults to TRUE, and the LM's prose *replaces* the
        # caption before DiT conditioning -- "dark techno, hypnotic, analog"
        # became "an energetic progressive trance track...". That silently
        # destroys every bit of genre control in prompts.toml, so it must be
        # off. The others are already false by default; pinned to be explicit.
        "use_cot_caption": False,
        "use_cot_language": False,
        "use_format": False,
        "sample_mode": False,
        "full_analysis_only": False,
        "analysis_only": False,

        # MUST be true. This runs the 5Hz LM to generate ~450 audio semantic
        # codes that condition the diffusion model — the structural scaffold
        # deciding what happens where in the track. With it off the DiT
        # free-runs and the output is incoherent: "nothing goes together".
        # Every example in examples/text2music/ sets "think": true. Costs
        # ~12 s per track; worth every second.
        "thinking": True,

        # Capped at 8 by the model regardless of what we ask for:
        #   "dmd_gan version: infer_steps 30 exceeds maximum 8, clamping to 8"
        # acestep-v15-turbo is a DMD-GAN distillation. Not a tuning knob.
        "inference_steps": 8,
        "guidance_scale": 7.0,
        "model": model,
        "batch_size": batch,
        "task_type": "text2music",
        "vocal_language": "en",
    }
    try:
        r = post("/release_task", payload)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            # Server queue is full (max 200). Back off and let the caller retry.
            warn("queue full (429) — backing off 30s")
            time.sleep(30)
            return None
        warn(f"release_task HTTP {e.code}: {e.read().decode()[:200]}")
        return None
    except Exception as e:
        warn(f"release_task failed: {e}")
        return None

    data = r.get("data") or {}
    return data.get("task_id") or data.get("taskId")


def wait_for(task_id: str) -> tuple[int, list[str]]:
    """Poll until the task settles. Returns (status, audio_paths)."""
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        if _INTERRUPTED:
            return 0, []
        time.sleep(POLL_INTERVAL)
        try:
            r = post("/query_result", {"task_id_list": [task_id]})
        except Exception:
            continue

        rows = r.get("data") or []
        if not rows:
            continue
        row = rows[0]
        status = row.get("status", 0)

        if status == 1:
            result = row.get("result")
            if isinstance(result, str) and result.strip():
                try:
                    result = json.loads(result)
                except json.JSONDecodeError:
                    pass
            return 1, find_audio_urls(result)
        if status == 2:
            return 2, []
    return 0, []


def run(args: argparse.Namespace) -> int:
    db = open_db(Path(args.db))
    out_dir = Path(args.out)
    bank = Bank(BANK_PATH, args.genre)

    duration = args.duration or bank.defaults.get("audio_duration", 200)
    model = args.model or bank.defaults.get("model", "acestep-v15-turbo")

    # ---- decide the work list ------------------------------------------------
    pending = db.execute(
        "SELECT COUNT(*) n FROM tracks WHERE status IN ('pending','generating')"
    ).fetchone()["n"]

    if args.resume:
        if not pending:
            print("\n  Nothing pending — the last run finished. "
                  "Use --tracks N or --hours N to add more.\n")
            return 0
        # A previous run died mid-flight; reclaim those rows.
        db.execute("UPDATE tracks SET status='pending', task_id=NULL "
                   "WHERE status='generating'")
        db.commit()
        say(f"Resuming — {pending} track(s) still to generate")
    else:
        if args.hours:
            n_tracks = math.ceil(args.hours * 3600 / duration)
        else:
            n_tracks = args.tracks

        if pending:
            warn(f"{pending} track(s) already pending from an earlier run.")
            warn("They'll be generated first. Use --resume to do only those.")

        n_prompts = math.ceil(n_tracks / args.batch_size)
        say(f"Planning {n_tracks} track(s) "
            f"= {n_prompts} prompt(s) x batch {args.batch_size}")

        quota = bank.pick_genre_quota(n_prompts)
        with db:
            for genre in quota:
                p = bank.build(genre)
                db.execute(
                    "INSERT INTO tracks (title,genre,bpm,key_scale,prompt,"
                    "status,created_at) VALUES (?,?,?,?,?,'pending',?)",
                    (p.title, p.genre, p.bpm, p.key_scale, p.prompt, now_iso()),
                )

        tally: dict[str, int] = {}
        for g in quota:
            tally[g["name"]] = tally.get(g["name"], 0) + 1
        for name, count in sorted(tally.items(), key=lambda x: -x[1]):
            print(f"    {name:<20} {count:>4} prompt(s)")

    # ---- check the engine ----------------------------------------------------
    if not api_alive():
        die(f"ACE-Step API not responding at {API}\n"
            "  Start it first:  ./engine/start-api.sh\n"
            "  (first run downloads model weights and takes a while)")

    todo = db.execute(
        "SELECT * FROM tracks WHERE status='pending' ORDER BY id"
    ).fetchall()
    if not todo:
        print("\n  Nothing to do.\n")
        return 0

    say(f"Generating {len(todo)} prompt(s) — Ctrl-C is safe")
    print(f"  {C.D}duration={duration}s  batch={args.batch_size}  "
          f"model={model}{C.X}\n")

    started = time.time()
    done = failed = produced = 0

    for i, row in enumerate(todo, 1):
        if _INTERRUPTED:
            break

        label = f"[{i}/{len(todo)}] {row['genre']:<18} {row['bpm']:>3}bpm"
        print(f"  {label}  {C.D}submitting…{C.X}", end="\r", flush=True)

        task_id = submit(row, duration, args.batch_size, model)
        if not task_id:
            db.execute("UPDATE tracks SET status='failed', error='submit failed' "
                       "WHERE id=?", (row["id"],))
            db.commit()
            failed += 1
            print(f"  {label}  {C.R}submit failed{C.X}      ")
            continue

        db.execute("UPDATE tracks SET status='generating', task_id=? WHERE id=?",
                   (task_id, row["id"]))
        db.commit()

        t0 = time.time()
        status, paths = wait_for(task_id)
        took = time.time() - t0

        if _INTERRUPTED:
            db.execute("UPDATE tracks SET status='pending', task_id=NULL "
                       "WHERE id=?", (row["id"],))
            db.commit()
            break

        if status != 1 or not paths:
            db.execute("UPDATE tracks SET status='failed', error=? WHERE id=?",
                       ("generation failed" if status == 2 else "timeout",
                        row["id"]))
            db.commit()
            failed += 1
            print(f"  {label}  {C.R}failed{C.X} after {fmt_hms(took)}        ")
            continue

        # First variation updates this row; extras become sibling rows so a
        # batch_size of N yields N playable tracks.
        saved = 0
        for k, remote in enumerate(paths):
            title = row["title"] if k == 0 else f"{row['title']} {chr(65 + k)}"
            fname = f"{row['id']:05d}{'' if k == 0 else chr(97 + k)}-" \
                    f"{title.lower().replace(' ', '-')}.{AUDIO_FORMAT}"
            dest = out_dir / fname
            if not download(remote, dest):
                continue
            master(dest)   # corrective EQ -- see MASTER_CHAIN for the measurements
            saved += 1
            if k == 0:
                db.execute(
                    "UPDATE tracks SET status='ready', path=?, duration=? "
                    "WHERE id=?", (str(dest), float(duration), row["id"]))
            else:
                db.execute(
                    "INSERT INTO tracks (title,genre,bpm,key_scale,prompt,"
                    "duration,status,path,task_id,created_at) "
                    "VALUES (?,?,?,?,?,?,'ready',?,?,?)",
                    (title, row["genre"], row["bpm"], row["key_scale"],
                     row["prompt"], float(duration), str(dest), task_id,
                     now_iso()))
        db.commit()

        if not saved:
            db.execute("UPDATE tracks SET status='failed', error='download failed' "
                       "WHERE id=?", (row["id"],))
            db.commit()
            failed += 1
            print(f"  {label}  {C.R}download failed{C.X}     ")
            continue

        done += 1
        produced += saved
        rate = (time.time() - started) / i
        eta = rate * (len(todo) - i)
        print(f"  {label}  {C.G}ok{C.X} {saved} track(s) in {fmt_hms(took)}"
              f"  {C.D}eta {fmt_hms(eta)}{C.X}        ")

    # ---- summary -------------------------------------------------------------
    elapsed = time.time() - started
    if _INTERRUPTED:
        say("Interrupted — progress saved")
        print("  Continue with:  ./engine/generate.py --resume")
    else:
        say("Run complete")

    print(f"  prompts ok    {done}")
    print(f"  tracks made   {produced}")
    print(f"  failed        {failed}")
    print(f"  elapsed       {fmt_hms(elapsed)}")
    if produced:
        print(f"  per track     {elapsed / produced:.1f}s")
        print(f"  {C.D}432 tracks would take "
              f"{fmt_hms(elapsed / produced * 432)}{C.X}")
    print()
    show_status(db)
    return 1 if (failed and not done) else 0


# ------------------------------------------------------------------------------
def main() -> int:
    p = argparse.ArgumentParser(
        description="Batch-generate the Music AI Player library.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    g = p.add_mutually_exclusive_group()
    g.add_argument("--tracks", type=int, default=10,
                   help="number of tracks to generate (default: 10)")
    g.add_argument("--hours", type=float,
                   help="generate this many hours of music (24 => ~432 tracks)")
    g.add_argument("--resume", action="store_true",
                   help="continue an interrupted run")
    g.add_argument("--status", action="store_true",
                   help="show library contents and exit")

    p.add_argument("--batch-size", type=int, default=1,
                   help="variations per prompt, 1-8 (default: 1). Higher is "
                        "faster per track but yields same-prompt variations, "
                        "so diversity drops. Set from the Phase 0 benchmark.")
    p.add_argument("--duration", type=int,
                   help="track length in seconds (default: from prompts.toml)")
    p.add_argument("--model", help="override the ACE-Step model")
    p.add_argument("--db", default=str(DEFAULT_DB))
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--seed", type=int, help="seed the planner for reproducibility")
    p.add_argument(
        "--genre",
        action="append",
        metavar="NAME",
        help="restrict the run to this [[genre]] from prompts.toml; repeatable. "
             "Omitted, every genre is used at its configured weight.",
    )

    args = p.parse_args()

    if not 1 <= args.batch_size <= 8:
        die("--batch-size must be between 1 and 8")
    if args.seed is not None:
        random.seed(args.seed)

    if args.status:
        show_status(open_db(Path(args.db)))
        return 0

    def on_sigint(_sig, _frm):
        global _INTERRUPTED
        if _INTERRUPTED:  # second Ctrl-C: bail immediately
            die("force quit")
        _INTERRUPTED = True
        print(f"\n\n  {C.Y}Interrupt received — finishing safely…{C.X}\n",
              flush=True)

    signal.signal(signal.SIGINT, on_sigint)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
