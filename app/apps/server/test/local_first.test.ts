// Footage local while a project is in work (local_first.ts): a new channel project's import keeps each source's
// original here and makes one working copy from it, behind the import; every other project keeps today's path.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";

import * as fs from "node:fs";
import { join } from "node:path";

import * as cloud from "../src/cloud.ts";
import { cleanPass } from "../src/cache_cleanup.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import * as encoder from "../src/encoder.ts";
import { importPaths } from "../src/import.ts";
import * as jobs from "../src/jobs.ts";
import * as keyframes from "../src/keyframe_index.ts";
import * as localFirst from "../src/local_first.ts";
import * as localPreviews from "../src/local_previews.ts";
import * as outages from "../src/outages.ts";
import type { Probe, Project } from "../src/model.ts";
import { nativeSources } from "../src/native_preview.ts";
import { useNative, wrap } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import * as relay from "../src/relay.ts";
import * as seams from "../src/seams.ts";
import * as storage from "../src/storage.ts";
import { copiesHere, Jobs, start } from "../src/script.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome, scratch, type Fixture } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
let clips: { dir: string; cleanup(): void };
/** Keyframes 5 s apart with B-frames (as a YouTube download), and one every second (as a bodycam export). */
let farApart: string;
let close: string;
const segment = localFirst.WORKING.segment_s;

const SECONDS = 8;
const PROBE: Probe = { kind: "video", duration: SECONDS, width: 1280, height: 720, fps: 30, has_audio: true };

function makeClip(out: string, gop: number): void {
  const made = Bun.spawnSync([
    tools.ffmpeg(), "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${SECONDS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-bf", "2",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", out,
  ]);
  if (made.exitCode !== 0) throw new Error(`ffmpeg: ${made.stderr.toString()}`);
}

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
  clips = scratch("local-first-clips");
  farApart = join(clips.dir, "far.mp4");
  close = join(clips.dir, "close.mp4");
  makeClip(farApart, 150);
  makeClip(close, 30);
  // Several stretches for an 8 s clip.
  localFirst.WORKING.segment_s = 3;
}, 60_000);

afterAll(() => {
  localFirst.WORKING.segment_s = segment;
  clips.cleanup();
  restore();
  mock.stop();
});

