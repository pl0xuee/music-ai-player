import { useEffect, useMemo, useRef, useState } from "react";
import type { PanelView } from "./PanelTabs";
import { PanelTabs } from "./PanelTabs";
import { Picker } from "./Picker";
import type { Playlist, Track } from "../types";
import { SOURCE_LABEL, isGenerated, meaningfulGenre } from "../types";
import { clock, key } from "../format";
import { searchTracks } from "../search";

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

  // The search lives here rather than in App because nothing outside this panel
  // reads it. The genre filter is App's because the shuffle bag draws through
  // it — narrowing the genre really does change what plays next. Typing here
  // does not: it changes what is on screen, and the queue keeps drawing from
  // the whole filtered library, which is what every player does and what makes
  // it safe to search while something is playing.
  const [query, setQuery] = useState("");
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const found = useMemo(() => searchTracks(tracks, query), [tracks, query]);
  const searching = found !== tracks;

  // Reaching the field without the mouse, by both of the shortcuts people try.
  // Neither takes a keystroke off a field that already has focus — including
  // this one, where "/" is a character someone may well be searching for.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const wanted = event.key === "/" || (event.key === "f" && (event.ctrlKey || event.metaKey));
      if (!wanted) return;
      const target = event.target;
      if (target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(target.tagName)) return;
      // A drawer is open over this panel, so the keystroke belongs to it. Asked
      // of the document rather than of the target, because nothing inside a
      // drawer need have focus for the drawer to be the thing being used.
      if (document.querySelector(".genpanel.is-open") !== null) return;
      event.preventDefault();
      fieldRef.current?.focus();
      fieldRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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

        {/* Beside the tabs rather than on a line of its own: a few words is all
            a query ever is, and a field that wide leaves the header's second
            line carrying almost nothing. */}
        <div className="lib-find">
          <svg className="lib-find-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m15.4 15.4 4.6 4.6" />
          </svg>
          <input
            ref={fieldRef}
            type="text"
            className="input is-find"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape empties a field with something in it and steps out of
              // one without, so it is never a key that appears to do nothing.
              if (query === "") event.currentTarget.blur();
              else setQuery("");
            }}
            placeholder="Search title, artist, genre"
            aria-label="Search the library"
            title="Search the library — Ctrl+F, or /"
            spellCheck={false}
            autoComplete="off"
          />
          {query !== "" && (
            <button
              type="button"
              className="lib-find-clear"
              onClick={() => {
                setQuery("");
                fieldRef.current?.focus();
              }}
              aria-label="Clear the search"
              title="Clear the search"
            >
              ✕
            </button>
          )}
        </div>

        <div className="lib-tools">
          {genreOptions.length > 0 && (
            <Picker
              className="is-quiet"
              label="Filter by genre"
              value={genre}
              onChange={onGenre}
              options={[
                { value: "all", label: "All genres" },
                ...genreOptions.map((option) => ({ value: option, label: option })),
              ]}
            />
          )}
          <span className="lib-count">
            {searching ? `${found.length} of ${tracks.length}` : `${tracks.length} ready`}
          </span>
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

      {/* Inside the scroller rather than beside it: `.aside` is a two-row grid,
          and a third child would land in an implicit row and take the list out
          of the one that scrolls. */}
      <div className="lib-list">
        {searching && found.length === 0 && (
          // Naming the genre matters. A filter set at the other end of the
          // header is the likeliest reason a track that really is in the
          // library cannot be found, and it is not what the eye is on while
          // typing.
          <p className="lib-none" role="status">
            Nothing matches “{query.trim()}”
            {genre === "all" ? "" : ` in ${genre}`}.
          </p>
        )}

        {found.map((track, index) => {
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
