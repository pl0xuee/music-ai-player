/** Which list the side panel is showing. */
export type PanelView = "library" | "playlists";

interface Props {
  view: PanelView;
  onView: (view: PanelView) => void;
  playlistCount: number;
}

/**
 * The side panel's two views.
 *
 * Deliberately not a "source" switch: both views list rows out of the same
 * local library and both play through the same decks. The only thing that
 * changes is what "next track" draws from — see `App.tsx`.
 */
export function PanelTabs({ view, onView, playlistCount }: Props) {
  return (
    <div className="tabs" role="tablist" aria-label="Side panel view">
      <button
        type="button"
        role="tab"
        className={view === "library" ? "tab is-on" : "tab"}
        aria-selected={view === "library"}
        onClick={() => onView("library")}
      >
        Library
      </button>
      <button
        type="button"
        role="tab"
        className={view === "playlists" ? "tab is-on" : "tab"}
        aria-selected={view === "playlists"}
        onClick={() => onView("playlists")}
      >
        Playlists
        {playlistCount > 0 && <span className="tab-count">{playlistCount}</span>}
      </button>
    </div>
  );
}
