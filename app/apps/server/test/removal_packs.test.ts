// removal_packs.ts: stretches of many files sent to vmake.ai as one file of
// their mode's length, and Vmake's result cut back into each, frame for frame,
// at each one's own size and rate.

import { expect, test } from "bun:test";

import { join } from "../src/paths.ts";
import * as packs from "../src/removal_packs.ts";
import * as tr from "../src/text_removal.ts";
import * as tools from "../src/tools.ts";
import { scratch } from "./helpers/home.ts";

test("stretches pack into as few files as fit their mode's length: Smart Pro 300 s, Smart 600 s, held to the byte cap at the website's quality", () => {
  expect(packs.MODE_SECONDS).toEqual({ pro: 300, smart: 600 });
  expect(packs.limitOf("pro")).toBe(300);
  expect(packs.limitOf("smart")).toBe(600);
  // The website's pieces go at 6 Mbit/s: 600 s of it is over 300 MB, so its Smart packs stop at 360 s (never softer than a piece alone).
  expect(packs.limitOf("smart", { rate: 6_000_000 })).toBe(360);
  expect(packs.limitOf("pro", { rate: 6_000_000 })).toBe(300);
  // Forty short stretches (3–7 s, ~200 s in all): one file, its members in their order.
  const short = Array.from({ length: 40 }, (_, index) => ({ index, seconds: 3 + (index % 5) }));
  const one = packs.packsOf(short, 300);
  expect(one.length).toBe(1);
  expect(one[0]!.map((item) => item.index)).toEqual(short.map((item) => item.index));
  // Long ones too: never over the limit, as few as fit (first fit, longest first).
  const mixed = [290, 287, 247, 120, 56, 16, 5, 5, 3, 2].map((seconds, index) => ({ index, seconds }));
  const pro = packs.packsOf(mixed, 300);
  for (const pack of pro) expect(pack.reduce((sum, item) => sum + item.seconds + 0.05, 0)).toBeLessThanOrEqual(300);
  expect(pro.length).toBe(4);
  const smart = packs.packsOf(mixed, 600);
  for (const pack of smart) expect(pack.reduce((sum, item) => sum + item.seconds + 0.05, 0)).toBeLessThanOrEqual(600);
  expect(smart.length).toBe(2);
  // Exactly the limit fits; a hair over doesn't.
  expect(packs.packsOf([{ index: 0, seconds: 299.95 }], 300).length).toBe(1);
  expect(packs.packsOf([{ index: 0, seconds: 150 }, { index: 1, seconds: 150 }], 300).length).toBe(2);
  expect(packs.packsOf([{ index: 0, seconds: 149.9 }, { index: 1, seconds: 149.9 }], 300).length).toBe(1);
});

test("a pack's name comes from its mode and its members, the same after a restart, another for another try or mode", () => {
  const members = [
    { key: "youtube:a|10|15", tries: 0 },
    { key: "sha256:b|0|3.2|smart", tries: 0 },
  ];
  const id = packs.packId("smart", members);
  expect(id).toMatch(/^[0-9a-f]{16}$/u);
  expect(packs.packId("smart", structuredClone(members))).toBe(id);
  expect(packs.packId("pro", members)).not.toBe(id);
  expect(packs.packId("smart", [members[0]!, { ...members[1]!, tries: 1 }])).not.toBe(id);
  expect(packs.packId("smart", [members[1]!, members[0]!])).not.toBe(id);
});

test("the layout: the largest member's size, the highest rate, each stretch's frames laid at it", () => {
  const plan = packs.layout([
    { width: 1920, height: 1080, rate: { num: 30, den: 1 }, frames: 90 },
    { width: 640, height: 360, rate: { num: 30000, den: 1001 }, frames: 100 },
    { width: 1440, height: 1080, rate: { num: 25, den: 1 }, frames: 50 },
    { width: 1920, height: 1080, rate: { num: 24000, den: 1001 }, frames: 24 },
  ]);
  expect([plan.width, plan.height, plan.rate]).toEqual([1920, 1080, { num: 30, den: 1 }]);
  expect(plan.places.map((one) => one.slots)).toEqual([90, 101, 60, 31]);
  expect(plan.places.map((one) => one.start)).toEqual([0, 90, 191, 251]);
  expect(plan.places[1]!.box).toEqual([0, 0, 1920, 1080]);
  // 4:3 in 16:9: pillarboxed, centred.
  expect(plan.places[2]!.box).toEqual([240, 0, 1440, 1080]);
  expect(plan.seconds).toBe(9.4);
});

