// text_blur.ts: the Gaussian blur tracked over their text (a taught
// channel's, in every section, where the agent marked): read three times a second and
// halved at each change, its box following the words (moving with them,
// both boxes across a change, off with none), laid through the clip's own
// framing, kept as it is when nothing changed; and, with the real engine, a
// moving line of words read and blurred where it is in each rendered frame.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import { strippedFrames } from "../src/clean_strips.ts";
import type { AdjustmentClip, Media, Project, VideoClip } from "../src/model.ts";
import type { Box, ScreenText } from "../src/native/index.ts";
import { join } from "../src/paths.ts";
import { sample } from "../src/project.ts";
import { jsonForSerde } from "../src/rust.ts";
import * as blur from "../src/text_blur.ts";
import { labelBoxes } from "../src/text_removal.ts";
import * as tools from "../src/tools.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

afterEach(() => blur.reset());

const plan = { band: [0.2, 0.8, 0.8, 0.95] as Box, labels: [], avoid: [[0.6, 0, 1, 0.08] as Box], subtitles: true, text: false };

/** A stand-in screen: a subtitle sliding right 0.1 a second from 0.2 until 2.0 s, another line from 2.0 to 3.0 s, nothing after; the camera's stamp up top always. */
function screen(t: number): ScreenText[] {
  const stamp: ScreenText = { b: [0.65, 0.02, 0.95, 0.06], t: "2024-01-23 14:01:43" };
  if (t < 2) return [stamp, { b: [0.3 + 0.1 * t, 0.84, 0.5 + 0.1 * t, 0.9], t: "The suspect ran away" }];
  if (t < 3) return [stamp, { b: [0.25, 0.82, 0.75, 0.92], t: "Get on the ground now" }];
  return [stamp];
}

test("a tracked blur sits just above its own clip, never over our captions on a lane that also holds a picture (Nov 19, the Boyfriends intro: Kelly's captions blurred)", () => {
  const clip = (one: Record<string, unknown>) => ({ color: "blue", fade_in: 0, fade_out: 0, opacity: 1, ...one }) as unknown as Project["clips"][number];
  const project = {
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [],
    tracks: ["v1", "v2"].map((id) => ({ id, kind: "video", hidden: false, muted: false, locked: false })),
    clips: [
      clip({ id: "c1", track: "v1", start: 0, duration: 100, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }),
      // Our caption over it, on a lane that holds a B-roll picture later on.
      clip({ id: "t1", track: "v2", start: 0, duration: 50, type: "text", text: "I'm not afraid of you." }),
      clip({ id: "b1", track: "v2", start: 200, duration: 50, type: "video", media: "m", source_in: 300, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }),
      // One laid before the rule, over the caption: laid again where it belongs.
      clip({ id: "old", track: "v9", start: 60, duration: 10, type: "adjustment", name: `${blur.TRACKED} · c1`, blur: { radius: 20, x: 0, y: 0, width: 100, height: 40, feather: 4, shape: "rect" } }),
    ],
    next_id: 10,
  } as unknown as Project;
  project.tracks.push({ id: "v9", kind: "video", hidden: false, muted: false, locked: false });
  const template = structuredClone(project.clips.find((one) => one.id === "old") as AdjustmentClip);
  const want = (start: number, duration: number) => ({ ...template, id: "", track: "", start, duration });
  expect(blur.lay(project, [want(10, 20), want(60, 10)])).toBe(true);
  const laid = project.clips.filter((one) => (one.name ?? "").startsWith(`${blur.TRACKED} · `));
  expect(laid.length).toBe(2);
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  for (const one of laid) {
    expect(index(one.track)).toBeGreaterThan(index("v1"));
    expect(index(one.track)).toBeLessThan(index("v2"));
  }
  expect(project.tracks.some((one) => one.id === "v9")).toBe(false);
  // Laid again as they are: nothing changes.
  expect(blur.lay(project, [want(10, 20), want(60, 10)])).toBe(false);
});

