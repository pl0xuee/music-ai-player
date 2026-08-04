import type { Track } from "../types";

export interface ShuffleConfig {
  /** How many recently played tracks to keep out of the running. */
  historyDepth: number;
  /** Two tracks beat-match well enough when their BPM differ by at most this. */
  bpmWindow: number;
  /** When nothing sits inside the BPM window, choose among the N nearest. */
  nearestFallback: number;
}

export const DEFAULT_SHUFFLE_CONFIG: ShuffleConfig = {
  historyDepth: 50,
  bpmWindow: 8,
  nearestFallback: 5,
};

/**
 * Shuffle bag.
 *
 * Invariant: `bag` holds the id of every eligible track that has not been drawn
 * in the current cycle, and it is refilled only once it runs empty. That single
 * rule is what guarantees the whole library plays through before anything
 * repeats — unlike random-with-replacement, which clusters.
 *
 * On top of the bag, two preferences shape the draw: recently played ids are
 * skipped (so the seam between two cycles does not repeat a track), and among
 * what is left the pick is biased towards a similar BPM so consecutive tracks
 * roughly beat-match.
 */
export class ShuffleBag {
  private readonly config: ShuffleConfig;
  private library = new Map<number, Track>();
  private genre: string | null = null;
  /** Eligible ids for the active genre, excluding buried tracks. */
  private eligible: number[] = [];
  private bag: number[] = [];
  private history: number[] = [];

  constructor(config: Partial<ShuffleConfig> = {}) {
    this.config = { ...DEFAULT_SHUFFLE_CONFIG, ...config };
  }

  /** Replace the known library. Draw progress and history survive. */
  setLibrary(tracks: Track[]): void {
    this.library = new Map(tracks.map((track) => [track.id, track]));
    this.rebuild();
  }

  /** Narrow the bag to one genre; null or "all" widens it again. */
  setGenre(genre: string | null): void {
    this.genre = genre === null || genre === "all" ? null : genre;
    this.rebuild();
  }

  get activeGenre(): string | null {
    return this.genre;
  }

  /** Tracks still to be drawn in this cycle. */
  get remaining(): number {
    return this.bag.length;
  }

  /** Tracks eligible under the current genre and rating filters. */
  get size(): number {
    return this.eligible.length;
  }

  /** Apply a rating change; -1 removes the track from circulation. */
  setRating(id: number, rating: number): void {
    const track = this.library.get(id);
    if (track === undefined) return;
    this.library.set(id, { ...track, rating });
    this.rebuild();
  }

  /** Register a track the user picked by hand so shuffle does not repeat it. */
  markPlayed(id: number): void {
    this.bag = this.bag.filter((candidate) => candidate !== id);
    this.history.push(id);
    if (this.history.length > this.config.historyDepth) {
      this.history = this.history.slice(-this.config.historyDepth);
    }
  }

  /**
   * Draw the next track, biased towards `current`'s tempo.
   * Returns null only when nothing is eligible at all.
   */
  next(current: Track | null): Track | null {
    if (this.eligible.length === 0) return null;
    if (this.bag.length === 0) this.refill();

    const candidates = this.dropRecent(this.bag);
    const id = this.pickByTempo(candidates, current);
    this.markPlayed(id);
    return this.library.get(id) ?? null;
  }

  /** Start a fresh cycle. */
  reset(): void {
    this.history = [];
    this.refill();
  }

  // -- internals ------------------------------------------------------------

  private rebuild(): void {
    this.eligible = [...this.library.values()]
      .filter((track) => track.rating !== -1)
      .filter((track) => this.genre === null || track.genre === this.genre)
      .map((track) => track.id);

    const eligibleSet = new Set(this.eligible);
    // Keep the cycle's progress: only drop ids the filters just excluded.
    this.bag = this.bag.filter((id) => eligibleSet.has(id));
    if (this.bag.length === 0) this.refill();
  }

  private refill(): void {
    this.bag = shuffled(this.eligible);
  }

  private dropRecent(ids: number[]): number[] {
    // Halve the avoidance window until something survives: on a library smaller
    // than `historyDepth` the full window would exclude every candidate.
    for (let depth = this.config.historyDepth; depth >= 1; depth = Math.floor(depth / 2)) {
      const recent = new Set(this.history.slice(-depth));
      const kept = ids.filter((id) => !recent.has(id));
      if (kept.length > 0) return kept;
    }
    return ids;
  }

  private pickByTempo(ids: number[], current: Track | null): number {
    if (current === null) return randomOf(ids);

    const scored = ids.map((id) => ({
      id,
      delta: Math.abs((this.library.get(id)?.bpm ?? current.bpm) - current.bpm),
    }));

    const matched = scored.filter((entry) => entry.delta <= this.config.bpmWindow);
    if (matched.length > 0) return randomOf(matched.map((entry) => entry.id));

    // No tempo match available: take the smallest jump on offer, but keep a
    // handful of options so the order does not become deterministic.
    scored.sort((a, b) => a.delta - b.delta);
    return randomOf(scored.slice(0, this.config.nearestFallback).map((entry) => entry.id));
  }
}

/** Fisher-Yates, on a copy. */
function shuffled(ids: number[]): number[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function randomOf(ids: number[]): number {
  const picked = ids[Math.floor(Math.random() * ids.length)];
  if (picked === undefined) throw new Error("shuffle: cannot draw from an empty list");
  return picked;
}
