// What's here to play (`GET /api/projects/{id}/playback/ready`, playback_ready.ts) for the longest real edit, measured
// on the server's one thread (Nov 21: a MacBook Air's log said the thread was held 3.7 s with this route last started,
// a 50-minute project open in the window). The project is shaped like the largest real one (3,173 clips on 28 tracks,
// 389 media, 2 h 6 min: 560 video and 333 audio clips played, 2,048 text clips), its footage streamed, each file's
// index real (a faststart MP4's head with every sample's time and bytes, built here) and some of its blocks here, as
// on a Mac whose footage is still coming down. The page asks every 0.7 s while a play is on or held, every 3 s at
// rest; the footage dialog asks its own every second.

import { afterAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { BLOCK } from "../src/cloud_blocks.ts";
import * as mp4 from "../src/mp4_index.ts";
import { hereOf, missingOf, played, readyStretches } from "../src/playback_ready.ts";
import type { Media, Project } from "../src/model.ts";
import { native, planOffThread, useNative, wrap, type Native } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { scratch } from "./helpers/home.ts";
import { media as mediaOf, project as newProject } from "./helpers/model.ts";

// ---- A faststart MP4's head: ftyp, then a moov whose sample tables say every sample (what mp4_index.ts reads).

const u32 = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, one) => sum + one.length, 0));
  let at = 0;
  for (const one of parts) {
    out.set(one, at);
    at += one.length;
  }
  return out;
};
const box = (type: string, ...parts: Uint8Array[]) => {
  const body = concat(parts);
  return concat([u32(body.length + 8), new TextEncoder().encode(type), body]);
};
const words = (values: ArrayLike<number>) => {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let n = 0; n < values.length; n++) view.setUint32(n * 4, values[n]!);
  return out;
};

interface TrackPlan {
  handler: "vide" | "soun";
  scale: number;
  delta: number;
  sizes: Uint32Array;
  perChunk: number;
  /** Keyframes (decode indices, from 0); null: every sample is one. */
  sync: number[] | null;
}

function trak(plan: TrackPlan, chunkOffsets: number[]): Uint8Array {
  const count = plan.sizes.length;
  const tables = [
    box("stts", u32(0), u32(1), u32(count), u32(plan.delta)),
    ...(plan.sync === null ? [] : [box("stss", u32(0), u32(plan.sync.length), words(plan.sync.map((n) => n + 1)))]),
    box("stsz", u32(0), u32(0), u32(count), words(plan.sizes)),
    box("stsc", u32(0), u32(1), u32(1), u32(plan.perChunk), u32(1)),
    box("stco", u32(0), u32(chunkOffsets.length), words(chunkOffsets)),
  ];
  const mdhd = box("mdhd", u32(0), u32(0), u32(0), u32(plan.scale), u32(count * plan.delta), u32(0));
  const hdlr = box("hdlr", u32(0), u32(0), new TextEncoder().encode(plan.handler), new Uint8Array(13));
  return box("trak", box("mdia", mdhd, hdlr, box("minf", box("stbl", ...tables))));
}

/** A proxy `seconds` long as ours are (picture at 30 fps, a keyframe every half second, AAC sound): its head and size. */
function proxy(seconds: number, picture: boolean): { head: Uint8Array; size: number } {
  const plans: TrackPlan[] = [];
  if (picture) {
    const frames = Math.max(1, Math.round(seconds * 30));
    // About 1.8 Mbit/s: a keyframe 40 KB, the rest 6 KB.
    const sizes = Uint32Array.from({ length: frames }, (_, n) => (n % 15 === 0 ? 40_000 : 6_000));
    plans.push({ handler: "vide", scale: 30, delta: 1, sizes, perChunk: 30, sync: Array.from({ length: Math.ceil(frames / 15) }, (_, n) => n * 15) });
  }
  const aac = Math.max(1, Math.ceil((seconds * 44_100) / 1024));
  plans.push({ handler: "soun", scale: 44_100, delta: 1024, sizes: new Uint32Array(aac).fill(470), perChunk: 43, sync: null });
  const ftyp = box("ftyp", new TextEncoder().encode("isom"), u32(512), new TextEncoder().encode("isomiso2avc1mp41"));
  // Chunks a second each, the tracks interleaved; the moov's size doesn't depend on the offsets, so it's laid out twice.
  const chunkCounts = plans.map((plan) => Math.ceil(plan.sizes.length / plan.perChunk));
  const build = (offsets: number[][]) => box("moov", box("mvhd", u32(0), u32(0), u32(0), u32(1000), u32(Math.round(seconds * 1000)), new Uint8Array(80)), ...plans.map((plan, n) => trak(plan, offsets[n]!)));
  const headSize = ftyp.length + build(chunkCounts.map((count) => new Array<number>(count).fill(0))).length;
  const offsets: number[][] = plans.map(() => []);
  let at = headSize + 8;
  for (let chunk = 0; chunk < Math.max(...chunkCounts); chunk++) {
    plans.forEach((plan, n) => {
      if (chunk >= chunkCounts[n]!) return;
      offsets[n]!.push(at);
      for (let s = chunk * plan.perChunk; s < Math.min(plan.sizes.length, (chunk + 1) * plan.perChunk); s++) at += plan.sizes[s]!;
    });
  }
  return { head: concat([ftyp, build(offsets)]), size: at };
}

