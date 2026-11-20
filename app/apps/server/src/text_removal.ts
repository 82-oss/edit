// What a re-uploader burned into footage, found and covered (Sphe, Nov 17
// and 19): their subtitles, their labels ("Actual case footage", "OFFICER
// 11"), their text get a Gaussian blur tracked tight over their words
// (text_blur.ts), in every section of the edit, only where the agent marked
// them (removal_asks.ts `marked`, from what detection proposes here) and only
// where their words actually are. The camera's own stamp is never touched
// (its clock, as camera_clock.ts reads it, the lines beside it, and on a stamp
// bar the other text in the clock's row: "MOTOROLA SOLUTIONS",
// "BWC2-101947"); a label laid over the bar ("OFFICER 11", reaching below it)
// is still the re-uploader's. Their see-through watermarks come out free, by
// the engine (watermark_removal.ts), which takes this file's stamp and files.
//
// Here: the camera's stamp (`stampOf`), where a file shows their text
// (`textOf`: burned_subtitles' spans, their labels), what the timeline shows
// of each file, what's proposed to the agent and what it marked, the blur's
// plan (`blurPlan`), and a lesson's examples (`takeExample`).

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as burned from "./burned_subtitles.ts";
import { parseClock, clockRegion } from "./camera_clock.ts";
import { isOverlay } from "./clean_strips.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import { hidingFrames } from "./frames_fill.ts";
import { probe } from "./media.ts";
import type { Media, Project } from "./model.ts";
import { native, type Box, type ScreenText } from "./native/index.ts";
import { fileStem, join } from "./paths.ts";
import { clipEnd, fps as fpsOf, reusedMedia, trackOf } from "./project.ts";
import * as asks from "./removal_asks.ts";
import * as removal from "./removal_lesson.ts";
import * as sections from "./removal_sections.ts";
import * as blur from "./text_blur.ts";
import * as inpaint from "./text_inpaint.ts";
import * as tools from "./tools.ts";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The camera's own stamp

/** A stamp bar along the top or bottom of the picture: rows [from, to) as shares of the height. */
export interface Bar {
  edge: "top" | "bottom";
  from: number;
  to: number;
}

/**
 * A full-width bar along the top (or bottom) the camera draws its stamp on:
 * a row where the picture darkens across the whole width, in every frame
 * (Motorola's see-through dark strip, Nov 17's "SWAT Faces Off": rows 0–48 of
 * 1080). `frames`: grey frames (one byte a pixel) of `width` × `height`.
 */
export function findBar(frames: Uint8Array[], width: number, height: number): Bar | null {
  if (frames.length === 0 || width < 16 || height < 16) return null;
  const slices = 16;
  const rows = 3;
  const mean = (frame: Uint8Array, row0: number, row1: number, x0: number, x1: number) => {
    let sum = 0;
    for (let row = row0; row < row1; row++) for (let x = x0; x < x1; x++) sum += frame[row * width + x]!;
    return sum / Math.max(1, (row1 - row0) * (x1 - x0));
  };
  let best: Bar & { score: number } = { edge: "top", from: 0, to: 0, score: 0 };
  for (const edge of ["top", "bottom"] as const) {
    for (let at = Math.max(rows, Math.round(height * 0.015)); at <= Math.round(height * 0.15); at++) {
      // The bar's side of the line and the picture's.
      const [bar0, bar1, pic0, pic1] = edge === "top" ? [at - rows, at, at, at + rows] : [height - at, height - at + rows, height - at - rows, height - at];
      let hits = 0;
      let contrast = 0;
      for (const frame of frames) {
        for (let slice = 0; slice < slices; slice++) {
          const [x0, x1] = [Math.floor((slice * width) / slices), Math.floor(((slice + 1) * width) / slices)];
          const step = mean(frame, pic0, pic1, x0, x1) - mean(frame, bar0, bar1, x0, x1);
          if (step >= 6) hits++;
          contrast += step;
        }
      }
      // The share of the width it darkens in every frame; between rows as good, the sharper edge (the bar's own last row).
      const score = hits / (frames.length * slices) + contrast / (frames.length * slices) / 1e4;
      if (score > best.score) best = edge === "top" ? { edge, from: 0, to: at / height, score } : { edge, from: (height - at) / height, to: 1, score };
    }
  }
  if (best.score < 0.75) return null;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { edge: best.edge, from: round(best.from), to: round(best.to) };
}

const centre = (box: Box): [number, number] => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
/** Beside the clock as a stamp's lines are (camera_clock's `besides`). */
const besides = (a: Box, b: Box) => Math.abs(centre(a)[1] - centre(b)[1]) < 0.08 && Math.abs(centre(a)[0] - centre(b)[0]) < 0.3;
const overlapShare = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return (w * h) / Math.max(1e-9, Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])));
};

