import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { App } from "../src/app.ts";
import { BLOCK } from "../src/cloud_blocks.ts";
import { localPath } from "../src/cloud_media.ts";
import * as footageReady from "../src/footage_ready.ts";
import * as localPreviews from "../src/local_previews.ts";
import * as playing from "../src/playing.ts";
import { THIS_MACHINE } from "../src/machine.ts";
import type { Project } from "../src/model.ts";
import * as storage from "../src/storage.ts";
import { scratch } from "./helpers/home.ts";
import { media, project as newProject } from "./helpers/model.ts";

const { headFor, readiness, RULE, smooth } = footageReady;
const MB = 1_000_000;

const realFree = storage.diskHooks.free;
const realRoot = footageReady.hooks.root;
const realNow = footageReady.hooks.now;
const realReceived = footageReady.hooks.received;
const realPrepare = footageReady.hooks.prepare;
const realFetch = localPreviews.hooks.fetch;
let token: string | undefined;
beforeEach(() => {
  token = process.env.EDIT_RELAY_TOKEN;
  process.env.EDIT_RELAY_TOKEN = "cloud-token";
  storage.diskHooks.free = () => 500 * 1e9;
});
afterEach(() => {
  if (token === undefined) delete process.env.EDIT_RELAY_TOKEN;
  else process.env.EDIT_RELAY_TOKEN = token;
  storage.diskHooks.free = realFree;
  storage.resetRoom();
  footageReady.hooks.root = realRoot;
  footageReady.hooks.now = realNow;
  footageReady.hooks.received = realReceived;
  footageReady.hooks.prepare = realPrepare;
  playing.reset();
  localPreviews.hooks.fetch = realFetch;
  localPreviews.reset();
  footageReady.reset();
});

test("a play from the start is smooth when every stretch not here can come before it plays, read no further ahead than a play reads, at a share of the speed", () => {
  // Nothing missing: smooth whatever the speed.
  expect(smooth([], null)).toBe(true);
  // Something missing and no speed measured: not yet.
  expect(smooth([{ at_s: 30, bytes: MB, fresh: true }], null)).toBe(false);
  // The very start missing: 10 MB at 100 MB/s (60 of it a play's) is 0.17 s and a round trip, inside a start's grace.
  expect(smooth([{ at_s: 0, bytes: 10 * MB, fresh: true }], 100 * MB)).toBe(true);
  // At 10 MB/s it's 1.67 s and the round trip: past the grace.
  expect(smooth([{ at_s: 0, bytes: 10 * MB, fresh: true }], 10 * MB)).toBe(false);
  // Later stretches are read only `lead_s` ahead of their moment: 45 MB at 5 minutes on a 4 MB/s link takes 18.75 s, past
  // the 15 s it may start ahead and the grace, however long the play before it.
  expect(smooth([{ at_s: 300, bytes: 45 * MB, fresh: false }], 4 * MB)).toBe(false);
  expect(smooth([{ at_s: 300, bytes: 30 * MB, fresh: false }], 4 * MB)).toBe(true);
  // One late read holds up the next: each starts once the one before it is in.
  const tight = (RULE.lead_s + RULE.grace_s) * 0.6 * 4 * MB * 0.9;
  expect(smooth([{ at_s: 300, bytes: tight, fresh: false }], 4 * MB)).toBe(true);
  expect(smooth([{ at_s: 300, bytes: tight, fresh: false }, { at_s: 301, bytes: tight, fresh: false }], 4 * MB)).toBe(false);
});

