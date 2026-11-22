// Room on a local-first home (local_first_room.ts, cache_cleanup.ts): short of room, a local-first project gives up
// its footage in its own order (whole originals R2 holds, keeping their used stretches; working copies off the
// timeline; on it; the stretches last), idle projects before projects in work; nothing R2 hasn't confirmed and no
// stand-in ever goes; and an export of a project whose original went reads the stretches kept here, fetching only what
// neither has, said plainly.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";
import { join } from "node:path";

import { cleanCache } from "../src/cache_cleanup.ts";
import * as cloud from "../src/cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import * as localRoom from "../src/local_first_room.ts";
import type { Project } from "../src/model.ts";
import { forget, markOpened } from "../src/opened.ts";
import { CACHE_FLOOR_BYTES } from "../src/storage.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome, scratch, type Fixture } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const GB = 1e9;
const DAY = 24 * 3600 * 1000;

let mock: MockServer;
let restore: () => void;
let clips: { dir: string; cleanup(): void };
/** 70 s of tiny footage with sound, keyframes 5 s apart. */
let tape: string;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
  clips = scratch("local-first-room-clips");
  tape = join(clips.dir, "tape.mp4");
  const made = Bun.spawnSync([
    tools.ffmpeg(), "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=70",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=70",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "150", "-keyint_min", "150", "-sc_threshold", "0",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", tape,
  ]);
  if (made.exitCode !== 0) throw new Error(`ffmpeg: ${made.stderr.toString()}`);
}, 60_000);

afterAll(() => {
  clips.cleanup();
  restore();
  mock.stop();
});

/** A file of `bytes` (sparse: nothing written), last written weeks ago. */
function put(path: string, bytes: number): string {
  fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  fs.writeFileSync(path, "");
  fs.truncateSync(path, bytes);
  const old = (Date.now() - 20 * DAY) / 1000;
  fs.utimesSync(path, old, old);
  return path;
}

/** A local-first project with two YouTube sources: `s1` on its timeline (a minute of it from 10 s), `s2` off it. */
async function localProject(fixture: Fixture, name: string, workedAgo: number): Promise<{ id: string; project: Project }> {
  const live = fixture.store.create(name, { width: 1280, height: 720, fps: 30 });
  const project = structuredClone(live.project) as Project;
  project.local_media = true;
  project.media = ["s1", "s2"].map((one) => {
    const video = `${name}${one}`.padEnd(11, "x");
    return {
      id: one, name: `${one}.mp4`, path: `/nowhere/${name}-${one}.mp4`, kind: "video" as const, duration: 600, width: 1280, height: 720, fps: 30, has_audio: true,
      cloud: { source: `youtube:${video}`, original: `edit/originals/youtube/${video}/${one}.mp4`, proxy: `edit/proxies/v720/youtube/${video}.mp4`, size: 1 },
    };
  });
  project.clips = [{ id: "c1", track: "v1", start: 0, duration: 60 * 30, type: "video", media: "s1", source_in: 10, speed: 1 } as Project["clips"][number]];
  await fixture.store.replace(project.id, null, project, "test");
  markOpened(fixture.store.home, project.id, Date.now() - workedAgo);
  const at = (Date.now() - workedAgo) / 1000;
  fs.utimesSync(`${fixture.store.home}/projects/${project.id}.json`, at, at);
  return { id: project.id, project };
}