test("their watermark's marked box is a place of its own, there over its seconds alone (Nov 19, the Boyfriends intro's ARRESTFLIX)", () => {
  const laid = blur.markTrack({ from: 10, to: 12, box: [0.1, 0.5, 0.3, 0.6] }, 0);
  const slots = blur.slotsOf(laid.samples);
  expect([...slots.keys()]).toEqual(["w0"]);
  const samples = slots.get("w0")!;
  expect(blur.boxAt(samples, 10)).toEqual([0.1, 0.5, 0.3, 0.6]);
  expect(blur.boxAt(samples, 11.99)).toEqual([0.1, 0.5, 0.3, 0.6]);
  expect(blur.boxAt(samples, 12)).toBeNull();
});

test("the track: read three times a second, halved twice at each change; between reads of the same words the box moves with them, across a change it's both, with none it's off; never the camera's stamp", async () => {
  const asked: number[][] = [];
  const samples = await blur.track(plan, 0, 4, async (times) => (asked.push(times), times.map(screen)));
  // 13 reads at 3 a second, then a read halfway into each change, and halfway again.
  expect(asked[0]!.length).toBe(13);
  expect(asked.length).toBe(3);
  const times = samples.map((one) => one.t);
  // The words changed at 2.0 s and went at 3.0 s: each change is bracketed within a twelfth of a second.
  const bracket = (at: number) => {
    const before = Math.max(...times.filter((t) => t < at));
    const after = Math.min(...times.filter((t) => t >= at));
    return after - before;
  };
  expect(bracket(2)).toBeLessThanOrEqual(1 / 12 + 1e-6);
  expect(bracket(3)).toBeLessThanOrEqual(1 / 12 + 1e-6);
  // Never the stamp: every box is in the band.
  expect(samples.every((one) => one.box === null || one.box[1] > 0.8)).toBe(true);
  // Moving: between two reads of the same line, where it is then (to the read's 0.001 rounding).
  const moving = blur.boxAt(samples, 0.5)!;
  expect(moving[0]).toBeCloseTo(0.35, 3);
  expect(moving[2]).toBeCloseTo(0.55, 3);
  // Across the change, both lines' boxes: neither shows sharp for a frame.
  const change = samples.findIndex((one) => one.t >= 2) - 1;
  const across = blur.boxAt(samples, (samples[change]!.t + samples[change + 1]!.t) / 2)!;
  expect(across[0]).toBeLessThanOrEqual(0.25);
  expect(across[2]).toBeGreaterThanOrEqual(0.75);
  expect(across[1]).toBeLessThanOrEqual(0.82);
  // After the words went: nothing.
  expect(blur.boxAt(samples, 3.5)).toBeNull();
  // A subtitle not found yet (no band) is looked for low and centred; a label of theirs by its box.
  expect(blur.theirs({ ...plan, band: null }, { b: [0.3, 0.85, 0.7, 0.9], t: "words" })).toBe(true);
  expect(blur.theirs({ ...plan, band: null }, { b: [0.3, 0.3, 0.7, 0.35], t: "words" })).toBe(false);
  expect(blur.theirs({ ...plan, subtitles: false, text: true, labels: [[0.02, 0.1, 0.3, 0.16]] }, { b: [0.03, 0.11, 0.25, 0.15], t: "OFFICER 11" })).toBe(true);
  // OCR reads a line in pieces: "THE" off to the left joins "SUSPECT RAN" beside it; the stamp never does.
  const pieces = blur.theirLines({ ...plan, band: null }, [{ b: [0.15, 0.84, 0.24, 0.9], t: "THE" }, { b: [0.25, 0.84, 0.6, 0.9], t: "SUSPECT RAN" }, { b: [0.65, 0.02, 0.95, 0.06], t: "2024-01-23" }]);
  expect(pieces.map((line) => line.t).sort()).toEqual(["SUSPECT RAN", "THE"]);
});

test("keys follow a value within a tolerance: a ramp is two keys, a jump two keys a frame apart", () => {
  const ramp = Array.from({ length: 30 }, (_, f) => 100 + 2 * f);
  expect(blur.keysFor(ramp, 0.75).map((key) => key.frame)).toEqual([0, 29]);
  const step = Array.from({ length: 30 }, (_, f) => (f < 12 ? 0 : 1));
  const keys = blur.keysFor(step, 0.01);
  for (let f = 0; f < 30; f++) expect(sample(keys, f)).toBeCloseTo(step[f]!, 6);
  expect(keys.length).toBeLessThanOrEqual(4);
});

