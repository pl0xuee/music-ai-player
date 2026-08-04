/**
 * Regression tests for the shuffle bag.
 *
 * `Math.random` is replaced with a seeded generator so a claim about how often
 * two pools interleave is a fact about the code rather than about today's luck.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ShuffleBag } from "../src/audio/shuffle.ts";
import { makeTrack } from "./harness.ts";

/** mulberry32 — small, fast, and identical on every run. */
function seedRandom(seed) {
  const original = Math.random;
  let state = seed;
  Math.random = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    Math.random = original;
  };
}

/** 60 generated tracks around 128 BPM, 40 YouTube imports with no tempo. */
function mixedLibrary() {
  const generated = Array.from({ length: 60 }, (_, i) =>
    makeTrack(i + 1, { bpm: 120 + (i % 17), source: "generated" }),
  );
  const imported = Array.from({ length: 40 }, (_, i) =>
    makeTrack(1000 + i, {
      // The library column is NOT NULL, so an import stores a neutral zero.
      bpm: 0,
      source: "youtube",
      uploader: "a channel",
      keyScale: "",
    }),
  );
  return { generated, imported, all: [...generated, ...imported] };
}

/* --- M3: imports must interleave with generated tracks --------------------- */

test("M3: a cycle interleaves imports with generated tracks", (t) => {
  const restore = seedRandom(20260803);
  t.after(restore);

  const { all } = mixedLibrary();
  const bag = new ShuffleBag();
  bag.setLibrary(all);

  const order = [];
  let current = null;
  for (let i = 0; i < all.length; i += 1) {
    current = bag.next(current);
    assert.notEqual(current, null);
    order.push(current.source);
  }

  let crossings = 0;
  for (let i = 1; i < order.length; i += 1) {
    if (order[i] !== order[i - 1]) crossings += 1;
  }

  // Random interleaving of 60 and 40 gives about 2·0.6·0.4·99 ≈ 48 crossings.
  // Treating bpm 0 as a tempo 128 BPM away from everything gave exactly one:
  // the whole of one pool, then the whole of the other.
  assert.ok(
    crossings > 20,
    `expected the two pools to interleave, saw ${crossings} crossings in ${order.length} tracks`,
  );
  assert.equal(new Set(order).size, 2, "both pools played");
});

test("M3: an import can follow a generated track and vice versa", (t) => {
  const restore = seedRandom(7);
  t.after(restore);

  const { generated, imported, all } = mixedLibrary();

  const afterGenerated = new Set();
  const afterImport = new Set();
  for (let run = 0; run < 40; run += 1) {
    const bag = new ShuffleBag();
    bag.setLibrary(all);
    afterGenerated.add(bag.next(generated[0]).source);
    const other = new ShuffleBag();
    other.setLibrary(all);
    afterImport.add(other.next(imported[0]).source);
  }

  assert.deepEqual([...afterGenerated].sort(), ["generated", "youtube"]);
  assert.deepEqual([...afterImport].sort(), ["generated", "youtube"]);
});

test("M3: a known tempo is still preferred among tracks that have one", (t) => {
  const restore = seedRandom(99);
  t.after(restore);

  // No imports here, so the BPM window is the only thing shaping the draw.
  const library = [
    makeTrack(1, { bpm: 128 }),
    makeTrack(2, { bpm: 130 }),
    makeTrack(3, { bpm: 200 }),
    makeTrack(4, { bpm: 201 }),
  ];
  const picks = new Set();
  for (let run = 0; run < 30; run += 1) {
    const bag = new ShuffleBag();
    bag.setLibrary(library);
    // Playing track 1 is what takes it out of the running for the next draw.
    bag.markPlayed(1);
    picks.add(bag.next(library[0]).id);
  }
  assert.deepEqual([...picks], [2], "only the one inside the 8 BPM window");
});

/* --- bag invariants -------------------------------------------------------- */

test("the whole library plays before anything repeats", (t) => {
  const restore = seedRandom(4242);
  t.after(restore);

  const library = Array.from({ length: 24 }, (_, i) => makeTrack(i + 1, { bpm: 120 + i }));
  const bag = new ShuffleBag();
  bag.setLibrary(library);

  const seen = new Set();
  let current = null;
  for (let i = 0; i < library.length; i += 1) {
    current = bag.next(current);
    assert.equal(seen.has(current.id), false, `track ${current.id} repeated inside one cycle`);
    seen.add(current.id);
  }
  assert.equal(seen.size, library.length);
});

test("a buried track leaves circulation", (t) => {
  const restore = seedRandom(11);
  t.after(restore);

  const library = [makeTrack(1), makeTrack(2), makeTrack(3)];
  const bag = new ShuffleBag();
  bag.setLibrary(library);
  bag.setRating(2, -1);

  for (let i = 0; i < 30; i += 1) {
    assert.notEqual(bag.next(null).id, 2);
  }
  assert.equal(bag.size, 2);
});
