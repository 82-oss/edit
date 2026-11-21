// The V2 timeline's pictures and waveforms (timeline_media.ts): a frame is the one FFmpeg decodes at the moment
// asked, kept on disk and served from there the second time; a see-through render gives its top half; a new render
// (`effect_key`) gives new pictures; a sound with no waveform here gets one when it's asked for; and none of it holds
// the server's thread (a 50 ms timer beats on while frames are made by a stand-in FFmpeg that takes 1.5 s).

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { respond } from "../src/http/server.ts";
import type { Media } from "../src/model.ts";
import { buildRouter } from "../src/routes.ts";
import * as timelineMedia from "../src/timeline_media.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";
import { media } from "./helpers/model.ts";

const bin = fs.mkdtempSync(join(os.tmpdir(), "timeline-media-"));
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

const router = buildRouter();

function ffmpegSync(args: string[]): Uint8Array {
  const done = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { stdout: "pipe", stderr: "pipe" });
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  return done.stdout;
}

/** A clip of FFmpeg's test source whose picture changes every frame (a clock and moving shapes). */
function testVideo(name: string, seconds = 4): string {
  const out = join(bin, name);
  if (!fs.existsSync(out)) ffmpegSync(["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`, "-c:v", "libx264", "-g", "30", "-bf", "0", "-pix_fmt", "yuv420p", out]);
  return out;
}

/** A see-through render: `top` above white (its mask), twice the picture's height, as effects.ts stacks one. */
function stackedVideo(name: string, top: string): string {
  const out = join(bin, name);
  ffmpegSync([
    "-f", "lavfi", "-i", `color=c=${top}:size=64x64:rate=30:duration=1`,
    "-f", "lavfi", "-i", "color=c=white:size=64x64:rate=30:duration=1",
    "-filter_complex", "[0:v][1:v]vstack=inputs=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

/** A picture's pixels, 32 px high and grey, decoded by FFmpeg from a JPEG. */
function grey(jpeg: Uint8Array): Uint8Array {
  const path = join(bin, `g-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(path, jpeg);
  return ffmpegSync(["-i", path, "-vf", "scale=56:32,format=gray", "-f", "rawvideo", "-"]);
}

/** A picture's mean red, green and blue (0–255). */
function meanColour(jpeg: Uint8Array): [number, number, number] {
  const path = join(bin, `c-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(path, jpeg);
  const raw = ffmpegSync(["-i", path, "-vf", "scale=8:8,format=rgb24", "-f", "rawvideo", "-"]);
  const sum = [0, 0, 0];
  for (let at = 0; at < raw.length; at++) sum[at % 3]! += raw[at]!;
  const n = raw.length / 3;
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

/** A JPEG's width and height. */
function sizeOf(jpeg: Uint8Array): [number, number] {
  const path = join(bin, `s-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(path, jpeg);
  const done = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], { stdout: "pipe" });
  const [w, h] = done.stdout.toString().trim().split(",").map(Number);
  return [w!, h!];
}

const difference = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0;
  for (let at = 0; at < a.length; at++) sum += Math.abs(a[at]! - b[at]!);
  return sum / a.length;
};

/** The frames in a route's body (timeline_media.ts `packFrames`). */
function unpack(body: Uint8Array): (Uint8Array | null)[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(0, true);
  const out: (Uint8Array | null)[] = [];
  let at = 4 + count * 4;
  for (let index = 0; index < count; index++) {
    const length = view.getUint32(4 + index * 4, true);
    out.push(length === 0 ? null : body.slice(at, at + length));
    at += length;
  }
  return out;
}

function home(name: string) {
  const fixture = fixtureHome(name);
  const id = fixture.app.store.create("Timeline", { width: 1920, height: 1080, fps: 30 }).project.id;
  const add = async (one: Media) => {
    await fixture.app.store.update(id, "test", (project) => {
      project.media = project.media.filter((other) => other.id !== one.id);
      project.media.push(one);
    });
  };
  const get = async (path: string) => {
    const response = (await respond(fixture.app, router, new Request(`http://localhost:7700${path}`, { headers: { host: "localhost:7700" } }), null))!;
    return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
  };
  const frames = async (mediaId: string, times: number[], h = 72) => {
    const answer = await get(`/api/projects/${id}/media/${mediaId}/frames?t=${times.join(",")}&h=${h}`);
    expect(answer.status).toBe(200);
    return unpack(answer.body);
  };
  return { ...fixture, id, add, get, frames };
}

async function withFfmpeg<T>(path: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.EDIT_FFMPEG;
  process.env.EDIT_FFMPEG = path;
  tools.forget();
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.EDIT_FFMPEG;
    else process.env.EDIT_FFMPEG = before;
    tools.forget();
  }
}

test("a frame is FFmpeg's own at the moment asked, and the second ask is served from disk", async () => {
  const { add, frames, app, id, cleanup } = home("timeline-frames");
  try {
    const source = testVideo("clock.mp4");
    await add(media({ id: "m1", name: "clock.mp4", path: source, kind: "video", duration: 4, width: 640, height: 360, fps: 30 }));
    const [at1, at3] = await frames("m1", [1.2, 3.1]);
    expect(at1).not.toBeNull();
    expect(at3).not.toBeNull();
    // FFmpeg's own frame at 1.2 s: this one, not the one at 3.1 s (testsrc2 changes every frame).
    const own = ffmpegSync(["-ss", "1.2", "-i", source, "-frames:v", "1", "-vf", "scale=-2:72", "-f", "mjpeg", "-q:v", "2", "-"]);
    const near = difference(grey(at1!), grey(own));
    const far = difference(grey(at3!), grey(own));
    expect(near).toBeLessThan(6);
    expect(far).toBeGreaterThan(near * 2);
    // Kept on disk: asked again with no FFmpeg at all, the same pictures.
    const dir = timelineMedia.frameDir(app.store.cacheDir(), app.store.get(id)!.project.media.find((one) => one.id === "m1")!, 72);
    expect(fs.existsSync(join(dir, "1200.jpg"))).toBe(true);
    const again = await withFfmpeg("/bin/false", () => frames("m1", [1.2, 3.1]));
    expect(again[0]).toEqual(at1);
    expect(again[1]).toEqual(at3);
  } finally {
    cleanup();
  }
});

test("a see-through render gives its picture's top half, and a new render (effect_key) gives new pictures", async () => {
  const { add, frames, cleanup } = home("timeline-stacked");
  try {
    const red = stackedVideo("red.mp4", "red");
    const effect = (path: string, key: string) =>
      media({ id: "fx", name: "card", path, kind: "video", duration: 1, width: 64, height: 64, fps: 30, effect: "card", effect_key: key, stacked_alpha: true } as Partial<Media> & Pick<Media, "id" | "name" | "path" | "kind" | "duration">);
    await add(effect(red, "k1"));
    const [first] = await frames("fx", [0.5]);
    const [r, g, b] = meanColour(first!);
    // Red alone (the mask below is white): its top half.
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    // And square, the picture's shape, not the stack's.
    expect(sizeOf(first!)).toEqual([72, 72]);
    // Rendered again, blue, at the very same path: its frames are the new render's.
    const blue = stackedVideo("blue.mp4", "blue");
    fs.copyFileSync(blue, red);
    await add(effect(red, "k2"));
    const [second] = await frames("fx", [0.5]);
    const [r2, , b2] = meanColour(second!);
    expect(b2).toBeGreaterThan(180);
    expect(r2).toBeLessThan(60);
  } finally {
    cleanup();
  }
});

test("a graphic not rendered yet (its clear still standing in) has no pictures to give", async () => {
  const { add, get, id, cleanup } = home("timeline-unrendered");
  try {
    await add(media({ id: "fx", name: "card", path: join(bin, "still.png"), kind: "image", duration: 5, width: 1920, height: 1080, effect: "card" } as Partial<Media> & Pick<Media, "id" | "name" | "path" | "kind" | "duration">));
    expect((await get(`/api/projects/${id}/media/fx/frames?t=1&h=72`)).status).toBe(404);
    expect((await get(`/api/projects/${id}/media/fx/frames?t=1&h=73`)).status).toBe(400);
  } finally {
    cleanup();
  }
});

test("a sound with no waveform here (a library sound played from the cloud) gets one when it's asked for", async () => {
  const { add, get, id, app, cleanup } = home("timeline-peaks");
  try {
    const sound = join(bin, "hit.wav");
    ffmpegSync(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", sound]);
    await add(media({ id: "a1", name: "hit.wav", path: sound, kind: "audio", duration: 1, has_audio: true, library: "sfx" } as Partial<Media> & Pick<Media, "id" | "name" | "path" | "kind" | "duration">));
    const peaks = app.media.paths(sound).peaks;
    expect(fs.existsSync(peaks)).toBe(false);
    const answer = await get(`/api/projects/${id}/media/a1/peaks`);
    expect(answer.status).toBe(200);
    // The engine's stub writes these four.
    expect([...answer.body]).toEqual([0, 64, 128, 255]);
    expect(fs.existsSync(peaks)).toBe(true);
  } finally {
    cleanup();
  }
});

test("frames are made off the server's thread: a 50 ms timer keeps beating while FFmpeg takes 1.5 s", async () => {
  const { add, frames, cleanup } = home("timeline-thread");
  try {
    // A stand-in FFmpeg: 1.5 s, then a picture at each output (every argument ending .jpg).
    const slow = join(bin, "slow-ffmpeg");
    fs.writeFileSync(slow, `#!/bin/sh\nsleep 1.5\nfor a; do case "$a" in *.jpg) printf 'jpeg' > "$a";; esac; done\n`, { mode: 0o755 });
    await add(media({ id: "m1", name: "clock.mp4", path: testVideo("clock.mp4"), kind: "video", duration: 4, width: 640, height: 360, fps: 30 }));
    let last = performance.now();
    let gap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
    }, 50);
    const started = performance.now();
    const made = await withFfmpeg(slow, () => frames("m1", [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 3.9, 0.2, 0.7, 1.7]));
    clearInterval(timer);
    expect(performance.now() - started).toBeGreaterThan(1400);
    expect(made.every((frame) => frame !== null)).toBe(true);
    expect(gap).toBeLessThan(750);
  } finally {
    cleanup();
  }
});

test("a moment at a file's very end still gives a frame (its stated length can run past its last frame)", async () => {
  const { add, frames, cleanup } = home("timeline-end");
  try {
    const source = testVideo("short.mp4", 2);
    // Its stated length a little past its real end, as an import's probe of a cut file can be.
    await add(media({ id: "m1", name: "short.mp4", path: source, kind: "video", duration: 2.4, width: 640, height: 360, fps: 30 }));
    const [last] = await frames("m1", [2.39]);
    expect(last).not.toBeNull();
  } finally {
    cleanup();
  }
});
