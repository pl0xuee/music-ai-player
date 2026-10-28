/**
 * Regression tests for the playlist walk.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { nextInPlaylist } from "../src/queue.ts";
import { makeTrack } from "./harness.ts";

function item(id, over = {}) {
  return { ...makeTrack(id), itemId: id * 10, position: id, addedAt: "", ...over };
}

test("a dead entry mid-playlist is stepped over, not a reason to go back to the top", () => {
  const items = [1, 2, 3, 4, 5].map((id) => item(id));
  // Track 3 has just failed to start, so it is both dead and the "current"
  // the player asks about while it looks for something else.
  const dead = new Set([3]);
  assert.equal(nextInPlaylist(items, items[2], dead)?.id, 4);
  assert.equal(nextInPlaylist(items, items[1], dead)?.id, 4);
});

test("the walk wraps, skips rows with no file, and stops when nothing else plays", () => {
  const items = [item(1), item(2, { path: null }), item(3)];
  assert.equal(nextInPlaylist(items, items[2], new Set())?.id, 1);
  assert.equal(nextInPlaylist(items, items[0], new Set())?.id, 3);
  assert.equal(nextInPlaylist(items, null, new Set())?.id, 1);
  assert.equal(nextInPlaylist(items, items[0], new Set([3])), null);
});
