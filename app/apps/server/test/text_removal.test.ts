// text_removal.ts, removal_schedule.ts and clean_strips.ts: what re-uploaders
// burned into footage (subtitles, labels) found and covered, the camera's own
// stamp kept as it was. The camera's text and its bar on real reads (Tulsa's
// Axon stamp under "Actual case footage", Nov 17; "SWAT Faces Off"'s Motorola
// bar under an "OFFICER 11" label), strips already in projects laid over the
// footage's clips on every save, the channel's removal lesson, and runs with
// stand-ins for the tracked blur's reads and the watermark engine: what goes
// follows the lesson and what's asked, the chat's waiting row, the agent woken
// once a run is done, the person's Stop, a restart's resume, removal starting
// as edits rest, and an export waiting for pieces still out.

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import * as burned from "../src/burned_subtitles.ts";
import * as channels from "../src/channels.ts";
import * as cloud from "../src/cloud.ts";
import { enforceCleanStrips, NAME, strippedFrames, WATERMARK_NAME } from "../src/clean_strips.ts";
import { beneathKey } from "../src/effect_inputs.ts";
import type { Media, Project, VideoClip } from "../src/model.ts";
import { native, useNative, type Native, type ScreenText } from "../src/native/index.ts";
import { createStub } from "../src/native/stub.ts";
import { join } from "../src/paths.ts";
import * as tr from "../src/text_removal.ts";
import * as blur from "../src/text_blur.ts";
import * as tools from "../src/tools.ts";
import * as removal from "../src/removal_lesson.ts";
import { EDIT_EVENT } from "../src/edit_event.ts";
import * as asks from "../src/removal_asks.ts";
import * as removalSchedule from "../src/removal_schedule.ts";
import * as removerCloud from "../src/remover_cloud.ts";
import * as cloudMedia from "../src/cloud_media.ts";
import { dispatch } from "../src/mcp/index.ts";
import * as wm from "../src/watermark_removal.ts";
import type { WatermarkRemoved } from "../src/native/index.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import * as found from "../src/found.ts";
import { fixtureHome } from "./helpers/home.ts";

// One cell at a time unless a test says (the Mac's memory would decide: watermark_removal.ts `limits`).
wm.limits.cells = 1;

const ownOpen = blur.reader.open;
let before: Native | null = null;
afterEach(async () => {
  await blur.settled();
  if (before !== null) useNative(before);
  before = null;
  blur.reader.open = ownOpen;
  blur.reset();
  asks.reset();
  removalSchedule.reset();
  wm.useEngine(null);
  wm.useShelf(null);
  wm.reset();
  v2cloud.useSkillsForTests([]);
});

// ---------------------------------------------------------------------------
// The camera's own text, on real reads

/** Edit's own OCR (PaddleOCR on mandalorian, Nov 17) of Tulsa's Axon footage under "Actual case footage". */
const TULSA: Record<number, ScreenText[]> = {
  2: [
    { b: [0.665, 0.013, 0.905, 0.05], t: "2025-02-07_14:28:20_-0600" },
    { b: [0.035, 0.054, 0.345, 0.124], t: "Actual case footage" },
    { b: [0.667, 0.048, 0.873, 0.074], t: "AXON B0DY 3 X60AB071C" },
    { b: [0.514, 0.663, 0.602, 0.715], t: "dose" },
    { b: [0.399, 0.743, 0.604, 0.807], t: "of.crime" },
  ],
  5: [
    { b: [0.666, 0.017, 0.904, 0.048], t: "2025-02-07_14:28:23-0600" },
    { b: [0.034, 0.05, 0.344, 0.126], t: "Actual case footage" },
    { b: [0.666, 0.046, 0.871, 0.078], t: "AXON B0DY 3 X60A8071C" },
    { b: [0.395, 0.913, 0.631, 0.963], t: "[Officer unintelligible]" },
  ],
  8: [
    { b: [0.666, 0.015, 0.904, 0.049], t: "2025-02-07 14:28:26 -0600" },
    { b: [0.035, 0.052, 0.345, 0.125], t: "Actual case footage" },
    { b: [0.667, 0.047, 0.872, 0.076], t: "AXON BODY 3 X60A8071C" },
  ],
};

/** The same of "SWAT Faces Off Against Killer 43 Years Later": Motorola's bar, a re-uploader's "OFFICER 11" over its left end. */
const MOTOROLA: ScreenText[] = [
  { b: [0.161, 0.011, 0.229, 0.043], t: "LUTIONS" },
  { b: [0.709, 0.007, 0.871, 0.039], t: "11/18/2024 12:16:31" },
  { b: [0.877, 0.007, 0.981, 0.039], t: "BWC2-101947" },
  { b: [0.018, 0.028, 0.154, 0.072], t: "OFFICER 11" },
  { b: [0, 0.394, 0.159, 0.526], t: "RAGIAL" },
];

const inside = (box: [number, number, number, number], line: ScreenText) => line.b[0] >= box[0] && line.b[1] >= box[1] && line.b[2] <= box[2] && line.b[3] <= box[3];
const kept = (boxes: [number, number, number, number][], line: ScreenText) => boxes.some((box) => inside(box, line));

