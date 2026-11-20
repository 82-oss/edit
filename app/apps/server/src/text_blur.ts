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
import { isOverlay, TRACKED } from "./clean_strips.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { framingAt } from "./frames_fill.ts";
import * as markBlurs from "./mark_blurs.ts";
import type { AdjustmentClip, Keyframe, Media, Project, VideoClip } from "./model.ts";
import { native, type Box, type ScreenText } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import * as removerCloud from "./remover_cloud.ts";
import { addTrack, clipEnd, fps as fpsOf, freshId, sample } from "./project.ts";
import { round } from "./rust.ts";
import { stripCovers } from "./text_inpaint.ts";
import { grow, same, slotsOf, track as trackRead, union, type Sample, type TrackPlan } from "./text_track.ts";

export { TRACKED };
export { RATE, partsOf, same, slotsOf, theirLines, theirs, type Part, type Sample, type TrackPlan } from "./text_track.ts";
export type Spans = [number, number][];

/** The house text blur: strong enough that no letter can be read, its edge feathered (at 1080 lines; scaled). */
const RADIUS_AT_1080 = 28;
const FEATHER_AT_1080 = 8;
/** Past the letters each side, as a share of the box's height (at least PAD_LEAST px at 1080). */
const PAD = 0.12;
const PAD_LEAST = 6;
/** More each side across, as a share of the box's height. */
const PAD_ACROSS = 0.3;
/**
 * A new way of tracking is a new file. 2: a box for each line of theirs (or adjacent lines), never one over words far
 * apart; scene text (a sticker, a sign) never a label of theirs (Nov 19: a cage's "Pro-gard" sticker joined the subtitle
 * line into one box over half a woman's body).
 */
const VERSION = 2;

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
  /** Their watermark's boxes the agent marked (start_removal `marks` with `box`): source seconds and a box, taken out with their words. */
  marks?: Mark[];
}

/** Their watermark marked where it sits: source seconds [from, to) of the file and its box (shares of its picture). */
export interface Mark {
  from: number;
  to: number;
  box: Box;
}

