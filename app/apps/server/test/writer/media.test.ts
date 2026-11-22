import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join as joinPath } from "node:path";

import { ffmpeg, ffprobe } from "../../src/tools.ts";
import * as encoder from "../../src/encoder.ts";
import { append, encodeProxy, input, inputsOf, join, overview, PACE, peaks, streams } from "../../src/writer/media.ts";

function make(args: string[], out: string) {
  const done = Bun.spawnSync([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
}

test("joins mixed recordings, appends by copying, and reads the sound's peaks", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "writer-join-"));
  try {
    const [a, b, c] = [joinPath(dir, "a.mp4"), joinPath(dir, "b.mp3"), joinPath(dir, "c.mov")];
    make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=3", "-f", "lavfi", "-i", "sine=d=3", "-shortest"], a);
    make(["-f", "lavfi", "-i", "sine=f=330:d=2"], b);
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2"], c);
    const parts = await Promise.all([a, b, c].map(async (path) => ({ path, streams: await streams(path) })));
    const out = joinPath(dir, "joined.mp4");
    await join(parts, out);
    const found = await streams(out);
    expect(found.video && found.audio).toBe(true);
    expect(found.durationMs).toBeGreaterThanOrEqual(6_900);
    expect(found.durationMs).toBeLessThanOrEqual(7_200);
    // A second piece encoded the same way is copied on.
    const more = joinPath(dir, "more.mp4");
    await join([parts[2]!], more);
    const longer = joinPath(dir, "longer.mp4");
    await append(more, [more], longer);
    expect((await streams(longer)).durationMs).toBeGreaterThanOrEqual(3_800);
    const sound = await peaks(out);
    expect(sound.length).toBeGreaterThan(300);
    expect(Math.max(...sound.slice(0, 100))).toBeGreaterThan(0.05);
    expect(overview(sound, 10)).toHaveLength(10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// Oct 30, 591): Axon bodycam recordings are full range (yuvj420p); their
// pieces kept that flag, never matched the rest, and the join encoded all 10
// hours again with libx264. Every piece is TV range now, so they copy.
test("a full-range recording's piece matches the others and joins by copying", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "writer-range-"));
  try {
    const [full, normal] = [joinPath(dir, "full.mp4"), joinPath(dir, "normal.mp4")];
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuvj420p", "-color_range", "pc"], full);
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p"], normal);
    const pieces = [joinPath(dir, "a.mp4"), joinPath(dir, "b.mp4")];
    for (const [index, source] of [full, normal].entries()) await join([{ path: source, streams: await streams(source) }], pieces[index]!);
    const formats = pieces.map((piece) => Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", piece]).stdout.toString().trim());
    expect(formats).toEqual(["yuv420p", "yuv420p"]);
    const joined = joinPath(dir, "joined.mp4");
    expect(await append(pieces[0]!, [pieces[1]!], joined)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// Nov 5, JJ's redacted bodycam: its sound stored apart from its picture, read once from R2, sent FFmpeg back and forth across the file, a request each time; it never finished.
test("footage in the cloud is read twice, the picture from one and the sound from the other", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "writer-cloud-"));
  const file = joinPath(dir, "a.mp4");
  make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=3", "-f", "lavfi", "-i", "sine=d=3", "-shortest"], file);
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => (requests++, new Response(Bun.file(file))) });
  try {
    const url = `http://127.0.0.1:${server.port}/a.mp4`;
    const both = { video: true, audio: true, durationMs: 3_000 };
    const cloud = inputsOf({ path: url, streams: both }, 4);
    expect([cloud.video, cloud.audio, cloud.count]).toEqual(["4:v", "5:a", 2]);
    expect(cloud.args.filter((arg) => arg === url)).toHaveLength(2);
    expect(inputsOf({ path: file, streams: both }, 4)).toMatchObject({ video: "4:v", audio: "4:a", count: 1 });
    expect(inputsOf({ path: url, streams: { ...both, audio: false } }, 0).count).toBe(1);
    // Both ways of joining: a piece alone (the hardware first) and several together.
    const part = { path: url, streams: await streams(url) };
    for (const parts of [[part], [part, part]]) {
      const out = joinPath(dir, `out-${parts.length}.mp4`);
      await join(parts, out);
      const found = await streams(out);
      expect(found.video && found.audio).toBe(true);
      expect(Math.abs(found.durationMs - 3_000 * parts.length)).toBeLessThan(300);
    }
    expect(requests).toBeGreaterThan(0);
  } finally {
    await server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

/** A file served as R2 serves one: any range asked for, each request counted. */
function ranges(file: string) {
  const bytes = fs.readFileSync(file);
  const served = { requests: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      served.requests++;
      const at = Number(/bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1] ?? -1);
      if (at < 0) return new Response(bytes, { headers: { "accept-ranges": "bytes", "content-type": "video/x-msvideo" } });
      return new Response(bytes.subarray(at), { status: 206, headers: { "accept-ranges": "bytes", "content-range": `bytes ${at}-${bytes.length - 1}/${bytes.length}`, "content-type": "video/x-msvideo" } });
    },
  });
  return { server, served };
}

