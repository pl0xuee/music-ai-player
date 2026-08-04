import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GenerationPanel } from "./components/GenerationPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { NowPlaying } from "./components/NowPlaying";
import { PlaylistPanel } from "./components/PlaylistPanel";
import type { PanelView } from "./components/PanelTabs";
import { Transport } from "./components/Transport";
import { Visualizer } from "./components/Visualizer";
import { YouTubePanel } from "./components/YouTubePanel";

import { Player } from "./audio/player";
import type { DeckId, PlayerCrossfade } from "./audio/player";
import { ShuffleBag } from "./audio/shuffle";

import {
  EVENTS,
  addToPlaylist,
  clearPlaylist,
  createPlaylist,
  deletePlaylist,
  genres as fetchGenres,
  libraryStats,
  listPlaylistItems,
  listPlaylists,
  listTracks,
  markPlayed,
  mediaKeyStatus,
  onTransport,
  rateTrack,
  removeItem,
  renamePlaylist,
  reorderItem,
  trackSourceUrl,
} from "./api";
import { EMPTY_STATS, IDLE_RUN } from "./types";
import type { GenerationProgress, Playlist, PlaylistItem, Stats, Track } from "./types";
import { span } from "./format";

export default function App() {
  const bagRef = useRef<ShuffleBag | null>(null);
  bagRef.current ??= new ShuffleBag();
  const bag = bagRef.current;
  const playerRef = useRef<Player | null>(null);

  const [library, setLibrary] = useState<Track[]>([]);
  const [visible, setVisible] = useState<Track[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [genreOptions, setGenreOptions] = useState<string[]>([]);
  const [genre, setGenre] = useState("all");
  const [loaded, setLoaded] = useState(false);

  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [queuedId, setQueuedId] = useState<number | null>(null);
  const [deck, setDeck] = useState<DeckId>("A");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fade, setFade] = useState<PlayerCrossfade | null>(null);
  const [volume, setVolume] = useState(0.8);
  const [bagCounts, setBagCounts] = useState({ remaining: 0, size: 0 });
  const [notice, setNotice] = useState<string | null>(null);

  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [downloading, setDownloading] = useState(0);
  const [run, setRun] = useState<GenerationProgress>(IDLE_RUN);
  // Bumped to re-run both library queries; the generator and the importer both
  // write into the same database while the player reads it, so "reload" is a
  // first-class action rather than a refresh button.
  const [libraryVersion, setLibraryVersion] = useState(0);
  const reloadLibrary = useCallback(() => setLibraryVersion((version) => version + 1), []);

  const [view, setView] = useState<PanelView>("library");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistId, setPlaylistId] = useState<number | null>(null);
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [playlistVersion, setPlaylistVersion] = useState(0);
  const reloadPlaylists = useCallback(() => setPlaylistVersion((v) => v + 1), []);

  /**
   * Where "next track" comes from.
   *
   * `shuffle` draws from the bag over the whole (genre-filtered) library;
   * `playlist` walks the selected playlist in order. This is the *only* piece
   * of state that differs between the two modes — playback, crossfade, the
   * decks and every transport surface are identical either way, because the
   * mode is expressed purely as the `NextSelector` handed to the Player below.
   */
  const [queueMode, setQueueMode] = useState<"shuffle" | "playlist">("shuffle");

  // Read by the media-key handlers, which must not be re-bound on every
  // progress tick just to know where the playhead is.
  const positionRef = useRef(0);
  // Play order as it actually happened, so "previous" means the track you just
  // heard rather than whatever the shuffle bag would draw next.
  const historyRef = useRef<number[]>([]);
  // The Player is constructed once and keeps one selector for its whole life,
  // so the selector reads the queue out of a ref rather than being rebound —
  // rebinding it mid-crossfade would change what is already loaded on the idle
  // deck.
  const queueRef = useRef<{ mode: "shuffle" | "playlist"; items: PlaylistItem[] }>({
    mode: "shuffle",
    items: [],
  });
  useEffect(() => {
    queueRef.current = { mode: queueMode, items };
  });

  const byId = useMemo(() => new Map(library.map((track) => [track.id, track])), [library]);
  const current = currentId === null ? null : (byId.get(currentId) ?? null);
  const queued = queuedId === null ? null : (byId.get(queuedId) ?? null);
  const selectedPlaylist = useMemo(
    () => playlists.find((playlist) => playlist.id === playlistId) ?? null,
    [playlistId, playlists],
  );

  const syncBag = useCallback(() => {
    setBagCounts({ remaining: bag.remaining, size: bag.size });
  }, [bag]);

  // -- audio graph ----------------------------------------------------------

  useEffect(() => {
    const player = new Player((track) => trackSourceUrl(track.id));
    playerRef.current = player;
    // The one definition of "what plays next". Every surface that can advance
    // the player — the Transport button, the tray menu, the media keys, the
    // end of a track, the crossfade preload — arrives here.
    player.setNextSelector((current) => {
      const queue = queueRef.current;
      return queue.mode === "playlist"
        ? nextInPlaylist(queue.items, current)
        : bag.next(current);
    });
    setAnalyser(player.analyser);
    setVolume(player.getVolume());

    const unsubscribe = [
      player.on("trackchange", ({ track, deck: id }) => {
        setCurrentId(track?.id ?? null);
        setDeck(id);
        syncBag();
        if (track === null) return;
        const history = historyRef.current;
        if (history[history.length - 1] !== track.id) history.push(track.id);
        if (history.length > 100) history.splice(0, history.length - 100);
        // Count the play as soon as the deck takes over, not when it ends —
        // a crossfade means the previous track never truly "ends".
        void markPlayed(track.id);
        const bump = (rows: Track[]): Track[] =>
          rows.map((row) => (row.id === track.id ? { ...row, playCount: row.playCount + 1 } : row));
        setLibrary(bump);
        setVisible(bump);
      }),
      player.on("queued", ({ track }) => setQueuedId(track?.id ?? null)),
      player.on("statechange", ({ playing: isPlaying }) => setPlaying(isPlaying)),
      player.on("progress", (event) => {
        positionRef.current = event.position;
        setPosition(event.position);
        setDuration(event.duration);
      }),
      player.on("crossfade", (event) => setFade(event.progress >= 1 ? null : event)),
      player.on("error", ({ message }) => setNotice(message)),
    ];

    return () => {
      for (const off of unsubscribe) off();
      player.dispose();
      playerRef.current = null;
    };
  }, [bag, syncBag]);

  // -- library --------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [tracks, nextStats, options] = await Promise.all([
          listTracks(null),
          libraryStats(),
          fetchGenres(),
        ]);
        if (cancelled) return;
        setLibrary(tracks);
        setStats(nextStats);
        setGenreOptions(options);
        bag.setLibrary(tracks);
        syncBag();
      } catch (err) {
        if (!cancelled) setNotice(describe(err));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bag, libraryVersion, syncBag]);

  useEffect(() => {
    let cancelled = false;
    bag.setGenre(genre);
    syncBag();
    void listTracks(genre === "all" ? null : genre)
      .then((rows) => {
        if (!cancelled) setVisible(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotice(describe(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bag, genre, libraryVersion, syncBag]);

  // -- playlists ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void listPlaylists()
      .then((rows) => {
        if (cancelled) return;
        setPlaylists(rows);
        // A playlist deleted underneath us must not leave a dangling selection.
        setPlaylistId((current) =>
          current !== null && rows.some((row) => row.id === current) ? current : null,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotice(describe(err));
      });
    return () => {
      cancelled = true;
    };
  }, [playlistVersion]);

  useEffect(() => {
    if (playlistId === null) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void listPlaylistItems(playlistId)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotice(describe(err));
      });
    return () => {
      cancelled = true;
    };
  }, [playlistId, playlistVersion, libraryVersion]);

  /** Run a playlist mutation, then refresh both the list and its contents. */
  const mutate = useCallback(
    (action: Promise<unknown>) => {
      void action.then(reloadPlaylists).catch((err: unknown) => setNotice(describe(err)));
    },
    [reloadPlaylists],
  );

  // -- actions --------------------------------------------------------------

  const playTrack = useCallback(
    (track: Track) => {
      bag.markPlayed(track.id);
      syncBag();
      void playerRef.current?.play(track);
    },
    [bag, syncBag],
  );

  /**
   * Play a track and switch the queue to the mode it was picked from.
   *
   * Clicking a playlist row is the only way into `playlist` mode, and clicking
   * a library row is the only way out — the choice is always the user's last
   * explicit action rather than a separate toggle they have to remember.
   */
  const playFrom = useCallback(
    (track: Track, mode: "shuffle" | "playlist") => {
      setQueueMode(mode);
      queueRef.current = { mode, items };
      playTrack(track);
    },
    [items, playTrack],
  );

  const handleToggle = useCallback(() => {
    const player = playerRef.current;
    if (player === null) return;
    if (player.currentTrack !== null) {
      void player.toggle();
      return;
    }
    // Cold start: whichever queue is active decides what the first track is,
    // so pressing Play on a media key does the same thing as pressing it here.
    const first =
      queueMode === "playlist"
        ? nextInPlaylist(items, null)
        : (bag.next(null) ?? visible[0] ?? library[0] ?? null);
    if (first !== null) playTrack(first);
  }, [bag, items, library, playTrack, queueMode, visible]);

  const handleSkip = useCallback(() => {
    void playerRef.current?.skip();
    syncBag();
  }, [syncBag]);

  /**
   * `MediaTrackPrevious`, with the transport convention every other player
   * follows: the first press restarts the current track, a second press within
   * the first few seconds steps back to the previous one.
   */
  const handlePrevious = useCallback(() => {
    const player = playerRef.current;
    if (player === null || player.currentTrack === null) return;

    const history = historyRef.current;
    const previousId = history.length >= 2 ? history[history.length - 2] : undefined;
    if (positionRef.current > 4 || previousId === undefined) {
      player.seek(0);
      return;
    }
    const previous = byId.get(previousId);
    if (previous === undefined) {
      player.seek(0);
      return;
    }
    // Both entries come back on the way in via the trackchange listener.
    history.splice(-2, 2);
    playTrack(previous);
  }, [byId, playTrack]);

  const handleVolume = useCallback((level: number) => {
    playerRef.current?.setVolume(level);
    setVolume(level);
  }, []);

  const handleRate = useCallback(
    (rating: number) => {
      if (currentId === null) return;
      const id = currentId;
      setLibrary((rows) => rows.map((row) => (row.id === id ? { ...row, rating } : row)));
      setVisible((rows) => rows.map((row) => (row.id === id ? { ...row, rating } : row)));
      bag.setRating(id, rating);
      syncBag();
      void rateTrack(id, rating).catch((err: unknown) => setNotice(describe(err)));
    },
    [bag, currentId, syncBag],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      // Don't steal keys from the sliders, the genre picker or the generator
      // drawer, where Space belongs to whatever button has focus.
      if (target instanceof HTMLElement) {
        if (/INPUT|SELECT|TEXTAREA/.test(target.tagName)) return;
        if (target.closest(".genpanel") !== null) return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        handleToggle();
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        handleSkip();
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        handlePrevious();
      } else if (event.code === "ArrowUp") {
        event.preventDefault();
        handleVolume(Math.min(1, volume + 0.05));
      } else if (event.code === "ArrowDown") {
        event.preventDefault();
        handleVolume(Math.max(0, volume - 0.05));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePrevious, handleSkip, handleToggle, handleVolume, volume]);

  /**
   * The tray menu and the OS media keys both arrive here as backend events, so
   * there is exactly one definition of what "next" means no matter which of the
   * three surfaces triggered it. These work while the window is unfocused, and
   * while it is hidden in the tray.
   */
  useEffect(() => {
    const unsubscribe = [
      onTransport(EVENTS.playPause, handleToggle),
      onTransport(EVENTS.next, handleSkip),
      onTransport(EVENTS.previous, handlePrevious),
    ];
    return () => {
      for (const off of unsubscribe) off();
    };
  }, [handlePrevious, handleSkip, handleToggle]);

  // A media key that silently does nothing is worse than one that is missing,
  // so say which surface still works instead of leaving the user guessing.
  useEffect(() => {
    void mediaKeyStatus().then((keys) => {
      if (keys.unclaimed.length > 0) {
        setNotice(
          `${keys.unclaimed.join(", ")} already belongs to another application — use the tray menu instead.`,
        );
      } else if (keys.wayland) {
        setNotice(
          "Media keys are bound through XWayland: on a native Wayland session they may only reach X11 windows. The tray menu always works.",
        );
      }
    });
  }, []);

  // -- render ---------------------------------------------------------------

  const empty = loaded && library.length === 0;

  return (
    <div className="shell">
      <header className="rail">
        <div className="mark">
          <span>
            Music<span className="mark-slash">//</span>AI
          </span>
          <span className="mark-sub">Local library player</span>
        </div>
        <div className="readouts">
          <Readout label="Ready" value={String(stats.ready)} live={stats.ready > 0} />
          <Readout label="Runtime" value={span(stats.playableSeconds)} />
          <Readout label="Queued" value={String(stats.pending + stats.generating)} />
          <Readout label="Failed" value={String(stats.failed)} />
          <button
            type="button"
            className={downloading > 0 ? "rail-action is-live" : "rail-action"}
            onClick={() => setImportOpen((open) => !open)}
            aria-expanded={importOpen}
            title="Paste YouTube links"
          >
            {downloading > 0 && <span className="rail-action-dot" aria-hidden="true" />}
            {downloading > 0 ? `Getting ${downloading}` : "Add URLs"}
          </button>
          <button
            type="button"
            className={run.running ? "rail-action is-live" : "rail-action"}
            onClick={() => setGeneratorOpen((open) => !open)}
            aria-expanded={generatorOpen}
            title="Generate more tracks"
          >
            {run.running && <span className="rail-action-dot" aria-hidden="true" />}
            {run.running && run.total > 0 ? `Gen ${run.current}/${run.total}` : "Generate"}
          </button>
        </div>
      </header>

      {empty ? (
        <EmptyLibrary
          stats={stats}
          onGenerate={() => setGeneratorOpen(true)}
          onImport={() => setImportOpen(true)}
        />
      ) : (
        <main className="stage">
          <div className="deck">
            <Visualizer analyser={analyser} active={playing} />
            <NowPlaying
              track={current}
              deck={deck}
              position={position}
              duration={duration}
              onSeek={(seconds) => playerRef.current?.seek(seconds)}
            />
          </div>
          {view === "library" ? (
            <LibraryPanel
              view={view}
              onView={setView}
              playlistCount={playlists.length}
              tracks={visible}
              currentId={currentId}
              queuedId={queuedId}
              onPlay={(track) => playFrom(track, "shuffle")}
              addTarget={
                selectedPlaylist === null
                  ? null
                  : { id: selectedPlaylist.id, name: selectedPlaylist.name }
              }
              onAdd={(track) => {
                if (selectedPlaylist === null) return;
                mutate(
                  addToPlaylist(selectedPlaylist.id, track.id).then((added) => {
                    if (!added) setNotice(`"${track.title}" is already in that playlist.`);
                  }),
                );
              }}
            />
          ) : (
            <PlaylistPanel
              view={view}
              onView={setView}
              playlists={playlists}
              selectedId={playlistId}
              onSelect={setPlaylistId}
              items={items}
              currentId={currentId}
              queuedId={queuedId}
              playingFrom={queueMode === "playlist"}
              onPlay={(item) => playFrom(item, "playlist")}
              onCreate={(name) =>
                mutate(createPlaylist(name).then((id) => setPlaylistId(id)))
              }
              onRename={(id, name) => mutate(renamePlaylist(id, name))}
              onDelete={(id) =>
                mutate(deletePlaylist(id).then(() => setPlaylistId(null)))
              }
              onClear={(id) => mutate(clearPlaylist(id))}
              onRemoveItem={(itemId) => mutate(removeItem(itemId))}
              onMoveItem={(itemId, position) => mutate(reorderItem(itemId, position))}
              onAddUrls={() => setImportOpen(true)}
            />
          )}
        </main>
      )}

      <Transport
        playing={playing}
        canPlay={library.length > 0}
        onToggle={handleToggle}
        onSkip={handleSkip}
        volume={volume}
        onVolume={handleVolume}
        genre={genre}
        genreOptions={genreOptions}
        onGenre={setGenre}
        current={current}
        queued={queued}
        fade={fade}
        onRate={handleRate}
        bagRemaining={bagCounts.remaining}
        bagSize={bagCounts.size}
      />

      {/* Both drawers stay mounted while closed: work started in either keeps
          going with the drawer shut and the window in the tray, and their
          subscriptions are what keep the rail badges honest. */}
      <GenerationPanel
        open={generatorOpen}
        onClose={() => setGeneratorOpen(false)}
        pending={stats.pending + stats.generating}
        onLibraryChanged={reloadLibrary}
        onRunChange={setRun}
      />

      <YouTubePanel
        open={importOpen}
        onClose={() => setImportOpen(false)}
        playlists={playlists}
        targetId={playlistId}
        onTarget={setPlaylistId}
        onLibraryChanged={() => {
          reloadLibrary();
          reloadPlaylists();
        }}
        onActiveChange={setDownloading}
      />

      {notice !== null && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" className="notice-close" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function Readout({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="readout">
      <span className="readout-key">{label}</span>
      <span className={live === true ? "readout-val is-live" : "readout-val"}>{value}</span>
    </div>
  );
}

function EmptyLibrary({
  stats,
  onGenerate,
  onImport,
}: {
  stats: Stats;
  onGenerate: () => void;
  onImport: () => void;
}) {
  return (
    <section className="empty">
      <span className="empty-key">No tracks yet</span>
      <h1 className="empty-title">The library is empty.</h1>
      <p className="empty-body">
        Two ways to fill it. Paste YouTube links and they are downloaded as mp3s into the library,
        or run the generator and take the 10-track sample. Either way the rows appear here as they
        land, and both play through the same decks.
      </p>
      <div className="empty-row">
        <button type="button" className="btn is-primary" onClick={onImport}>
          Paste YouTube URLs
        </button>
        <button type="button" className="btn" onClick={onGenerate}>
          Open generator
        </button>
      </div>
      <p className="empty-body">Or, from a terminal, the same thing without the window:</p>
      <code className="empty-cmd">./engine/generate.py --tracks 10</code>
      <span className="empty-path">
        {stats.available
          ? `Reading ${stats.libraryPath} — ${stats.total} rows, none ready yet.`
          : `Looking for ${stats.libraryPath || "library/library.db"}. Set MUSIC_AI_LIBRARY to point elsewhere.`}
      </span>
    </section>
  );
}

/**
 * The track after `current` in the playlist, wrapping at the end.
 *
 * Rows whose file has gone missing are stepped over rather than handed to the
 * player, and a `current` that is not in this playlist at all starts it from
 * the top — which is what happens when the user was shuffling and then clicks
 * a playlist row. Returns null only when the playlist has nothing playable,
 * which stops the player rather than looping on a dead entry.
 */
function nextInPlaylist(items: PlaylistItem[], current: Track | null): PlaylistItem | null {
  const playable = items.filter((item) => item.path !== null);
  if (playable.length === 0) return null;

  const at = current === null ? -1 : playable.findIndex((item) => item.id === current.id);
  return playable[(at + 1) % playable.length] ?? null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