// ---- The project: shaped like the largest real edit, with a seeded hand so every run is the same.

let seed = 7;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const between = (a: number, b: number) => a + random() * (b - a);

const FPS = 30;
const stream = (key: string) => `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(key)}`;

interface Long {
  cache: string;
  root: string;
  project: Project;
  /** Each streamed file's folder of blocks and its last block. */
  files: { key: string; folder: string; last: number }[];
}

/** Keeps blocks `indices` of `key` (`size` bytes, its head `head`) under `root`, as cloud_blocks.ts keeps them. */
function keep(root: string, key: string, size: number, head: Uint8Array, indices: number[]) {
  const folder = path.join(root, createHash("sha1").update(key).digest("hex"));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ size, type: "video/mp4", key }));
  // Only the index's bytes are read (block 0); the rest need only be here.
  for (const index of indices) fs.writeFileSync(path.join(folder, `${index}`), index === 0 ? head : "");
  // Block 0 is a whole block, as kept (sparse: its bytes past the index cost no room).
  if (indices.includes(0)) fs.truncateSync(path.join(folder, "0"), Math.min(size, BLOCK));
  return folder;
}

/** The shape of an edit: its footage (how many of each length, seconds), its sounds, its played clips and its length. */
interface Shape {
  videos: [count: number, from: number, to: number][];
  sounds: number;
  clips: { video: number; footageSound: number; music: number; titles: number };
  length: number;
}

/** The largest real edit (3,173 clips on 28 tracks, 389 media, 2 h 6 min): its footage p50 half a minute, at most 30.5. */
const LARGEST: Shape = { videos: [[4, 20 * 60, 30.5 * 60], [26, 60, 8 * 60], [289, 6, 60]], sounds: 55, clips: { video: 560, footageSound: 250, music: 83, titles: 2048 }, length: Math.round((2 * 3600 + 6 * 60) * FPS) };
/** A 40-minute edit like the one open on the MacBook Air (a real one: 1,355 clips, 100 media, 1.6 h of footage, the longest 40 min). */
const FORTY: Shape = { videos: [[2, 30 * 60, 40 * 60], [6, 3 * 60, 8 * 60], [19, 20, 120]], sounds: 40, clips: { video: 300, footageSound: 200, music: 40, titles: 800 }, length: Math.round(40 * 60 * FPS) };