// Nov 18, nightly-86: three of a case's CCTV recordings (HEVC and A-law sound in AVI, from a DVR) were dropped
// from JJ's Drive import as "Couldn't be read as video or audio". FFmpeg reads an AVI by its index and calls one
// whose sound is filed seconds from its picture non-interleaved, jumping back and forth for every packet: from R2
// a request a jump, 86 for ffprobe's look (29 s from mandalorian), past streams()'s minute on JJ's busy line.
test("an AVI in the cloud whose sound is filed apart from its picture is read in one request, and its piece made from it", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "writer-avi-"));
  const file = joinPath(dir, "CH03-2022-03-12-08-57-59_09-35-17.avi");
  // A DVR's: the sound 3 s behind the picture in the file, in 40 ms chunks, an index (idx1) at the end.
  const plain = joinPath(dir, "plain.avi");
  make(["-f", "lavfi", "-i", "testsrc=s=640x360:r=15:d=20", "-f", "lavfi", "-i", "sine=f=440:r=8000:d=20", "-c:v", "mpeg4", "-c:a", "pcm_alaw", "-ac", "1"], plain);
  make(["-i", plain, "-itsoffset", "3", "-i", plain, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "asetnsamples=n=320", "-c:a", "pcm_alaw"], file);
  const { server, served } = ranges(file);
  try {
    const url = `http://127.0.0.1:${server.port}/edit/originals/drive/x/CH03-2022-03-12-08-57-59_09-35-17.avi?X-Amz-Signature=abc`;
    // Read by its index, FFmpeg calls it non-interleaved (and jumps about it: from R2, a request a jump).
    expect(Bun.spawnSync([ffprobe(), "-v", "info", "-hide_banner", file]).stderr.toString()).toContain("non-interleaved AVI");
    const found = await streams(url);
    expect(found).toMatchObject({ video: true, audio: true });
    expect(Math.abs(found.durationMs - 20_000)).toBeLessThan(200);
    expect(served.requests).toBe(1);
    // Its piece from the link: each opening one read straight through.
    served.requests = 0;
    const out = joinPath(dir, "piece.mp4");
    await join([{ path: url, streams: found }], out);
    expect(served.requests).toBe(2);
    const piece = await streams(out);
    expect(piece.video && piece.audio).toBe(true);
    expect(Math.abs(piece.durationMs - 20_000)).toBeLessThan(300);
    // A-law's sound comes through, heard from the piece.
    expect(Math.max(...(await peaks(out)).slice(10, 100))).toBeGreaterThan(0.05);
    // Only an AVI from a link reads in order; a seek (a stretch) needs its index, and another link or a file here is as before.
    expect(input(url)).toContain("-seekable");
    expect(input(url, true)).not.toContain("-seekable");
    expect(input(url.replace(".avi", ".mp4"))).not.toContain("-seekable");
    expect(input(file)).toEqual([]);
    expect(inputsOf({ path: url, streams: found }, 0, [], 320_000).args).not.toContain("-seekable");
  } finally {
    await server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

/**
 * A recording in the cloud whose read stalled: the server takes the connection and never answers, so
 * FFmpeg waits on it forever. (A pipe nobody writes to stalls it too, but FFmpeg blocked opening one ignores the
 * stop's SIGTERM, so each try then waited out the 5 s to its SIGKILL: 10 of this file's 28 s.)
 */
function stalled() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  return { never: `http://127.0.0.1:${server.port}/never.mp4`, server };
}

