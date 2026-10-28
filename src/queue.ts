import type { PlaylistItem, Track } from "./types";

/**
 * The track after `current` in the playlist, wrapping at the end.
 *
 * Rows whose file has gone missing are stepped over rather than handed to the
 * player — both the ones the database never had a path for and the ones the
 * resolver has since failed on, which the column cannot tell us about. A
 * `current` that is not in this playlist at all starts it from the top, which
 * is what happens when the user was shuffling and then clicks a playlist row.
 *
 * Returns null when the playlist has nothing playable *left*, which stops the
 * player rather than looping on a dead entry — and that includes a playlist
 * whose only playable entry is the one already playing: handing that back
 * would load the same file onto both decks and crossfade it into itself.
 */
export function nextInPlaylist(
  items: PlaylistItem[],
  current: Track | null,
  dead: ReadonlySet<number>,
): PlaylistItem | null {
  // Located in the whole list, not in the playable subset: a track that has
  // just been found dead is no longer in that subset, and searching it for one
  // would send the walk back to the top of the playlist instead of on to the
  // entry after it.
  const usable = (item: PlaylistItem): boolean =>
    item.path !== null && !dead.has(item.id) && item.id !== current?.id;
  const at = current === null ? -1 : items.findIndex((item) => item.id === current.id);
  for (let step = 1; step <= items.length; step += 1) {
    const item = items[(at + step) % items.length];
    if (item !== undefined && usable(item)) return item;
  }
  return null;
}