function project(): Project {
  const footage: Media = media({ id: "m", name: "tape", path: "/tmp/tape.mp4", kind: "video", duration: 10, width: 1920, height: 1080, fps: 30 });
  return {
    id: "p1795000000000-abc",
    name: "Blur",
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [{ id: "v1", name: "V1", kind: "video" }],
    media: [footage],
    clips: [clip({ id: "c1", track: "v1", start: 30, duration: 120, type: "video", media: "m", source_in: 0, keyframes: { scale: [{ frame: 0, value: 1, ease: "linear" }, { frame: 119, value: 1.5, ease: "linear" }] } })],
    next_id: 10,
  } as unknown as Project;
}

test("laid through the clip: a push-in carries the box with it, the blur is off where there are no words, and a lay of the same blurs changes nothing", async () => {
  const p = project();
  const samples = await blur.track(plan, 0, 4, async (times) => times.map(screen));
  const [one] = blur.blursFor(p, p.clips[0] as VideoClip, p.media[0]!, [{ from: 0, to: 4, samples }]);
  expect(one).toBeDefined();
  // It starts with the clip (words from its first frame) and ends where the words went (3.0 s into the file), not the clip's end.
  expect(one!.start).toBe(30);
  expect(one!.start + one!.duration).toBeGreaterThanOrEqual(30 + 87);
  expect(one!.start + one!.duration).toBeLessThanOrEqual(30 + 92);
  expect(one!.name).toBe(`${blur.TRACKED} · c1`);
  const at = (param: string, frame: number) => sample(one!.keyframes![param]!, frame)!;
  // At 1.0 s of the file the line is 0.4–0.6 across, centred 0.5: x = 0 from the centre, its width 0.2 × 1920 × the push-in's scale.
  const scale = 1 + (0.5 * 30) / 119;
  expect(Math.abs(at("blur.x", 30) - 0)).toBeLessThan(3);
  expect(at("blur.width", 30)).toBeGreaterThan(0.2 * 1920 * scale);
  // A letter's width more each side (OCR's box stops short of a line's ends), never the band's 0.6 across.
  expect(at("blur.width", 30)).toBeLessThan(0.2 * 1920 * scale + 100);
  // Tight: its height a little over the line's 0.06 × 1080 (padded and feathered), far from the band's 0.15.
  expect(at("blur.height", 30)).toBeLessThan(0.06 * 1080 * scale + 50);
  // The line slides right: at 0.5 s it's left of where it is at 1.5 s.
  expect(at("blur.x", 15)).toBeLessThan(at("blur.x", 45) - 100);
  // Their text counts as gone under it, and the band's still cover gives way there.
  expect(strippedFrames({ ...p, clips: [...p.clips, one!] }).get("c1")).toEqual([[one!.start, one!.start + one!.duration]]);
  // Laid once; laid again unchanged keeps it (its id), and a change of track lays the new one.
  const laid = structuredClone(p);
  expect(blur.lay(laid, [one!])).toBe(true);
  const id = laid.clips.find((c) => c.name === one!.name)!.id;
  expect(blur.lay(laid, [one!])).toBe(false);
  expect(laid.clips.find((c) => c.name === one!.name)!.id).toBe(id);
  expect(blur.lay(laid, [])).toBe(true);
  expect(laid.clips.some((c) => c.name === one!.name)).toBe(false);
});

