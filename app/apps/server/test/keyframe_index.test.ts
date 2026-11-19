// An excerpt's keyframe comes from the file's index, read once (keyframe_index.ts):
// Nov 18–19, JJ's Axon bodycam (6.3 GB, its index at the end, a keyframe every
// 8.3 s) had ffprobe read 25 s and more of footage over its cloud address for
// each excerpt, past two minutes on his line.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as keyframeIndex from "../src/keyframe_index.ts";
import { keyframeBefore } from "../src/script.ts";
import * as tools from "../src/tools.ts";

let dir: string;
/** 40 s, a keyframe every 10 s, B-frames (an edit list past their delay), its index at the end, as Axon's are. */
let late: string;
let server: ReturnType<typeof Bun.serve>;
const served = { requests: 0, bytes: 0 };

/** What ffprobe says the keyframes are, reading every picture. */
async function probed(path: string): Promise<number[]> {
  const out = new TextDecoder().decode(
    await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", path]),
  );
  return out.split("\n").map((line) => line.replace(/,+$/, "").trim()).filter((line) => line !== "").map(Number);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "keyframe-index-"));
  late = join(dir, "bodycam.mp4");
  await tools.run([
    tools.ffmpeg(), "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=40",
    "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=40",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "150", "-keyint_min", "150", "-sc_threshold", "0", "-bf", "3",
    "-c:a", "aac", "-shortest", late,
  ]);
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const bytes = fs.readFileSync(late);
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
      served.requests++;
      if (range === null) {
        served.bytes += bytes.length;
        return new Response(bytes);
      }
      const from = Number(range[1]);
      const to = range[2] === "" ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
      served.bytes += to + 1 - from;
      return new Response(bytes.subarray(from, to + 1), { status: 206, headers: { "content-range": `bytes ${from}-${to}/${bytes.length}` } });
    },
  });
});
afterAll(() => {
  void server.stop(true);
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  keyframeIndex.forget();
  served.requests = 0;
  served.bytes = 0;
});

test("the test file is laid out as the bodycam's: its index after its footage, an edit list past the B-frames' delay", async () => {
  const head = fs.readFileSync(late).subarray(0, 64);
  // ftyp, then the footage (after a `free` FFmpeg leaves), the index last.
  expect(head.toString("latin1")).toContain("ftyp");
  expect(fs.readFileSync(late).lastIndexOf("moov")).toBeGreaterThan(fs.readFileSync(late).indexOf("mdat"));
  expect(await probed(late)).toEqual([0, 10, 20, 30]);
});

test("keyframes from the index over a ranged URL match ffprobe's, in a few small reads, read once a file", async () => {
  const size = fs.statSync(late).size;
  const url = `http://127.0.0.1:${server.port}/edit/originals/drive/F/bodycam.mp4?X-Amz-Signature=one`;
  expect(await keyframeIndex.keyframeTimes(url)).toEqual(await probed(late));
  expect(served.requests).toBeLessThanOrEqual(4);
  expect(served.bytes).toBeLessThan(size / 4);
  // Another excerpt of it, with another signature: nothing read again.
  const before = served.requests;
  expect(await keyframeBefore(`http://127.0.0.1:${server.port}/edit/originals/drive/F/bodycam.mp4?X-Amz-Signature=two`, 27.5)).toBe(20);
  expect(await keyframeBefore(url, 9.99)).toBe(0);
  expect(await keyframeBefore(url, 10)).toBe(10);
  expect(served.requests).toBe(before);
});

test("a file on this disk reads its index too; a file that isn't an MP4 or MOV is left to ffprobe", async () => {
  expect(await keyframeIndex.keyframeTimes(late)).toEqual([0, 10, 20, 30]);
  const mkv = join(dir, "bodycam.mkv");
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", late, "-c", "copy", mkv]);
  expect(await keyframeIndex.keyframeTimes(mkv)).toBeNull();
  // ffprobe's own times there (Matroska's rounding, a fragment's B-frame delay without an edit list).
  expect(Math.abs((await keyframeBefore(mkv, 27.5)) - 20)).toBeLessThan(0.2);
  // Sound alone: no picture, no keyframe (an excerpt of it is cut from 0, as before).
  const sound = join(dir, "call.m4a");
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", late, "-vn", "-c:a", "copy", sound]);
  expect(await keyframeIndex.keyframeTimes(sound)).toEqual([]);
  expect(await keyframeBefore(sound, 27.5)).toBe(0);
});

test("a fragmented MP4 is left to ffprobe", async () => {
  const fragmented = join(dir, "fragmented.mp4");
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-i", late, "-c", "copy", "-movflags", "frag_keyframe+empty_moov", fragmented]);
  expect(await keyframeIndex.keyframeTimes(fragmented)).toBeNull();
  expect(Math.abs((await keyframeBefore(fragmented, 27.5)) - 20)).toBeLessThan(0.2);
});
