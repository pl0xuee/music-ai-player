import type { Track } from "../types";

/** Length of the equal-power crossfade between decks, in seconds. */
export const CROSSFADE_SECONDS = 8;

/**
 * Progress polling interval. `setInterval` rather than `requestAnimationFrame`:
 * rAF is throttled to a stop while the window is hidden, which would stall the
 * crossfade trigger whenever the player is minimised.
 */
const TICK_MS = 100;

/**
 * How many selections `advance()` will try before giving up.
 *
 * A missing file must not end the session, but a library whose folder has gone
 * away must not walk thousands of dead rows over IPC either.
 */
const ADVANCE_ATTEMPTS = 12;

export type DeckId = "A" | "B";

export interface PlayerProgress {
  track: Track | null;
  position: number;
  duration: number;
}

export interface PlayerCrossfade {
  from: Track | null;
  to: Track | null;
  /** 0 -> 1 across the fade; 1 means the handover just completed. */
  progress: number;
}

export interface PlayerEventMap {
  trackchange: { track: Track | null; deck: DeckId };
  progress: PlayerProgress;
  statechange: { playing: boolean };
  crossfade: PlayerCrossfade;
  /** The idle deck has been armed with the next track, or cleared with null. */
  queued: { track: Track | null };
  error: { message: string };
}

type Listener<K extends keyof PlayerEventMap> = (payload: PlayerEventMap[K]) => void;
type ListenerSets = { [K in keyof PlayerEventMap]: Set<Listener<K>> };

/** Chooses what plays after `current`. Returning null stops after this track. */
export type NextSelector = (current: Track | null) => Track | null;

/**
 * Turns a track into a URL an `<audio>` element can load.
 *
 * Null means "this track has no playable file". A resolver that *rejects*
 * instead is treated the same way — see `Player.resolveUrl` — because the real
 * one goes through IPC, and an unhandled rejection there would leave the UI
 * insisting it is still playing.
 */
export type SourceResolver = (track: Track) => Promise<string | null>;

/** Outcome of one attempt to start a track. */
type StartResult =
  /** The deck is running. */
  | "started"
  /** No file, or the element refused to play it. Another track may work. */
  | "failed"
  /** A newer play() took the player over while this one was waiting. */
  | "superseded";

/**
 * How far the analysis element may drift from the audible deck before it is
 * pulled back. A spectrum a tenth of a second out is not something an eye can
 * see, and correcting more eagerly than this would re-seek constantly.
 */
const ANALYSIS_DRIFT_SECONDS = 0.35;

/**
 * Floor on how often the analysis element may be re-seeked.
 *
 * A seek in a two-hour file is not free, and correcting drift the moment it
 * appears costs more time than it recovers — which grows the drift, which
 * triggers another seek. This is what keeps a cosmetic subsystem from
 * competing with playback for the same pipeline.
 */
const ANALYSIS_RESYNC_MS = 4000;

interface Deck {
  id: DeckId;
  el: HTMLAudioElement;
  /**
   * The deck's own 0..1 fader, before the listening volume is applied. Kept
   * separately from `el.volume` because that carries the product of the two,
   * and the crossfade has to be able to reason about the fader alone.
   */
  level: number;
  track: Track | null;
  /** True once the element has a src and has been told to buffer. */
  armed: boolean;
  /** Removers for the DOM listeners this deck installed; run on dispose. */
  detach: (() => void)[];
}

