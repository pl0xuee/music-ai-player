import type { PanelView } from "./PanelTabs";
import { PanelTabs } from "./PanelTabs";
import type { Track } from "../types";
import { SOURCE_LABEL, isGenerated, meaningfulGenre } from "../types";
import { clock, key } from "../format";

interface Props {
  view: PanelView;
  onView: (view: PanelView) => void;
  playlistCount: number;
  onRefresh: () => void;
  refreshing: boolean;
  tracks: Track[];
  currentId: number | null;
  queuedId: number | null;
  onPlay: (track: Track) => void;
  /** Set when a playlist is selected, so rows can offer to join it. */
  addTarget: { id: number; name: string } | null;
  onAdd: (track: Track) => void;
}

export function LibraryPanel(props: Props) {
  const { view, onView, playlistCount, onRefresh, refreshing, tracks, currentId, queuedId, onPlay, addTarget, onAdd } =
    props;

  return (
    <aside className="aside" aria-label="Library">
      <header className="lib-head">
        <PanelTabs view={view} onView={onView} playlistCount={playlistCount} />
        <div className="lib-tools">
          <span className="lib-count">{tracks.length} ready</span>
          <button
            type="button"
            className="icon"
            onClick={onRefresh}
            disabled={refreshing}
            title="Re-read the library and drop tracks whose files have gone"
            aria-label="Refresh the library"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.34-5.66" />
              <path d="M20 4v4.5h-4.5" />
            </svg>
          </button>
        </div>
      </header>

      <div className="lib-list">
        {tracks.map((track, index) => {
          const classes = ["row"];
          if (track.id === currentId) classes.push("is-current");
          if (track.rating === -1) classes.push("is-buried");
          if (addTarget !== null) classes.push("is-pl");

          return (
            <div className={classes.join(" ")} key={track.id}>
              <button
                type="button"
                className="row-main is-lib"
                onClick={() => onPlay(track)}
                aria-current={track.id === currentId}
                title={track.title}
              >
                <span className="row-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="row-stack">
                  <span className="row-title">{track.title}</span>
                  <span className="row-sub">{subtitle(track)}</span>
                </span>
                {/* Both cells are always emitted, empty if the row has nothing
                    for them. Each row is its own grid, so a cell left out
                    entirely would shift every column after it out of line with
                    the row above. */}
                <span className="row-bpm">{isGenerated(track) ? `${track.bpm} BPM` : ""}</span>
                <span className="row-key">{isGenerated(track) ? key(track.keyScale) : ""}</span>
                <span className="row-time">{clock(track.duration ?? 0)}</span>
                <span className={track.rating === 1 ? "row-mark is-up" : "row-mark"}>
                  {marker(track, queuedId)}
                </span>
              </button>
              {addTarget !== null && (
                <div className="row-tools">
                  <button
                    type="button"
                    className="icon"
                    onClick={() => onAdd(track)}
                    aria-label={`Add ${track.title} to ${addTarget.name}`}
                    title={`Add to “${addTarget.name}”`}
                  >
                    +
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * The line under the title: who to credit, and where the audio came from.
 *
 * A generated row has no artist, so it shows the genre it was rendered for —
 * which is the closest thing it has to one.
 */
function subtitle(track: Track): string {
  if (isGenerated(track)) return meaningfulGenre(track) ?? SOURCE_LABEL.generated;
  // Artist or channel, then where it came from — and the genre only when it is
  // not just the source repeating itself.
  const parts = [track.uploader, meaningfulGenre(track), SOURCE_LABEL[track.source]];
  return parts.filter((part): part is string => part !== null && part !== "").join(" · ");
}

/** Mirrors the schema's rating values rather than inventing new symbols. */
function marker(track: Track, queuedId: number | null): string {
  if (track.id === queuedId) return "»";
  if (track.rating === 1) return "+";
  if (track.rating === -1) return "−";
  return "";
}
