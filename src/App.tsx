import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GenerationPanel } from "./components/GenerationPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { LocalPanel } from "./components/LocalPanel";
import { CROSSFADE_KEY, SettingsPanel, VOLUME_KEY } from "./components/SettingsPanel";
import { NowPlaying } from "./components/NowPlaying";
import { PlaylistPanel } from "./components/PlaylistPanel";
import type { PanelView } from "./components/PanelTabs";
import { Rail } from "./components/Rail";
import { Transport } from "./components/Transport";
import { Visualizer } from "./components/Visualizer";
import { YouTubePanel } from "./components/YouTubePanel";

import { CROSSFADE_SECONDS, Player } from "./audio/player";
import type { DeckId, PlayerCrossfade } from "./audio/player";
import { ShuffleBag } from "./audio/shuffle";

import {
  EVENTS,
  IN_TAURI,
  addToPlaylist,
  curationApply,
  curationExport,
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
  onFileDrop,
  onTransport,
  pruneMissing,
  reportNowPlaying,
  rateTrack,
  removeItem,
  renamePlaylist,
  reorderItem,
  scanLocal,
  trackSourceUrl,
} from "./api";
import { EMPTY_STATS, IDLE_RUN } from "./types";
import type {
  CurationExport,
  CurationReport,
  GenerationProgress,
  Playlist,
  PlaylistItem,
  Stats,
  Track,
} from "./types";
import { deckColour, liveColour } from "./deck-colour";
import { devPanel } from "./dev-fixtures";

