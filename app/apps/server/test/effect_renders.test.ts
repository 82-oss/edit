import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import * as devtools from "../src/chrome_devtools.ts";
import * as diag from "../src/diag.ts";
import * as effects from "../src/effects.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { findAddon, useNative, wrap, type Native } from "../src/native/index.ts";
import * as tools from "../src/tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import * as playing from "../src/playing.ts";
import * as seams from "../src/seams.ts";
import * as storage from "../src/storage.ts";
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
    // What every export does first: waits for it, rendering it now; an export waiting says how far it is.
    const going = seams.broll.waitForMaps(app, id, 90_000);
    // What it says while it waits: behind another test's render still drawing (CI's Mac), then its own frames.
    const lines = new Set<string>();
    let done = false;
    void going.finally(() => (done = true));
    while (!done) {
      const line = effects.renderingLine(id);
      if (line !== null) lines.add(line);
      await Bun.sleep(10);
    }
    await going;
    expect(lines.size).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^(rendering the bar effect( · \d+ of 60 frames)?|waiting behind .+'s render)$/);
    expect([...lines].some((line) => / of 60 frames$/.test(line))).toBe(true);
    expect(effects.renderingLine(id)).toBeNull();
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
    // Its code put back exactly as it was (a change that can't be finished, effects.NO_WEBGL_LINE): the render kept of
    // that code plays again, placed as it was, never drawn (no Chrome needed for it).
    const kept = join(app.store.uploadsDir(id), "effect-renders", `bar-${now}.mp4`);
    const made = fs.statSync(kept).mtimeMs;
    fs.writeFileSync(join(dir, "scene.html"), GOOD.replace("#e0343c", "#34e03c"));
    expect(effects.list(app.store, id)[0]!.key).toBe(now);
    await seams.broll.waitForMaps(app, id, 90_000);
    const back = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect([back.effect_key, back.kind, back.path]).toEqual([now, "video", kept]);
    expect(fs.statSync(kept).mtimeMs).toBe(made);
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

/** Opaque for its first 1.1 s, then half of it see-through: a render that turns stacked part way. */
const TURNS_SEE_THROUGH = `<!doctype html>
<html><body style="margin:0;overflow:hidden">
<div id="left" style="position:absolute;left:0;top:0;width:960px;height:1080px;background:#ff0000"></div>
<div id="right" style="position:absolute;left:960px;top:0;width:960px;height:1080px;background:#0000ff"></div>
<script>
window.duration = 2;
window.ready = Promise.resolve();
window.seek = (t) => { document.getElementById("right").style.display = t >= 1.1 ? "none" : "block"; };
</script></body></html>`;

test.skipIf(chrome === null)("a render is made in chunks of its frames, joined by a stream copy into one video as before; a chunk found see-through makes it stacked, the ones before drawn again so (kenobi, Nov 17: every frame kept at once needed 8 GB free)", async () => {
  const { app, cleanup, id } = hq("effects-chunks");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const bytes = effects.chunkHooks.bytes;
  try {
    app.port = server.port!;
    // Half a second a chunk (one keyframe interval): four of them, the third the first see-through.
    effects.chunkHooks.bytes = 16 * 1920 * 1080 * 1.5;
    expect(effects.chunkFrames({ width: 1920, height: 1080, fps: 30 })).toBe(15);
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "turns", { "scene.html": TURNS_SEE_THROUGH });
    const added = await effects.add(app, id, "turns");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 120_000);
    const media = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect(media.kind).toBe("video");
    expect(media.stacked_alpha).toBe(true);
    expect(size(media.path)).toBe("1920,2160");
    expect(fs.existsSync(media.path.replace(/\.mp4$/, ".frames"))).toBe(false);
    const probe = (entries: string, extra: string[] = []) => Bun.spawnSync(["ffprobe", "-v", "error", ...extra, "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0", media.path]).stdout.toString().trim();
    // Every frame once, a keyframe every half second, no B-frames, video range BT.709 as before.
    expect(probe("stream=nb_read_frames", ["-count_frames"]).replace(/,$/, "")).toBe("60");
    const keyframes = probe("frame=key_frame,pict_type").split("\n").map((line, n) => [n, line] as const).filter(([, line]) => line.startsWith("1")).map(([n]) => n);
    expect(keyframes).toEqual([0, 15, 30, 45]);
    expect(probe("frame=pict_type").includes("B")).toBe(false);
    expect(probe("stream=pix_fmt,color_range,color_space").replace(/,$/, "")).toBe("yuv420p,tv,bt709");
    expect(Math.abs(media.duration - 2)).toBeLessThan(0.05);
    // Its alpha (the lower half) at 0.5 s, from a chunk made plain before and drawn again: all of it opaque; at 1.5 s
    // the right half clear.
    const frameAt = (t: number, x: number, y: number) => [...Bun.spawnSync(["ffmpeg", "-v", "error", "-ss", String(t), "-i", media.path, "-frames:v", "1", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
    expect(frameAt(0.5, 1440, 1620)[0]).toBeGreaterThan(230);
    expect(frameAt(1.5, 1440, 1620)[0]).toBeLessThan(25);
    expect(frameAt(1.5, 480, 1620)[0]).toBeGreaterThan(230);
    // The colour half: blue on the right while it's there.
    const blue = frameAt(0.5, 1440, 540);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]).toBeLessThan(40);
  } finally {
    effects.chunkHooks.bytes = bytes;
    await server.stop(true);
    cleanup();
  }
}, 240_000);

