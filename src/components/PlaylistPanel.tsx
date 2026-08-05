import { useState } from "react";

import type { PanelView } from "./PanelTabs";
import { PanelTabs } from "./PanelTabs";
import { Picker } from "./Picker";
import type { CurationExport, Playlist, PlaylistItem } from "../types";
import { clock, span } from "../format";

interface Props {
  view: PanelView;
  onView: (view: PanelView) => void;
  playlists: Playlist[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  items: PlaylistItem[];
  currentId: number | null;
  queuedId: number | null;
  /** True when the transport is drawing its next track from this playlist. */
  playingFrom: boolean;
  onPlay: (item: PlaylistItem) => void;
  onCreate: (name: string) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  onClear: (id: number) => void;
  onRemoveItem: (itemId: number) => void;
  onMoveItem: (itemId: number, position: number) => void;
  onAddUrls: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** The last export, so the panel can show where the files actually went. */
  curation: CurationExport | null;
  curating: boolean;
  onCurateExport: () => void;
  onCurateApply: () => void;
}

export function PlaylistPanel(props: Props) {
  const {
    view,
    onView,
    playlists,
    selectedId,
    onSelect,
    items,
    currentId,
    queuedId,
    playingFrom,
    onPlay,
    onCreate,
    onRename,
    onDelete,
    onClear,
    onRemoveItem,
    onMoveItem,
    onAddUrls,
    onRefresh,
    refreshing,
    curation,
    curating,
    onCurateExport,
    onCurateApply,
  } = props;

  // `null` means the name editor is closed; "" is a legitimate in-progress
  // value while the user is still typing, so the two cannot be conflated.
  const [draft, setDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [showCurate, setShowCurate] = useState(false);

  const selected = playlists.find((p) => p.id === selectedId) ?? null;

  const submit = (): void => {
    if (draft === null) return;
    const name = draft.trim();
    if (name.length > 0) {
      if (renaming && selected !== null) onRename(selected.id, name);
      else if (!renaming) onCreate(name);
    }
    setDraft(null);
    setRenaming(false);
  };

  return (
    <aside className="aside" aria-label="Playlists">
      <header className="lib-head">
        <PanelTabs view={view} onView={onView} playlistCount={playlists.length} />
        <div className="lib-tools">
          <span className="lib-count">
            {selected === null ? `${playlists.length} saved` : `${selected.itemCount} tracks`}
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

      <div className="pl-body">
        <div className="pl-controls">
          <Picker
            className="is-wide"
            label="Select a playlist"
            value={selectedId === null ? "" : String(selectedId)}
            onChange={(next) => onSelect(next === "" ? null : Number(next))}
            options={[
              { value: "", label: "— no playlist —" },
              ...playlists.map((playlist) => ({
                value: String(playlist.id),
                label: playlist.name,
                // The count sets itself apart from the name rather than being
                // bracketed onto the end of it.
                hint: String(playlist.itemCount),
              })),
            ]}
          />

          <div className="pl-actions">
            <button
              type="button"
              className="btn is-tight"
              onClick={() => {
                setRenaming(false);
                setDraft("");
              }}
              title="Create a playlist"
            >
              New
            </button>
            <button
              type="button"
              className="btn is-tight"
              disabled={selected === null}
              onClick={() => {
                setRenaming(true);
                setDraft(selected?.name ?? "");
              }}
              title="Rename this playlist"
            >
              Rename
            </button>
            <button
              type="button"
              className="btn is-tight"
              disabled={selected === null || items.length === 0}
              onClick={() => selected !== null && onClear(selected.id)}
              title="Remove every track from this playlist"
            >
              Empty
            </button>
            <button
              type="button"
              className="btn is-tight"
              disabled={selected === null}
              onClick={() => selected !== null && onDelete(selected.id)}
              title="Delete this playlist — the audio files are kept"
            >
              Delete
            </button>
          </div>

          {draft !== null && (
            <form
              className="pl-name"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <input
                className="input"
                autoFocus
                value={draft}
                placeholder={renaming ? "New name" : "Playlist name"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setDraft(null);
                    setRenaming(false);
                  }
                }}
                aria-label={renaming ? "New playlist name" : "Playlist name"}
              />
              <button type="submit" className="btn is-primary is-tight">
                {renaming ? "Save" : "Create"}
              </button>
            </form>
          )}

          <button
            type="button"
            className="btn is-primary is-block"
            onClick={onAddUrls}
            title="Paste one or many YouTube links"
          >
            Paste YouTube URLs
          </button>

          {/* Sorting a library into playlists is a judgement about music, which
              is the one part of this the app has no business guessing at — and
              exactly what a language model is good at. So the app asks the
              question in a file and takes the answer back in another, without
              ever talking to a model itself. */}
          <button
            type="button"
            className="btn is-block"
            onClick={() => setShowCurate(!showCurate)}
            aria-expanded={showCurate}
            title="Have an AI sort the library into playlists"
          >
            {showCurate ? "Hide AI curation" : "Curate with AI…"}
          </button>

          {showCurate && (
            <div className="curate">
              <p className="curate-note">
                Nothing here talks to a model. The library is written to a file and a plan is read
                back from one, so this works with whatever assistant you already have — or none.
              </p>

              <div className="curate-step">
                <button
                  type="button"
                  className="btn is-tight"
                  onClick={onCurateExport}
                  disabled={curating}
                >
                  {curation === null ? "1 · Export library" : "1 · Export again"}
                </button>
                {curation !== null && (
                  <>
                    <p className="curate-note">
                      {curation.tracks} tracks written. Point your AI at this folder and tell it to
                      follow <code>PROMPT.md</code>:
                    </p>
                    <code className="curate-path">{curation.dir}</code>
                  </>
                )}
              </div>

              <div className="curate-step">
                <button
                  type="button"
                  className="btn is-tight"
                  onClick={onCurateApply}
                  disabled={curating}
                >
                  2 · Apply plan
                </button>
                <p className="curate-note">
                  Reads <code>plan.json</code> from that folder. It only ever adds — no playlist is
                  emptied or deleted, so running a plan twice is safe.
                </p>
              </div>
            </div>
          )}
        </div>

        {selected === null ? (
          <p className="pl-hint">
            {playlists.length === 0
              ? "No playlists yet. Create one, then paste YouTube links into it — each one is downloaded to the library and plays like any other track."
              : "Pick a playlist to see what is in it."}
          </p>
        ) : items.length === 0 ? (
          <p className="pl-hint">
            “{selected.name}” is empty. Paste YouTube links to fill it, or drop tracks in from the
            library.
          </p>
        ) : (
          <>
            <div className="pl-meta">
              <span className={playingFrom ? "pl-meta-key is-live" : "pl-meta-key"}>
                {playingFrom ? "Playing in order" : "Click a track to start"}
              </span>
              <span>{span(selected.seconds)}</span>
            </div>
            <div className="lib-list">
              {items.map((item, index) => {
                const classes = ["row", "is-pl"];
                if (item.id === currentId) classes.push("is-current");
                if (item.rating === -1) classes.push("is-buried");
                const missing = item.path === null;
                if (missing) classes.push("is-missing");

                return (
                  <div className={classes.join(" ")} key={item.itemId}>
                    <button
                      type="button"
                      className="row-main"
                      onClick={() => onPlay(item)}
                      disabled={missing}
                      aria-current={item.id === currentId}
                      title={missing ? "The audio file for this track is missing" : item.title}
                    >
                      <span className="row-index">{String(index + 1).padStart(3, "0")}</span>
                      <span className="row-stack">
                        <span className="row-title">{item.title}</span>
                        <span className="row-sub">
                          {item.uploader ?? item.genre}
                          {missing && <span className="row-warn"> · file missing</span>}
                        </span>
                      </span>
                      <span className="row-time">{clock(item.duration)}</span>
                      <span className={item.id === queuedId ? "row-mark is-up" : "row-mark"}>
                        {item.id === queuedId ? "»" : ""}
                      </span>
                    </button>
                    <div className="row-tools">
                      <button
                        type="button"
                        className="icon"
                        onClick={() => onMoveItem(item.itemId, index - 1)}
                        disabled={index === 0}
                        aria-label={`Move ${item.title} up`}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="icon"
                        onClick={() => onMoveItem(item.itemId, index + 1)}
                        disabled={index === items.length - 1}
                        aria-label={`Move ${item.title} down`}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="icon"
                        onClick={() => onRemoveItem(item.itemId)}
                        aria-label={`Remove ${item.title} from the playlist`}
                        title="Remove from playlist"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
