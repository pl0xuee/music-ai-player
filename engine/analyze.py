#!/usr/bin/env python3
"""Measure a reference track, then measure generated tracks against it.

This is the tool that makes tuning `prompts.toml` (and the corrective mastering
chain in `generate.py`) objective instead of a guessing game. It answers one
question: *in what specific way does our output differ from the sound we want?*

    ./engine/analyze.py <reference-audio> [<dir-or-file> ...]

The first argument is the reference — a track whose sound you are aiming at.
Every argument after it is a target: an audio file, or a directory of them
(scanned recursively). Each target group is summarised with the same metrics as
the reference, then printed as a **per-octave delta** plus the three biggest
gaps, which is what you act on.

Example:

    ./engine/analyze.py ~/Music/reference.mp3 library/tracks

Requirements
------------
* `ffmpeg` and `ffprobe` on PATH (already required by the importer).
* `numpy`.

The interpreter that is guaranteed to have numpy on this machine is the engine
venv:

    engine/ACE-Step-1.5/venv_rocm/bin/python engine/analyze.py <ref> <targets>

Running it as `./engine/analyze.py` uses the system `python3`; if that has no
numpy the script re-execs itself under the venv interpreter automatically, and
only gives up (with a message naming the venv path) if that is missing too.

A note on a metric that is deliberately NOT here
------------------------------------------------
An earlier version of this tool reported **raw energy percentage per frequency
band** ("68% of total energy below 60 Hz", etc.). Do not add it back.

That number is dominated by the 1/f spectral tilt that essentially all music
shares: low frequencies carry the overwhelming majority of the energy in any
recording, so two completely different-sounding tracks both come out around
"~88% below 150 Hz" and the metric reports a match. It did exactly that here —
it said our output matched the reference at a point when the two sounded
obviously different, and a wrong conclusion was drawn from it.

Every metric below is either normalised per octave, expressed in dB relative to
this track's own loudest octave, or otherwise scale-free. That is the whole
point: they cancel the shared tilt and only show what actually differs.
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

# ---------------------------------------------------------------------------
# numpy, or a clear explanation of how to get it
# ---------------------------------------------------------------------------
VENV_PYTHON = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "ACE-Step-1.5", "venv_rocm", "bin", "python",
)

try:
    import numpy as np
except ImportError:  # pragma: no cover - environment dependent
    # Re-exec under the engine venv, which definitely has numpy. The guard env
    # var stops an infinite loop if that interpreter somehow lacks it too.
    if not os.environ.get("_ANALYZE_REEXEC") and os.path.exists(VENV_PYTHON):
        os.environ["_ANALYZE_REEXEC"] = "1"
        os.execv(VENV_PYTHON, [VENV_PYTHON, os.path.abspath(__file__)] + sys.argv[1:])
    sys.exit(
        "analyze.py needs numpy.\n"
        f"  Run it with the engine venv interpreter:\n"
        f"    {VENV_PYTHON} {os.path.abspath(__file__)} <reference> <targets...>\n"
        "  Or install it for the interpreter you are using:  pip install numpy"
    )


SR = 22050          # analysis rate; Nyquist 11025 Hz covers every band we use
SEG = 45            # seconds of audio per probe window
REF_PROBES = 6      # probe windows across the reference
TGT_PROBES = 2      # probe windows per target file
MIN_SAMPLES = SR * 5  # a window shorter than this is not worth measuring

AUDIO_EXTS = (".mp3", ".flac", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".webm")


# ---------------------------------------------------------------------------
# Audio I/O — ffmpeg does the decoding, we only ever see raw float samples
# ---------------------------------------------------------------------------
def duration_of(path: str) -> float:
    """Length in seconds, or 0.0 if ffprobe cannot tell."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def load(path: str, start: float, mono: bool = True) -> np.ndarray:
    """Decode `SEG` seconds from `start` as float32 at `SR`.

    Returns a 1-D array when mono, or an (n, 2) array when not. An empty array
    means ffmpeg produced nothing (past the end of the file, or undecodable).
    """
    fd, tmp = tempfile.mkstemp(suffix=".raw")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(SEG),
             "-i", path, "-ac", "1" if mono else "2", "-ar", str(SR),
             "-f", "f32le", "-y", tmp],
            check=True, capture_output=True)
        x = np.fromfile(tmp, dtype=np.float32)
    except subprocess.CalledProcessError:
        return np.zeros(0, dtype=np.float32)
    finally:
        os.unlink(tmp)

    if not mono:
        return x[: len(x) // 2 * 2].reshape(-1, 2)
    return x


def spectrogram(x: np.ndarray, win: int = 2048, hop: int = 512):
    """Magnitude STFT. Returns (frames x bins, bin frequencies, frames/second)."""
    n = 1 + (len(x) - win) // hop
    w = np.hanning(win)
    S = np.empty((n, win // 2 + 1), dtype=np.float32)
    for i in range(n):
        S[i] = np.abs(np.fft.rfft(x[i * hop:i * hop + win] * w))
    return S, np.fft.rfftfreq(win, 1 / SR), SR / hop


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
# Octave bands from 31 Hz up. Levels are reported in dB *relative to this
# track's own loudest octave*, which is what makes them comparable across
# tracks: the shared 1/f tilt sits in the reference level and cancels out of the
# delta. See the module docstring for why the absolute-energy version of this
# was removed and must not come back.
OCT = [(22, 44), (44, 88), (88, 175), (175, 350), (350, 700),
       (700, 1400), (1400, 2800), (2800, 5600), (5600, 11025)]
OCT_NAMES = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k"]


def measure(path: str, start: float) -> dict | None:
    """All metrics for one probe window. None if the window is unusable."""
    x = load(path, start)
    if len(x) < MIN_SAMPLES:
        return None

    S, freqs, fps = spectrogram(x)
    mag = S.mean(axis=0) + 1e-10

    # --- spectral balance -------------------------------------------------
    oct_db = np.array([
        20 * np.log10(mag[(freqs >= lo) & (freqs < hi)].mean() + 1e-10)
        for lo, hi in OCT
    ])
    oct_db -= oct_db.max()          # relative to the loudest octave

    # Brightness. Where the "centre of mass" of the spectrum sits.
    centroid = float((freqs * mag).sum() / mag.sum())
    # 85% rolloff: the frequency below which 85% of the magnitude lives.
    cum = np.cumsum(mag)
    rolloff = float(freqs[np.searchsorted(cum, 0.85 * cum[-1])])
    # Flatness: geometric over arithmetic mean. Low = tonal, high = noisy.
    flatness = float(np.exp(np.log(mag).mean()) / mag.mean())

    # --- rhythm -----------------------------------------------------------
    # Half-wave-rectified spectral flux is the onset envelope; its
    # autocorrelation peaks at the beat period.
    flux = np.diff(S, axis=0)
    flux[flux < 0] = 0
    env = flux.sum(axis=1)
    centred = env - env.mean()
    ac = np.correlate(centred, centred, "full")[len(centred) - 1:]

    # Keep the TWO strongest lags rather than one. Half/double-time ambiguity
    # is real and common; showing both candidates is honest, silently picking
    # one is how you end up chasing a tempo the track does not have.
    lo_lag, hi_lag = int(fps * 60 / 200), int(fps * 60 / 60)   # 60-200 BPM
    seg = ac[lo_lag:hi_lag]
    peaks: list[tuple[int, float]] = []
    if len(seg):
        for i in sorted(np.argsort(seg)[::-1][:40]):
            lag = int(i) + lo_lag
            if all(abs(lag - p) > fps * 0.15 for p, _ in peaks):
                peaks.append((lag, float(seg[i])))
        peaks.sort(key=lambda t: -t[1])
    tempo = [(60 * fps / lag, val / (ac[0] + 1e-9)) for lag, val in peaks[:2]]

    # Percussive fraction: share of frames that are strong onsets. Separates a
    # track with a hard beat from one that merely has energy down low.
    perc = float((env > env.mean() + 2 * env.std()).mean())

    # --- dynamics and space -----------------------------------------------
    rms = float(np.sqrt((x ** 2).mean()))
    peak = float(np.abs(x).max())
    crest = 20 * np.log10(peak / (rms + 1e-12) + 1e-12)

    st = load(path, start, mono=False)
    if len(st):
        mid = (st[:, 0] + st[:, 1]) / 2
        side = (st[:, 0] - st[:, 1]) / 2
        width = float(np.sqrt((side ** 2).mean())
                      / (np.sqrt((mid ** 2).mean()) + 1e-12))
    else:
        width = 0.0

    return dict(oct=oct_db, centroid=centroid, rolloff=rolloff,
                flatness=flatness, tempo=tempo, perc=perc,
                crest=crest, width=width)


def probe_points(dur: float, n: int) -> list[float]:
    """`n` start offsets spread across the body of a file, skipping the edges.

    Intros and outros are unrepresentative — a 20-second fade-in would drag the
    whole measurement dark and quiet.
    """
    if dur <= 0:
        return [0.0]
    usable = max(dur * 0.84 - SEG, 0.0)
    if usable <= 0:
        return [0.0]
    return [float(dur * 0.08 + usable * i / max(n - 1, 1)) for i in range(n)]


def profile(paths: list[str], probes: int) -> list[dict]:
    """Measure every probe window of every file, flattened."""
    out = []
    for p in paths:
        for start in probe_points(duration_of(p), probes):
            m = measure(p, start)
            if m:
                out.append(m)
    return out


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def mean(feats: list[dict], key: str) -> float:
    return float(np.mean([f[key] for f in feats]))


def summarise(name: str, feats: list[dict], n_files: int) -> np.ndarray:
    """Print one block and return the mean per-octave profile."""
    octaves = np.array([f["oct"] for f in feats]).mean(axis=0)

    print(f"\n=== {name} ===")
    print(f"  {n_files} file(s), {len(feats)} probe(s) x {SEG}s")
    print("  octave (dB rel. peak): " +
          " ".join(f"{n}:{v:>6.1f}" for n, v in zip(OCT_NAMES, octaves)))
    print(f"  centroid {mean(feats, 'centroid'):>7.0f} Hz"
          f"   rolloff85 {mean(feats, 'rolloff'):>7.0f} Hz"
          f"   flatness {mean(feats, 'flatness'):.4f}"
          f"   perc {mean(feats, 'perc'):.3f}")
    print(f"  crest    {mean(feats, 'crest'):>7.1f} dB"
          f"   width     {mean(feats, 'width'):>7.2f}"
          f"   ({'wide' if mean(feats, 'width') > 0.3 else 'narrow/centred'})")

    bpms = sorted(round(b) for f in feats for b, _ in f["tempo"])
    print(f"  tempo candidates: {bpms}")
    return octaves


def compare(octaves: np.ndarray, ref_oct: np.ndarray,
            feats: list[dict], ref_feats: list[dict]) -> None:
    """Print the delta block — the part you actually act on."""
    diff = octaves - ref_oct
    print("  DELTA vs ref:          " +
          " ".join(f"{n}:{v:>+6.1f}" for n, v in zip(OCT_NAMES, diff)))

    worst = np.argsort(-np.abs(diff))[:3]
    print("  biggest gaps: " + ", ".join(
        f"{OCT_NAMES[i]}Hz {diff[i]:+.1f}dB "
        f"({'too loud' if diff[i] > 0 else 'too quiet'})"
        for i in worst))

    scalars = [
        ("centroid", "centroid", "{:+.0f} Hz", "brighter", "darker"),
        ("rolloff85", "rolloff", "{:+.0f} Hz", "more top", "less top"),
        ("flatness", "flatness", "{:+.4f}", "noisier", "more tonal"),
        ("perc", "perc", "{:+.3f}", "more percussive", "less percussive"),
        ("crest", "crest", "{:+.1f} dB", "more dynamic", "more compressed"),
        ("width", "width", "{:+.2f}", "wider", "narrower"),
    ]
    parts = []
    for label, key, fmt, hi, lo in scalars:
        d = mean(feats, key) - mean(ref_feats, key)
        parts.append(f"{label} {fmt.format(d)} ({hi if d > 0 else lo})")
    print("  scalar deltas: " + "; ".join(parts[:3]))
    print("                 " + "; ".join(parts[3:]))


def collect(target: str) -> list[str]:
    """Expand a target into a list of audio files."""
    if os.path.isfile(target):
        return [target]
    if os.path.isdir(target):
        found = []
        for root, _dirs, files in os.walk(target):
            found.extend(os.path.join(root, f) for f in files
                         if f.lower().endswith(AUDIO_EXTS))
        return sorted(found)
    # Let the shell-less caller pass a glob.
    return sorted(g for g in glob.glob(target) if g.lower().endswith(AUDIO_EXTS))


def main() -> int:
    p = argparse.ArgumentParser(
        description="Measure generated audio against a reference track.",
        epilog="Example: ./engine/analyze.py ~/Music/reference.mp3 library/tracks")
    p.add_argument("reference", help="the track whose sound you are aiming at")
    p.add_argument("targets", nargs="*",
                   help="audio files or directories to compare against it")
    p.add_argument("--probes", type=int, default=TGT_PROBES,
                   help=f"probe windows per target file (default {TGT_PROBES})")
    p.add_argument("--ref-probes", type=int, default=REF_PROBES,
                   help=f"probe windows across the reference (default {REF_PROBES})")
    args = p.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            return int(bool(sys.stderr.write(
                f"{tool} not found on PATH. Install it:  sudo pacman -S ffmpeg\n")))

    if not os.path.isfile(args.reference):
        sys.stderr.write(f"reference not found: {args.reference}\n")
        return 1

    ref_feats = profile([args.reference], args.ref_probes)
    if not ref_feats:
        sys.stderr.write(f"could not decode any audio from {args.reference}\n")
        return 1
    ref_oct = summarise(f"REFERENCE  {os.path.basename(args.reference)}",
                        ref_feats, 1)

    if not args.targets:
        print("\n  (no targets given — reference measured only)\n")
        return 0

    for target in args.targets:
        files = collect(target)
        if not files:
            print(f"\n=== {target} ===\n  no audio files found")
            continue
        feats = profile(files, args.probes)
        if not feats:
            print(f"\n=== {target} ===\n  nothing decodable")
            continue
        octaves = summarise(os.path.basename(target.rstrip("/")) or target,
                            feats, len(files))
        compare(octaves, ref_oct, feats, ref_feats)

    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