/** A bar crossing the frame over `seconds`, the frame's number on it and a colour of its own behind: a frame out of place shows. */
const counting = (seconds: number) =>
  GOOD.replace("window.duration = 2;", `window.duration = ${seconds};`)
    .replace("(t / 2) * 1840", `(t / ${seconds}) * 560`)
    .replace("font:700 64px", "font:700 40px")
    .replace("document.getElementById(\"n\").textContent", "const n = Math.round(t * 30); document.body.style.background = `rgb(${(n * 37) % 256},${(n * 91) % 256},${(n * 53) % 256})`; document.getElementById(\"n\").textContent");

test.skipIf(chrome === null)("renders take turns at a chunk's end: another project's render an export waits on starts after at most one chunk of a long one, which goes on from its chunks and comes out the same as drawn in one go; each says how long it waited in the queue (Sphe's M4, Nov 18)", async () => {
  const size = { width: 640, height: 360 };
  const { app, cleanup, id: long } = hq("effects-turns", size);
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const bytes = effects.chunkHooks.bytes;
  const place = async (project: string, name: string, page: string) => {
    await app.store.update(project, "test", (edited) => {
      edited.hq = true;
    });
    write(app, project, name, { "scene.html": page });
    const added = await effects.add(app, project, name);
    await app.store.update(project, "test", (edited) => {
      edited.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof edited.tracks)[number]);
      edited.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof edited.clips)[number]);
    });
    return () => app.store.get(project)!.project.media.find((one) => one.id === added.media)!;
  };
  try {
    app.port = server.port!;
    // Half a second a chunk: the long one 12 chunks, the short one 2.
    effects.chunkHooks.bytes = 16 * size.width * size.height * 1.5;
    expect(effects.chunkFrames({ ...size, fps: 30 })).toBe(15);
    const short = app.store.create("Title cards", { ...size, fps: 30 }).project.id;
    const whole = app.store.create("Drawn in one go", { ...size, fps: 30 }).project.id;
    const longMedia = await place(long, "interview", counting(6));
    const shortMedia = await place(short, "card", counting(1));
    const wholeMedia = await place(whole, "interview", counting(6));
    // The long one nobody waits on (a render after the agent's turn), its frames under way.
    const longDone = effects.renderNow(app, long, "interview");
    const until = Date.now() + 60_000;
    while (!/ of 180 frames$/.test(effects.renderingLine(long) ?? "") || (effects.drawing()[0] ?? "") === "") {
      if (Date.now() > until) throw new Error(`the long render never started: ${effects.renderingLine(long)}`);
      await Bun.sleep(5);
    }
    expect(effects.drawing()).toEqual(["Welfare check's interview effect"]);
    // An export of the other project waits on its card.
    const asked = Number(/(\d+) of 180/.exec(effects.renderingLine(long)!)![1]);
    const exported = seams.broll.waitForMaps(app, short, 120_000);
    let shortStarted = false;
    let longAtShort = -1;
    let exportDone = false;
    void exported.finally(() => (exportDone = true));
    while (!exportDone) {
      if (!shortStarted && /^rendering the card effect/.test(effects.renderingLine(short) ?? "")) {
        shortStarted = true;
        const state = effects.renderState(long, "interview", effects.list(app.store, long)[0]!.key) ?? "";
        expect(state).toMatch(/^waiting behind Title cards's render \(\d+ of 180 frames drawn\)$/);
        longAtShort = Number(/\((\d+) of 180/.exec(state)![1]);
        expect(effects.drawing()).toEqual(["Title cards's card effect", "Welfare check's interview effect"]);
      }
      await Bun.sleep(5);
    }
    await exported;
    expect(shortStarted).toBe(true);
    // At most the rest of the chunk it was drawing: it gave way at that chunk's end.
    expect(longAtShort % 15).toBe(0);
    expect(longAtShort).toBeLessThanOrEqual((Math.floor(asked / 15) + 1) * 15);
    expect(shortMedia().kind).toBe("video");
    // The long one, waiting meanwhile, then goes on from its chunks.
    expect(longMedia().kind).toBe("image");
    await longDone;
    expect(longMedia().kind).toBe("video");
    expect(effects.drawing()).toEqual([]);
    // Drawn again in one go, in a project of its own: the same frames, in the same order (Chrome's pixels and the encoder
    // aren't bit for bit the same twice, so frame by frame alike to the eye; one out of place is another colour).
    await effects.renderNow(app, whole, "interview");
    const psnr = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", longMedia().path, "-i", wholeMedia().path, "-lavfi", "[0:v][1:v]psnr=stats_file=-", "-f", "null", "-"]).stdout.toString();
    const frames = [...psnr.matchAll(/psnr_avg:(\S+)/g)].map((match) => (match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1])));
    expect(frames.length).toBe(180);
    expect(Math.min(...frames)).toBeGreaterThan(35);
    // Each start, and each turn again, says how long it waited in the queue, by project.
    const said = diag.lines(400).map((line) => line.message);
    expect(said.some((line) => new RegExp(`^${short}: card's render starts after \\d+\\.\\d s in the queue \\(waited on\\)$`).test(line))).toBe(true);
    expect(said.some((line) => new RegExp(`^${long}: interview's render gives way to another project's at \\d+ of 180 frames`).test(line))).toBe(true);
    expect(said.some((line) => new RegExp(`^${long}: interview's render takes its turn again after \\d+\\.\\d s in the queue, \\d+ of 180 frames drawn$`).test(line))).toBe(true);
    expect(said.some((line) => new RegExp(`^${long}: interview rendered \\(180 frames, \\d+\\.\\d s drawing and joining, \\d+\\.\\d s in the queue\\)$`).test(line))).toBe(true);
  } finally {
    effects.chunkHooks.bytes = bytes;
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("a render made while someone watches is put in once the play stops, never under it (Sphe, Nov 17: the agent's work goes on as if it weren't happening)", async () => {
  const { app, cleanup, id } = hq("effects-render-play");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const stale = playing.hooks.staleMs;
  playing.reset();
  playing.hooks.staleMs = 600_000;
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "bar", { "scene.html": GOOD });
    const added = await effects.add(app, id, "bar");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    const going = seams.broll.waitForMaps(app, id, 120_000);
    let done = false;
    void going.finally(() => (done = true));
    // Its frames under way, a play starts.
    while (!done && !/ of 60 frames$/.test(effects.renderingLine(id) ?? "")) await Bun.sleep(10);
    playing.note("p", true);
    const media = () => app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    await Bun.sleep(4_000);
    expect(done).toBe(false);
    expect(media().kind).toBe("image");
    expect(media().effect_key).toBeUndefined();
    playing.note("p", false);
    await going;
    expect(media().kind).toBe("video");
    expect(media().effect_key).toBe(effects.list(app.store, id)[0]!.key);
  } finally {
    playing.hooks.staleMs = stale;
    playing.reset();
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("a render with no room on the disk for what it holds at once is refused before it draws, saying how much to free", async () => {
  const { app, cleanup, id } = hq("effects-no-room");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const free = storage.diskHooks.free;
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "bar", { "scene.html": GOOD });
    const added = await effects.add(app, id, "bar");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    // The floor and 100 MB: a 2 s board holds ~0.2 GB at once.
    storage.diskHooks.free = () => storage.WORK_FLOOR_BYTES + 100_000_000;
    await expect(effects.renderNow(app, id, "bar")).rejects.toThrow("The disk is too full to draw the bar effect: free about 1 GB, and Edit draws it by itself.");
    expect(fs.readdirSync(join(app.store.uploadsDir(id), "effect-renders")).filter((name) => name.endsWith(".frames")).flatMap((name) => fs.readdirSync(join(app.store.uploadsDir(id), "effect-renders", name)))).toEqual([]);
  } finally {
    storage.diskHooks.free = free;
    await server.stop(true);
    cleanup();
  }
}, 120_000);