/**
 * Two-deck player.
 *
 * # Why the audio does not go through Web Audio
 *
 * The obvious design here — and the one this started as — is
 * `MediaElementAudioSourceNode -> GainNode -> analyser -> master -> destination`,
 * which gives sample-accurate fades on the audio clock for free. It cannot be
 * used on Linux: WebKitGTK's Web Audio *output* stops emitting roughly a second
 * after it starts. Measured with a bare `OscillatorNode` and no media element
 * anywhere in the graph, so it is the destination itself, not
 * `createMediaElementSource`. The graph keeps rendering perfectly the whole
 * time — the analyser stays hot — WebKit simply stops handing the result to the
 * audio device.
 *
 * So the decks never touch the graph. Each `<audio>` element plays straight to
 * GStreamer's own sink, which works flawlessly, and the crossfade is done with
 * `el.volume` stepped by the ticker instead of scheduled on an audio clock.
 *
 * # The analysis element
 *
 * The visualiser still needs a spectrum, and the analyser is the one part of
 * Web Audio that does work. So a third element mirrors whatever the active deck
 * is playing and *is* wired into the graph. Being in the graph is precisely
 * what makes it inaudible — `createMediaElementSource` re-routes an element
 * away from the output device.
 *
 * It is not free, and the cost scales with the file. WebKit buffers each media
 * element into its own temp file under `/var/tmp`, so the mirror doubles that:
 * three copies of a 272 MB mix were measured resident at once, and the extra
 * write lands in front of the first sample. `preload = "none"` and a throttled
 * resync keep it as cheap as this design can be, but the real fix for a library
 * of long files is to compute the spectrum from the audio once, on the Rust
 * side, rather than decoding the track a second time to look at it.
 *
 * `silentSink` sits at gain 0 between the analyser and the destination. The
 * analyser is upstream of it, so it still sees the signal, while anything the
 * destination might emit is zeroed. On this WebKit that is belt and braces;
 * on an engine whose Web Audio output works it is what stops the analysis
 * element from being heard alongside the deck.
 */
export class Player {
  private readonly ctx: AudioContext;
  private readonly analyserNode: AnalyserNode;
  /** Held at gain 0; see the class comment. */
  private readonly silentSink: GainNode;
  private readonly decks: Record<DeckId, Deck>;
  /**
   * Silent mirror of the active deck, wired into the graph so the analyser has
   * something to measure. Null where `createMediaElementSource` is missing, in
   * which case the visualiser simply stays dark and playback is unaffected.
   */
  private readonly analysisEl: HTMLAudioElement | null;
  private readonly resolveSource: SourceResolver;
  private readonly listeners: ListenerSets = {
    trackchange: new Set(),
    progress: new Set(),
    statechange: new Set(),
    crossfade: new Set(),
    queued: new Set(),
    error: new Set(),
  };

  private active: DeckId = "A";
  private nextSelector: NextSelector = () => null;
  private timer: number | null = null;
  /**
   * Position of the *outgoing* element when the running fade began, or null
   * when no fade is in flight.
   *
   * Measuring the fade against that element's own clock rather than a wall
   * clock is what makes a pause freeze the handover: a paused element's
   * `currentTime` stops, so progress stops with it and resumes exactly where it
   * left off. The Web Audio version of this player had to suspend the whole
   * AudioContext to get the same property.
   *
   * It also means a missed tick cannot corrupt anything. Progress is recomputed
   * from the element each time rather than accumulated, so a throttled timer
   * makes the fade coarser, never wrong.
   */
  private fadeFrom: number | null = null;
  /**
   * Length of the fade in flight. Shorter than `CROSSFADE_SECONDS` when the
   * outgoing track is too short to give the full handover to.
   */
  private fadeSeconds = CROSSFADE_SECONDS;
  /**
   * Bumped by every `cancelFade`. `beginFade` captures it before awaiting the
   * incoming element and refuses to arm a fade that was cancelled meanwhile:
   * otherwise a play, skip or seek landing inside that window is silently
   * undone and the track the user just chose is faded to silence.
   */
  private fadeSeq = 0;
  /** Guards against a stale preload — or a stale play — landing after a skip. */
  private preloadToken = 0;
  /**
   * The last `playing` value handed to listeners.
   *
   * Kept so the ticker can notice the interface disagreeing with the elements
   * and put it right. Media engines do not always settle `play()`, and the
   * transport must not be the thing that stays wrong when one does not.
   */
  private reportedPlaying = false;
  /** When the analysis element was last pulled back into step. */
  private lastResync = 0;
  /**
   * How long a full handover may take. Settable, because how much overlap feels
   * right depends on the music: eight seconds suits a droning mix and is far
   * too long between two short tracks.
   */
  private crossfadeMax = CROSSFADE_SECONDS;
  private volume = 0.8;

