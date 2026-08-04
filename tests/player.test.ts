/**
 * Regression tests for the audio path.
 *
 * Every test here reproduces a defect that shipped: revert the fix it names and
 * it fails. They drive the real `Player` against the fake browser objects in
 * `harness.ts`, on a manual clock, so a crossfade or a ten-second pause takes
 * no wall-clock time at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { install, makeTrack } from "./harness.ts";

/** Play the given list in order, then stop. */
function playInOrder(player, tracks) {
  player.setNextSelector((current) => {
    if (current === null) return tracks[0] ?? null;
    const at = tracks.findIndex((track) => track.id === current.id);
    return at === -1 ? null : (tracks[at + 1] ?? null);
  });
}

/* --- W1: the decks must stay out of the audio graph ------------------------ */

test("W1: no deck is ever wired into the AudioContext", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1), makeTrack(2)];
  playInOrder(player, [a, b]);
  await player.play(a);
  await harness.advance(1);

  // This is the whole reason the player sounds at all on Linux. WebKitGTK's
  // Web Audio *output* stops emitting about a second in — proven with a bare
  // OscillatorNode, so it is the destination itself, not the media source node
  // — and `createMediaElementSource` moves an element off the output device
  // and onto that dead path. Wiring a deck up here is silent in every test but
  // this one, and costs the user all sound a second after each track starts.
  for (const id of ["A", "B"]) {
    assert.equal(
      harness.ctx.deckGains.has(harness.deck(id)),
      false,
      `deck ${id} must play straight to the media backend, not through Web Audio`,
    );
  }

  // The analyser still has to be fed, so exactly one element does go through
  // the graph: the silent mirror the visualiser reads.
  assert.equal(harness.analysisIsWired(), true, "the analyser has nothing to measure");
  assert.notEqual(harness.analysisEl(), harness.deck("A"));
  assert.notEqual(harness.analysisEl(), harness.deck("B"));
});

test("W1: the analysis element follows the audible deck", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1), makeTrack(2)];
  playInOrder(player, [a, b]);
  await player.play(a);
  await harness.advance(2);

  const analysis = harness.analysisEl();
  assert.equal(analysis.src, harness.activeEl().src, "same track as the one being heard");
  assert.equal(analysis.paused, false, "and running, or the spectrum is flat");
  assert.ok(
    Math.abs(analysis.currentTime - harness.activeEl().currentTime) <= 0.2,
    "and roughly in step with it",
  );

  // A pause has to take the mirror down too, or the visualiser keeps dancing
  // to a track nobody is hearing.
  player.pause();
  assert.equal(analysis.paused, true);
});

test("W1: volume and the crossfade share el.volume", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1), makeTrack(2)];
  playInOrder(player, [a, b]);
  await player.play(a);
  await harness.advance(1);

  // A media element has one gain to give, so the deck's fader and the listening
  // volume have to be multiplied together before they reach it.
  player.setVolume(0.5);
  assert.equal(harness.activeEl().volume, 0.5, "full fader times half volume");

  player.setVolume(0);
  assert.equal(harness.activeEl().volume, 0, "silence is reachable");

  player.setVolume(1);
  assert.equal(harness.activeEl().volume, 1);

  // Mid-fade the two decks must still sum to roughly constant power rather
  // than both sitting at the listening volume.
  await harness.advance(12);
  assert.equal(player.isCrossfading, true);
  const outgoing = harness.activeEl().volume;
  const incoming = harness.idleEl().volume;
  assert.ok(
    Math.abs(outgoing * outgoing + incoming * incoming - 1) < 0.05,
    `equal power across the handover (got ${outgoing} and ${incoming})`,
  );
});

/* --- C1: a missing file must not kill the player silently ------------------ */

test("C1: a resolver that rejects mid-session does not strand the player", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b, c] = [makeTrack(1), makeTrack(2), makeTrack(3)];
  playInOrder(player, [a, b, c]);
  // The real resolver rejects when the row's file has gone; the type says it
  // resolves null, and nothing used to guard the difference.
  harness.unresolvable(b.id);

  assert.equal(await player.play(a), true);
  await harness.advance(1);
  // B could not be armed, so nothing is queued — and the UI is told so.
  assert.equal(player.queuedTrack, null);
  assert.equal(harness.last("queued").track, null);

  // Run A out. The end of a track is where the unhandled rejection used to
  // escape: `advance()` threw, no event was emitted, and the transport was
  // left insisting it was still playing.
  await harness.advance(25);

  assert.equal(player.currentTrack?.id, c.id, "the bad row is stepped over, not fatal");
  assert.equal(player.isPlaying, true);
  assert.equal(harness.last("statechange").playing, true);
  assert.ok(
    harness.named("error").some((event) => event.payload.message.includes(b.title)),
    "the missing file is reported",
  );
});

