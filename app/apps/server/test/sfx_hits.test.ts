// A file of several hits plays one (JJ, Oct 31–Nov 6: three clicks for one
// picture, on four videos): its bursts found, and a clip still playing two flagged.

import { expect, test } from "bun:test";

import { soundEffectsSeveralHits } from "../src/edit_tools.ts";
import { burstsOf } from "../src/library.ts";
import type { Project } from "../src/model.ts";

const STEP = 0.02;

test("a file's separate hits are its bursts, quiet between; a short dip inside one doesn't split it", () => {
  // "Click… Variations" as the addon measured it: clicks at 0, 0.56 and 1.16 s.
  const peaks = Array<number>(62).fill(-Infinity);
  for (const [at, peak] of [[0, -14], [1, -3], [2, -28], [3, -48], [28, -29], [29, -6], [30, -25], [31, -5], [32, -33], [33, -91], [58, -3], [59, -28], [60, -2], [61, -39]] as const) peaks[at] = peak;
  const bursts = burstsOf(peaks, STEP).map(([from, to]) => [Math.round(from * 100) / 100, Math.round(to * 100) / 100]);
  expect(bursts).toEqual([[0, 0.06], [0.56, 0.64], [1.16, 1.22]]);
  // One click: one burst; silence: none.
  expect(burstsOf([-6, -20, -Infinity, -Infinity], STEP)).toHaveLength(1);
  expect(burstsOf([-Infinity, -Infinity], STEP)).toEqual([]);
});

const project = (duration: number, sourceIn = 0) =>
  ({
    settings: { fps: 30, width: 1920, height: 1080 },
    tracks: [],
    media: [{ id: "m1", kind: "audio", name: "User Interface, Click, Button, Press, Click, Video Game, Variations.wav", duration: 1.24, markers: [{ time: 0.025, name: "hit", note: "" }, { time: 0.56, name: "another hit", note: "" }, { time: 1.16, name: "another hit", note: "" }] }],
    clips: [{ id: "c1", type: "audio", media: "m1", track: "a1", start: 90, duration, source_in: sourceIn, speed: 1, volume_db: -8 }],
  }) as unknown as Project;

test("a clip playing two or more of its file's hits is flagged, with the length that plays one", () => {
  const [flag] = soundEffectsSeveralHits(project(38)) as { kind: string; hits: number; fix: string }[];
  expect(flag?.kind).toBe("sfx_several_hits");
  expect(flag?.hits).toBe(3);
  expect(flag?.fix).toContain("duration 16 frames");
  // One hit's stretch, or the last click alone, is fine.
  expect(soundEffectsSeveralHits(project(6))).toEqual([]);
  expect(soundEffectsSeveralHits(project(3, 1.15))).toEqual([]);
});