  constructor(resolveSource: SourceResolver) {
    this.resolveSource = resolveSource;
    // Whatever rate the engine prefers. Nothing is played through this context
    // — it exists only to drive the analyser — so the rate has no bearing on
    // what is heard, and forcing one to match the output device was measured to
    // make no difference to the Web Audio output bug either.
    this.ctx = new AudioContext();

    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    // Range and smoothing both set explicitly, because the defaults are wrong
    // for looking at music. `-100..-30` puts ordinary programme material at the
    // very top of the window, and the per-band tilt correction then pushes it
    // past the ceiling: every bar sits at maximum and nothing in the track can
    // stand out from anything else. Opening the top up to -10 dB leaves the
    // headroom that makes a loud moment read as loud.
    this.analyserNode.minDecibels = -90;
    this.analyserNode.maxDecibels = -10;
    // 0.75 is smooth enough to blur a beat into the bar next to it.
    this.analyserNode.smoothingTimeConstant = 0.68;

    // Zero, permanently. Listening volume is applied on the elements now, and
    // nothing in this graph is ever meant to be heard.
    this.silentSink = this.ctx.createGain();
    this.silentSink.gain.value = 0;

    this.analyserNode.connect(this.silentSink);
    this.silentSink.connect(this.ctx.destination);

    this.decks = { A: this.createDeck("A"), B: this.createDeck("B") };
    this.analysisEl = this.createAnalysisElement();
  }

  /**
   * The one element that *is* wired into the graph, feeding the analyser.
   *
   * It is never given a volume or asked to be quiet: routing an element through
   * `createMediaElementSource` takes it off the output device by definition,
   * which is the whole reason this works.
   */
  private createAnalysisElement(): HTMLAudioElement | null {
    if (typeof this.ctx.createMediaElementSource !== "function") return null;
    const el = new Audio();
    // `none`, unlike the decks. This element never needs to be ready ahead of
    // time — it is told to play at the same moment the deck is already playing
    // — and asking it to buffer eagerly makes WebKit write a second full copy
    // of the track to disk before the first one has finished arriving. On a
    // 272 MB mix that is 272 MB of pure overhead in front of the first sample.
    el.preload = "none";
    el.crossOrigin = "anonymous";
    this.ctx.createMediaElementSource(el).connect(this.analyserNode);
    return el;
  }

  /**
   * Keep the analysis element on the same track, at the same place, in the same
   * play state as the audible deck.
   *
   * Called from the ticker and from every transport edge. Nothing here may
   * throw into a caller: this is a cosmetic subsystem, and a visualiser that
   * cannot keep up must never take the audio down with it.
   */
  private driveAnalysis(): void {
    const el = this.analysisEl;
    if (el === null) return;
    const deck = this.decks[this.active];
    const src = deck.el.getAttribute("src");

    try {
      if (src === null || deck.track === null) {
        if (!el.paused) el.pause();
        if (el.getAttribute("src") !== null) el.removeAttribute("src");
        return;
      }
      if (el.getAttribute("src") !== src) {
        el.src = src;
      }
      if (deck.el.paused) {
        if (!el.paused) el.pause();
        return;
      }
      // Correcting drift means seeking, and a seek in a long file is expensive
      // enough that doing it eagerly turns into a storm: the correction costs
      // more time than the drift it was fixing, so the drift grows and it seeks
      // again. Only worth doing when the spectrum would be visibly wrong, and
      // never more than once every few seconds.
      const drift = Math.abs(el.currentTime - deck.el.currentTime);
      const now = Date.now();
      if (drift > ANALYSIS_DRIFT_SECONDS && now - this.lastResync > ANALYSIS_RESYNC_MS) {
        this.lastResync = now;
        // Throws if metadata has not landed yet, which the catch absorbs; the
        // next tick will try again once the element knows its own length.
        el.currentTime = deck.el.currentTime;
      }
      if (el.paused) {
        void el.play().catch(() => {
          /* the spectrum goes flat; the music does not stop */
        });
      }
    } catch {
      /* see above */
    }
  }

