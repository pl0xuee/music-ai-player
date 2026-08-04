import type { PlayerCrossfade } from "../audio/player";
import type { Track } from "../types";
import { isGenerated } from "../types";
import { clock } from "../format";

interface Props {
  playing: boolean;
  canPlay: boolean;
  onToggle: () => void;
  onSkip: () => void;
  volume: number;
  onVolume: (level: number) => void;
  genre: string;
  genreOptions: string[];
  onGenre: (genre: string) => void;
  current: Track | null;
  queued: Track | null;
  fade: PlayerCrossfade | null;
  onRate: (rating: number) => void;
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
  /** The arriving deck's colour, or null when nothing is handing over. */
  incoming: string | null;
}

/**
 * The dock: the controls that must work whatever the library is showing.
 *
 * The scrub bar doubles as the handover display. During a crossfade the
 * arriving deck's colour washes in from the right end in step with the fade,
 * so the one place the eye already goes for position also answers "what is
 * coming, and how soon" — no second meter to read or explain.
 */
export function Transport(props: Props) {
  const {
    playing,
    canPlay,
    onToggle,
    onSkip,
    volume,
    onVolume,
    genre,
    genreOptions,
    onGenre,
    current,
    queued,
    fade,
    onRate,
    position,
    duration,
    onSeek,
    incoming,
  } = props;

  const rating = current?.rating ?? 0;
  const fading = fade !== null && fade.progress < 1;
  const length = duration > 0 ? duration : (current?.duration ?? 0);
  const played = length > 0 ? Math.min(position / length, 1) : 0;

  return (
    <footer className="dock" aria-label="Transport">
      <div className="dock-group">
        <button
          type="button"
          className="play"
          onClick={onToggle}
          disabled={!canPlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="2" width="4" height="12" rx="1" />
              <rect x="9" y="2" width="4" height="12" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2.5v11a.6.6 0 0 0 .92.5l8.5-5.5a.6.6 0 0 0 0-1L4.92 2a.6.6 0 0 0-.92.5Z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="step"
          onClick={onSkip}
          disabled={!canPlay}
          aria-label="Skip to next track"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3.2v9.6a.5.5 0 0 0 .77.42L11 8.42a.5.5 0 0 0 0-.84L3.77 2.78A.5.5 0 0 0 3 3.2Z" />
            <rect x="11.6" y="3" width="2" height="10" rx="1" />
          </svg>
        </button>
      </div>

      <div className="scrub">
        <span className="scrub-time is-elapsed">{length > 0 ? clock(position) : "--:--"}</span>
        <div className="scrub-rail">
          <div className="scrub-played" style={{ width: `${played * 100}%` }} />
          {/* Grows from the right as the handover runs, in the colour of the
              deck that is arriving. */}
          <div
            className="scrub-incoming"
            style={{
              width: fading ? `${(fade?.progress ?? 0) * 100}%` : "0%",
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
              ...({ "--incoming": incoming ?? "transparent" } as React.CSSProperties),
            }}
          />
          <div className="scrub-head" style={{ left: `${played * 100}%` }} />
          <input
            className="scrub-input"
            type="range"
            min={0}
            max={length > 0 ? length : 1}
            step={0.1}
            value={Math.min(position, length)}
            disabled={current === null || length === 0}
            aria-label="Seek"
            onChange={(event) => onSeek(Number(event.target.value))}
          />
        </div>
        <span className="scrub-time">
          {length > 0 ? `-${clock(Math.max(0, length - position))}` : "--:--"}
        </span>
      </div>

      <div className="dock-group">
        <div
          className={fading ? "next is-fading" : "next"}
          style={
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            ({ "--incoming": incoming ?? "transparent" } as React.CSSProperties)
          }
        >
          <span className="next-key">{fading ? "Handing to" : "Next"}</span>
          <span className="next-title">
            {queued === null
              ? "nothing queued"
              : isGenerated(queued)
                ? `${queued.title} · ${queued.bpm} BPM`
                : queued.title}
          </span>
        </div>

        <button
          type="button"
          className={rating === 1 ? "btn is-on" : "btn"}
          onClick={() => onRate(rating === 1 ? 0 : 1)}
          disabled={current === null}
          aria-pressed={rating === 1}
          title="Star this track"
        >
          Star
        </button>
        <button
          type="button"
          className={rating === -1 ? "btn is-on" : "btn"}
          onClick={() => onRate(rating === -1 ? 0 : -1)}
          disabled={current === null}
          aria-pressed={rating === -1}
          title="Bury this track so shuffle stops offering it"
        >
          Bury
        </button>

        <select
          className="select"
          value={genre}
          onChange={(event) => onGenre(event.target.value)}
          aria-label="Filter by genre"
        >
          <option value="all">All genres</option>
          {genreOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <span className="dock-label">Vol</span>
        <input
          className="range is-short"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(event) => onVolume(Number(event.target.value))}
          aria-label="Volume"
        />
      </div>
    </footer>
  );
}