/**
 * The camera's own text, kept exactly (shares of the picture): the clock's
 * lines, the stamp's lines beside them (Axon's "AXON BODY 3 X60A8071C") with
 * room for the maker's logo either side, and on a stamp bar the other lines
 * inside the bar that share the clock's row (Motorola's maker and camera id;
 * with `bar` null, a clock within a tenth of the top or bottom stands for it);
 * a line reaching out of the bar ("OFFICER 11", laid over it) isn't the
 * camera's. Each only where it stays put: in three of the frames read or more
 * (a third, of fewer).
 */
export function cameraText(frames: ScreenText[][], bar: Bar | null): Box[] {
  type Seen = { box: Box; count: number };
  const kept: Seen[] = [];
  const note = (box: Box) => {
    const same = kept.find((one) => overlapShare(one.box, box) > 0.5);
    if (same === undefined) kept.push({ box, count: 1 });
    else {
      same.box = [Math.min(same.box[0], box[0]), Math.min(same.box[1], box[1]), Math.max(same.box[2], box[2]), Math.max(same.box[3], box[3])];
      same.count += 1;
    }
  };
  for (const lines of frames) {
    const clocks = lines.filter((line) => parseClock(line.t) !== null);
    for (const clock of clocks) {
      const h = clock.b[3] - clock.b[1];
      const stamp = [clock, ...lines.filter((line) => line !== clock && besides(line.b, clock.b) && Math.abs(centre(line.b)[1] - centre(clock.b)[1]) < 3 * h)];
      for (const line of stamp) {
        const lh = line.b[3] - line.b[1];
        // A logo beside the stamp's text (Axon's triangle): four of its line heights each way (a height is 9/16 as wide).
        note([line.b[0] - 4 * lh * 0.5625, line.b[1] - 0.3 * lh, line.b[2] + 4 * lh * 0.5625, line.b[3] + 0.3 * lh]);
      }
      // With no bar found (no frames looked at: planning), a clock at the picture's edge stands for its row.
      const row = bar ?? (centre(clock.b)[1] < 0.1 ? { from: 0, to: 0.1 } : centre(clock.b)[1] > 0.9 ? { from: 0.9, to: 1 } : null);
      if (row === null) continue;
      const inBar = (box: Box) => box[1] >= row.from - 0.005 && box[3] <= row.to + 0.005;
      if (!inBar(clock.b)) continue;
      for (const line of lines) {
        if (stamp.includes(line) || !inBar(line.b)) continue;
        const shared = Math.min(line.b[3], clock.b[3]) - Math.max(line.b[1], clock.b[1]);
        if (shared >= 0.5 * Math.min(line.b[3] - line.b[1], h)) note([line.b[0] - 0.003, line.b[1] - 0.003, line.b[2] + 0.003, line.b[3] + 0.003]);
      }
    }
  }
  // A compilation shows each camera's stamp in only part of its reads (Nov 19, the Boyfriends intro's 4PuH2FjxQJA: its
  // Axon stamp in under a third, so it wasn't the camera's, and the watermark engine learned it as their mark): three
  // reads of the same place is a stamp that stays put.
  const least = Math.max(1, Math.min(3, Math.ceil(frames.length / 3)));
  const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return kept.filter((one) => one.count >= least).map(({ box }) => box.map(clamp) as Box);
}

// ---------------------------------------------------------------------------
// What shows their text

/** Mostly letters: words, not a number or a stamp's code. */
const wordy = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 3;
const tokens = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((one) => one.length >= 2));
const alike = (a: Set<string>, b: Set<string>) => {
  const both = [...a].filter((one) => b.has(one)).length;
  return both >= 0.6 * Math.max(1, a.size + b.size - both);
};

/** Runs of `hits` among the sampled `seconds`, a few samples' gap bridged, padded by half the spacing (burned_subtitles' `judge`). */
function runsOf(hits: number[], seconds: number[], duration: number): [number, number][] {
  const sorted = [...new Set(seconds)].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((second, index) => second - sorted[index]!).sort((a, b) => a - b);
  const spacing = Math.max(1, gaps[Math.floor(gaps.length / 4)] ?? 1);
  const bridge = 3 * spacing;
  const pad = spacing / 2 + 1;
  const spans: [number, number][] = [];
  for (const second of [...new Set(hits)].sort((a, b) => a - b)) {
    const last = spans[spans.length - 1];
    if (last !== undefined && second - pad - last[1] <= bridge) last[1] = Math.min(duration, second + pad);
    else spans.push([Math.max(0, second - pad), Math.min(duration, second + pad)]);
  }
  return spans;
}

/**
 * Where a file shows a re-uploader's label (source seconds): words that stay
 * put, the same at one place in three samples or a quarter of them, that
 * aren't the camera's own text (`camera`); a line of words a channel's lesson
 * gave as theirs (`taught.remove`) wherever it's read, once is enough, and
 * none it gave to keep (`taught.keep`).
 */