test("the first step is the shortest start, in whole minutes, after which a play from the start is smooth", () => {
  // A heavy first two minutes (cut-ins of many files), light after: two minutes first.
  const needs = [
    { at_s: 5, bytes: 50 * MB, fresh: true },
    { at_s: 70, bytes: 50 * MB, fresh: true },
    { at_s: 200, bytes: 2 * MB, fresh: false },
    { at_s: 400, bytes: 2 * MB, fresh: false },
  ];
  expect(headFor(needs, 4 * MB, 600)).toBe(120);
  // A fast link: one minute (never less).
  expect(headFor(needs, 500 * MB, 600)).toBe(60);
  // No speed measured: as far as anything's missing (the last need, at 400 s), until one is.
  expect(headFor(needs, null, 600)).toBe(420);
  // An edit shorter than its minutes: all of it.
  expect(headFor([{ at_s: 5, bytes: 50 * MB, fresh: true }], 1 * MB, 45)).toBe(45);
});

test("getting a project ready brings its first minutes' files first in the timeline's order, then the rest of the footage, then the graphics", async () => {
  const home = scratch("footage-ready-order");
  try {
    const started: string[] = [];
    // Each fetch never ends: what starts is what's first in the queue, four at once.
    localPreviews.hooks.fetch = (key) => new Promise<void>(() => started.push(key));
    const project = newProject();
    const keys: string[] = ["a", "b", "c", "d", "e", "f"].map((name) => `edit/originals/sha256/${name}/clip.mp4`);
    keys.forEach((key, n) =>
      project.media.push(media({ id: `m${n}`, name: `m${n}`, path: stream(key), kind: "video", duration: 60, cloud: { proxy: key }, ...(n === 1 || n === 4 ? { effect: `cutfx-${n}` } : {}) } as never)),
    );
    // The first minute (1800 frames): m0, then the graphic m1. After it: m2, the graphic m4, m3, m5.
    project.clips.push(clip("c0", "m0", 0, 1800), clip("c1", "m1", 300, 90, "v2"), clip("c2", "m2", 1800, 900), clip("c3", "m4", 2000, 90, "v2"), clip("c4", "m3", 2700, 900), clip("c5", "m5", 3600, 900));
    expect(localPreviews.fetchInPlayheadOrder(home.dir, project, 0, [], 1800)).toBe(6);
    await Bun.sleep(5);
    expect(started).toEqual(keys.slice(0, 4));
    // Without a first minute (an open as before): the playhead's order, the graphics where they play.
    localPreviews.reset();
    started.length = 0;
    expect(localPreviews.fetchInPlayheadOrder(home.dir, project, 0)).toBe(6);
    await Bun.sleep(5);
    expect(started).toEqual([keys[0]!, keys[1]!, keys[2]!, keys[4]!]);
  } finally {
    home.cleanup();
  }
});

const stream = (key: string) => `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(key)}`;
const clip = (id: string, mediaId: string, start: number, duration: number, track = "v1") => ({ type: "video", id, track, media: mediaId, start, duration, source_in: 0, speed: 1 }) as never;

/** Blocks `indices` of a `blocks`-block object `key` kept under `root`, as cloud_blocks.ts keeps them. */
function keep(root: string, key: string, blocks: number, indices: number[]) {
  const folder = path.join(root, createHash("sha1").update(key).digest("hex"));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ size: blocks * BLOCK, type: "video/mp4", key }));
  for (const index of indices) fs.writeFileSync(path.join(folder, `${index}`), "");
}

/** Its whole copy here, `bytes` long. */
function whole(cache: string, key: string, bytes: number) {
  const local = localPath(cache, key);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, new Uint8Array(bytes));
}

/** An app with only what readiness reads: the project, the cache and the home. */
function appOf(dir: string, project: Project): App {
  return { store: { get: (id: string) => (id === project.id ? { project } : null), cacheDir: () => dir, home: dir, cloud: () => null } } as unknown as App;
}