function longProject(name: string, shape: Shape = LARGEST): Long & { cleanup(): void } {
  const home = scratch(name);
  const cache = home.dir;
  const root = path.join(cache, "cloud", "blocks");
  const project = newProject("long", { width: 1920, height: 1080, fps: FPS });
  project.tracks.length = 0;
  for (let n = 0; n < 14; n++) project.tracks.push({ id: `v${n + 1}`, kind: "video", name: `V${n + 1}` } as never);
  for (let n = 0; n < 14; n++) project.tracks.push({ id: `a${n + 1}`, kind: "audio", name: `A${n + 1}` } as never);
  const files: Long["files"] = [];
  const videos: Media[] = [];
  const sounds: Media[] = [];
  const lengths = shape.videos.flatMap(([count, from, to]) => Array.from({ length: count }, () => between(from, to)));
  for (const [n, seconds] of lengths.entries()) {
    const key = `edit/proxies/youtube/long-${name}-${n}.mp4`;
    const one = mediaOf({ id: `m${n}`, name: `m${n}`, path: stream(key), kind: "video", duration: seconds, width: 1280, height: 720, fps: FPS, has_audio: true, cloud: { proxy: key } } as never);
    project.media.push(one);
    videos.push(one);
  }
  // Sounds (music, voice): a few minutes each.
  for (let n = 0; n < shape.sounds; n++) {
    const key = `edit/proxies/youtube/long-${name}-sound-${n}.mp4`;
    const one = mediaOf({ id: `s${n}`, name: `s${n}`, path: stream(key), kind: "audio", duration: between(30, 240), has_audio: true, cloud: { proxy: key } } as never);
    project.media.push(one);
    sounds.push(one);
  }
  // 15 images, here.
  for (let n = 0; n < 15; n++) {
    const file = path.join(cache, "images", `i${n}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "png");
    project.media.push(mediaOf({ id: `i${n}`, name: `i${n}`, path: file, kind: "image", duration: 0 } as never));
  }
  // Each streamed file: its head here and the first part of it (a Mac whose footage is coming down).
  for (const one of [...videos, ...sounds]) {
    const made = proxy(one.duration, one.kind === "video");
    const last = Math.floor((made.size - 1) / BLOCK);
    const here = Array.from({ length: Math.max(1, Math.floor((last + 1) * between(0.2, 0.7))) }, (_, n) => n);
    files.push({ key: one.cloud!.proxy!, folder: keep(root, one.cloud!.proxy!, made.size, made.head, here), last });
  }
  // 560 video clips over the 2 h 6 min (some sharing a stretch on two tracks), 333 audio clips, 2,048 titles.
  let id = 0;
  const lay = (count: number, type: "video" | "audio", from: Media[], tracks: string[]) => {
    for (let n = 0; n < count; n++) {
      const one = from[Math.floor(random() * from.length)]!;
      const duration = Math.max(15, Math.round(between(2, 20) * FPS));
      const start = Math.round((n / count) * (shape.length - duration));
      const sourceIn = Math.max(0, random() * Math.max(0, one.duration - duration / FPS));
      project.clips.push({ type, id: `c${id++}`, track: tracks[n % tracks.length]!, media: one.id, start, duration, source_in: sourceIn, speed: 1 } as never);
    }
  };
  lay(shape.clips.video, "video", videos, project.tracks.filter((track) => track.kind === "video").map((track) => track.id));
  lay(shape.clips.footageSound, "audio", videos, ["a1", "a2", "a3", "a4", "a5", "a6"]);
  lay(shape.clips.music, "audio", sounds, ["a7", "a8", "a9", "a10"]);
  const titles = shape.clips.titles;
  for (let n = 0; n < titles; n++) project.clips.push({ type: "text", id: `t${n}`, track: `v${1 + (n % 4)}`, start: Math.round((n / titles) * (shape.length - 90)), duration: 90, text: "a title" } as never);
  return { cache, root, project, files, cleanup: home.cleanup };
}

/** A block more of `count` files lands (between two of the page's asks, footage coming down). */
function landSome(long: Long, count: number): void {
  for (const file of long.files.slice(0, count)) {
    const next = fs.readdirSync(file.folder).filter((name) => /^\d+$/.test(name)).map(Number).reduce((a, b) => Math.max(a, b), 0) + 1;
    if (next <= file.last) fs.writeFileSync(path.join(file.folder, `${next}`), "");
  }
}

const BEAT_MS = 10;
/** `work` run while the event loop beats every 10 ms: the longest gap between beats and how long it took. */
async function beating(work: () => Promise<unknown>): Promise<{ gap: number; ms: number }> {
  let last = performance.now();
  let gap = 0;
  const beat = () => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  };
  const timer = setInterval(beat, BEAT_MS);
  const started = performance.now();
  await work();
  const ms = performance.now() - started;
  beat();
  clearInterval(timer);
  return { gap, ms };
}

let countsNow = () => "";
const timed = async (what: string, work: () => unknown) => {
  const started = performance.now();
  await work();
  const ms = performance.now() - started;
  console.log(`  ${what}: ${ms.toFixed(1)} ms ${countsNow()}`);
  return ms;
};

const made: (() => void)[] = [];
afterAll(() => made.forEach((cleanup) => cleanup()));

test("what each step of the ready route costs for the longest real edit, its footage streamed (printed: the measure, not a rule)", async () => {
  const long = longProject("ready-steps");
  made.push(long.cleanup);
  const { cache, root, project } = long;
  console.log(`ready route, ${project.clips.length} clips, ${project.media.length} media:`);
  const parse = spyOn(mp4, "parse");
  const scan = spyOn(mp4, "secondsHere");
  const counts = () => { const out = `(${parse.mock.calls.length} indexes read, ${scan.mock.calls.length} scanned)`; parse.mockClear(); scan.mockClear(); return out; };
  countsNow = counts;
  await timed("played clips", () => played(project));
  await timed("every file's seconds here, first ask (indexes read)", async () => {
    for (const one of project.media) await hereOf(cache, root, one);
  });
  await timed("every file's seconds here, asked again (nothing new)", async () => {
    for (const one of project.media) await hereOf(cache, root, one);
  });
  landSome(long, 100);
  await timed("every file's seconds here, a block more of 100 files", async () => {
    for (const one of project.media) await hereOf(cache, root, one);
  });
  await timed("missing stretches (missingOf)", () => missingOf(cache, project, root));
  await timed("ready stretches (the route's answer), nothing new", () => readyStretches(cache, project, root));
  landSome(long, 374);
  await timed("ready stretches, a block more of every file", () => readyStretches(cache, project, root));
  const ready = await readyStretches(cache, project, root);
  await timed("the answer as JSON", () => JSON.stringify({ ready, keeping: true }));
  parse.mockRestore();
  scan.mockRestore();
  countsNow = () => "";
  expect(ready.length).toBeGreaterThan(0);
});

test("an ask with no new blocks reads no file's index again and scans none: the same blocks are the same seconds (Nov 21: every ask of the longest real edit read and scanned all 374, 350 ms and 750 MB a time)", async () => {
  const long = longProject("ready-again");
  made.push(long.cleanup);
  const { cache, root, project } = long;
  const parse = spyOn(mp4, "parse");
  const scan = spyOn(mp4, "secondsHere");
  try {
    const first = await readyStretches(cache, project, root);
    expect(parse.mock.calls.length).toBeGreaterThan(300);
    parse.mockClear();
    scan.mockClear();
    const cpu = process.cpuUsage();
    const again = await readyStretches(cache, project, root);
    const used = process.cpuUsage(cpu);
    const ms = (used.user + used.system) / 1000;
    console.log(`an ask with nothing new: ${parse.mock.calls.length} indexes read, ${scan.mock.calls.length} files scanned, ${ms.toFixed(0)} ms of processor`);
    expect(again).toEqual(first);
    expect(parse.mock.calls.length).toBe(0);
    expect(scan.mock.calls.length).toBe(0);
    // 10 ms here now, 400 ms before; the bar has room for a Mac four times slower and not for the old way.
    expect(ms).toBeLessThan(100);
    // A block more of ten files: those ten are looked at again, and the answer moves with them.
    landSome(long, 10);
    const moved = await readyStretches(cache, project, root);
    expect(scan.mock.calls.length).toBeLessThanOrEqual(10);
    expect(moved).not.toEqual(first);
  } finally {
    parse.mockRestore();
    scan.mockRestore();
  }
});

// The bar: 200 ms, well under a page's patience. A guard, not the finding: before Nov 21 the longest edit's ask also
// gave a turn between files (each index read was a real wait) and the 40-minute one took 7 ms at most, on mandalorian;
// what changed is the work (the test above), 350 ms of processor an ask down to 10.
const GAP_MS = 200;

for (const [name, shape] of [["the longest real edit", LARGEST], ["a 40-minute edit", FORTY]] as const) {
  test(`asking what's here of ${name}, as the page does while footage comes down, leaves the rest of Edit its turns`, async () => {
    const long = longProject(`ready-gap-${shape.length}`, shape);
    made.push(long.cleanup);
    const { cache, root, project } = long;
    const ask = async () => {
      const cpu = process.cpuUsage();
      const out = await beating(() => readyStretches(cache, project, root));
      const used = process.cpuUsage(cpu);
      return { ...out, cpu: (used.user + used.system) / 1000 };
    };
    // The first ask (each file's index read), then asks as a play's page makes them, a block more of every file between.
    const first = await ask();
    const asks: { gap: number; ms: number; cpu: number }[] = [];
    for (let n = 0; n < 3; n++) {
      landSome(long, long.files.length);
      asks.push(await ask());
    }
    const again = [await ask(), await ask()];
    const said = (one: { gap: number; ms: number; cpu: number }) => `${one.ms.toFixed(0)} ms, ${one.cpu.toFixed(0)} ms of processor (longest gap ${one.gap.toFixed(0)})`;
    console.log(`ready route for ${name} (${project.clips.length} clips, ${project.media.length} media) beside a ${BEAT_MS} ms beat: first ask ${said(first)}; a block more of every file: ${asks.map(said).join("; ")}; nothing new: ${again.map(said).join("; ")}`);
    for (const one of [first, ...asks, ...again]) expect(one.gap).toBeLessThan(GAP_MS);
  });
}

test("a plan is made off the server's thread: on the addon's pool where it can, else after the encoders are listed off it (an addon built before Nov 21)", async () => {
  const before = useNative(null);
  try {
    const said: string[] = [];
    const plan = { plan: { start: 0, end: 30 } as never, fps: 30 };
    const old = { ...createStub(), exportPlan: () => (said.push("plan here"), plan), encoders: async () => (said.push("encoders listed"), {} as never) } as Native;
    useNative(wrap(old));
    expect(await planOffThread({ json: "{}" }, native().exportDefaults())).toEqual(plan);
    expect(said).toEqual(["encoders listed", "plan here"]);
    said.length = 0;
    useNative(wrap({ ...old, exportPlanAsync: async () => (said.push("planned on the pool"), plan) } as Native));
    expect(await planOffThread({ json: "{}" }, native().exportDefaults())).toEqual(plan);
    expect(said).toEqual(["planned on the pool"]);
  } finally {
    useNative(before);
  }
});
