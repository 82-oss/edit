import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { BLOCK } from "../src/cloud_blocks.ts";
import { localPath } from "../src/cloud_media.ts";
import * as pieces from "../src/proxy_pieces.ts";
import { keeping, readyStretches } from "../src/playback_ready.ts";
import * as storage from "../src/storage.ts";
import { scratch } from "./helpers/home.ts";
import { media, project as newProject } from "./helpers/model.ts";
import * as vbr from "./helpers/vbr_mp4.ts";

const stream = (key: string) => `http://127.0.0.1:7700/api/cloud/preview?key=${encodeURIComponent(key)}`;
const clip = (id: string, mediaId: string, start: number, duration: number, sourceIn = 0, type = "video") =>
  ({ type, id, track: type === "video" ? "v1" : "a1", media: mediaId, start, duration, source_in: sourceIn, speed: 1 }) as never;

/** Blocks `indices` of a `blocks`-block object `key` kept under `root`, as cloud_blocks.ts keeps them. */
function keep(root: string, key: string, blocks: number, indices: number[]) {
  const folder = path.join(root, createHash("sha1").update(key).digest("hex"));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ size: blocks * BLOCK, type: "video/mp4", key }));
  for (const index of indices) fs.writeFileSync(path.join(folder, `${index}`), "");
}

test("the timeline's ready stretches: a file here or its whole copy throughout, a streamed one where its blocks are, nothing past them (the progress bar's grey, what a play waits for)", async () => {
  const home = scratch("playback-ready");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    const streamed = "edit/proxies/drive/streamed.mp4";
    const whole = "edit/proxies/drive/whole.mp4";
    const unread = "edit/proxies/drive/unread.mp4";
    const project = newProject();
    project.settings.fps = 30;
    project.media.push(
      media({ id: "a", name: "a", path: stream(streamed), kind: "video", duration: 100, cloud: { proxy: streamed } } as never),
      media({ id: "b", name: "b", path: stream(whole), kind: "video", duration: 100, cloud: { proxy: whole } } as never),
      media({ id: "c", name: "c", path: stream(unread), kind: "video", duration: 100, cloud: { proxy: unread } } as never),
    );
    // 100 s in ten blocks, the first three here: its first 30 s, less half a block's worth (5 s) at the run's end.
    keep(root, streamed, 10, [0, 1, 2]);
    fs.mkdirSync(path.dirname(localPath(cache, whole)), { recursive: true });
    fs.writeFileSync(localPath(cache, whole), "mp4");
    project.clips.push(clip("c1", "a", 0, 3000), clip("c2", "b", 3000, 600), clip("c3", "c", 3600, 300));
    expect(await readyStretches(cache, project, root)).toEqual([[0, 750], [3000, 3600]]);
    // A clip further into the streamed file, from 10 s of it: ready to 25 s of the file, 15 s of the clip.
    project.clips.splice(0, 3, clip("c4", "a", 0, 900, 10));
    expect(await readyStretches(cache, project, root)).toEqual([[0, 450]]);
    // Its index (block 0) not here: nothing of it is, whatever else is.
    keep(root, unread, 10, [3, 4]);
    project.clips.splice(0, 1, clip("c5", "c", 0, 300, 35));
    expect(await readyStretches(cache, project, root)).toEqual([]);
    // A hidden track's clip doesn't hold anything up.
    project.tracks.find((track) => track.id === "v1")!.hidden = true;
    expect(await readyStretches(cache, project, root)).toEqual([[0, 300]]);
  } finally {
    home.cleanup();
  }
});

test("the page is told whether what's read is kept here: not at the disk's floor, where a play waiting for its next seconds would wait for nothing (kenobi, Nov 17: 30 s every play)", () => {
  const realFree = storage.diskHooks.free;
  try {
    storage.diskHooks.free = () => storage.WORK_FLOOR_BYTES + 10_000_000;
    expect(keeping("/cache/cloud/blocks")).toBe(false);
    storage.diskHooks.free = () => storage.WORK_FLOOR_BYTES + 2_000_000_000;
    expect(keeping("/cache/cloud/blocks")).toBe(true);
    // Playback not configured: nothing is read into blocks, as before.
    storage.diskHooks.free = () => 0;
    expect(keeping(null)).toBe(true);
  } finally {
    storage.diskHooks.free = realFree;
  }
});

test.skipIf(vbr.ffmpeg === null || vbr.ffprobe === null)("a streamed proxy is ready where every sample, picture and sound, lies in blocks here, by its own index: not an even share of its bytes (kenobi, Nov 17: ready said seconds were here that weren't)", async () => {
  const home = scratch("playback-ready-index");
  const file = vbr.makeVbr();
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    const key = "edit/proxies/drive/vbr.mp4";
    const folder = path.join(root, createHash("sha1").update(key).digest("hex"));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ size: file.bytes.length, type: "video/mp4", key }));
    const last = Math.floor((file.bytes.length - 1) / BLOCK);
    // Its first two blocks of seven: the still's 3 s and the start of the noise; an even share would say about 1.7 s.
    for (const n of [0, 1]) fs.writeFileSync(path.join(folder, `${n}`), file.bytes.subarray(n * BLOCK, (n + 1) * BLOCK));
    const project = newProject();
    project.settings.fps = 30;
    project.media.push(media({ id: "v", name: "v", path: stream(key), kind: "video", duration: 6, cloud: { proxy: key } } as never));
    project.clips.push(clip("c1", "v", 0, 180), clip("c2", "v", 0, 180, 0, "audio"));
    // Up to the first sample of either track that passes block 1, by ffprobe's word.
    const until = Math.min(...[0, 1].map((stream) => file.packets.find((one) => one.stream === stream && one.pos + one.size > 2 * BLOCK)!.pts));
    expect(until).toBeGreaterThan(3);
    const even = (2 * BLOCK / file.bytes.length) * 6 - (BLOCK / 2 / file.bytes.length) * 6;
    expect(until - even).toBeGreaterThan(1);
    expect(await readyStretches(cache, project, root)).toEqual([[0, Math.round(until * 30)]]);
    // Every block here: all of it.
    for (let n = 2; n <= last; n++) fs.writeFileSync(path.join(folder, `${n}`), file.bytes.subarray(n * BLOCK, (n + 1) * BLOCK));
    expect(await readyStretches(cache, project, root)).toEqual([[0, 180]]);
  } finally {
    file.cleanup();
    home.cleanup();
  }
});

