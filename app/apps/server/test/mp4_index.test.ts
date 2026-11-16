import { afterAll, expect, test } from "bun:test";

import { blocksFor, parse, rangesFor, secondsHere, type Mp4Index } from "../src/mp4_index.ts";
import { ffmpeg, ffprobe, makeVbr, type Packet } from "./helpers/vbr_mp4.ts";

const have = ffmpeg !== null && ffprobe !== null;
const plain = have ? makeVbr() : null;
const reordered = have ? makeVbr({ bframes: 3 }) : null;
afterAll(() => {
  plain?.cleanup();
  reordered?.cleanup();
});

const indexOf = (bytes: Uint8Array): Mp4Index => {
  const parsed = parse(bytes, bytes.length);
  if (!("index" in parsed)) throw new Error(JSON.stringify(parsed));
  return parsed.index;
};

/** The packets of `stream` a reader needs for `from..to` by ffprobe's word: those showing then, from the keyframe before (sound: one before). */
function needed(packets: Packet[], stream: number, from: number, to: number): Packet[] {
  const all = packets.filter((one) => one.stream === stream);
  const byPts = [...all].sort((a, b) => a.pts - b.pts);
  const showing = new Set(byPts.filter((one, n) => one.pts < to && (byPts[n + 1]?.pts ?? Number.POSITIVE_INFINITY) > from));
  let first = all.findIndex((one) => showing.has(one));
  let last = all.length - 1 - [...all].reverse().findIndex((one) => showing.has(one));
  if (stream === 0) while (first > 0 && !all[first]!.key) first--;
  else first = Math.max(0, first - 1);
  return all.slice(first, last + 1);
}

test.skipIf(!have)("an MP4's index read from its start says every sample's time and bytes as ffprobe does; one cut short asks for the rest, one with its index at its end has none", () => {
  const { bytes, packets } = plain!;
  // Its first bytes only: how far to read.
  const short = parse(bytes.subarray(0, 100), bytes.length);
  expect("need" in short).toBe(true);
  const need = (short as { need: number }).need;
  expect("index" in parse(bytes.subarray(0, need), bytes.length)).toBe(true);
  const index = indexOf(bytes);
  expect(index.head).toBe(need);
  expect(index.head).toBeLessThan(Math.min(...packets.map((one) => one.pos)));
  for (const [n, kind] of (["video", "audio"] as const).entries()) {
    const track = index.tracks[n]!;
    const theirs = packets.filter((one) => one.stream === n);
    expect(track.kind).toBe(kind);
    expect(track.count).toBe(theirs.length);
    theirs.forEach((one, i) => {
      expect(track.offset[i]).toBe(one.pos);
      expect(track.size[i]).toBe(one.size);
      expect(Math.abs(track.start[i]! - one.pts)).toBeLessThan(1e-4);
    });
  }
  // Keyframes every half second.
  expect([...index.tracks[0]!.sync!].slice(0, 4)).toEqual([0, 15, 30, 45]);
  // Not faststart: nothing to read at its start.
  const tail = makeVbr({ faststart: false });
  try {
    expect("none" in parse(tail.bytes, tail.bytes.length)).toBe(true);
  } finally {
    tail.cleanup();
  }
  expect("none" in parse(new Uint8Array(4096).fill(7), 4096)).toBe(true);
});

test.skipIf(!have)("a stretch's bytes are exactly its samples' in every track from the keyframe before it, and the index; with B-frames too", () => {
  for (const file of [plain!, reordered!]) {
    const index = indexOf(file.bytes);
    for (const [from, to] of [[0, 1], [1.2, 1.8], [2.9, 3.3], [4.05, 4.6], [5.5, 9]] as const) {
      const ranges = rangesFor(index, from, to);
      const want = [...needed(file.packets, 0, from, to), ...needed(file.packets, 1, from, to)];
      for (const one of want) expect(ranges.some(([a, b]) => a <= one.pos && one.pos + one.size <= b)).toBe(true);
      // Nothing else: the ranges hold the index and those samples, no byte more.
      const total = ranges.reduce((sum, [a, b]) => sum + b - a, 0);
      expect(total).toBe(index.head + want.reduce((sum, one) => sum + one.size, 0));
    }
  }
  // The blocks they lie in (64 KiB ones here), ascending, none twice.
  const index = indexOf(plain!.bytes);
  const blocks = blocksFor(index, 4.05, 4.6, 65_536);
  const want = new Set([0, ...[...needed(plain!.packets, 0, 4.05, 4.6), ...needed(plain!.packets, 1, 4.05, 4.6)].flatMap((one) => {
    const out: number[] = [];
    for (let n = Math.floor(one.pos / 65_536); n <= Math.floor((one.pos + one.size - 1) / 65_536); n++) out.push(n);
    return out;
  })]);
  expect(blocks).toEqual([...want].sort((a, b) => a - b));
});

test.skipIf(!have)("the seconds here are those whose every picture (with its keyframe's run) and sound lies in blocks here, not an even share of the bytes", () => {
  const { bytes, packets } = plain!;
  const index = indexOf(bytes);
  const block = 65_536;
  const blocksOf = (one: Packet) => [Math.floor(one.pos / block), Math.floor((one.pos + one.size - 1) / block)] as const;
  const video = packets.filter((one) => one.stream === 0);
  const audio = packets.filter((one) => one.stream === 1);
  const last = Math.floor((bytes.length - 1) / block);
  // The first blocks only, to about half the file: up to the first sample of either track past them.
  const upTo = Math.floor(last / 2);
  const spans = secondsHere(index, (n) => n <= upTo, block);
  const until = Math.min(...[video, audio].map((track) => track.find((one) => blocksOf(one)[1] > upTo)!.pts));
  // (Past every track's end nothing is held back: that's the second, from 6 s on.)
  const end = Math.max(...index.tracks.map((track) => track.end));
  expect(spans.length).toBe(2);
  expect(spans[0]![0]).toBe(Number.NEGATIVE_INFINITY);
  expect(Math.abs(spans[0]![1] - until)).toBeLessThan(1e-4);
  expect(spans[1]).toEqual([end, Number.POSITIVE_INFINITY]);
  expect(end).toBeCloseTo(6, 1);
  // Half the bytes are far past half the seconds: the still's 3 s are a sliver of the file.
  const even = ((upTo + 1) * block / bytes.length) * 6;
  expect(until - even).toBeGreaterThan(1);
  // One block missing in the noise: up to its first sample, then on from the keyframe after its last picture.
  const hole = Math.floor(last * 0.75);
  const holed = secondsHere(index, (n) => n !== hole, block);
  const touching = (track: Packet[]) => track.filter((one) => blocksOf(one)[0] <= hole && hole <= blocksOf(one)[1]);
  const stop = Math.min(touching(video)[0]!.pts, touching(audio)[0]!.pts);
  const lastVideo = video.indexOf(touching(video).at(-1)!);
  const resume = Math.max(video.slice(lastVideo + 1).find((one) => one.key)!.pts, audio[audio.indexOf(touching(audio).at(-1)!) + 1]!.pts);
  expect(holed.length).toBe(2);
  expect(Math.abs(holed[0]![1] - stop)).toBeLessThan(1e-4);
  expect(Math.abs(holed[1]![0] - resume)).toBeLessThan(1e-4);
  expect(holed[1]![1]).toBe(Number.POSITIVE_INFINITY);
  // Its index not here: nothing.
  expect(secondsHere(index, (n) => n !== 0, block)).toEqual([]);
  // Everything here, B-frames or not: all of it.
  expect(secondsHere(indexOf(reordered!.bytes), () => true, block)).toEqual([[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]]);
});
