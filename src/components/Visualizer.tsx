import { useEffect, useRef } from "react";

import {
  KickDetector,
  bandEnergy,
  kickBandBins,
  planLogBands,
  publishKick,
  readBands,
  subscribeKick,
} from "../audio/analysis";
import type { Kick, LogBandPlan } from "../audio/analysis";

import "./visualizer.css";

export type { Kick } from "../audio/analysis";

interface Props {
  analyser: AnalyserNode | null;
  /** Only animate while audio is actually running. */
  active: boolean;
  /**
   * Fires on every detected kick. Optional — every kick is also broadcast on
   * the module-level bus (`subscribeKick` / `useKick`), so nothing has to be
   * threaded through App to react to the beat.
   */
  onKick?: (kick: Kick) => void;
}

/* --- palette -------------------------------------------------------------- */
/* Mirrors styles.css. One accent; everything else is greyscale, so anything
   glowing is by definition something happening right now. */

// Illuminated-readout grey, matched to the metal theme (--bright/#e8edf1
// family). Was hardcoded amber; the theme could not reach it from CSS.
const READOUT = "205, 214, 220";
const RULE = "#1b1f21";
const RULE_INNER = "rgba(27, 31, 33, 0.72)";
const RULE_WARM = "#2b2418";
const DIM = "#5d6568";

