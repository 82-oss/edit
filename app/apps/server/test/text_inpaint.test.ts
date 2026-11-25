// text_inpaint.ts: their subtitles taken out by the model in the intro and first cases (where this machine has it):
// a stretch's frames and names, a cleaned stretch laid as a strip and kept on the shelf so another project lays it
// with nothing run again, the blur off where a strip covers; and the worker's own streaming (minimax_worker.py) with a
// stand-in model: every frame of the stretch out, see-through where there are no words, the model given only the
// chunks with words in them.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { Media, Project } from "../src/model.ts";
import type { Box } from "../src/native/index.ts";
import { join } from "../src/paths.ts";
import * as cloud from "../src/cloud.ts";
import * as inpaint from "../src/text_inpaint.ts";
import * as removerCloud from "../src/remover_cloud.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

afterEach(() => {
  inpaint.useCleaner(null);
  inpaint.reset();
});

test("a stretch's frames are the file's own at its rate; a kept strip's name gives back its seconds and box", () => {
  expect(inpaint.framesOf(1.0, 3.0, 30)).toEqual({ first: 30, frames: 60 });
  // 29.97: the frame on screen at the second (the one before it: 299.7), through the last before its end.
  expect(inpaint.framesOf(10, 12, 30000 / 1001)).toEqual({ first: 299, frames: 61 });
  // A clip starting between two frames (218.28 s at 30: frame 6548.4) shows frame 6548, so the stretch starts there.
  expect(inpaint.framesOf(218.28, 222.81, 30).first).toBe(6548);
  const box: Box = [0, 0.55, 1, 0.92];
  const name = inpaint.stripName(1, 3, box);
  expect(inpaint.parseStrip(name)).toEqual({ from: 1, to: 3, box, under: "" });
  expect(inpaint.parseStrip(inpaint.stripName(1, 3, null))).toEqual({ from: 1, to: 3, box: null, under: "" });
  // Their watermark's box marked there is in its name too (a mark added later makes it again); none there, as before.
  const mark = { from: 2, to: 4, box: [0.1, 0.5, 0.3, 0.6] as Box };
  expect(inpaint.underWith("", [mark], 5, 8)).toBe("");
  expect(inpaint.underWith("ab12cd34ef", [], 1, 3)).toBe("ab12cd34ef");
  expect(inpaint.underWith("", [mark], 1, 3)).toMatch(/^[0-9a-f]{10}$/u);
  expect(inpaint.underWith("", [mark], 1, 3)).not.toBe(inpaint.underWith("", [{ ...mark, box: [0.1, 0.5, 0.35, 0.6] }], 1, 3));
  // Cleaned over their watermark strips: which ones is in its name, so a watermark done again makes it again.
  expect(inpaint.parseStrip(inpaint.stripName(1, 3, box, "ab12cd34ef"))).toEqual({ from: 1, to: 3, box, under: "ab12cd34ef" });
  const wm = (path: string, from: number) => ({ id: path, path, cleans: { media: "m1", from, to: from + 30, box: [0, 0.8, 1, 1] as Box, what: "watermark" as const } }) as unknown as Media;
  const one = inpaint.beneathOf({ media: [wm("/c/0-30.watermark-a.mp4", 0), wm("/c/30-60.watermark-a.mp4", 30)] }, "m1", 25, 35);
  expect(one.strips.map((strip) => strip.from)).toEqual([0, 30]);
  expect(one.under).toMatch(/^[0-9a-f]{10}$/u);
  expect(inpaint.beneathOf({ media: [wm("/c/0-30.watermark-b.mp4", 0)] }, "m1", 25, 35).under).not.toBe(one.under);
  expect(inpaint.beneathOf({ media: [] }, "m1", 25, 35)).toEqual({ strips: [], under: "" });
  // Which strips of a file are current: told by name, as a strip backed up to the cloud is read from a URL of its name.
  const strip = (name: string) => ({ id: "s", name, path: "http://127.0.0.1:7790/api/cloud/preview?key=edit%2Fexports%2Fx", cleans: { media: "m1", from: 1, to: 3, box, what: "text" } }) as unknown as Media;
  expect(inpaint.current({ media: [strip(inpaint.nameOf("tape.mp4", 1, 3, ""))] }, "m1", 1, 3, "")).toBe(true);
  // Made over a watermark done since, or before the watermark fix (no tag): made again.
  expect(inpaint.current({ media: [strip(inpaint.nameOf("tape.mp4", 1, 3, "ab12cd34ef"))] }, "m1", 1, 3, "")).toBe(false);
  expect(inpaint.current({ media: [strip("tape.mp4 · their subtitles out 1–3 s")] }, "m1", 1, 3, "")).toBe(false);
  // Another's (Vmake's, from before Nov 19) stays as it was.
  expect(inpaint.current({ media: [strip("tape.mp4 · their text out 1–3 s · Smart")] }, "m1", 1, 3, "")).toBe(true);
  // Legacy v2 strip: stays current when its box covers the tracked y-range, re-cleans when mid-screen captions sit above it.
  const v2Clipped = { ...strip(inpaint.nameOf("tape.mp4", 1, 3, "", 2)), cleans: { media: "m1", from: 1, to: 3, box: [0, 0.5167, 1, 1] as Box, what: "text" as const } } as unknown as Media;
  expect(inpaint.current({ media: [v2Clipped] }, "m1", 1, 3, "", [0.85, 0.96])).toBe(true);
  expect(inpaint.current({ media: [v2Clipped] }, "m1", 1, 3, "", [0.42, 0.96])).toBe(false);
  // Newly produced v3 strip stays current even if its box is narrower than yRange (never re-enqueues on subsequent saves).
  const v3Narrow = { ...strip(inpaint.nameOf("tape.mp4", 1, 3, "", 3)), cleans: { media: "m1", from: 1, to: 3, box: [0, 0.6, 1, 0.9] as Box, what: "text" as const } } as unknown as Media;
  expect(inpaint.current({ media: [v3Narrow] }, "m1", 1, 3, "", [0.42, 0.96])).toBe(true);
  // Another version's or another kind's isn't this one's.
  expect(inpaint.parseStrip("1000-3000.watermark-abc-none.json")).toBeNull();
  expect(inpaint.pixelsOf([[[0.1, 0.8, 0.9, 0.9]], []], 1920, 1080)).toEqual([[[192, 864, 1728, 972]], []]);
});

