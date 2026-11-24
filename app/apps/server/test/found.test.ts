// found.ts: a file's boxes from the finder (by frame, in its pixels) as the
// track text_blur.ts and the model's masks read: each run pinned to its first
// and last frame, a caption read a few pixels off from frame to frame one still
// box, a mark that glides moving between its steps, captions told from labels
// by slot; the seconds to take out (joined, widened, never longer than a
// piece); what counts as looked at; and the judge's answer read.

import { expect, test } from "bun:test";

import * as found from "../src/found.ts";
import { boxAt } from "../src/text_blur.ts";
import { slotsOf } from "../src/text_track.ts";

const file = (masks: found.Mask[], covered: [number, number][] = [[0, 60]]): found.Found => ({ version: 1, width: 1000, height: 500, fps: 10, covered, masks });

/** Every slot's box at frame `frame` of a track (as text_blur.ts `boxesOf` reads it). */
const at = (track: ReturnType<typeof found.samplesOf>, frame: number, fps = 10) =>
  Object.fromEntries([...slotsOf(track)].flatMap(([slot, samples]) => {
    const box = boxAt(samples, frame / fps);
    return box === null ? [] : [[slot, box.map((value) => Math.round(value * 1000) / 1000)]];
  }));

test("a run is there from its first frame to its last and on no frame beside them", () => {
  const track = found.samplesOf(file([[20, 29, 100, 400, 500, 450, "subtitle"]]), 0, 6);
  expect(at(track, 19)).toEqual({});
  expect(at(track, 20)).toEqual({ c0: [0.1, 0.8, 0.5, 0.9] });
  expect(at(track, 29)).toEqual({ c0: [0.1, 0.8, 0.5, 0.9] });
  expect(at(track, 30)).toEqual({});
  // Far from it too (a gap between two reads is never filled with the box at its far end).
  expect(at(track, 5)).toEqual({});
  expect(at(track, 55)).toEqual({});
});

test("a caption read a few pixels off from one frame to the next is one still box; the next caption is its own", () => {
  const track = found.samplesOf(
    file([
      [20, 22, 100, 400, 500, 450, "subtitle"],
      [23, 25, 96, 398, 506, 452, "subtitle"],
      [26, 28, 102, 401, 498, 449, "subtitle"],
      // Another line right after, much narrower.
      [29, 40, 300, 400, 420, 450, "subtitle"],
    ]),
    0,
    6,
  );
  const whole = [0.096, 0.796, 0.506, 0.904];
  expect(at(track, 20)).toEqual({ c0: whole });
  expect(at(track, 24)).toEqual({ c0: whole });
  expect(at(track, 28)).toEqual({ c0: whole });
  expect(at(track, 29)).toEqual({ c0: [0.3, 0.8, 0.42, 0.9] });
  expect(at(track, 40)).toEqual({ c0: [0.3, 0.8, 0.42, 0.9] });
  expect(at(track, 41)).toEqual({});
});

test("a label and a caption on at once are each their own slot, and only the caption's is a caption", () => {
  const track = found.samplesOf(
    file([
      [0, 599, 800, 20, 950, 60, "label"],
      [20, 29, 100, 400, 500, 450, "subtitle"],
      [25, 35, 100, 300, 500, 350, "note"],
    ]),
    0,
    6,
  );
  expect(at(track, 10)).toEqual({ l0: [0.8, 0.04, 0.95, 0.12] });
  expect(at(track, 27)).toEqual({ c0: [0.1, 0.8, 0.5, 0.9], c1: [0.1, 0.6, 0.5, 0.7], l0: [0.8, 0.04, 0.95, 0.12] });
  expect(at(track, 33)).toEqual({ c1: [0.1, 0.6, 0.5, 0.7], l0: [0.8, 0.04, 0.95, 0.12] });
  expect(Object.keys(at(track, 27)).filter(found.isCaption)).toEqual(["c0", "c1"]);
});

test("a mark that glides moves between its steps", () => {
  const track = found.samplesOf(
    file([
      [10, 12, 100, 100, 200, 150, "mark"],
      [13, 15, 110, 100, 210, 150, "mark"],
      [16, 18, 120, 100, 220, 150, "mark"],
    ]),
    0,
    6,
  );
  expect(at(track, 10)).toEqual({ m0: [0.1, 0.2, 0.2, 0.3] });
  expect(at(track, 13)).toEqual({ m0: [0.11, 0.2, 0.21, 0.3] });
  expect(at(track, 18)).toEqual({ m0: [0.12, 0.2, 0.22, 0.3] });
  expect(at(track, 19)).toEqual({});
});

test("the seconds to take out: stretches a second apart joined, a quarter second wider, cut to what's shown, none over a piece", () => {
  const one = file([
    [100, 119, 0, 0, 10, 10, "subtitle"], // 10–12 s
    [125, 139, 0, 0, 10, 10, "subtitle"], // 12.5–14 s: joined
    [300, 309, 0, 0, 10, 10, "label"], // 30–31 s: its own
  ]);
  expect(found.spansOf(one, [[0, 60]])).toEqual([
    [9.75, 14.25],
    [29.75, 31.25],
  ]);
  // Only what the timeline shows.
  expect(found.spansOf(one, [[11, 13]])).toEqual([[11, 13]]);
  expect(found.spansOf(one, [[20, 25]])).toEqual([]);
  // A label on for two minutes: pieces of 30 s at most.
  const long = found.spansOf(file([[0, 1199, 0, 0, 10, 10, "label"]], [[0, 120]]), [[0, 120]]);
  expect(long.length).toBe(4);
  expect(long.every(([a, b]) => b - a <= found.LONGEST_S + 1e-6)).toBe(true);
  expect(long[0]![0]).toBe(0);
  expect(long.at(-1)![1]).toBe(120);
});

test("what the finder looked at: its shown stretches and a second past each", () => {
  const one = file([], [[10, 20], [40, 50]]);
  expect(found.covers(one, [[10, 20]])).toBe(true);
  expect(found.covers(one, [[9.5, 20.5], [41, 42]])).toBe(true);
  expect(found.covers(one, [[10, 30]])).toBe(false);
  expect(found.covers(one, [[60, 61]])).toBe(false);
});

test("the judge's answer is read out of whatever is round it, unknown words left out", () => {
  expect(found.readVerdicts('Here you go:\n{"0": "overlay", "1": "scene", "2": "camera", "3": "banana", "07": "unclear"}\nDone.')).toEqual({ "0": "overlay", "1": "scene", "2": "camera", "7": "unclear" });
  expect(found.readVerdicts("no idea")).toEqual({});
  expect(found.readVerdicts("{not json}")).toEqual({});
});

test("stretches cleaned from the room's picture at once, by the Mac's memory and cores", () => {
  const at = (gb: number, cores: number) => found.stillAtOnceFor(gb * 2 ** 30, cores);
  // An 8 GB M1 Air (kenobi): one. A 16 GB 10-core: five. The 17.2 GB M4: five. Mandalorian (30 GB, 32 threads): eight.
  expect([at(8, 8), at(16, 10), at(17.2, 10), at(24, 10), at(30, 32), at(4, 4)]).toEqual([1, 5, 5, 5, 8, 1]);
  // More memory or more cores is never fewer at once.
  for (const gb of [4, 8, 12, 16, 24, 32, 64]) for (const cores of [4, 8, 10, 16]) {
    expect(at(gb * 2, cores)).toBeGreaterThanOrEqual(at(gb, cores));
    expect(at(gb, cores * 2)).toBeGreaterThanOrEqual(at(gb, cores));
  }
});