async function grey(file: string, width: number, height: number): Promise<Uint8Array> {
  return tools.run([tools.ffmpeg(), "-v", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${width}:${height},format=gray`, "-f", "rawvideo", "-"]);
}

test("Motorola's stamp bar is found, its clock reads as one, and its own text is kept while OFFICER 11 over it isn't", async () => {
  const frame = join(import.meta.dir, "fixtures", "motorola-strip-officer-label.jpg");
  const bar = tr.findBar([await grey(frame, 480, 270)], 480, 270);
  expect(bar).not.toBeNull();
  expect(bar!.edge).toBe("top");
  expect(bar!.to).toBeGreaterThan(0.035);
  expect(bar!.to).toBeLessThan(0.05);
  const { parseClock } = await import("../src/camera_clock.ts");
  // Month first, as US cameras write it; and as a Mac's Vision reads it, its colons dots.
  for (const read of ["11/18/2024 12:16:31", "11/18/2024 12..16..31", "11/18/2024 12'.16.'31", "1l/18/2024 12:16:3l"]) expect(parseClock(read)).toEqual({ day: 20045, second: 12 * 3600 + 16 * 60 + 31, seconds: true });
  const boxes = tr.cameraText([MOTOROLA, MOTOROLA, MOTOROLA], bar);
  for (const own of ["11/18/2024 12:16:31", "BWC2-101947", "LUTIONS"]) expect(kept(boxes, MOTOROLA.find((line) => line.t === own)!)).toBe(true);
  // The re-uploader's label reaches below the bar: theirs, not the camera's; nor is the tyre's word.
  const officer = MOTOROLA.find((line) => line.t === "OFFICER 11")!;
  expect(boxes.some((box) => box[0] < officer.b[2] && officer.b[0] < box[2] && box[1] < officer.b[3] && officer.b[1] < box[3])).toBe(false);
  expect(kept(boxes, MOTOROLA.find((line) => line.t === "RAGIAL")!)).toBe(false);
  // Planning reads no frames: a clock at the picture's edge stands for its row, the same boxes.
  expect(tr.cameraText([MOTOROLA, MOTOROLA, MOTOROLA], null)).toEqual(boxes);
  // OFFICER 11 is a label of theirs that stays put: the file shows their text.
  const seconds = [1, 5, 9, 13, 17];
  expect(tr.labelSpans(Object.fromEntries(seconds.map((second) => [second, MOTOROLA])), seconds, 20, boxes)).toEqual([[0, 20]]);
  // A synthetic bar the same way: dark see-through rows over a moving picture, in every frame.
  const frames = [0, 1, 2].map((shift) => {
    const out = new Uint8Array(480 * 270);
    for (let y = 0; y < 270; y++) for (let x = 0; x < 480; x++) out[y * 480 + x] = Math.round((110 + 70 * Math.sin((x + 0.7 * y + 40 * shift) / 23) + 30 * Math.cos((x - y + 25 * shift) / 13)) * (y < 12 ? 0.45 : 1));
    return out;
  });
  expect(tr.findBar(frames, 480, 270)).toEqual({ edge: "top", from: 0, to: 0.044 });
  // No bar: a picture alone.
  expect(tr.findBar(frames.map((frame) => frame.map((value, at) => (at < 12 * 480 ? Math.round(value / 0.45) : value))), 480, 270)).toBeNull();
});

test("Axon's stamp and its logo are kept, Tulsa's 'Actual case footage' isn't, and the file shows their text", () => {
  const seconds = [2, 5, 8];
  const frames = seconds.map((second) => TULSA[second]!);
  const boxes = tr.cameraText(frames, null);
  for (const frame of frames) {
    for (const line of frame) expect(kept(boxes, line)).toBe(/^(2025|AXON)/u.test(line.t));
  }
  // Room for the triangle right of the date line (x 0.945–0.985 of the picture).
  expect(Math.max(...boxes.map((box) => box[2]))).toBeGreaterThan(0.96);
  expect(tr.labelSpans(TULSA, seconds, 10, boxes)).toEqual([[0, 10]]);
  // A clock and its stamp alone: nothing of theirs to take out.
  const stampOnly = Object.fromEntries(seconds.map((second) => [second, TULSA[second]!.filter((line) => /^(2025|AXON)/u.test(line.t))]));
  expect(tr.labelSpans(stampOnly, seconds, 10, boxes)).toEqual([]);
});

test("a compilation's camera stamp is kept though it shows in only a few of the file's reads (Nov 19, the Boyfriends intro: 4PuH2FjxQJA's Axon stamp, learned by the watermark engine as their mark)", () => {
  // 12 reads: the Axon stamp in 4 (one camera of several), a doorbell's in 8 with no clock.
  const axon = TULSA[8]!.filter((line) => /^(2025|AXON)/u.test(line.t));
  const doorbell: ScreenText[] = [{ b: [0.02, 0.92, 0.12, 0.97], t: "vivint" }];
  const boxes = tr.cameraText([axon, axon, axon, axon, ...Array.from({ length: 8 }, () => doorbell)], null);
  for (const line of axon) expect(kept(boxes, line)).toBe(true);
  // A clock read once or twice is not a stamp that stays put.
  expect(tr.cameraText([axon, axon, ...Array.from({ length: 10 }, () => doorbell)], null)).toEqual([]);
});

test("a mark covers the shot it's in; a slowed copy reads as the file it was made from; a fading flash hides nothing (Nov 19, the Boyfriends intro: 'Wow', a subtitle a read before its mark, 'No' in a 0.80x copy)", () => {
  // A mark over the shots of the file it touches: [100, 102.06] shown, marked at 101.81–101.87.
  expect(tr.shotsOf([[101.81, 101.87]], [[100, 102.06], [254.72, 256.49]])).toEqual([[100, 102.06]]);
  // A mark outside every shot shown stays as it is.
  expect(tr.shotsOf([[10, 12]], [[100, 102.06]])).toEqual([[10, 12]]);
  const p = footageProject();
  p.media.push({ id: "slow", name: "tape-0.80x-320728d208e1.mp4", path: "/slow.mp4", kind: "video", duration: 3, width: 1280, height: 720, fps: 30, has_audio: false } as Media);
  p.media.find((one) => one.id === "m")!.name = "tape.mp4";
  expect(tr.slowedFrom(p, p.media.find((one) => one.id === "slow")!)?.id).toBe("m");
  expect(tr.slowedFrom(p, p.media.find((one) => one.id === "m")!)).toBeNull();
  // A white flash over c1's first 6 frames, fading out over 5: only its first frame hides the tape.
  p.tracks.push({ id: "v3", kind: "video", hidden: false, muted: false, locked: false });
  p.clips.push({ id: "flash", track: "v3", start: 0, duration: 6, color: "blue", fade_in: 0, fade_out: 0, type: "solid", fill: [1, 1, 1, 1], opacity: 1, keyframes: { opacity: [{ frame: 0, value: 1, ease: "out" }, { frame: 5, value: 0, ease: "linear" }] } } as unknown as Project["clips"][number]);
  expect(tr.shownSeconds(p).get("m")![0]![0]).toBeCloseTo(12 + 1 / 30, 5);
  // At full strength throughout, it hides all six.
  (p.clips.find((one) => one.id === "flash") as { keyframes?: unknown }).keyframes = undefined;
  expect(tr.shownSeconds(p).get("m")![0]![0]).toBeCloseTo(12 + 6 / 30, 5);
  // A graphic's still, holding its place while it's drawn again, fills the frame and hides nothing (Nov 23: the plan
  // changed with every render of a cut-in's key line).
  p.clips = p.clips.filter((one) => one.id !== "flash");
  const before = tr.shownSeconds(p).get("m");
  p.media.push({ id: "still", name: "cutin-keys", path: "/effect-stills/cutin-keys.clear.png", kind: "image", width: 1920, height: 1080, effect: "cutin-keys" } as unknown as Media);
  p.clips.push({ id: "keys", track: "v3", start: 0, duration: 600, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "still", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as unknown as Project["clips"][number]);
  expect(tr.shownSeconds(p).get("m")).toEqual(before!);
});

test("a still blur left standing in for removal goes on the next save, its clip there or not (Nov 19, the Boyfriends intro: five over cleaned or empty frames, one on a clip re-cut since)", () => {
  const p = footageProject();
  p.media = p.media.filter((one) => one.cleans == null);
  p.clips.push({ ...structuredClone(p.clips.find((one) => one.id === "blur")!), id: "orphan", start: 400, name: `${burned.UNTIL_REMOVED} · c13` } as Project["clips"][number]);
  // A cover of ours ("cover": theirs blurred, ours on it) stays.
  p.clips.push({ ...structuredClone(p.clips.find((one) => one.id === "blur")!), id: "taught", start: 500, name: `${burned.COVER} · c2` } as Project["clips"][number]);
  enforceCleanStrips(null, p);
  expect(p.clips.filter((one) => (one.name ?? "").startsWith(burned.COVER)).map((one) => one.id)).toEqual(["taught"]);
});

// ---------------------------------------------------------------------------
// In the project

function footageProject(): Project {
  return {
    version: 1,
    id: "p",
    name: "p",
    style: "bodycam",
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "m", name: "tape", path: "/tape.mp4", kind: "video", duration: 600, width: 1280, height: 720, fps: 30, has_audio: true },
      { id: "s", name: "tape · their text out 9–31 s", path: "/strip.mp4", kind: "video", duration: 22, width: 1280, height: 640, fps: 30, has_audio: false, stacked_alpha: true, cleans: { media: "m", from: 9, to: 31, box: [0, 0, 1, 0.9] } },
    ],
    tracks: [
      { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
      { id: "v2", kind: "video", hidden: false, muted: false, locked: false },
      { id: "t1", kind: "video", hidden: false, muted: false, locked: false, subtitles: true },
    ],
    clips: [
      // 12–22 s of the tape at 0, pushing in, fading in.
      { id: "c1", track: "v1", start: 0, duration: 300, color: "blue", fade_in: 10, fade_out: 0, type: "video", media: "m", source_in: 12, speed: 1, transform: { x: 40, y: 0, scale: 1.1, rotation: 0 }, opacity: 1, keyframes: { scale: [{ frame: 0, value: 1.1, ease: "linear" }, { frame: 299, value: 1.3, ease: "linear" }] } },
      // 25–40 s of it later: only up to 31 s is cleaned.
      { id: "c2", track: "v1", start: 300, duration: 450, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 25, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 },
      // A picture on the track above.
      { id: "b", track: "v2", start: 0, duration: 60, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 100, speed: 1, transform: { x: 500, y: 0, scale: 0.3, rotation: 0 }, opacity: 1 },
      // The blur standing in until it's done, on c1.
      { id: "blur", track: "v2", start: 100, duration: 200, color: "blue", fade_in: 0, fade_out: 0, type: "adjustment", name: `${burned.UNTIL_REMOVED} · c1`, blur: { radius: 35, x: 0, y: 400, width: 900, height: 120, feather: 10 } },
    ],
    next_id: 10,
    remove_burned: true,
  } as unknown as Project;
}

test("a strip is laid over each clip of its footage it covers, stuck to it, just above it; re-cuts follow, a save changes nothing, the blur gives way", () => {
  const project = footageProject();
  enforceCleanStrips(null, project);
  const overlays = project.clips.filter((clip): clip is VideoClip => (clip.name ?? "").startsWith(NAME));
  expect(overlays.length).toBe(2);
  const [one, two] = overlays.sort((a, b) => a.start - b.start);
  // c1: the whole clip (12–22 s is inside 9–31 s), its own fade, the strip's 3 s in, stuck to c1, on a lane just above v1.
  expect(one).toMatchObject({ start: 0, duration: 300, media: "s", source_in: 3, speed: 1, parent: "c1", fade_in: 10, name: `${NAME} · c1` });
  const lane = project.tracks.findIndex((track) => track.id === one!.track);
  expect(project.tracks[lane - 1]!.id).toBe("v1");
  expect(project.tracks[lane + 1]!.id).toBe("v2");
  // Placed over the footage at rest: the strip's picture is the box's (the top 90%), its scale the footage's on screen.
  expect(one!.transform.x).toBeCloseTo(40, 3);
  expect(one!.transform.y).toBeCloseTo(-0.05 * 720 * 1.5 * 1.1, 1);
  expect(one!.transform.scale).toBeCloseTo((1280 * 1.5 * 1.1) / (1280 * Math.min(1920 / 1280, 1080 / 640)), 4);
  // c2: 25–31 s only, from its start.
  expect(two).toMatchObject({ start: 300, duration: 180, source_in: 16, parent: "c2", track: one!.track });
  // The blur on c1 is gone where the strip covers it; onTimeline no longer shows theirs there.
  expect(project.clips.find((clip) => clip.id === "blur")).toBeUndefined();
  expect(strippedFrames(project).get("c1")).toEqual([[0, 300]]);
  // Saved again: nothing changes (no new ids, no new lane).
  const again = structuredClone(project);
  enforceCleanStrips(project, again);
  expect(again).toEqual(project);
  // A re-cut: c1 trimmed to start at 20 s of the tape, moved; its strip follows.
  const cut = structuredClone(project);
  const c1 = cut.clips.find((clip) => clip.id === "c1") as VideoClip;
  c1.source_in = 20;
  c1.start = 30;
  c1.duration = 250;
  enforceCleanStrips(project, cut);
  const followed = cut.clips.filter((clip): clip is VideoClip => (clip.name ?? "").startsWith(NAME) && clip.parent === "c1");
  expect(followed.map((clip) => [clip.start, clip.duration, clip.source_in])).toEqual([[30, 250, 11]]);
  expect(cut.tracks.length).toBe(project.tracks.length);
  // The strip gone (taken out of the project): the overlays and their lane go with it.
  const gone = structuredClone(project);
  gone.media = gone.media.filter((media) => media.id !== "s");
  enforceCleanStrips(project, gone);
  expect(gone.clips.some((clip) => (clip.name ?? "").startsWith(NAME))).toBe(false);
  expect(gone.tracks.map((track) => track.id)).toEqual(["v1", "v2", "t1"]);
});

test("a strip finished touches only its own overlays: the rest keep their ids and lanes, an effect drawn elsewhere keeps what's beneath it, and a save with nothing new changes nothing (Nov 18, Sphe's M4)", () => {
  // 20 clips of a 40 s tape, 2 s each; their text cleaned in two strips (0–20 s, 20–40 s), their watermark in one (0–40 s).
  const strip = (id: string, from: number, to: number, what: "text" | "watermark") =>
    ({ id, name: id, path: `/${id}.mp4`, kind: "video", duration: to - from, width: 1280, height: 640, fps: 30, has_audio: false, stacked_alpha: true, cleans: { media: "m", from, to, box: [0, 0, 1, 0.9], what } }) as unknown as Media;
  const effect = (id: string, name: string) => ({ id, name, path: `/${name}.mp4`, kind: "video", duration: 4, width: 1920, height: 1080, fps: 30, has_audio: false, effect: name }) as unknown as Media;
  const project = {
    version: 1,
    id: "p",
    name: "p",
    style: "bodycam",
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "m", name: "tape", path: "/tape.mp4", kind: "video", duration: 40, width: 1280, height: 720, fps: 30, has_audio: true },
      strip("s1", 0, 20, "text"),
      strip("s2", 20, 40, "text"),
      strip("w", 0, 40, "watermark"),
      effect("ea", "glass_a"),
      effect("eb", "glass_b"),
    ],
    tracks: [
      { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
      { id: "fx", kind: "video", hidden: false, muted: false, locked: false },
    ],
    clips: [
      ...Array.from({ length: 20 }, (_, index) => ({ id: `f${index}`, track: "v1", start: index * 60, duration: 60, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: index * 2, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 })),
      // Effects over 0–4 s (s1's) and 30–34 s (s2's).
      { id: "xa", track: "fx", start: 0, duration: 120, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "ea", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 },
      { id: "xb", track: "fx", start: 900, duration: 120, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "eb", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 },
    ],
    next_id: 100,
  } as unknown as Project;
  const overlays = (of: Project) => of.clips.filter((clip): clip is VideoClip => (clip.name ?? "").startsWith(NAME) || (clip.name ?? "").startsWith(WATERMARK_NAME));
  const rank = (of: Project, clip: VideoClip) => of.tracks.findIndex((track) => track.id === clip.track);
  /** Every text overlay above the watermark overlay of the same clip, and every overlay between its footage and the effects. */
  const layered = (of: Project) => {
    for (const one of overlays(of)) {
      expect(rank(of, one)).toBeGreaterThan(rank(of, of.clips.find((clip) => clip.id === one.parent)! as VideoClip));
      expect(rank(of, one)).toBeLessThan(of.tracks.findIndex((track) => track.id === "fx"));
      if (!one.name!.startsWith(NAME)) continue;
      for (const under of overlays(of).filter((clip) => clip.parent === one.parent && clip.name!.startsWith(WATERMARK_NAME))) expect(rank(of, one)).toBeGreaterThan(rank(of, under));
    }
  };
  enforceCleanStrips(null, project);
  expect(overlays(project).length).toBe(40);
  layered(project);
  // Saved again with nothing new: nothing changes.
  const again = structuredClone(project);
  enforceCleanStrips(project, again);
  expect(again).toEqual(project);
  // s1 replaced (the old strip out, a fresh media in, as long).
  const done = structuredClone(project);
  done.media = done.media.filter((media) => media.id !== "s1");
  done.media.push({ ...strip("s1b", 0, 20, "text"), path: "/s1-again.mp4" });
  enforceCleanStrips(project, done);
  const ids = (of: Project, keep: (clip: VideoClip) => boolean) => overlays(of).filter(keep).map((clip) => [clip.id, clip.track, clip.media]).sort();
  // The watermark's overlays and s2's: as they were, ids, lanes and all.
  const untouched = (clip: VideoClip) => clip.media !== "s1" && clip.media !== "s1b";
  expect(ids(done, untouched)).toEqual(ids(project, untouched));
  // s1's ten overlays now of the new strip, still over their clips, and no lanes more than before.
  expect(overlays(done).filter((clip) => clip.media === "s1b").length).toBe(10);
  expect(overlays(done).some((clip) => clip.media === "s1")).toBe(false);
  expect(done.tracks.length).toBe(project.tracks.length);
  layered(done);
  // What's beneath the effect over s2's seconds is as it was (its render stays); the one over s1's changed.
  expect(beneathKey(done, "glass_b")).toBe(beneathKey(project, "glass_b"));
  expect(beneathKey(done, "glass_a")).not.toBe(beneathKey(project, "glass_a"));
  // The new strip's upload landing (its cloud source filled in) is the same picture: no render again.
  const uploaded = structuredClone(done);
  const landed = uploaded.media.find((one) => one.id === "s1b")!;
  expect(landed.cleans).toBeTruthy();
  landed.cloud = { ...(landed.cloud ?? {}), source: "sha256:0123456789abcdef" } as NonNullable<typeof landed.cloud>;
  expect(beneathKey(uploaded, "glass_a")).toBe(beneathKey(done, "glass_a"));
  // Then a save with nothing new: nothing changes.
  const still = structuredClone(done);
  enforceCleanStrips(done, still);
  expect(still).toEqual(done);
  // The lanes reordered under an effect: what's beneath it changed (which is drawn over which).
  const swapped = structuredClone(done);
  const lanes = swapped.tracks.splice(1, 2);
  swapped.tracks.splice(1, 0, lanes[1]!, lanes[0]!);
  expect(beneathKey(swapped, "glass_b")).not.toBe(beneathKey(done, "glass_b"));
});

// ---------------------------------------------------------------------------
// Runs, with stand-ins for the blur's reads and the watermark engine

/** The fixture's addon, reading `reads` off every file (as Paddle or Vision would). */
function reading(reads: Record<number, ScreenText[]>): void {
  const raw = createStub() as unknown as Record<string, unknown>;
  const current = native() as unknown as Record<string, unknown>;
  for (const key of Object.keys(current)) raw[key] = current[key];
  raw.stub = false;
  raw.screenTextDetect = async (_source: string, _size: [number, number], indexes: number[]) => Object.fromEntries(indexes.map((index) => [index, reads[index] ?? reads[Number(Object.keys(reads)[0])] ?? []]));
  raw.screenTextCached = () => reads;
  before = useNative(raw as unknown as Native);
}

async function labelledFootage(dir: string, seconds: number): Promise<string> {
  const file = join(dir, "tape.mp4");
  await tools.run([
    tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x7f7f7f:size=320x180:rate=30:duration=${seconds},format=yuv420p,noise=alls=12:allf=t,drawbox=x=10:y=10:w=80:h=16:color=white:t=fill`,
    "-c:v", "libx264", "-qp", "0", file,
  ]);
  return file;
}

