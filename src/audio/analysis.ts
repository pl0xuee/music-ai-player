/* ---------------------------------------------------------------------------
   Signal analysis for the visualiser.

   Everything in here is deliberately free of DOM and Web Audio types: it takes
   plain byte arrays and numbers, so the interesting parts (log binning, kick
   onset detection) can be driven headlessly with synthetic FFT frames instead
   of being trusted on sight.
--------------------------------------------------------------------------- */

/** Byte FFT data spans `maxDecibels - minDecibels`; 70 dB is the Web Audio default. */
const DEFAULT_RANGE_DB = 70;

/**
 * How much of a band's value comes from its loudest bin rather than its mean.
 * Pure mean smears a narrow sub-bass peak across a wide high band; pure max
 * makes broadband hiss read as loud as a tone. 0.62 keeps peaks legible while
 * still respecting how much of the band is actually occupied.
 */
const PEAK_WEIGHT = 0.62;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ---------------------------------------------------------------------------
// Logarithmic frequency binning
// ---------------------------------------------------------------------------

export interface LogBandOptions {
  /** `analyser.frequencyBinCount`. */
  binCount: number;
  /** `audioContext.sampleRate`. */
  sampleRate: number;
  /** Number of display columns wanted. */
  count: number;
  /** Left edge of the display, Hz. Below ~30 Hz there is nothing to see. */
  minHz?: number;
  /** Right edge, Hz. Clamped to Nyquist. */
  maxHz?: number;
  /**
   * Gentle shelf above `pivotHz`, in dB per octave. Byte FFT data is already
   * dB-scaled, so a spectrum of dark techno slopes hard to the right and the
   * top half of the display sits dead. A small positive tilt keeps it alive
   * without inventing energy that is not there. Set to 0 for a flat read.
   */
  tiltDbPerOctave?: number;
  pivotHz?: number;
  /** `maxDecibels - minDecibels` of the analyser, used to normalise the tilt. */
  rangeDb?: number;
}

export interface LogBandPlan {
  readonly count: number;
  /** First FFT bin of each band, inclusive. */
  readonly start: Int32Array;
  /** Last FFT bin of each band, exclusive. */
  readonly end: Int32Array;
  /** Per-band tilt, already expressed in normalised 0..1 units. */
  readonly gain: Float32Array;
  /** `count + 1` band edges in Hz. */
  readonly edgeHz: Float32Array;
  readonly hzPerBin: number;
  readonly minHz: number;
  readonly maxHz: number;
}

/**
 * Map FFT bins onto `count` geometrically spaced display columns.
 *
 * A linear axis spends ~90% of its width above 2 kHz, where this library has
 * almost no content, and crushes the entire 30-500 Hz range — the part that
 * carries a dark techno track — into the first two columns. Geometric spacing
 * gives every octave the same number of columns, which is how the ear hears it
 * and how any real analyser is graduated.
 *
 * Low bands legitimately share FFT bins (at 48 kHz / 2048 the resolution is
 * 23.4 Hz, so 30-60 Hz is a single bin). That produces the blocky staircase at
 * the left edge you see on real hardware; it is honest, not a bug.
 */
export function planLogBands(options: LogBandOptions): LogBandPlan {
  const binCount = Math.max(2, Math.floor(options.binCount));
  const nyquist = options.sampleRate / 2;
  const hzPerBin = nyquist / binCount;

  const minHz = Math.max(1, options.minHz ?? 30);
  const maxHz = Math.max(minHz * 2, Math.min(options.maxHz ?? 16000, nyquist));
  const tilt = options.tiltDbPerOctave ?? 1.5;
  const pivotHz = options.pivotHz ?? 500;
  const rangeDb = options.rangeDb ?? DEFAULT_RANGE_DB;

  const count = Math.max(1, Math.floor(options.count));
  const start = new Int32Array(count);
  const end = new Int32Array(count);
  const gain = new Float32Array(count);
  const edgeHz = new Float32Array(count + 1);

  const decades = Math.log(maxHz / minHz);
  for (let i = 0; i <= count; i += 1) edgeHz[i] = minHz * Math.exp((decades * i) / count);

  for (let i = 0; i < count; i += 1) {
    const lo = edgeHz[i] ?? minHz;
    const hi = edgeHz[i + 1] ?? maxHz;
    // Bin 0 is DC plus any rumble below the first bin centre; skipping it keeps
    // a DC offset in a badly mastered file from lighting the whole left edge.
    let a = Math.min(Math.max(Math.floor(lo / hzPerBin), 1), binCount - 1);
    let b = Math.min(Math.max(Math.ceil(hi / hzPerBin), a + 1), binCount);
    if (b <= a) b = a + 1;
    start[i] = a;
    end[i] = b;

    const centre = Math.sqrt(lo * hi);
    // Shelf, not a see-saw: the tilt only ever lifts, so the bass keeps its
    // true level and the top end is merely rescued from the floor.
    gain[i] = Math.max(0, (tilt * Math.log2(centre / pivotHz)) / rangeDb);
  }

  return { count, start, end, gain, edgeHz, hzPerBin, minHz, maxHz };
}

