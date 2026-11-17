// watermark_removal.ts and clean_strips.ts: a channel's see-through
// watermark taken out of its footage on the timeline by the engine, free: the
// cells of each file the timeline shows (fixed 30 s, so a clip extended later
// only does its new cells), each kept and never made twice (another project on
// the same footage reuses them), strips laid under a text strip of the same
// frames, and only a text strip ending the blur over their subtitles. The
// engine is a stand-in here (its own tests are Rust's: edit-engine watermark).

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { enforceCleanStrips, NAME, strippedFrames, WATERMARK_NAME } from "../src/clean_strips.ts";
import type { Media, Project, VideoClip } from "../src/model.ts";
import type { WatermarkPiece, WatermarkRemoved } from "../src/native/index.ts";
import { join } from "../src/paths.ts";
import * as tools from "../src/tools.ts";
import * as wm from "../src/watermark_removal.ts";
import { fixtureHome } from "./helpers/home.ts";

afterEach(() => {
  wm.useEngine(null);
  wm.useShelf(null);
  wm.reset();
});

test("cells: the fixed 30 s of each file the timeline shows, a second's handle each side, within the file", () => {
  expect(wm.cellsFor([[10, 20], [95, 100]], 120)).toEqual([[0, 30], [90, 120]]);
  // A handle crossing into the next cell takes it too; the file's end holds the last one in.
  expect(wm.cellsFor([[29.5, 31]], 45)).toEqual([[0, 30], [30, 45]]);
  expect(wm.cellsFor([[0, 12]], 12)).toEqual([[0, 12]]);
  // A kept cell's name reads back, for its own mark only.
  expect(wm.parseCell("30000-60000.watermark-abc123-3734-6167-6281-8417.mp4", "abc123")).toEqual({ from: 30, to: 60, box: [0.3734, 0.6167, 0.6281, 0.8417] });
  expect(wm.parseCell("0-30000.watermark-abc123-none.json", "abc123")).toEqual({ from: 0, to: 30, box: null });
  expect(wm.parseCell("0-30000.watermark-def456-none.json", "abc123")).toBeNull();
  expect(wm.parseCell("9000-31000.vmake-api.mp4", "abc123")).toBeNull();
});

/** A project: footage `m` on v1 in one clip, a blur over its subtitles, a text strip and a watermark strip of the same seconds. */
function stacked(): Project {
  const clip: VideoClip = { id: "c1", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 };
  const strip = (id: string, what: "text" | "watermark" | undefined, box: [number, number, number, number]): Media => ({
    id,
    name: id,
    path: `/tmp/${id}.mp4`,
    kind: "video",
    duration: 30,
    width: 640,
    height: 120,
    fps: 30,
    has_audio: false,
    stacked_alpha: true,
    cleans: { media: "m", from: 0, to: 30, box, ...(what === undefined ? {} : { what }) },
  });
  return {
    id: "p",
    name: "p",
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
      { id: "v2", kind: "video", hidden: false, muted: false, locked: false },
    ],
    media: [{ id: "m", name: "tape", path: "/tmp/tape.mp4", kind: "video", duration: 60, width: 1280, height: 720, fps: 30, has_audio: false }, strip("t", undefined, [0, 0.8, 1, 1]), strip("w", "watermark", [0.37, 0.61, 0.63, 0.84])],
    clips: [clip, { id: "blur", track: "v2", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "adjustment", name: "Burned-in cover · c1", parent: "c1" } as unknown as Project["clips"][number]],
    next_id: 10,
  } as unknown as Project;
}