export function labelSpans(texts: Record<number, ScreenText[]>, seconds: number[], duration: number, camera: Box[], taught: { remove: string[]; keep: string[] } = { remove: [], keep: [] }): [number, number][] {
  const removeWords = taught.remove.map(tokens);
  const keepWords = taught.keep.map(tokens);
  const read = seconds.filter((second) => Object.hasOwn(texts, second));
  type Group = { words: Set<string>; at: [number, number]; seconds: number[] };
  const groups: Group[] = [];
  const taughtHits: number[] = [];
  for (const second of read) {
    for (const line of texts[second] ?? []) {
      if (!wordy(line.t) || parseClock(line.t) !== null || camera.some((box) => overlapShare(box, line.b) > 0.5)) continue;
      const words = tokens(line.t);
      if (keepWords.some((kept) => alike(kept, words))) continue;
      if (removeWords.some((theirs) => alike(theirs, words))) {
        taughtHits.push(second);
        continue;
      }
      const at = centre(line.b);
      const same = groups.find((group) => Math.abs(group.at[0] - at[0]) < 0.03 && Math.abs(group.at[1] - at[1]) < 0.03 && alike(group.words, words));
      if (same === undefined) groups.push({ words, at, seconds: [second] });
      else if (!same.seconds.includes(second)) same.seconds.push(second);
    }
  }
  const least = Math.max(3, Math.ceil(read.length / 4));
  const hits = [...groups.filter((group) => group.seconds.length >= least).flatMap((group) => group.seconds), ...taughtHits];
  return hits.length === 0 ? [] : runsOf(hits, read, duration);
}

/** How far from the top or bottom (a share of the picture) an untaught label of theirs sits, for the blurs. */
const LABEL_EDGE = 0.2;

/**
 * The boxes (shares) of a file's labels as `labelSpans` finds them, each grown a little: where the tracked blur looks
 * for their words. With `edges`, words that stay put count only along the top or bottom, where a re-uploader puts a label;
 * the picture's own (a sticker on a cage, a sign, a car's decal, still in a fixed camera) stays sharp (Nov 19). A line a
 * lesson gave as theirs counts anywhere.
 */
export function labelBoxes(texts: Record<number, ScreenText[]>, seconds: number[], camera: Box[], taught: { remove: string[]; keep: string[] } = { remove: [], keep: [] }, edges = false): Box[] {
  const read = seconds.filter((second) => Object.hasOwn(texts, second));
  const removeWords = taught.remove.map(tokens);
  const keepWords = taught.keep.map(tokens);
  type Group = { words: Set<string>; at: [number, number]; box: Box; seen: number; taught: boolean };
  const groups: Group[] = [];
  for (const second of read) {
    for (const line of texts[second] ?? []) {
      if (!wordy(line.t) || parseClock(line.t) !== null || camera.some((box) => overlapShare(box, line.b) > 0.5)) continue;
      const words = tokens(line.t);
      if (keepWords.some((kept) => alike(kept, words))) continue;
      const at = centre(line.b);
      const same = groups.find((group) => Math.abs(group.at[0] - at[0]) < 0.03 && Math.abs(group.at[1] - at[1]) < 0.03 && alike(group.words, words));
      const isTaught = removeWords.some((theirs) => alike(theirs, words));
      if (same === undefined) groups.push({ words, at, box: line.b, seen: 1, taught: isTaught });
      else {
        same.box = [Math.min(same.box[0], line.b[0]), Math.min(same.box[1], line.b[1]), Math.max(same.box[2], line.b[2]), Math.max(same.box[3], line.b[3])];
        same.seen += 1;
      }
    }
  }
  const least = Math.max(3, Math.ceil(read.length / 4));
  const atEdge = (box: Box) => (box[1] + box[3]) / 2 < LABEL_EDGE || (box[1] + box[3]) / 2 > 1 - LABEL_EDGE;
  return groups.filter((group) => group.taught || (group.seen >= least && (!edges || atEdge(group.box)))).map((group) => grown(group.box, 0.01));
}