const FONT = `"JetBrains Mono", "IBM Plex Mono", "DejaVu Sans Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const LABEL_PX = 9;
const TRACKING = 1.5;

/* --- behaviour ------------------------------------------------------------ */

/** Bar fall time constant. Slow enough to read, fast enough to breathe. */
const BAR_DECAY_S = 0.16;
/** How far a bar closes the gap to a higher reading in one frame. */
const BAR_ATTACK = 0.62;
/** Peak caps sit still this long before they start sinking. */
const PEAK_HOLD_S = 0.45;
/** …then fall at this many display-heights per second. */
const PEAK_FALL_PER_S = 0.75;
/** Kick lamp decay. */
const PULSE_DECAY_S = 0.17;
/** Peak-level readout decay, in dB terms; slow so the number stays readable. */
const METER_DECAY_S = 0.8;

/** Target column pitch in CSS px. 5 px reads as an instrument, not a toy. */
const COLUMN_PITCH = 5;
const MIN_BANDS = 24;
const MAX_BANDS = 160;

/** Graticule frequencies: all get a tick, the decades get a label. */
const TICKS_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000] as const;
const LABELLED_HZ = new Map<number, string>([
  [100, "100"],
  [1000, "1k"],
  [10000, "10k"],
]);

interface View {
  w: number;
  h: number;
  padX: number;
  innerW: number;
  headBaseline: number;
  scopeMid: number;
  scopeHalf: number;
  specTop: number;
  specBottom: number;
  specH: number;
  rulerBaseline: number;
  /** Whole-pixel left edge of every column. */
  columnX: Int32Array;
  barW: number;
  plan: LogBandPlan;
  values: Float32Array;
  levels: Float32Array;
  peaks: Float32Array;
  holds: Float32Array;
  gradient: CanvasGradient;
  charAdv: number;
}

/**
 * Spectrum analyser, oscilloscope and kick detector for the deck.
 *
 * Reads the shared `AnalyserNode` at frame rate and paints a single canvas:
 * a min/max waveform envelope across the top, a logarithmically binned
 * spectrum with peak-hold caps below it, and a graticule with the readouts a
 * rack unit would carry. Kick onsets drive a lamp, the baseline flash and the
 * bloom under the bass columns, and are published on the kick bus.
 *
 * The loop parks itself whenever the document is hidden or the canvas scrolls
 * off screen, and again once the display has settled after playback stops —
 * this is background music, it must not cost anything while the user works.
 */
export function Visualizer({ analyser, active, onKick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlRef = useRef<{ setActive: (value: boolean) => void } | null>(null);
  const activeRef = useRef(active);
  const onKickRef = useRef(onKick);

  useEffect(() => {
    activeRef.current = active;
    onKickRef.current = onKick;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    /* -- analysis taps ----------------------------------------------------- */

    // The shared analyser smooths at 0.75, which is right for a spectrum you
    // look at and wrong for one you measure transients on: it spreads a kick
    // attack over ~4 frames and blunts exactly the edge we want to detect. A
    // second analyser hung off the same node gives detection its own, barely
    // smoothed view without touching the player's graph or the audible path.
    let detectTap: AnalyserNode | null = null;
    if (analyser !== null) {
      try {
        const tap = analyser.context.createAnalyser();
        tap.fftSize = analyser.fftSize;
        tap.smoothingTimeConstant = 0.15;
        tap.minDecibels = analyser.minDecibels;
        tap.maxDecibels = analyser.maxDecibels;
        analyser.connect(tap);
        detectTap = tap;
      } catch {
        // Older engines can refuse a second fan-out; fall back to the shared
        // node, which detects a little later but still detects.
        detectTap = null;
      }
    }

    const binCount = analyser?.frequencyBinCount ?? 1024;
    const sampleRate = analyser?.context.sampleRate ?? 48_000;
    const fftSize = analyser?.fftSize ?? 2048;

    const freq = new Uint8Array(binCount);
    const time = new Uint8Array(fftSize);
    const detectFreq = detectTap === null ? freq : new Uint8Array(binCount);
    time.fill(128);

    const [kickLo, kickHi] = kickBandBins(binCount, sampleRate);
    const detector = new KickDetector();

    /* -- grain ------------------------------------------------------------- */

    // Static, not animated: sensor noise on a screen, not TV static. Built once
    // at device resolution and blitted with the transform reset so it stays one
    // physical pixel per speckle regardless of devicePixelRatio.
    const grain = buildGrain();

    /* -- layout ------------------------------------------------------------ */

    let view: View | null = null;

    const buildView = (w: number, h: number): View => {
      const padX = 20;
      const innerW = Math.max(1, w - padX * 2);

      const headH = Math.min(26, h * 0.24);
      const rulerH = Math.min(15, h * 0.13);
      const bodyH = Math.max(12, h - headH - rulerH);

      const scopeH = Math.max(6, Math.round(bodyH * 0.3));
      const gap = Math.max(3, Math.round(bodyH * 0.06));
      const specH = Math.max(6, bodyH - scopeH - gap);

      const scopeTop = headH;
      const specTop = scopeTop + scopeH + gap;
      const specBottom = specTop + specH;

      const count = Math.max(MIN_BANDS, Math.min(MAX_BANDS, Math.floor(innerW / COLUMN_PITCH)));
      const bandW = innerW / count;

      // Columns are snapped to whole pixels and share one integer width. Left on
      // fractional coordinates the browser antialiases each column by a slightly
      // different amount, and a bank of 157 of them beats into visible moiré
      // across the panel. Snapping trades a 1 px wobble in the gaps — invisible —
      // for columns that all render identically.
      const columnX = new Int32Array(count);
      for (let i = 0; i < count; i += 1) columnX[i] = Math.round(padX + i * bandW);
      const barW = Math.max(1, Math.round(bandW) - 2);

      const gradient = ctx.createLinearGradient(0, specTop, 0, specBottom);
      gradient.addColorStop(0, `rgba(${READOUT}, 1)`);
      gradient.addColorStop(0.5, `rgba(${READOUT}, 0.82)`);
      gradient.addColorStop(1, `rgba(${READOUT}, 0.3)`);

      ctx.font = `${LABEL_PX}px ${FONT}`;
      const charAdv = ctx.measureText("0").width + TRACKING;

      return {
        w,
        h,
        padX,
        innerW,
        // Shares a baseline with the .viz-tag in the opposite corner, which
        // styles.css puts at top:14px on a 10px line.
        headBaseline: Math.round(Math.min(headH - 1, 24)),
        // Rounded so the graticule's centre line and a silent (flat) trace
        // land on exactly the same pixel row instead of 1 px apart.
        scopeMid: Math.round(scopeTop + scopeH / 2),
        scopeHalf: scopeH / 2,
        specTop,
        specBottom,
        specH,
        rulerBaseline: Math.round(Math.min(h - 2, specBottom + rulerH * 0.86)),
        columnX,
        barW,
        plan: planLogBands({ binCount, sampleRate, count }),
        values: new Float32Array(count),
        levels: new Float32Array(count),
        peaks: new Float32Array(count),
        holds: new Float32Array(count),
        gradient,
        charAdv,
      };
    };

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      view = buildView(w, h);
    };

    /* -- state ------------------------------------------------------------- */

    let raf = 0;
    let running = false;
    let liveWanted = activeRef.current;
    let pageVisible = document.visibilityState !== "hidden";
    let onScreen = true;
    let lastTime = 0;
    let pulse = 0;
    let meterPeak = 0;

    /* -- frame ------------------------------------------------------------- */

    const drawFrame = (now: number): void => {
      const v = view;
      if (v === null) return;

      const dt = lastTime === 0 ? 1 / 60 : Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      const live = liveWanted && analyser !== null;

      if (live && analyser !== null) {
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(time);
        if (detectTap !== null) detectTap.getByteFrequencyData(detectFreq);
        readBands(freq, v.plan, v.values);
      } else {
        v.values.fill(0);
        time.fill(128);
      }

      /* kick ------------------------------------------------------------- */

      let kick: Kick | null = null;
      if (live) {
        kick = detector.push(bandEnergy(detectFreq, kickLo, kickHi), now);
        if (kick !== null) {
          pulse = Math.max(pulse, kick.strength);
          publishKick(kick);
          onKickRef.current?.(kick);
        }
      }
      pulse *= Math.exp(-dt / PULSE_DECAY_S);
      if (pulse < 0.004) pulse = 0;

      /* envelopes -------------------------------------------------------- */

      const fall = Math.exp(-dt / BAR_DECAY_S);
      const peakDrop = PEAK_FALL_PER_S * dt;
      for (let i = 0; i < v.plan.count; i += 1) {
        const target = v.values[i] ?? 0;
        const current = v.levels[i] ?? 0;
        const next = target > current ? current + (target - current) * BAR_ATTACK : current * fall;
        v.levels[i] = next < 0.0008 ? 0 : next;

        const peak = v.peaks[i] ?? 0;
        if (next >= peak) {
          v.peaks[i] = next;
          v.holds[i] = PEAK_HOLD_S;
        } else {
          const hold = (v.holds[i] ?? 0) - dt;
          v.holds[i] = hold > 0 ? hold : 0;
          if (hold <= 0) v.peaks[i] = Math.max(next, peak - peakDrop);
        }
      }

      if (live) {
        let sample = 0;
        for (const byte of time) {
          const a = Math.abs(byte - 128);
          if (a > sample) sample = a;
        }
        meterPeak = Math.max(sample / 128, meterPeak * Math.exp(-dt / METER_DECAY_S));
      } else {
        // No signal, no reading — and nothing to keep the loop alive for.
        meterPeak = 0;
      }

      /* paint ------------------------------------------------------------ */

      ctx.clearRect(0, 0, v.w, v.h);
      paintGraticule(ctx, v);
      if (pulse > 0.03) paintBloom(ctx, v, pulse);
      paintScope(ctx, v, time);
      paintSpectrum(ctx, v);
      paintBaseline(ctx, v, pulse);
      paintBrackets(ctx, v, pulse);
      paintHead(ctx, v, { live, pulse, bpm: detector.bpm, peak: meterPeak });
      if (grain !== null) paintGrain(ctx, canvas, grain);

      /* park once the display has settled ------------------------------- */

      if (!live) {
        let quiet = pulse === 0;
        if (quiet) {
          for (let i = 0; i < v.plan.count; i += 1) {
            if ((v.levels[i] ?? 0) > 0 || (v.peaks[i] ?? 0) > 0.002) {
              quiet = false;
              break;
            }
          }
        }
        if (quiet) {
          running = false;
          raf = 0;
          return;
        }
      }

      if (running) raf = window.requestAnimationFrame(drawFrame);
      else raf = 0;
    };

    const evaluate = (): void => {
      const shouldRun = pageVisible && onScreen;
      if (shouldRun && raf === 0) {
        running = true;
        lastTime = 0;
        raf = window.requestAnimationFrame(drawFrame);
      } else if (!shouldRun && raf !== 0) {
        running = false;
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    controlRef.current = {
      setActive: (value: boolean) => {
        if (value === liveWanted) return;
        liveWanted = value;
        if (!value) detector.reset();
        evaluate();
      },
    };

    /* -- wiring ------------------------------------------------------------ */

    const onVisibility = (): void => {
      pageVisible = document.visibilityState !== "hidden";
      evaluate();
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
      evaluate();
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        onScreen = entry.isIntersecting;
        evaluate();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    document.addEventListener("visibilitychange", onVisibility);

    resize();
    evaluate();

    return () => {
      controlRef.current = null;
      running = false;
      if (raf !== 0) window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      if (detectTap !== null && analyser !== null) {
        // Both can throw if the player already closed the context underneath us.
        try {
          analyser.disconnect(detectTap);
        } catch {
          /* already torn down */
        }
        try {
          detectTap.disconnect();
        } catch {
          /* already torn down */
        }
      }
    };
  }, [analyser]);

  useEffect(() => {
    controlRef.current?.setActive(active);
  }, [active]);

  return (
    <section className="viz" aria-label="Audio visualiser">
      <canvas ref={canvasRef} className="viz-canvas" />
      <span className="viz-tag">
        Spectrum <span className="viz-tag-slash">//</span>{" "}
        {active ? "log 30 Hz – 16 kHz" : "standby"}
      </span>
    </section>
  );
}

/* --- painters ------------------------------------------------------------- */

/**
 * Canvas letter-spacing is not available in every engine this ships to, and
 * every label in the rest of the UI is tracked out. Drawing per glyph keeps the
 * readouts speaking in the same voice as the CSS.
 */
function tracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, adv: number): void {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += adv;
  }
}

/** Width of a tracked string, without the trailing gap. */
function trackedWidth(text: string, adv: number): number {
  return text.length === 0 ? 0 : text.length * adv - TRACKING;
}

function paintGraticule(ctx: CanvasRenderingContext2D, v: View): void {
  const { padX, innerW, specTop, specH, specBottom } = v;

  // Horizontal divisions across the spectrum well — quarter, half, three
  // quarters of full scale, the graduation any analyser face carries.
  ctx.fillStyle = RULE_INNER;
  for (const t of [0.25, 0.5, 0.75]) {
    ctx.fillRect(padX, Math.round(specTop + specH * t), innerW, 1);
  }

  // Scope centre line.
  ctx.fillRect(padX, v.scopeMid, innerW, 1);

  // Frequency ticks, spaced by the same log map the columns use.
  const span = Math.log(v.plan.maxHz / v.plan.minHz);
  ctx.font = `${LABEL_PX}px ${FONT}`;
  ctx.textBaseline = "alphabetic";

  for (const hz of TICKS_HZ) {
    if (hz <= v.plan.minHz || hz >= v.plan.maxHz) continue;
    const x = Math.round(padX + (innerW * Math.log(hz / v.plan.minHz)) / span);
    const label = LABELLED_HZ.get(hz);

    if (label === undefined) {
      ctx.fillStyle = RULE_INNER;
      ctx.fillRect(x, specBottom + 1, 1, 3);
      continue;
    }

    // Decades get a rule the full depth of the well rather than a longer tick:
    // the columns then read against a grid instead of floating over a void, and
    // the label keeps the whole ruler row to itself.
    ctx.fillStyle = RULE_INNER;
    ctx.fillRect(x, specTop, 1, specH);
    ctx.fillStyle = RULE;
    ctx.fillRect(x, specBottom + 1, 1, 3);
    ctx.fillStyle = DIM;
    tracked(ctx, label, x - trackedWidth(label, v.charAdv) / 2, v.rulerBaseline, v.charAdv);
  }
}

function paintBloom(ctx: CanvasRenderingContext2D, v: View, pulse: number): void {
  // Backlight behind the bass columns: the panel registering the hit, rather
  // than a shape drawn on top of it.
  const cx = v.padX + v.innerW * 0.07;
  const r = Math.max(24, v.specH * 1.9);
  const bloom = ctx.createRadialGradient(cx, v.specBottom, 0, cx, v.specBottom, r);
  bloom.addColorStop(0, `rgba(${READOUT}, ${(0.11 * pulse).toFixed(4)})`);
  bloom.addColorStop(1, `rgba(${READOUT}, 0)`);
  ctx.fillStyle = bloom;
  ctx.fillRect(v.padX, v.specTop - v.specH, v.innerW, v.specH * 2 + 8);
}

function paintScope(ctx: CanvasRenderingContext2D, v: View, time: Uint8Array): void {
  // Min/max envelope rather than a polyline: at ~800 columns against 2048
  // samples a polyline aliases into a mess, and heavy sub-bass reads as a solid
  // body anyway. This is what a scope in envelope mode shows.
  const columns = Math.max(1, Math.floor(v.innerW));
  const step = time.length / columns;
  const scale = v.scopeHalf - 1;

  ctx.fillStyle = `rgba(${READOUT}, 0.5)`;
  ctx.beginPath();
  for (let c = 0; c < columns; c += 1) {
    const from = Math.floor(c * step);
    const to = Math.min(time.length, Math.max(from + 1, Math.floor((c + 1) * step)));
    let lo = 255;
    let hi = 0;
    for (let j = from; j < to; j += 1) {
      const s = time[j] ?? 128;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    const top = v.scopeMid - ((hi - 128) / 128) * scale;
    const bottom = v.scopeMid - ((lo - 128) / 128) * scale;
    ctx.rect(v.padX + c, top, 1, Math.max(1, bottom - top));
  }
  ctx.fill();
}

function paintSpectrum(ctx: CanvasRenderingContext2D, v: View): void {
  const base = Math.round(v.specBottom);

  ctx.fillStyle = v.gradient;
  ctx.beginPath();
  for (let i = 0; i < v.plan.count; i += 1) {
    const h = Math.max(1, Math.round((v.levels[i] ?? 0) * v.specH));
    ctx.rect(v.columnX[i] ?? 0, base - h, v.barW, h);
  }
  ctx.fill();

  // Peak-hold caps. The column shows now; the cap shows the last second.
  ctx.fillStyle = `rgba(${READOUT}, 0.7)`;
  ctx.beginPath();
  let any = false;
  for (let i = 0; i < v.plan.count; i += 1) {
    const peak = v.peaks[i] ?? 0;
    if (peak <= 0.012) continue;
    any = true;
    ctx.rect(v.columnX[i] ?? 0, base - Math.round(peak * v.specH) - 1, v.barW, 1);
  }
  if (any) ctx.fill();
}

function paintBaseline(ctx: CanvasRenderingContext2D, v: View, pulse: number): void {
  ctx.fillStyle = RULE;
  ctx.fillRect(v.padX, Math.round(v.specBottom), v.innerW, 1);
  if (pulse <= 0.01) return;
  ctx.fillStyle = `rgba(${READOUT}, ${(0.6 * pulse).toFixed(4)})`;
  ctx.fillRect(v.padX, Math.round(v.specBottom), v.innerW, 1);
  ctx.fillStyle = `rgba(${READOUT}, ${(0.12 * pulse).toFixed(4)})`;
  ctx.fillRect(v.padX, Math.round(v.specBottom) + 1, v.innerW, 2);
}

function paintBrackets(ctx: CanvasRenderingContext2D, v: View, pulse: number): void {
  const arm = 7;
  const top = Math.round(v.scopeMid - v.scopeHalf);
  const bottom = Math.round(v.specBottom);
  const left = v.padX - 6;
  const right = v.w - v.padX + 6;

  const draw = (colour: string, width: number): void => {
    ctx.fillStyle = colour;
    for (const [x, dir] of [
      [left, 1],
      [right - width, -1],
    ] as const) {
      ctx.fillRect(x, top, width, 1);
      ctx.fillRect(x, bottom, width, 1);
      const stem = dir === 1 ? x : x + width - 1;
      ctx.fillRect(stem, top, 1, arm);
      ctx.fillRect(stem, bottom - arm + 1, 1, arm);
    }
  };

  draw(RULE_WARM, arm);
  if (pulse > 0.01) draw(`rgba(${READOUT}, ${(0.55 * pulse).toFixed(4)})`, arm);
}

interface HeadState {
  live: boolean;
  pulse: number;
  bpm: number | null;
  peak: number;
}

function paintHead(ctx: CanvasRenderingContext2D, v: View, state: HeadState): void {
  const { charAdv } = v;
  const y = v.headBaseline;
  const gutter = 16;

  ctx.font = `${LABEL_PX}px ${FONT}`;
  ctx.textBaseline = "alphabetic";

  // Kick lamp, rightmost — the thing you glance at.
  const lampSize = 5;
  const lampY = Math.round(y - lampSize - 1);
  const groupX = v.w - v.padX - (lampSize + 5 + trackedWidth("KICK", charAdv));

  ctx.fillStyle =
    state.pulse > 0.01 ? `rgba(${READOUT}, ${(0.2 + 0.8 * state.pulse).toFixed(4)})` : RULE_WARM;
  ctx.fillRect(groupX, lampY, lampSize, lampSize);
  ctx.fillStyle = state.pulse > 0.35 ? `rgba(${READOUT}, 0.9)` : DIM;
  tracked(ctx, "KICK", groupX + lampSize + 5, y, charAdv);

  // Tempo, inferred from the kick intervals — `~` because it is measured off
  // what is playing, not read from the track metadata.
  const bpmText = state.bpm === null ? "BPM ---" : `BPM ~${Math.round(state.bpm)}`;
  const bpmW = trackedWidth(bpmText, charAdv);
  let x = groupX - gutter - bpmW;
  ctx.fillStyle = state.bpm === null || !state.live ? DIM : `rgba(${READOUT}, 0.85)`;
  tracked(ctx, bpmText, x, y, charAdv);

  // Peak level, held and decayed so the number can actually be read.
  const db = state.peak > 0.001 ? Math.max(-60, 20 * Math.log10(state.peak)) : null;
  const dbText = db === null ? "PK  --.-" : `PK ${db > -9.95 ? " " : ""}${db.toFixed(1)}`;
  x -= gutter + trackedWidth(dbText, charAdv);
  ctx.fillStyle = db !== null && db > -1.5 ? `rgba(${READOUT}, 0.85)` : DIM;
  tracked(ctx, dbText, x, y, charAdv);
}

/* --- grain ---------------------------------------------------------------- */

function buildGrain(): CanvasPattern | null {
  const size = 96;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const tctx = tile.getContext("2d");
  if (tctx === null) return null;

  const image = tctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 16);
  }
  tctx.putImageData(image, 0, 0);
  return tctx.createPattern(tile, "repeat");
}

function paintGrain(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  pattern: CanvasPattern,
): void {
  ctx.save();
  // Reset the DPR transform so a speckle is one physical pixel, not a block.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/* --- consumer hook -------------------------------------------------------- */

/**
 * Run `handler` on every detected kick. The handler may change between renders
 * without resubscribing, and nothing re-renders on the beat — drive an
 * imperative effect (a ref, a CSS class toggle) from here rather than state if
 * you want it 60 fps smooth.
 */
export function useKick(handler: (kick: Kick) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribeKick((kick) => ref.current(kick)), []);
}