export default function App() {
  const bagRef = useRef<ShuffleBag | null>(null);
  bagRef.current ??= new ShuffleBag();
  const bag = bagRef.current;
  const playerRef = useRef<Player | null>(null);
  /** Read inside the player-construction effect, which must not re-run on it. */
  const volumeRef = useRef(0.8);

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
  const [volume, setVolume] = useState(() => {
    // The stored string is checked before it is converted, because
    // `Number(null)` is 0 rather than NaN — and 0 is a legitimate volume, so a
    // range check cannot tell "muted" from "never set" and a fresh install
    // would start silent.
    const stored = window.localStorage.getItem(VOLUME_KEY);
    if (stored === null) return 0.8;
    const saved = Number(stored);
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 0.8;
  });
  const [bagCounts, setBagCounts] = useState({ remaining: 0, size: 0 });
  const [notice, setNotice] = useState<string | null>(null);

  // Outside the shell the hash can open a drawer straight away, so every
  // surface is reachable by loading a URL. `IN_TAURI` is true in the app, in
  // dev and in a bundled build alike, so this is inert there.
  const [generatorOpen, setGeneratorOpen] = useState(!IN_TAURI && devPanel() === "generate");
  const [importOpen, setImportOpen] = useState(!IN_TAURI && devPanel() === "import");
  const [downloading, setDownloading] = useState(0);
  /** True while a folder scan is walking and probing. */
  const [scanning, setScanning] = useState(false);
  /** True while the library is being re-read and checked for missing files. */
  const [refreshing, setRefreshing] = useState(false);
  const [curation, setCuration] = useState<CurationExport | null>(null);
  const [curating, setCurating] = useState(false);
  /** True while files are being held over the window. */
  const [dropping, setDropping] = useState(false);
  const [run, setRun] = useState<GenerationProgress>(IDLE_RUN);
  // Bumped to re-run both library queries; the generator and the importer both
  // write into the same database while the player reads it, so "reload" is a
  // first-class action rather than a refresh button.
  const [libraryVersion, setLibraryVersion] = useState(0);
  const reloadLibrary = useCallback(() => setLibraryVersion((version) => version + 1), []);

  const [view, setView] = useState<PanelView>(
    !IN_TAURI && devPanel() === "playlists" ? "playlists" : "library",
  );
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
  // Rows the resolver could not turn into a URL. `path` being set only says the
  // database once knew where the file was, so this is the only evidence there
  // is that it is still there; the playlist walker steps over these rather than
  // handing the player a row it already knows is dead. Cleared on every library
  // reload, so a drive that comes back is not remembered as broken.
  const deadRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    queueRef.current = { mode: queueMode, items };
  });

  const byId = useMemo(() => new Map(library.map((track) => [track.id, track])), [library]);
  const current = currentId === null ? null : (byId.get(currentId) ?? null);
  const queued = queuedId === null ? null : (byId.get(queuedId) ?? null);
  const syncBag = useCallback(() => {
    setBagCounts({ remaining: bag.remaining, size: bag.size });
  }, [bag]);

  // -- audio graph ----------------------------------------------------------

  useEffect(() => {
    const dead = deadRef.current;
    const player = new Player(async (track) => {
      try {
        const url = await trackSourceUrl(track.id);
        if (url !== null) {
          dead.delete(track.id);
          return url;
        }
      } catch {
        /* A row the backend cannot resolve is a dead row, whichever way it says so. */
      }
      dead.add(track.id);
      return null;
    });
    playerRef.current = player;
    // The one definition of "what plays next". Every surface that can advance
    // the player — the Transport button, the tray menu, the media keys, the
    // end of a track, the crossfade preload — arrives here.
    player.setNextSelector((current) => {
      const queue = queueRef.current;
      return queue.mode === "playlist"
        ? nextInPlaylist(queue.items, current, dead)
        : bag.next(current);
    });
    setAnalyser(player.analyser);
    player.setVolume(volumeRef.current);

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
    // A reload is the one moment worth trusting the database again: files that
    // failed to resolve may well have been re-downloaded or regenerated.
    deadRef.current.clear();
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
        ? nextInPlaylist(items, null, deadRef.current)
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
    window.localStorage.setItem(VOLUME_KEY, String(level));
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

  // What the desktop shows and what its media keys act on. Sent on every track
  // change and play/pause, and on the whole-second boundary while playing so
  // the position it reports does not drift from the truth.
  const lastReport = useRef("");
  useEffect(() => {
    const key = `${current?.id ?? 0}|${String(playing)}|${Math.floor(position)}`;
    if (key === lastReport.current) return;
    lastReport.current = key;
    reportNowPlaying({
      title: current?.title ?? "",
      artist: current === null ? "" : (current.uploader ?? current.genre),
      playing,
      position,
      duration,
      id: current?.id ?? 0,
    });
  }, [current, duration, playing, position]);

  /**
   * The player may not outlive its own row.
   *
   * A track whose file has been deleted keeps playing from what the engine has
   * already buffered, so a refresh that prunes the row leaves the stage reading
   * "nothing playing" beside a transport that still says Pause. Stopping keeps
   * the two agreeing, and it covers a row vanishing by any route — a prune, a
   * delete from another window, a library pointed somewhere else.
   *
   * Guarded on a non-empty library so that a failed reload, which briefly
   * answers with nothing, cannot stop playback on its own.
   */
  useEffect(() => {
    if (!loaded || currentId === null || library.length === 0) return;
    if (byId.has(currentId)) return;
    playerRef.current?.stop();
  }, [byId, currentId, library.length, loaded]);

  // -- local files ----------------------------------------------------------

  /**
   * Adopt whatever is under `paths`, then say what happened.
   *
   * The report is worth showing even when it is all good news: a scan that
   * silently adds 300 rows to a list the user is not looking at is
   * indistinguishable from one that did nothing.
   */
  const adopt = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return null;
      setScanning(true);
      try {
        const report = await scanLocal(paths);
        reloadLibrary();
        const parts: string[] = [];
        if (report.added > 0) parts.push(`Added ${report.added}`);
        if (report.updated > 0) parts.push(`retitled ${report.updated} from their tags`);
        if (report.skipped > 0) parts.push(`${report.skipped} already in the library`);
        if (report.failed > 0) parts.push(`${report.failed} could not be read`);
        if (report.truncated) parts.push("stopped at the 20,000-file limit");
        setNotice(parts.length === 0 ? "No audio files there." : `${parts.join(" · ")}.`);
        return report;
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setScanning(false);
      }
    },
    [reloadLibrary],
  );

  /**
   * Re-read the library, dropping anything whose file has gone.
   *
   * Both halves matter: the generator and the importer write rows this window
   * has not seen, and files leave without the database being told. Doing them
   * together is what makes one button match what the user means by "refresh".
   */
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void pruneMissing()
      .then((report) => {
        reloadLibrary();
        reloadPlaylists();
        if (report.removed > 0) {
          setNotice(
            `Removed ${report.removed} track${report.removed === 1 ? "" : "s"} whose file had gone.`,
          );
        }
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setRefreshing(false));
  }, [reloadLibrary, reloadPlaylists]);

  const [localOpen, setLocalOpen] = useState(!IN_TAURI && devPanel() === "files");
  const [settingsOpen, setSettingsOpen] = useState(!IN_TAURI && devPanel() === "settings");
  const [crossfade, setCrossfadeState] = useState(() => {
    // Same trap as the volume above: `Number(null)` is 0. Safe here only
    // because a zero-length crossfade is not a value worth restoring, so the
    // `> 0` test rejects both "absent" and "off" alike.
    const stored = window.localStorage.getItem(CROSSFADE_KEY);
    if (stored === null) return CROSSFADE_SECONDS;
    const saved = Number(stored);
    return Number.isFinite(saved) && saved > 0 ? saved : CROSSFADE_SECONDS;
  });
  const handleCrossfade = useCallback((seconds: number) => {
    setCrossfadeState(seconds);
    window.localStorage.setItem(CROSSFADE_KEY, String(seconds));
  }, []);

  /**
   * Push the setting into the player — including on the first render.
   *
   * Applying it only when the slider moved meant a saved value was restored
   * into the interface and never into the player: Settings would say four
   * seconds while every handover still took eight. A setting that is displayed
   * but not in force is worse than one that was never offered.
   */
  useEffect(() => {
    playerRef.current?.setCrossfade(crossfade);
  }, [crossfade]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  // Dropping music onto the window is the other half of the same feature. This
  // is the webview's own drag-drop event, not the DOM's: a file dropped on a
  // Tauri window never arrives as a `DragEvent`, and what this carries is real
  // filesystem paths, which is what the scanner needs.
  useEffect(() => {
    return onFileDrop({
      over: setDropping,
      drop: (paths) => void adopt(paths),
    });
  }, [adopt]);

  // -- render ---------------------------------------------------------------

  const empty = loaded && library.length === 0;

  // The whole visual idea, in two lines: the accent is the deck that is
  // sounding, and across a handover it sits between the two exactly as the
  // audio does. Everything colour-carrying in styles.css reads these.
  const fading = fade !== null && fade.progress < 1;
  const live = liveColour(deck, fading ? fade.progress : null);
  const incoming = fading ? deckColour(deck === "A" ? "B" : "A").css : null;
  const shellStyle = {
    "--live": live.css,
    "--live-rgb": live.rgb,
  } as React.CSSProperties;

  return (
    <div className="shell" style={shellStyle}>
      <Rail
        onAddLocal={() => setLocalOpen((open) => !open)}
        onImport={() => setImportOpen((open) => !open)}
        onGenerate={() => setGeneratorOpen((open) => !open)}
        scanning={scanning}
        downloading={downloading}
        generating={run.running}
        bagRemaining={bagCounts.remaining}
        bagSize={bagCounts.size}
        onSettings={() => setSettingsOpen((open) => !open)}
      />

      {empty ? (
        <main className="main">
          <EmptyLibrary
            stats={stats}
            onGenerate={() => setGeneratorOpen(true)}
            onImport={() => setImportOpen(true)}
            onAddLocal={() => setLocalOpen(true)}
          />
        </main>
      ) : (
        <main className="main">
          <div className="stage">
            <NowPlaying track={current} deck={deck} duration={duration} onRate={handleRate} />
            <div className="deck">
              <Visualizer analyser={analyser} active={playing} accent={live.rgb} bare />
            </div>
          </div>
          {view === "library" ? (
            <LibraryPanel
              view={view}
              onView={setView}
              playlistCount={playlists.length}
              genre={genre}
              genreOptions={genreOptions}
              onGenre={setGenre}
              onRefresh={handleRefresh}
              refreshing={refreshing}
                                tracks={visible}
              currentId={currentId}
              queuedId={queuedId}
              onPlay={(track) => playFrom(track, "shuffle")}
              playlists={playlists}
              onAddTo={(track, playlistId) => {
                const name = playlists.find((p) => p.id === playlistId)?.name ?? "that playlist";
                mutate(
                  addToPlaylist(playlistId, track.id).then((added) => {
                    // Confirmed either way. Adding a track to a playlist on
                    // another tab changes nothing the user can see from here,
                    // so silence would be indistinguishable from a dead button.
                    setNotice(
                      added
                        ? `Added “${track.title}” to “${name}”.`
                        : `“${track.title}” is already in “${name}”.`,
                    );
                  }),
                );
              }}
              onCreateWith={(track, name) => {
                mutate(
                  createPlaylist(name).then((id) =>
                    addToPlaylist(id, track.id).then(() => {
                      // Select it too: someone who just named a playlist is
                      // more likely than not to want to look at it.
                      setPlaylistId(id);
                      setNotice(`Added “${track.title}” to “${name}”.`);
                    }),
                  ),
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
              onRefresh={handleRefresh}
              refreshing={refreshing}
              curation={curation}
              curating={curating}
              onCurateExport={() => {
                setCurating(true);
                mutate(
                  curationExport()
                    .then((result) => {
                      setCuration(result);
                      setNotice(`Wrote ${result.tracks} tracks to ${result.dir}`);
                    })
                    .finally(() => setCurating(false)),
                );
              }}
              onCurateApply={() => {
                setCurating(true);
                mutate(
                  curationApply(null)
                    .then((report) => setNotice(describeCuration(report)))
                    .finally(() => setCurating(false)),
                );
              }}
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
        current={current}
        queued={queued}
        fade={fade}
        position={position}
        duration={duration}
        onSeek={(seconds) => playerRef.current?.seek(seconds)}
        incoming={incoming}
      />

      {dropping && (
        <div className="drop-veil" role="status">
          <div className="drop-ring">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4" />
              <path d="M7.5 8.5 12 4l4.5 4.5" />
              <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
            </svg>
          </div>
          <span className="drop-title">Drop to add</span>
          <span className="drop-body">
            Folders are searched through; the files stay where they are.
          </span>
        </div>
      )}

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

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        stats={stats}
        crossfade={crossfade}
        onCrossfade={handleCrossfade}
      />

      <LocalPanel
        open={localOpen}
        onClose={() => setLocalOpen(false)}
        onScan={adopt}
        scanning={scanning}
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

function EmptyLibrary({
  stats,
  onGenerate,
  onImport,
  onAddLocal,
}: {
  stats: Stats;
  onGenerate: () => void;
  onImport: () => void;
  onAddLocal: () => void;
}) {
  return (
    <section className="empty">
      <span className="empty-key">No tracks yet</span>
      <h1 className="empty-title">Nothing to play yet.</h1>
      <p className="empty-body">
        Three ways to fill it. Point it at music already on this machine and the files stay where
        they are, paste YouTube links to pull audio down at its original quality, or run the
        generator and render something new on the GPU. Everything lands in the same library and
        plays through the same two decks.
      </p>
      <div className="empty-row">
        <button type="button" className="btn is-primary" onClick={onAddLocal}>
          Add music from a folder
        </button>
        <button type="button" className="btn" onClick={onImport}>
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
 * player — both the ones the database never had a path for and the ones the
 * resolver has since failed on, which the column cannot tell us about. A
 * `current` that is not in this playlist at all starts it from the top, which
 * is what happens when the user was shuffling and then clicks a playlist row.
 *
 * Returns null when the playlist has nothing playable *left*, which stops the
 * player rather than looping on a dead entry — and that includes a playlist
 * whose only playable entry is the one already playing: handing that back
 * would load the same file onto both decks and crossfade it into itself.
 */
function nextInPlaylist(
  items: PlaylistItem[],
  current: Track | null,
  dead: ReadonlySet<number>,
): PlaylistItem | null {
  const playable = items.filter((item) => item.path !== null && !dead.has(item.id));
  if (playable.length === 0) return null;

  const at = current === null ? -1 : playable.findIndex((item) => item.id === current.id);
  const next = playable[(at + 1) % playable.length] ?? null;
  return next !== null && next.id === current?.id ? null : next;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One line describing what applying a plan actually did.
 *
 * A plan is written somewhere else by something this app cannot check, so the
 * counts are reported rather than reduced to "done" — a plan that half-applied
 * because half its ids were stale should not read the same as one that worked.
 */
function describeCuration(report: CurationReport): string {
  const parts: string[] = [];
  if (report.created.length > 0) parts.push(`created ${report.created.length}`);
  if (report.appended.length > 0) parts.push(`added to ${report.appended.length}`);
  parts.push(`${report.added} tracks placed`);
  if (report.alreadyIn > 0) parts.push(`${report.alreadyIn} already there`);
  if (report.unknownIds > 0) parts.push(`${report.unknownIds} unknown ids skipped`);
  if (report.errors.length > 0) parts.push(`${report.errors.length} refused`);
  return parts.join(" · ");
}