/** A channel's removal lesson, as teach_removal keeps it, for the projects of channel ch-taught. */
function teach(remove: Partial<Record<removal.Kind, boolean>>, examples: removal.Example[] = [], when: Partial<Record<removal.Kind, removal.When>> = {}): void {
  const lesson = removal.changed(null, remove, examples, false, when);
  v2cloud.useSkillsForTests([{ name: removal.SKILL, key: v2cloud.ownKey("skill", "ch-taught--edit", removal.SKILL), text: removal.write(lesson) }]);
}

/** A project of channel ch-taught with `file` on its timeline, its words read (a label that stays put). */
async function labelledProject(app: App, file: string, duration: number, name = "p"): Promise<string> {
  const live = app.store.create(name, { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  const media: Media = { id: "m", name: "tape", path: file, kind: "video", duration, width: 320, height: 180, fps: 30, has_audio: false };
  project.media = [media];
  project.clips = [{ id: "f", track: "v1", start: 0, duration: Math.round(duration * 30), color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 }];
  project.channel = "ch-taught";
  await app.store.replace(project.id, null, project, "test");
  await burned.warm(app.media, media);
  takeProposed(app, project.id);
  return project.id;
}

/** The agent's look done and every stretch detection proposes taken (start_removal `marks: "proposed"`): what these tests blur is detection's. */
function takeProposed(app: App, id: string): void {
  asks.add(app.store.home, id, { at: Date.now(), kinds: ["subtitles", "text"], media: "all", mark: "add" });
}

/** A re-uploader's label along the top, where theirs go (text_removal.ts `labelBoxes`). */
const LABEL: ScreenText = { t: "Actual case footage", b: [0.03, 0.05, 0.28, 0.15] };

/** The tracked blur's reads (text_blur.ts `reader`): LABEL wherever it looks, once `gate` lets it; each read's times counted in `reads`. */
function blurReads(reads: number[], gate: () => Promise<void> = async () => {}): void {
  blur.reader.open = () => ({
    read: async (times) => {
      await gate();
      reads.push(times.length);
      return times.map(() => [LABEL]);
    },
    close: () => {},
  });
}

/** A gate that holds until opened. */
function gated(): { wait: () => Promise<void>; open: () => void } {
  let open = () => {};
  const held = new Promise<void>((resolve) => (open = resolve));
  return { wait: () => held, open: () => open() };
}

/** The blur's stretches of `id`: file, seconds, state. */
const blurs = (id: string) => blur.piecesOf(id).map((one) => [one.media, one.from, one.to, one.state]);
/** Whether `id`'s timeline has a tracked blur laid. */
const tracked = (app: App, id: string) => app.store.get(id)!.project.clips.some((clip) => clip.type === "adjustment" && (clip.name ?? "").startsWith(`${blur.TRACKED} · `));

// ---------------------------------------------------------------------------
// What a channel is taught to take out (removal_lesson.ts) and what that does

test("a removal lesson reads back as kept, changes part by part, and says plainly what's done to each part", () => {
  const actual: removal.Example = { kind: "text", action: "remove", text: "Actual case footage", box: [0.03, 0.05, 0.35, 0.13], from: { source: "drive:abc", at: 5 } };
  const stamp: removal.Example = { kind: "stamp", action: "keep", text: "AXON BODY 3", box: [0.66, 0.01, 0.97, 0.09] };
  const lesson = removal.changed(null, { subtitles: true, text: true }, [actual, stamp]);
  const kept = removal.write(lesson);
  expect(kept.split("\n")[0]).toBe(`Their subtitles and text get a tight blur; the camera's stamp and "AXON BODY 3" always kept.`);
  expect(removal.parse(kept)).toEqual(lesson);
  // When each part runs, said in the first line: by itself after import, or only when someone asks.
  const timed = removal.changed(lesson, { watermarks: true }, [], false, { watermarks: "asked" });
  expect(removal.summary(timed)).toBe(`Their subtitles and text get a tight blur; only when someone asks, their watermarks come out; the camera's stamp and "AXON BODY 3" always kept.`);
  expect(removal.summary(removal.changed(null, { watermarks: true }, [], false, { watermarks: "asked" }))).toBe("Only when someone asks, their watermarks come out; the camera's stamp always kept.");
  expect(removal.summary(removal.changed(null, { subtitles: true, watermarks: true }, []))).toBe("Their subtitles get a tight blur; their watermarks come out; the camera's stamp always kept.");
  expect(removal.summary(removal.changed(null, { text: true }, []))).toBe("Their labels and other text get a tight blur; the camera's stamp always kept.");
  expect(removal.summary(removal.changed(null, {}, []))).toBe("Nothing is taken out of the footage's picture; the camera's stamp always kept.");
  expect(removal.parse(removal.write(timed))!.when).toEqual({ subtitles: "automatic", watermarks: "asked", text: "automatic" });
  // A lesson kept before timings read back: every part by itself, as it ran.
  expect(removal.parse(`x\n<removal>{"remove":{"subtitles":true},"examples":[]}</removal>`)!.when).toEqual({ subtitles: "automatic", watermarks: "automatic", text: "automatic" });
  // Hand-written words, or broken data, are no lesson: nothing is taken out.
  expect(removal.parse("Take their subtitles out")).toBeNull();
  expect(removal.parse("x <removal>{oops</removal>")).toBeNull();
  // Part by part: what's given changes, the rest stays; the same frame's example replaced, or all cleared.
  const later = removal.changed(lesson, { text: false, watermarks: true }, [{ ...actual, text: "Actual footage" }]);
  expect(later.remove).toEqual({ subtitles: true, watermarks: true, text: false });
  expect(later.examples.map((one) => one.text)).toEqual(["AXON BODY 3", "Actual footage"]);
  expect(removal.changed(later, {}, [], true).examples).toEqual([]);
  // Where each part goes: the tracked blur for subtitles and text, the engine for watermarks, nothing untaught.
  expect(removal.kinds(null)).toEqual({ blur: [], watermarks: [] });
  expect(removal.kinds(removal.changed(null, { subtitles: true }, []))).toEqual({ blur: ["subtitles"], watermarks: [] });
  expect(removal.kinds(removal.changed(null, { watermarks: true }, []))).toEqual({ blur: [], watermarks: ["watermarks"] });
  expect(removal.kinds(removal.changed(null, { subtitles: true, text: true, watermarks: true }, []))).toEqual({ blur: ["subtitles", "text"], watermarks: ["watermarks"] });
  expect(removal.takesOut(removal.changed(null, { subtitles: false }, []))).toBe(false);
  // Taught words: a label of theirs counts the first time it's read; words it keeps never count, staying put or not.
  const once = { 3: [{ t: "Actual case footage", b: [0.03, 0.05, 0.35, 0.13] }] } as Record<number, ScreenText[]>;
  expect(tr.labelSpans(once, [1, 3, 5, 7], 8, [])).toEqual([]);
  expect(tr.labelSpans(once, [1, 3, 5, 7], 8, [], removal.exampleWords(lesson))).toEqual([[1.5, 4.5]]);
  const credit = Object.fromEntries([1, 3, 5, 7].map((second) => [second, [{ t: "Bodycam Watch exclusive", b: [0.6, 0.85, 0.95, 0.9] }]])) as Record<number, ScreenText[]>;
  expect(tr.labelSpans(credit, [1, 3, 5, 7], 8, [])).toEqual([[0, 8]]);
  expect(tr.labelSpans(credit, [1, 3, 5, 7], 8, [], { remove: [], keep: ["Bodycam Watch exclusive"] })).toEqual([]);
});

/** A stand-in for the watermark engine: each cell a small stacked strip, its mark all but gone. */
function engine(calls: string[]): wm.Engine {
  return {
    async learn(_source, _size, _duration, hint) {
      calls.push(`learn ${JSON.stringify(hint)}`);
      return JSON.stringify({ version: 1, stand: "in" });
    },
    async remove(piece): Promise<WatermarkRemoved | null> {
      calls.push(`remove ${piece.from}-${piece.to}`);
      await tools.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:size=64x128:rate=30:duration=${piece.to - piece.from}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", piece.out]);
      return { region: [0.37, 0.61, 0.63, 0.84], frames: Math.round((piece.to - piece.from) * 30), marked: 1, filled: 0.9, left: 0.05, took: 1 };
    },
  };
}

test("what's done follows the lesson: untaught nothing, subtitles alone not their labels, their text under the tracked blur, watermarks alone to the engine", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-lessons");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  const reads: number[] = [];
  blurReads(reads);
  const calls: string[] = [];
  wm.useEngine(engine(calls));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    // Untaught: nothing said, nothing read, nothing learned.
    await removalSchedule.ensure(app, id);
    await blur.settled();
    await wm.settled();
    expect(removalSchedule.statusOf(app, id)).toEqual({ background: null });
    expect([reads, calls, blurs(id)]).toEqual([[], [], []]);
    // Taught their subtitles alone: this footage shows a label, no subtitles, so nothing.
    teach({ subtitles: true });
    expect(await tr.blurPlan(app, store.get(id)!.project)).toEqual([]);
    // Their text: the label's seconds get the tracked blur, laid over its clip.
    teach({ text: true });
    expect((await tr.blurPlan(app, store.get(id)!.project)).map((one) => [one.media.id, one.spans, one.text, one.subtitles])).toEqual([["m", [[0, 8]], true, false]]);
    await removalSchedule.ensure(app, id);
    await blur.settled();
    expect(blurs(id)).toEqual([["m", 0, 8, "done"]]);
    expect(reads.length).toBeGreaterThan(0);
    expect(tracked(app, id)).toBe(true);
    // Their watermark alone, with an example of it: the mark learned from it once, the timeline's cells done here, the blur taken off.
    const source = `sha256:${await cloudMedia.sha256File(file)}`;
    teach({ watermarks: true }, [{ kind: "watermarks", action: "remove", box: [0.3, 0.6, 0.7, 0.85], from: { source, at: 4 } }]);
    expect(await tr.blurPlan(app, store.get(id)!.project)).toEqual([]);
    await tr.ensure(app, id);
    await removalSchedule.ensure(app, id);
    await wm.settled();
    expect(calls).toEqual([`learn ${JSON.stringify([0.3, 0.6, 0.7, 0.85])}`, "remove 0-8"]);
    expect(tracked(app, id)).toBe(false);
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(1);
  } finally {
    cleanup();
  }
}, 120_000);