test("short of room, local-first footage goes in its order, idle projects first; nothing R2 hasn't confirmed, no stand-in, and a project in work keeps its timeline's footage until the disk is truly out", async () => {
  const fixture = fixtureHome("local-first-room-order");
  try {
    const cache = fixture.store.cacheDir();
    // A 10 GB disk's three projects: two idle (worked on 5 and 4 days ago), one in work (yesterday).
    const projects = { old: await localProject(fixture, "old", 5 * DAY), newer: await localProject(fixture, "newer", 4 * DAY), work: await localProject(fixture, "work", 1 * DAY) };
    const files: Record<string, Record<string, string>> = {};
    const confirmed = new Set<string>();
    for (const [name, { project }] of Object.entries(projects)) {
      const [s1, s2] = localRoom.footageOf(project);
      const one = localRoom.paths(cache, s1!);
      const two = localRoom.paths(cache, s2!);
      expect(one.cells.length).toBe(3);
      files[name] = {
        original1: put(one.original, 1.5 * GB),
        copy1: put(one.copy!, 0.4 * GB),
        ...Object.fromEntries(one.cells.map((cell, n) => [`cell${n}`, put(cell, 0.05 * GB)])),
        sound1: put(one.sound!, 0.01 * GB),
        original2: put(two.original, 1.5 * GB),
        copy2: two.copy!,
      };
      // The newer idle project's second source has no working copy made yet: the original stands in at its place.
      if (name === "newer") fs.linkSync(two.original, two.copy!);
      else put(two.copy!, 0.4 * GB);
      for (const key of ["original1", "original2"]) confirmed.add(files[name]![key]!);
    }
    // R2 hasn't said it holds the older project's second original.
    confirmed.delete(files.old!.original2!);
    const here = (name: string) => Object.fromEntries(Object.entries(files[name]!).map(([key, path]) => [key, fs.existsSync(path)]));
    const all = (name: string, but: string[] = []) => Object.fromEntries(Object.keys(files[name]!).map((key) => [key, !but.includes(key)]));
    const cells = ["cell0", "cell1", "cell2", "sound1"];
    const ask = (short: number, free = 5 * GB) => cleanCache(fixture.app, false, Date.now(), { freeBytes: free + short, free, confirmed });
    // Room enough: nothing goes.
    expect(ask(-1).files).toBe(0);
    // 2 GB short: whole originals R2 holds, the oldest idle project's first; its unconfirmed one stays.
    let report = ask(2 * GB);
    expect(report.bytes).toBe(3 * GB);
    expect(here("old")).toEqual(all("old", ["original1"]));
    expect(here("newer")).toEqual(all("newer", ["original1"]));
    expect(here("work")).toEqual(all("work"));
    // 3.5 GB short of what's left: the stand-in's original is skipped, then the project in work's originals (its
    // timeline's stretches are kept); then working copies of footage off the timeline.
    report = ask(3.5 * GB);
    expect(report.bytes).toBe(3.8 * GB);
    expect(here("work")).toEqual(all("work", ["original1", "original2", "copy2"]));
    expect(here("old")).toEqual(all("old", ["original1", "copy2"]));
    expect(here("newer")).toEqual(all("newer", ["original1"]));
    // However short, over the hard floor: idle projects' working copies on the timeline, then their stretches; the
    // project in work keeps its own, and the unconfirmed original and the stand-in stay.
    report = ask(9 * GB);
    expect(report.bytes).toBeCloseTo(2 * (0.4 + 0.16) * GB, -3);
    expect(here("old")).toEqual(all("old", ["original1", "copy1", "copy2", ...cells]));
    expect(here("newer")).toEqual(all("newer", ["original1", "copy1", ...cells]));
    expect(here("work")).toEqual(all("work", ["original1", "original2", "copy2"]));
    // The disk truly out: the project in work gives its timeline's working copy, then its stretches.
    report = ask(1 * GB, CACHE_FLOOR_BYTES / 2);
    expect(here("work")).toEqual(all("work", ["original1", "original2", "copy1", "copy2", ...cells]));
    // Never: an original R2 hasn't confirmed, nor a stand-in (it and its original are one file).
    report = ask(100 * GB, 0);
    expect([fs.existsSync(files.old!.original2!), fs.existsSync(files.newer!.original2!), fs.existsSync(files.newer!.copy2!)]).toEqual([true, true, true]);
  } finally {
    forget(fixture.store.home);
    fixture.cleanup();
  }
}, 60_000);

