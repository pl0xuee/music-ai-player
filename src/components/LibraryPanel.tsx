import type { PanelView } from "./PanelTabs";
import { PanelTabs } from "./PanelTabs";
import type { Track } from "../types";
import { isImported } from "../types";
import { key } from "../format";

interface Props {
  view: PanelView;
  onView: (view: PanelView) => void;
  playlistCount: number;
  tracks: Track[];
  currentId: number | null;
  queuedId: number | null;
  onPlay: (track: Track) => void;
  /** Set when a playlist is selected, so rows can offer to join it. */
  addTarget: { id: number; name: string } | null;
  onAdd: (track: Track) => void;
}

export function LibraryPanel(props: Props) {
  const { view, onView, playlistCount, tracks, currentId, queuedId, onPlay, addTarget, onAdd } =
    props;

  return (
    <aside className="aside" aria-label="Library">
      <header className="lib-head">
        <PanelTabs view={view} onView={onView} playlistCount={playlistCount} />
        <span className="lib-count">{tracks.length} ready</span>
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
                <span className="row-index">{String(index + 1).padStart(3, "0")}</span>
                <span className="row-title">{track.title}</span>
                {/* An import has no tempo or key, so the channel takes both
                    columns rather than showing two dashes. */}
                {isImported(track) ? (
                  <span className="row-uploader">{track.uploader ?? "YouTube"}</span>
                ) : (
                  <>
                    <span className="row-bpm">{track.bpm}</span>
                    <span className="row-key">{key(track.keyScale)}</span>
                  </>
                )}
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

/** Mirrors the schema's rating values rather than inventing new symbols. */
function marker(track: Track, queuedId: number | null): string {
  if (track.id === queuedId) return "»";
  if (track.rating === 1) return "+";
  if (track.rating === -1) return "−";
  return "";
}