/** [a, b) spans merged. */
function merged(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function minus(spans: [number, number][], holes: [number, number][]): [number, number][] {
  let out = spans;
  for (const [a, b] of holes) out = out.flatMap(([x, y]): [number, number][] => (b <= x || a >= y ? [[x, y]] : ([[x, Math.min(y, a)], [Math.max(x, b), y]] as [number, number][]).filter(([p, q]) => q > p)));
  return out;
}

/**
 * The source seconds of each footage file the timeline shows (visible clips,
 * not under a picture that fills the frame above), by media id: what of
 * `textOf`'s spans is worth cleaning. A finished video of ours a script
 * reuses (its subtitles burned in) only with `reused`: where the agent or
 * the person points at it themselves (Nov 19: a compilation's cases 5 and 6,
 * reused whole, were marked and never sent).
 */
export function shownSeconds(project: Project, reused = false): Map<string, [number, number][]> {
  const fps = fpsOf(project);
  const ours = reused ? new Set<string>() : reusedMedia(project);
  const index = (track: string) => project.tracks.findIndex((one) => one.id === track);
  const out = new Map<string, [number, number][]>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || isOverlay(clip) || trackOf(project, clip.track)?.hidden === true || !(clip.speed > 0)) continue;
    const media = project.media.find((one) => one.id === clip.media);
    if (media === undefined || media.kind !== "video" || ours.has(media.id) || media.cleans != null || media.effect != null) continue;
    // Hidden only where a picture above fills the frame at full strength (a flash fading out, a dissolve: not there).
    const above = project.clips
      .filter((other) => other.id !== clip.id && index(other.track) > index(clip.track) && trackOf(project, other.track)?.hidden !== true && other.start < clipEnd(clip) && clipEnd(other) > clip.start)
      .flatMap((other) => hidingFrames(project, other));
    const at = (frame: number) => clip.source_in + ((frame - clip.start) / fps) * clip.speed;
    for (const [a, b] of minus([[clip.start, clipEnd(clip)]], above)) out.set(media.id, [...(out.get(media.id) ?? []), [at(a), at(b)]]);
  }
  for (const [id, spans] of out) out.set(id, merged(spans));
  return out;
}

/** The source seconds of each footage file the timeline shows between `from` and `to` (timeline seconds); `reused` as `shownSeconds`. */
export function shownBetween(project: Project, from: number, to: number, reused = false): Map<string, [number, number][]> {
  const fps = fpsOf(project);
  const [a, b] = [Math.round(from * fps), Math.round(Math.min(to, Number.MAX_SAFE_INTEGER / 1e6) * fps)];
  // Read only, so the clips alone are new (removal_sections asks this for every section of the edit).
  const clips = project.clips.flatMap((clip): Project["clips"] => {
    if (clip.type !== "video") return [clip];
    const start = Math.max(clip.start, a);
    const end = Math.min(clipEnd(clip), b);
    if (end <= start) return [];
    return [{ ...clip, start, duration: end - start, source_in: clip.source_in + ((start - clip.start) / fps) * clip.speed }];
  });
  return shownSeconds({ ...project, clips }, reused);
}

/** A box grown by `by` each way, kept on the picture. */
const grown = (box: Box, by: number): Box => [Math.max(0, box[0] - by), Math.max(0, box[1] - by), Math.min(1, box[2] + by), Math.min(1, box[3] + by)];

/** A few grey frames of `input` (a quarter, half and three quarters in) at its own size, for `findBar`. */
async function greyFrames(input: string, width: number, height: number, duration: number): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const share of [0.25, 0.5, 0.75]) {
    const bytes = await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", ...tools.urlArgs(input), "-ss", String(duration * share), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:${height},format=gray`, "-f", "rawvideo", "-"], { background: true });
    if (bytes.length === width * height) out.push(bytes);
  }
  return out;
}


/** Where removal's results are kept on R2 (watermark_removal.ts's models and pieces; text strips from before Nov 19). */
export const PREFIX = "edit/cleaned";
export const folderOf = (source: string) => createHash("sha256").update(source).digest("hex").slice(0, 32);

/** What identifies a file across projects: its cloud source, else its bytes' hash. */
export async function sourceOf(media: Media): Promise<string> {
  if (media.cloud?.source) return media.cloud.source;
  return `sha256:${await cloudMedia.sha256File(media.path)}`;
}

// ---------------------------------------------------------------------------
// One project's plan

/** What a file shows of what `lesson` covers with the tracked blur (source seconds: their subtitles, their labels and text), or undefined while it isn't read yet. */
export function textOf(media: Media, camera: Box[], lesson: removal.Lesson | null): [number, number][] | undefined {
  const subtitles = burned.of(media);
  if (subtitles === undefined) return undefined;
  const reads = burned.readsOf(media);
  const labels = reads === null || lesson?.remove.text !== true ? [] : labelSpans(reads.texts, reads.seconds, media.duration ?? 0, [...camera, ...removal.keepBoxes(lesson)], removal.exampleWords(lesson));
  return merged([...(lesson?.remove.subtitles === true ? (subtitles?.spans ?? []) : []), ...labels]);
}

export const lessonOf = removal.lessonOf;

/** The camera's own text in a file, from the words read off it (no new reads; a bar needs its frames: `stampOf`). */
function cameraFromReads(media: Media, bar: Bar | null): Box[] {
  const reads = burned.readsOf(media);
  if (reads === null) return [];
  return cameraText(reads.seconds.map((second) => reads.texts[second] ?? []), bar);
}

