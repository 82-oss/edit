// Their text blurred, in every section of the edit (Sphe, Nov 18 and 19: a
// channel taught to take their subtitles or text out, or where asked): a
// Gaussian blur tracked over the words themselves, never a big still box over
// their band.
//
// Only the stretches the agent marked go (removal_asks.ts `marked`). Each is
// read for its words on screen (screen_text's `Stretch`, the region where
// their text is: their subtitles' band, their labels' boxes) three times a
// second, and twice more between two reads where the words change, appear or
// go, so each change is found within a twelfth of a second: decoded once in
// time order, a frame that shows what the one before it did taken as read
// there, the rest read side by side. What's theirs is
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
// (ids kept otherwise, as clean_strips' are), and taken off when its marks
// change. Where it lies the blur over their band (burned_subtitles `cover`)
// gives way, and their subtitles count as gone (clean_strips.ts
// `strippedFrames`).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
import { stripCovers } from "./text_inpaint.ts";

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
/** Reads asked of the engine at once, each chunk halved before the next (it gives way to a play between them; the frames a halving may read are held through one chunk). */
const CHUNK = 15;
/**
 * A new way of tracking is a new file. 2: a box for each line of theirs (or adjacent lines), never one over words far
 * apart; scene text (a sticker, a sign) never a label of theirs (Nov 19: a cage's "Pro-gard" sticker joined the subtitle
 * line into one box over half a woman's body).
 */
const VERSION = 2;
/** A subtitle's words change as it's spoken: a line read the same for this long (seconds) is the picture's (a decal, a sign). */
const STILL = 8;

/** Their words in one place at a read: a line, or lines stacked tight; `slot` says which it is from read to read ("s" their subtitle, "l<n>" their nth label). */
export interface Part {
  slot: string;
  box: Box;
  words: string;
}