test("a part taught to run only when asked does nothing until the agent starts it on what the person pointed to; then it's counted and waited for as any", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-asked");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true, watermarks: true }, [], { text: "asked", watermarks: "asked" });
  const reads: number[] = [];
  const gate = gated();
  blurReads(reads, gate.wait);
  const calls: string[] = [];
  wm.useEngine(engine(calls));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  const call = async (args: Record<string, unknown>) =>
    ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
  let id = "";
  try {
    const file = await labelledFootage(dir, 8);
    id = await labelledProject(app, file, 8);
    // Taught, not asked: no file looked at, nothing read, nothing said, nothing for an export to wait for.
    await removalSchedule.ensure(app, id);
    await wm.settled();
    expect([reads, calls, blurs(id)]).toEqual([[], [], []]);
    expect(await tr.blurPlan(app, store.get(id)!.project)).toEqual([]);
    expect(removalSchedule.statusOf(app, id)).toEqual({ background: null });
    await removalSchedule.waitForPieces(app, id, 200);
    // Asked with nowhere said: the agent is told what to give.
    expect((await call({})).content[0]!.text).toContain("say where");
    // The person points at the footage: both parts waiting for an ask start on it.
    const said = await call({ media: ["m"] });
    expect(said.isError).toBe(false);
    expect(said.content[0]!.text).toContain("Taking their watermarks, their labels and other text out of tape");
    expect(said.content[0]!.text).toContain("tight tracked blur");
    while (removalSchedule.progressOf(id).out === 0) await Bun.sleep(20);
    expect(removalSchedule.statusOf(app, id).background?.label).toMatch(/^Removing their (text|watermarks)/u);
    expect(await removalSchedule.waitForPieces(app, id, 200).catch((error: unknown) => String(error))).toContain("still rendering");
    const waited = removalSchedule.waitForPieces(app, id, 60_000);
    gate.open();
    await waited;
    await blur.settled();
    await wm.settled();
    expect(calls).toEqual(["learn null", "remove 0-8"]);
    expect(blurs(id)).toEqual([["m", 0, 8, "done"]]);
    expect(tracked(app, id)).toBe(true);
    expect(store.get(id)!.project.media.filter((media) => media.cleans != null).map((media) => media.cleans!.what)).toEqual(["watermark"]);
    // Kept across a restart of the server: what was asked still covers this footage.
    asks.reset();
    expect(asks.scope(removal.lessonOf(store.get(id)!.project), app.store.home, id, "text", "m", [[0, 8]])).toEqual([[0, 8]]);
    // A mode is no longer a thing: start_removal has none.
    expect((await call({ media: ["m"], mode: "smart" })).isError).toBe(false);
  } finally {
    cleanup();
  }
}, 120_000);