test("a project's readiness from what's here: a whole copy, blocks of a file, nothing of another; the speed measured as they come; ready once the rest would come in time", async () => {
  const home = scratch("footage-ready");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    footageReady.hooks.root = () => root;
    let now = 1_000_000;
    footageReady.hooks.now = () => now;
    let received = 0;
    footageReady.hooks.received = () => received;
    const [a, b, c] = ["a", "b", "c"].map((name) => `edit/proxies/drive/${name}.mp4`) as [string, string, string];
    const project = newProject();
    project.settings.fps = 30;
    for (const [id, key] of [["a", a], ["b", b], ["c", c]] as const) project.media.push(media({ id, name: id, path: stream(key), kind: "video", duration: 60, cloud: { proxy: key } } as never));
    project.clips.push(clip("ca", "a", 0, 1800), clip("cb", "b", 1800, 1800), clip("cc", "c", 3600, 1800));
    // a here whole; b's first three of ten blocks (its first 15 s); none of c.
    whole(cache, a, 10 * BLOCK);
    keep(root, b, 10, [0, 1, 2]);
    const app = appOf(cache, project);

    const first = await readiness(app, project.id, false);
    expect(first.ready).toBe(false);
    expect(first.done).toBe(false);
    expect([first.files_done, first.files_total]).toEqual([1, 3]);
    expect(first.bytes_total).toBe(10 * BLOCK + 10 * BLOCK + guessOf(project, "c"));
    expect(first.bytes_done).toBe(13 * BLOCK);
    // No speed yet: no times, and the first step is the whole edit until there is one.
    expect(first.speed_bps).toBeNull();
    expect(first.ready_in_s).toBeNull();
    expect(first.head_s).toBe(180);
    expect(first.steps.map((step) => [step.kind, step.state])).toEqual([["start", "current"], ["rest", "waiting"]]);

    // Two seconds on, half of c has come (5 blocks, ~10.5 MB: ~5 MB/s): the rest would come in time.
    keep(root, c, 10, [0, 1, 2, 3, 4]);
    received += 5 * BLOCK;
    now += 2_000;
    const second = await readiness(app, project.id, false);
    expect(second.speed_bps).toBeCloseTo((5 * BLOCK) / 2, 0);
    expect(second.ready).toBe(true);
    // With a speed, the first step comes down from the whole edit to the first minute (a's, here already).
    expect(second.head_s).toBe(60);
    expect(second.steps[0]!.state).toBe("done");
    expect(second.ready_in_s).toBe(0);
    expect(second.left_s).toBeCloseTo((7 * BLOCK + 5 * BLOCK) / ((5 * BLOCK) / 2), 1);

    // Everything here whole: done, every step ticked.
    whole(cache, b, 10 * BLOCK);
    whole(cache, c, 10 * BLOCK);
    now += 2_000;
    const third = await readiness(app, project.id, false);
    expect([third.ready, third.done]).toEqual([true, true]);
    expect([third.files_done, third.files_total]).toEqual([3, 3]);
    expect(third.steps.every((step) => step.state === "done")).toBe(true);
    expect(third.room).toBeNull();
  } finally {
    home.cleanup();
  }
});

test("a slow link: not ready until the first minutes are here, and the graphics are a step of their own", async () => {
  const home = scratch("footage-ready-slow");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    footageReady.hooks.root = () => root;
    let now = 1_000_000;
    footageReady.hooks.now = () => now;
    let received = 0;
    footageReady.hooks.received = () => received;
    const keys = ["a", "b", "g"].map((name) => `edit/proxies/drive/${name}.mp4`) as [string, string, string];
    const project = newProject();
    project.settings.fps = 30;
    project.media.push(
      media({ id: "a", name: "a", path: stream(keys[0]), kind: "video", duration: 60, cloud: { proxy: keys[0] } } as never),
      media({ id: "b", name: "b", path: stream(keys[1]), kind: "video", duration: 600, cloud: { proxy: keys[1] } } as never),
      media({ id: "g", name: "g", path: stream(keys[2]), kind: "video", duration: 5, cloud: { proxy: keys[2] }, effect: "cutfx-1" } as never),
    );
    // A minute of a (100 blocks: 3.5 MB a second of it), then ten minutes of b (100 blocks: 0.35 MB a second), the graphic over b.
    project.clips.push(clip("ca", "a", 0, 1800), clip("cb", "b", 1800, 18000), clip("cg", "g", 6000, 150, "v2"));
    keep(root, keys[0], 100, [0]);
    keep(root, keys[1], 100, [0]);
    keep(root, keys[2], 5, [0]);
    const app = appOf(cache, project);
    await readiness(app, project.id, false);
    // 2 MB/s measured: two blocks in 2.1 s.
    keep(root, keys[0], 100, [0, 1, 2]);
    received += 2 * BLOCK;
    now += 2_097.152;
    const slow = await readiness(app, project.id, false);
    expect(Math.round(slow.speed_bps! / 1e5)).toBe(20);
    expect(slow.ready).toBe(false);
    expect(slow.steps.map((step) => [step.kind, step.state])).toEqual([["start", "current"], ["rest", "waiting"], ["graphics", "waiting"]]);
    // a whole and b's first minutes here: what's left of b reads ahead of the play at its pace.
    whole(cache, keys[0], 100 * BLOCK);
    keep(root, keys[1], 100, Array.from({ length: 20 }, (_, n) => n));
    now += 60_000;
    const later = await readiness(app, project.id, false);
    expect(later.ready).toBe(true);
    expect(later.steps[0]!.state).toBe("done");
    expect(later.done).toBe(false);
  } finally {
    home.cleanup();
  }
});