  private createDeck(id: DeckId): Deck {
    const el = new Audio();
    el.preload = "auto";
    // The server replies with `Access-Control-Allow-Origin`, and asking for the
    // CORS load explicitly keeps the element usable by the graph. It matters
    // for the analysis element rather than these ones, but the decks share the
    // same URLs and a mismatched request would fetch the file twice.
    el.crossOrigin = "anonymous";
    // Deliberately *not* wired into the AudioContext: that is what would take
    // it off the output device. See the class comment.
    el.volume = 0;

    const deck: Deck = { id, el, level: 0, track: null, armed: false, detach: [] };

    // The element can be started and stopped by things that never go through
    // this class: a media key picked up by the engine's own media session, the
    // desktop's playback controls, MPRIS. The ticker reconciles that while it
    // is running, but a pause stops the ticker — so an outside *resume* would
    // otherwise play on with the transport still reading "Play" and the clock
    // frozen. These two listeners are what make the elements the source of
    // truth rather than this class's idea of them.
    const on = <K extends keyof HTMLMediaElementEventMap>(
      type: K,
      handler: (event: HTMLMediaElementEventMap[K]) => void,
    ): void => {
      el.addEventListener(type, handler);
      deck.detach.push(() => el.removeEventListener(type, handler));
    };

    on("play", () => {
      if (this.active !== id) return;
      this.reportPlaying(this.isPlaying);
      if (this.isPlaying) {
        this.driveAnalysis();
        this.startTicking();
      }
    });
    on("pause", () => {
      if (this.active !== id) return;
      this.reportPlaying(this.isPlaying);
    });

    on("ended", () => {
      // Only reached when the crossfade did not take over first — a track
      // shorter than the fade, or nothing queued. Advance immediately.
      if (this.active === id && this.fadeFrom === null) {
        void this.advance();
      }
    });
    on("error", () => {
      // Detaching a src fires a spurious error; ignore decks we have retired.
      if (el.getAttribute("src") === null || deck.track === null) return;
      this.emit("error", { message: `Deck ${id} could not play "${deck.track.title}".` });
    });

    return deck;
  }

  // -- accessors ------------------------------------------------------------

  get analyser(): AnalyserNode {
    return this.analyserNode;
  }

  get currentTrack(): Track | null {
    return this.decks[this.active].track;
  }

  get queuedTrack(): Track | null {
    return this.decks[this.idle].track;
  }

  /**
   * A track is audible right now.
   *
   * The deck having a track is part of the question, not an assumption. An
   * element can be left running by a load that was then abandoned, and without
   * this the ticker's reconciliation reports playback for a stage that says
   * "nothing playing" — a transport reading Pause with no title beside it.
   */
  get isPlaying(): boolean {
    const deck = this.decks[this.active];
    return deck.track !== null && !deck.el.paused && !deck.el.ended;
  }

  get isCrossfading(): boolean {
    return this.fadeFrom !== null;
  }

  get activeDeck(): DeckId {
    return this.active;
  }

  private get idle(): DeckId {
    return this.active === "A" ? "B" : "A";
  }

  /**
   * Nudge the context awake without awaiting it.
   *
   * Only the analyser depends on this now, so a context that never starts costs
   * the visualiser and nothing else — which is why the failure is swallowed
   * rather than reported. A context blocked by the autoplay policy returns a
   * promise that stays pending until the user interacts, so awaiting it here
   * would stall playback behind a purely cosmetic subsystem.
   */
  private unlock(): void {
    if (this.ctx.state !== "suspended") return;
    void this.ctx.resume().catch(() => {
      /* no spectrum; the music is unaffected */
    });
  }

  /**
   * Resolve a track's URL, turning a rejected resolver into the same null a
   * missing file already produces.
   *
   * The production resolver crosses the IPC bridge and rejects when the row's
   * file has gone; neither caller is in a position to let that escape. An
   * unhandled rejection here kills the advance that was in progress without
   * emitting anything, so the transport keeps offering "Pause" for a player
   * that will never make another sound.
   */
  private async resolveUrl(track: Track): Promise<string | null> {
    try {
      return await this.resolveSource(track);
    } catch {
      return null;
    }
  }