/** Collapse a byte FFT frame onto `plan`'s columns, normalised to 0..1. */
export function readBands(freq: Uint8Array, plan: LogBandPlan, out: Float32Array): Float32Array {
  const { count, start, end, gain } = plan;
  for (let i = 0; i < count; i += 1) {
    const a = start[i] ?? 0;
    const b = end[i] ?? a + 1;
    let peak = 0;
    let sum = 0;
    for (let j = a; j < b; j += 1) {
      const v = freq[j] ?? 0;
      if (v > peak) peak = v;
      sum += v;
    }
    const width = b - a;
    const mean = width > 0 ? sum / width : 0;
    const blended = (PEAK_WEIGHT * peak + (1 - PEAK_WEIGHT) * mean) / 255;
    out[i] = clamp01(blended + (gain[i] ?? 0));
  }
  return out;
}

/** Mean level of the bins spanning `[startBin, endBin)`, normalised to 0..1. */
export function bandEnergy(freq: Uint8Array, startBin: number, endBin: number): number {
  const a = Math.max(0, Math.floor(startBin));
  const b = Math.min(freq.length, Math.ceil(endBin));
  if (b <= a) return 0;
  let sum = 0;
  for (let j = a; j < b; j += 1) sum += freq[j] ?? 0;
  return sum / (b - a) / 255;
}

// ---------------------------------------------------------------------------
// Kick detection
// ---------------------------------------------------------------------------

/** Bottom of the kick band. Below this is room rumble and DC. */
export const KICK_BAND_LOW_HZ = 20;
/** Top of the kick band. Above this the snare and bass line start to intrude. */
export const KICK_BAND_HIGH_HZ = 120;

/** Fastest tempo this library ships (see the generator's prompt set). */
export const MAX_TRACKED_BPM = 135;

/**
 * Refractory period. One beat at 135 BPM is 444 ms, so anything at 75% of that
 * can never swallow a real beat, while still being long enough to sit out the
 * 100-150 ms tail of the kick that fired it.
 */
export const KICK_DEBOUNCE_MS = (60_000 / MAX_TRACKED_BPM) * 0.75;

/** FFT bins covering `[KICK_BAND_LOW_HZ, KICK_BAND_HIGH_HZ)`, exclusive of DC. */
export function kickBandBins(binCount: number, sampleRate: number): readonly [number, number] {
  const hzPerBin = sampleRate / 2 / Math.max(1, binCount);
  const lo = Math.min(Math.max(Math.floor(KICK_BAND_LOW_HZ / hzPerBin), 1), binCount - 1);
  const hi = Math.min(Math.max(Math.ceil(KICK_BAND_HIGH_HZ / hzPerBin), lo + 1), binCount);
  return [lo, hi];
}

export interface Kick {
  /** Timestamp of the frame that fired, on whatever clock was passed to `push`. */
  at: number;
  /** Low-band level at the hit, 0..1. */
  energy: number;
  /** 0.4..1 — how far past the adaptive threshold the onset landed. */
  strength: number;
  /** Milliseconds since the previous kick, or null for the first one. */
  interval: number | null;
  /** Rolling tempo estimate, folded into `bpmRange`. Null until three kicks. */
  bpm: number | null;
}