test("a watermark strip lies under a text strip of the same frames, both stuck to the clip; only the text strip ends the subtitles' blur", () => {
  const project = stacked();
  enforceCleanStrips(null, project);
  const text = project.clips.find((clip) => (clip.name ?? "").startsWith(`${NAME} · `)) as VideoClip;
  const mark = project.clips.find((clip) => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `)) as VideoClip;
  expect(text).toMatchObject({ media: "t", parent: "c1", start: 0, duration: 300 });
  expect(mark).toMatchObject({ media: "w", parent: "c1", start: 0, duration: 300 });
  const lane = (id: string) => project.tracks.findIndex((track) => track.id === id);
  expect(lane("v1")).toBeLessThan(lane(mark.track));
  expect(lane(mark.track)).toBeLessThan(lane(text.track));
  // The text strip ended the blur; the frames counted as stripped are the text strip's only.
  expect(project.clips.some((clip) => clip.id === "blur")).toBe(false);
  expect(strippedFrames(project).get("c1")).toEqual([[0, 300]]);
  // Saved again: nothing changes.
  const again = structuredClone(project);
  enforceCleanStrips(project, again);
  expect(again).toEqual(project);
  // With only a watermark strip, the blur over their subtitles stays.
  const alone = stacked();
  alone.media = alone.media.filter((media) => media.id !== "t");
  enforceCleanStrips(null, alone);
  expect(alone.clips.some((clip) => clip.id === "blur")).toBe(true);
  expect(strippedFrames(alone).size).toBe(0);
  expect(alone.clips.filter((clip) => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `)).length).toBe(1);
});

/** A stand-in engine: each piece a small stacked strip as long as the piece, or nothing where `absent` says. */
function standIn(calls: WatermarkPiece[], absent: (from: number) => boolean = () => false): wm.Engine {
  return {
    async learn() {
      return JSON.stringify({ version: 1, stand: "in" });
    },
    async remove(piece): Promise<WatermarkRemoved | null> {
      calls.push(piece);
      if (absent(piece.from)) return null;
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:size=64x64:rate=30:duration=${piece.to - piece.from}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", piece.out]);
      return { region: [0.37, 0.61, 0.63, 0.84], frames: Math.round((piece.to - piece.from) * 30), marked: 1, filled: 0.9, left: 0.08, took: 1 };
    },
  };
}

/** A project of `channel` with `file` on its timeline from 0 for `seconds`. */
async function project(app: App, file: string, seconds: number, channel: string | undefined, name = "p"): Promise<string> {
  const live = app.store.create(name, { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  project.media = [{ id: "m", name: "tape", path: file, kind: "video", duration: 70, width: 1280, height: 720, fps: 30, has_audio: false }];
  project.clips = [{ id: "f", track: "v1", start: 0, duration: Math.round(seconds * 30), color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }];
  if (channel !== undefined) project.channel = channel;
  await app.store.replace(project.id, null, project, "test");
  return project.id;
}

test("a taught channel's footage is cleaned cell by cell: once, the new cells only when a clip grows, reused by another project, nothing where it isn't", async () => {
  const { app, dir, store, cleanup } = fixtureHome("watermark-run");
  const calls: WatermarkPiece[] = [];
  wm.useEngine(standIn(calls, (from) => from === 60));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = join(dir, "tape.mp4");
    fs.writeFileSync(file, "a stand-in tape");
    fs.mkdirSync(join(app.store.cacheDir(), "watermarks"), { recursive: true });
    fs.writeFileSync(join(app.store.cacheDir(), "watermarks", "ch.json"), JSON.stringify({ version: 1, matte: "…" }));
    const id = await project(app, file, 40, "ch");
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.map((piece) => [piece.from, piece.to])).toEqual([[0, 30], [30, 60]]);
    expect(calls[0]).toMatchObject({ size: [1280, 720], fps: 30, model: JSON.stringify({ version: 1, matte: "…" }) });
    const strips = store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark");
    expect(strips.map((media) => [media.cleans!.from, media.cleans!.to])).toEqual([[0, 30], [30, 60]]);
    expect(strips[0]).toMatchObject({ stacked_alpha: true, has_audio: false, cleans: { media: "m", box: [0.37, 0.61, 0.63, 0.84] } });
    expect(store.get(id)!.project.clips.filter((clip) => (clip.name ?? "").startsWith(`${WATERMARK_NAME} · `)).length).toBe(2);
    expect(wm.piecesOf(id).map((piece) => [piece.from, piece.state, piece.left])).toEqual([[0, "done", 0.08], [30, "done", 0.08]]);
    // Again: nothing new.
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.length).toBe(2);
    // The clip grows to 70 s: only the new cell, where the mark isn't (kept as nothing, never asked again).
    const grown = structuredClone(store.get(id)!.project);
    (grown.clips.find((clip) => clip.id === "f") as VideoClip).duration = 70 * 30;
    await app.store.replace(id, null, grown, "test");
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.map((piece) => piece.from)).toEqual([0, 30, 60]);
    await wm.ensure(app, id);
    await wm.settled();
    expect(calls.length).toBe(3);
    // Another project on the same footage: the kept cells, nothing made.
    const other = await project(app, file, 70, "ch", "q");
    await wm.ensure(app, other);
    await wm.settled();
    expect(calls.length).toBe(3);
    expect(store.get(other)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(2);
    // A channel taught no mark, or no channel: nothing.
    await wm.ensure(app, await project(app, file, 70, "other", "r"));
    await wm.ensure(app, await project(app, file, 70, undefined, "s"));
    await wm.settled();
    expect(calls.length).toBe(3);
  } finally {
    cleanup();
  }
}, 60_000);