/** The file's stamp bar and the camera's text, found once a run (from its original's frames and the reads). */
export async function stampOf(app: App, media: Media, input: string): Promise<Box[]> {
  const [w, h] = [Math.min(480, media.width || 480), Math.round((Math.min(480, media.width || 480) * (media.height || 270)) / (media.width || 480))];
  const bar = findBar(await greyFrames(input, w, h, media.duration ?? 0).catch(() => []), w, h);
  const boxes = cameraFromReads(media, bar);
  if (!boxes.some((box) => box[1] < 0.2 || box[3] > 0.8)) {
    // A clock too small for the 960-wide read: find_camera_time's own look at the top and bottom bands.
    const region = await clockRegion(app.media, media).catch(() => null);
    if (region !== null) boxes.push(region);
  }
  return boxes;
}

/** The lesson as it applies to `project` now (its parts that run by themselves, and those asked for: removal_asks.ts). */
export const inForceOf = (app: App, project: Pick<Project, "id" | "channel">): removal.Lesson | null => asks.inForce(lessonOf(project), app.store.home, project.id);

/**
 * Whether only the agent's marks go (removal_asks.ts `marked`): a channel
 * taught to take their subtitles or text out (Sphe, Nov 18: detection
 * proposes, the agent marks the in and out points, only those are blurred).
 * A channel taught nothing of theirs blurs what's asked, by detection.
 */
export const marksOnly = (project: Pick<Project, "channel">): boolean => removal.kinds(lessonOf(project)).blur.length > 0;

/** One file's seconds to blur their text in, and the parts there (`wantedOf`); their watermark's boxes marked there. */
interface Wanted {
  media: Media;
  spans: [number, number][];
  kinds: removal.Kind[];
  marks: asks.BoxMark[];
}

/**
 * Each of `spans` widened to the shots of the file it touches (`shown`, its seconds on the timeline): a mark covers the
 * shot it's in. Detection reads a file a few times a second at most, so its stretches start and end up to a read late
 * and a line shorter than a read is missed (Nov 19, the Boyfriends intro: "Wow", 0.3 s, never proposed; a subtitle
 * showing 0.33 s before its mark began): the track reads the whole shot, and only their words there get anything.
 */
export function shotsOf(spans: [number, number][], shown: [number, number][]): [number, number][] {
  return merged(spans.flatMap((span) => [span, ...shown.filter(([a, b]) => a < span[1] && b > span[0])]));
}

/**
 * The file a slowed copy was made from (broll.ts's smoothing: "<its stem>-0.80x-<key>.mp4"), when the project has it:
 * its subtitles' band and the camera's text stand for the copy's, a few seconds long and read too little to find them
 * (Nov 19, the Boyfriends intro: their "No" in a 3 s copy read as none of theirs).
 */
export function slowedFrom(project: Pick<Project, "media">, media: Media): Media | null {
  const stem = /^(.*)-\d+(?:\.\d+)?x-[0-9a-f]{6,}\.\w+$/u.exec(media.name)?.[1];
  if (stem === undefined) return null;
  return project.media.find((one) => one.id !== media.id && one.kind === "video" && one.cleans == null && fileStem(one.name) === stem) ?? null;
}

/**
 * What of each footage file has their text to take out now: the agent's
 * marks within what the lesson covers there (a channel taught it), else
 * what detection finds within what was asked (a file still being read is
 * read, and waits).
 */
