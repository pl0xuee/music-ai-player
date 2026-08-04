import type { Track } from "../types";

/** Length of the equal-power crossfade between decks, in seconds. */
export const CROSSFADE_SECONDS = 8;

/** Points in the pre-computed gain curve handed to `setValueCurveAtTime`. */
const CURVE_STEPS = 256;

/**
 * Progress polling interval. `setInterval` rather than `requestAnimationFrame`:
 * rAF is throttled to a stop while the window is hidden, which would stall the
 * crossfade trigger whenever the player is minimised.
 */
const TICK_MS = 100;

/** Shown when the browser cannot open an audio output device at all. */
const AUDIO_UNAVAILABLE =
  "No audio output is available — the system has no usable audio device.";

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

interface Deck {
  id: DeckId;
  el: HTMLAudioElement;
  gain: GainNode;
  track: Track | null;
  /** True once the element has a src and has been told to buffer. */
  armed: boolean;
}

/**
 * Two-deck player.
 *
 * Graph: each deck is `MediaElementAudioSourceNode -> GainNode -> analyser`,
 * and the shared analyser feeds a master gain (volume) then the destination.
 * Volume sits downstream of the analyser so the visualiser shows the mix rather
 * than the listening level.
 */
export class Player {
  private readonly ctx: AudioContext;
  private readonly analyserNode: AnalyserNode;
  private readonly master: GainNode;
  private readonly decks: Record<DeckId, Deck>;
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
  /** AudioContext timestamp the running fade began at, or null when idle. */
  private fadeStartedAt: number | null = null;
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
  /** True while `pause()` is holding the context suspended. */
  private suspendedForPause = false;
  private volume = 0.8;

  constructor(resolveSource: SourceResolver) {
    this.resolveSource = resolveSource;
    this.ctx = new AudioContext();

    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.75;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;

    this.analyserNode.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.decks = { A: this.createDeck("A"), B: this.createDeck("B") };
  }

