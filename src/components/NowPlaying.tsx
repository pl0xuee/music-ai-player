import type { Track } from "../types";
import { isImported } from "../types";
import type { DeckId } from "../audio/player";
import { clock, key } from "../format";

interface Props {
  track: Track | null;
  deck: DeckId;
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
}

export function NowPlaying({ track, deck, position, duration, onSeek }: Props) {
  const tags = track === null ? [] : splitPrompt(track.prompt);
  const length = duration > 0 ? duration : (track?.duration ?? 0);
  // An imported track has no tempo, key or prompt — the columns those would
  // fill show what it does have instead of a row of placeholders.
  const imported = track !== null && isImported(track);

  return (
    <section className="now" aria-label="Now playing">
      <div className="now-eyebrow">
        <span>Now playing</span>
        <span className="now-deck">Deck {deck}</span>
      </div>

      {track === null ? (
        <h1 className="now-title is-idle">Nothing loaded — pick a track or hit play.</h1>
      ) : (
        <h1 className="now-title">{track.title}</h1>
      )}

      <div className="now-meta">
        {imported && track !== null ? (
          <>
            <Cell label="Channel" value={track.uploader ?? "unknown"} accent />
            <Cell label="Source" value="YouTube" />
          </>
        ) : (
          <>
            <Cell label="Tempo" value={track === null ? "---" : `${track.bpm} BPM`} accent />
            <Cell label="Key" value={track === null ? "---" : key(track.keyScale)} />
            <Cell label="Genre" value={track?.genre ?? "---"} />
          </>
        )}
        <Cell label="Length" value={clock(length)} />
        <Cell label="Plays" value={track === null ? "---" : String(track.playCount)} />
      </div>

      {tags.length > 0 && (
        <div className="prompt">
          <span className="prompt-key">Generated from</span>
          <div className="prompt-tags">
            {tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="scrub">
        <span className="scrub-time is-elapsed">{length > 0 ? clock(position) : "--:--"}</span>
        <input
          className="range"
          type="range"
          min={0}
          max={length > 0 ? length : 1}
          step={0.1}
          value={Math.min(position, length)}
          disabled={track === null || length === 0}
          aria-label="Seek"
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <span className="scrub-time">
          {length > 0 ? `-${clock(Math.max(0, length - position))}` : "--:--"}
        </span>
      </div>
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
