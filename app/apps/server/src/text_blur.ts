// Their text blurred where Vmake isn't used (removal_modes.ts: a channel
// taught removal, from its third case on; or where asked, "just blur case 2"):
// a Gaussian blur tracked over the words themselves, never a big still box
// over their band (Sphe, Nov 18).
//
// Only the stretches the agent marked go (removal_asks.ts `marked`). Each is
// read for its words on screen (screen_text's `screenTextAt`, the region where
// their text is: their subtitles' band, their labels' boxes) three times a
// second, and twice more between two reads where the words change, appear or
// go, so each change is found within a twelfth of a second. What's theirs is
// kept (their band, their labels; never the camera's stamp or what the lesson
// keeps) and its box is the track: between two reads of the same words it
// moves from one to the other (text that slides), across a change it's both
// boxes for the few frames it can't tell, and with no words the blur is off.
//
// The track is kept by file and seconds (`<cache>/cleaned/tracks/`), so a
// re-cut, a second project of the same case, or a restart lays it again with
// nothing read twice. It's laid as one adjustment per clip and stretch, named
// `TRACKED · <clip>`: its box keyframed frame by frame (in project pixels,
// through the clip's own framing as it pushes in, inside a card's picture),
// feathered, padded only a little past the letters, its strength following
// the clip through a dissolve. Laid again only when what it would be changes
// (ids kept otherwise, as clean_strips' are), and taken off when its marks or
// its section's mode change. Where it lies the blur over their band laid
// while waiting (burned_subtitles `cover`) gives way, and their subtitles
// count as gone (clean_strips.ts `strippedFrames`).

import * as fs from "node:fs";

import type { App } from "./app.ts";
import { TRACKED } from "./clean_strips.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { framingAt } from "./frames_fill.ts";
import * as markBlurs from "./mark_blurs.ts";
import type { AdjustmentClip, Keyframe, Media, Project, VideoClip } from "./model.ts";
import { native, type Box, type ScreenText } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import { clipEnd, fps as fpsOf, freshId, sample } from "./project.ts";
import { round } from "./rust.ts";

export { TRACKED };
export type Spans = [number, number][];

/** Reads a second; and the steps of halving between two that differ. */
export const RATE = 3;
const HALVINGS = 2;
/** The house text blur: strong enough that no letter can be read, its edge feathered (at 1080 lines; scaled). */
const RADIUS_AT_1080 = 28;
const FEATHER_AT_1080 = 8;
/** Past the letters each side, as a share of the box's height (at least PAD_LEAST px at 1080). */
const PAD = 0.12;
const PAD_LEAST = 6;
/** More each side across, as a share of the box's height. */
const PAD_ACROSS = 0.3;
/** Two reads say the same words when their words share this much. */
const SAME = 0.5;
/** Reads asked of the engine at once (it gives way to a play between them). */
const CHUNK = 30;
/** A new way of tracking is a new file. */
const VERSION = 1;

/** One read: a source second, and the box of their words there (shares of the picture), null with none. */
export interface Sample {
  t: number;
  box: Box | null;
  words: string;
}

/** What one file's marked seconds need (text_removal.ts `plan`). */
export interface BlurPlan {
  media: Media;
  /** The file's identity (text_removal `sourceOf`): its tracks are kept by it. */
  source: string;
  /** Source seconds to blur (marked, and in a part the blur takes). */
  spans: Spans;
  /** Their subtitles' band, when found (burned_subtitles); their labels' boxes (text_removal `labelBoxes`). */
  band: Box | null;
  labels: Box[];
  /** The camera's text and what the lesson keeps: never theirs. */
  avoid: Box[];
  /** The parts taken out here: their subtitles, their other text. */
  subtitles: boolean;
  text: boolean;
}

/** One stretch being tracked or tracked, as check_removal and the waiting row list it. */
export interface BlurPiece {
  key: string;
  media: string;
  name: string;
  from: number;
  to: number;
  state: "queued" | "running" | "done" | "failed";
  why?: string;
}

/** What reads the words on screen: the engine's (tests put a stand-in here). */
export const reader = {
  read: (input: string, size: [number, number], fps: number, region: Box, times: number[]): Promise<ScreenText[][]> => {
    const at = native().screenTextAt;
    if (at === undefined) throw new Error("this build of Edit can't read words in a region yet");
    return at(input, size, fps, region, times);
  },
};

