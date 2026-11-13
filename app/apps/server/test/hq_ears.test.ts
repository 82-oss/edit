// Bodycam HQ's sound in both ears (hq_ears.ts, ears.ts): Nov 13, a 911 call
// with the dispatcher in one ear and the caller in the other.

import { expect, test } from "bun:test";

test("a sound split between the ears is told from one heard on both", async () => {
  // Sphe, Nov 13, a 911 call: "part of the audio appears in one ear and part of the audio appears in the other ear".
  const { splitOf } = await import("../src/ears.ts");
  const rate = 8000;
  const stereo = (left: (i: number) => number, right: (i: number) => number) => {
    const out = new Float32Array(rate * 4 * 2);
    for (let i = 0; i < rate * 4; i++) { out[i * 2] = left(i); out[i * 2 + 1] = right(i); }
    return out;
  };
  const tone = (i: number) => 0.3 * Math.sin((2 * Math.PI * 200 * i) / rate);
  // A dispatcher on the left for two seconds, then a caller on the right.
  expect(splitOf(stereo((i) => (i < rate * 2 ? tone(i) : 0), (i) => (i >= rate * 2 ? tone(i) : 0)), rate)).toBe(true);
  // The same voice on both sides.
  expect(splitOf(stereo(tone, tone), rate)).toBe(false);
});

test("only speech is put in both ears: footage and recordings, never the library's music or effects", async () => {
  const { speech } = await import("../src/hq_ears.ts");
  const media = (more: Record<string, unknown>) => ({ id: "m", name: "x", path: "x", width: 0, height: 0, fps: 0, duration: 70, has_audio: true, ...more }) as never;
  expect(speech(media({ kind: "audio" }))).toBe(true);
  expect(speech(media({ kind: "video" }))).toBe(true);
  expect(speech(media({ kind: "audio", library: "sfx" }))).toBe(false);
  expect(speech(media({ kind: "audio", duration: 0.95 }))).toBe(false);
});

test("a clip whose stereo was put back on purpose is never given a side again", async () => {
  // Review, Nov 13: both_ears side "stereo" left no channel, and the turn's end measured it and set one.
  const { unsided } = await import("../src/hq_ears.ts");
  const sound = (id: string, channel?: string) => ({ id, type: "audio", track: "a1", start: 0, duration: 60, media: id, source_in: 2, speed: 1, ...(channel === undefined ? {} : { channel }) }) as never;
  expect([...unsided([sound("none"), sound("stereo", "stereo"), sound("left", "left")], 30)]).toEqual([["none", [[2, 2]]]]);
});