test("an original's used stretches are cut from it here before it may go, follow the timeline, and an export then reads them, fetching only what's missing and saying so", async () => {
  const fixture = fixtureHome("local-first-room-export");
  try {
    const cache = fixture.store.cacheDir();
    cloudMedia.configurePlayback(fixture.app);
    const video = "roomExport1";
    const original = `edit/originals/youtube/${video}/tape.mp4`;
    const live = fixture.store.create("room", { width: 1280, height: 720, fps: 30 });
    const project = structuredClone(live.project) as Project;
    project.local_media = true;
    project.media = [{ id: "m1", name: "tape.mp4", path: `/nowhere/tape.mp4`, kind: "video", duration: 70, width: 160, height: 90, fps: 30, has_audio: true,
      cloud: { source: `youtube:${video}`, original, proxy: `edit/proxies/v720/youtube/${video}.mp4`, size: fs.statSync(tape).size } }];
    // The timeline shows 12–28 s: the first cell (0–30 s) only.
    project.clips = [{ id: "c1", track: "v1", start: 0, duration: 16 * 30, type: "video", media: "m1", source_in: 12, speed: 1 } as Project["clips"][number]];
    await fixture.store.replace(project.id, null, project, "test");
    const at = localRoom.paths(cache, localRoom.footageOf(project)[0]!);
    fs.mkdirSync(join(at.original, ".."), { recursive: true });
    fs.copyFileSync(tape, at.original);
    cloudMedia.rememberLocalOriginal(cache, original, at.original);
    mock.cloud.put(original, fs.readFileSync(tape));
    // Its working copy not made yet (the original stands in): nothing is cut, it can't go anyway.
    fs.mkdirSync(join(at.copy!, ".."), { recursive: true });
    fs.linkSync(at.original, at.copy!);
    expect(await localRoom.keep(fixture.app, () => true)).toBe(0);
    fs.rmSync(at.copy!);
    fs.copyFileSync(tape, at.copy!);
    // R2 not sure of it: nothing is cut either.
    expect(await localRoom.keep(fixture.app, () => false)).toBe(0);
    // R2 holds it: its stretch is cut here from the original, with its sound, and nothing read from the cloud.
    const reads = () => mock.calls(/^\/r2\//, "GET").filter((one) => one.path.includes(video)).length;
    expect(await localRoom.keep(fixture.app, () => true)).toBe(1);
    expect(at.cells.map((cell) => fs.existsSync(cell))).toEqual([true]);
    expect(fs.existsSync(at.sound!)).toBe(true);
    expect(reads()).toBe(0);
    // The clip moves to 40–55 s while the original's here: that stretch is cut from it too.
    await fixture.store.update(project.id, "test", (one) => {
      const first = one.clips[0];
      if (first?.type === "video") first.source_in = 40;
    });
    const moved = localRoom.paths(cache, localRoom.footageOf(fixture.store.get(project.id)!.project)[0]!);
    expect(localRoom.stretchesHere(cache, localRoom.footageOf(fixture.store.get(project.id)!.project)[0]!)).toBe(false);
    expect(await localRoom.keep(fixture.app, () => true)).toBe(1);
    expect(moved.cells.every((cell) => fs.existsSync(cell))).toBe(true);
    expect(reads()).toBe(0);
    // Short of room, R2 holding it: the original goes (its stretches are kept), the copy and the stretches stay.
    for (const path of [at.original, at.copy!]) fs.utimesSync(path, (Date.now() - 20 * DAY) / 1000, (Date.now() - 20 * DAY) / 1000);
    cleanCache(fixture.app, false, Date.now(), { freeBytes: 6 * GB, free: 5 * GB, confirmed: new Set([at.original]) });
    expect([fs.existsSync(at.original), fs.existsSync(at.copy!), ...moved.cells.map((cell) => fs.existsSync(cell))]).toEqual([false, true, true]);
    expect(cloudMedia.localOriginal(cache, original)).toBeNull();
    // The export reads its stretch here: nothing of the original fetched, nothing said of fetching.
    const phases: string[] = [];
    const [out, held] = await cloudMedia.forExport(fixture.store.get(project.id)!.project, 0, 15 * 30, cache, () => false, (phase) => phases.push(phase));
    held.release();
    expect(out.media[0]!.path.startsWith("http")).toBe(true);
    expect(reads()).toBe(0);
    expect(phases.some((phase) => phase.includes("from the cloud"))).toBe(false);
    // A clip added past what's kept (the original gone): fetched for the export, and the card says it in those words.
    await fixture.store.update(project.id, "test", (one) => {
      one.clips.push({ id: "c2", track: "v1", start: 16 * 30, duration: 5 * 30, type: "video", media: "m1", source_in: 62, speed: 1 } as Project["clips"][number]);
    });
    const [, again] = await cloudMedia.forExport(fixture.store.get(project.id)!.project, 0, 21 * 30, cache, () => false, (phase) => phases.push(phase));
    again.release();
    expect(reads()).toBeGreaterThan(0);
    expect(phases.some((phase) => phase.startsWith("fetching footage this computer no longer has from the cloud"))).toBe(true);
  } finally {
    fixture.cleanup();
  }
}, 120_000);