test("the speed is what's downloaded: a file landing here at once without coming down (a graphic the backfill registered, a joined copy) is no burst of speed, and doesn't open the project", async () => {
  const home = scratch("footage-ready-landed");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    footageReady.hooks.root = () => root;
    let now = 1_000_000;
    footageReady.hooks.now = () => now;
    let received = 0;
    footageReady.hooks.received = () => received;
    const keys = ["a", "b"].map((name) => `edit/proxies/drive/${name}.mp4`) as [string, string];
    const project = newProject();
    project.settings.fps = 30;
    // Ten minutes of a (300 blocks: 1 MB a second of it), and b a minute after it starts.
    project.media.push(
      media({ id: "a", name: "a", path: stream(keys[0]), kind: "video", duration: 600, cloud: { proxy: keys[0] } } as never),
      media({ id: "b", name: "b", path: stream(keys[1]), kind: "video", duration: 60, cloud: { proxy: keys[1] } } as never),
    );
    project.clips.push(clip("ca", "a", 0, 18000), clip("cb", "b", 1800, 1800, "v2"));
    keep(root, keys[0], 300, [0]);
    const app = appOf(cache, project);
    await readiness(app, project.id, false);
    // 0.5 MB/s coming down: too slow for a.
    keep(root, keys[0], 300, [0, 1]);
    received += BLOCK;
    now += 4_194.304;
    const slow = await readiness(app, project.id, false);
    expect(Math.round(slow.speed_bps! / 1e5)).toBe(5);
    expect(slow.ready).toBe(false);
    // b's whole copy (32 MB) lands at once, nothing more downloaded: the speed holds, still not ready.
    whole(cache, keys[1], 16 * BLOCK);
    now += 2_000;
    const landed = await readiness(app, project.id, false);
    expect(landed.bytes_done).toBe(18 * BLOCK);
    // Measured off the project's bytes here, that read as 5.8 MB/s, and ready.
    expect(landed.speed_bps!).toBeLessThan(0.6e6);
    expect(landed.ready).toBe(false);
  } finally {
    home.cleanup();
  }
});

