/**
 * A headless stand-in for the browser bits `src/audio/player.ts` drives.
 *
 * The player is pure TypeScript over three browser objects — `AudioContext`,
 * `Audio` and `window.setInterval` — so faking those three is enough to run it
 * for real, with no DOM and no audio device. Everything here is deterministic
 * and manually clocked: `clock.advance(seconds)` steps the audio context, the
 * media elements and the player's own interval together, which is what lets a
 * test say "pause here, wait ten seconds, resume" and mean it.
 *
 * Run with `npm test` (Node's built-in runner strips the types).
 */

import { Player } from "../src/audio/player.ts";

/* --- tracks ---------------------------------------------------------------- */

export function makeTrack(id, over = {}) {
  return {
    id,
    title: `Track ${id}`,
    genre: "ambient",
    bpm: 128,
    keyScale: "C:maj",
    prompt: "",
    duration: 20,
    path: `/library/${id}.mp3`,
    createdAt: "2026-01-01T00:00:00Z",
    playCount: 0,
    lastPlayed: null,
    rating: 0,
    source: "generated",
    videoId: null,
    url: null,
    uploader: null,
    ...over,
  };
}

/* --- web audio ------------------------------------------------------------- */

/** Records every automation call so a test can assert on the fade curves. */
class FakeParam {
  value = 0;
  /** `{ start, seconds, rising }` for each `setValueCurveAtTime`. */
  curves = [];
  events = [];

  setValueAtTime(value, when) {
    this.value = value;
    this.events.push({ type: "set", value, when });
    return this;
  }

  setTargetAtTime(value, when, constant) {
    this.value = value;
    this.events.push({ type: "target", value, when, constant });
    return this;
  }

  setValueCurveAtTime(curve, start, seconds) {
    const first = curve[0] ?? 0;
    const last = curve[curve.length - 1] ?? 0;
    this.curves.push({ start, seconds, rising: last > first });
    this.value = last;
    return this;
  }

  cancelScheduledValues(when) {
    this.events.push({ type: "cancel", when });
    return this;
  }

  cancelAndHoldAtTime(when) {
    this.events.push({ type: "hold", when });
    return this;
  }
}

class FakeGain {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}

class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  minDecibels = -100;
  maxDecibels = -30;
  connect() {}
  disconnect() {}
}

/**
 * `currentTime` only moves while the context is running — the whole point of
 * suspending on pause, and the property the wall clock below leans on.
 */
class FakeContext {
  state = "running";
  destination = {};
  sampleRate = 48000;
  /** element -> the GainNode the player wired it to. */
  deckGains = new Map();
  #time = 0;

  get currentTime() {
    return this.#time;
  }

  advance(seconds) {
    if (this.state === "running") this.#time += seconds;
  }

  createAnalyser() {
    return new FakeAnalyser();
  }

  createGain() {
    return new FakeGain();
  }

  createMediaElementSource(el) {
    return {
      connect: (node) => {
        this.deckGains.set(el, node);
      },
    };
  }

  suspend() {
    if (this.state === "running") this.state = "suspended";
    return Promise.resolve();
  }

  resume() {
    if (this.state === "suspended") this.state = "running";
    return Promise.resolve();
  }

  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

/* --- media element --------------------------------------------------------- */

/** Durations by URL, so `src = url` produces the length the test wants. */
const urlDurations = new Map();

class FakeAudio {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = NaN;
  preload = "";
  crossOrigin = null;
  /**
   * Where the crossfade lives now. A real element starts at 1; the player drops
   * each deck to 0 as it builds it and raises the one it is starting.
   */
  volume = 1;
  playCount = 0;
  loadCount = 0;
  /** When set, `play()` returns this promise instead of resolving at once. */
  pendingPlay = null;
  #src = null;
  #listeners = new Map();

  constructor() {
    elements.push(this);
  }

  get src() {
    return this.#src ?? "";
  }

  set src(value) {
    this.#src = value;
    this.currentTime = 0;
    this.ended = false;
    this.duration = urlDurations.get(value) ?? 20;
  }

  getAttribute(name) {
    return name === "src" ? this.#src : null;
  }

  setAttribute(name, value) {
    if (name === "src") this.src = value;
  }

  removeAttribute(name) {
    if (name !== "src") return;
    this.#src = null;
    this.paused = true;
    this.duration = NaN;
  }

  load() {
    this.loadCount += 1;
  }