test.skipIf(chrome === null)("a render the hardware encoder refuses is made with libx264, and the log says which encoder made it", async () => {
  const { app, cleanup, id } = hq("effects-software");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const hardware = effects.encoderHooks.hardware;
  const said: string[] = [];
  const info = spyOn(diag, "info").mockImplementation((_area: string, line: string) => void said.push(line));
  const warn = spyOn(diag, "warn").mockImplementation((_area: string, line: string) => void said.push(line));
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // NVENC with no card to open: FFmpeg's last line is "Nothing was written into output file" (Nov 22, the trial server).
    effects.encoderHooks.hardware = () => ["-c:v", "h264_nvenc", "-gpu", "99"];
    // Four seconds: two chunks, the second refused too had it been on the card.
    write(app, id, "bar", { "scene.html": GOOD.replace("window.duration = 2;", "window.duration = 4;") });
    const added = await effects.add(app, id, "bar");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 120, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await seams.broll.waitForMaps(app, id, 120_000);
    const media = app.store.get(id)!.project.media.find((one) => one.id === added.media)!;
    expect(media.kind).toBe("video");
    expect(fs.readFileSync(media.path).includes("x264 - core")).toBe(true);
    const counted = Bun.spawnSync(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", media.path]).stdout.toString().trim().replace(/,$/, "");
    expect(counted).toBe("120");
    const refused = said.find((line) => line.includes("didn't encode on h264_nvenc"));
    expect(refused).toBeDefined();
    // FFmpeg's reason, not its knock-on last line.
    expect(refused).not.toContain("Nothing was written");
    expect(refused).toContain("made with libx264 instead");
    expect(said.some((line) => line.includes("bar's 2 chunks joined, encoded with libx264"))).toBe(true);
  } finally {
    effects.encoderHooks.hardware = hardware;
    info.mockRestore();
    warn.mockRestore();
    await server.stop(true);
    cleanup();
  }
}, 240_000);