// ---------------------------------------------------------------------------
// Which words are theirs

const area = (box: Box) => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
const overlap = (a: Box, b: Box) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
const grow = (box: Box, by: number): Box => [Math.max(0, box[0] - by), Math.max(0, box[1] - by), Math.min(1, box[2] + by), Math.min(1, box[3] + by)];
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Where their text may be: their band and labels, grown; the lower part of the picture for subtitles not found yet; else all of it. */
export function regionOf(plan: Pick<BlurPlan, "band" | "labels" | "subtitles" | "text">): Box {
  const boxes: Box[] = [];
  if (plan.subtitles) boxes.push(plan.band !== null ? grow(plan.band, 0.06) : [0.04, 0.6, 0.96, 1]);
  if (plan.text) boxes.push(...(plan.labels.length > 0 ? plan.labels.map((box) => grow(box, 0.05)) : [[0, 0, 1, 1] as Box]));
  return boxes.length === 0 ? [0, 0, 1, 1] : boxes.reduce(union);
}

/** Whether a line read is theirs: in their band (or low and centred, for subtitles not found yet) or on a label of theirs; never the camera's or what's kept. */
export function theirs(plan: Pick<BlurPlan, "band" | "labels" | "avoid" | "subtitles" | "text">, line: ScreenText): boolean {
  const box = line.b;
  if (area(box) <= 0 || !/\p{L}|\p{N}/u.test(line.t)) return false;
  if (plan.avoid.some((keep) => overlap(box, keep) > 0.3 * area(box))) return false;
  // A subtitle has words (a read of digits alone in their band is the picture's: a plate, a shirt's number).
  if (plan.subtitles && (line.t.match(/\p{L}/gu) ?? []).length >= 2) {
    if (plan.band !== null ? overlap(box, grow(plan.band, 0.03)) > 0.5 * area(box) : box[1] > 0.66 && Math.abs((box[0] + box[2]) / 2 - 0.5) < 0.25) return true;
  }
  if (plan.text) {
    // No label of theirs known (a file not read yet): words that aren't a stamp's (along the very top or bottom, mostly digits).
    if (plan.labels.length === 0) {
      const middle = (box[1] + box[3]) / 2;
      const letters = (line.t.match(/\p{L}/gu) ?? []).length;
      const digits = (line.t.match(/\p{N}/gu) ?? []).length;
      return middle > 0.1 && middle < 0.92 && letters >= 3 && digits < letters;
    }
    if (plan.labels.some((label) => overlap(box, grow(label, 0.02)) > 0.5 * area(box))) return true;
  }
  return false;
}

const tokens = (words: string) => new Set(words.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((one) => one.length >= 2));
/** Whether two reads show the same words (OCR reads a line a little differently each time). */
export function same(a: Sample, b: Sample): boolean {
  if (a.box === null || b.box === null) return a.box === b.box;
  const [x, y] = [tokens(a.words), tokens(b.words)];
  if (x.size === 0 || y.size === 0) return overlap(a.box, b.box) > 0.5 * Math.min(area(a.box), area(b.box));
  const both = [...x].filter((one) => y.has(one)).length;
  return both >= SAME * (x.size + y.size - both);
}

/** Whether two lines read sit on one row, side by side (OCR reads a subtitle's words in pieces: "THE" apart from "SUSPECT RAN"). */
function besides(a: Box, b: Box): boolean {
  const high = Math.max(a[3] - a[1], b[3] - b[1]);
  const gap = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
  return Math.abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) < 0.5 * high && gap < 1.5 * high && Math.min(a[3] - a[1], b[3] - b[1]) >= SPECK * high;
}

/** A read much shorter than their tallest line beside it is the picture's speckle read as a letter ("0", "90"), never theirs. */
const SPECK = 0.55;