function wantedOf(app: App, project: Project): Wanted[] {
  const wanted: Wanted[] = [];
  const taught = lessonOf(project);
  const lesson = asks.inForce(taught, app.store.home, project.id);
  if (lesson === null || removal.kinds(lesson).blur.length === 0) return wanted;
  const marking = marksOnly(project);
  // Every stretch detection proposes, when the agent took them all (its own marks and unmarks over them).
  const proposals = new Map<string, [number, number][]>();
  const unreadIds = new Set<string>();
  if (marking && asks.marksProposed(app.store.home, project.id)) {
    for (const [id] of shownSeconds(project)) {
      const media = project.media.find((one) => one.id === id)!;
      const spans = textOf(media, cameraFromReads(media, null), lesson);
      if (spans === undefined) unreadIds.add(id);
      else proposals.set(id, spans);
    }
  }
  // Each mark over the shots it touches (`shotsOf`).
  const shots = shownSeconds(project, true);
  const grow = (id: string, spans: [number, number][]) => shotsOf(spans, shots.get(id) ?? []);
  const marks = marking ? asks.marked(app.store.home, project.id, proposals, grow) : new Map<string, [number, number][]>();
  // The agent's own in and out points, which never wait on detection (a file not read yet is still blurred where it marked it).
  const explicit = marking ? asks.marked(app.store.home, project.id, new Map(), grow) : new Map<string, [number, number][]>();
  // Their watermark's boxes it marked: taken out with their words, whatever the file's detection says.
  const boxes = marking ? asks.markedBoxes(app.store.home, project.id) : new Map<string, asks.BoxMark[]>();
  const ours = reusedMedia(project);
  const pointed = asks.pointedAt(app.store.home, project.id);
  for (const [id, shown] of shownSeconds(project, true)) {
    // A finished video of ours, reused: only where it's marked or asked for by name.
    if (ours.has(id) && !(marking ? marks.has(id) : pointed.has(id))) continue;
    const media = project.media.find((one) => one.id === id)!;
    // Each part on the seconds it covers: all the timeline shows for one that runs by itself, what was asked for else.
    const found: [number, number][] = [];
    const kinds: removal.Kind[] = [];
    // Waiting on detection's proposals only when the agent marked nothing of this file itself.
    let unread = marking && unreadIds.has(id) && (explicit.get(id) ?? []).length === 0;
    const marksHere = marking && unreadIds.has(id) ? explicit : marks;
    for (const kind of removal.kinds(lesson).blur) {
      if (unread) break;
      const within = asks.scope(taught, app.store.home, project.id, kind, id, shown);
      if (within.length === 0) continue;
      const spans = marking ? (marksHere.get(id) ?? []) : textOf(media, cameraFromReads(media, null), removal.only(lesson, [kind]));
      if (spans === undefined) {
        unread = true;
        break;
      }
      const mine = sections.intersect(spans, within);
      if (mine.length === 0) continue;
      found.push(...mine);
      kinds.push(kind);
    }
    const marked = (boxes.get(id) ?? []).flatMap(([a, b, box]) => sections.intersect([[a, b]], shown).map(([x, y]): asks.BoxMark => [x, y, box]));
    if (unread && marked.length === 0) {
      void burned.warm(app.media, media);
      continue;
    }
    if (marking && unreadIds.has(id)) void burned.warm(app.media, media);
    const spans = merged([...(unread ? [] : found), ...marked.map(([a, b]): [number, number] => [a, b])]);
    if (spans.length > 0) wanted.push({ media, spans, kinds: unread ? [] : kinds, marks: marked });
  }
  return wanted;
}

/**
 * The files whose marked seconds get the tracked blur (every section of the
 * edit, the intro and every case), as text_blur.ts takes them.
 */
export async function blurPlan(app: App, project: Project): Promise<blur.BlurPlan[]> {
  const out: blur.BlurPlan[] = [];
  const wanted = wantedOf(app, project);
  if (wanted.length === 0) return out;
  const lesson = inForceOf(app, project);
  for (const { media, spans, kinds, marks } of wanted) {
    const reads = burned.readsOf(media);
    // A slowed copy reads as the file it was made from (`slowedFrom`).
    const parent = slowedFrom(project, media);
    const camera = [...cameraFromReads(media, null), ...(parent === null ? [] : cameraFromReads(parent, null))];
    const keep = removal.keepBoxes(lesson);
    const labels = reads === null || !kinds.includes("text") ? [] : labelBoxes(reads.texts, reads.seconds, [...camera, ...keep], removal.exampleWords(lesson), true);
    const band = burned.of(media)?.band ?? (parent === null ? null : (burned.of(parent)?.band ?? null));
    out.push({ media, source: await sourceOf(media), spans, band, labels, avoid: [...camera, ...keep], subtitles: kinds.includes("subtitles"), text: kinds.includes("text"), marks: marks.map(([from, to, box]) => ({ from, to, box })) });
  }
  return out;
}

/**
 * What detection proposes for the agent to mark (get_edit_context's
 * removal): each visible clip's stretch of the timeline where its file shows
 * their text (burned_subtitles' spans, their labels), and whether it's marked
 * already; and the marks made beyond them.
 */
