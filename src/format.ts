/** `3:07` — track-length scale. */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "--:--";
  }
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** `14h 22m` — library-total scale. */
export function span(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * `6m12s` — run-progress scale.
 *
 * Deliberately the same shape as the generator's own `fmt_hms`, so an ETA read
 * off the panel and one read out of a terminal are visibly the same number.
 */
export function hms(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "--";
  }
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** `A minor` -> `A MIN`, so the readout stays a fixed width. */
export function key(keyScale: string): string {
  return keyScale
    .replace(/minor/i, "min")
    .replace(/major/i, "maj")
    .toUpperCase();
}