test.skipIf(chrome === null)("a render that failed for a passing reason is the computer's: tried again by itself, and at once for an export that waits on it", async () => {
  const { app, cleanup, id } = hq("effects-passing");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const run = tools.run;
  let refusals = 0;
  const spy = spyOn(tools, "run").mockImplementation(async (command: string[], options?: Parameters<typeof tools.run>[1]) => {
    // Every encode of a chunk fails, on either encoder, until it's let go: a moment the machine couldn't encode at all.
    if (refusals >= 0 && command.some((part) => part.endsWith(".partial.mp4") && part.includes("chunk-"))) {
      refusals += 1;
      throw Object.assign(new Error("[out#0/mp4 @ 0x1] Nothing was written into output file, because at least one of its streams received no packets."), { stderr: "[h264_nvenc @ 0x2] OpenEncodeSessionEx failed: out of memory (10): (no details)\n[out#0/mp4 @ 0x1] Nothing was written into output file, because at least one of its streams received no packets.\n" });
    }
    return run(command, options);
  });
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "bar", { "scene.html": GOOD });
    const added = await effects.add(app, id, "bar");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    // Nobody waits on it: it fails (tried once again at once), and is the computer's, never the agent's to fix.
    const first = await effects.renderNow(app, id, "bar").then(() => null, (error: unknown) => diag.messageOf(error));
    expect(first).toBe("The bar effect couldn't render just now: press Retry.");
    expect(refusals).toBeGreaterThan(0);
    expect(effects.renderState(id, "bar", effects.list(app.store, id)[0]!.key)).toContain("h264_nvenc: OpenEncodeSessionEx failed: out of memory (10)");
    expect(await messageContext(app, id, null, true)).toBe("");
    // Asked again with nobody waiting, it stands until its own try (a minute on, then 5, 15, every 30).
    await expect(effects.renderNow(app, id, "bar")).rejects.toThrow("couldn't render just now");
    // The machine can encode again: an export waiting on it renders it now, not refusing until that try.
    refusals = -1;
    await seams.broll.waitForMaps(app, id, 90_000);
    expect(app.store.get(id)!.project.media.find((one) => one.id === added.media)!.kind).toBe("video");
  } finally {
    spy.mockRestore();
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
    // A page whose WebGL wouldn't start on this browser, which then never gets as far as its seek: the computer's, said
    // before its missing seek, and the agent never asked to fix the code for it.
    fs.writeFileSync(join(dir, "scene.html"), `<!doctype html><body><script>
      const real = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return /webgl/.test(kind) ? null : real.call(this, kind, ...rest); };
      window.duration = 2; window.ready = Promise.resolve();
      setTimeout(() => { throw new Error("Error creating WebGL context."); });
    </script></body>`);
    const failed = await effects.renderNow(app, id, "breaks").then(() => "rendered", (error: unknown) => diag.messageOf(error));
    expect(failed).toContain("couldn't render just now");
    // Read first: the render's line marks a failure told (`renderLine`), which would leave nothing here to see.
    expect(await messageContext(app, id, null, true)).toBe("");
    const line = effects.renderLine(app, id, "breaks")!;
    expect(line).toMatch(/its page couldn't start: .*Error creating WebGL context\..* \(this computer's browser has no WebGL\)/u);
    expect(line).toEndWith(`${effects.NO_WEBGL_LINE}`);
    expect(line).not.toContain("no window.seek");
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