test("migration & save-time fast path: current strips never expand masksOf, v2 shelf hits preserve v2 tag until tracked, narrow v3 never re-enqueues, and reject clears v2+v3 shelf entries", async () => {
  const { app, cleanup } = fixtureHome("text-inpaint-migration");
  try {
    let cleanCalls = 0;
    let maskCalls = 0;
    let returnBox: Box = [0, 0.6, 1, 0.9];
    inpaint.useCleaner({
      async clean(request) {
        cleanCalls++;
        await fakeStrip(request.out, request.masks.length, 64, 20, request.fps);
        return { ok: true, box: returnBox, inferred: request.masks.length };
      },
    });
    const source = "r2:footage/smartcops.mp4";
    const footage = media({ id: "m1", name: "bodycam.mp4", path: join(app.store.home, "bodycam.mp4"), kind: "video", duration: 10, width: 64, height: 36, fps: 30, cloud: { source, original: "", size: 0 } }) as Media;
    const created = app.store.create("M", { width: 1280, height: 720, fps: 30 }).project as Project;
    await app.store.update(created.id, "test", (project) => {
      project.media.push(footage);
      project.clips.push(clip({ id: "c1", type: "video", media: "m1", track: project.tracks[0]!.id, start: 0, duration: 300, source_in: 0, speed: 1 }));
    });
    const plan = [{ media: footage, source, spans: [[1, 3]] as [number, number][] }];
    const masksOf: inpaint.MasksOf = (_s, _f, _t, _fps, _first, frames) => {
      maskCalls++;
      return Array.from({ length: frames }, (): Box[] => [[0.1, 0.42, 0.9, 0.95]]);
    };
    // Put a legacy v2 strip with box [0, 0.5167, 1, 1] on the shelf before tracking completes.
    const { createHash } = await import("node:crypto");
    const folder = createHash("sha256").update(source).digest("hex").slice(0, 32);
    const shelfDir = join(app.store.cacheDir(), "cleaned", folder);
    fs.mkdirSync(shelfDir, { recursive: true });
    const v2File = join(shelfDir, "1000-3000.minimax-v2-0-5167-10000-10000.mp4");
    await fakeStrip(v2File, 60, 64, 20, 30);

    // 0. A plan its caller no longer stands by when its turn comes (a Stop of their text since): nothing placed.
    await inpaint.ensure(app, created.id, plan, masksOf, () => undefined, () => false);
    await inpaint.settled();
    expect(app.store.get(created.id)!.project.media.filter((one) => one.cleans != null)).toEqual([]);
    // Standing at its turn, then a Stop while it looks on the shelf: still nothing placed.
    let asked = 0;
    await inpaint.ensure(app, created.id, plan, masksOf, () => undefined, () => asked++ === 0);
    await inpaint.settled();
    expect(asked).toBeGreaterThan(1);
    expect(app.store.get(created.id)!.project.media.filter((one) => one.cleans != null)).toEqual([]);
    // A Stop while a kept strip is being laid (its probe, a play): not laid either.
    asked = 0;
    await inpaint.ensure(app, created.id, plan, masksOf, () => undefined, () => asked++ < 2);
    await inpaint.settled();
    expect(asked).toBeGreaterThan(2);
    expect(app.store.get(created.id)!.project.media.filter((one) => one.cleans != null)).toEqual([]);

    // 1. While track range is undefined, v2 shelf hit is placed AND keeps its v2 tag (never promoted to v3).
    await inpaint.ensure(app, created.id, plan, masksOf, () => undefined);
    await inpaint.settled();
    expect(cleanCalls).toBe(0);
    expect(maskCalls).toBe(0);
    const placedV2 = app.store.get(created.id)!.project.media.find((one) => one.cleans != null)!;
    expect(placedV2.name).toContain(" · v2");
    expect(placedV2.name).not.toContain(" · v3");

    // 2. If track range fits inside v2 box, save-time ensure skips masksOf completely (no frame expansion stall).
    await inpaint.ensure(app, created.id, plan, masksOf, () => [0.8, 0.95]);
    await inpaint.settled();
    expect(cleanCalls).toBe(0);
    expect(maskCalls).toBe(0);

    // 3. Once track finishes with mid-screen captions [0.42, 0.95] above v2's 0.5167, it upgrades to v3.
    //    Even if the cleaner returns a box narrower than [0.42, 0.95], subsequent saves NEVER re-enqueue it or call masksOf!
    returnBox = [0, 0.6, 1, 0.9];
    await inpaint.ensure(app, created.id, plan, masksOf, () => [0.42, 0.95]);
    await inpaint.settled();
    expect(cleanCalls).toBe(1);
    expect(maskCalls).toBe(1);
    const placedV3 = app.store.get(created.id)!.project.media.find((one) => one.cleans != null)!;
    expect(placedV3.name).toContain(" · v3");
    await inpaint.ensure(app, created.id, plan, masksOf, () => [0.42, 0.95]);
    await inpaint.settled();
    expect(cleanCalls).toBe(1);
    expect(maskCalls).toBe(1);

    // 4. reject() clears BOTH v2 and v3 shelf entries so a rejected strip cannot be restored from the v2 shelf entry.
    const pieceKey = inpaint.piecesOf(created.id)[0]!.key;
    await inpaint.reject(app, created.id, pieceKey, "still has captions");
    expect(fs.existsSync(v2File)).toBe(false);
    expect(fs.readdirSync(shelfDir)).toEqual([]);
  } finally {
    cleanup();
  }
});