test("the speed holds steady while blocks land in bursts: a few together now and then is still the speed the footage comes at", async () => {
  const home = scratch("footage-ready-bursts");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    footageReady.hooks.root = () => root;
    let now = 1_000_000;
    footageReady.hooks.now = () => now;
    let received = 0;
    footageReady.hooks.received = () => received;
    const key = "edit/proxies/drive/a.mp4";
    const project = newProject();
    project.settings.fps = 30;
    project.media.push(media({ id: "a", name: "a", path: stream(key), kind: "video", duration: 600, cloud: { proxy: key } } as never));
    project.clips.push(clip("ca", "a", 0, 18000));
    keep(root, key, 300, [0]);
    const app = appOf(cache, project);
    // Blocks landing as several lanes finish together, a burst every few seconds (kenobi's series, Nov 17): 24 blocks
    // in 96 s, half a MB a second.
    const bursts = new Map([[3, 1], [5, 3], [14, 1], [16, 4], [27, 2], [35, 1], [37, 3], [48, 2], [51, 1], [62, 4], [70, 1], [79, 2], [88, 3], [96, 1]]);
    const truth = (29 * BLOCK) / 96;
    const speeds: number[] = [];
    // Asked every second, as the dialog asks.
    for (let second = 0; second <= 96; second++) {
      received += (bursts.get(second) ?? 0) * BLOCK;
      const answer = await readiness(app, project.id, false);
      if (second >= 30) speeds.push(answer.speed_bps!);
      now += 1_000;
    }
    for (const speed of speeds) expect(Math.abs(speed / truth - 1)).toBeLessThan(0.4);
  } finally {
    home.cleanup();
  }
});

test("the disk's floors hold: footage that can't all fit is said so plainly, and at the floor nothing waits (it plays from the cloud)", async () => {
  const home = scratch("footage-ready-room");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    footageReady.hooks.root = () => root;
    const key = "edit/proxies/drive/big.mp4";
    const project = newProject();
    project.settings.fps = 30;
    project.media.push(media({ id: "a", name: "a", path: stream(key), kind: "video", duration: 600, cloud: { proxy: key } } as never));
    project.clips.push(clip("ca", "a", 0, 18000));
    keep(root, key, 2000, [0]);
    const app = appOf(cache, project);
    // Room for a gigabyte over what whole copies leave free (what Edit keeps free on the tests' 100 GB disk), of a 4.2 GB file.
    storage.diskHooks.free = () => storage.cacheFloor(cache) + 1e9;
    const short = await readiness(app, project.id, false);
    expect(short.room).toBe("Only 1.0 of the 4.2 GB fits on this Mac. The start of the edit comes first; the rest plays from the cloud.");
    expect(short.ready).toBe(false);
    // Its whole copy asked for and refused for want of room: "The rest of the footage" is over but not ready, it streams.
    localPreviews.hooks.fetch = async () => {};
    localPreviews.fetchWhole(key, localPath(cache, key), 2000 * BLOCK);
    const streaming = await readiness(app, project.id, false);
    expect(streaming.steps.find((step) => step.kind === "rest")).toMatchObject({ state: "done", streams: true });
    // At the work's floor nothing read is kept: nothing to wait for.
    storage.diskHooks.free = () => storage.WORK_FLOOR_BYTES;
    const full = await readiness(app, project.id, false);
    expect(full.ready).toBe(true);
    expect(full.room).toBe("This Mac's disk is too full to keep the footage, so it plays from the cloud.");
  } finally {
    home.cleanup();
  }
});

test("a project with nothing in the cloud, or whose footage is all here, is ready at once: no dialog", async () => {
  const home = scratch("footage-ready-here");
  try {
    const cache = home.dir;
    footageReady.hooks.root = () => path.join(cache, "cloud", "blocks");
    const project = newProject();
    project.media.push(media({ id: "a", name: "a", path: path.join(cache, "own.mp4"), kind: "video", duration: 60 }));
    fs.writeFileSync(path.join(cache, "own.mp4"), "mp4");
    project.clips.push(clip("ca", "a", 0, 1800));
    const answer = await readiness(appOf(cache, project), project.id, false);
    expect([answer.ready, answer.done, answer.files_total]).toEqual([true, true, 0]);
  } finally {
    home.cleanup();
  }
});

function guessOf(project: Project, id: string): number {
  const one = project.media.find((media) => media.id === id)!;
  return localPreviews.previewBytes(one, one.cloud!.proxy!);
}

/** "This Mac" ("This computer" off a Mac). */
const here = () => `${THIS_MACHINE.charAt(0).toUpperCase()}${THIS_MACHINE.slice(1)}`;