test.skipIf(chrome === null)("a page held up by the network (the relay unreachable, its tiles hanging) is the network's, not its code's: the agent isn't told to fix it, and it renders again once the relay answers (Sphe's M4, Nov 17, nightly-78)", async () => {
  // A stand-in relay that's down: its health 503, its tiles held unanswered until it's back.
  let up = false;
  const held: (() => void)[] = [];
  const stand = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 200,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/health") return new Response(up ? "ok" : "down", { status: up ? 200 : 503 });
      // Its other calls (V2's cloud's fonts) refused at once: only the tiles hang.
      if (!path.startsWith("/v1/3dtiles/")) return Response.json({ error: "not here" }, { status: 404 });
      if (!up) await new Promise<void>((done) => held.push(done));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=60" } });
    },
  });
  const relayBefore = process.env.EDIT_RELAY_URL;
  const tokenBefore = process.env.EDIT_RELAY_TOKEN;
  process.env.EDIT_RELAY_URL = `http://127.0.0.1:${stand.port}`;
  // Signed out, no cloud: the tiles go to the relay all the same (a person's token when there is one).
  delete process.env.EDIT_RELAY_TOKEN;
  const { app, cleanup, id } = hq("effects-network", { width: 640, height: 360 });
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  effects.waits.quietMs = 1_500;
  effects.networkRetry.probeMs = 500;
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    // Ready once its one tile has come, as a map's find() is.
    const page = (ready: string) => `<!doctype html><body style="margin:0;background:#123"><script>
window.duration = 1;
window.ready = ${ready};
window.seek = () => {};
</script></body>`;
    const tile = (name: string) => `fetch("edit-map/v1/3dtiles/datasets/x/files/${name}.glb?session=s1").then((answer) => answer.arrayBuffer())`;
    // A look while it's down: the network's, said so, not "a Promise nothing resolves".
    write(app, id, "looked", { "scene.html": page(tile("a")) });
    const look = effects.look(app, id, "looked", [0.5]);
    await expect(look).rejects.toThrow("looked's page got nowhere for 1.5 s waiting on the network, with 1 of its map's tiles unanswered");
    await expect(look).rejects.toThrow("nothing in its code to fix");
    // One whose render alone asks for a tile, so it's added while the relay is down.
    write(app, id, "tiles", { "scene.html": page(`location.search.includes("render=") ? ${tile("b")} : Promise.resolve()`) });
    const { media } = await effects.add(app, id, "tiles");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 30, media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    await expect(seams.broll.waitForMaps(app, id, 90_000)).rejects.toThrow("The tiles effect couldn't render while the connection was down. It renders again by itself once it's back.");
    // Not the code's: the agent isn't asked to fix it, and what it reads says so.
    expect(await messageContext(app, id, null, true)).toBe("");
    expect(effects.renderLine(app, id, "tiles")).toContain("nothing in its code to fix, it renders again by itself once Edit's relay answers");
    // The relay back: the held tiles answer, and the render goes by itself, well inside the five minutes.
    up = true;
    for (const done of held.splice(0)) done();
    const key = effects.list(app.store, id).find((one) => one.name === "tiles")!.key;
    const until = Date.now() + 60_000;
    while (app.store.get(id)!.project.media.find((one) => one.id === media)!.effect_key !== key) {
      if (Date.now() > until) throw new Error(`not rendered again: ${effects.renderLine(app, id, "tiles")}`);
      await Bun.sleep(250);
    }
    expect(await messageContext(app, id, null, true)).toBe("");
  } finally {
    up = true;
    for (const done of held.splice(0)) done();
    effects.waits.quietMs = 15_000;
    effects.networkRetry.probeMs = 30_000;
    if (relayBefore === undefined) delete process.env.EDIT_RELAY_URL;
    else process.env.EDIT_RELAY_URL = relayBefore;
    if (tokenBefore === undefined) delete process.env.EDIT_RELAY_TOKEN;
    else process.env.EDIT_RELAY_TOKEN = tokenBefore;
    await server.stop(true);
    await stand.stop(true);
    cleanup();
  }
}, 180_000);

