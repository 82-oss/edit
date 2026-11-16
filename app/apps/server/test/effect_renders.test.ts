import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import * as devtools from "../src/chrome_devtools.ts";
import * as effects from "../src/effects.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { findAddon, useNative, wrap, type Native } from "../src/native/index.ts";
import * as tools from "../src/tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as seams from "../src/seams.ts";
import { messageContext } from "../src/media_tools.ts";
import { fixtureHome } from "./helpers/home.ts";

// An effect rendered from its code, a file of its own beside effects.test.ts: its renders in Chrome are most of that
// file's time on CI's Mac (Nov 16: ~85 of 123 s), and a file is what the server tests' parts are cut by.
registerEffectTools();
registerEditingTools();
afterAll(() => effects.closeChrome());

/** A page that keeps the contract: a bar that crosses the frame in two seconds, and a count of the frame. */
const GOOD = `<!doctype html>
<html><body style="margin:0;background:#101418;overflow:hidden">
<div id="bar" style="position:absolute;top:500px;left:0;width:80px;height:80px;background:#e0343c"></div>
<div id="n" style="position:absolute;left:40px;top:40px;font:700 64px sans-serif;color:#fff"></div>
<script>
window.duration = 2;
window.ready = Promise.resolve();
window.seek = (t) => {
  document.getElementById("bar").style.transform = "translateX(" + Math.round((t / 2) * 1840) + "px)";
  document.getElementById("n").textContent = String(Math.round(t * 30));
};
</script></body></html>`;

function hq(name: string, size = { width: 1920, height: 1080 }) {
  const home = fixtureHome(name);
  const live = home.app.store.create("Welfare check", { ...size, fps: 30 });
  return { ...home, id: live.project.id };
}

function write(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, files: Record<string, string>): string {
  const dir = effects.folder(app.store, project, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(join(dir, file, ".."), { recursive: true });
    fs.writeFileSync(join(dir, file), text);
  }
  return dir;
}



const chrome = seams.broll.chrome();

