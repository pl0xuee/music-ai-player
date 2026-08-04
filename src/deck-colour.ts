import type { DeckId } from "./audio/player";

/**
 * The colour of each deck, and how to read the one that is currently sounding.
 *
 * This is the whole visual idea of the interface. The player never has a gap —
 * two decks overlap for eight seconds at every change — and that handover is
 * the thing it does that other players do not. So the accent is not a brand
 * colour, it is a *reading*: it says which deck is carrying the music, and
 * during a crossfade it sits between the two exactly as the audio does.
 *
 * Kept in sync with `--deck-a` / `--deck-b` in styles.css by hand, because
 * canvas cannot read custom properties and the visualiser needs the same
 * numbers the CSS is using.
 */
const DECK_RGB: Record<DeckId, [number, number, number]> = {
  A: [255, 107, 61],
  B: [61, 165, 255],
};

export interface LiveColour {
  /** `"r, g, b"`, for `rgba()` and for the canvas. */
  rgb: string;
  /** `"rgb(r, g, b)"`, for anything taking a plain colour. */
  css: string;
}

function mix(from: [number, number, number], to: [number, number, number], t: number): LiveColour {
  const at = Math.min(Math.max(t, 0), 1);
  // Straight sRGB interpolation, and the muddy middle is the point: ember and
  // arc pass through a neutral grey at t = 0.5, which is exactly where the two
  // decks are equally loud. The colour is as ambiguous as the audio is.
  const step = (i: 0 | 1 | 2): number => Math.round(from[i] + (to[i] - from[i]) * at);
  const [r, g, b] = [step(0), step(1), step(2)];
  return { rgb: `${r}, ${g}, ${b}`, css: `rgb(${r}, ${g}, ${b})` };
}

/**
 * The accent for right now.
 *
 * `progress` is the running crossfade's 0→1, or null when nothing is handing
 * over — in which case the answer is simply the active deck's own colour.
 */
export function liveColour(active: DeckId, progress: number | null): LiveColour {
  const from = DECK_RGB[active];
  if (progress === null) return mix(from, from, 0);
  return mix(from, DECK_RGB[active === "A" ? "B" : "A"], progress);
}

/** The flat colour of one deck, for the arriving side of a handover. */
export function deckColour(deck: DeckId): LiveColour {
  return mix(DECK_RGB[deck], DECK_RGB[deck], 0);
}
