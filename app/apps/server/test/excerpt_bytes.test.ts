// Nov 21, the bad-day run's no-room case (Linux and a Mac): cutting a cloud original's excerpts over the network
// fetched 98 to 109 MB for 20 MB of excerpts. FFmpeg reads open-ended ranges and drops each when it seeks, and every
// byte the line had already handed over by then was paid for and thrown away (the length probe's and each cut's reads
// of the file's start, two to three megabytes a drop on loopback, and about four past each excerpt's end); and three
// cuts ran at once over the line. Here: a stand-in for the cloud serving a real MP4 (eight minutes, its index at its
// end, a keyframe every 4 s and B-frames, as an Axon file), counting what it hands over as the bad-day line does, and
// the real length probe, keyframe and cut.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";

import * as fs from "node:fs";
import * as http from "node:http";

import * as cloud from "../src/cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import * as keyframes from "../src/keyframe_index.ts";
import type { Probe } from "../src/model.ts";
import { useNative, wrap } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
let made: { dir: string; cleanup(): void };
let file = "";
let size = 0;
let moov = 0;
const SECONDS = 480;

beforeAll(async () => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
  made = scratch("excerpt-bytes-footage");
  file = `${made.dir}/Axon_Body_4_Video_2024-01-11_2341_X6031.mp4`;
  // Noise over the pattern so the encoder spends its bitrate; the index at the end (no faststart), as Axon's.
  await tools.run([
    tools.ffmpeg(), "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=25:duration=${SECONDS},noise=alls=20:allf=t`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "400k", "-maxrate", "400k", "-bufsize", "800k",
    "-g", "100", "-keyint_min", "100", "-sc_threshold", "0", "-bf", "2",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-threads", "4", file,
  ]);
  size = fs.statSync(file).size;
  moov = moovBytes(file);
}, 120_000);

afterAll(() => {
  restore();
  mock.stop();
  made.cleanup();
});

/** The size of the file's index (moov), as the bad-day run reads it. */
function moovBytes(path: string): number {
  const bytes = fs.readFileSync(path);
  let at = 0;
  while (at + 8 <= bytes.length) {
    let length = bytes.readUInt32BE(at);
    if (length === 1) length = Number(bytes.readBigUInt64BE(at + 8));
    if (bytes.toString("latin1", at + 4, at + 8) === "moov") return length;
    if (length <= 0) break;
    at += length;
  }
  return 0;
}

/**
 * The cloud's stand-in: Range answered as R2 does, each answer read from the file 64 kB at a time as the socket takes
 * it, so what's counted is what was handed to the reader (the kernel's buffers included), as the bad-day line counts.
 */
async function standIn(path: string, cutOnce: { from: number; to: number; after: number } | null = null): Promise<{ url: (name: string) => string; sent: () => number; requests: { range: string; sent: number }[]; stop(): void }> {
  let sent = 0;
  const requests: { range: string; sent: number }[] = [];
  const total = fs.statSync(path).size;
  const server = http.createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const from = range === null ? 0 : Number(range[1]);
    const to = range === null || range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1);
    const one = { range: request.headers.range ?? "whole", sent: 0 };
    requests.push(one);
    if (from >= total) {
      response.writeHead(416, { "content-range": `bytes */${total}` });
      response.end();
      return;
    }
    response.writeHead(range === null ? 200 : 206, {
      "content-type": "video/mp4",
      "content-length": String(to - from + 1),
      "accept-ranges": "bytes",
      ...(range === null ? {} : { "content-range": `bytes ${from}-${to}/${total}` }),
    });
    const stream = fs.createReadStream(path, { start: from, end: to, highWaterMark: 64 * 1024 });
    // The line dropped once mid-read: the connection reset after so many bytes.
    const drop = cutOnce !== null && from >= cutOnce.from && from < cutOnce.to ? cutOnce.after : Number.POSITIVE_INFINITY;
    if (drop !== Number.POSITIVE_INFINITY) cutOnce = null;
    stream.on("data", (chunk) => {
      sent += chunk.length;
      one.sent += chunk.length;
      if (one.sent >= drop) {
        stream.destroy();
        response.destroy();
      }
    });
    stream.pipe(response);
    response.on("close", () => stream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: (name) => `http://127.0.0.1:${port}/r2/${name}?X-Amz-Signature=stand-in`,
    sent: () => sent,
    requests,
    stop: () => void server.close(),
  };
}