  private createDeck(id: DeckId): Deck {
    const el = new Audio();
    el.preload = "auto";
    // The asset protocol replies with `Access-Control-Allow-Origin` for the
    // window origin. Without an explicit CORS request the media counts as
    // cross-origin and MediaElementAudioSourceNode would output silence.
    el.crossOrigin = "anonymous";

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    this.ctx.createMediaElementSource(el).connect(gain);
    gain.connect(this.analyserNode);

    const deck: Deck = { id, el, gain, track: null, armed: false };

    el.addEventListener("ended", () => {
      // Only reached when the crossfade did not take over first — a track
      // shorter than the fade, or nothing queued. Advance immediately.
      if (this.active === id && this.fadeStartedAt === null) {
        void this.advance();
      }
    });
    el.addEventListener("error", () => {
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

  get isPlaying(): boolean {
    const el = this.decks[this.active].el;
    return !el.paused && !el.ended;
  }

  get isCrossfading(): boolean {
    return this.fadeStartedAt !== null;
  }

  get activeDeck(): DeckId {
    return this.active;
  }

  private get idle(): DeckId {
    return this.active === "A" ? "B" : "A";
  }

  /**
   * Nudge the context awake without awaiting it. A context blocked by the
   * autoplay policy returns a promise that stays pending until the user
   * interacts, so awaiting it here would deadlock playback rather than delay it.
   *
   * It can also *reject* — a machine with no usable audio output answers
   * `InvalidStateError: Failed to start the audio device` — and that has to be
   * reported rather than left as an unhandled rejection the user never sees.
   */
  private unlock(): void {
    if (this.ctx.state !== "suspended") return;
    void this.ctx.resume().catch((err: unknown) => {
      this.emit("error", { message: `${AUDIO_UNAVAILABLE} (${describe(err)})` });
    });
  }

  /**
   * Bring the context back after `pause()` suspended it.
   *
   * Awaiting is safe here and only here: the context was running a moment ago,
   * so this is not the autoplay-policy case `unlock` must not await. Every
   * entry point into playback goes through this, so the fade automation — which
   * was frozen along with the clock — restarts together with the elements.
   */
  private async wake(): Promise<void> {
    if (!this.suspendedForPause) {
      this.unlock();
      return;
    }
    this.suspendedForPause = false;
    try {
      await this.ctx.resume();
    } catch (err) {
      this.emit("error", { message: `${AUDIO_UNAVAILABLE} (${describe(err)})` });
    }
  }

  /**
   * True once the output device has failed for good. The browser closes the
   * context when it cannot open a device, and a closed context never reopens,
   * so every later attempt has to say so instead of arming a silent deck.
   */
  private get audioUnavailable(): boolean {
    return this.ctx.state === "closed";
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
    if (this.audioUnavailable) {
      this.emit("error", { message: AUDIO_UNAVAILABLE });
      return "failed";
    }
    this.cancelFade();
    // The token the preload already used, now shared with play: a second click
    // landing while this one waits on IPC must win, and the one it overtook
    // must not touch the decks on its way out.
    this.preloadToken += 1;
    const token = this.preloadToken;

    const deck = this.decks[this.active];
    const other = this.decks[this.idle];
    other.el.pause();
    this.setGain(other, 0);

    // Everything above is synchronous, so a click always unwinds the fade it
    // interrupted before anything else can observe the player.
    await this.wake();
    const url = await this.resolveUrl(track);
    if (token !== this.preloadToken) return "superseded";
    if (url === null) {
      this.emit("error", { message: `No audio file for "${track.title}".` });
      // Nothing new started, so say what is true now. Without this the button
      // keeps reading "Pause" and the visualiser stays lit for a dead player.
      this.emit("statechange", { playing: this.isPlaying });
      return "failed";
    }

    deck.track = track;
    deck.armed = true;
    deck.el.src = url;
    this.setGain(deck, 1);

    try {
      await deck.el.play();
    } catch (err) {
      // A newer load is what aborted this one; that is not an error to report.
      if (token !== this.preloadToken) return "superseded";
      this.emit("error", { message: describe(err) });
      this.emit("statechange", { playing: this.isPlaying });
      return "failed";
    }
    if (token !== this.preloadToken) return "superseded";

    this.emit("trackchange", { track, deck: deck.id });
    this.emit("statechange", { playing: true });
    this.startTicking();
    void this.preloadNext();
    return "started";
  }

  async resume(): Promise<void> {
    const deck = this.decks[this.active];
    if (deck.track === null) return;
    if (this.audioUnavailable) {
      this.emit("error", { message: AUDIO_UNAVAILABLE });
      return;
    }
    await this.wake();
    try {
      await deck.el.play();
      if (this.fadeStartedAt !== null) await this.decks[this.idle].el.play();
    } catch (err) {
      this.emit("error", { message: describe(err) });
      return;
    }
    this.emit("statechange", { playing: true });
    this.startTicking();
  }

  pause(): void {
    this.decks[this.active].el.pause();
    // Mid-fade both decks are audible, so the incoming one has to stop too.
    if (this.fadeStartedAt !== null) this.decks[this.idle].el.pause();
    // Suspending stops `ctx.currentTime`, and with it both the fade's progress
    // and the gain curve already scheduled on the automation timeline. Without
    // it a handover runs to completion on wall-clock time while the audio sits
    // still: come back ten seconds later and the outgoing track has been
    // retired mid-phrase, the incoming one starts from wherever the fade got
    // to, and a trackchange has counted a play nobody heard.
    if (this.ctx.state === "running") {
      this.suspendedForPause = true;
      void this.ctx.suspend().catch(() => {
        // An engine that will not suspend still has to be resumable; the fade
        // then finishes late rather than not at all.
        this.suspendedForPause = false;
      });
    }
    this.stopTicking();
    this.emit("statechange", { playing: false });
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
      this.setGain(deck, 0);
    }
    this.stopTicking();
    this.emit("trackchange", { track: null, deck: this.active });
    this.emit("queued", { track: null });
    this.emit("statechange", { playing: false });
  }

  seek(seconds: number): void {
    const el = this.decks[this.active].el;
    if (!Number.isFinite(el.duration)) return;
    // Seeking out of the fade window has to unwind a fade already in flight.
    this.cancelFade();
    el.currentTime = Math.min(Math.max(0, seconds), el.duration);
    this.emitProgress();
  }

  setVolume(level: number): void {
    this.volume = Math.min(Math.max(level, 0), 1);
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.volume, now, 0.02);
  }

  getVolume(): number {
    return this.volume;
  }

  dispose(): void {
    this.stopTicking();
    for (const id of ["A", "B"] as const) {
      this.decks[id].el.pause();
      this.decks[id].el.removeAttribute("src");
    }
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
    const el = this.decks[this.active].el;
    this.emitProgress();

    if (this.fadeStartedAt !== null) {
      const progress = Math.min((this.ctx.currentTime - this.fadeStartedAt) / this.fadeSeconds, 1);
      this.emit("crossfade", {
        from: this.decks[this.active].track,
        to: this.decks[this.idle].track,
        progress,
      });
      if (progress >= 1) this.completeFade();
      return;
    }

    if (el.paused) return;
    const length = playableDuration(el);
    if (length === null) return;
    if (length - el.currentTime <= fadeLengthFor(length)) {
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
    this.fadeStartedAt = this.ctx.currentTime;
    this.fadeSeconds = fadeLengthFor(playableDuration(outgoing.el));
    const seq = this.fadeSeq;

    try {
      await incoming.el.play();
    } catch (err) {
      // A cancel is what aborted this play(); it has already tidied up.
      if (seq !== this.fadeSeq) return;
      this.fadeStartedAt = null;
      this.emit("error", { message: describe(err) });
      return;
    }

    // A play, skip or seek during that await unwound this handover. Re-arming
    // it here would fade the track the user just chose down to silence and
    // then promote the deck the cancel had already paused.
    if (seq !== this.fadeSeq) {
      if (this.fadeStartedAt === null && this.decks[this.idle] === incoming) {
        incoming.el.pause();
        incoming.el.currentTime = 0;
      }
      return;
    }

    const start = this.ctx.currentTime;
    this.fadeStartedAt = start;
    this.rampCurve(outgoing.gain, false, start, this.fadeSeconds);
    this.rampCurve(incoming.gain, true, start, this.fadeSeconds);
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
    this.fadeStartedAt = null;

    outgoing.track = null;
    outgoing.armed = false;
    outgoing.el.pause();
    outgoing.el.removeAttribute("src");
    this.setGain(outgoing, 0);

    this.active = incoming.id;
    this.setGain(incoming, 1);

    this.emit("crossfade", { from: null, to: incoming.track, progress: 1 });
    this.emit("trackchange", { track: incoming.track, deck: incoming.id });
    void this.preloadNext();
  }

  private cancelFade(): void {
    if (this.fadeStartedAt === null) return;
    // Anything still waiting on `beginFade`'s await has to learn that the fade
    // it claimed is gone, or it will re-arm the one we are unwinding here.
    this.fadeSeq += 1;
    this.fadeStartedAt = null;
    const incoming = this.decks[this.idle];
    incoming.el.pause();
    // Back to the top: the deck stays armed with this track, and without the
    // rewind it would start a few seconds in — a little further every time.
    incoming.el.currentTime = 0;
    this.setGain(incoming, 0);
    this.setGain(this.decks[this.active], 1);
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

  private setGain(deck: Deck, value: number): void {
    const now = this.ctx.currentTime;
    clearAutomation(deck.gain.gain, now);
    deck.gain.gain.setValueAtTime(value, now);
  }

  private rampCurve(node: GainNode, rising: boolean, startTime: number, seconds: number): void {
    // setValueCurveAtTime throws if any other event sits inside the curve's
    // window, so the range must be cleared first — and only then, without
    // planting a setValueAtTime at startTime itself.
    clearAutomation(node.gain, startTime);
    node.gain.setValueCurveAtTime(equalPowerCurve(rising), startTime, seconds);
  }
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
function fadeLengthFor(duration: number | null): number {
  if (duration === null) return CROSSFADE_SECONDS;
  return Math.min(CROSSFADE_SECONDS, duration / 2);
}

/**
 * Equal-power crossfade curve.
 *
 * A linear fade dips about 3 dB in the middle, because two uncorrelated signals
 * sum in power rather than amplitude: 0.5² + 0.5² = 0.5. A quarter cycle of
 * sine/cosine instead gives sin²(t·π/2) + cos²(t·π/2) = 1 at every instant, so
 * total power — and therefore perceived loudness — stays flat across the
 * handover.
 */
function equalPowerCurve(rising: boolean): Float32Array {
  const curve = new Float32Array(CURVE_STEPS);
  for (let i = 0; i < CURVE_STEPS; i += 1) {
    const angle = ((i / (CURVE_STEPS - 1)) * Math.PI) / 2;
    curve[i] = rising ? Math.sin(angle) : Math.cos(angle);
  }
  return curve;
}

/**
 * `cancelScheduledValues` leaves an already-started curve running, so a fade in
 * flight also needs `cancelAndHoldAtTime` where the engine provides it.
 */
function clearAutomation(param: AudioParam, at: number): void {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(at);
  }
  param.cancelScheduledValues(at);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