/** A home whose addon probes every file as the clips are. */
function home(name: string, options: Parameters<typeof fixtureHome>[1] = {}): Fixture {
  const fixture = fixtureHome(name, options);
  const raw = createStub();
  raw.init({ home: fixture.home, cacheDir: `${fixture.home}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", log: () => {} });
  raw.probe = async () => PROBE;
  useNative(wrap(raw));
  mock.cloud.objects.clear();
  mock.cloud.convex.media.clear();
  cloudMedia.configurePlayback(fixture.app);
  return fixture;
}

/** A new channel project (Edit V2), as Home's New project makes one. */
function channelProject(fixture: Fixture, name = "local"): string {
  const id = fixture.store.createAs(name, "bodycam", { width: 1280, height: 720, fps: 30 }, true).project.id;
  void fixture.store.update(id, "test", (project) => {
    project.channel = "ch-test";
  });
  return id;
}

/** Waits for `check` to hold (at most `ms`). */
async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** Every file under `dir`, relative. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(at, name);
      if (fs.statSync(path).isDirectory()) walk(path);
      else out.push(path.slice(dir.length + 1));
    }
  };
  walk(dir);
  return out.sort();
}

/** The footage in the cloud stand-in (a V2 project's chat goes up too). */
const footageUp = () => [...mock.cloud.objects.keys()].filter((key) => key.startsWith("edit/originals/") || key.startsWith("edit/proxies/"));

/** The video id of a `youtube:<id>` file. */
const youtube = (file: string): string => file.slice("youtube:".length);

const gapOf = async (path: string, duration: number) => {
  keyframes.forget();
  return localFirst.keyframeGap(path, duration);
};

test("the switch: a new channel project takes the local path at its first import, and nothing else ever does", async () => {
  const fixture = home("local-first-switch");
  try {
    const fresh = channelProject(fixture);
    expect(await localFirst.settle(fixture.app, fresh)).toBe(true);
    expect(fixture.store.get(fresh)!.project.local_media).toBe(true);
    // A V1 project, and a V2 project without a channel.
    const v1 = fixture.store.create("v1", { width: 1280, height: 720, fps: 30 }).project.id;
    expect(await localFirst.settle(fixture.app, v1)).toBe(false);
    const bare = fixture.store.createAs("bare", "bodycam", { width: 1280, height: 720, fps: 30 }, true).project.id;
    expect(await localFirst.settle(fixture.app, bare)).toBe(false);
    // A channel project that already has cloud footage keeps today's path for good.
    const old = channelProject(fixture, "old");
    await fixture.store.update(old, "test", (project) => {
      project.media.push({ id: "m1", name: "a.mp4", path: "x", kind: "video", duration: 5, width: 1280, height: 720, fps: 30, has_audio: true, cloud: { source: "youtube:aaaaaaaaaaa", original: "edit/originals/youtube/aaaaaaaaaaa/a.mp4", proxy: "edit/proxies/youtube/aaaaaaaaaaa.mp4", size: 1 } });
    });
    expect(await localFirst.settle(fixture.app, old)).toBe(false);
    for (const id of [v1, bare, old]) expect(fixture.store.get(id)!.project.local_media).toBeUndefined();
    // A whole save from a page that read the project before the choice never takes it back.
    const before = structuredClone(fixture.store.get(fresh)!.project) as Project;
    delete before.local_media;
    await fixture.store.replace(fresh, null, before, "page");
    expect(fixture.store.get(fresh)!.project.local_media).toBe(true);
    // Saved by a build from before the field (it drops it): its working copies still say which path it took.
    const dropped = channelProject(fixture, "dropped");
    await fixture.store.update(dropped, "test", (project) => {
      project.media.push({ id: "m1", name: "a.mp4", path: "x", kind: "video", duration: 5, width: 1280, height: 720, fps: 30, has_audio: true, cloud: { source: "youtube:bbbbbbbbbbb", original: "edit/originals/youtube/bbbbbbbbbbb/a.mp4", proxy: "edit/proxies/v720/youtube/bbbbbbbbbbb.mp4", size: 1 } });
    });
    expect(localFirst.chosen(fixture.store.get(dropped)!.project)).toBe(true);
    expect(await localFirst.settle(fixture.app, dropped)).toBe(true);
    expect(fixture.store.get(dropped)!.project.local_media).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test("a far-apart keyframe file gets one working copy made behind, in stretches, and a restart carries on from the stretches made", async () => {
  const fixture = home("local-first-working");
  const runs: string[][] = [];
  const run = localFirst.hooks.run;
  try {
    const cache = fixture.store.cacheDir();
    const key = "edit/originals/youtube/wrkCopyTest/far.mp4";
    const original = cloudMedia.localPath(cache, key);
    fs.mkdirSync(join(original, ".."), { recursive: true });
    fs.copyFileSync(farApart, original);
    expect(await gapOf(original, SECONDS)).toBeGreaterThan(2);
    // The second stretch fails, as a restart would cut it.
    let failNext = 1;
    localFirst.hooks.run = async (command) => {
      runs.push(command);
      if (command.includes("-frames:v") && runs.filter((one) => one.includes("-frames:v")).length === 2 && failNext-- > 0) throw new Error("stopped");
      return run(command);
    };
    const made = await localFirst.media(fixture.home, cache, { source: "youtube:wrkCopyTest", key, name: "far.mp4", path: original, size: fs.statSync(original).size, upload: false });
    const proxy = made.cloud!.proxy!;
    expect(proxy).toBe("edit/proxies/v720/youtube/wrkCopyTest.mp4");
    const at = cloudMedia.localPath(cache, proxy);
    // Playable at once: the original stands in at the working copy's place.
    expect(localFirst.isStandIn(at, original)).toBe(true);
    await until(() => jobs.list(fixture.home, "upload").some((job) => job.state === "waiting"));
    const row = jobs.list(fixture.home, "upload").find((job) => job.args.working === proxy)!;
    expect(row.step).toBe("Making it quick to scrub, 0 of 0 min");
    expect(localFirst.isStandIn(at, original)).toBe(true);
    // Edit starts again: the row is carried on, the first stretch not made twice.
    const before = runs.filter((one) => one.includes("-frames:v")).length;
    cloudMedia.resumeUpload(fixture.home, row.args);
    await until(() => !localFirst.isStandIn(at, original) && fs.existsSync(at) && jobs.list(fixture.home, "upload").every((job) => job.args.working !== proxy));
    const stretches = runs.filter((one) => one.includes("-frames:v"));
    expect(stretches.length - before).toBe(localFirst.stretchesOf(SECONDS) - 1);
    // Each stretch took its turn on the encoder's background tier, and none is left.
    expect(encoder.busy()).toBe(false);
    expect(fs.existsSync(join(cache, "cloud", "making"))).toBe(true);
    expect(fs.readdirSync(join(cache, "cloud", "making"))).toEqual([]);
    // What it is: one file, a keyframe every second, the sound kept, the length kept.
    expect(await gapOf(at, SECONDS)).toBeLessThanOrEqual(1.05);
    const probed = Bun.spawnSync([tools.ffprobe(), "-v", "error", "-show_entries", "stream=codec_type,width,height,has_b_frames:format=duration", "-of", "json", at]).stdout.toString();
    const info = JSON.parse(probed) as { streams: { codec_type: string; width?: number; height?: number; has_b_frames?: number }[]; format: { duration: string } };
    expect(info.streams.map((one) => one.codec_type).sort()).toEqual(["audio", "video"]);
    expect(info.streams.find((one) => one.codec_type === "video")!.height).toBe(720);
    expect(info.streams.find((one) => one.codec_type === "video")!.has_b_frames ?? 0).toBe(0);
    expect(Math.abs(Number(info.format.duration) - SECONDS)).toBeLessThan(0.2);
    // Then it goes up, as today's whole proxies do.
    await until(() => footageUp().includes(proxy) && jobs.list(fixture.home, "upload").length === 0);
  } finally {
    localFirst.hooks.run = run;
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("a close-keyframe file is its own working copy: nothing made, nothing but the original here", async () => {
  const fixture = home("local-first-own");
  try {
    const cache = fixture.store.cacheDir();
    const key = "edit/originals/drive/FILEabcdefgh/close.mp4";
    const original = cloudMedia.localPath(cache, key);
    fs.mkdirSync(join(original, ".."), { recursive: true });
    fs.copyFileSync(close, original);
    const made = await localFirst.media(fixture.home, cache, { source: "drive:FILEabcdefgh", key, name: "close.mp4", path: original, size: fs.statSync(original).size, upload: false });
    expect(made.cloud!.proxy!).toBe(key);
    expect(jobs.list(fixture.home, "upload")).toEqual([]);
    expect(filesUnder(join(cache, "cloud"))).toEqual(["local-originals.json", "originals/drive/FILEabcdefgh/close.mp4"]);
  } finally {
    fixture.cleanup();
  }
});

/** A stand-in yt-dlp that "downloads" `clip` (as youtube.ts's `after_move:EDIT-FILE` says where it put it). */
function fakeYtDlp(dir: string, clip: string): string {
  const binary = join(dir, "yt-dlp");
  fs.writeFileSync(binary, `#!/bin/sh
echo call >> '${dir}/calls'
for arg in "$@"; do if [ "$prev" = '-P' ]; then out="$arg"; fi; prev="$arg"; done
cp '${clip}' "$out/far.mp4"
echo "EDIT-FILE $out/far.mp4"
`, { mode: 0o755 });
  return binary;
}

test("a YouTube import on a new channel project keeps the original, answers before any upload, plays from the original and then from its one working copy, and sends both up behind", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-youtube", { services: { scripts } });
  const previous = process.env.EDIT_YTDLP;
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const realUpload = cloud.uploadFile;
  let letUp!: () => void;
  const upGate = new Promise<void>((resolve) => (letUp = resolve));
  const uploads = spyOn(cloud, "uploadFile").mockImplementation(async (...args: Parameters<typeof cloud.uploadFile>) => {
    await upGate;
    return realUpload(...args);
  });
  const run = localFirst.hooks.run;
  let letMake!: () => void;
  const makeGate = new Promise<void>((resolve) => (letMake = resolve));
  localFirst.hooks.run = async (command, signal) => {
    await makeGate;
    return run(command, signal);
  };
  try {
    process.env.EDIT_YTDLP = fakeYtDlp(fixture.dir, farApart);
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "footage", file: "youtube:abcdefghijk", url: "https://youtu.be/abcdefghijk", start: 1, end: 3, label: "00:01–00:03" }] };
    });
    await start(fixture.app, id, false);
    const cache = fixture.store.cacheDir();
    const project = fixture.store.get(id)!.project;
    expect(scripts.get(id)!.state).toBe("done");
    expect(project.local_media).toBe(true);
    // One media, the whole source; the clip points into it.
    expect(project.media.length).toBe(1);
    const media = project.media[0]!;
    expect(media.duration).toBe(SECONDS);
    expect(media.cloud!.proxy!).toBe("edit/proxies/v720/youtube/abcdefghijk.mp4");
    const clip = project.clips.find((one) => one.type === "video")!;
    expect(clip.media).toBe(media.id);
    expect(clip.source_in ?? 0).toBeCloseTo(1, 1);
    // The original kept here at its key's place, noted, and nothing up yet.
    const original = cloudMedia.localPath(cache, media.cloud!.original);
    expect(fs.readFileSync(original)).toEqual(fs.readFileSync(farApart));
    expect(cloudMedia.localOriginal(cache, media.cloud!.original)).toBe(original);
    expect(footageUp()).toEqual([]);
    // Played before its working copy is made: the window reads the original itself.
    const before = (await (await nativeSources(fixture.app, project)).json()) as { sources: Record<string, string>; sounds: Record<string, string> };
    expect(before.sources[media.id]).toBe(original);
    expect(before.sounds[media.id]).toBe(original);
    // The working copy made: the window is told and reads it from then on.
    letMake();
    const at = cloudMedia.localPath(cache, media.cloud!.proxy!);
    await until(() => fs.existsSync(at) && !localFirst.isStandIn(at, original));
    const after = (await (await nativeSources(fixture.app, project)).json()) as { sources: Record<string, string> };
    expect(after.sources[media.id]).toBe(at);
    // Both go up behind, the original first; the registry's own proxy left for today's path.
    letUp();
    await until(() => mock.cloud.objects.has(media.cloud!.proxy!) && jobs.list(fixture.home, "upload").length === 0);
    expect(footageUp()).toEqual([media.cloud!.original, media.cloud!.proxy!]);
    const record = mock.cloud.convex.media.get("youtube:abcdefghijk")!;
    expect(record.originalReady).toBe(true);
    expect(record.originalKey).toBe(media.cloud!.original);
    expect(record.proxyKey ?? null).toBeNull();
    // One form per source here: no pieces, no joins, no cuts of pieces, no blocks, nothing left in scratch.
    expect(filesUnder(join(cache, "cloud"))).toEqual(["local-originals.json", media.cloud!.original.slice("edit/".length), media.cloud!.proxy!.slice("edit/".length)]);
    expect(fs.readFileSync(join(fixture.dir, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    letUp();
    letMake();
    localFirst.hooks.run = run;
    localFirst.reset();
    uploads.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    if (previous === undefined) delete process.env.EDIT_YTDLP;
    else process.env.EDIT_YTDLP = previous;
    fixture.cleanup();
  }
}, 60_000);

/** A local-first project with `clip` imported as YouTube video `video` (its original here, its working copy made), and the clip on its timeline. */
async function imported(fixture: Fixture, video: string, clip: string, upload: boolean): Promise<{ id: string; project: Project; original: string; working: string }> {
  const cache = fixture.store.cacheDir();
  const key = `edit/originals/youtube/${video}/clip.mp4`;
  const original = cloudMedia.localPath(cache, key);
  fs.mkdirSync(join(original, ".."), { recursive: true });
  fs.copyFileSync(clip, original);
  const made = await localFirst.media(fixture.home, cache, { source: `youtube:${video}`, key, name: "clip.mp4", path: original, size: fs.statSync(original).size, upload });
  const id = channelProject(fixture);
  await localFirst.settle(fixture.app, id);
  await fixture.store.update(id, "test", (project) => {
    project.media.push({ id: "m1", name: made.name, path: made.path, kind: "video", duration: SECONDS, width: 1280, height: 720, fps: 30, has_audio: true, cloud: made.cloud! });
    project.clips.push({ id: "c1", track: "v1", start: 0, duration: 90, type: "video", media: "m1", source_in: 1, speed: 1 } as Project["clips"][number]);
  });
  const working = cloudMedia.localPath(cache, made.cloud!.proxy!);
  return { id, project: fixture.store.get(id)!.project, original, working };
}

test("export reads the original here, with nothing fetched from the cloud", async () => {
  const fixture = home("local-first-export");
  try {
    const { project, original } = await imported(fixture, "exportTest1", close, false);
    const asked = mock.calls("/v1/cloud/r2/url").length;
    const [out, originals] = await cloudMedia.forExport(project, 0, 90, fixture.store.cacheDir());
    expect(out.media[0]!.path).toBe(original);
    expect(mock.calls("/v1/cloud/r2/url").length).toBe(asked);
    originals.release();
  } finally {
    fixture.cleanup();
  }
});

test("its original and working copy stay while anything of it isn't in the cloud, and go once it's done and R2 holds them", async () => {
  const fixture = home("local-first-retention");
  const realUpload = cloud.uploadFile;
  let letUp!: () => void;
  const upGate = new Promise<void>((resolve) => (letUp = resolve));
  const uploads = spyOn(cloud, "uploadFile").mockImplementation(async (...args: Parameters<typeof cloud.uploadFile>) => {
    await upGate;
    return realUpload(...args);
  });
  try {
    const { id, original, working } = await imported(fixture, "retainTest1", farApart, true);
    await until(() => fs.existsSync(working) && !localFirst.isStandIn(working, original));
    // Left 8 days: let go as done, but its upload hasn't landed, so it's in work and all of it stays.
    const at = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(`${fixture.home}/projects/${id}.json`, at, at);
    const size = (path: string) => async () => ({ size: fs.statSync(path).size });
    await cleanPass(fixture.app, Date.now(), size(original));
    expect([fs.existsSync(original), fs.existsSync(working)]).toEqual([true, true]);
    // Up: the original (R2 has it at its size) and its working copy go with the rest.
    letUp();
    await until(() => footageUp().length === 2 && jobs.list(fixture.home, "upload").length === 0);
    fs.utimesSync(`${fixture.home}/projects/${id}.json`, at, at);
    // Written days ago, as a week-old project's files are (the cleaner never takes what was written in the last hours).
    for (const path of [original, working]) fs.utimesSync(path, at, at);
    await cleanPass(fixture.app, Date.now(), async (key) => ({ size: mock.cloud.objects.get(key)?.length ?? 0 }));
    expect([fs.existsSync(original), fs.existsSync(working)]).toEqual([false, false]);
    expect(cloudMedia.localOriginal(fixture.store.cacheDir(), `edit/originals/youtube/retainTest1/clip.mp4`)).toBeNull();
  } finally {
    letUp();
    uploads.mockRestore();
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("another computer opening the project waits for its working copy without an error, and plays it from a whole copy once it's up", async () => {
  const fixture = home("local-first-first-home");
  const realUpload = cloud.uploadFile;
  let letUp!: () => void;
  const upGate = new Promise<void>((resolve) => (letUp = resolve));
  const uploads = spyOn(cloud, "uploadFile").mockImplementation(async (...args: Parameters<typeof cloud.uploadFile>) => {
    await upGate;
    return realUpload(...args);
  });
  const waits = localPreviews.retryHooks.waits;
  localPreviews.retryHooks.waits = [50];
  let other: Fixture | null = null;
  try {
    const { project, original, working } = await imported(fixture, "secondHome1", farApart, true);
    await until(() => fs.existsSync(working) && !localFirst.isStandIn(working, original));
    // The other computer: the same project, from the cloud.
    other = home("local-first-second-home");
    const there = other.store.putFromCloud(structuredClone(project), "cloud").project;
    const key = there.media[0]!.cloud!.proxy!;
    const copy = cloudMedia.localPath(other.store.cacheDir(), key);
    const first = (await (await nativeSources(other.app, there)).json()) as { sources: Record<string, string>; coming: boolean };
    expect(first.sources.m1!.startsWith("http://127.0.0.1:")).toBe(true);
    expect(first.coming).toBe(true);
    await Bun.sleep(300);
    // Not up yet: asked again shortly, never counted as one that won't come.
    expect(localPreviews.failedLately(copy)).toBe(false);
    letUp();
    await until(() => fs.existsSync(copy));
    expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(working));
    const then = (await (await nativeSources(other.app, there)).json()) as { sources: Record<string, string> };
    expect(then.sources.m1).toBe(copy);
  } finally {
    letUp();
    localPreviews.retryHooks.waits = waits;
    uploads.mockRestore();
    localFirst.reset();
    other?.cleanup();
    fixture.cleanup();
  }
}, 60_000);

test("a local file's import with the relay down answers with footage that plays here, and its working copy is made here all the same", async () => {
  const fixture = home("local-first-relay-down");
  const relayUrl = process.env.EDIT_RELAY_URL;
  const wait = localFirst.CLOUD_WAIT_MS.value;
  localFirst.CLOUD_WAIT_MS.value = 500;
  try {
    const id = channelProject(fixture);
    const file = join(fixture.dir, "bodycam.mp4");
    fs.copyFileSync(farApart, file);
    // Nothing answers at the relay's address.
    process.env.EDIT_RELAY_URL = "http://127.0.0.1:9";
    const began = Date.now();
    const [, added, errors] = await importPaths(fixture.app, id, [file], false, "test");
    expect(errors).toEqual([]);
    expect(Date.now() - began).toBeLessThan(5_000);
    const project = fixture.store.get(id)!.project;
    expect(project.local_media).toBe(true);
    const media = project.media.find((one) => one.id === added[0])!;
    const cache = fixture.store.cacheDir();
    const original = cloudMedia.localPath(cache, media.cloud!.original);
    // The person's file linked in (only read), noted, and playing here now.
    expect(fs.statSync(original).ino).toBe(fs.statSync(file).ino);
    expect(cloudMedia.localOriginal(cache, media.cloud!.original)).toBe(original);
    const sources = (await (await nativeSources(fixture.app, project)).json()) as { sources: Record<string, string> };
    expect([original, cloudMedia.localPath(cache, media.cloud!.proxy!)]).toContain(sources.sources[media.id]!);
    const working = cloudMedia.localPath(cache, media.cloud!.proxy!);
    await until(() => fs.existsSync(working) && !localFirst.isStandIn(working, original));
    // Its uploads, the original's and the working copy's, wait for the relay, tried again by themselves.
    await until(() => jobs.list(fixture.home, "upload").some((job) => job.args.uploadOriginal === true && job.state === "waiting"));
    await until(() => jobs.list(fixture.home, "upload").some((job) => job.args.proxy === media.cloud!.proxy && job.args.working === undefined && job.state === "waiting"));
    // Each on its own row, so a restart carries both on.
    expect(jobs.list(fixture.home, "upload").filter((job) => job.state === "waiting").map((job) => job.args.uploadOriginal).sort()).toEqual([false, true]);
  } finally {
    process.env.EDIT_RELAY_URL = relayUrl;
    // The relay back, as Edit hears it once it answers again.
    outages.forgetForTests();
    localFirst.CLOUD_WAIT_MS.value = wait;
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("the stretches add up to the source's own frames, whatever its rate and length", () => {
  for (const [duration, fps] of [[7200, 24000 / 1001], [3601.5, 30000 / 1001], [8, 30], [125.3, 60], [59.99, 25]] as const) {
    const total = localFirst.stretchesOf(duration);
    let frames = 0;
    let last = 0;
    for (let n = 0; n < total; n++) {
      const [first, end] = localFirst.stretchFrames({ duration, fps }, n);
      expect(first).toBe(last);
      expect(end).toBeGreaterThan(first);
      frames += end - first;
      last = end;
    }
    expect(frames).toBe(Math.round(duration * localFirst.workingFps(fps)));
  }
});

test("every reader reads a plain file here: the agent's looks, the page's player, removal and analysis, before the working copy is made and after", async () => {
  const fixture = home("local-first-readers");
  const run = localFirst.hooks.run;
  let letMake!: () => void;
  const makeGate = new Promise<void>((resolve) => (letMake = resolve));
  localFirst.hooks.run = async (command, signal) => {
    await makeGate;
    return run(command, signal);
  };
  try {
    const cache = fixture.store.cacheDir();
    const { project, original, working } = await imported(fixture, "readersTst1", farApart, false);
    const media = project.media[0]!;
    const check = async (expected: string) => {
      // The agent's looks.
      expect(fs.readFileSync(localPreviews.pathOf(cache, media))).toEqual(fs.readFileSync(expected));
      expect(fs.readFileSync(localPreviews.localized(cache, project)!.media[0]!.path)).toEqual(fs.readFileSync(expected));
      // The page's player, through this server.
      const served = await cloudMedia.streamFromCloud(new Request(media.path), media.cloud, "proxy");
      expect(Buffer.from(await served!.arrayBuffer())).toEqual(fs.readFileSync(expected));
      // Removal and analysis read the original itself.
      expect(await cloudMedia.originalInput(cache, media)).toBe(original);
    };
    await check(original);
    letMake();
    await until(() => !localFirst.isStandIn(working, original));
    await check(working);
    // Nothing was read from the cloud (the working copy then goes up behind, as any does).
    expect(mock.calls("/v1/cloud/r2/url").filter((one) => JSON.stringify(one.json()).includes("readersTst1") && (one.json() as { method?: string }).method !== "PUT")).toEqual([]);
    await until(() => footageUp().length === 1 && jobs.list(fixture.home, "upload").length === 0);
  } finally {
    letMake();
    localFirst.hooks.run = run;
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

// Nov 25, the reviews of turning local-first on: the local path brought a Drive file down whole before the answer and
// sent it all back up (a 6 GB file on JJ's line: about 100 min, then about 6.7 h), where the relay copies it without the
// Mac and the edit's stretches are cut by range. Only footage whose whole original comes here anyway takes it.
test("a Drive file on a new channel project keeps today's path: the relay's copy, cut by range, nothing brought here whole", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-drive", { services: { scripts } });
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const asked: string[] = [];
  const original = spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => {
    asked.push(file);
    return { file, source: `drive:${file}`, key: `edit/originals/drive/${file}/Bodycam 1.mp4`, name: "Bodycam 1.mp4", size: 100 };
  });
  const excerpts = spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache, one) => {
    const proxy = `edit/proxies/drive/${one.file}.mp4`;
    const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
    return [{ path, from: 0, to: SECONDS, cloud: { path, name: one.name, probe: PROBE, cloud: { source: one.source, original: one.key, proxy, size: 100 } } }];
  });
  try {
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "footage", file: "1LocalDriveFile01", url: "https://drive.google.com/file/d/1LocalDriveFile01/view", start: 2, end: 4, label: "00:02–00:04" }] };
    });
    await start(fixture.app, id, false);
    const project = fixture.store.get(id)!.project;
    expect(scripts.get(id)!.state).toBe("done");
    expect(project.local_media).toBe(true);
    expect(asked).toEqual(["1LocalDriveFile01"]);
    const media = project.media[0]!;
    expect(media.cloud!.proxy).toBe("edit/proxies/drive/1LocalDriveFile01.mp4");
    expect(fs.existsSync(cloudMedia.localPath(fixture.store.cacheDir(), media.cloud!.original))).toBe(false);
  } finally {
    original.mockRestore();
    excerpts.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("a Drive file whose whole copy Script mode keeps here takes the local path from that copy, with nothing downloaded", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-drive-held", { services: { scripts } });
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const asked = spyOn(seams.cloudMedia, "driveOriginal");
  const find = copiesHere.find;
  const held = join(fixture.dir, "held", "Bodycam 1.mp4");
  fs.mkdirSync(join(held, ".."), { recursive: true });
  fs.copyFileSync(close, held);
  let released = 0;
  let leased = 0;
  copiesHere.find = (source) =>
    source === "drive:1LocalDriveFile01" ? (leased++, { copy: { path: held, key: "edit/originals/drive/1LocalDriveFile01/Bodycam 1.mp4", name: "Bodycam 1.mp4", size: fs.statSync(held).size, release: () => void released++ } }) : null;
  try {
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "footage", file: "1LocalDriveFile01", url: "https://drive.google.com/file/d/1LocalDriveFile01/view", start: 2, end: 4, label: "00:02–00:04" }] };
    });
    await start(fixture.app, id, false);
    const project = fixture.store.get(id)!.project;
    expect(scripts.get(id)!.state).toBe("done");
    const media = project.media[0]!;
    expect(media.cloud!.original).toBe("edit/originals/drive/1LocalDriveFile01/Bodycam 1.mp4");
    // Its own working copy (close keyframes): the original itself plays, linked in at its key's place.
    expect(media.cloud!.proxy).toBe(media.cloud!.original);
    expect(fs.readFileSync(cloudMedia.localPath(fixture.store.cacheDir(), media.cloud!.original))).toEqual(fs.readFileSync(close));
    expect(asked).not.toHaveBeenCalled();
    // Held once, let go once: the cleaner never sees it as in use for good (PR #12's review).
    expect([leased, released]).toEqual([1, 1]);
  } finally {
    copiesHere.find = find;
    asked.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("a YouTube download with no room here to keep it whole beside its working copy goes on today's path, downloaded once", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-youtube-short", { services: { scripts } });
  const previous = process.env.EDIT_YTDLP;
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const short = spyOn(storage, "roomFor").mockReturnValue(false);
  const excerpts = spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache, one) => {
    const proxy = `edit/proxies/youtube/${one.file}.mp4`;
    const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
    return [{ path, from: 0, to: SECONDS, cloud: { path, name: one.name, probe: PROBE, cloud: { source: one.source, original: one.key, proxy, size: 100 } } }];
  });
  try {
    process.env.EDIT_YTDLP = fakeYtDlp(fixture.dir, farApart);
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "footage", file: "youtube:shortroom01", url: "https://youtu.be/shortroom01", start: 1, end: 3, label: "00:01–00:03" }] };
    });
    await start(fixture.app, id, false);
    const project = fixture.store.get(id)!.project;
    expect(scripts.get(id)!.state).toBe("done");
    expect(project.media.length).toBeGreaterThan(0);
    for (const media of project.media) expect(localFirst.isWorkingKey(media.cloud?.proxy)).toBe(false);
    // Today's path: the original went up before the answer and its copy here went.
    expect(mock.cloud.objects.has("edit/originals/youtube/shortroom01/far.mp4")).toBe(true);
    expect(fs.existsSync(cloudMedia.localPath(fixture.store.cacheDir(), "edit/originals/youtube/shortroom01/far.mp4"))).toBe(false);
    expect(fs.readFileSync(join(fixture.dir, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    short.mockRestore();
    excerpts.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    if (previous === undefined) delete process.env.EDIT_YTDLP;
    else process.env.EDIT_YTDLP = previous;
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("a YouTube video Script mode has here, or one already on its way up from somewhere, keeps today's path: nothing downloaded", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-youtube-elsewhere", { services: { scripts } });
  const previous = process.env.EDIT_YTDLP;
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const asked: string[] = [];
  const original = spyOn(seams.cloudMedia, "youtubeOriginal").mockImplementation(async (_home, file) => {
    asked.push(file);
    return [{ file, source: file, key: `edit/originals/youtube/${youtube(file)}/clip.mp4`, name: "clip.mp4", size: 100 }, null];
  });
  const excerpts = spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache, one) => {
    const proxy = `edit/proxies/youtube/${youtube(one.file)}.mp4`;
    const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
    return [{ path, from: 0, to: SECONDS, cloud: { path, name: one.name, probe: PROBE, cloud: { source: one.source, original: one.key, proxy, size: 100 } } }];
  });
  const find = copiesHere.find;
  let released = 0;
  copiesHere.find = (source) => (source === "youtube:heldScript1" ? { copy: { path: farApart, key: "edit/originals/youtube/heldScript1/far.mp4", name: "far.mp4", size: 1, release: () => void released++ } } : null);
  try {
    process.env.EDIT_YTDLP = fakeYtDlp(fixture.dir, farApart);
    // Another computer's import has it on its way up: in the registry, not ready.
    mock.cloud.convex.media.set("youtube:goingUpElse", { source: "youtube:goingUpElse", name: "clip.mp4", originalKey: "edit/originals/youtube/goingUpElse/clip.mp4", originalReady: false, size: 100 } as never);
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = {
        blocks: [
          { kind: "footage", file: "youtube:heldScript1", url: "https://youtu.be/heldScript1", start: 1, end: 3, label: "00:01–00:03" },
          { kind: "footage", file: "youtube:goingUpElse", url: "https://youtu.be/goingUpElse", start: 1, end: 3, label: "00:01–00:03" },
        ],
      };
    });
    await start(fixture.app, id, false);
    expect(scripts.get(id)!.state).toBe("done");
    // Script mode's copy is cut from as it is; the one on its way up is waited for or taken from the cloud.
    expect(asked).toEqual(["youtube:goingUpElse"]);
    for (const media of fixture.store.get(id)!.project.media) expect(localFirst.isWorkingKey(media.cloud?.proxy)).toBe(false);
    expect(fs.existsSync(join(fixture.dir, "calls"))).toBe(false);
    // Each hold on Script mode's copy let go (the local path's look, and today's path's cut from it).
    expect(released).toBe(2);
  } finally {
    copiesHere.find = find;
    original.mockRestore();
    excerpts.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    if (previous === undefined) delete process.env.EDIT_YTDLP;
    else process.env.EDIT_YTDLP = previous;
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("a no-room fallback leaves nothing of the download behind, even when today's path finds the original up meanwhile", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-youtube-short-race", { services: { scripts } });
  const previous = process.env.EDIT_YTDLP;
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const short = spyOn(storage, "roomFor").mockReturnValue(false);
  // Another computer's upload landed between the looks: today's path takes the cloud's and leaves the download alone.
  const original = spyOn(seams.cloudMedia, "youtubeOriginal").mockImplementation(async (_home, file) => [{ file, source: file, key: "edit/originals/youtube/shortRace01/far.mp4", name: "far.mp4", size: 100 }, null]);
  const excerpts = spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache, one) => {
    const proxy = "edit/proxies/youtube/shortRace01.mp4";
    const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
    return [{ path, from: 0, to: SECONDS, cloud: { path, name: one.name, probe: PROBE, cloud: { source: one.source, original: one.key, proxy, size: 100 } } }];
  });
  try {
    process.env.EDIT_YTDLP = fakeYtDlp(fixture.dir, farApart);
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "footage", file: "youtube:shortRace01", url: "https://youtu.be/shortRace01", start: 1, end: 3, label: "00:01–00:03" }] };
    });
    await start(fixture.app, id, false);
    expect(scripts.get(id)!.state).toBe("done");
    expect(fs.existsSync(join(seams.cloudMedia.scratchDir(fixture.store.cacheDir()), "youtube-shortRace01"))).toBe(false);
  } finally {
    short.mockRestore();
    original.mockRestore();
    excerpts.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    if (previous === undefined) delete process.env.EDIT_YTDLP;
    else process.env.EDIT_YTDLP = previous;
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("an original counts as up once it lands, though its proxy's upload fails after it; and what the job table has going up counts as not up at a start", async () => {
  const fixture = home("local-first-up-boundary");
  const realUpload = cloud.uploadFile;
  const uploads = spyOn(cloud, "uploadFile").mockImplementation(async (...args: Parameters<typeof cloud.uploadFile>) => {
    if (args[1].startsWith("edit/proxies/")) throw new Error("the line dropped");
    return realUpload(...args);
  });
  const key = "edit/originals/sha256/boundary/clip.mp4";
  try {
    const file = join(fixture.dir, "clip.mp4");
    fs.copyFileSync(close, file);
    const proxy = join(fixture.dir, "proxy.mp4");
    fs.copyFileSync(close, proxy);
    cloudMedia.uploadLater(fixture.home, { file, source: "sha256:boundary", size: fs.statSync(file).size, duration: SECONDS, originalKey: key, uploadOriginal: true, proxy: "edit/proxies/sha256/boundary.mp4", local: proxy, name: "clip.mp4" });
    expect(cloud.notUp(key)).toBe(true);
    expect(await cloudMedia.uploaded(file)).toBe(false);
    expect(cloud.notUp(key)).toBe(false);
    // Its row, put off for the proxy, says the original is up: a start doesn't count it as not up again.
    cloudMedia.noteOriginalsGoingUp(fixture.home);
    expect(cloud.notUp(key)).toBe(false);
    // Its row put off for later: a start notes its original as not up until it's sent again.
    const later = "edit/originals/sha256/putoff/clip.mp4";
    const row = jobs.begin(fixture.home, "upload", "-", { file, source: "sha256:putoff", size: 1, duration: 1, originalKey: later, uploadOriginal: true, proxy: null, local: null }, "sha256:putoff");
    jobs.putOff(fixture.home, row, "offline");
    expect(cloud.notUp(later)).toBe(false);
    cloudMedia.noteOriginalsGoingUp(fixture.home);
    expect(cloud.notUp(later)).toBe(true);
    cloud.upEnded(later, false);
  } finally {
    uploads.mockRestore();
    fixture.cleanup();
  }
}, 60_000);

test("a Drive file whose Script mode download fails while the import waits for it keeps today's path, never brought down whole", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-drive-landing-fails", { services: { scripts } });
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const asked: string[] = [];
  const original = spyOn(seams.cloudMedia, "driveOriginal").mockImplementation(async (file: string) => {
    asked.push(file);
    return { file, source: `drive:${file}`, key: `edit/originals/drive/${file}/Bodycam 1.mp4`, name: "Bodycam 1.mp4", size: 100 };
  });
  const excerpts = spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache, one) => {
    const proxy = `edit/proxies/drive/${one.file}.mp4`;
    const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
    return [{ path, from: 0, to: SECONDS, cloud: { path, name: one.name, probe: PROBE, cloud: { source: one.source, original: one.key, proxy, size: 100 } } }];
  });
  const find = copiesHere.find;
  const failed = Promise.reject(new Error("Script mode's download failed"));
  failed.catch(() => {});
  let landing = true;
  copiesHere.find = (source) => (source === "drive:1LandingFails1" && landing ? ((landing = false), { landing: { path: join(fixture.dir, "nothing.mp4"), size: 100, name: "Bodycam 1.mp4", done: failed } }) : null);
  try {
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "footage", file: "1LandingFails1", url: "https://drive.google.com/file/d/1LandingFails1/view", start: 2, end: 4, label: "00:02–00:04" }] };
    });
    await start(fixture.app, id, false);
    expect(scripts.get(id)!.state).toBe("done");
    expect(asked).toEqual(["1LandingFails1"]);
    const media = fixture.store.get(id)!.project.media[0]!;
    expect(localFirst.isWorkingKey(media.cloud?.proxy)).toBe(false);
    expect(fs.existsSync(cloudMedia.localPath(fixture.store.cacheDir(), media.cloud!.original))).toBe(false);
  } finally {
    copiesHere.find = find;
    original.mockRestore();
    excerpts.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

test("an upload whose file is gone when it's started again after a restart is no longer waited for, and stays refused to RunPod", () => {
  const fixture = home("local-first-resume-gone");
  const key = "edit/originals/sha256/resumegone/clip.mp4";
  try {
    cloud.goingUp(key);
    cloud.waitFor(key, "p1", "gone.mp4");
    expect(() => cloudMedia.resumeUpload(fixture.home, { file: join(fixture.dir, "gone.mp4"), source: "sha256:resumegone", size: 1, duration: 1, originalKey: key, uploadOriginal: true, proxy: null, local: null })).toThrow("is gone");
    expect(cloud.waitedFor("p1")).toEqual([]);
    // R2 never got it: RunPod isn't sent its key.
    expect(cloud.notUp(key)).toBe(true);
  } finally {
    cloud.upEnded(key, false);
    fixture.cleanup();
  }
});

test("a Script mode copy on another disk (no link into the cache) goes on today's path, cut from it under its hold", async () => {
  const scripts = new Jobs();
  const fixture = home("local-first-drive-held-other-disk", { services: { scripts } });
  const enabled = spyOn(relay, "cloudEnabled").mockReturnValue(true);
  const researched = spyOn(seams.research, "articles").mockReturnValue([]);
  const inputs: (string | null | undefined)[] = [];
  const excerpts = spyOn(seams.cloudMedia, "driveExcerpts").mockImplementation(async (_cache, one, _ranges, input) => {
    inputs.push(input);
    const proxy = `edit/proxies/drive/${one.file}.mp4`;
    const path = `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(proxy)}`;
    return [{ path, from: 0, to: SECONDS, cloud: { path, name: one.name, probe: PROBE, cloud: { source: one.source, original: one.key, proxy, size: 100 } } }];
  });
  const find = copiesHere.find;
  const held = join(fixture.dir, "held", "Bodycam 1.mp4");
  fs.mkdirSync(join(fixture.dir, "held"), { recursive: true });
  fs.copyFileSync(close, held);
  let leased = 0;
  let released = 0;
  copiesHere.find = (source) =>
    source === "drive:1OtherDisk001" ? (leased++, { copy: { path: held, key: "edit/originals/drive/1OtherDisk001/Bodycam 1.mp4", name: "Bodycam 1.mp4", size: fs.statSync(held).size, release: () => void released++ } }) : null;
  const link = spyOn(fs, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
  });
  try {
    const id = channelProject(fixture);
    await fixture.store.update(id, "test", (project) => {
      project.script = { blocks: [{ kind: "footage", file: "1OtherDisk001", url: "https://drive.google.com/file/d/1OtherDisk001/view", start: 2, end: 4, label: "00:02–00:04" }] };
    });
    await start(fixture.app, id, false);
    expect(scripts.get(id)!.state).toBe("done");
    const media = fixture.store.get(id)!.project.media[0]!;
    expect(localFirst.isWorkingKey(media.cloud?.proxy)).toBe(false);
    expect(inputs).toEqual([held]);
    expect(leased).toBe(released);
  } finally {
    link.mockRestore();
    copiesHere.find = find;
    excerpts.mockRestore();
    enabled.mockRestore();
    researched.mockRestore();
    localFirst.reset();
    fixture.cleanup();
  }
}, 60_000);

// Nov 25, the M1 Air's trial of PR #12: a 90 MB YouTube original made a 168 MB working copy (its picture at 1.8 Mbit/s
// over a source spending under 1), and at 2 Mbit/s up it took twice the original's 6 minutes to send.
test("a working copy spends no more than its original (but for the floor a very thin source gets): a thin source's copy is made at the source's own rate", () => {
  const minutes = (n: number) => n * 60;
  // The trial's: 90 MB over 16 minutes is about 0.75 Mbit/s, so the copy's picture is about 0.62 (its sound taken off).
  const thin = localFirst.workingRate(90e6, minutes(16));
  expect(thin).toBeLessThan(700_000);
  expect(thin).toBeGreaterThan(550_000);
  // A 383 MB original over the same length spends 3.2 Mbit/s: the copy keeps its 1.8.
  expect(localFirst.workingRate(383e6, minutes(16))).toBe(localFirst.WORKING.bitrate);
  // A length that can't be read, or a source thinner than any copy should be: never under the least.
  expect(localFirst.workingRate(1e6, 0)).toBe(localFirst.WORKING.bitrate);
  expect(localFirst.workingRate(1e6, minutes(60))).toBe(localFirst.WORKING.least_bitrate);
  // And it's what the encode is told.
  const command = localFirst.stretchCommand("in.mp4", PROBE, 0, "out.mp4", thin);
  expect(command[command.indexOf("-b:v") + 1]).toBe(`${Math.round(thin / 1000)}k`);
});