test("asked for a stretch of the timeline, only those seconds of the footage there; a part never taught can be asked for too", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-asked-span");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL], 9: [LABEL], 11: [LABEL] });
  v2cloud.useSkillsForTests([]);
  const reads: number[] = [];
  blurReads(reads);
  try {
    const file = await labelledFootage(dir, 30);
    const id = await labelledProject(app, file, 30);
    // The timeline's 2–6 s are the footage's 2–6 s.
    const project = store.get(id)!.project;
    expect([...removalSchedule.shownBetween(project, 2, 6)]).toEqual([["m", [[2, 6]]]]);
    // Untaught: nothing until asked; asked for their text from 2 to 6 s: that stretch alone.
    await removalSchedule.ensure(app, id);
    await blur.settled();
    expect([reads, blurs(id)]).toEqual([[], []]);
    const said = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: id, kinds: ["text"], from: 2, to: 6 } } }, null)) as { result: { isError: boolean } };
    expect(said.result.isError).toBe(false);
    await blur.settled();
    expect(blurs(id)).toEqual([["m", 2, 6, "done"]]);
    expect(tracked(app, id)).toBe(true);
  } finally {
    cleanup();
  }
}, 120_000);

test("after a restart the work resumes by itself, with no edit (Nov 17, Sphe's M4): a cell cut short by the stop is done again, kept ones never twice", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-resume");
  reading({});
  const calls: string[] = [];
  let stopping = true;
  const base = engine(calls);
  // The server stopping mid-cell: FFmpeg killed under it, and nothing more done before it's gone.
  wm.useEngine({
    ...base,
    remove: async (piece, progress) => {
      if (!stopping) return base.remove(piece, progress);
      calls.push(`remove ${piece.from}-${piece.to}`);
      await Bun.sleep(1e9);
      return null;
    },
  });
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 40);
    const id = await labelledProject(app, file, 40);
    teach({ watermarks: true });
    await removalSchedule.ensure(app, id);
    while (calls.length < 2) await Bun.sleep(20);
    expect(calls).toEqual(["learn null", "remove 0-30"]);
    // The restart: nothing in memory (the stopped server's queue gone), nothing edited since.
    stopping = false;
    wm.reset();
    v2cloud.forgetSkills();
    teach({ watermarks: true });
    expect(await removalSchedule.resume(app)).toBe(1);
    await wm.settled();
    // Its mark was kept by the file (not looked for again); both cells done now.
    expect(calls).toEqual(["learn null", "remove 0-30", "remove 0-30", "remove 30-40"]);
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(2);
    // Another restart: the kept cells are laid already, nothing is made again.
    wm.reset();
    await removalSchedule.resume(app);
    await wm.settled();
    expect(calls.length).toBe(4);
    // Untaught, or an old project: nothing resumes.
    v2cloud.useSkillsForTests([]);
    expect(await removalSchedule.resume(app)).toBe(0);
  } finally {
    cleanup();
  }
}, 120_000);