/** Their lines among those read: `theirs`, and the words on the same row beside one of them (never the camera's or what's kept). */
export function theirLines(plan: Parameters<typeof theirs>[0], lines: ScreenText[]): ScreenText[] {
  const mine = lines.filter((line) => theirs(plan, line));
  const rest = lines.filter((line) => !mine.includes(line) && area(line.b) > 0 && /\p{L}|\p{N}/u.test(line.t) && !plan.avoid.some((keep) => overlap(line.b, keep) > 0.3 * area(line.b)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const line of [...rest]) {
      if (!mine.some((one) => besides(one.b, line.b))) continue;
      mine.push(line);
      rest.splice(rest.indexOf(line), 1);
      grew = true;
    }
  }
  const high = (box: Box) => box[3] - box[1];
  // Near a line of theirs over SPECK taller (its row, or just above or below it): speckle.
  return mine.filter((line) => !mine.some((other) => high(line.b) < SPECK * high(other.b) && Math.abs((line.b[1] + line.b[3]) / 2 - (other.b[1] + other.b[3]) / 2) < 1.5 * high(other.b)));
}

function sampleOf(plan: Parameters<typeof theirs>[0], t: number, lines: ScreenText[]): Sample {
  const mine = theirLines(plan, lines).sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
  return { t, box: mine.length === 0 ? null : mine.map((line) => line.b).reduce(union), words: mine.map((line) => line.t).join(" ") };
}

// ---------------------------------------------------------------------------
// The track

/**
 * Their text's box over source seconds [from, to): read RATE a second, then
 * between each two reads that differ (words changed, came or went) halved
 * HALVINGS times. `read` gives the lines at each of the times asked.
 */
export async function track(plan: Parameters<typeof theirs>[0], from: number, to: number, read: (times: number[]) => Promise<ScreenText[][]>): Promise<Sample[]> {
  const step = 1 / RATE;
  const times: number[] = [];
  for (let t = from; t < to - 1e-6; t += step) times.push(round(t * 1000) / 1000);
  times.push(round(Math.max(from, to - 0.01) * 1000) / 1000);
  const readAll = async (at: number[]): Promise<Sample[]> => {
    const out: Sample[] = [];
    for (let i = 0; i < at.length; i += CHUNK) {
      await playing.whenIdle();
      const part = at.slice(i, i + CHUNK);
      const lines = await read(part);
      part.forEach((t, j) => out.push(sampleOf(plan, t, lines[j] ?? [])));
    }
    return out;
  };
  let samples = await readAll(times);
  for (let halving = 0; halving < HALVINGS; halving++) {
    const mids: number[] = [];
    for (let i = 0; i + 1 < samples.length; i++) if (!same(samples[i]!, samples[i + 1]!)) mids.push(round(((samples[i]!.t + samples[i + 1]!.t) / 2) * 1000) / 1000);
    if (mids.length === 0) break;
    samples = [...samples, ...(await readAll(mids))].sort((a, b) => a.t - b.t);
  }
  return samples;
}