test("Nov 19, Cuffed & Caught's m10 at 7.57 s: only the subtitle line is blurred, never the cage's Pro-gard sticker beside it; lines stacked tight are one box, words apart never", async () => {
  // As read off the frame (shares of 1920×1080): the camera's stamp, the sticker on the cage, their yellow line.
  const stamp: ScreenText[] = [{ b: [0.636, 0.002, 0.946, 0.044], t: "2025-08-08 12:50:28 -0600" }, { b: [0.636, 0.03, 0.9, 0.07], t: "AXON BODY 4 D01A0653Y" }];
  const sticker: ScreenText = { b: [0.749, 0.533, 0.795, 0.58], t: "Pro gard" };
  const line: ScreenText = { b: [0.344, 0.861, 0.656, 0.912], t: "unable to start her car" };
  const later: ScreenText = { b: [0.235, 0.861, 0.76, 0.912], t: "because it had an Intoxalock installed," };
  const frame = (t: number) => [...stamp, sticker, t < 1 ? line : later];
  const avoid: Box[] = [[0.62, 0, 0.96, 0.08]];
  // Both ways it was planned: their text taken out with no label of theirs known, and the sticker taken for a label (it stays put).
  for (const labels of [[], [[0.739, 0.523, 0.805, 0.59]]] as Box[][]) {
    const mine = { band: null, labels, avoid, subtitles: true, text: true };
    const samples = await blur.track(mine, 0, 2, async (times) => times.map(frame));
    const p = { ...project(), clips: [clip({ id: "c1", track: "v1", start: 0, duration: 60, type: "video", media: "m", source_in: 0 })] } as unknown as Project;
    const laid = blur.blursFor(p, p.clips[0] as VideoClip, p.media[0]!, [{ from: 0, to: 2, samples }]);
    const edges = laid.map((one): [number, number, number, number] => {
      const [x, y, w, h] = [one.blur!.x ?? 0, one.blur!.y ?? 0, one.blur!.width ?? 0, one.blur!.height ?? 0];
      return [960 + x - w / 2, 540 + y - h / 2, 960 + x + w / 2, 540 + y + h / 2];
    });
    // The line's box alone: as tight as the text (660–1260 across, 930–985 down), a letter's width and the feather more.
    const subtitle = edges.filter(([, y0]) => y0 > 880);
    expect(subtitle.length).toBe(1);
    const [x0, y0, x1, y1] = subtitle[0]!;
    expect(x0).toBeGreaterThan(560);
    expect(x0).toBeLessThan(660);
    expect(x1).toBeGreaterThan(1260);
    expect(x1).toBeLessThan(1360);
    expect(y0).toBeLessThan(930);
    expect(y1).toBeGreaterThan(985);
    expect(y1 - y0).toBeLessThan(110);
    if (labels.length === 0) expect(edges.length).toBe(1);
    // Never a box reaching up to the sticker or the woman's body above the line.
    expect(edges.every(([, top, , bottom]) => bottom < 700 || top > 880)).toBe(true);
  }
  // The sticker is no label of theirs: words that stay put in the middle of a fixed camera's picture are the picture's; a channel's tag along the top is theirs.
  const seconds = Array.from({ length: 12 }, (_, at) => at * 10);
  const texts = Object.fromEntries(seconds.map((second) => [second, [...stamp, sticker, { b: [0.02, 0.1, 0.2, 0.15], t: "@CopsDaily clips" }, { b: [0.3, 0.86, 0.7, 0.91], t: ["she said", "nothing happened", "get out", "of the car", "now ma'am", "hands behind", "your back", "stop resisting", "I didn't", "do anything", "you're under", "arrest"][second / 10]! }]])) as Record<number, ScreenText[]>;
  const labels = labelBoxes(texts, seconds, avoid, undefined, true);
  expect(labels.length).toBe(1);
  expect(labels[0]![1]).toBeLessThan(0.12);
  expect(labelBoxes(texts, seconds, avoid).length).toBe(2);
  // Two stacked lines of a subtitle are one place; a line far above it in the band its own.
  const two = blur.partsOf({ labels: [] }, [{ b: [0.3, 0.8, 0.7, 0.85], t: "he said he was" }, { b: [0.32, 0.86, 0.68, 0.91], t: "never there" }]);
  expect(two.length).toBe(1);
  const apart = blur.partsOf({ labels: [] }, [{ b: [0.3, 0.5, 0.45, 0.55], t: "EXIT" }, { b: [0.32, 0.86, 0.68, 0.91], t: "never there at all" }]);
  expect(apart.map((one) => one.slot)).toEqual(["s", "s@11"]);
  // A line low and centred that never changes (a car's decal) isn't their subtitle: dropped from the track.
  const decal: blur.Sample[] = Array.from({ length: 31 }, (_, at) => ({ t: at / 3, box: [0.4, 0.85, 0.6, 0.9] as Box, words: "STATE PATROL", parts: [{ slot: "s", box: [0.4, 0.85, 0.6, 0.9] as Box, words: "STATE PATROL" }] }));
  expect(blur.slotsOf(decal).size).toBe(0);
});