test.skipIf(chrome === null)("a render an export waits on goes on while footage is waited on and a play goes on: neither holds it for ever", async () => {
  // Nov 20: the graphic step sat at "rendering the cutfx-3 effect · 40 of 300 frames" for as long as anything played, or
  // for hours while a cloud project's footage came down (its page renews holdLink every 3 s), and the export failed.
  const { app, cleanup, id } = hq("effects-render-busy");
  const router = buildRouter();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => (await respond(app, router, request, null)) ?? new Response(null, { status: 404 }) });
  const first = effects.PLAY_FIRST_MS.value;
  effects.PLAY_FIRST_MS.value = 200;
  // Footage waited on, renewed as the page renews it; a play that never stops.
  playing.holdLink(id, 10_000);
  const renew = setInterval(() => playing.holdLink(id, 10_000), 50);
  playing.note("busy-play", true);
  const beat = setInterval(() => playing.note("busy-play", true), 50);
  try {
    app.port = server.port!;
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    write(app, id, "bar", { "scene.html": GOOD });
    const added = await effects.add(app, id, "bar");
    await app.store.update(id, "test", (project) => {
      project.tracks.push({ id: "t1", kind: "video", name: "V1", hidden: false, muted: false, locked: false } as unknown as (typeof project.tracks)[number]);
      project.clips.push({ id: "c1", type: "video", track: "t1", start: 0, duration: 60, media: added.media, source_in: 0 } as unknown as (typeof project.clips)[number]);
    });
    expect(playing.isIdle()).toBe(false);
    await seams.broll.waitForMaps(app, id, 150_000);
    expect(app.store.get(id)!.project.media.find((one) => one.id === added.media)!.effect_key).toBe(effects.list(app.store, id)[0]!.key);
  } finally {
    clearInterval(renew);
    clearInterval(beat);
    playing.note("busy-play", false);
    playing.releaseLink(id);
    effects.PLAY_FIRST_MS.value = first;
    void server.stop(true);
    cleanup();
  }
  // Its own limit, as the file's other renders in Chrome have: CI's Mac drew it inside the default 30 s once in three runs.
}, 180_000);