/** A stacked strip of `frames` frames, `width` × 2·`height` (what the worker writes). */
async function fakeStrip(out: string, frames: number, width: number, height: number, fps: number): Promise<void> {
  await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=${width}x${height * 2}:r=${fps}`, "-frames:v", String(frames), "-pix_fmt", "yuv420p", out]);
}

test("a cleaned stretch is laid as a strip over its file's seconds and kept: a second project of the same footage lays it with nothing run, and the blur is off under it", async () => {
  const { app, cleanup } = fixtureHome("text-inpaint");
  try {
    const calls: { from: number; frames: number; boxes: number }[] = [];
    inpaint.useCleaner({
      async clean(request) {
        calls.push({ from: request.from, frames: request.masks.length, boxes: request.masks.filter((one) => one.length > 0).length });
        await fakeStrip(request.out, request.masks.length, 64, 20, request.fps);
        return { ok: true, box: [0, 0.6, 1, 0.9], inferred: request.masks.length };
      },
    });
    const footage = media({ id: "m1", name: "bodycam.mp4", path: join(app.store.home, "bodycam.mp4"), kind: "video", duration: 10, width: 64, height: 36, fps: 30 }) as Media;
    const make = async (name: string) => {
      const created = app.store.create(name, { width: 1280, height: 720, fps: 30 }).project as Project;
      await app.store.update(created.id, "test", (project) => {
        project.media.push(footage);
        project.clips.push(clip({ id: "c1", type: "video", media: "m1", track: project.tracks[0]!.id, start: 0, duration: 300, source_in: 0, speed: 1 }));
      });
      return created;
    };
    const first = await make("A");
    const plan = [{ media: footage, source: "r2:footage/bodycam.mp4", spans: [[1, 3]] as [number, number][] }];
    let tracked = false;
    const masksOf: inpaint.MasksOf = (_source, _from, _to, _fps, _first, frames) => (tracked ? Array.from({ length: frames }, (_, k): Box[] => (k < 30 ? [[0.1, 0.8, 0.9, 0.9]] : [])) : null);
    // Not tracked yet: it waits (blurred meanwhile), nothing out for an export beyond the track itself.
    await inpaint.ensure(app, first.id, plan, masksOf);
    expect(inpaint.piecesOf(first.id).map((one) => one.state)).toEqual(["waiting"]);
    expect(inpaint.outOf(first.id)).toBe(0);
    tracked = true;
    await inpaint.ensure(app, first.id, plan, masksOf);
    await inpaint.settled();
    expect(calls).toEqual([{ from: 1, frames: 60, boxes: 30 }]);
    const strip = app.store.get(first.id)!.project.media.find((one) => one.cleans != null)!;
    expect(strip.cleans).toEqual({ media: "m1", from: 1, to: 3, box: [0, 0.6, 1, 0.9], what: "text" });
    expect(strip.stacked_alpha).toBe(true);
    expect(inpaint.piecesOf(first.id).map((one) => one.state)).toEqual(["done"]);
    // The tracked blur gives way under it, and only there.
    expect(inpaint.stripCovers(app.store.get(first.id)!.project, "m1", 1, 3)).toBe(true);
    expect(inpaint.stripCovers(app.store.get(first.id)!.project, "m1", 3, 5)).toBe(false);
    // Asked again and again at once (an edit resting as a track finishes): the stretch is cleaned once.
    const twice = await make("C");
    await app.store.update(twice.id, "test", (project) => void (project.media = project.media.filter((one) => one.cleans == null)));
    const otherPlan = [{ ...plan[0]!, source: "r2:footage/other.mp4" }];
    await Promise.all([inpaint.ensure(app, twice.id, otherPlan, masksOf), inpaint.ensure(app, twice.id, otherPlan, masksOf), inpaint.ensure(app, twice.id, otherPlan, masksOf)]);
    await inpaint.settled();
    expect(calls.length).toBe(2);
    // Another project of the same footage: laid from the shelf, the model never asked.
    const second = await make("B");
    await inpaint.ensure(app, second.id, plan, masksOf);
    await inpaint.settled();
    expect(calls.length).toBe(2);
    expect(app.store.get(second.id)!.project.media.find((one) => one.cleans != null)?.cleans?.from).toBe(1);
    expect(fs.existsSync(strip.path)).toBe(true);
  } finally {
    cleanup();
  }
});

test("a stretch the model fails on stays blurred: tried once more, then left, said why", async () => {
  const { app, cleanup } = fixtureHome("text-inpaint-fail");
  try {
    let asked = 0;
    inpaint.useCleaner({ clean: async () => (asked++, { ok: false, error: "CUDA out of memory" }) });
    const footage = media({ id: "m1", name: "tape.mp4", path: join(app.store.home, "tape.mp4"), kind: "video", duration: 10, width: 64, height: 36, fps: 30 }) as Media;
    const created = app.store.create("A", { width: 1280, height: 720, fps: 30 }).project as Project;
    await app.store.update(created.id, "test", (project) => void project.media.push(footage));
    const plan = [{ media: footage, source: "sha256:abc", spans: [[0, 2]] as [number, number][] }];
    const masksOf: inpaint.MasksOf = (_s, _f, _t, _fps, _first, frames) => Array.from({ length: frames }, (): Box[] => [[0.1, 0.8, 0.9, 0.9]]);
    for (let round = 0; round < 4; round++) {
      await inpaint.ensure(app, created.id, plan, masksOf);
      await inpaint.settled();
    }
    expect(asked).toBe(2);
    const [piece] = inpaint.piecesOf(created.id);
    expect(piece!.state).toBe("failed");
    expect(piece!.why).toContain("CUDA out of memory");
    expect(app.store.get(created.id)!.project.media.some((one) => one.cleans != null)).toBe(false);
  } finally {
    cleanup();
  }
});

test("two stretches of a video from the same second are made in files of their own", async () => {
  const { app, cleanup } = fixtureHome("text-inpaint-same-start");
  try {
    const outs: string[] = [];
    inpaint.useCleaner({ clean: async (request) => (outs.push(request.out), { ok: false, error: "stand-in" }) });
    const footage = media({ id: "m1", name: "tape.mp4", path: join(app.store.home, "tape.mp4"), kind: "video", duration: 10, width: 64, height: 36, fps: 30 }) as Media;
    const created = app.store.create("A", { width: 1280, height: 720, fps: 30 }).project as Project;
    await app.store.update(created.id, "test", (project) => void project.media.push(footage));
    const plan = [{ media: footage, source: "sha256:abc", spans: [[0, 2], [0, 3]] as [number, number][] }];
    const masksOf: inpaint.MasksOf = (_s, _f, _t, _fps, _first, frames) => Array.from({ length: frames }, (): Box[] => [[0.1, 0.8, 0.9, 0.9]]);
    await inpaint.ensure(app, created.id, plan, masksOf);
    await inpaint.settled();
    expect(outs.length).toBe(2);
    expect(new Set(outs).size).toBe(2);
  } finally {
    cleanup();
  }
});

const PYTHON = join(inpaint.REMOVER, "venv", "bin", "python");

test.skipIf(!fs.existsSync(PYTHON))("the worker streams a stretch through a stand-in model: every frame out at its size, see-through without words, only chunks with words given to the model, seams crossfaded", async () => {
  const { app, cleanup } = fixtureHome("text-inpaint-worker");
  try {
    const dir = app.store.home;
    const input = join(dir, "in.mp4");
    // 150 frames at 30 fps, 320×180, a pattern that changes every frame.
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30", "-frames:v", "150", "-pix_fmt", "yuv420p", input]);
    // Words in frames 70–99 only, a line low in the picture.
    const masks = Array.from({ length: 120 }, (_, k) => (k >= 70 && k < 100 ? [[40, 140, 280, 160]] : []));
    // Their watermark taken out underneath (a stacked strip: solid red over full alpha, the picture's lower third), from source 1.0 s.
    const under = join(dir, "watermark.mp4");
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x60:r=30", "-f", "lavfi", "-i", "color=c=white:s=320x60:r=30", "-filter_complex", "[0:v][1:v]vstack", "-frames:v", "150", "-pix_fmt", "yuv420p", under]);
    const request = { input, input_args: [], from: 0.5, fps: 30, width: 320, height: 180, matrix: "bt601", masks, out: join(dir, "strip.mp4"), ffmpeg: tools.ffmpeg(), beneath: [{ file: under, from: 1.0, box: [0, 2 / 3, 1, 1] }] };
    const script = `
import json, sys, numpy as np
sys.path.insert(0, ${JSON.stringify(join(import.meta.dir, "..", "src"))})
import minimax_worker as w
class Fake:
    calls = []
    red = []
    def infer(self, images, masks):
        Fake.calls.append(len(images))
        # The lower rows of the band at the chunk's first frame (source 2.37 s: the watermark strip laid there) and its
        # last real one: red, as the strip, not the test pattern.
        Fake.red.append([int(v) for v in images[0, -4:, :, :].reshape(-1, 3).mean(axis=0)])
        return np.full(images.shape, 200, np.uint8)
req = json.loads(sys.stdin.read())
out = w.clean(Fake(), req)
print(json.dumps({**out, "calls": Fake.calls, "red": Fake.red}))
`;
    const run = Bun.spawnSync([PYTHON, "-I", "-c", script], { stdin: new TextEncoder().encode(JSON.stringify(request)), stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const answer = JSON.parse(new TextDecoder().decode(run.stdout).trim().split("\n").at(-1)!) as { box: Box; inferred: number; calls: number[]; red: number[][] };
    // The band of the words (rows round 140–160, with room round them), the whole width.
    expect(answer.box[0]).toBe(0);
    expect(answer.box[2]).toBe(1);
    expect(answer.box[1]).toBeLessThan(140 / 180);
    expect(answer.box[3]).toBeGreaterThan(160 / 180);
    // Chunks of 61 overlapping by 5: [0, 61) has none, [56, 117) has them all, [112, 120) none: one call, of 61 frames.
    expect(answer.calls).toEqual([61]);
    // The model was given the picture with their watermark already out (the red strip), not the original under it.
    const [r, g, b] = answer.red[0]!;
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    const bandHigh = Math.round((answer.box[3] - answer.box[1]) * 180);
    const frames = new Uint8Array(await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", request.out, "-f", "rawvideo", "-pix_fmt", "gray", "-"]));
    const size = 320 * bandHigh * 2;
    expect(frames.length / size).toBe(120);
    // The alpha (the lower half) at the middle of the words' box: on in frames 70–99, off elsewhere.
    const alphaAt = (frame: number) => frames[frame * size + (bandHigh + Math.round(150 - answer.box[1] * 180)) * 320 + 160]!;
    expect(alphaAt(10)).toBeLessThan(20);
    expect(alphaAt(85)).toBeGreaterThan(230);
    expect(alphaAt(110)).toBeLessThan(20);
  } finally {
    cleanup();
  }
});

test("which stretches the model takes: none where this machine hasn't it; in a video of one case, every marked stretch", async () => {
  const { inpaintPlan } = await import("../src/text_removal.ts");
  const footage = media({ id: "m1", name: "tape.mp4", path: "/x/tape.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30 }) as Media;
  const project = { id: "p", name: "p", settings: { width: 1920, height: 1080, fps: 30 }, tracks: [{ id: "v1", kind: "video" }], media: [footage], clips: [clip({ id: "c1", type: "video", media: "m1", track: "v1", start: 0, duration: 1800, source_in: 0, speed: 1 })] } as unknown as Project;
  const plans = [{ media: footage, source: "s", spans: [[2, 4], [30, 33]] as [number, number][], band: null, labels: [], avoid: [], subtitles: true, text: false }];
  // Not on this machine (tests never count the real model): all blurred.
  expect(inpaintPlan(project, plans)).toEqual([]);
  inpaint.useCleaner({ clean: async () => ({ ok: false }) });
  expect(inpaintPlan(project, plans).map((one) => one.spans)).toEqual([[[2, 4], [30, 33]]]);
});

test("a stretch still running when the plan is made again, and kept in it, stays wanted while the rest are looked at (CodeRabbit on #5: it was thrown away as stopped)", async () => {
  const { app, cleanup } = fixtureHome("text-inpaint-kept-running");
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let wanted: (() => boolean) | undefined;
    inpaint.useCleaner({
      clean: async (request) => {
        if (wanted === undefined) {
          wanted = request.wanted;
          await gate;
        }
        return { ok: false, error: "stand-in" };
      },
    });
    const footage = media({ id: "m1", name: "tape.mp4", path: join(app.store.home, "tape.mp4"), kind: "video", duration: 10, width: 64, height: 36, fps: 30 }) as Media;
    const created = app.store.create("A", { width: 1280, height: 720, fps: 30 }).project as Project;
    await app.store.update(created.id, "test", (project) => void project.media.push(footage));
    const masksOf: inpaint.MasksOf = (_s, _f, _t, _fps, _first, frames) => Array.from({ length: frames }, (): Box[] => [[0.1, 0.8, 0.9, 0.9]]);
    await inpaint.ensure(app, created.id, [{ media: footage, source: "sha256:abc", spans: [[0, 2]] }], masksOf);
    while (wanted === undefined) await Bun.sleep(1);
    // Planned again with a new stretch looked at first and the running one kept: while the new one is looked at (its
    // seconds asked for, before the shelf is read), the running one is still wanted.
    const seen: boolean[] = [];
    const rangeOf: inpaint.RangeOf = (_source, from) => {
      if (from === 4) seen.push(wanted!());
      return undefined;
    };
    await inpaint.ensure(app, created.id, [{ media: footage, source: "sha256:abc", spans: [[4, 6], [0, 2]] }], masksOf, rangeOf);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    release();
    await inpaint.settled();
  } finally {
    cleanup();
  }
});

// Nov 25, the reviews of turning local-first on: a stretch of footage whose original was still going up from here was
// sent to RunPod for a key R2 hadn't got, and failed ("the footage isn't in the cloud yet"), blurred for good.
test("on RunPod, a stretch of footage whose original is still going up from here waits for it, sending nothing", async () => {
  const { app, cleanup } = fixtureHome("text-inpaint-going-up");
  const key = "edit/originals/youtube/inpaintUp01/clip.mp4";
  removerCloud.setOnForTests(true);
  cloud.goingUp(key);
  try {
    const footage = media({ id: "m1", name: "clip.mp4", path: join(app.store.home, "clip.mp4"), kind: "video", duration: 10, width: 64, height: 36, fps: 30, cloud: { source: "youtube:inpaintUp01", original: key, proxy: key, size: 1 } }) as Media;
    const created = app.store.create("A", { width: 1280, height: 720, fps: 30 }).project as Project;
    await app.store.update(created.id, "test", (project) => void project.media.push(footage));
    const plan = [{ media: footage, source: "youtube:inpaintUp01", spans: [[0, 2]] as [number, number][] }];
    let asked = 0;
    const masksOf: inpaint.MasksOf = (_s, _f, _t, _fps, _first, frames) => (asked++, Array.from({ length: frames }, (): Box[] => [[0.1, 0.8, 0.9, 0.9]]));
    await inpaint.ensure(app, created.id, plan, masksOf);
    await inpaint.settled();
    expect(inpaint.piecesOf(created.id).map((one) => one.state)).toEqual(["waiting"]);
    expect(asked).toBe(0);
  } finally {
    cloud.upEnded(key, false);
    removerCloud.setOnForTests(null);
    cleanup();
  }
});