export function proposed(app: App, project: Project): sections.Proposed[] {
  const fps = fpsOf(project);
  const lesson = inForceOf(app, project);
  if (lesson === null) return [];
  const all = new Map<string, [number, number][]>();
  if (asks.marksProposed(app.store.home, project.id)) for (const media of project.media) if (media.kind === "video") all.set(media.id, textOf(media, cameraFromReads(media, null), lesson) ?? []);
  const marks = asks.marked(app.store.home, project.id, all);
  const out: sections.Proposed[] = [];
  const seen = new Map<string, [number, number][]>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || isOverlay(clip) || trackOf(project, clip.track)?.hidden === true || !(clip.speed > 0)) continue;
    const media = project.media.find((one) => one.id === clip.media);
    if (media === undefined || media.kind !== "video" || media.cleans != null || media.effect != null) continue;
    const spans = textOf(media, cameraFromReads(media, null), lesson) ?? [];
    const end = clip.source_in + (clip.duration / fps) * clip.speed;
    const timeline = (seconds: number) => clip.start / fps + (seconds - clip.source_in) / clip.speed;
    const mine = marks.get(media.id) ?? [];
    for (const [a, b] of sections.intersect(spans, [[clip.source_in, end]])) {
      const covered = sections.minus([[a, b]], mine).length === 0;
      out.push({ from: timeline(a), to: timeline(b), media: media.name, marked: covered });
    }
    for (const [a, b] of sections.intersect(mine, [[clip.source_in, end]])) {
      // A mark beyond what detection found (the agent saw it itself).
      if (sections.minus([[a, b]], spans).length === 0) continue;
      const key = media.id;
      if ((seen.get(key) ?? []).some(([x, y]) => x === a && y === b)) continue;
      seen.set(key, [...(seen.get(key) ?? []), [a, b]]);
      out.push({ from: timeline(a), to: timeline(b), media: media.name, marked: true });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

/** The sections the model cleans (text_inpaint.ts), on RunPod or this machine's GPU: the intro and the first cases (Sphe, Nov 19); the rest is blurred. */
export const INPAINT_CASES = 2;

/**
 * Of the blur's stretches, those the model cleans: each marked stretch of a file the intro or the first
 * INPAINT_CASES cases show (by the file's seconds there: the same seconds reused in a later case are clean there too).
 */
export function inpaintPlan(project: Project, plans: blur.BlurPlan[]): inpaint.InpaintPlan[] {
  if (plans.length === 0 || !inpaint.available()) return [];
  const fps = fpsOf(project);
  const shown = new Map<string, [number, number][]>();
  for (const part of sections.parts(project)) {
    if (part.case !== null && part.case > INPAINT_CASES) continue;
    for (const [id, spans] of shownBetween(project, part.start / fps, part.end / fps, true)) shown.set(id, merged([...(shown.get(id) ?? []), ...spans]));
  }
  return plans.flatMap((plan) => {
    const within = shown.get(plan.media.id) ?? [];
    const spans = plan.spans.filter((span) => sections.intersect([span], within).length > 0);
    return spans.length === 0 ? [] : [{ media: plan.media, source: plan.source, spans, marks: plan.marks ?? [] }];
  });
}

/** Brings `id`'s tracked blurs, and where this machine has the model its cleaned stretches, up to what's marked now (removal_schedule.ts calls it as soon as edits rest). */
export async function ensure(app: App, id: string): Promise<void> {
  // The relay's word on RunPod, fresh (a minute old at most) before planning what the model cleans.
  await inpaint.cloudOn();
  const live = app.store.get(id);
  if (live === null) return;
  const plans = removal.kinds(inForceOf(app, live.project)).blur.length === 0 ? [] : await blurPlan(app, live.project);
  await blur.ensure(app, id, plans);
  const cleaned = inpaintPlan(live.project, plans);
  await inpaint.ensure(app, id, cleaned, masksOf(app, cleaned), rangeOf(app, cleaned));
}

/**
 * text_inpaint's masks: their words' boxes from the track (text_blur `boxesOf`), with their watermark's boxes marked
 * there. Each mark's seconds cover the same whole frames as `framesOf` (Nov 19: a mark starting mid-frame left frame
 * 0 unmasked, and the temporal model copied ARRESTFLIX from frame 0 back onto every masked frame).
 */
export function masksWithMarks(words: Box[][], marks: blur.Mark[], fps: number, first: number): Box[][] {
  const covered = marks.map((one) => ({ ...inpaint.framesOf(one.from, one.to, fps), box: one.box }));
  return words.map((boxes, k) => {
    const frame = first + k;
    return [...boxes, ...covered.filter((one) => frame >= one.first && frame < one.first + one.frames).map((one) => one.box)];
  });
}

const masksOf =
  (app: App, plans: inpaint.InpaintPlan[]): inpaint.MasksOf =>
  (source, from, to, fps, first, frames) => {
    const words = blur.boxesOf(app, source, from, to, fps, first, frames);
    if (words === null) return null;
    const marks = plans.filter((plan) => plan.source === source).flatMap((plan) => plan.marks ?? []);
    return masksWithMarks(words, marks, fps, first);
  };

const rangeOf =
  (app: App, plans: inpaint.InpaintPlan[]): inpaint.RangeOf =>
  (source, from, to) => {
    const trackRange = blur.yRangeOf(app, source, from, to);
    if (trackRange === undefined) return undefined;
    let minY = trackRange === null ? Infinity : trackRange[0];
    let maxY = trackRange === null ? -Infinity : trackRange[1];
    for (const plan of plans) {
      if (plan.source !== source) continue;
      for (const mark of plan.marks ?? []) {
        if (mark.from < to && mark.to > from) {
          if (mark.box[1] < minY) minY = mark.box[1];
          if (mark.box[3] > maxY) maxY = mark.box[3];
        }
      }
    }
    return Number.isFinite(minY) ? [minY, maxY] : null;
  };

/** Each project's stretches cleaned as soon as their tracks are read (one look at a time a project). */
const cleaning = new Map<string, Promise<void>>();
blur.whenTracked.push((app, id) => {
  if (!inpaint.available() || cleaning.has(id)) return;
  const run = (async () => {
    const live = app.store.get(id);
    if (live === null) return;
    const plans = removal.kinds(inForceOf(app, live.project)).blur.length === 0 ? [] : await blurPlan(app, live.project);
    const cleaned = inpaintPlan(live.project, plans);
    await inpaint.ensure(app, id, cleaned, masksOf(app, cleaned), rangeOf(app, cleaned));
  })()
    .catch(() => {})
    .finally(() => cleaning.delete(id));
  cleaning.set(id, run);
});

// ---------------------------------------------------------------------------
// A lesson's examples

/** What the agent gives for an example: a second of a footage file of the project, or a picture from the chat. */
export interface GivenExample {
  kind: removal.Example["kind"];
  action: removal.Example["action"];
  media?: string;
  at?: number;
  picture?: string;
  box?: Box;
  text?: string;
  note?: string;
}

/**
 * An example made ready to keep: its frame (the footage's second, at full
 * quality, or the chat's picture), its words read there (the lines in its box,
 * or its box from the words given), its crop kept in Edit's cloud under the
 * channel (`edit/channels/<channel>/removal/<sha256>.jpg`). `pictures`: where a
 * chat picture may be read from (the project's uploads, Edit's cache).
 */
export async function takeExample(app: App, project: Project, channel: string, given: GivenExample, pictures: string[]): Promise<removal.Example> {
  const dir = join(app.store.cacheDir(), "cleaned", "examples");
  fs.mkdirSync(dir, { recursive: true });
  const stem = join(dir, `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  const frame = `${stem}.png`;
  let from: removal.Example["from"];
  try {
    if (given.media !== undefined) {
      const media = project.media.find((one) => one.id === given.media);
      if (media === undefined || media.kind !== "video") throw new Error(`no footage ${given.media} in this project`);
      const at = Math.min(Math.max(0, given.at ?? 0), Math.max(0, (media.duration ?? 0) - 0.05));
      const input = await cloudMedia.originalInput(app.store.cacheDir(), media);
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...tools.urlArgs(input), "-ss", String(at), "-i", input, "-frames:v", "1", frame]);
      from = { source: await sourceOf(media), at: Math.round(at * 100) / 100 };
    } else if (given.picture !== undefined) {
      const real = fs.realpathSync(given.picture);
      if (!pictures.some((root) => real.startsWith(fs.realpathSync(root) + "/")) || !/\.(png|jpe?g|webp)$/iu.test(real)) throw new Error("picture is a picture from this chat (its file), or give media and at");
      await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", real, "-frames:v", "1", frame]);
    } else throw new Error("an example is a footage file's second (media, at) or a picture from the chat");
    // Its words, as Edit reads the footage's (screen_text.rs, on a second of the frame held).
    const held = `${stem}.mp4`;
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", frame, "-t", "2", "-r", "5", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", held]);
    const info = await probe(held);
    const lines = given.kind === "watermarks" ? [] : ((await native().screenTextDetect(held, [info.width, info.height], [1]))[1] ?? []);
    let box = given.box;
    let words = given.text;
    if (box !== undefined && words === undefined) {
      const inside = lines.filter((line) => overlapShare(box!, line.b) > 0.5);
      if (inside.length > 0) words = inside.map((line) => line.t.trim()).join(" ");
    }
    if (box === undefined && words !== undefined) {
      const said = tokens(words);
      const found = lines.filter((line) => alike(said, tokens(line.t)));
      if (found.length > 0) box = [Math.min(...found.map((one) => one.b[0])), Math.min(...found.map((one) => one.b[1])), Math.max(...found.map((one) => one.b[2])), Math.max(...found.map((one) => one.b[3]))];
    }
    // The crop: the box with a margin (the whole frame, small, without one).
    const crop = `${stem}.jpg`;
    const area = box === undefined ? "scale=640:-2" : (() => {
      const [x0, y0, x1, y1] = grown(box, 0.02);
      return `crop=iw*${(x1 - x0).toFixed(4)}:ih*${(y1 - y0).toFixed(4)}:iw*${x0.toFixed(4)}:ih*${y0.toFixed(4)}`;
    })();
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", frame, "-vf", area, "-q:v", "3", crop]);
    const sha = createHash("sha256").update(fs.readFileSync(crop)).digest("hex");
    const key = `edit/channels/${channel}/removal/${sha}.jpg`;
    if (cloud.enabled()) await cloud.uploadFile(crop, key);
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {
      kind: given.kind,
      action: given.action,
      ...(words !== undefined && words.trim() !== "" ? { text: words.trim().slice(0, 120) } : {}),
      ...(box !== undefined ? { box: box.map(round) as Box } : {}),
      ...(cloud.enabled() ? { picture: key } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(given.note !== undefined && given.note.trim() !== "" ? { note: given.note.trim().slice(0, 160) } : {}),
    };
  } finally {
    for (const name of fs.readdirSync(dir).filter((one) => one.startsWith(stem.slice(dir.length + 1)))) fs.rmSync(join(dir, name), { force: true });
  }
}