/** One read: a source second, and the box of their words there (shares of the picture), null with none; each place's own in `parts`. */
export interface Sample {
  t: number;
  box: Box | null;
  words: string;
  parts?: Part[];
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

/** One stretch of a file being read in time order (`reader.open`). */
export interface Reading {
  /** The lines at each of `times`, the frames at `keep` held for a read after (a read between two that differ). */
  read(times: number[], keep: number[]): Promise<ScreenText[][]>;
  close(): void;
}

/** What reads the words on screen: the engine's (tests put a stand-in here). */
export const reader = {
  open: (input: string, size: [number, number], fps: number, region: Box): Reading => {
    const engine = native();
    // One decode carried through the stretch (Nov 19: a read at a time, each a seek into a cloud original, took 2 s a read).
    if (engine.screenTextStretch !== undefined && engine.screenTextStretchRead !== undefined) {
      const id = engine.screenTextStretch(input, size, fps, region);
      return { read: (times, keep) => engine.screenTextStretchRead!(id, times, keep), close: () => engine.screenTextStretchClose?.(id) };
    }
    const at = engine.screenTextAt;
    if (at === undefined) throw new Error("this build of Edit can't read words in a region yet");
    return { read: (times) => at(input, size, fps, region, times), close: () => {} };
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
  if (plan.text) boxes.push(...plan.labels.map((box) => grow(box, 0.05)));
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
    // No label of theirs known: none (words anywhere were taken as theirs, a cage's sticker among them, Nov 19).
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

/** Whether two lines sit one over the other, close: a subtitle's two lines (never a line and words far above or below it). */
function stacked(a: Box, b: Box): boolean {
  const high = Math.max(a[3] - a[1], b[3] - b[1]);
  const gap = Math.max(a[1], b[1]) - Math.min(a[3], b[3]);
  const across = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  return gap < 0.6 * high && across > 0 && Math.min(a[3] - a[1], b[3] - b[1]) >= 0.6 * high;
}

const letters = (words: string) => (words.match(/\p{L}/gu) ?? []).length;

/**
 * Their lines in places: lines beside each other on a row or stacked tight are one place, words apart are never one.
 * A place on a label of theirs is that label's ("l<n>"); of the rest the one with the most letters is their subtitle
 * ("s"), any other in its band its own place by height ("s@<twentieths down>").
 */
export function partsOf(plan: Pick<BlurPlan, "labels">, mine: ScreenText[]): Part[] {
  const group = mine.map((_, at) => at);
  const root = (at: number): number => (group[at] === at ? at : (group[at] = root(group[at]!)));
  for (let a = 0; a < mine.length; a++) for (let b = a + 1; b < mine.length; b++) if (besides(mine[a]!.b, mine[b]!.b) || stacked(mine[a]!.b, mine[b]!.b)) group[root(a)] = root(b);
  const places = new Map<number, ScreenText[]>();
  mine.forEach((line, at) => places.set(root(at), [...(places.get(root(at)) ?? []), line]));
  const parts: (Part & { label: number })[] = [...places.values()].map((lines) => {
    lines.sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
    const box = lines.map((line) => line.b).reduce(union);
    const label = plan.labels.findIndex((one) => lines.some((line) => overlap(line.b, grow(one, 0.02)) > 0.5 * area(line.b)));
    return { slot: "", box, words: lines.map((line) => line.t).join(" "), label };
  });
  const subtitles = parts.filter((one) => one.label < 0).sort((a, b) => letters(b.words) - letters(a.words) || b.box[3] - a.box[3]);
  subtitles.forEach((one, at) => (one.slot = at === 0 ? "s" : `s@${Math.round(((one.box[1] + one.box[3]) / 2) * 20)}`));
  for (const one of parts) if (one.label >= 0) one.slot = `l${one.label}`;
  return parts.map(({ slot, box, words }) => ({ slot, box, words })).sort((a, b) => a.slot.localeCompare(b.slot));
}

function sampleOf(plan: Parameters<typeof theirs>[0], t: number, lines: ScreenText[]): Sample {
  const parts = partsOf(plan, theirLines(plan, lines));
  return { t, box: parts.length === 0 ? null : parts.map((one) => one.box).reduce(union), words: parts.map((one) => one.words).join(" "), parts };
}

/**
 * A track by place (`partsOf`'s slots), each its own samples: a box over each, never one spanning them. A place of
 * subtitles whose words never change over STILL seconds is the picture's (a decal, a sign), dropped.
 */
export function slotsOf(samples: Sample[]): Map<string, Sample[]> {
  const out = new Map<string, Sample[]>();
  const names = new Set(samples.flatMap((one) => (one.parts ?? (one.box === null ? [] : [{ slot: "s" }])).map((part) => part.slot)));
  for (const slot of [...names].sort()) {
    const mine = samples.map((one): Sample => {
      const part = one.parts === undefined ? (one.box === null ? undefined : { slot: "s", box: one.box, words: one.words }) : one.parts.find((p) => p.slot === slot);
      return { t: one.t, box: part?.box ?? null, words: part?.words ?? "" };
    });
    const shown = mine.filter((one) => one.box !== null);
    if (slot.startsWith("s") && shown.length > 1 && shown.at(-1)!.t - shown[0]!.t >= STILL && shown.every((one) => same(one, shown[0]!))) continue;
    out.set(slot, mine);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The track

/**
 * Their text's box over source seconds [from, to): read RATE a second, then
 * between each two reads that differ (words changed, came or went) halved
 * HALVINGS times. Read in time order, CHUNK at a time, each chunk halved
 * before the next is read; `read` gives the lines at each of the times asked,
 * holding the frames at `keep` (where a halving may read next).
 */
export async function track(plan: Parameters<typeof theirs>[0], from: number, to: number, read: (times: number[], keep: number[]) => Promise<ScreenText[][]>): Promise<Sample[]> {
  const ms = (t: number) => round(t * 1000) / 1000;
  const step = 1 / RATE;
  const base: number[] = [];
  for (let t = from; t < to - 1e-6; t += step) base.push(ms(t));
  base.push(ms(Math.max(from, to - 0.01)));
  const times = [...new Set(base)].sort((a, b) => a - b);
  // The times halving may read between a and b, `depth` deep.
  const between = (a: number, b: number, depth: number): number[] => {
    if (depth === 0) return [];
    const mid = ms((a + b) / 2);
    return [mid, ...between(a, mid, depth - 1), ...between(mid, b, depth - 1)];
  };
  const readAll = async (at: number[], keep: number[]): Promise<Sample[]> => {
    const lines = await read(at, keep);
    return at.map((t, j) => sampleOf(plan, t, lines[j] ?? []));
  };
  const out: Sample[] = [];
  for (let i = 0; i < times.length; i += CHUNK) {
    await playing.whenIdle();
    const part = times.slice(i, i + CHUNK);
    // The read before this chunk (the last chunk's last): the change between them is halved here.
    const last = out.at(-1);
    const bounds = last === undefined ? part : [last.t, ...part];
    let samples = [...(last === undefined ? [] : [last]), ...(await readAll(part, bounds.slice(1).flatMap((t, j) => between(bounds[j]!, t, HALVINGS))))];
    for (let halving = 0; halving < HALVINGS; halving++) {
      const pairs: [Sample, Sample][] = [];
      for (let j = 0; j + 1 < samples.length; j++) if (!same(samples[j]!, samples[j + 1]!)) pairs.push([samples[j]!, samples[j + 1]!]);
      if (pairs.length === 0) break;
      const mids = pairs.map(([a, b]) => ms((a.t + b.t) / 2));
      const deeper = pairs.flatMap(([a, b]) => between(a.t, b.t, HALVINGS - halving).slice(1));
      samples = [...samples, ...(await readAll(mids, deeper))].sort((a, b) => a.t - b.t);
    }
    out.push(...(last === undefined ? samples : samples.slice(1)));
  }
  return out;
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
    for (const one of tracks.flatMap((laid) => [...slotsOf(laid.samples).values()].map((samples) => ({ ...laid, samples })))) {
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
/** Tracks to read, each with its project (a media id like "m6" is only unique within one). */
const queue: { key: string; project: string; run: () => Promise<void> }[] = [];
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

/** Called when one of a project's stretches is tracked (text_removal.ts cleans it then, where it's cleaned). */
export const whenTracked: ((app: App, id: string) => void)[] = [];

/**
 * Their words' boxes (shares) at each of a stretch's frames, from its track: frame k at source second (first + k) / fps,
 * a box for each place of theirs there (`slotsOf`, `boxAt`). Null while it isn't tracked. The mask text_inpaint.ts cleans by.
 */
export function boxesOf(app: App, source: string, from: number, to: number, fps: number, first: number, frames: number): Box[][] | null {
  const samples = known(app, source, from, to);
  if (samples === null) return null;
  const slots = [...slotsOf(samples).values()];
  return Array.from({ length: frames }, (_, k) => slots.flatMap((one): Box[] => {
    const box = boxAt(one, (first + k) / fps);
    return box === null ? [] : [box];
  }));
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

/** The tracked blurs `project` should have now, over every clip of their footage (none where a strip took their words out: text_inpaint.ts). */
function wanted(app: App, project: Project): AdjustmentClip[] {
  const laid = laidOf(app, project.id);
  const out: AdjustmentClip[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "video") continue;
    const mine = laid.get(clip.media)?.filter((one) => !stripCovers(project, clip.media, one.from, one.to));
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
        if (queue.some((one) => one.key === key && one.project === id) || had.state === "running") continue;
      }
      const piece: BlurPiece = { key, media: plan.media.id, name: plan.media.name, from, to, state: "queued" };
      mine.set(key, piece);
      queue.push({
        key,
        project: id,
        run: async () => {
          piece.state = "running";
          try {
            const input = await cloudMedia.originalInput(app.store.cacheDir(), plan.media);
            const size: [number, number] = [plan.media.width || 1920, plan.media.height || 1080];
            const region = regionOf(plan);
            const started = Date.now();
            const reading = reader.open(input, size, plan.media.fps || 30, region);
            const samples = await track(plan, from, to, (times, keep) => reading.read(times, keep)).finally(() => reading.close());
            const file = fileOf(app, plan.source, from, to);
            // Its folder (paths.join keeps ".." as a name: Nov 19, every track's file was made a folder and its write failed, EISDIR).
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // A folder left in its place by a build before: empty, made by that mistake.
            if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() === true) fs.rmSync(file, { recursive: true, force: true });
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
          for (const listener of whenTracked) listener(app, id);
        },
      });
    }
  }
  pieces.set(id, mine);
  await layNow(app, id);
  drain();
}

/**
 * Tracks read at once: one on a Mac (its OCR beside the editor's own work), several on a Linux machine with cores to
 * spare (Nov 19, Sphe's Linux prod Edit: one at a time read 3.3 s for each second of footage, ~150 stretches of two
 * compilations' later cases would have taken all day). At most 3: six at once held ~21 FFmpeg decoders, 8 GB, and the
 * server stalled at its memory limit (each is one decoder now, its reads on 3 or 4 threads, screen_text.rs `Stretch`).
 */
export const AT_ONCE = process.platform === "linux" ? Math.min(3, Math.max(1, Math.floor(os.cpus().length / 8))) : 1;

function drain(): void {
  if (busy !== null) return;
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next.run();
  };
  busy = Promise.all(Array.from({ length: AT_ONCE }, worker)).then(() => {}).finally(() => {
    busy = null;
    if (queue.length > 0) drain();
  });
}

/**
 * The person's Stop (removal_schedule.ts `stop`): the project's tracks not started yet are let go, so nothing more
 * is read for it (Nov 19: two stopped compilations' 190 queued tracks, ~2 h of footage, kept every other project's
 * waiting behind them); what's tracked and laid stays, a track under way finishes.
 */
export function stop(id: string): void {
  for (let at = queue.length - 1; at >= 0; at--) if (queue[at]!.project === id) queue.splice(at, 1);
  const mine = pieces.get(id);
  if (mine !== undefined) for (const [key, piece] of mine) if (piece.state === "queued") mine.delete(key);
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
