import { useEffect, useRef, useState } from "react";
import type { PanelView } from "./PanelTabs";
import { PanelTabs } from "./PanelTabs";
import type { Playlist, Track } from "../types";
import { SOURCE_LABEL, isGenerated, meaningfulGenre } from "../types";
import { clock, key } from "../format";

interface Props {
  view: PanelView;
  onView: (view: PanelView) => void;
  playlistCount: number;
  onRefresh: () => void;
  refreshing: boolean;
  genre: string;
  genreOptions: string[];
  onGenre: (genre: string) => void;
  tracks: Track[];
  currentId: number | null;
  queuedId: number | null;
  onPlay: (track: Track) => void;
  /** Every playlist, so a row can offer all of them rather than one. */
  playlists: Playlist[];
  onAddTo: (track: Track, playlistId: number) => void;
  /** Make a playlist and put this track in it, in one go. */
  onCreateWith: (track: Track, name: string) => void;
}

export function LibraryPanel(props: Props) {
  const {
    view,
    onView,
    playlistCount,
    onRefresh,
    refreshing,
    genre,
    genreOptions,
    onGenre,
    tracks,
    currentId,
    queuedId,
    onPlay,
    playlists,
    onAddTo,
    onCreateWith,
  } = props;

  // The row whose playlist menu is open, and the name being typed if the user
  // asked for a new playlist. Only one menu is ever open, so this is a single
  // id rather than a set.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setMenuFor(null);
    setDraft(null);
  };

  // A menu that can only be dismissed by picking something is a trap, so both
  // of the ways people expect to escape one are wired up. `mousedown` rather
  // than `click`, or choosing an item would close the menu on the way down and
  // never deliver the click.
  useEffect(() => {
    if (menuFor === null) return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  return (
    <aside className="aside" aria-label="Library">
      <header className="lib-head">
        <PanelTabs view={view} onView={onView} playlistCount={playlistCount} />
        <div className="lib-tools">
          {genreOptions.length > 0 && (
            <select
              className="select is-quiet"
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
          )}
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
          const classes = ["row", "is-pl"];
          if (track.id === currentId) classes.push("is-current");
          if (track.rating === -1) classes.push("is-buried");
          const open = menuFor === track.id;

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

              {/* Offered on every row, always. This used to appear only while a
                  playlist happened to be selected on the other tab, which meant
                  the way to put a track in a playlist was to go and select one
                  first — and nothing on this tab said so. */}
              <div className="row-tools">
                <button
                  type="button"
                  className="icon"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={() => (open ? close() : (setDraft(null), setMenuFor(track.id)))}
                  aria-label={`Add ${track.title} to a playlist`}
                  title="Add to a playlist"
                >
                  +
                </button>

                {open && (
                  <div className="pl-menu" role="menu" ref={menuRef}>
                    <p className="pl-menu-head">Add to</p>
                    {playlists.map((playlist) => (
                      <button
                        key={playlist.id}
                        type="button"
                        role="menuitem"
                        className="pl-menu-item"
                        onClick={() => {
                          onAddTo(track, playlist.id);
                          close();
                        }}
                      >
                        <span className="pl-menu-name">{playlist.name}</span>
                        <span className="pl-menu-count">{playlist.itemCount}</span>
                      </button>
                    ))}

                    {draft === null ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="pl-menu-item is-new"
                        onClick={() => setDraft("")}
                      >
                        New playlist…
                      </button>
                    ) : (
                      <form
                        className="pl-menu-new"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const name = draft.trim();
                          if (name === "") return;
                          onCreateWith(track, name);
                          close();
                        }}
                      >
                        <input
                          className="input"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          placeholder="Playlist name"
                          aria-label="Name for the new playlist"
                          autoFocus
                        />
                      </form>
                    )}
                  </div>
                )}
              </div>
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
