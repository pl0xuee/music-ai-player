import type { Track } from "../types";
import { creditFor, isGenerated, meaningfulGenre } from "../types";
import type { DeckId } from "../audio/player";
import { clock, key } from "../format";

interface Props {
  track: Track | null;
  deck: DeckId;
  onRate: (rating: number) => void;
  /** Falls back to the row's stored length before the element reports one. */
  duration: number;
}

/**
 * The stage: what is playing, in the largest type in the interface.
 *
 * Scrubbing lives in the dock rather than here, where it is reachable whatever
 * the library is doing. This half is for reading at a glance from across a
 * desk, which is how the player is used — it sits behind an editor and gets
 * looked at, not operated.
 */
export function NowPlaying({ track, deck, duration, onRate }: Props) {
  const rating = track?.rating ?? 0;
  const tags = track === null ? [] : splitPrompt(track.prompt);
  const length = duration > 0 ? duration : (track?.duration ?? 0);

  return (
    <section className="now" aria-label="Now playing">
      <div className="now-eyebrow">
        <span>Now playing</span>
        {/* The deck letter is the key to the colour the whole interface is
            wearing, so it is named rather than left for the user to infer. */}
        <span className="now-deck">Deck {deck}</span>

        {/* Rating acts on this track, so it belongs beside it rather than in
            the transport, where it sat among controls that act on playback. */}
        {track !== null && (
          <span className="rate">
            <button
              type="button"
              className={rating === 1 ? "rate-btn is-on" : "rate-btn"}
              onClick={() => onRate(rating === 1 ? 0 : 1)}
              aria-pressed={rating === 1}
              title="Star this track"
              aria-label="Star this track"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4.6l2.3 4.9 5.2.7-3.8 3.6 1 5.2-4.7-2.6-4.7 2.6 1-5.2L4.5 10.2l5.2-.7Z" />
              </svg>
            </button>
            <button
              type="button"
              className={rating === -1 ? "rate-btn is-on" : "rate-btn"}
              onClick={() => onRate(rating === -1 ? 0 : -1)}
              aria-pressed={rating === -1}
              title="Bury this track so shuffle stops offering it"
              aria-label="Bury this track"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 7.5h14" />
                <path d="M9.5 7.5V5.8h5v1.7" />
                <path d="M6.6 7.5l.9 11h9l.9-11" />
              </svg>
            </button>
          </span>
        )}
      </div>

      {track === null ? (
        <h1 className="now-title is-idle">Nothing playing. Pick a track, or press play.</h1>
      ) : (
        <h1 className={`now-title ${titleScale(track.title)}`} title={track.title}>
          {track.title}
        </h1>
      )}

      <div className="now-meta">
        {track !== null && isGenerated(track) ? (
          <>
            <Cell label="Tempo" value={`${track.bpm} BPM`} accent />
            <Cell label="Key" value={key(track.keyScale)} />
            <Cell label="Genre" value={track.genre} />
          </>
        ) : track !== null ? (
          <>
            {/* Nothing imported or adopted has a tempo or key, so the space
                goes to who made it instead of to two dashes. */}
            <Cell label={creditFor(track).label} value={creditFor(track).value} accent />
            {meaningfulGenre(track) !== null && (
              <Cell label="Genre" value={meaningfulGenre(track) ?? ""} />
            )}
          </>
        ) : (
          <Cell label="Tempo" value="—" />
        )}
        <Cell label="Length" value={clock(length)} />
        {track !== null && <Cell label="Plays" value={String(track.playCount)} />}
      </div>

      {tags.length > 0 && (
        <div className="prompt">
          <span className="prompt-key">Prompt</span>
          <div className="prompt-tags">
            {tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="meta-cell">
      <span className="meta-key">{label}</span>
      <span className={accent === true ? "meta-val is-accent" : "meta-val"}>{value}</span>
    </div>
  );
}

/**
 * Type size for the title, stepped down as it gets longer.
 *
 * A generated title is two or three words and wants to be the biggest thing on
 * screen. A YouTube title is a sentence with the upload date in it, and setting
 * that at the same size fills the stage and still ends in an ellipsis. Scaling
 * by length lets both be read: the short ones stay a headline, the long ones
 * shrink until they fit rather than being cut off.
 */
function titleScale(title: string): string {
  if (title.length > 62) return "is-tiny";
  if (title.length > 34) return "is-long";
  return "";
}

/** The generator writes prompts as comma-joined tags; show them as such. */
function splitPrompt(prompt: string): string[] {
  const seen = new Set<string>();
  return prompt
    .split(",")
    .map((part) => part.trim())
    .filter((part) => {
      if (part.length === 0 || seen.has(part)) return false;
      seen.add(part);
      return true;
    });
}
