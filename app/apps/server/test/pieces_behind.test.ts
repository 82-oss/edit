// A short import's pieces made behind its answer (cloud_media.ts `piecesBehind`) when one can't be made.
//
// Nov 21 (audit I8.a): the row was said to have got further after every fill, made or not, which forgave its waits,
// so a piece that kept failing was tried again a minute later, every minute for good, with nothing on screen.

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import * as cloud from "../src/cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import * as jobs from "../src/jobs.ts";
import * as pieces from "../src/proxy_pieces.ts";

const fill = cloudMedia.fillHooks.fill;
afterEach(() => {
  cloudMedia.fillHooks.fill = fill;
});

/** A data folder with a pieced proxy's layout for `source` here (two one-minute pieces, none made). */
function withLayout(source: string): { home: string; cache: string } {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-pieces-behind-"));
  const cache = join(home, "cache");
  const base = pieces.baseKey(source);
  const file = cloudMedia.localPath(cache, pieces.layoutKeyOf(base));
  fs.mkdirSync(join(file, ".."), { recursive: true });
  const layout: pieces.Layout = {
    v: 1, source, original: `edit/originals/${source}`, duration: 120, fps: 30, frames: 3600, perPiece: 1800, pieces: 2,
    width: 320, height: 180, bitrate: 1_000_000, slot: 1 << 20, audio: null, head: 4096, total: 4096 + 2 * (1 << 20),
  };
  fs.writeFileSync(file, JSON.stringify(layout));
  return { home, cache };
}

const minutesOff = (row: jobs.Job | undefined) => Math.round(((row?.retry_at ?? 0) - Date.now()) / 60_000);

test("a piece that can't be made waits longer each time it's tried (1, then 5, then 15 minutes), not a minute for good", async () => {
  const source = "hash:pieces-behind-never-made";
  const { home, cache } = withLayout(source);
  try {
    // The fill makes nothing (it logs each piece's failure and goes on, as playback's own filling needs it to).
    let fills = 0;
    cloudMedia.fillHooks.fill = async () => (fills++, 0);
    const key = jobs.keyOf("upload", "-", `${source}#pieces`);
    const waits: number[] = [];
    for (let n = 0; n < 3; n++) {
      // Each try as the table starts it when its wait is over (`resumeUpload` → `piecesBehind`).
      await cloudMedia.piecesBehind(home, cache, source);
      const row = jobs.get(home, key);
      expect(row?.state).toBe("waiting");
      waits.push(minutesOff(row));
    }
    expect(fills).toBe(6);
    expect(waits).toEqual([1, 5, 15]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a try that made a piece is getting further: its wait starts again from a minute", async () => {
  const source = "hash:pieces-behind-one-made";
  const { home, cache } = withLayout(source);
  try {
    const key = jobs.keyOf("upload", "-", `${source}#pieces`);
    cloudMedia.fillHooks.fill = async () => 0;
    await cloudMedia.piecesBehind(home, cache, source);
    await cloudMedia.piecesBehind(home, cache, source);
    expect(minutesOff(jobs.get(home, key))).toBe(5);
    // This try makes the first piece (its picture written as a fill would); the second still fails.
    const base = pieces.baseKey(source);
    cloudMedia.fillHooks.fill = async (_context, wants) => {
      const layout = JSON.parse(fs.readFileSync(cloudMedia.localPath(cache, pieces.layoutKeyOf(base)), "utf8")) as pieces.Layout;
      const n = Math.floor((wants[0]!.seconds * layout.fps) / layout.perPiece);
      if (n !== 0) return 0;
      const piece = cloudMedia.localPath(cache, `${base}/video/0.m4s`);
      fs.mkdirSync(join(piece, ".."), { recursive: true });
      fs.writeFileSync(piece, "made");
      return 1;
    };
    await cloudMedia.piecesBehind(home, cache, source);
    expect(minutesOff(jobs.get(home, key))).toBe(1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Nov 21 audit: a piece already made whose upload kept failing waited only a minute each time, the piece before it
// (up already) counted as getting further at every try.
test("a piece made whose upload keeps failing waits longer each time, the pieces up already not counting as further", async () => {
  const source = "hash:pieces-behind-up-fails";
  const { home, cache } = withLayout(source);
  const base = pieces.baseKey(source);
  for (const n of [0, 1]) {
    const piece = cloudMedia.localPath(cache, `${base}/video/${n}.m4s`);
    fs.mkdirSync(join(piece, ".."), { recursive: true });
    fs.writeFileSync(piece, "made");
  }
  const up = new Set<string>();
  const head = spyOn(cloud, "head").mockImplementation(async (key: string) => (up.has(key) ? ({ size: 4 } as never) : null));
  const sending = spyOn(cloud, "uploadFile").mockImplementation(async (_path: string, key: string) => {
    if (key.endsWith("/1.m4s")) throw new Error("The socket connection was closed unexpectedly");
    up.add(key);
  });
  try {
    cloudMedia.fillHooks.fill = async () => 0;
    const key = jobs.keyOf("upload", "-", `${source}#pieces`);
    const waits: number[] = [];
    for (let n = 0; n < 3; n++) {
      await cloudMedia.piecesBehind(home, cache, source);
      waits.push(minutesOff(jobs.get(home, key)));
    }
    expect(waits).toEqual([1, 5, 15]);
  } finally {
    head.mockRestore();
    sending.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Nov 21 (audit I14.e): an upload's row was noted only at its first reports, so an hour's upload was listed as
// "running, nothing noted for N min" in the log and in each Mac's report, which misled anyone reading it from afar.
test("an upload's row is noted as it goes, every report, not only at its first", async () => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "edit-upload-beats-"));
  const beatEvery = jobs.BEAT_MS.value;
  jobs.BEAT_MS.value = 0;
  const file = join(home, "footage.mp4");
  fs.writeFileSync(file, "footage");
  let goOn: () => void = () => {};
  const key = jobs.keyOf("upload", "-", "hash:upload-beats");
  let late = 0;
  const halfway = Promise.withResolvers<void>();
  const head = spyOn(cloud, "head").mockResolvedValue(null);
  const sending = spyOn(cloud, "uploadFile").mockImplementation(async (_path, _key, report = () => {}) => {
    // What's up already, then a part, as a resumed upload reports; then it goes on for a long while.
    report(0, 40);
    report(10, 40);
    halfway.resolve();
    await new Promise<void>((resolve) => (goOn = resolve));
    report(20, 40);
    report(30, 40);
    late = jobs.get(home, key)?.updated_ms ?? 0;
  });
  const record = spyOn(cloud, "mutation").mockResolvedValue(null as never);
  try {
    const upload: cloudMedia.Upload = { file, source: "hash:upload-beats", size: 40, duration: 1, originalKey: "edit/originals/hash/upload-beats", uploadOriginal: true, proxy: null, local: null };
    cloudMedia.uploadLater(home, upload);
    await halfway.promise;
    const early = jobs.get(home, key)!.updated_ms;
    await Bun.sleep(50);
    goOn();
    // Its later reports note the row again (before: its time stayed at the second report's).
    await cloudMedia.uploaded(file);
    expect(sending).toHaveBeenCalled();
    expect(late - early).toBeGreaterThanOrEqual(40);
  } finally {
    head.mockRestore();
    sending.mockRestore();
    record.mockRestore();
    jobs.BEAT_MS.value = beatEvery;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