  /** Ask for the next track, absorbing a selector that throws. */
  private selectNext(current: Track | null): Track | null {
    try {
      return this.nextSelector(current);
    } catch (err) {
      this.emit("error", { message: describe(err) });
      return null;
    }
  }

  setNextSelector(selector: NextSelector): void {
    this.nextSelector = selector;
  }

  // -- transport ------------------------------------------------------------

  /**
   * Load `track` onto the active deck and start it, abandoning any fade.
   * Resolves true once the deck is actually running.
   */
  async play(track: Track): Promise<boolean> {
    return (await this.start(track)) === "started";
  }

  /** `play`, with the detail `advance` needs to decide whether to try again. */
  private async start(track: Track): Promise<StartResult> {
    this.cancelFade();
    // The token the preload already used, now shared with play: a second click
    // landing while this one waits on IPC must win, and the one it overtook
    // must not touch the decks on its way out.
    this.preloadToken += 1;
    const token = this.preloadToken;

    const deck = this.decks[this.active];
    const other = this.decks[this.idle];
    other.el.pause();
    this.setLevel(other, 0);

    // Everything above is synchronous, so a click always unwinds the fade it
    // interrupted before anything else can observe the player.
    this.unlock();
    const url = await this.resolveUrl(track);
    if (token !== this.preloadToken) return "superseded";
    if (url === null) {
      this.emit("error", { message: `No audio file for "${track.title}".` });
      // Nothing new started, so say what is true now. Without this the button
      // keeps reading "Pause" and the visualiser stays lit for a dead player.
      this.reportPlaying(this.isPlaying);
      return "failed";
    }

    deck.track = track;
    deck.armed = true;
    deck.el.src = url;
    this.setLevel(deck, 1);

    try {
      await deck.el.play();
    } catch (err) {
      // A newer load is what aborted this one; that is not an error to report.
      // The token catches most of those, and `isAborted` catches the rest —
      // the engine can reject the old play *after* the new one has already
      // taken the token back, and that rejection is about a deck nobody is
      // listening to any more.
      if (token !== this.preloadToken || isAborted(err)) return "superseded";
      this.emit("error", { message: describe(err) });
      this.reportPlaying(this.isPlaying);
      return "failed";
    }
    if (token !== this.preloadToken) return "superseded";

    this.emit("trackchange", { track, deck: deck.id });
    this.reportPlaying(true);
    this.driveAnalysis();
    this.startTicking();
    void this.preloadNext();
    return "started";
  }

  /**
   * Start the current deck again after a pause.
   *
   * The interface is updated *before* `play()` is awaited, not after. That
   * promise resolves when playback actually begins, and WebKitGTK does not
   * reliably settle it on a resume — gating on it leaves the transport frozen,
   * the scrub stuck and the button still reading "Play" while the audio runs.
   * Announcing the intent and correcting on failure is both more robust and
   * more responsive; `tick` reconciles anything that disagrees afterwards.
   */
  async resume(): Promise<void> {
    const deck = this.decks[this.active];
    if (deck.track === null) return;
    this.unlock();

    this.reportPlaying(true);
    this.driveAnalysis();
    this.startTicking();

    try {
      await deck.el.play();
      if (this.fadeFrom !== null) await this.decks[this.idle].el.play();
    } catch (err) {
      if (!isAborted(err)) this.emit("error", { message: describe(err) });
      this.reportPlaying(this.isPlaying);
      if (!this.isPlaying) this.stopTicking();
    }
  }

  /**
   * Both decks stop, and the fade stops with them.
   *
   * Nothing has to be done to freeze the handover: its progress is measured
   * against the outgoing element's own clock, which a pause stops dead. Come
   * back ten minutes later and the fade picks up exactly where it was, rather
   * than having run to completion in silence and retired a track nobody heard.
   */
  pause(): void {
    this.decks[this.active].el.pause();
    // Mid-fade both decks are audible, so the incoming one has to stop too.
    if (this.fadeFrom !== null) this.decks[this.idle].el.pause();
    this.analysisEl?.pause();
    this.stopTicking();
    this.reportPlaying(false);
  }