/** A ten-minute project of one streamed file (`blocks` of it, `here` read), its speed measured at 1 MB/s. */
async function slowProject(cache: string, blocks: number, here: number[]) {
  const root = path.join(cache, "cloud", "blocks");
  footageReady.hooks.root = () => root;
  let now = 1_000_000;
  footageReady.hooks.now = () => now;
  let received = 0;
  footageReady.hooks.received = () => received;
  const prepared: number[] = [];
  footageReady.hooks.prepare = (_app, _id, head) => void prepared.push(head);
  const key = "edit/proxies/drive/long.mp4";
  const project = newProject();
  project.settings.fps = 30;
  project.media.push(media({ id: "a", name: "a", path: stream(key), kind: "video", duration: 600, cloud: { proxy: key } } as never));
  project.clips.push(clip("ca", "a", 0, 18000));
  keep(root, key, blocks, here);
  const app = appOf(cache, project);
  await readiness(app, project.id, false);
  received += 2_000_000;
  now += 2_000;
  return { app, project, prepared };
}

test("while its dialog or card waits on the footage the link is the person's: background work gives way, and it's let go once all is here or Open now asks without waiting", async () => {
  const home = scratch("footage-ready-hold");
  try {
    const { app, project, prepared } = await slowProject(home.dir, 1000, [0]);
    const waited = await readiness(app, project.id, true);
    expect(waited.ready).toBe(false);
    expect(prepared.length).toBe(1);
    expect(playing.linkHeld()).toBe(true);
    expect(playing.isIdle()).toBe(false);
    // Nothing plays: the footage's own fetches go on; everything else waits.
    expect(playing.isPlaying()).toBe(false);
    let idle = false;
    void playing.whenIdle().then(() => (idle = true));
    expect(await playing.whenNotPlaying()).toBe(true);
    await Bun.sleep(5);
    expect(idle).toBe(false);
    // Open now: asked without waiting, the link goes back at once.
    await readiness(app, project.id, false);
    expect(playing.linkHeld()).toBe(false);
    await Bun.sleep(playing.hooks.pollMs + 20);
    expect(idle).toBe(true);
  } finally {
    home.cleanup();
  }
});

test("one that can't become smooth here (it doesn't fit and the link can't stream it) says so plainly instead of waiting", async () => {
  const home = scratch("footage-ready-cant");
  try {
    // 4.2 GB over ten minutes at 1 MB/s, and room for 300 MB of blocks: never smooth.
    storage.diskHooks.free = () => storage.WORK_FLOOR_BYTES + 300_000_000;
    const { app, project } = await slowProject(home.dir, 2000, [0]);
    const cant = await readiness(app, project.id, true);
    expect(cant.ready).toBe(false);
    expect(cant.cant).toBe(`${here()} can't hold all of it and the connection is too slow to stream it smoothly. Open now plays it as it comes; it may pause.`);
    expect(cant.room).toBeNull();
    // Its first minute and more here: the start plays smoothly, later parts may pause.
    const start = await slowProject(home.dir, 2000, Array.from({ length: 250 }, (_, n) => n));
    const later = await readiness(start.app, start.project.id, true);
    expect(later.cant).toBe(`${here()} can't hold all of it and the connection is too slow to stream the rest smoothly. Open now plays the start smoothly; later parts may pause.`);
    // Room enough: no such line, it just takes a while.
    storage.diskHooks.free = () => 500 * 1e9;
    expect((await readiness(start.app, start.project.id, true)).cant).toBeNull();
  } finally {
    home.cleanup();
  }
});

