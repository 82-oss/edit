// A file from this Mac's disk answers its import in seconds whatever its length (Nov 21, a MacBook Air in the real
// window: three files of about 14.6 minutes kept the file browser busy 2 min 14 s to 2 min 23 s each while their whole
// proxy was made before the import answered; a 20.75-minute one answered in 13.6 s with a pieced proxy). A short file
// now takes the long file's path: its first piece made beside the hash, the rest behind the answer in a row of the
// job table that a restart carries on.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";
import { join } from "node:path";

import * as cloud from "../src/cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { playbackPath } from "../src/cloud_playback.ts";
import type { Probe } from "../src/model.ts";
import { useNative, wrap } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import * as pieces from "../src/proxy_pieces.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token", EDIT_CLOUD_HOLDER: undefined });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

/** How long the stand-in proxy maker takes: far past what a first piece of a small file takes, even on CI's slow Mac. */
const STAND_IN_MS = 12_000;

type Row = { key: string; kind: string; step?: string; state: string; args: Record<string, unknown> };
const rows = (fixture: Fixture): Row[] => {
  try {
    return JSON.parse(fs.readFileSync(join(fixture.home, "jobs.json"), "utf8")) as Row[];
  } catch {
    return [];
  }
};

/** A real video of `seconds` (picture and a tone), small enough to make in a second or two. */
function footage(dir: string, name: string, seconds: number, hz: number): string {
  const file = join(dir, name);
  const made = Bun.spawnSync([
    "ffmpeg", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=320x180:rate=30:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", file,
  ]);
  expect(made.exitCode).toBe(0);
  return file;
}

