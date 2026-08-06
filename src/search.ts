import type { Track } from "./types";

/**
 * Finding one track in a library by typing at it.
 *
 * The genre picker narrows the list along the one axis the database indexes,
 * and past a few hundred rows everything else is scrolling. This is the other
 * axis: the words on the row.
 *
 * Three rules shape the whole thing.
 *
 *  - Every word has to match, but any of them may match any field, in any
 *    order. So "punk daft" and "daft punk" find the same row, and "aphex
 *    ambient" narrows across the artist and the genre at once — which is how
 *    people actually remember music, in fragments from more than one column.
 *  - Case and accents are ignored on both sides. A library of real music is
 *    full of names nobody types the way they are spelled — Björk, Sigur Rós,
 *    Beyoncé — and a search that only matches the spelling is a search that
 *    fails on exactly the tracks worth finding.
 *  - Only the fields that identify a row are searchable: its title, whoever
 *    made it, its genre and where it came from. Not the generator prompt and
 *    not the file path — matching on those would put rows in the list with no
 *    visible reason to be there, which reads as a bug rather than as a feature.
 */

/**
 * The letters Unicode cannot take apart.
 *
 * An accented letter decomposes into a letter and a mark; a letter that was
 * never an accented letter to begin with does not — ø is its own character
 * rather than an o wearing a stroke. Without these, "bjork" finds Björk and
 * "motley" finds Mötley Crüe, but "slotface" never finds Sløtface: the same
 * promise kept for half a library and quietly broken for the rest.
 */
const WHOLE_LETTERS: Record<string, string> = {
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  æ: "ae",
  œ: "oe",
  ß: "ss",
};

/**
 * Reduce a string to what a search should compare.
 *
 * NFD splits an accented character into its letter and its accent, so dropping
 * every combining mark leaves the plain letter behind: "Björk" folds to
 * "bjork", which is what the user typed. Applied to the query as well as to the
 * rows, so it works in both directions — typing the accent finds the row that
 * has none, and typing none finds the row that has it.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[øđðþłæœß]/g, (letter) => WHOLE_LETTERS[letter] ?? letter);
}

/**
 * The folded text of a row, kept for as long as the row itself.
 *
 * A folder scan will adopt up to 20,000 files, and re-folding every one of them
 * on every keystroke is work whose answer never changes. A WeakMap is the right
 * shape for that cache because it cannot outlive what it describes: rows are
 * replaced wholesale on every library reload, and the old entries go with them.
 */
const folded = new WeakMap<Track, string>();

function haystack(track: Track): string {
  const cached = folded.get(track);
  if (cached !== undefined) return cached;
  const built = fold(
    [track.title, track.uploader ?? "", track.genre, track.source].join(" "),
  );
  folded.set(track, built);
  return built;
}

/** The words a query is asking for, folded the same way the rows are. */
export function queryTerms(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .filter((term) => term !== "");
}

/** True when every word of the query appears somewhere in the row. */
export function matches(track: Track, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const hay = haystack(track);
  return terms.every((term) => hay.includes(term));
}

/**
 * The rows a query keeps, in the order they were given in.
 *
 * Deliberately not ranked. The list is already sorted by something the user
 * chose to see — and a result set that reshuffles itself as the query is typed
 * moves the row being aimed at out from under the pointer.
 *
 * An empty query hands back the same array, so a panel that renders this can
 * tell "nothing typed" from "nothing found" by identity alone.
 */
export function searchTracks<T extends Track>(tracks: T[], query: string): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return tracks;
  return tracks.filter((track) => matches(track, terms));
}