/** How sharp a region of an RGB(A) frame is: the mean absolute Laplacian of its luma. */
function sharpness(pixels: Uint8Array, width: number, channels: number, box: [number, number, number, number]): number {
  const luma = (x: number, y: number) => {
    const at = (y * width + x) * channels;
    return 0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]!;
  };
  let sum = 0;
  let count = 0;
  for (let y = box[1] + 1; y < box[3] - 1; y++) {
    for (let x = box[0] + 1; x < box[2] - 1; x++) {
      sum += Math.abs(4 * luma(x, y) - luma(x - 1, y) - luma(x + 1, y) - luma(x, y - 1) - luma(x, y + 1));
      count += 1;
    }
  }
  return sum / Math.max(1, count);
}

test("with the real engine: a line of words sliding across the picture is read, tracked, and blurred where it is in each rendered frame, the picture beside it untouched", async () => {
  const { useNative, initNative, isReal, native } = await import("../src/native/index.ts");
  if (process.env.EDIT_NO_GPU === "1") return;
  const { app, cleanup } = fixtureHome("text-blur-real");
  const previous = useNative(null);
  try {
    try {
      initNative({ home: app.store.home, cacheDir: app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe() });
    } catch {
      return;
    }
    if (!isReal() || native().screenTextAt === undefined) return;
    // 3 s of a textured picture with big white words sliding right 300 px a second along the bottom.
    const file = join(app.store.home, "sliding.mp4");
    const font = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"].find((one) => fs.existsSync(one));
    if (font === undefined) return;
    try {
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=3", "-vf", `drawtext=fontfile='${font}':text='THE SUSPECT RAN':fontsize=56:fontcolor=white:borderw=3:bordercolor=black:x=40+300*t:y=600`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file]);
    } catch {
      return; // An FFmpeg without drawtext.
    }
    const footage = media({ id: "m", name: "sliding", path: file, kind: "video", duration: 3, width: 1280, height: 720, fps: 30 });
    // Their band along the bottom, as burned_subtitles finds it (the words slide along it, off-centre by the end).
    const one = { ...plan, band: [0.02, 0.8, 0.98, 0.95] as Box, avoid: [] };
    const samples = await blur.track(one, 0, 3, (times) => native().screenTextAt!(file, [1280, 720], 30, blur.regionOf(one), times));
    expect(samples.filter((s) => s.box !== null).length).toBeGreaterThan(5);
    const base = structuredClone(app.store.create("Blur", { width: 1280, height: 720, fps: 30 }).project) as Project;
    base.media = [footage];
    base.clips = [clip({ id: "c1", track: base.tracks[0]!.id, start: 0, duration: 90, type: "video", media: "m", source_in: 0 })];
    const blurred = structuredClone(base);
    expect(blur.lay(blurred, blur.blursFor(base, base.clips[0] as VideoClip, footage, [{ from: 0, to: 3, samples }]))).toBe(true);
    const laid = blurred.clips.find((c): c is AdjustmentClip => c.type === "adjustment")!;
    expect(laid.keyframes?.["blur.x"]).toBeDefined();
    const render = async (p: Project, frame: number) => {
      const [image] = await native().renderFrames({ project: { json: jsonForSerde(p) }, frames: [frame], maxSide: 1280, priority: "agent", encode: "png" });
      const out = join(app.store.home, `f${frame}-${p === base ? "o" : "b"}.png`);
      fs.writeFileSync(out, image!.data);
      const raw = await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      return new Uint8Array(raw);
    };
    // Where the words are at 0.5 s (x 190–) and at 2.5 s (x 790–), 600–660 down.
    const early: [number, number, number, number] = [200, 606, 520, 650];
    const late: [number, number, number, number] = [800, 606, 1120, 650];
    for (const [frame, words, away] of [[15, early, late], [75, late, early]] as const) {
      const [o, b] = [await render(base, frame), await render(blurred, frame)];
      const sharp = sharpness(o, 1280, 3, words);
      // The words blurred where they are now…
      expect(sharpness(b, 1280, 3, words)).toBeLessThan(sharp * 0.35);
      // …and where they were (or will be) left as it was: the box moved with them, it isn't one long still box.
      expect(sharpness(b, 1280, 3, away)).toBeGreaterThan(sharpness(o, 1280, 3, away) * 0.85);
      // The top of the picture untouched.
      expect(sharpness(b, 1280, 3, [100, 100, 1180, 400])).toBeGreaterThan(sharpness(o, 1280, 3, [100, 100, 1180, 400]) * 0.97);
    }
  } finally {
    useNative(previous);
    cleanup();
  }
}, 120_000);