test("a run in the background: the chat row's numbers while it's out, then the agent woken with what it did once any turn under way ends, as Edit's own event; Stop does nothing more", async () => {
  const { app, dir, cleanup } = fixtureHome("removal-row");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true });
  const reads: number[] = [];
  let gate = gated();
  blurReads(reads, () => gate.wait());
  const sent: string[] = [];
  let running = true;
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running }), send: async (_project: string, text: string) => void sent.push(text) };
  const before = { ...removalSchedule.timing };
  removalSchedule.timing.watchMs = 40;
  removalSchedule.timing.wakeEveryMs = 40;
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    await removalSchedule.ensure(app, id);
    while (removalSchedule.progressOf(id).out === 0) await Bun.sleep(20);
    // The row's numbers and its Details.
    expect(removalSchedule.statusOf(app, id).background).toMatchObject({ label: "Removing their text", done: 0, total: 1 });
    expect(removalSchedule.pieceRows(id)).toEqual([expect.objectContaining({ key: "blur:m@0-8000", what: "blur", name: "tape", from: 0, to: 8 })]);
    gate.open();
    await blur.settled();
    // Done while the agent's turn runs: it waits for the turn to end, then one turn of Edit's own.
    await Bun.sleep(300);
    expect(sent).toEqual([]);
    running = false;
    const until = Date.now() + 10_000;
    while (sent.length === 0 && Date.now() < until) await Bun.sleep(20);
    expect(sent.length).toBe(1);
    expect(sent[0]).toStartWith(`${EDIT_EVENT} Their text is out of the footage (1 piece).`);
    expect(sent[0]).toContain("- tape: text 0–8 s");
    expect(sent[0]).toContain("lay OUR subtitles");
    await Bun.sleep(200);
    expect(sent.length).toBe(1);
    expect(removalSchedule.statusOf(app, id)).toEqual({ background: null });
    // Stopped mid-run (another project): nothing more is done there and nobody is woken.
    gate = gated();
    fs.mkdirSync(join(dir, "b"), { recursive: true });
    const other = await labelledProject(app, await labelledFootage(join(dir, "b"), 9), 9, "q");
    await removalSchedule.ensure(app, other);
    while (removalSchedule.progressOf(other).out === 0) await Bun.sleep(20);
    removalSchedule.stop(app, other);
    expect(asks.isStopped(app.store.home, other)).toBe(true);
    gate.open();
    await blur.settled();
    await removalSchedule.ensure(app, other);
    await blur.settled();
    await Bun.sleep(300);
    expect(sent.length).toBe(1);
    expect(removalSchedule.progressOf(other).out).toBe(0);
    expect(removalSchedule.statusOf(app, other).background).toBeNull();
  } finally {
    Object.assign(removalSchedule.timing, before);
    cleanup();
  }
}, 120_000);

test("two runs done while the person's turn runs: one turn of Edit's own once it ends, telling of both", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-wake-once");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL], 9: [LABEL], 11: [LABEL] });
  teach({ text: true });
  const reads: number[] = [];
  blurReads(reads);
  const sent: string[] = [];
  let running = true;
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running }), send: async (_project: string, text: string) => void sent.push(text) };
  const before = { ...removalSchedule.timing };
  removalSchedule.timing.watchMs = 30;
  removalSchedule.timing.wakeEveryMs = 30;
  try {
    const file = await labelledFootage(dir, 30);
    const id = await labelledProject(app, file, 30);
    await store.update(id, "test", (p) => {
      (p.clips[0] as VideoClip).duration = 240;
    });
    await removalSchedule.ensure(app, id);
    await blur.settled();
    await Bun.sleep(200);
    expect(blurs(id)).toEqual([["m", 0, 8, "done"]]);
    // The clip grows: a second run, done while the turn still runs.
    await store.update(id, "agent", (p) => {
      (p.clips[0] as VideoClip).duration = 360;
    });
    await removalSchedule.ensure(app, id);
    await blur.settled();
    await Bun.sleep(200);
    expect(blurs(id)).toEqual([["m", 0, 12, "done"]]);
    expect(sent).toEqual([]);
    running = false;
    const until = Date.now() + 10_000;
    while (sent.length === 0 && Date.now() < until) await Bun.sleep(20);
    await Bun.sleep(200);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("(2 pieces)");
  } finally {
    Object.assign(removalSchedule.timing, before);
    cleanup();
  }
}, 120_000);

test("after a start nothing else has read the channels: removal reads them itself, so a group's lesson is found and the work resumes (Nov 17, Sphe's M4 on nightly-82)", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-group-resume");
  reading({});
  const calls: string[] = [];
  wm.useEngine(engine(calls));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  // The lesson is the group's; the channel's group is known only once the channels are read.
  const lesson = removal.changed(null, { watermarks: true }, []);
  v2cloud.useSkillsForTests([{ name: removal.SKILL, key: v2cloud.ownKey("skill", "gr-caught--edit", removal.SKILL), text: removal.write(lesson) }]);
  channels.useChannelsForTests([], []);
  const read = spyOn(channels, "refresh").mockImplementation(async () => channels.useChannelsForTests([], [{ key: "gr-caught", lanes: { ideas: "", thumbnails: "", script: "", edit: "" }, channels: ["ch-taught"] }]));
  try {
    const file = await labelledFootage(dir, 20);
    const id = await labelledProject(app, file, 20);
    expect(await removalSchedule.resume(app)).toBe(1);
    await wm.settled();
    expect(read).toHaveBeenCalled();
    expect(calls).toEqual(["learn null", "remove 0-20"]);
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(1);
  } finally {
    read.mockRestore();
    channels.useChannelsForTests([], []);
    cleanup();
  }
}, 60_000);

test("stopped, then asked for a stretch: only that stretch is blurred, what ran by itself stays stopped (Sphe, Nov 17: just the intro and the first case's start)", async () => {
  const { app, dir, cleanup } = fixtureHome("removal-stop-ask");
  reading(Object.fromEntries(Array.from({ length: 15 }, (_, at) => [at * 2 + 1, [LABEL]])));
  teach({ text: true });
  const reads: number[] = [];
  blurReads(reads);
  try {
    const file = await labelledFootage(dir, 30);
    const id = await labelledProject(app, file, 30);
    removalSchedule.stop(app, id);
    await removalSchedule.ensure(app, id);
    await blur.settled();
    expect([reads, blurs(id)]).toEqual([[], []]);
    await Bun.sleep(5);
    const said = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: id, kinds: ["text"], from: 2, to: 6 } } }, null)) as { result: { isError: boolean } };
    expect(said.result.isError).toBe(false);
    await blur.settled();
    expect(blurs(id)).toEqual([["m", 2, 6, "done"]]);
    // An edit later, a restart: still only that stretch, nothing read again.
    const count = reads.length;
    await removalSchedule.ensure(app, id);
    await blur.settled();
    expect(await removalSchedule.resume(app)).toBe(1);
    await blur.settled();
    expect(blurs(id)).toEqual([["m", 2, 6, "done"]]);
    expect(reads.length).toBe(count);
  } finally {
    cleanup();
  }
}, 120_000);