export interface KickDetectorOptions {
  /** Frames of onset history behind the adaptive threshold. ~0.8 s at 60 fps. */
  historyFrames?: number;
  /**
   * Quiet frames required before the detector will fire at all. Without this
   * the step from silence to signal at the top of a track reads as one enormous
   * onset — measured at 0.14 flux against a 0.05 bar on a droning intro, which
   * is a phantom kick on the downbeat of every track. 8 frames is 133 ms.
   */
  warmupFrames?: number;
  /** Frames the rise is measured over. 4 covers a smoothed kick attack at 60 fps. */
  lookbackFrames?: number;
  /** Multiplier on the rolling mean onset strength. */
  meanFactor?: number;
  /** Multiplier on the rolling standard deviation. Rejects noisy passages. */
  deviationFactor?: number;
  /** Absolute onset floor, so near-silence can never clear the bar. */
  fluxFloor?: number;
  /** Absolute band-level floor, likewise. */
  energyFloor?: number;
  debounceMs?: number;
  /** Intervals kept for the tempo median. */
  tempoFrames?: number;
  /** Gaps longer than this reset the tempo estimate (track change, pause). */
  maxIntervalMs?: number;
  /** Octave window the tempo estimate is folded into. Must span > 1 octave. */
  bpmRange?: readonly [number, number];
}

type ResolvedOptions = Required<KickDetectorOptions>;

const DEFAULTS: ResolvedOptions = {
  historyFrames: 48,
  warmupFrames: 8,
  lookbackFrames: 4,
  meanFactor: 1.6,
  deviationFactor: 4.5,
  fluxFloor: 0.05,
  energyFloor: 0.06,
  debounceMs: KICK_DEBOUNCE_MS,
  tempoFrames: 8,
  maxIntervalMs: 2400,
  bpmRange: [68, 152],
};

/**
 * Onset detector for the kick drum.
 *
 * It watches *rectified low-band flux* — how much the 20-120 Hz level has risen
 * over the last few frames — rather than raw energy. Raw energy is the obvious
 * choice and the wrong one for this library: a dark techno track sits on a
 * continuous sub-bass drone, so absolute low-band energy is high all the time
 * and a level threshold either fires constantly or misses the beat entirely.
 * Flux is ~0 through a sustain and spikes only on an attack.
 *
 * Measuring the rise against the *minimum* of the last few frames rather than
 * just the previous one matters because the analyser smooths: a kick attack is
 * spread over 2-4 frames, and a frame-to-frame difference sees only a third of
 * the real jump.
 *
 * The bar it has to clear is `mean * meanFactor + deviation * deviationFactor`
 * over a rolling window, floored by an absolute minimum. The variance term is
 * what keeps broadband noise quiet: noise has a high mean flux *and* a high
 * spread, so the bar rises with it.
 *
 * The one non-obvious rule is that frames which fire, and the refractory frames
 * behind them, are *not* fed back into that window. Letting them in means the
 * detector's own hits set its baseline — measured, a 4-on-the-floor pattern
 * drove the threshold up by ~14% per beat until it out-ran the kick and
 * detection collapsed. The window therefore describes the material *between*
 * hits, which is exactly the thing a hit has to stand out from.
 */
export class KickDetector {
  private readonly options: ResolvedOptions;
  private readonly history: Float32Array;
  private readonly recent: Float32Array;
  private readonly intervals: number[] = [];

  private cursor = 0;
  private filled = 0;
  private recentFilled = 0;
  private lastAt: number | null = null;
  private tempo: number | null = null;
  private lastFlux = 0;
  private lastThreshold = 0;

  constructor(options: KickDetectorOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.history = new Float32Array(Math.max(4, Math.floor(this.options.historyFrames)));
    this.recent = new Float32Array(Math.max(1, Math.floor(this.options.lookbackFrames)));
  }

  /** Feed one frame. Returns a `Kick` on the frame the onset fires, else null. */
  push(energy: number, atMs: number): Kick | null {
    const level = clamp01(energy);

    // Baseline: the quietest of the last few frames. During a sustain that is
    // ~the current level (flux 0); across an attack it is the pre-hit floor.
    let baseline = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.recentFilled; i += 1) {
      const v = this.recent[i] ?? 0;
      if (v < baseline) baseline = v;
    }
    this.pushRecent(level);

    if (!Number.isFinite(baseline)) {
      this.record(0);
      return null;
    }

