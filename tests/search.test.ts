/**
 * Regression tests for library search.
 *
 * The interesting claims are the ones that are easy to break by "simplifying"
 * the matcher into a single `includes`: word order, matching across two fields
 * at once, and accents.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { queryTerms, searchTracks } from "../src/search.ts";
import { makeTrack } from "./harness.ts";

/** Titles, so a failure names the track rather than its id. */
function titles(tracks) {
  return tracks.map((track) => track.title);
}

/** Files on disk, so `source` is only "generated" where a test means it to be. */
function onDisk(id, over) {
  return makeTrack(id, { source: "local", ...over });
}

const library = [
  onDisk(1, { title: "Around the World", uploader: "Daft Punk", genre: "house" }),
  onDisk(2, { title: "Jóga", uploader: "Björk", genre: "art pop" }),
  onDisk(3, { title: "Xtal", uploader: "Aphex Twin", genre: "ambient" }),
  onDisk(4, { title: "Ageispolis", uploader: "Aphex Twin", genre: "idm" }),
  onDisk(5, { title: "Windowlicker", uploader: "Aphex Twin", genre: "electronic" }),
  makeTrack(6, {
    title: "Rain on Glass",
    uploader: null,
    genre: "ambient",
    source: "generated",
  }),
  makeTrack(7, {
    title: "Live at the Barbican",
    uploader: "some channel",
    genre: "youtube",
    source: "youtube",
  }),
];

test("an empty query hands the list straight back", () => {
  assert.equal(searchTracks(library, ""), library);
  assert.equal(searchTracks(library, "   "), library);
});

test("matching ignores case", () => {
  assert.deepEqual(titles(searchTracks(library, "XTAL")), ["Xtal"]);
});

test("every word has to match, in any order and across any field", () => {
  // Two fields at once: the artist and the genre.
  assert.deepEqual(titles(searchTracks(library, "aphex ambient")), ["Xtal"]);
  assert.deepEqual(titles(searchTracks(library, "ambient aphex")), ["Xtal"]);
  // A word that matches nothing rules the row out however well the others did.
  assert.deepEqual(searchTracks(library, "aphex disco"), []);
});

test("accents are ignored on both sides", () => {
  assert.deepEqual(titles(searchTracks(library, "bjork")), ["Jóga"]);
  assert.deepEqual(titles(searchTracks(library, "joga")), ["Jóga"]);
  // And typing them still works, for anyone with the keyboard for it.
  assert.deepEqual(titles(searchTracks(library, "Björk")), ["Jóga"]);
});

test("letters that are not accented letters fold too", () => {
  // The ones no amount of NFD will take apart, and which a library of real
  // music is full of.
  const nordic = [
    onDisk(20, { title: "Empire State Human", uploader: "Sløtface" }),
    onDisk(21, { title: "Eple", uploader: "Röyksopp" }),
    onDisk(22, { title: "Straße", uploader: "Kraftwerk" }),
  ];
  assert.deepEqual(titles(searchTracks(nordic, "slotface")), ["Empire State Human"]);
  assert.deepEqual(titles(searchTracks(nordic, "royksopp")), ["Eple"]);
  assert.deepEqual(titles(searchTracks(nordic, "strasse")), ["Straße"]);
  // And, again, both ways round.
  assert.deepEqual(titles(searchTracks(nordic, "Sløtface")), ["Empire State Human"]);
});

test("results keep the order they were given in", () => {
  assert.deepEqual(titles(searchTracks(library, "aphex")), [
    "Xtal",
    "Ageispolis",
    "Windowlicker",
  ]);
});

test("a row with no artist is still searchable by its other fields", () => {
  assert.deepEqual(titles(searchTracks(library, "rain")), ["Rain on Glass"]);
  assert.deepEqual(titles(searchTracks(library, "generated")), ["Rain on Glass"]);
});

test("where a track came from is searchable", () => {
  assert.deepEqual(titles(searchTracks(library, "youtube")), ["Live at the Barbican"]);
});

test("the prompt and the file path are not searchable", () => {
  // Both carry text nothing on the row shows, so a match on either would put a
  // row in the list with no visible reason to be there.
  const track = onDisk(8, {
    title: "Untitled",
    uploader: null,
    genre: "ambient",
    prompt: "slow rain on a tin roof",
    path: "/music/tin-roof.mp3",
  });
  assert.deepEqual(searchTracks([track], "tin roof"), []);
});

test("queryTerms folds and splits the way the rows are folded", () => {
  assert.deepEqual(queryTerms("  Daft   PUNK "), ["daft", "punk"]);
  assert.deepEqual(queryTerms(""), []);
  assert.deepEqual(queryTerms("Sigur Rós"), ["sigur", "ros"]);
});