test("after the person's Stop a cleaned strip stays unless what's asked since runs over its seconds (Nov 24, the Hitman edit: the intro's captions came back)", () => {
  const strip = { id: "s", name: "s", path: "/s.mp4", kind: "video", duration: 20, cleans: { media: "m", from: 10, to: 30, box: [0, 0, 1, 0.9] } } as unknown as Media;
  const media = { id: "m" } as Media;
  // Going: the blur or the model's new strips take its place.
  expect(tr.takesItsPlace([], strip, false)).toBe(true);
  // Stopped: nothing asked there, so it stays; asked over its seconds, the new run takes them.
  expect(tr.takesItsPlace([], strip, true)).toBe(false);
  expect(tr.takesItsPlace([{ media, spans: [[40, 50]] }], strip, true)).toBe(false);
  expect(tr.takesItsPlace([{ media: { id: "n" } as Media, spans: [[10, 30]] }], strip, true)).toBe(false);
  // Asked over only part of it: the rest would lose its clean, so it stays; asked over all of it, the new run takes it.
  expect(tr.takesItsPlace([{ media, spans: [[25, 35]] }], strip, true)).toBe(false);
  expect(tr.takesItsPlace([{ media, spans: [[10, 20]] }, { media, spans: [[20, 30.05]] }], strip, true)).toBe(true);
  expect(tr.takesItsPlace([{ media, spans: [[5, 35]] }], strip, true)).toBe(true);
});

test("ours go over their subtitles only where removal takes theirs out: taught to by itself, or asked for those seconds; not when stopped or taught to wait", async () => {
  const { app, store, cleanup } = fixtureHome("removal-theirs-taken");
  try {
    const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    project.media = [{ id: "m", name: "tape", path: "/tape.mp4", kind: "video", duration: 30, width: 320, height: 180, fps: 30, has_audio: false }];
    project.clips = [{ id: "f", track: "v1", start: 0, duration: 900, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip];
    project.channel = "ch-taught";
    await app.store.replace(project.id, null, project, "test");
    const id = project.id;
    const at = (from: number, to: number) => tr.theirsTakenOut(app, store.get(id)!.project, { clip: "f", start: from * 30, end: to * 30 });
    // With no finder, a channel taught to take theirs out blurs only what's marked (`wantedOf`): ours wait for a mark.
    teach({ subtitles: true });
    expect(at(10, 12)).toBe(false);
    asks.add(app.store.home, id, { at: Date.now(), kinds: ["subtitles"], media: { m: [[9, 13]] }, mark: "add" });
    expect(at(10, 12)).toBe(true);
    asks.add(app.store.home, id, { at: Date.now(), kinds: ["subtitles"], media: { m: [[9, 13]] }, mark: "remove" });
    // A machine with the finder takes out all it finds: no mark needed.
    found.useFinderForTests({ find: async () => ({ ask: [], sheets: [] }), finish: async () => { throw new Error("not read here"); } });
    expect(at(10, 12)).toBe(true);
    // Taught only their text, or their subtitles only when asked: theirs stay, so ours are refused there.
    teach({ text: true });
    expect(at(10, 12)).toBe(false);
    teach({ subtitles: true }, [], { subtitles: "asked" });
    expect(at(10, 12)).toBe(false);
    // Asked for 5–15 s of the tape: those seconds, not the rest.
    asks.add(app.store.home, id, { at: Date.now(), kinds: ["subtitles"], media: { m: [[5, 15]] } });
    expect(at(10, 12)).toBe(true);
    expect(at(14, 18)).toBe(false);
    // Stopped: only what's asked since.
    teach({ subtitles: true });
    await Bun.sleep(5);
    removalSchedule.stop(app, id, ["subtitles"]);
    expect(at(20, 22)).toBe(false);
  } finally {
    found.useFinderForTests(null);
    cleanup();
  }
});

test("after one part is stopped alone, the agent's marks start it again on what they mark", async () => {
  const { app, cleanup } = fixtureHome("removal-part-marks");
  try {
    teach({ text: true });
    const id = "p-marks";
    asks.stopParts(app.store.home, id, ["text"]);
    expect(asks.scope(removal.lessonOf({ channel: "ch-taught" } as Project), app.store.home, id, "text", "m", [[0, 30]])).toEqual([]);
    await Bun.sleep(5);
    asks.add(app.store.home, id, { at: Date.now(), kinds: ["text"], media: { m: [[4, 9]] }, mark: "add" });
    expect(asks.askedKinds(app.store.home, id)).toEqual(["text"]);
    expect(asks.scope(removal.lessonOf({ channel: "ch-taught" } as Project), app.store.home, id, "text", "m", [[0, 30]])).toEqual([[4, 9]]);
  } finally {
    cleanup();
  }
});

test("one part stopped alone, the rest goes on; asked again, it runs on what's named (Nov 24, the Trooper edit: no way to stop just its watermarks)", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-stop-part");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true, watermarks: true });
  const reads: number[] = [];
  blurReads(reads);
  const calls: string[] = [];
  wm.useEngine(engine(calls));
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  const call = async (args: Record<string, unknown>) =>
    ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "start_removal", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
  let id = "";
  try {
    const file = await labelledFootage(dir, 8);
    id = await labelledProject(app, file, 8);
    const said = await call({ stop: true, kinds: ["watermarks"] });
    expect(said.isError).toBe(false);
    expect(said.content[0]!.text).toContain("Stopped taking their watermarks out");
    await removalSchedule.ensure(app, id);
    await blur.settled();
    await wm.settled();
    // Their text still blurred; no file looked at for a mark.
    expect(blurs(id)).toEqual([["m", 0, 8, "done"]]);
    expect(calls).toEqual([]);
    expect(asks.isStopped(app.store.home, id)).toBe(false);
    // Kept across a restart.
    asks.reset();
    await removalSchedule.ensure(app, id);
    await wm.settled();
    expect(calls).toEqual([]);
    await Bun.sleep(5);
    // Asked for again: done on what's named.
    expect((await call({ kinds: ["watermarks"], media: ["m"] })).isError).toBe(false);
    await wm.settled();
    expect(calls).toEqual(["learn null", "remove 0-8"]);
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(1);
  } finally {
    cleanup();
  }
}, 120_000);

test("a plan begun before a Stop of their text lays nothing after it", async () => {
  const { app, dir, cleanup } = fixtureHome("removal-stop-text-plan");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true });
  const reads: number[] = [];
  blurReads(reads);
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    const planning = tr.ensure(app, id);
    removalSchedule.stop(app, id, ["text"]);
    await planning;
    await blur.settled();
    expect(blurs(id)).toEqual([]);
  } finally {
    cleanup();
  }
}, 120_000);

test("removal starts by itself as soon as edits rest; a longer clip is blurred to its new end", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-timing");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL], 9: [LABEL], 11: [LABEL] });
  teach({ text: true });
  const reads: number[] = [];
  blurReads(reads);
  removalSchedule.timing.restMs = 50;
  removalSchedule.start(app);
  try {
    const file = await labelledFootage(dir, 30);
    const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    const media: Media = { id: "m", name: "tape", path: file, kind: "video", duration: 30, width: 320, height: 180, fps: 30, has_audio: false };
    project.media = [media];
    project.channel = "ch-taught";
    await app.store.replace(project.id, null, project, "test");
    await burned.warm(app.media, media);
    takeProposed(app, project.id);
    // The first cut: 0–8 s of the tape on the timeline.
    await store.update(project.id, "agent", (p) => {
      p.clips = [{ id: "f", track: "v1", start: 0, duration: 240, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip];
    });
    const until = Date.now() + 30_000;
    while (!tracked(app, project.id) && Date.now() < until) await Bun.sleep(100);
    await blur.settled();
    expect(blurs(project.id)).toEqual([["m", 0, 8, "done"]]);
    // The clip extended to 12 s: its blur follows it there.
    await store.update(project.id, "agent", (p) => {
      (p.clips[0] as VideoClip).duration = 360;
    });
    const later = Date.now() + 30_000;
    while (blurs(project.id)[0]?.[2] !== 12 && Date.now() < later) await Bun.sleep(100);
    await blur.settled();
    expect(blurs(project.id)).toEqual([["m", 0, 12, "done"]]);
    expect(removalSchedule.statusOf(app, project.id)).toEqual({ background: null });
  } finally {
    removalSchedule.timing.restMs = 2000;
    cleanup();
  }
}, 120_000);