test("with the real engine, a 30 s subtitled clip at 1920: read in one pass the words are the old way's (each change caught within a twelfth of a second, boxes within 4 px), and its speed recorded", async () => {
  const { useNative, initNative, isReal, native } = await import("../src/native/index.ts");
  if (process.env.EDIT_NO_GPU === "1") return;
  const { app, cleanup } = fixtureHome("text-blur-speed");
  const previous = useNative(null);
  try {
    try {
      initNative({ home: app.store.home, cacheDir: app.store.cacheDir(), ffmpeg: tools.ffmpeg(), ffprobe: tools.ffprobe() });
    } catch {
      return;
    }
    if (!isReal() || native().screenTextAt === undefined || native().screenTextStretch === undefined) return;
    const font = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"].find((one) => fs.existsSync(one));
    if (font === undefined) return;
    // A new subtitle every 1.5 s: on a black box over the first 15 s, outlined over the moving picture after.
    const words = ["Stop right there", "Put your hands up", "I did nothing wrong", "Sir step out of the car", "Where are you going", "Get on the ground now", "I want my lawyer", "You are under arrest", "Do you understand me", "Turn around slowly", "Is this your vehicle", "Keep your hands visible", "Why did you run", "I was scared okay", "We found the bag", "That is not mine", "Watch your head", "Sit in the back", "Call my mother please", "We are done here"];
    const changes = words.map((_, at) => at * 1.5);
    const draws = words.map((line, at) => `drawtext=fontfile='${font}':text='${line}':fontsize=56:fontcolor=white:borderw=4:bordercolor=black${at < 10 ? ":box=1:boxcolor=black:boxborderw=12" : ""}:x=(w-text_w)/2:y=950:enable='between(t,${changes[at]},${changes[at]! + 1.5 - 0.001})'`);
    const file = join(app.store.home, "subtitled.mp4");
    try {
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=30", "-vf", draws.join(","), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-y", file]);
    } catch {
      return; // An FFmpeg without drawtext.
    }
    const plan = { band: [0.15, 0.86, 0.85, 0.96] as Box, labels: [], avoid: [], subtitles: true, text: false };
    const region = blur.regionOf(plan);
    // The old way (a read at a time, read_at) and the new (one stretch, read in one pass) over the first 10 s.
    let started = performance.now();
    const before = await blur.track(plan, 0, 10, (times) => native().screenTextAt!(file, [1920, 1080], 30, region, times));
    const beforeSeconds = (performance.now() - started) / 1000;
    const reading = blur.reader.open(file, [1920, 1080], 30, region);
    started = performance.now();
    const after = await blur.track(plan, 0, 10, (times, keep) => reading.read(times, keep)).finally(() => reading.close());
    const afterSeconds = (performance.now() - started) / 1000;
    expect(after.map((one) => one.t)).toEqual(before.map((one) => one.t));
    let [off, worded] = [0, 0];
    after.forEach((one, at) => {
      const was = before[at]!;
      // The same words as the tracker tells them (OCR may read a line's first "I" one way and not the other).
      expect(blur.same(one, was)).toBe(true);
      if (one.words !== was.words) worded++;
      else if (one.box !== null && was.box !== null) for (const [side, value] of one.box.entries()) off = Math.max(off, Math.abs(value - was.box[side]!));
    });
    expect(off).toBeLessThan(0.0041);
    // All 30 s the new way: every change caught between two reads at most a twelfth of a second (and a frame) apart.
    const whole = blur.reader.open(file, [1920, 1080], 30, region);
    started = performance.now();
    const samples = await blur.track(plan, 0, 30, (times, keep) => whole.read(times, keep)).finally(() => whole.close());
    const wholeSeconds = (performance.now() - started) / 1000;
    // Read as the tracker tells words apart (OCR reads "lawyer" as "Iawyer").
    const reads = (one: blur.Sample, line: string) => one.box !== null && blur.same(one, { t: one.t, box: one.box, words: line });
    for (const [at, change] of changes.entries()) {
      if (at === 0) continue;
      const after = samples.findIndex((one) => one.t >= change);
      const [a, b] = [samples[after - 1]!, samples[after]!];
      expect(b.t - a.t).toBeLessThanOrEqual(1 / 12 + 1 / 30 + 1e-3);
      expect(reads(a, words[at - 1]!)).toBe(true);
      expect(reads(b, words[at]!)).toBe(true);
    }
    console.log(`text blur tracking, 1920×1080 subtitles: ${(beforeSeconds / 10).toFixed(2)} s a footage second read at a time, ${(afterSeconds / 10).toFixed(2)} s in one pass (${(wholeSeconds / 30).toFixed(2)} s over all 30 s, ${samples.length} reads; boxes at most ${off.toFixed(3)} from the old way's, ${worded} of ${after.length} reads' words not letter for letter)`);
    // Faster on a real machine (Linux 5–8×, kenobi 0.25 against 0.41 s a second). On CI's Mac VM, Vision's reads
    // take nearly all the time either way (23.3 against 22.9 s on 3724e823), so there it only mustn't be much slower.
    expect(afterSeconds).toBeLessThan(beforeSeconds * (process.env.CI === "true" && process.platform === "darwin" ? 1.25 : 1));
  } finally {
    useNative(previous);
    cleanup();
  }
}, 600_000);