/**
 * Real footage through the product path (`EDIT_WATERMARK_REAL`: a file with a re-uploader's see-through mark, e.g.
 * Tulsa's 35 min; `EDIT_WATERMARK_AT`: seconds into it of 10 s on the timeline; `EDIT_WATERMARK_OUT`: a folder for the
 * strips): the real addon learns the mark from the whole file and cleans the timeline's cells. Signed out: nothing
 * reaches the cloud.
 */
test.skipIf(process.env.EDIT_WATERMARK_REAL === undefined)("real footage: the mark learned and the timeline's cells cleaned by the engine", async () => {
  const { useNative, initNative, isReal } = await import("../src/native/index.ts");
  const { app, store, cleanup } = fixtureHome("watermark-real");
  const previous = useNative(null);
  try {
    initNative({ home: app.store.home, cacheDir: app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe() });
    expect(isReal()).toBe(true);
    const source = process.env.EDIT_WATERMARK_REAL!;
    const probed = await (await import("../src/media.ts")).probe(source);
    const media: Media = { id: "m", name: "footage", path: source, kind: "video", duration: probed.duration, width: probed.width, height: probed.height, fps: probed.fps, has_audio: false };
    const live = app.store.create("real", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    project.media = [media];
    project.clips = [{ id: "f", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: Number(process.env.EDIT_WATERMARK_AT ?? "0"), speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }];
    project.channel = "real-test";
    await app.store.replace(project.id, null, project, "test");
    let started = Date.now();
    const model = await wm.learn(app, "real-test", media, null);
    const learned = JSON.parse(model.json) as { gamma: number; white: number; strength: number; at: number[] };
    console.log(`learned in ${((Date.now() - started) / 1000).toFixed(1)} s: gamma ${learned.gamma} white ${learned.white.toFixed(3)} strength ${learned.strength.toFixed(3)} at ${learned.at}`);
    started = Date.now();
    await wm.ensure(app, project.id);
    await wm.settled();
    console.log(`cleaned in ${((Date.now() - started) / 1000).toFixed(1)} s: ${JSON.stringify(wm.piecesOf(project.id))}`);
    const strips = store.get(project.id)!.project.media.filter((one) => one.cleans?.what === "watermark");
    expect(strips.length).toBeGreaterThan(0);
    const out = process.env.EDIT_WATERMARK_OUT;
    if (out !== undefined) {
      fs.mkdirSync(out, { recursive: true });
      for (const strip of strips) fs.copyFileSync(strip.path, join(out, `strip-${strip.cleans!.from}.mp4`));
      fs.writeFileSync(join(out, "strips.json"), JSON.stringify(strips.map((strip) => strip.cleans)));
    }
  } finally {
    useNative(previous);
    cleanup();
  }
}, 1_800_000);