/** A marked box as a track of its own place ("w<n>": never taken for a still subtitle), there over [from, to). */
export function markTrack(mark: Mark, at: number): Laid {
  const part = { slot: `w${at}`, box: mark.box, words: "their watermark" };
  const shown = (t: number): Sample => ({ t, box: mark.box, words: part.words, parts: [part] });
  return { from: mark.from, to: mark.to, samples: [shown(mark.from), shown(Math.max(mark.from, mark.to - 1e-3)), { t: mark.to, box: null, words: "", parts: [] }] };
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

/** Where their text may be: their band and labels, grown; the lower part of the picture for subtitles not found yet; else all of it. */
export function regionOf(plan: Pick<BlurPlan, "band" | "labels" | "subtitles" | "text">): Box {
  const boxes: Box[] = [];
  if (plan.subtitles) boxes.push(plan.band !== null ? grow(plan.band, 0.06) : [0.04, 0.6, 0.96, 1]);
  if (plan.text) boxes.push(...plan.labels.map((box) => grow(box, 0.05)));
  return boxes.length === 0 ? [0, 0, 1, 1] : boxes.reduce(union);
}

/** Their text's reads over source seconds [from, to) (text_track.ts `track`), giving way to a play between chunks. */
export const track = (plan: TrackPlan, from: number, to: number, read: (times: number[], keep: number[]) => Promise<ScreenText[][]>): Promise<Sample[]> => trackRead(plan, from, to, read, async () => {
  await playing.whenIdle();
});

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
/** The footage clip a tracked blur is over (its name ends with the clip's id). */
const ownerOf = (clip: Project["clips"][number]) => (clip.name ?? "").slice(`${TRACKED} · `.length);

/**
 * The lanes from just above `owner`'s track up through the lanes laid over it (clean_strips' strips, the tracked
 * blurs' own): where a tracked blur over that clip goes, so it blurs that picture alone and never our captions or
 * graphics over it (Nov 19, the Boyfriends intro: a lane "above every picture" sat over caption tracks that also
 * hold B-roll and the title card, and Kelly's and the officer's captions were blurred). [first index, last index].
 */
function aboveOwner(project: Project, owner: string): [number, number] | null {
  const track = project.clips.find((clip) => clip.id === owner)?.track;
  const at = project.tracks.findIndex((one) => one.id === track);
  if (at < 0) return null;
  let last = at;
  for (let index = at + 1; index < project.tracks.length; index++) {
    const mine = project.clips.filter((clip) => clip.track === project.tracks[index]!.id);
    if (mine.length === 0 || !mine.every((clip) => isOverlay(clip) || isTracked(clip))) break;
    last = index;
  }
  return [at + 1, last];
}

/** A lane for a tracked blur over `owner`'s frames [start, end): one of the tracked blurs' own among `aboveOwner`, free then, else a new one at its top. */
function laneOver(project: Project, owner: string, start: number, end: number): string {
  const span = aboveOwner(project, owner);
  if (span === null) return markBlurs.laneFor(project, start, end, TRACKED);
  for (let index = span[0]; index <= span[1]; index++) {
    const lane = project.tracks[index]!;
    const mine = project.clips.filter((clip) => clip.track === lane.id);
    if (mine.length > 0 && mine.every(isTracked) && !mine.some((clip) => clip.start < end && start < clipEnd(clip))) return lane.id;
  }
  const id = addTrack(project, "video");
  const track = project.tracks.find((one) => one.id === id)!;
  project.tracks.splice(project.tracks.indexOf(track), 1);
  project.tracks.splice(span[1] + 1, 0, track);
  return id;
}

/** Whether a tracked blur sits where `laneOver` would put it (a blur laid before Nov 19's fix may sit over our captions). */
function wellPlaced(project: Project, clip: Project["clips"][number]): boolean {
  const span = aboveOwner(project, ownerOf(clip));
  const at = project.tracks.findIndex((one) => one.id === clip.track);
  return span === null || (at >= span[0] && at <= span[1]);
}

/**
 * Lays exactly `want` (from `blursFor`) in `project`: those already there as
 * they'd be are kept (their ids and lanes), the rest of the tracked blurs go,
 * the missing are added. Whether anything changed.
 */
export function lay(project: Project, want: AdjustmentClip[]): boolean {
  const standing = new Map<string, string[]>();
  // One on a lane over our captions (laid before the lane rule) is laid again where it belongs.
  for (const clip of project.clips) if (isTracked(clip) && wellPlaced(project, clip)) standing.set(shapeOf(clip), [...(standing.get(shapeOf(clip)) ?? []), clip.id]);
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
    clip.track = laneOver(project, ownerOf(clip), clip.start, clipEnd(clip));
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
    // Their watermark's marked boxes: blurred as they are (until the model takes them out, where it does).
    (plan.marks ?? []).forEach((mark, at) => out.set(plan.media.id, [...(out.get(plan.media.id) ?? []), markTrack(mark, at)]));
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
            const size: [number, number] = [plan.media.width || 1920, plan.media.height || 1080];
            const region = regionOf(plan);
            const started = Date.now();
            // Read on a rented CPU machine when the relay does removal there (remover_cloud.ts, the same text_track.ts), else here.
            const key = removerCloud.keyOf(plan.media);
            let samples: Sample[];
            if (key !== undefined && (await removerCloud.on())) samples = await removerCloud.track(key, size, plan.media.fps || 30, region, plan, from, to);
            else {
              const input = await cloudMedia.originalInput(app.store.cacheDir(), plan.media);
              const reading = reader.open(input, size, plan.media.fps || 30, region);
              samples = await track(plan, from, to, (times, keep) => reading.read(times, keep)).finally(() => reading.close());
            }
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
/** Tracks read at once on rented CPU machines (each a few of a machine's cores there). */
const CLOUD_AT_ONCE = 16;

function drain(): void {
  if (busy !== null) return;
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next.run();
  };
  busy = Promise.all(Array.from({ length: removerCloud.now() ? CLOUD_AT_ONCE : AT_ONCE }, worker)).then(() => {}).finally(() => {
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