test("Home's line says how far the footage coming here has got, only while it's in the queue, and only looks: no link held, nothing brought first", async () => {
  const home = scratch("footage-coming");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    footageReady.hooks.root = () => root;
    let now = 1_000_000;
    footageReady.hooks.now = () => now;
    let received = 0;
    footageReady.hooks.received = () => received;
    const prepared: number[] = [];
    footageReady.hooks.prepare = (_app, _id, head) => void prepared.push(head);
    // Each fetch never ends: what's queued stays coming.
    localPreviews.hooks.fetch = () => new Promise<void>(() => {});
    const [a, b, c] = ["a", "b", "c"].map((name) => `edit/proxies/drive/${name}.mp4`) as [string, string, string];
    const project = newProject();
    project.settings.fps = 30;
    for (const [id, key] of [["a", a], ["b", b], ["c", c]] as const) project.media.push(media({ id, name: id, path: stream(key), kind: "video", duration: 60, cloud: { proxy: key } } as never));
    project.clips.push(clip("ca", "a", 0, 1800), clip("cb", "b", 1800, 1800), clip("cc", "c", 3600, 1800));
    // a here whole; b's first three of ten blocks; none of c.
    whole(cache, a, 10 * BLOCK);
    keep(root, b, 10, [0, 1, 2]);
    const app = appOf(cache, project);

    // Not opened here, so nothing of it is coming: nothing to say.
    expect(await footageReady.coming(app, project.id)).toBeNull();
    // Opened: b and c queued to come down whole, and the line follows them.
    expect(localPreviews.fetchInPlayheadOrder(cache, project, 0)).toBe(2);
    const first = await footageReady.coming(app, project.id);
    expect(first).toEqual({ files_done: 1, files_total: 3, bytes_done: 13 * BLOCK, bytes_total: 20 * BLOCK + guessOf(project, "c"), left_s: null });
    expect(prepared).toEqual([]);
    expect(playing.linkHeld()).toBe(false);

    // The editor's asks measured a speed (~5 MB/s): the line has a time by it, and asking it measures nothing.
    await readiness(app, project.id, false);
    received += 5 * BLOCK;
    now += 2_000;
    const bps = (await readiness(app, project.id, false)).speed_bps!;
    received += 50 * BLOCK;
    now += 2_000;
    const timed = await footageReady.coming(app, project.id);
    expect(timed!.left_s).toBeCloseTo((7 * BLOCK + guessOf(project, "c")) / bps, 3);

    // Everything here: nothing coming.
    whole(cache, b, 10 * BLOCK);
    whole(cache, c, 10 * BLOCK);
    expect(await footageReady.coming(app, project.id)).toBeNull();
  } finally {
    home.cleanup();
  }
});

test("Home's status carries each project's footage coming here, and none for a project whose footage isn't coming", async () => {
  const { fixtureHome } = await import("./helpers/home.ts");
  const { projectStatus } = await import("../src/reviews.ts");
  const { app, cleanup } = fixtureHome("footage-coming-status");
  try {
    const root = path.join(app.store.cacheDir(), "cloud", "blocks");
    footageReady.hooks.root = () => root;
    localPreviews.hooks.fetch = () => new Promise<void>(() => {});
    (app as { agents: unknown }).agents = { chat: () => ({ running: false, entries: [] }), turn: () => ({ running: false, entries: [] }) };
    (app as { exports: unknown }).exports = { running: () => false };
    const coming = app.store.createAs("Coming", "bodycam", { width: 1920, height: 1080, fps: 30 });
    const quiet = app.store.createAs("Quiet", "bodycam", { width: 1920, height: 1080, fps: 30 }).project.id;
    const key = "edit/proxies/drive/coming.mp4";
    const given = structuredClone(coming.project) as Project;
    given.media.push(media({ id: "a", name: "a", path: stream(key), kind: "video", duration: 60, cloud: { proxy: key } } as never));
    given.clips.push(clip("ca", "a", 0, 1800));
    const saved = await app.store.replace(coming.project.id, coming.rev, given, "test");
    localPreviews.fetchInPlayheadOrder(app.store.cacheDir(), saved.project, 0);
    const status = await projectStatus(app);
    expect(status[coming.project.id]!.footage).toMatchObject({ files_done: 0, files_total: 1, bytes_done: 0 });
    expect(status[quiet]!.footage).toBeNull();
  } finally {
    cleanup();
  }
});
