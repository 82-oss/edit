// Every excerpt is checked as soon as it's cut (script.excerptProblem): it reads
// back as long as was asked, or up to the footage's end. Nov 1: a 911 call's
// 0–55 s excerpt was AAC in a .wav, read back as 27.6 s, and stopped an import.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { cut, excerptProblem } from "../src/script.ts";
import * as tools from "../src/tools.ts";

let dir: string;
let call: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "excerpt-check-"));
  call = join(dir, "911_Call.wav");
  // As the team's 911 calls come: µ-law, 8 kHz, stereo, 30 s.
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=30", "-ac", "2", "-c:a", "pcm_mulaw", call]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("an excerpt that can't hold what was cut is caught: AAC written into a .wav, as before the fix", async () => {
  const broken = join(dir, "broken.wav");
  await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-ss", "0", "-i", call, "-t", "20", "-c:a", "aac", "-b:a", "192k", broken]);
  expect(await excerptProblem(call, 0, 20, broken)).toMatch(/runs \d+\.\d s, not 20\.0 s|can't be read back/);
});

test("a right cut passes, and so does one asked past the footage's end", async () => {
  const good = join(dir, "good.m4a");
  await cut(call, 2, 22, good);
  expect(await excerptProblem(call, 2, 22, good)).toBeNull();
  const tail = join(dir, "tail.m4a");
  await cut(call, 20, 45, tail);
  expect(fs.existsSync(tail)).toBe(true);
});

test("cut refuses and removes an excerpt that comes out wrong", async () => {
  const wrong = join(dir, "wrong.wav");
  const failed = await cut(call, 0, 20, wrong).catch((error: unknown) => error);
  expect((failed as Error).message).toContain("came out wrong");
  expect(fs.existsSync(wrong)).toBe(false);
});

test("copied picture running on by its B-frames' reorder delay is the stretch asked, not an excerpt come out wrong", async () => {
  // Nov 18, JJ's Axon bodycam: a 0.6 s reorder delay, its 29.2 s excerpt read 29.8 s (every frame sound) and was
  // refused twice. Here 3 fps with 3 B-frames: two frames, 0.67 s, past the 0.5 s a short excerpt was allowed.
  const footage = join(dir, "bodycam.mp4");
  await tools.run([
    tools.ffmpeg(), "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=3:duration=60",
    "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=60",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-bf", "3", "-c:a", "aac", "-shortest", footage,
  ]);
  const excerpt = join(dir, "bodycam 10-22.mp4");
  await cut(footage, 10, 22, excerpt);
  expect(fs.existsSync(excerpt)).toBe(true);
  // Run on, as FFmpeg cuts it, yet asked of it, it passes; a sound shorter than asked still doesn't.
  expect(await excerptProblem(footage, 10, 22, excerpt)).toBeNull();
  expect(await excerptProblem(footage, 10, 30, excerpt)).toMatch(/not 20\.0 s/);
});