test.skipIf(chrome === null)("an effect on the timeline is rendered from its code, in place of its still, and again when its code changes", async () => {
  const { app, cleanup, id } = hq("effects-render");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = write(app, id, "bar", { "scene.html": GOOD });
    const added = await effects.add(app, id, "bar");
    expect(added.duration).toBe(2);
    let media = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect(media.kind).toBe("image");
    expect(media.effect_key).toBeUndefined();
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    // What every export does first: waits for it, rendering it now.
    await seams.broll.waitForMaps(app, id, 90_000);
    media = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    const key = effects.list(app.store, id)[0]!.key;
    expect(media.effect_key).toBe(key);
    expect(media.kind).toBe("video");
    expect(media.effect).toBe("bar");
    expect(media.path.endsWith(`effect-renders/bar-${key}.mp4`)).toBe(true);
    expect(media.width).toBe(1920);
    expect(media.height).toBe(1080);
    expect(Math.abs(media.duration - 2)).toBeLessThan(0.05);
    // The frames went once joined; the video is every frame of it.
    expect(fs.existsSync(media.path.replace(/\.mp4$/, ".frames"))).toBe(false);
    const counted = Bun.spawnSync(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", media.path]).stdout.toString().trim().replace(/,$/, "");
    expect(counted).toBe("60");
    // Video range, as footage is: the JPEG frames are full range, which FFmpeg otherwise carries through (seen on kenobi, Nov 11).
    expect(Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_range", "-of", "csv=p=0", media.path]).stdout.toString().trim().replace(/,$/, "")).toBe("yuv420p,tv");
    // Rendered: nothing more to wait for.
    await seams.broll.waitForMaps(app, id, 10);
    // A change to its code is a new version: the render is outdated until it's made again.
    await Bun.sleep(20);
    fs.writeFileSync(join(dir, "scene.html"), GOOD.replace("#e0343c", "#34e03c"));
    const now = effects.list(app.store, id)[0]!.key;
    expect(now).not.toBe(key);
    await expect(seams.broll.waitForMaps(app, id, 10)).rejects.toThrow("The bar effect is still rendering");
    await seams.broll.waitForMaps(app, id, 90_000);
    expect(app.store.get(id)!.project.media.find((one) => one.id === added.media)!.effect_key).toBe(now);
    // A third version: the oldest render goes, the one before the newest stays (an undo shows it).
    await Bun.sleep(20);
    fs.writeFileSync(join(dir, "scene.html"), GOOD.replace("#e0343c", "#3434e0"));
    await seams.broll.waitForMaps(app, id, 90_000);
    const third = effects.list(app.store, id)[0]!.key;
    expect(fs.readdirSync(join(app.store.uploadsDir(id), "effect-renders")).sort()).toEqual([`bar-${now}.mp4`, `bar-${third}.mp4`].sort());
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("an effect plays footage it's given: seeked to each moment, drawn there, rendered frame by frame", async () => {
  const { app, cleanup, id, dir: scratchDir } = hq("effects-footage");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Footage: a counter on screen, a tone under it, three seconds.
    const clip = join(scratchDir, "clip.mp4");
    expect(Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]).exitCode).toBe(0);
    const media = "m9";
    await app.store.update(id, "test", (project) => {
      project.media.push({ id: media, name: "clip.mp4", path: clip, kind: "video", duration: 3, width: 640, height: 360, fps: 30, has_audio: true });
    });
    const given = await effects.giveFootage(app, id, "framed", media, 1, 3, "shot");
    expect(given).toMatchObject({ video: "shot.mp4", levels: "shot.levels.js", key: "shot", width: 640, height: 360, start: 1, duration: 2 });
    const folder = effects.folder(app.store, id, "framed");
    const script = fs.readFileSync(join(folder, "shot.levels.js"), "utf8");
    expect(script.startsWith('(window.levels = window.levels || {})["shot"] = {"fps":30,"frames":60,')).toBe(true);
    await expect(effects.giveFootage(app, id, "framed", media, 2.5, 2, null)).rejects.toThrow("start and end are seconds");
    await expect(effects.giveFootage(app, id, "framed", "m404", 0, 1, null)).rejects.toThrow("no media m404");
    // A page that plays the footage in a rounded frame, a meter from its sound beside it, seek waiting for the video.
    write(app, id, "framed", {
      "scene.html": `<!doctype html><body style="margin:0;background:#000"><script src="shot.levels.js"></script>
        <video id="v" src="shot.mp4" muted playsinline style="position:absolute;left:100px;top:300px;width:960px;border-radius:40px"></video>
        <div id="m" style="position:absolute;left:1300px;top:300px;width:120px;background:#fff"></div><script>
        const v = document.getElementById("v"), levels = window.levels.shot;
        window.duration = 2;
        window.ready = new Promise((resolve) => v.addEventListener("loadeddata", resolve, { once: true }));
        window.seek = (t) => {
          document.getElementById("m").style.height = Math.round(400 * levels.rms[Math.min(levels.frames - 1, Math.floor(t * levels.fps))]) + "px";
          return new Promise((resolve) => { v.addEventListener("seeked", resolve, { once: true }); v.currentTime = t; });
        };
      </script></body>`,
    });
    const look = await effects.look(app, id, "framed", [0.2, 1.5]);
    expect(look.errors).toEqual([]);
    expect(look.problems).toEqual([]);
    expect(Buffer.from(look.stills[0]!.picture).equals(Buffer.from(look.stills[1]!.picture))).toBe(false);
    // Rendered, every frame waiting for its seek.
    const added = await effects.add(app, id, "framed");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 90_000);
    const rendered = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect(rendered.kind).toBe("video");
    // The footage moves in the render: its first and last frames differ where the video sits.
    const frameAt = (t: number) => Bun.spawnSync(["ffmpeg", "-v", "error", "-ss", String(t), "-i", rendered.path, "-frames:v", "1", "-vf", "crop=960:540:100:300,scale=96:54,format=gray", "-f", "rawvideo", "-"]).stdout;
    expect(Buffer.from(frameAt(0.1)).equals(Buffer.from(frameAt(1.8)))).toBe(false);
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("a sound made from its code: rendered in the page, a WAV among the project's media, made again in its place", async () => {
  const { app, cleanup, id } = hq("effects-sound");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Plain samples: half a second of 440 Hz.
    write(app, id, "beep", {
      "sound.html": `<script>window.sound = { render: (rate) => { const out = new Float32Array(rate / 2); for (let at = 0; at < out.length; at++) out[at] = 0.5 * Math.sin(2 * Math.PI * 440 * at / rate); return [out]; } };</script>`,
    });
    const first = await effects.makeSound(app, id, "beep");
    expect(Math.abs(first.duration - 0.5)).toBeLessThan(0.02);
    let media = app.store.get(id)!.project.media.find((one) => one.id === first.media)!;
    expect(media).toMatchObject({ kind: "audio", name: "beep" });
    const peak = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", media.path, "-af", "volumedetect", "-f", "null", "-"], { stderr: "pipe" }).stderr.toString();
    expect(peak).toContain("max_volume: -6.0 dB");
    // An OfflineAudioContext's buffer, a second long: the same media, the new sound.
    write(app, id, "beep", {
      "sound.html": `<script>window.sound = { render: async (rate) => { const context = new OfflineAudioContext(2, rate, rate); const tone = context.createOscillator(); tone.connect(context.destination); tone.start(); return context.startRendering(); } };</script>`,
    });
    const again = await effects.makeSound(app, id, "beep");
    expect(again.media).toBe(first.media);
    media = app.store.get(id)!.project.media.find((one) => one.id === first.media)!;
    expect(Math.abs(media.duration - 1)).toBeLessThan(0.02);
    // Longer than a minute (a bed, a drone), read out of the page a stretch at a time: every sample, both sides.
    write(app, id, "drone", {
      "sound.html": `<script>window.sound = { render: (rate) => { const left = new Float32Array(rate * 75), right = new Float32Array(rate * 75); for (let at = 0; at < left.length; at++) { left[at] = 0.25 * Math.sin(2 * Math.PI * 110 * at / rate); right[at] = at >= left.length - rate ? 0.5 : 0; } return [left, right]; } };</script>`,
    });
    const drone = await effects.makeSound(app, id, "drone");
    expect(Math.abs(drone.duration - 75)).toBeLessThan(0.05);
    const end = Bun.spawnSync(["ffmpeg", "-hide_banner", "-ss", "74.2", "-i", app.store.get(id)!.project.media.find((one) => one.id === drone.media)!.path, "-af", "pan=mono|c0=c1,volumedetect", "-f", "null", "-"], { stderr: "pipe" }).stderr.toString();
    expect(end).toContain("max_volume: -6.0 dB");
    // One that never answers is said to, without waiting out a clock.
    effects.waits.quietMs = 1_500;
    try {
      write(app, id, "never", { "sound.html": `<script>window.sound = { render: () => new Promise(() => {}) };</script>` });
      await expect(effects.makeSound(app, id, "never")).rejects.toThrow("never's render(rate) never answered");
    } finally {
      effects.waits.quietMs = 15_000;
    }
    // A page with no sound says so.
    write(app, id, "silent", { "sound.html": `<p>nothing</p>` });
    await expect(effects.makeSound(app, id, "silent")).rejects.toThrow("no window.sound");
    await expect(effects.makeSound(app, id, "nothing-here")).rejects.toThrow("has no sound.html");
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 120_000);

test.skipIf(chrome === null)("a page is waited for as long as it works to be ready, and given up on once it gets nowhere, with what it waited on", async () => {
  const { app, cleanup, id } = hq("effects-ready-waits", { width: 640, height: 360 });
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  // The same rules with a shorter clock: what a page doing nothing for 15 s is refused for, in 1.5.
  effects.waits.quietMs = 1_500;
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const page = (ready: string) => `<!doctype html><body style="margin:0"><canvas id="c" width="640" height="360"></canvas><script>
window.duration = 1;
window.ready = ${ready};
window.seek = () => {};
</script></body>`;
    // Painting for 4 s in one go (ten times the clock's quiet), and in slices with breaks between: both are ready.
    write(app, id, "painted", { "scene.html": page(`new Promise((done) => setTimeout(() => { const end = performance.now() + 4000; const c = document.getElementById("c").getContext("2d"); while (performance.now() < end) { c.fillStyle = "hsl(" + (performance.now() % 360) + ",50%,50%)"; c.fillRect(Math.random() * 640, Math.random() * 360, 4, 4); } done(); }, 50))`) });
    const painted = await effects.look(app, id, "painted", [0.5]);
    expect(painted.errors).toEqual([]);
    expect(painted.ready!.ms).toBeGreaterThan(3_500);
    expect(painted.ready!.longest).toBeGreaterThan(3_500);
    write(app, id, "sliced", { "scene.html": page(`(async () => { const end = performance.now() + 4000; while (performance.now() < end) { const slice = performance.now() + 30; while (performance.now() < slice); await new Promise((go) => setTimeout(go)); } })()`) });
    const sliced = await effects.look(app, id, "sliced", [0.5]);
    expect(sliced.errors).toEqual([]);
    expect(sliced.ready!.ms).toBeGreaterThan(3_500);
    expect(sliced.ready!.longest).toBeLessThan(500);
    // Kept from that look, it isn't loaded again: nothing to say of its getting ready.
    expect((await effects.look(app, id, "sliced", [0.2])).ready).toBeNull();
    // A picture that isn't in its folder, waited for by its load alone: said by name, soon.
    write(app, id, "missing", { "scene.html": page(`new Promise((done) => { const picture = new Image(); picture.onload = done; picture.src = "board.png"; })`) });
    const from = Date.now();
    await expect(effects.look(app, id, "missing", [0.5])).rejects.toThrow(`missing's window.ready never resolved: its page got nowhere for 1.5 s (no code running, nothing loading), waiting on something that never comes: it asked for "board.png", not in its folder`);
    expect(Date.now() - from).toBeLessThan(10_000);
    // A promise nothing resolves.
    write(app, id, "forgot", { "scene.html": page(`new Promise(() => {})`) });
    await expect(effects.look(app, id, "forgot", [0.5])).rejects.toThrow("a Promise nothing resolves");
    // A loop that never ends, past the most a working page is given.
    effects.waits.workingMostMs = 4_000;
    write(app, id, "endless", { "scene.html": page(`(async () => { for (;;) { const slice = performance.now() + 30; while (performance.now() < slice); await new Promise((go) => setTimeout(go)); } })()`) });
    await expect(effects.look(app, id, "endless", [0.5])).rejects.toThrow("endless's page was still working on window.ready after");
    // What the agent is told: how long its code ran without a break, for the person's viewer runs it too.
    const told = async (name: string) => JSON.stringify(await dispatch(app, { id: 1, method: "tools/call", params: { name: "look_at_effect", arguments: { name, times: [0.5] } } }, id));
    expect(await told("sliced")).not.toContain("WITHOUT A BREAK");
    write(app, id, "painted", { "scene.html": page(`new Promise((done) => setTimeout(() => { const end = performance.now() + 2500; while (performance.now() < end); done(); }, 50))`) });
    expect(await told("painted")).toContain("WITHOUT A BREAK");
  } finally {
    effects.waits.quietMs = 15_000;
    effects.waits.workingMostMs = 10 * 60_000;
    await server.stop(true);
    cleanup();
  }
}, 120_000);

const SEE_THROUGH = `<!doctype html>
<html><body style="margin:0;overflow:hidden">
<div style="position:absolute;left:0;top:0;width:960px;height:1080px;background:#ff0000"></div>
<script>
window.duration = 1;
window.ready = Promise.resolve();
window.seek = () => {};
</script></body></html>`;

/** The colour at (x, y) of a picture (PNG or JPEG bytes), as FFmpeg reads it. */
function pixel(picture: Uint8Array, x: number, y: number): number[] {
  const kind = picture[0] === 0xff && picture[1] === 0xd8 ? "jpg" : "png";
  const path = join(os.tmpdir(), `edit-pixel-${process.pid}-${Math.random().toString(36).slice(2)}.${kind}`);
  fs.writeFileSync(path, picture);
  try {
    return [...Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
  } finally {
    fs.rmSync(path, { force: true });
  }
}

const size = (path: string) => Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path]).stdout.toString().trim().replace(/,$/, "");

test.skipIf(chrome === null)("an effect with see-through parts renders with its alpha and plays over what's beneath; while its code is newer, the engine draws nothing for it", async () => {
  const { app, cleanup, id } = hq("effects-alpha");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const addon = findAddon();
  const before = addon === null ? null : useNative(wrap(require(addon) as Native));
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = write(app, id, "half", { "scene.html": SEE_THROUGH });
    // The agent's look says so, and shows it over a checkerboard.
    const looked = (await effects.look(app, id, "half", [0])).stills[0]!;
    expect(looked.seeThrough).toBe(true);
    const red = pixel(looked.picture, 300, 270);
    expect(red[0]).toBeGreaterThan(230);
    expect(red[1]! + red[2]!).toBeLessThan(40);
    expect(new Set(pixel(looked.picture, 700, 270)).size).toBe(1);
    const added = await effects.add(app, id, "half");
    const mediaOf = () => app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    // Before its render: a clear picture of its own, nothing drawn for it.
    expect(mediaOf().path.endsWith("effect-stills/half.clear.png")).toBe(true);
    expect([mediaOf().width, mediaOf().height]).toEqual([1920, 1080]);
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.tracks.push({ id: "t2", kind: "video", name: "V2", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      // Blue beneath it, the effect over it.
      project.clips.push({ id: "c0", type: "solid", track: "t1", start: 0, duration: 30, fill: [0, 0, 1, 1], opacity: 1 } as unknown as (typeof project.clips)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t2", start: 0, duration: 30, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 90_000);
    let media = mediaOf();
    expect(media.stacked_alpha).toBe(true);
    expect(media.kind).toBe("video");
    // The picture's own size; the file is the picture over its alpha, played as it is (no preview copy to halve it).
    expect([media.width, media.height]).toEqual([1920, 1080]);
    expect(size(media.path)).toBe("1920,2160");
    expect(app.media.status(media.path).proxy).toBe("skipped");
    // The engine draws it over the blue: red where it's painted, blue where it isn't (with the real engine, built).
    if (addon !== null) {
      (require(addon) as Native).init({ home: app.store.home, cacheDir: app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe(), log: () => {} });
      const frame = ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "render_frame", arguments: { frame: 10, max_size: 1920 } } }, id)) as { result: { content: { type: string; data?: string; text?: string }[] } }).result;
      const picture = Buffer.from(frame.content.find((part) => part.type === "image")?.data ?? "", "base64");
      expect(picture.length).toBeGreaterThan(0);
      const [r1, g1, b1] = pixel(picture, 480, 540);
      expect(r1).toBeGreaterThan(230);
      expect(g1! + b1!).toBeLessThan(30);
      const [r2, g2, b2] = pixel(picture, 1440, 540);
      expect(b2).toBeGreaterThan(230);
      expect(r2! + g2!).toBeLessThan(30);
    }
    // Its code changed: at once its old render gives way to its clear picture (the page playing live is all that's seen of it).
    await Bun.sleep(20);
    fs.writeFileSync(join(dir, "scene.html"), SEE_THROUGH.replace("margin:0;", "margin:0;background:#00ff00;"));
    effects.renderSoon(app, id);
    for (let wait = 0; wait < 50 && mediaOf().kind !== "image"; wait++) await Bun.sleep(50);
    media = mediaOf();
    expect(media.path.endsWith("half.clear.png")).toBe(true);
    expect(media.effect_key).toBeUndefined();
    expect(media.stacked_alpha).toBeUndefined();
    // A page that paints every pixel is plain video, as before.
    expect((await effects.look(app, id, "half", [0])).stills[0]!.seeThrough).toBe(false);
    await seams.broll.waitForMaps(app, id, 90_000);
    media = mediaOf();
    expect(media.stacked_alpha).toBeUndefined();
    expect(media.kind).toBe("video");
    expect(size(media.path)).toBe("1920,1080");
  } finally {
    if (addon !== null) useNative(before);
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("a render that fails names its effect and says what to do; the agent is told what went wrong", async () => {
  const { app, cleanup, id } = hq("effects-render-fails");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = write(app, id, "breaks", { "scene.html": GOOD });
    const added = await effects.add(app, id, "breaks");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    // Its seek throws past the first second: the code's to fix, so the agent is asked to.
    fs.writeFileSync(join(dir, "scene.html"), GOOD.replace("window.seek = (t) => {", "window.seek = (t) => { if (t > 1) throw new Error('nope');"));
    await expect(seams.broll.waitForMaps(app, id, 90_000)).rejects.toThrow("The breaks effect didn't render: ask the agent to fix the breaks effect.");
    // The render went after the turn that wrote it: the agent hears of it with the person's next message, once.
    const next = await messageContext(app, id, null, true);
    expect(next).toStartWith("\n\n(Edit, automatically) The breaks effect's render failed: ");
    expect(next).toContain("its page threw at");
    expect(next).toEndWith(". Fix its code, then check it with look_at_effect.");
    expect(await messageContext(app, id, null, true)).toBe("");
    expect(effects.renderLine(app, id, "breaks")).toContain("its page threw at");
    // Asked again while it stands: the same, at once, and no export takes the clear still for it.
    await expect(seams.broll.waitForMaps(app, id, 10)).rejects.toThrow("ask the agent to fix the breaks effect");
    expect(effects.notReady(app.store, app.store.get(id)!.project)).toContain("The breaks effect");
  } finally {
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("a render Chrome let down (it didn't start) is tried again at once, not failed for five minutes", async () => {
  const { app, cleanup, id } = hq("effects-render-again");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const open = devtools.open;
  let failed = 0;
  const spy = spyOn(devtools, "open").mockImplementation(((opening: Parameters<typeof devtools.open>[0]) => {
    if (opening.what === "Rendering an effect" && failed === 0) {
      failed += 1;
      return Promise.reject(new Error("Rendering an effect: Chrome didn't start."));
    }
    return open(opening);
  }) as typeof devtools.open);
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "again", { "scene.html": GOOD });
    const added = await effects.add(app, id, "again");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 90_000);
    expect(failed).toBe(1);
    expect(app.store.get(id)!.project.media.find((one) => one.id === added.media)!.effect_key).toBe(effects.list(app.store, id)[0]!.key);
  } finally {
    spy.mockRestore();
    await server.stop(true);
    cleanup();
  }
}, 240_000);