    const flux = Math.max(0, level - baseline);
    const { mean, deviation } = this.stats();
    const threshold = Math.max(
      this.options.fluxFloor,
      mean * this.options.meanFactor + deviation * this.options.deviationFactor,
    );

    this.lastFlux = flux;
    this.lastThreshold = threshold;

    const previous = this.lastAt;
    const refractory = previous !== null && atMs - previous < this.options.debounceMs;
    const onset = flux > threshold && level >= this.options.energyFloor;

    // See the class note: onsets and the refractory tail behind them stay out of
    // their own baseline. Keyed on `onset` rather than on whether we actually
    // fired, so the frames suppressed by warm-up or debounce are excluded too —
    // otherwise the very spikes being suppressed are the ones setting the bar.
    if (!refractory && !onset) this.record(flux);

    if (!onset || refractory) return null;
    if (this.filled < this.options.warmupFrames) return null;

    const interval = previous === null ? null : atMs - previous;
    this.lastAt = atMs;
    this.updateTempo(interval);

    const excess = threshold > 0 ? (flux - threshold) / threshold : 1;
    return {
      at: atMs,
      energy: level,
      strength: clamp01(0.4 + 0.6 * Math.min(1, excess)),
      interval,
      bpm: this.tempo,
    };
  }

  /**
   * Forget the onset state — used on pause and on track change. The tempo
   * estimate survives on purpose, so the readout does not blank on every pause.
   */
  reset(): void {
    this.history.fill(0);
    this.recent.fill(0);
    this.cursor = 0;
    this.filled = 0;
    this.recentFilled = 0;
    this.lastAt = null;
    this.lastFlux = 0;
    this.lastThreshold = 0;
    this.intervals.length = 0;
  }

  get bpm(): number | null {
    return this.tempo;
  }

  get flux(): number {
    return this.lastFlux;
  }

  /** The bar the current frame had to clear — handy for plotting. */
  get threshold(): number {
    return this.lastThreshold;
  }

  get lastKickAt(): number | null {
    return this.lastAt;
  }

  private pushRecent(level: number): void {
    const size = this.recent.length;
    for (let i = size - 1; i > 0; i -= 1) this.recent[i] = this.recent[i - 1] ?? 0;
    this.recent[0] = level;
    if (this.recentFilled < size) this.recentFilled += 1;
  }

  private record(flux: number): void {
    this.history[this.cursor] = flux;
    this.cursor = (this.cursor + 1) % this.history.length;
    if (this.filled < this.history.length) this.filled += 1;
  }

  private stats(): { mean: number; deviation: number } {
    const n = this.filled;
    if (n === 0) return { mean: 0, deviation: 0 };
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += this.history[i] ?? 0;
    const mean = sum / n;
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      const d = (this.history[i] ?? 0) - mean;
      acc += d * d;
    }
    return { mean, deviation: Math.sqrt(acc / n) };
  }

  private updateTempo(interval: number | null): void {
    if (interval === null) return;
    if (interval > this.options.maxIntervalMs) {
      this.intervals.length = 0;
      return;
    }
    this.intervals.push(interval);
    while (this.intervals.length > this.options.tempoFrames) this.intervals.shift();
    if (this.intervals.length < 3) return;

    // Median, not mean: one missed or doubled beat should not drag the readout.
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (middle <= 0) return;

    const [low, high] = this.options.bpmRange;
    let bpm = 60_000 / middle;
    for (let i = 0; i < 8 && bpm < low; i += 1) bpm *= 2;
    for (let i = 0; i < 8 && bpm > high; i += 1) bpm /= 2;
    this.tempo = bpm;
  }
}

// ---------------------------------------------------------------------------
// Kick bus
// ---------------------------------------------------------------------------

export type KickListener = (kick: Kick) => void;

const listeners = new Set<KickListener>();

/**
 * Subscribe to every kick the visualiser detects. Module-level rather than
 * prop-drilled so any part of the UI can flinch on the beat without App having
 * to thread a callback down to it. Returns an unsubscribe function.
 */
export function subscribeKick(listener: KickListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the visualiser; there is only ever one producer. */
export function publishKick(kick: Kick): void {
  for (const listener of listeners) listener(kick);
}