test("the person's Stop lets go of the project's tracks not started yet: another project's are read, the stopped one's never are (Nov 19: two stopped compilations kept a third waiting behind ~2 h of footage)", async () => {
  const { app, cleanup } = fixtureHome("text-blur-stop");
  const own = blur.reader.open;
  try {
    const read: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    blur.reader.open = (input) => {
      read.push(input);
      return {
        read: async (times) => {
          await gate;
          return times.map(() => []);
        },
        close: () => {},
      };
    };
    const footage = (name: string) => media({ id: "m6", name, path: join(app.store.home, name), kind: "video", duration: 600, width: 1920, height: 1080, fps: 30 }) as Media;
    const planOf = (name: string, spans: [number, number][]): blur.BlurPlan => ({ media: footage(name), source: `sha256:${name}`, spans, band: [0.2, 0.8, 0.8, 0.95], labels: [], avoid: [], subtitles: true, text: false });
    const stopped = app.store.create("Stopped", { width: 1920, height: 1080, fps: 30 }).project.id;
    const other = app.store.create("Other", { width: 1920, height: 1080, fps: 30 }).project.id;
    // Many of the stopped one's first (more than read at once), then the other's: all behind the gate.
    await blur.ensure(app, stopped, [planOf("a.mp4", Array.from({ length: 8 }, (_, k): [number, number] => [k * 10, k * 10 + 2]))]);
    await blur.ensure(app, other, [planOf("b.mp4", [[0, 2]])]);
    blur.stop(stopped);
    expect(blur.piecesOf(stopped).every((one) => one.state === "running")).toBe(true);
    release();
    await blur.settled();
    // Only those already under way when it stopped were read of the stopped one's; the other's was read.
    expect(read.filter((one) => one.endsWith("a.mp4")).length).toBe(blur.AT_ONCE);
    expect(read.filter((one) => one.endsWith("b.mp4")).length).toBe(1);
    expect(blur.outOf(stopped)).toBe(0);
  } finally {
    blur.reader.open = own;
    cleanup();
  }
});