/** A fixture whose whole-proxy maker is the slow stand-in, noting when it ends in `order`. */
function slowHome(name: string, order: string[]): Fixture & { proxies: string[] } {
  const fixture = fixtureHome(name);
  const raw = createStub();
  raw.init({ home: fixture.home, cacheDir: `${fixture.home}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", log: () => {} });
  const proxies: string[] = [];
  raw.makeCloudProxy = async (source: string, _probe: Probe, out: string) => {
    proxies.push(source);
    await Bun.sleep(STAND_IN_MS);
    fs.copyFileSync(source, out);
    order.push("proxy made");
  };
  useNative(wrap(raw));
  // No export runs here (the pieces behind an import wait while one does).
  Object.assign(fixture.app.exports, { localRunning: () => false });
  cloudMedia.configurePlayback(fixture.app);
  return { ...fixture, proxies };
}

/** Waits until `done()` holds, at most `ms`. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const began = Date.now();
  while (!done()) {
    if (Date.now() - began > ms) return false;
    await Bun.sleep(100);
  }
  return true;
}

test("a short file from this Mac answers before its proxy is made, then gets every piece made and put in the cloud, carried on after a restart", async () => {
  const order: string[] = [];
  const fixture = slowHome("short-import", order);
  // Each piece behind the answer is as slow as the stand-in: what's made after the answer is never waited on by it.
  const fill = cloudMedia.fillHooks.fill;
  cloudMedia.fillHooks.fill = async (context, wants, stop) => {
    await Bun.sleep(STAND_IN_MS / 4);
    const made = await fill(context, wants, stop);
    order.push("piece made");
    return made;
  };
  try {
    const cache = fixture.store.cacheDir();
    // 150 s: three one-minute pieces, far under the 20 minutes from which a file was pieced before.
    const video = footage(fixture.dir, "short.mp4", 150, 440);
    const probe: Probe = { kind: "video", duration: 150, width: 320, height: 180, fps: 30, has_audio: true };
    const made = await cloudMedia.importLocal(cache, video, probe, "short.mp4");
    order.push("answered");
    // The import answered before any proxy was made (before the change: after the stand-in's 12 s whole proxy).
    expect(order[0]).toBe("answered");
    expect(fixture.proxies).toEqual([]);
    const source = made.cloud!.source;
    const proxy = pieces.proxyKeyOf(source);
    expect(made.cloud!.proxy).toBe(proxy);
    expect(made.path).toBe(playbackPath(proxy, fixture.app.port));
    // Playable now: its layout, head and first piece are here and in the cloud.
    const base = pieces.baseKey(source);
    const here = (key: string) => fs.existsSync(cloudMedia.localPath(cache, key));
    expect(here(`${base}/layout.json`) && here(`${base}/head.mp4`) && here(`${base}/video/0.m4s`) && here(`${base}/audio/0.m4s`)).toBe(true);
    expect(mock.cloud.objects.has(`${base}/layout.json`) && mock.cloud.objects.has(`${base}/head.mp4`)).toBe(true);
    // The rest are being made behind the answer, in a row that says so.
    const row = () => rows(fixture).find((one) => one.kind === "upload" && one.key.endsWith("#pieces"));
    expect(row()?.step).toBe("making its pieces");
    const args = { ...row()!.args };

    // Then every piece is here and in the cloud, and the row is crossed off.
    expect(await until(() => row() === undefined, 120_000)).toBe(true);
    const all = [0, 1, 2].flatMap((n) => [`${base}/video/${n}.m4s`, `${base}/audio/${n}.m4s`]);
    expect(all.filter((key) => !here(key))).toEqual([]);
    expect(await until(() => all.every((key) => mock.cloud.objects.has(key)), 30_000)).toBe(true);
    // The original went up behind it as before.
    expect(await cloudMedia.uploaded(video)).toBe(true);
    expect(mock.cloud.objects.has(made.cloud!.original)).toBe(true);
    expect(fixture.proxies).toEqual([]);

    // A restart part-way (its last piece not made yet): the row's resumer makes what's missing.
    fs.rmSync(cloudMedia.localPath(cache, `${base}/video/2.m4s`));
    fs.rmSync(cloudMedia.localPath(cache, `${base}/audio/2.m4s`));
    mock.cloud.objects.delete(`${base}/video/2.m4s`);
    mock.cloud.objects.delete(`${base}/audio/2.m4s`);
    cloudMedia.resumeUpload(fixture.home, args);
    expect(row()?.step).toBe("making its pieces");
    expect(await until(() => row() === undefined, 120_000)).toBe(true);
    expect(all.filter((key) => !here(key))).toEqual([]);
  } finally {
    cloudMedia.fillHooks.fill = fill;
    fixture.cleanup();
  }
}, 300_000);

test("a long file from this Mac answers with its pieced proxy as before, its pieces left to the viewer", async () => {
  const order: string[] = [];
  const fixture = slowHome("long-import", order);
  try {
    const cache = fixture.store.cacheDir();
    // A 20-second file probed as 25 minutes: only its first piece is made before the answer.
    const video = footage(fixture.dir, "long.mp4", 20, 660);
    const probe: Probe = { kind: "video", duration: 1500, width: 320, height: 180, fps: 30, has_audio: true };
    const made = await cloudMedia.importLocal(cache, video, probe, "long.mp4");
    order.push("answered");
    expect(order).toEqual(["answered"]);
    expect(fixture.proxies).toEqual([]);
    expect(made.cloud!.proxy).toBe(pieces.proxyKeyOf(made.cloud!.source));
    const base = pieces.baseKey(made.cloud!.source);
    expect(fs.existsSync(cloudMedia.localPath(cache, `${base}/video/0.m4s`))).toBe(true);
    expect(fs.existsSync(cloudMedia.localPath(cache, `${base}/video/1.m4s`))).toBe(false);
    // Only the original's upload is noted: no row makes all 25 of its pieces.
    expect(rows(fixture).filter((one) => one.kind === "upload").map((one) => one.key.endsWith("#pieces"))).toEqual([false]);
    expect(await cloudMedia.uploaded(video)).toBe(true);
    // Its first piece is shared as before.
    expect(await until(() => mock.cloud.objects.has(`${base}/video/0.m4s`), 30_000)).toBe(true);
  } finally {
    fixture.cleanup();
  }
}, 120_000);

test("a clip under two minutes still has its whole proxy made before the import answers, as it always was", async () => {
  const order: string[] = [];
  const fixture = slowHome("clip-import", order);
  try {
    const cache = fixture.store.cacheDir();
    const video = footage(fixture.dir, "clip.mp4", 20, 550);
    const probe: Probe = { kind: "video", duration: 20, width: 320, height: 180, fps: 30, has_audio: true };
    const made = await cloudMedia.importLocal(cache, video, probe, "clip.mp4");
    order.push("answered");
    // The whole proxy first (the stand-in), then the answer; no pieces, and no row making any.
    expect(order).toEqual(["proxy made", "answered"]);
    expect(made.cloud!.proxy).not.toBe(pieces.proxyKeyOf(made.cloud!.source));
    expect(rows(fixture).some((one) => one.key.endsWith("#pieces"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
}, 120_000);