  async toggle(): Promise<void> {
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.resume();
    }
  }

  /** Jump straight to the next selection, no crossfade. */
  async skip(): Promise<void> {
    await this.advance();
  }

  stop(): void {
    this.cancelFade();
    this.preloadToken += 1;
    for (const id of ["A", "B"] as const) {
      const deck = this.decks[id];
      deck.track = null;
      deck.armed = false;
      deck.el.pause();
      deck.el.removeAttribute("src");
      this.setLevel(deck, 0);
    }
    this.driveAnalysis();
    this.stopTicking();
    this.emit("trackchange", { track: null, deck: this.active });
    this.emit("queued", { track: null });
    this.reportPlaying(false);
  }

  seek(seconds: number): void {
    const el = this.decks[this.active].el;
    if (!Number.isFinite(el.duration)) return;
    // Seeking out of the fade window has to unwind a fade already in flight.
    this.cancelFade();
    el.currentTime = Math.min(Math.max(0, seconds), el.duration);
    this.driveAnalysis();
    this.emitProgress();
  }

  /** Length of a full handover, in seconds. Clamped to something musical. */
  setCrossfade(seconds: number): void {
    this.crossfadeMax = Math.min(Math.max(seconds, 0), 20);
  }

  getCrossfade(): number {
    return this.crossfadeMax;
  }

  setVolume(level: number): void {
    this.volume = clamp01(level);
    this.applyLevel(this.decks.A);
    this.applyLevel(this.decks.B);
  }

  getVolume(): number {
    return this.volume;
  }

  dispose(): void {
    this.stopTicking();
    for (const id of ["A", "B"] as const) {
      const deck = this.decks[id];
      deck.el.pause();
      deck.el.removeAttribute("src");
      // `load()` after clearing the source is what actually makes the engine
      // let go of the decoder and its audio stream. Without it a disposed
      // player keeps its output alive: a session that hot-reloads a few times
      // ends up with a stack of them, and the one the keyboard is talking to is
      // no longer the one making the sound.
      deck.el.load();
      // These were added in `createDeck` and never taken off, so every listener
      // held a reference to this player and kept the whole thing — decks,
      // context and all — from being collected.
      for (const off of deck.detach) off();
      deck.detach.length = 0;
    }
    this.analysisEl?.pause();
    this.analysisEl?.removeAttribute("src");
    this.analysisEl?.load();
    for (const key of Object.keys(this.listeners) as (keyof PlayerEventMap)[]) {
      this.listeners[key].clear();
    }
    void this.ctx.close();
  }

  // -- events ---------------------------------------------------------------

  on<K extends keyof PlayerEventMap>(event: K, listener: Listener<K>): () => void {
    const set: Set<Listener<K>> = this.listeners[event];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit<K extends keyof PlayerEventMap>(event: K, payload: PlayerEventMap[K]): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }

  /**
   * The only way `statechange` is emitted.
   *
   * Deduplicated, so the ticker can assert the truth ten times a second without
   * re-rendering anything, and so a single field always holds what the
   * interface currently believes.
   */
  private reportPlaying(playing: boolean): void {
    if (playing === this.reportedPlaying) return;
    this.reportedPlaying = playing;
    this.emit("statechange", { playing });
  }

  // -- scheduling -----------------------------------------------------------

  private startTicking(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const outgoing = this.decks[this.active];
    const el = outgoing.el;
    this.emitProgress();
    this.driveAnalysis();
    // Whatever the elements are actually doing wins. This is the one loop that
    // is guaranteed to run while a deck is loaded, so it is the right place to
    // catch a transport that has drifted out of step with the audio.
    this.reportPlaying(this.isPlaying);

    if (this.fadeFrom !== null) {
      const incoming = this.decks[this.idle];
      // Measured against the outgoing element rather than a wall clock, so a
      // pause freezes it and a stall stretches it instead of running the
      // handover on ahead of the audio.
      const elapsed = el.currentTime - this.fadeFrom;
      // The element reaching its end is also the fade reaching its end. Without
      // this a fade whose last fraction of a second never arrives — the file
      // being a hair shorter than its declared duration — would hang at 0.99.
      const progress = el.ended ? 1 : Math.min(Math.max(elapsed / this.fadeSeconds, 0), 1);

      this.setLevel(outgoing, equalPowerGain(progress, false));
      this.setLevel(incoming, equalPowerGain(progress, true));

      this.emit("crossfade", { from: outgoing.track, to: incoming.track, progress });
      if (progress >= 1) this.completeFade();
      return;
    }

    if (el.paused) return;
    const length = playableDuration(el);
    if (length === null) return;
    if (length - el.currentTime <= fadeLengthFor(length, this.crossfadeMax)) {
      void this.beginFade();
    }
  }

  private emitProgress(): void {
    const deck = this.decks[this.active];
    const duration = Number.isFinite(deck.el.duration)
      ? deck.el.duration
      : (deck.track?.duration ?? 0);
    this.emit("progress", { track: deck.track, position: deck.el.currentTime, duration });
  }

  // -- crossfade ------------------------------------------------------------

  /** Arm the idle deck with the next track so the fade never has to buffer. */
  private async preloadNext(): Promise<void> {
    this.preloadToken += 1;
    const token = this.preloadToken;
    const idle = this.decks[this.idle];
    const next = this.selectNext(this.currentTrack);

    if (next === null) {
      idle.track = null;
      idle.armed = false;
      this.emit("queued", { track: null });
      return;
    }

    const url = await this.resolveUrl(next);
    // A skip or a fresh selection may have raced ahead while we awaited IPC.
    if (token !== this.preloadToken) return;
    if (url === null) {
      // Nothing is armed, so show nothing as queued rather than leaving the
      // previous pick standing. The end of the current track then falls
      // through to `advance`, which asks the selector for something else.
      idle.track = null;
      idle.armed = false;
      this.emit("queued", { track: null });
      this.emit("error", { message: `No audio file for "${next.title}".` });
      return;
    }

    idle.track = next;
    idle.el.src = url;
    idle.el.load();
    idle.armed = true;
    this.emit("queued", { track: next });
  }

  private async beginFade(): Promise<void> {
    const outgoing = this.decks[this.active];
    const incoming = this.decks[this.idle];
    if (!incoming.armed || incoming.track === null) return;
    // Claim the fade before awaiting so the next tick cannot start a second one.
    this.fadeFrom = outgoing.el.currentTime;
    this.fadeSeconds = fadeLengthFor(playableDuration(outgoing.el), this.crossfadeMax);
    const seq = this.fadeSeq;

    try {
      await incoming.el.play();
    } catch (err) {
      // A cancel is what aborted this play(); it has already tidied up.
      if (seq !== this.fadeSeq) return;
      this.fadeFrom = null;
      if (!isAborted(err)) this.emit("error", { message: describe(err) });
      return;
    }

    // A play, skip or seek during that await unwound this handover. Re-arming
    // it here would fade the track the user just chose down to silence and
    // then promote the deck the cancel had already paused.
    if (seq !== this.fadeSeq) {
      if (this.fadeFrom === null && this.decks[this.idle] === incoming) {
        incoming.el.pause();
        incoming.el.currentTime = 0;
      }
      return;
    }

    // Re-read rather than reusing the value from before the await: the deck has
    // been playing throughout it, and anchoring the fade to a stale position
    // would start it already part-way through.
    this.fadeFrom = outgoing.el.currentTime;
    this.setLevel(outgoing, 1);
    this.setLevel(incoming, 0);
    this.emit("crossfade", { from: outgoing.track, to: incoming.track, progress: 0 });
  }

  private completeFade(): void {
    const outgoing = this.decks[this.active];
    const incoming = this.decks[this.idle];

    // Only ever promote a deck that is actually running. A paused incoming
    // deck means the handover was unwound underneath us, and promoting it
    // would leave the transport naming a track that makes no sound.
    if (incoming.track === null || incoming.el.paused) {
      this.stop();
      return;
    }
    this.fadeFrom = null;

    outgoing.track = null;
    outgoing.armed = false;
    outgoing.el.pause();
    outgoing.el.removeAttribute("src");
    this.setLevel(outgoing, 0);

    this.active = incoming.id;
    this.setLevel(incoming, 1);
    this.driveAnalysis();

    this.emit("crossfade", { from: null, to: incoming.track, progress: 1 });
    this.emit("trackchange", { track: incoming.track, deck: incoming.id });
    void this.preloadNext();
  }

  private cancelFade(): void {
    if (this.fadeFrom === null) return;
    // Anything still waiting on `beginFade`'s await has to learn that the fade
    // it claimed is gone, or it will re-arm the one we are unwinding here.
    this.fadeSeq += 1;
    this.fadeFrom = null;
    const incoming = this.decks[this.idle];
    incoming.el.pause();
    // Back to the top: the deck stays armed with this track, and without the
    // rewind it would start a few seconds in — a little further every time.
    incoming.el.currentTime = 0;
    this.setLevel(incoming, 0);
    this.setLevel(this.decks[this.active], 1);
  }

  /**
   * Move to the next selection.
   *
   * A row whose file has gone missing must not end the session, so a failed
   * start asks the selector for another one. Two things stop that spinning: a
   * track the selector has already offered in this attempt ends it, and so
   * does `ADVANCE_ATTEMPTS`.
   */
  private async advance(): Promise<void> {
    const tried = new Set<number>();
    let candidate = this.selectNext(this.currentTrack);

    while (candidate !== null && tried.size < ADVANCE_ATTEMPTS) {
      if (tried.has(candidate.id)) break;
      tried.add(candidate.id);
      // "superseded" means a play() overtook us; the player belongs to it now.
      if ((await this.start(candidate)) !== "failed") return;
      candidate = this.selectNext(candidate);
    }
    this.stop();
  }

  /** Move a deck's own fader, and push the result to its element. */
  private setLevel(deck: Deck, level: number): void {
    deck.level = clamp01(level);
    this.applyLevel(deck);
  }

  /**
   * `el.volume` carries the deck's fader times the listening volume.
   *
   * Both have to be folded together here because a media element has exactly
   * one gain to give: the Web Audio version could keep the crossfade and the
   * volume control on separate nodes, and this cannot.
   */
  private applyLevel(deck: Deck): void {
    deck.el.volume = clamp01(deck.level * this.volume);
  }
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** The element's duration, or null while it is unknown — 0, NaN or a stream. */
function playableDuration(el: HTMLAudioElement): number | null {
  const seconds = el.duration;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * How long a track of `duration` seconds may spend handing over.
 *
 * Half the track at most. A full 8-second fade on a 6-second track would start
 * at t = 0, so the track would never once be heard on its own — and the gain
 * curve would still be climbing when the file ran out.
 */
function fadeLengthFor(duration: number | null, max: number): number {
  if (duration === null) return max;
  return Math.min(max, duration / 2);
}

/**
 * Equal-power crossfade gain at `progress` (0..1) through the handover.
 *
 * A linear fade dips about 3 dB in the middle, because two uncorrelated signals
 * sum in power rather than amplitude: 0.5² + 0.5² = 0.5. A quarter cycle of
 * sine/cosine instead gives sin²(t·π/2) + cos²(t·π/2) = 1 at every instant, so
 * total power — and therefore perceived loudness — stays flat across the
 * handover.
 *
 * Sampled per tick rather than handed to `setValueCurveAtTime` as a 256-point
 * table, because the fade now lives on `el.volume` and there is no automation
 * timeline to schedule it on. At a 100 ms tick an 8-second fade lands in 80
 * steps, and the steepest of them is about 0.1 dB.
 */
function equalPowerGain(progress: number, rising: boolean): number {
  const angle = (clamp01(progress) * Math.PI) / 2;
  return rising ? Math.sin(angle) : Math.cos(angle);
}

/**
 * True when a `play()` was cut short by a newer load rather than by a failure.
 *
 * Changing `src`, or clearing it, rejects any play still in flight with
 * `AbortError` — "The play() request was interrupted because the media was
 * removed from the document". That is the normal consequence of clicking a
 * second track, and showing it to the user is noise about an internal race
 * they did not cause and cannot act on.
 */
function isAborted(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    return err.message.includes("interrupted") || err.message.includes("aborted");
  }
  return false;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