test("C1: play() on a track with no file says the player stopped", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const track = makeTrack(1);
  harness.unresolvable(track.id);

  assert.equal(await player.play(track), false);
  assert.equal(harness.last("error").message.includes(track.title), true);
  // Without this the button keeps reading "Pause" for a player that will never
  // make another sound.
  assert.deepEqual(harness.last("statechange"), { playing: false });
  assert.equal(player.isPlaying, false);
});

test("C1: a library whose files have all gone stops instead of spinning", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const tracks = [makeTrack(1), makeTrack(2), makeTrack(3), makeTrack(4)];
  // A selector that keeps offering rows, as the shuffle bag does.
  let at = 0;
  player.setNextSelector(() => {
    at += 1;
    return tracks[at % tracks.length] ?? null;
  });
  for (const track of tracks) harness.unresolvable(track.id);

  await player.skip();

  assert.equal(player.currentTrack, null);
  assert.deepEqual(harness.last("statechange"), { playing: false });
  assert.ok(harness.resolveCalls.length <= 12, "the retry loop is bounded");
});

/* --- M1: a fade must not complete on wall-clock time while paused ---------- */

test("M1: pausing mid-crossfade freezes it until the user comes back", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1), makeTrack(2)];
  playInOrder(player, [a, b]);
  harness.setDuration(a.id, 20);
  harness.setDuration(b.id, 20);

  await player.play(a);
  // 20s track, 8s fade: the handover starts at t = 12.
  await harness.advance(13);
  assert.equal(player.isCrossfading, true);
  const incoming = harness.idleEl();
  assert.equal(incoming.paused, false);

  const changesBeforePause = harness.named("trackchange").length;
  player.pause();
  assert.equal(incoming.paused, true);
  const incomingAt = incoming.currentTime;
  // The fade is measured against the outgoing element's own clock, so this is
  // the clock that must stop. Nothing else has to be suspended to freeze the
  // handover — a paused element simply stops counting.
  const outgoingAt = harness.activeEl().currentTime;

  // Ten seconds away from the keyboard. The fade is eight seconds long.
  await harness.advance(10);
  assert.equal(
    harness.named("trackchange").length,
    changesBeforePause,
    "no track may change hands while nothing is playing",
  );
  assert.equal(player.isCrossfading, true);
  assert.equal(incoming.currentTime, incomingAt, "the incoming deck stayed put");
  assert.equal(
    harness.activeEl().currentTime,
    outgoingAt,
    "the clock the fade reads must stop too",
  );
  assert.equal(player.currentTrack?.id, a.id);

  // Coming back finishes the handover from where it was, not from where the
  // wall clock got to.
  await player.resume();
  assert.equal(harness.activeEl().paused, false);
  await harness.advance(2);
  assert.equal(player.isCrossfading, true, "about 5s of the fade were still to run");
  await harness.advance(6);
  assert.equal(player.currentTrack?.id, b.id, "the handover completes after the fade, not before");
});

/* --- M2: a cancelled fade must stay cancelled ------------------------------ */

test("M2: picking a track mid-fade is not undone by the fade that was cancelled", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b, chosen] = [makeTrack(1), makeTrack(2), makeTrack(3)];
  playInOrder(player, [a, b]);
  harness.setDuration(a.id, 20);
  harness.setDuration(b.id, 20);
  harness.setDuration(chosen.id, 20);

  await player.play(a);
  // Hold the incoming deck's play() open: that await is the window where a
  // user's click used to be silently reversed.
  const idle = harness.idleEl();
  const gate = { promise: null, resolve: null };
  gate.promise = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  idle.pendingPlay = gate;

  await harness.advance(13);
  assert.equal(player.isCrossfading, true, "the fade has been claimed");

  // The user clicks a library row while the handover is still starting up.
  const chosenDeckId = player.activeDeck;
  await player.play(chosen);
  assert.equal(player.isCrossfading, false);
  const chosenVolume = harness.deck(chosenDeckId).volume;
  assert.ok(chosenVolume > 0, "the chosen track is audible");

  // …and only now does the incoming deck report that it started.
  gate.resolve();
  await harness.advance(1);

  assert.equal(player.currentTrack?.id, chosen.id);
  assert.equal(player.isCrossfading, false, "the cancelled fade must not be re-armed");
  assert.equal(
    harness.deck(chosenDeckId).volume,
    chosenVolume,
    "nothing may fade down the track the user just chose",
  );

  // Long enough for the resurrected fade to have completed and promoted the
  // deck `cancelFade` had already paused.
  await harness.advance(10);
  assert.equal(player.currentTrack?.id, chosen.id, "the chosen track is still the one playing");
  assert.equal(player.isPlaying, true);
});

