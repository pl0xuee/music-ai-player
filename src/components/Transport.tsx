import type { PlayerCrossfade } from "../audio/player";
import { CROSSFADE_SECONDS } from "../audio/player";
import type { Track } from "../types";
import { isImported } from "../types";

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
  bagRemaining: number;
  bagSize: number;
}

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
    bagRemaining,
    bagSize,
  } = props;

  const rating = current?.rating ?? 0;
  const fading = fade !== null && fade.progress < 1;
  // Same equal-power law the gain nodes follow, so the meter shows the real
  // shape of the handover rather than a linear approximation of it.
  const angle = ((fade?.progress ?? 0) * Math.PI) / 2;
  const outgoing = fading ? Math.cos(angle) : 1;
  const incoming = fading ? Math.sin(angle) : 0;

  return (
    <footer className="dock" aria-label="Transport">
      <div className="dock-group">
        <button
          type="button"
          className="btn is-primary"
          onClick={onToggle}
          disabled={!canPlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={onSkip}
          disabled={!canPlay}
          aria-label="Skip to next track"
        >
          Skip
        </button>
      </div>

      <div className="handover dock-meters">
        <span className={fading ? "handover-key is-live" : "handover-key"}>
          {fading ? "A▸B" : "XFADE"}
        </span>
        <div className="handover-bars">
          <Bar level={outgoing} quiet={!playing} />
          <Bar level={incoming} quiet={false} />
        </div>
        <span className="handover-caption">
          {fading
            ? `Handing over to ${fade?.to?.title ?? "next"}`
            : queued === null
              ? `Crossfade ${CROSSFADE_SECONDS}s · nothing queued`
              : // An import has no tempo — the row stores 0 — so it names the
                // channel here, the same swap the library rows make.
                `Next · ${queued.title} · ${
                  isImported(queued) ? (queued.uploader ?? "YouTube") : `${queued.bpm} BPM`
                }`}
        </span>
      </div>

      <div className="dock-group">
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

        <span className="dock-label">Bag</span>
        <span className="readout-val">
          {bagRemaining}/{bagSize}
        </span>

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

function Bar({ level, quiet }: { level: number; quiet: boolean }) {
  return (
    <div className="handover-track">
      <div
        className={quiet ? "handover-fill is-quiet" : "handover-fill"}
        style={{ width: `${Math.round(level * 100)}%` }}
      />
    </div>
  );
}