  play() {
    if (this.#src === null) {
      return Promise.reject(new Error("no source"));
    }
    if (this.pendingPlay !== null) {
      // Deferred: the test decides when the element actually starts, which is
      // the window every play/skip/seek race lives in.
      const deferred = this.pendingPlay;
      this.pendingPlay = null;
      return deferred.promise.then(() => {
        this.paused = false;
        this.ended = false;
        this.playCount += 1;
      });
    }
    this.paused = false;
    this.ended = false;
    this.playCount += 1;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  addEventListener(type, fn) {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  dispatch(type) {
    for (const fn of this.#listeners.get(type) ?? []) fn({ type });
  }

  /** One wall-clock step of playback. */
  step(seconds) {
    if (this.paused || this.#src === null) return;
    if (!Number.isFinite(this.duration)) return;
    this.currentTime += seconds;
    if (this.currentTime < this.duration) return;
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.dispatch("ended");
  }
}

let elements = [];

/* --- clock ----------------------------------------------------------------- */

/** Lets a promise be settled from outside — see `FakeAudio.pendingPlay`. */
export function deferred() {
  let settle = () => {};
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle(undefined) };
}

/** Drain every pending microtask. */
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/* --- installation ---------------------------------------------------------- */

/**
 * Install the fakes as globals and hand back the controls.
 *
 * `resolver` is the source resolver the Player is built with; by default every
 * track resolves to `track:<id>`. Call `harness.dispose()` when done.
 */
export function install() {
  elements = [];
  urlDurations.clear();

  const ctx = new FakeContext();
  const timers = new Map();
  let nextTimerId = 1;
  let wallMs = 0;

  globalThis.AudioContext = function () {
    return ctx;
  };
  globalThis.Audio = FakeAudio;
  globalThis.window = {
    setInterval: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, ms, due: wallMs + ms });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
  };

  /** Track id -> what the resolver should do. */
  const sources = new Map();
  const resolveCalls = [];

  const resolver = async (track) => {
    resolveCalls.push(track.id);
    const entry = sources.get(track.id);
    if (entry === undefined) return `track:${track.id}`;
    if (entry.kind === "missing") return null;
    // The shape the real resolver actually has when a file has gone: the IPC
    // call rejects rather than answering null.
    if (entry.kind === "reject") throw new Error(`no file for track ${track.id}`);
    await entry.gate.promise;
    return `track:${track.id}`;
  };

  const events = [];
  const player = new Player(resolver);
  for (const name of ["trackchange", "progress", "statechange", "crossfade", "queued", "error"]) {
    player.on(name, (payload) => {
      if (name !== "progress") events.push({ name, payload });
    });
  }

  /**
   * Step wall-clock time forward, firing the player's interval and advancing
   * both the audio context (unless it is suspended) and every playing element.
   */
  const advance = async (seconds) => {
    let remaining = Math.round(seconds * 1000);
    while (remaining > 0) {
      const dtMs = Math.min(50, remaining);
      remaining -= dtMs;
      wallMs += dtMs;
      ctx.advance(dtMs / 1000);
      for (const el of [...elements]) el.step(dtMs / 1000);
      for (const timer of [...timers.values()]) {
        while (timer.due <= wallMs) {
          timer.due += timer.ms;
          timer.fn();
        }
      }
      await flush();
    }
    await flush();
  };

  return {
    player,
    ctx,
    events,
    resolveCalls,
    /** Deck A's element, then deck B's — the order the Player builds them in. */
    get elements() {
      return elements;
    },
    deck(id) {
      const el = elements[id === "A" ? 0 : 1];
      if (el === undefined) throw new Error(`no deck ${id}`);
      return el;
    },
    /**
     * The silent element the player mirrors onto the analyser.
     *
     * Built after both decks, so it is the third one. It is the *only* element
     * wired into the audio graph: the decks deliberately are not, because
     * routing one through `createMediaElementSource` takes it off the output
     * device, which is what silenced every deck under WebKitGTK.
     */
    analysisEl() {
      const el = elements[2];
      if (el === undefined) throw new Error("no analysis element");
      return el;
    },
    /** True when the player wired the analysis element to the analyser. */
    analysisIsWired() {
      return ctx.deckGains.has(this.analysisEl());
    },
    /** The deck currently carrying the active track. */
    activeEl() {
      return this.deck(player.activeDeck);
    },
    idleEl() {
      return this.deck(player.activeDeck === "A" ? "B" : "A");
    },
    setDuration(trackId, seconds) {
      urlDurations.set(`track:${trackId}`, seconds);
    },
    /** Make this track's file "missing" — the resolver answers null. */
    missing(trackId) {
      sources.set(trackId, { kind: "missing" });
    },
    /** Make this track's resolver *reject*, as the real one does. */
    unresolvable(trackId) {
      sources.set(trackId, { kind: "reject" });
    },
    /** Hold this track's resolution open until the returned gate is opened. */
    stall(trackId) {
      const gate = deferred();
      sources.set(trackId, { kind: "stall", gate });
      return gate;
    },
    named(name) {
      return events.filter((event) => event.name === name);
    },
    last(name) {
      const matching = this.named(name);
      return matching[matching.length - 1]?.payload;
    },
    advance,
    dispose() {
      player.dispose();
      timers.clear();
      delete globalThis.AudioContext;
      delete globalThis.Audio;
      delete globalThis.window;
    },
  };
}