/** A test source whose every frame says its number (its grey: 28 + 7·n mod 200), at `size` and `rate`. */
async function numbered(dir: string, name: string, size: string, rate: string, seconds: number): Promise<string> {
  const file = join(dir, `${name}.mp4`);
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `nullsrc=s=${size}:r=${rate}:d=${seconds},geq=lum='28+mod(N*7\\,200)':cb=128:cr=128,format=yuv420p`, "-c:v", "libx264", "-qp", "0", "-g", "12", file]);
  return file;
}

/** Each frame's grey (the middle of the picture, away from any bars). */
async function greys(file: string): Promise<number[]> {
  const raw = await tools.run([tools.ffmpeg(), "-v", "error", "-i", file, "-vf", "crop=iw/4:ih/4:iw*3/8:ih*3/8,scale=4:4,format=gray", "-f", "rawvideo", "-"]);
  const out: number[] = [];
  for (let at = 0; at + 16 <= raw.length; at += 16) out.push(Math.round(raw.slice(at, at + 16).reduce((sum, one) => sum + one, 0) / 16));
  return out;
}

test("stretches of files of different sizes and rates go as one pack and come back frame for frame, at their own size and rate; Vmake changing the rate is brought back by time", async () => {
  const { dir, cleanup } = scratch("packs-exact");
  try {
    const sources = [
      { file: await numbered(dir, "a", "320x180", "30", 8), from: 2.5, to: 5.9 },
      { file: await numbered(dir, "b", "240x180", "25", 8), from: 1.04, to: 4.2 },
      { file: await numbered(dir, "c", "320x180", "30000/1001", 8), from: 0, to: 2.7 },
      { file: await numbered(dir, "d", "160x90", "24000/1001", 8), from: 3.3, to: 6.1 },
    ];
    const quality = { crf: 12, rate: 20_000_000 };
    const originals: string[] = [];
    const given: packs.Source[] = [];
    for (const [index, one] of sources.entries()) {
      const rate = await packs.rateOf(one.file);
      const original = join(dir, `original-${index}.mp4`);
      await tr.cutPiece(one.file, one.from, one.to, original, 300_000_000, quality, rate);
      originals.push(original);
      given.push({ input: one.file, from: one.from, seconds: one.to - one.from, rate });
    }
    const cuts = await Promise.all(originals.map((one) => packs.cutOf(one)));
    expect(cuts.map((one) => [one.width, one.height, one.rate])).toEqual([
      [320, 180, { num: 30, den: 1 }],
      [240, 180, { num: 25, den: 1 }],
      [320, 180, { num: 30000, den: 1001 }],
      [160, 90, { num: 24000, den: 1001 }],
    ]);
    const plan = packs.layout(cuts);
    const pack = join(dir, "pack.mp4");
    await packs.build(given, plan, pack, quality);
    const packed = await packs.cutOf(pack);
    expect([packed.width, packed.height, packed.rate, packed.frames]).toEqual([320, 180, { num: 30, den: 1 }, plan.places.reduce((sum, one) => sum + one.slots, 0)]);
    // Vmake as itself (what it gave back is the pack), and Vmake giving it back at another rate (Smart's 23.976 → 29.97 of Nov 19).
    const resampled = join(dir, "resampled.mp4");
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", pack, "-vf", "fps=60", "-c:v", "libx264", "-qp", "0", resampled]);
    for (const result of [pack, resampled]) {
      const start = await packs.fits(result, plan);
      for (const [index, original] of originals.entries()) {
        const back = join(dir, `back-${index}.mp4`);
        await packs.unpack(result, plan, index, back, start);
        const [want, got] = [await greys(original), await greys(back)];
        expect(got.length).toBe(want.length);
        // Frame for frame: each frame's number, never its neighbour's (7 grey apart).
        expect(got.every((grey, at) => Math.abs(grey - want[at]!) <= 2)).toBe(true);
        expect((await packs.cutOf(back))).toMatchObject({ width: cuts[index]!.width, height: cuts[index]!.height, rate: cuts[index]!.rate });
      }
    }
    // A result of another length isn't this pack's.
    const short = join(dir, "short.mp4");
    await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", pack, "-t", "5", "-c", "copy", short]);
    await expect(packs.fits(short, plan)).rejects.toThrow("not the pack's");
  } finally {
    cleanup();
  }
}, 120_000);