/** A fixture whose addon probes every excerpt as a video and "makes" its proxy by copying it. */
function home(name: string) {
  const fixture = fixtureHome(name);
  const raw = createStub();
  raw.init({ home: fixture.home, cacheDir: `${fixture.home}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", log: () => {} });
  raw.probe = async (): Promise<Probe> => ({ kind: "video", duration: 30, width: 320, height: 180, fps: 25, has_audio: true });
  raw.makeCloudProxy = async (source: string, _probe: Probe, out: string) => void fs.copyFileSync(source, out);
  useNative(wrap(raw));
  cloudMedia.configurePlayback(fixture.app);
  return fixture;
}

/** Cuts `ranges` of the stand-in's file through the real path; what was fetched, what the excerpts need, and the most cuts at once. */
async function cutFromCloud(id: string, ranges: [number, number][], input: string | null = null, cutOnce: { from: number; to: number; after: number } | null = null) {
  const fixture = home(`excerpt-bytes-${id}`);
  const cloudFile = await standIn(file, cutOnce);
  const key = `edit/originals/drive/${id}/Axon_Body_4_Video_2024-01-11_2341_X6031.mp4`;
  const realPresign = cloud.presign;
  const presign = spyOn(cloud, "presign").mockImplementation((asked, method, ...rest) =>
    asked === key && method === "GET" ? Promise.resolve(cloudFile.url(asked)) : realPresign(asked, method, ...rest),
  );
  let now = 0;
  let most = 0;
  const realCut = cloudMedia.scriptParts.cut;
  const cut = spyOn(cloudMedia.scriptParts, "cut").mockImplementation(async (source, start, to, out) => {
    most = Math.max(most, ++now);
    try {
      // Long enough that cuts started together are seen together.
      await Bun.sleep(150);
      return await realCut(source, start, to, out);
    } finally {
      now--;
    }
  });
  keyframes.forget();
  try {
    const original = { file: id, source: `drive:${id}`, key, name: "Axon_Body_4_Video_2024-01-11_2341_X6031.mp4", size };
    const excerpts = await cloudMedia.driveExcerpts(fixture.store.cacheDir(), original, ranges, input);
    // What the cuts need: each excerpt's share of the file (from its keyframe to its end), and one read of the index.
    const needed = excerpts.reduce((sum, one) => sum + ((one.to - one.from) / SECONDS) * size, 0) + moov;
    // Each excerpt that went up is whole: FFmpeg read all it needed through answers that end short.
    const lengths: number[] = [];
    for (const one of excerpts) {
      const copy = `${fixture.dir}/up-${lengths.length}.mp4`;
      fs.writeFileSync(copy, mock.cloud.objects.get(one.cloud!.cloud!.original)!);
      const said = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", copy]));
      lengths.push(Math.round(Number(said.trim()) * 10) / 10);
    }
    return { excerpts, sent: cloudFile.sent(), needed, most, requests: cloudFile.requests, lengths };
  } finally {
    cut.mockRestore();
    presign.mockRestore();
    cloudFile.stop();
    keyframes.forget();
    fixture.cleanup();
  }
}

const report = (what: string, run: { sent: number; needed: number; requests: { range: string; sent: number }[] }) =>
  console.log(
    `${what}: ${(run.sent / 1e6).toFixed(2)} MB fetched for ${(run.needed / 1e6).toFixed(2)} MB needed (${(run.sent / run.needed).toFixed(2)}×) in ${run.requests.length} requests: ` +
      run.requests.map((one) => `${one.range} ${(one.sent / 1e6).toFixed(2)} MB`).join(", "),
  );

test("excerpts cut over the network fetch at most 1.3 times what they need, one cut at a time: at the start, middle and end of a long file", async () => {
  const run = await cutFromCloud("BytesFileMany1", [[5, 15], [230, 240], [450, 460]]);
  report("three excerpts", run);
  expect(run.excerpts.map((one) => [one.from, one.to])).toEqual([[0, 25], [220, 250], [440, 470]]);
  for (const [index, one] of run.excerpts.entries()) expect(Math.abs(run.lengths[index]! - (one.to - one.from))).toBeLessThanOrEqual(0.2);
  expect(run.most).toBe(1);
  expect(run.sent).toBeLessThanOrEqual(run.needed * 1.3);
}, 120_000);

test("one excerpt cut over the network fetches at most 1.3 times what it needs", async () => {
  const run = await cutFromCloud("BytesFileOne1", [[230, 240]]);
  report("one excerpt", run);
  expect(run.excerpts.map((one) => [one.from, one.to])).toEqual([[220, 250]]);
  expect(Math.abs(run.lengths[0]! - 30)).toBeLessThanOrEqual(0.2);
  expect(run.sent).toBeLessThanOrEqual(run.needed * 1.3);
}, 120_000);

test("excerpts of a file on this Mac are cut from it, three at once, and nothing comes from the cloud", async () => {
  const copy = `${made.dir}/here.mp4`;
  fs.copyFileSync(file, copy);
  const run = await cutFromCloud("BytesFileHere1", [[5, 15], [230, 240], [450, 460]], copy);
  expect(run.excerpts).toHaveLength(3);
  expect(run.sent).toBe(0);
  expect(run.most).toBe(3);
}, 120_000);

test("a connection dropped mid-cut is read on from where it stopped, through the reader as from the cloud's own address", async () => {
  // Past the file's start and its index: the excerpt's own stretch (12.5 MB in), cut 600 kB into it.
  const run = await cutFromCloud("BytesFileDrop1", [[230, 240]], null, { from: 10_000_000, to: 20_000_000, after: 600_000 });
  report("one excerpt, its connection dropped", run);
  expect(run.excerpts.map((one) => [one.from, one.to])).toEqual([[220, 250]]);
  expect(Math.abs(run.lengths[0]! - 30)).toBeLessThanOrEqual(0.2);
  expect(run.sent).toBeLessThanOrEqual(run.needed * 1.3);
}, 120_000);