// Nov 21 (audit P9): a clip's end in its file was worked out unclamped, and what's here was held to the file's length
// (an index's last span to the media's duration, a pieced proxy's pieces to its picture's frames). A clip at the file's
// end overshot it by a sliver of float (3.3e-7 s on a 29.97 fps file), rounded out to a whole frame not "ready": a play
// near that cut held on its spinner up to 30 s with every byte on the disk.

test("a clip to its file's very end is ready when the whole file is here, its last frame too, whatever the float says", async () => {
  const home = scratch("playback-ready-end");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    const key = "edit/proxies/drive/ntsc-end.mp4";
    const project = newProject();
    project.settings.fps = 30;
    project.settings.ntsc = true;
    // The probe's file: 29.97 fps, 9.976633 s; 299 frames of it end 3.3e-7 s past that.
    project.media.push(media({ id: "n", name: "n", path: stream(key), kind: "video", duration: 9.976633, cloud: { proxy: key } } as never));
    expect((299 * 1001) / 30000 - 9.976633).toBeGreaterThan(0);
    keep(root, key, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    project.clips.push(clip("c1", "n", 0, 299), clip("c2", "n", 0, 299, 0, "audio"));
    expect(await readyStretches(cache, project, root)).toEqual([[0, 299]]);
    // Its last block not here: its end truly isn't, and is said so (the run's end pulled in half a block's worth).
    fs.rmSync(path.join(root, createHash("sha1").update(key).digest("hex"), "9"));
    const ready = await readyStretches(cache, project, root);
    expect(ready.length).toBe(1);
    expect(ready[0]![0]).toBe(0);
    expect(ready[0]![1]).toBeLessThan(299 - 20);
  } finally {
    home.cleanup();
  }
});

test("a clip running a tenth of a second past its file's length (edit_plan allows it) is ready when the file is here", async () => {
  const home = scratch("playback-ready-past");
  try {
    const cache = home.dir;
    const root = path.join(cache, "cloud", "blocks");
    const key = "edit/proxies/drive/past-end.mp4";
    const project = newProject();
    project.settings.fps = 30;
    project.media.push(media({ id: "p", name: "p", path: stream(key), kind: "video", duration: 10, cloud: { proxy: key } } as never));
    keep(root, key, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 303 frames from its start: 10.1 s of a 10 s file, then a clip after it.
    project.clips.push(clip("c1", "p", 0, 303), clip("c2", "p", 303, 150, 2));
    expect(await readyStretches(cache, project, root)).toEqual([[0, 453]]);
    // The first half of the file not here: what the clips need of it is still missing.
    const folder = path.join(root, createHash("sha1").update(key).digest("hex"));
    for (const n of [1, 2, 3, 4]) fs.rmSync(path.join(folder, `${n}`));
    expect(await readyStretches(cache, project, root)).toEqual([[0, 15], [165, 303], [408, 453]]);
  } finally {
    home.cleanup();
  }
});

test("a pieced proxy whose sound outlasts its picture is ready to its sound's end once its last piece is here; a piece not here is still missing", async () => {
  const home = scratch("playback-ready-pieced");
  try {
    const cache = home.dir;
    const source = "hash:sound-outlasts-picture";
    const base = pieces.baseKey(source);
    const key = pieces.proxyKeyOf(source);
    // Two one-minute pieces of picture (3,600 frames at 30 fps, 120 s); its sound runs to 120.4 s.
    const layout: pieces.Layout = {
      v: 1, source, original: "edit/originals/x", duration: 120.4, fps: 30, frames: 3600, perPiece: 1800, pieces: 2,
      width: 320, height: 180, bitrate: 1_000_000, slot: 1 << 20, audio: { frames: 5644, slot: 1 << 16 }, head: 4096, total: 4096 + 2 * ((1 << 20) + (1 << 16)),
    };
    const at = (k: string) => {
      const file = localPath(cache, k);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return file;
    };
    fs.writeFileSync(at(`${base}/layout.json`), JSON.stringify(layout));
    fs.writeFileSync(at(`${base}/video/0.m4s`), "piece");
    const project = newProject();
    project.settings.fps = 30;
    project.media.push(media({ id: "s", name: "s", path: stream(key), kind: "video", duration: 120.4, cloud: { proxy: key } } as never));
    // Its picture to 120 s, its sound to 120.4 s.
    project.clips.push(clip("c1", "s", 0, 3600), clip("c2", "s", 0, 3612, 0, "audio"));
    // The second piece not here: its minute is missing, picture and sound.
    expect(await readyStretches(cache, project, path.join(cache, "cloud", "blocks"))).toEqual([[0, 1800]]);
    fs.writeFileSync(at(`${base}/video/1.m4s`), "piece");
    expect(await readyStretches(cache, project, path.join(cache, "cloud", "blocks"))).toEqual([[0, 3612]]);
  } finally {
    home.cleanup();
  }
});