/** Their text's box at source second `t` of a track (see the top), null where there's none. */
export function boxAt(samples: Sample[], t: number): Box | null {
  if (samples.length === 0) return null;
  // The last read at or before t (the first when t is before them all).
  let [lo, hi] = [0, samples.length - 1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const a = samples[i]!;
  const b = samples[i + 1];
  if (b === undefined || t <= a.t) return a.box;
  if (a.box !== null && b.box !== null) {
    if (!same(a, b)) return union(a.box, b.box);
    const k = (t - a.t) / (b.t - a.t);
    return a.box.map((value, at) => value + (b.box![at]! - value) * k) as Box;
  }
  // Came or went between two reads: blurred across all of it (never a frame of it sharp).
  return a.box ?? b.box;
}

// ---------------------------------------------------------------------------
// Laid on the timeline

/** Keys over frames [0, values.length) that follow `values` within `tolerance`, linear between (a jump is two keys a frame apart). */
export function keysFor(values: number[], tolerance: number): Keyframe[] {
  const keys: number[] = [0];
  let last = 0;
  for (let end = 2; end <= values.length; end++) {
    // Can the line from the last key to frame end-1 carry every frame between within tolerance?
    const to = end - 1;
    let fits = true;
    for (let f = last + 1; f < to; f++) {
      const expected = values[last]! + ((values[to]! - values[last]!) * (f - last)) / (to - last);
      if (Math.abs(expected - values[f]!) > tolerance) {
        fits = false;
        break;
      }
    }
    if (!fits) {
      keys.push(to - 1);
      last = to - 1;
    }
  }
  if (values.length > 1 && keys.at(-1) !== values.length - 1) keys.push(values.length - 1);
  return keys.map((frame) => ({ frame, value: round(values[frame]! * 1000) / 1000, ease: "linear" as const }));
}

/** One tracked stretch for a clip: the file's source seconds [from, to) and their track. */
export interface Laid {
  from: number;
  to: number;
  samples: Sample[];
}

/**
 * The tracked blurs over `clip` (footage `media`) for each of `tracks`: one
 * adjustment a stretch it shows of them, its box and strength keyed frame
 * by frame. Ids and lanes are left to `lay`.
 */
export function blursFor(project: Project, clip: VideoClip, media: Media, tracks: Laid[]): AdjustmentClip[] {
  const fps = fpsOf(project);
  const { width, height } = project.settings;
  const [mw, mh] = [media.width || width, media.height || height];
  const scaleOf = height / 1080;
  const feather = Math.max(2, Math.round(FEATHER_AT_1080 * scaleOf));
  // Where the clip shows at all, and its strength through a dissolve: mark_blurs' runs, for a box the size of the picture.
  const runs = markBlurs.blursFor(project, clip, media, { text: "their text", box: [0, 0, 1, 1] });
  const out: AdjustmentClip[] = [];
  const sourceAt = (frame: number) => clip.source_in + ((frame - clip.start) / fps) * clip.speed;
  for (const run of runs) {
    for (const one of tracks) {
      // The run's frames whose source seconds are in [from, to).
      let start = Math.max(run.start, clip.start + Math.ceil(((one.from - clip.source_in) / clip.speed) * fps - 1e-6));
      let end = Math.min(clipEnd(run), clip.start + Math.ceil(((one.to - clip.source_in) / clip.speed) * fps - 1e-6));
      while (start < end && boxAt(one.samples, sourceAt(start)) === null) start++;
      while (end > start && boxAt(one.samples, sourceAt(end - 1)) === null) end--;
      if (end - start < 2) continue;
      const fade = run.keyframes?.opacity;
      const values: { x: number[]; y: number[]; w: number[]; h: number[]; opacity: number[] } = { x: [], y: [], w: [], h: [], opacity: [] };
      let held: Box | null = null;
      // A frame with no words keeps the box of the nearest with them (the blur is off there; its box mustn't sweep).
      const boxes = Array.from({ length: end - start }, (_, at) => boxAt(one.samples, sourceAt(start + at)));
      const nextShown: (Box | null)[] = new Array(boxes.length).fill(null);
      for (let at = boxes.length - 1; at >= 0; at--) nextShown[at] = boxes[at] ?? nextShown[at + 1] ?? null;
      boxes.forEach((box, at) => {
        const frame = start + at;
        const shown = box ?? held ?? nextShown[at]!;
        if (box !== null) held = box;
        const into = frame - clip.start;
        const { x, y, scale } = framingAt(clip, into);
        const fit = Math.min(width / mw, height / mh) * scale;
        const [x0, y0, x1, y1] = shown;
        const h = (y1 - y0) * mh * fit;
        const pad = Math.max(PAD_LEAST * scaleOf, PAD * h) + feather;
        // OCR's box stops short of a line's first and last letters (a letter showed at each end, Nov 18): a letter's width more across.
        const across = pad + PAD_ACROSS * h;
        let rect: [number, number, number, number] = [((x0 + x1) / 2 - 0.5) * mw * fit + x, ((y0 + y1) / 2 - 0.5) * mh * fit + y, (x1 - x0) * mw * fit + 2 * across, h + 2 * pad];
        if (scale < 0.99) rect = markBlurs.insidePicture(project, clip, media, rect, into);
        values.x.push(rect[0]);
        values.y.push(rect[1]);
        values.w.push(rect[2]);
        values.h.push(rect[3]);
        const strength = fade !== undefined && fade.length > 0 ? (sample(fade, frame - run.start) ?? 1) : 1;
        values.opacity.push(box === null ? 0 : strength);
      });
      const keyframes: Record<string, Keyframe[]> = {};
      const params = { "blur.x": values.x, "blur.y": values.y, "blur.width": values.w, "blur.height": values.h } as const;
      for (const [param, list] of Object.entries(params)) {
        const keys = keysFor(list, 0.75);
        if (keys.length > 1 && keys.some((key) => Math.abs(key.value - keys[0]!.value) > 0.5)) keyframes[param] = keys;
      }
      if (values.opacity.some((value) => value < 0.999)) keyframes.opacity = keysFor(values.opacity, 0.01);
      out.push({
        id: "",
        track: "",
        start,
        duration: end - start,
        color: "blue",
        name: `${TRACKED} · ${clip.id}`,
        fade_in: 0,
        fade_out: 0,
        ...(Object.keys(keyframes).length > 0 ? { keyframes } : {}),
        type: "adjustment",
        grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
        blur: { radius: Math.round(RADIUS_AT_1080 * scaleOf), x: round(values.x[0]!), y: round(values.y[0]!), width: round(values.w[0]!), height: round(values.h[0]!), feather, shape: "rect" },
        opacity: 1,
      } as AdjustmentClip);
    }
  }
  return out;
}

const isTracked = (clip: Project["clips"][number]) => clip.type === "adjustment" && (clip.name ?? "").startsWith(`${TRACKED} · `);
const shapeOf = (clip: Project["clips"][number]) => JSON.stringify({ ...clip, id: "", track: "" });

/**
 * Lays exactly `want` (from `blursFor`) in `project`: those already there as
 * they'd be are kept (their ids and lanes), the rest of the tracked blurs go,
 * the missing are added. Whether anything changed.
 */
export function lay(project: Project, want: AdjustmentClip[]): boolean {
  const standing = new Map<string, string[]>();
  for (const clip of project.clips) if (isTracked(clip)) standing.set(shapeOf(clip), [...(standing.get(shapeOf(clip)) ?? []), clip.id]);
  const kept = new Set<string>();
  const missing: AdjustmentClip[] = [];
  for (const one of want) {
    const match = standing.get(shapeOf(one))?.shift();
    if (match !== undefined) kept.add(match);
    else missing.push(one);
  }
  const gone = project.clips.filter((clip) => isTracked(clip) && !kept.has(clip.id));
  if (gone.length === 0 && missing.length === 0) return false;
  const lanes = new Set(gone.map((clip) => clip.track));
  project.clips = project.clips.filter((clip) => !gone.includes(clip));
  project.tracks = project.tracks.filter((track) => !lanes.has(track.id) || project.clips.some((clip) => clip.track === track.id));
  for (const one of missing) {
    const clip = { ...one, id: freshId(project, "c") } as AdjustmentClip;
    clip.track = markBlurs.laneFor(project, clip.start, clipEnd(clip), TRACKED);
    project.clips.push(clip);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The work, in the background

const pieces = new Map<string, Map<string, BlurPiece>>();
/** Each project's last plans (a track that's done lays them again). */
const plans = new Map<string, BlurPlan[]>();
/** Tracks read, by file and seconds. */
const tracks = new Map<string, Sample[]>();
/** Tracks to read, one at a time (OCR on the CPU, beside everything else). */
const queue: { key: string; run: () => Promise<void> }[] = [];
let busy: Promise<void> | null = null;

const trackKey = (source: string, from: number, to: number) => `${source}|${Math.round(from * 1000)}|${Math.round(to * 1000)}`;
const fileOf = (app: App, source: string, from: number, to: number) =>
  join(app.store.cacheDir(), "cleaned", "tracks", source.replace(/[^a-z0-9]+/giu, "-").slice(0, 80), `${Math.round(from * 1000)}-${Math.round(to * 1000)}.v${VERSION}.json`);

function known(app: App, source: string, from: number, to: number): Sample[] | null {
  const key = trackKey(source, from, to);
  const hit = tracks.get(key);
  if (hit !== undefined) return hit;
  try {
    const kept = JSON.parse(fs.readFileSync(fileOf(app, source, from, to), "utf8")) as Sample[];
    tracks.set(key, kept);
    return kept;
  } catch {
    return null;
  }
}

/** The project's stretches being tracked or tracked. */
export function piecesOf(id: string): BlurPiece[] {
  return [...(pieces.get(id)?.values() ?? [])].sort((a, b) => a.media.localeCompare(b.media) || a.from - b.from);
}

/** How many of the project's stretches are still being tracked. */
export const outOf = (id: string): number => piecesOf(id).filter((one) => one.state === "queued" || one.state === "running").length;

/** Each file's tracked stretches the timeline needs now (only those read). */
function laidOf(app: App, id: string): Map<string, Laid[]> {
  const out = new Map<string, Laid[]>();
  for (const plan of plans.get(id) ?? []) {
    for (const [from, to] of plan.spans) {
      const samples = known(app, plan.source, from, to);
      if (samples !== null) out.set(plan.media.id, [...(out.get(plan.media.id) ?? []), { from, to, samples }]);
    }
  }
  return out;
}

/** The tracked blurs `project` should have now, over every clip of their footage. */
function wanted(app: App, project: Project): AdjustmentClip[] {
  const laid = laidOf(app, project.id);
  const out: AdjustmentClip[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "video") continue;
    const mine = laid.get(clip.media);
    const media = project.media.find((one) => one.id === clip.media);
    if (mine === undefined || media === undefined) continue;
    out.push(...blursFor(project, clip, media, mine));
  }
  return out;
}

async function layNow(app: App, id: string): Promise<void> {
  const live = app.store.get(id);
  if (live === null) return;
  const want = wanted(app, live.project);
  // Nothing to change: no save (an unchanged save would still wake every watcher).
  if (lay(structuredClone(live.project), want) === false) return;
  await playing.whenIdle();
  await app.store.update(id, "text removal", (project) => {
    lay(project, wanted(app, project));
  });
}

/**
 * Brings project `id`'s tracked blurs up to `given` (text_removal.ts's plan
 * of the blur's files): what's tracked is laid at once, what isn't is read in
 * the background and laid as each is done, what's no longer wanted goes.
 */
export async function ensure(app: App, id: string, given: BlurPlan[]): Promise<void> {
  plans.set(id, given);
  const mine = new Map<string, BlurPiece>();
  const was = pieces.get(id);
  for (const plan of given) {
    for (const [from, to] of plan.spans) {
      const key = `blur:${plan.media.id}@${Math.round(from * 1000)}-${Math.round(to * 1000)}`;
      const had = was?.get(key);
      if (known(app, plan.source, from, to) !== null) {
        mine.set(key, { key, media: plan.media.id, name: plan.media.name, from, to, state: "done" });
        continue;
      }
      if (had !== undefined && had.state !== "done") {
        mine.set(key, had);
        if (had.state === "failed") continue;
        if (queue.some((one) => one.key === key) || had.state === "running") continue;
      }
      const piece: BlurPiece = { key, media: plan.media.id, name: plan.media.name, from, to, state: "queued" };
      mine.set(key, piece);
      queue.push({
        key,
        run: async () => {
          piece.state = "running";
          try {
            const input = await cloudMedia.originalInput(app.store.cacheDir(), plan.media);
            const size: [number, number] = [plan.media.width || 1920, plan.media.height || 1080];
            const region = regionOf(plan);
            const started = Date.now();
            const samples = await track(plan, from, to, (times) => reader.read(input, size, plan.media.fps || 30, region, times));
            const file = fileOf(app, plan.source, from, to);
            fs.mkdirSync(join(file, ".."), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(samples));
            tracks.set(trackKey(plan.source, from, to), samples);
            piece.state = "done";
            diag.info("removal", `${id}: ${plan.media.name} ${Math.round(from)}–${Math.round(to)} s tracked for the blur in ${Math.round((Date.now() - started) / 1000)} s (${samples.length} reads, words in ${samples.filter((one) => one.box !== null).length})`);
          } catch (error) {
            piece.state = "failed";
            piece.why = diag.messageOf(error);
            diag.warn("removal", `${id}: ${plan.media.name} ${Math.round(from)}–${Math.round(to)} s couldn't be tracked for the blur: ${piece.why}`);
          }
          await layNow(app, id).catch((error: unknown) => diag.warn("removal", `${id}: laying the tracked blur: ${diag.messageOf(error)}`));
        },
      });
    }
  }
  pieces.set(id, mine);
  await layNow(app, id);
  drain();
}

function drain(): void {
  if (busy !== null) return;
  busy = (async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next.run();
  })().finally(() => {
    busy = null;
    if (queue.length > 0) drain();
  });
}

/** Resolves once nothing is being tracked (tests). */
export async function settled(): Promise<void> {
  while (busy !== null) await busy;
}

/** For tests: nothing remembered. */
export function reset(): void {
  pieces.clear();
  plans.clear();
  tracks.clear();
  queue.length = 0;
}