test("M2: completeFade refuses to promote a deck that is not running", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1), makeTrack(2)];
  playInOrder(player, [a, b]);
  harness.setDuration(a.id, 20);
  harness.setDuration(b.id, 20);

  await player.play(a);
  await harness.advance(13);
  assert.equal(player.isCrossfading, true);

  // Something pauses the incoming deck behind the player's back.
  harness.idleEl().pause();
  await harness.advance(8);

  assert.equal(player.currentTrack, null, "a silent deck is never promoted");
  assert.deepEqual(harness.last("statechange"), { playing: false });
});

/* --- m1: a cancelled fade rewinds the deck it had started ------------------ */

test("m1: cancelling a fade rewinds the queued track to the top", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1), makeTrack(2)];
  playInOrder(player, [a, b]);
  harness.setDuration(a.id, 20);
  harness.setDuration(b.id, 20);

  await player.play(a);
  await harness.advance(15);
  const incoming = harness.idleEl();
  assert.ok(incoming.currentTime > 1, "the queued deck has been running for a few seconds");

  player.seek(2);
  assert.equal(player.isCrossfading, false);
  assert.equal(incoming.currentTime, 0, "or it would start further in every time");
});

/* --- m2: a short track must not fade from t = 0 ---------------------------- */

test("m2: a track shorter than the crossfade fades over half its length", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1, { duration: 6 }), makeTrack(2)];
  playInOrder(player, [a, b]);
  harness.setDuration(a.id, 6);
  harness.setDuration(b.id, 20);

  await player.play(a);
  const active = player.activeDeck;
  await harness.advance(1);
  assert.equal(player.isCrossfading, false, "a 6s track must be heard on its own first");
  await harness.advance(1.5);
  assert.equal(player.isCrossfading, false);

  // Half of six is three: the handover starts at t = 3, not t = 0.
  await harness.advance(1);
  assert.equal(player.isCrossfading, true);

  const fullVolume = harness.deck(active).volume;
  await harness.advance(0.5);
  assert.ok(
    harness.deck(active).volume < fullVolume,
    "the outgoing deck is on its way down",
  );

  // The fade being three seconds rather than the full eight is what lets it
  // finish inside what is left of the track. An 8-second fade would still be
  // climbing when the file ran out, and the handover would never complete.
  await harness.advance(3);
  assert.equal(
    player.currentTrack?.id,
    b.id,
    "the 3s handover completed within the 6s track",
  );
});

test("m2: a duration that is not a number never triggers a fade", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [a, b] = [makeTrack(1), makeTrack(2)];
  playInOrder(player, [a, b]);
  await player.play(a);
  harness.activeEl().duration = Number.NaN;
  await harness.advance(2);
  assert.equal(player.isCrossfading, false);

  harness.activeEl().duration = 0;
  await harness.advance(2);
  assert.equal(player.isCrossfading, false);
});

/* --- m7: the last click wins ---------------------------------------------- */

test("m7: a second click while the first is still resolving wins", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const [slow, chosen] = [makeTrack(1), makeTrack(2)];
  player.setNextSelector(() => null);
  const gate = harness.stall(slow.id);

  const first = player.play(slow);
  await Promise.resolve();
  // Impatient second click, resolving immediately.
  assert.equal(await player.play(chosen), true);
  assert.equal(player.currentTrack?.id, chosen.id);

  // The first click's IPC finally answers.
  gate.resolve();
  assert.equal(await first, false, "the overtaken call reports that it did not start");
  await harness.advance(0.5);

  assert.equal(player.currentTrack?.id, chosen.id, "the track that landed last is the one playing");
  assert.equal(harness.activeEl().src, `track:${chosen.id}`);
  const changes = harness.named("trackchange").map((event) => event.payload.track?.id);
  assert.deepEqual(changes, [chosen.id], "and the stale one announced nothing");
});

/* --- transport basics ------------------------------------------------------ */

test("pause/resume keeps the position and reports both states", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const track = makeTrack(1);
  player.setNextSelector(() => null);
  await player.play(track);
  await harness.advance(3);
  const at = harness.activeEl().currentTime;

  player.pause();
  assert.deepEqual(harness.last("statechange"), { playing: false });
  await harness.advance(5);
  assert.equal(harness.activeEl().currentTime, at, "a paused deck does not move");

  await player.resume();
  assert.deepEqual(harness.last("statechange"), { playing: true });
  await harness.advance(1);
  assert.ok(harness.activeEl().currentTime > at);
});

test("a track that ends with nothing queued stops the player", async (t) => {
  const harness = install();
  t.after(() => harness.dispose());
  const { player } = harness;

  const track = makeTrack(1);
  harness.setDuration(track.id, 5);
  player.setNextSelector(() => null);

  await player.play(track);
  await harness.advance(6);

  assert.equal(player.currentTrack, null);
  assert.deepEqual(harness.last("statechange"), { playing: false });
});
