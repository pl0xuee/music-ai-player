import type { Track } from "../types";
import { creditFor, isGenerated, meaningfulGenre } from "../types";
import type { DeckId } from "../audio/player";
import { clock, key } from "../format";

interface Props {
  track: Track | null;
  deck: DeckId;
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
export function NowPlaying({ track, deck, duration }: Props) {
  const tags = track === null ? [] : splitPrompt(track.prompt);
  const length = duration > 0 ? duration : (track?.duration ?? 0);

  return (
    <section className="now" aria-label="Now playing">
      <div className="now-eyebrow">
        <span>Now playing</span>
        {/* The deck letter is the key to the colour the whole interface is
            wearing, so it is named rather than left for the user to infer. */}
        <span className="now-deck">Deck {deck}</span>
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