// Nov 25, the reviews of turning local-first on: what waits for an original to be on R2 (RunPod's read, track and clean)
// had nothing to wake it once the upload landed, short of an edit.
test("an original that goes up from here brings the projects showing it up to date, with no edit to wake them", async () => {
  const { app, dir, cleanup } = fixtureHome("removal-woken-by-upload");
  reading({ 1: [LABEL], 3: [LABEL], 5: [LABEL], 7: [LABEL] });
  teach({ text: true });
  const reads: number[] = [];
  blurReads(reads);
  // Edits resting and the start's resume wake nothing during the test: only the upload does.
  removalSchedule.timing.restMs = 600_000;
  removalSchedule.timing.resumeMs = 600_000;
  removalSchedule.start(app);
  // Tracked here (the test has no relay): what matters is that it's woken.
  removerCloud.setOnForTests(false);
  const key = "edit/originals/youtube/wokenByUp1/tape.mp4";
  try {
    // Its original here at its key's place, as a local-first import keeps it.
    const file = cloudMedia.localPath(app.store.cacheDir(), key);
    fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    fs.renameSync(await labelledFootage(dir, 8), file);
    cloudMedia.rememberLocalOriginal(app.store.cacheDir(), key, file);
    const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const project = structuredClone(live.project) as Project;
    const media: Media = { id: "m", name: "tape", path: file, kind: "video", duration: 8, width: 320, height: 180, fps: 30, has_audio: false, cloud: { source: "youtube:wokenByUp1", original: key, proxy: key, size: 1 } };
    project.media = [media];
    project.channel = "ch-taught";
    project.clips = [{ id: "f", track: "v1", start: 0, duration: 240, color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, opacity: 1 } as VideoClip];
    await app.store.replace(project.id, null, project, "test");
    await burned.warm(app.media, media);
    takeProposed(app, project.id);
    expect(blurs(project.id)).toEqual([]);
    cloud.goingUp(key);
    cloud.upEnded(key, true);
    const until = Date.now() + 30_000;
    while (!tracked(app, project.id) && Date.now() < until) await Bun.sleep(100);
    await blur.settled();
    expect(blurs(project.id)).toEqual([["m", 0, 8, "done"]]);
  } finally {
    removalSchedule.timing.restMs = 2000;
    removalSchedule.timing.resumeMs = 15_000;
    removalSchedule.reset();
    removerCloud.setOnForTests(null);
    cleanup();
  }
}, 120_000);

test("an export waits for pieces still out, and the agent looks at each watermark piece and rejects one that isn't clean: done once more", async () => {
  const { app, dir, store, cleanup } = fixtureHome("removal-check");
  reading({});
  teach({ watermarks: true });
  const calls: string[] = [];
  const gate = gated();
  const base = engine(calls);
  let held = true;
  wm.useEngine({ ...base, remove: async (piece, progress) => (held ? (calls.push("held"), await gate.wait(), (held = false)) : null, base.remove(piece, progress)) });
  wm.useShelf(wm.shelfIn(join(dir, "shelf"), () => false));
  try {
    const file = await labelledFootage(dir, 8);
    const id = await labelledProject(app, file, 8);
    await removalSchedule.ensure(app, id);
    // While the piece is out: the row counts it, a quick export look says "still rendering", the export's step says how far.
    while (!calls.includes("held")) await Bun.sleep(20);
    expect(removalSchedule.statusOf(app, id)).toEqual({ background: { label: "Removing their watermarks", done: 0, total: 1, started_at: expect.any(Number) } });
    expect(removalSchedule.exportLine(id)).toBe("Removing their text · 0 of 1 pieces");
    expect(await removalSchedule.waitForPieces(app, id, 200).catch((error: unknown) => String(error))).toContain("still rendering");
    const waited = removalSchedule.waitForPieces(app, id, 60_000);
    gate.open();
    await waited;
    await wm.settled();
    expect(removalSchedule.exportLine(id)).toBeNull();
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "check_removal", arguments: { project_id: id, ...args } } }, null)) as { result: { content: { type: string; text?: string }[]; isError: boolean } }).result;
    const looked = await call({});
    expect(looked.isError).toBe(false);
    expect(looked.content[0]!.text).toContain("watermark:m@0 · tape 0–8 s · watermark · done");
    expect(looked.content.some((one) => one.type === "image")).toBe(true);
    // Looked at once: not shown again.
    expect((await call({})).content.some((one) => one.type === "image")).toBe(false);
    // Rejected: done once more.
    const again = await call({ reject: [{ piece: "watermark:m@0", why: "a ghost of the mark" }] });
    expect(again.content[0]!.text).toContain("watermark:m@0: done once more");
    // Started again in the background (watermark_removal.ts `reject`).
    const until = Date.now() + 20_000;
    while (calls.filter((one) => one.startsWith("remove")).length < 2 && Date.now() < until) await Bun.sleep(20);
    await wm.settled();
    expect(calls.filter((one) => one.startsWith("remove")).length).toBe(2);
    expect(store.get(id)!.project.media.filter((media) => media.cleans?.what === "watermark").length).toBe(1);
    // A blur's stretch isn't rejected here: it's marked again tighter.
    expect((await call({ reject: [{ piece: "blur:m@0-8000", why: "misses a word" }] })).content[0]!.text).toContain("mark that stretch again tighter");
  } finally {
    cleanup();
  }
}, 120_000);

test("masksWithMarks covers the first and last whole frames when a mark starts or ends mid-frame", () => {
  // 278.952 s at 30 fps falls inside frame 8368 (278.933..278.967 s): frame 0 of the stretch must still carry the mark
  // or the temporal inpaint model copies the unmasked watermark from frame 0 onto every masked frame after it.
  const box: [number, number, number, number] = [0.3, 0.78, 0.49, 0.95];
  const empty = Array.from({ length: 101 }, () => [] as [number, number, number, number][]);
  const out = tr.masksWithMarks(empty, [{ from: 278.952, to: 282.285333, box }], 30, 8368);
  expect(out[0]).toEqual([box]);
  expect(out[100]).toEqual([box]);
});

test("after their subtitles are stopped, text that goes on over the same seconds sends the model none of the stopped captions (CodeRabbit on #5)", () => {
  const media = { id: "m" } as Media;
  const plan = { media, source: "sha256:s", spans: [[10, 20], [40, 50]] as [number, number][], marks: [] };
  // Subtitles on 12–14 s and 44–46 s (frames at 30 fps), a label the whole time.
  const read = { version: 1, width: 1920, height: 1080, fps: 30, covered: [[0, 60]], masks: [[360, 419, 0, 900, 1920, 1000, "subtitle"], [1320, 1379, 0, 900, 1920, 1000, "subtitle"], [0, 1800, 0, 0, 300, 80, "label"]] } as unknown as found.Found;
  const all = (_media: string, spans: [number, number][]) => spans;
  // Asked of their subtitles everywhere: as planned.
  expect(tr.subtitlesAsked([plan], all, () => read)).toEqual([plan]);
  // Stopped after 30 s: the first stretch as planned; of the second, only the seconds with no subtitle of theirs.
  const until30 = (_media: string, spans: [number, number][]) => spans.flatMap(([a, b]): [number, number][] => (a < 30 ? [[a, Math.min(b, 30)]] : []));
  expect(tr.subtitlesAsked([plan], until30, () => read)[0]!.spans).toEqual([[10, 20], [40, 44], [46, 50]]);
  // A file the finder hasn't read: left as it is.
  expect(tr.subtitlesAsked([plan], until30, () => null)).toEqual([plan]);
});