test("an encode that makes no progress is stopped by its pace, not left to run out its hour", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "edit-pace-"));
  const { never, server } = stalled();
  const was = { ...PACE };
  Object.assign(PACE, { afterMs: 400, everyMs: 100 });
  const began = Date.now();
  try {
    const failed = await encodeProxy(never, joinPath(dir, "out.mp4"), 3_600_000).then(() => null, (error: unknown) => error as Error);
    expect(failed?.message).toMatch(/made no progress/);
    // Both tries (the video hardware, then libx264), each judged within a second or so.
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(fs.existsSync(joinPath(dir, "out.mp4"))).toBe(false);
  } finally {
    Object.assign(PACE, was);
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a script's preview piece takes its turn after a share's review copy, and a cancel ends its wait (Nov 22)", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "edit-piece-turn-"));
  const { never, server } = stalled();
  const was = { ...PACE, poll: encoder.hooks.pollMs };
  Object.assign(PACE, { afterMs: 400, everyMs: 100 });
  encoder.hooks.pollMs = 20;
  const copy = encoder.hold("a share's review copy", "share");
  try {
    const stop = new AbortController();
    const cancelled = encodeProxy(never, joinPath(dir, "a.mp4"), 3_600_000, () => {}, stop.signal).then(() => null, (error: unknown) => error as Error);
    const encode = encodeProxy(never, joinPath(dir, "out.mp4"), 3_600_000).then(() => null, (error: unknown) => error as Error);
    await Bun.sleep(150);
    // Waiting, not encoding beside the copy.
    expect(encoder.holding("background")).toEqual([]);
    stop.abort(new Error("cancelled"));
    expect((await cancelled)?.message).toBe("cancelled");
    copy.release();
    for (let tries = 0; encoder.holding("background").length === 0 && tries < 100; tries++) await Bun.sleep(10);
    expect(encoder.holding("background")).toEqual(["a script's preview piece"]);
    expect((await encode)?.message).toMatch(/made no progress/);
  } finally {
    copy.release();
    encoder.hooks.pollMs = was.poll;
    Object.assign(PACE, { afterMs: was.afterMs, everyMs: was.everyMs });
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("an encode sharing the hardware encoder with an export isn't judged by its pace until the export ends", async () => {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "edit-pace-shared-"));
  const { never, server } = stalled();
  const was = { ...PACE };
  Object.assign(PACE, { afterMs: 400, everyMs: 100 });
  let exporting = true;
  const undo = encoder.register(() => (exporting ? "an export" : null));
  try {
    const encode = encodeProxy(never, joinPath(dir, "out.mp4"), 3_600_000).then(() => null, (error: unknown) => error as Error);
    // Well past its judging time: an export holds the encoder, so it isn't stopped as slow.
    const early = await Promise.race([encode, Bun.sleep(1500).then(() => "still going" as const)]);
    expect(early).toBe("still going");
    // The export ends: from then on its pace counts, and it's stopped as one that made no progress.
    exporting = false;
    const failed = await encode;
    expect(failed?.message).toMatch(/made no progress/);
  } finally {
    undo();
    Object.assign(PACE, was);
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
