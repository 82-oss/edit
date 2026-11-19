// What a re-uploader burned into footage taken out of its picture (Sphe, Nov
// 17): their subtitles, their labels ("Actual case footage", "OFFICER 11"),
// their text, so cleanly "you really have to stare deeply in order to notice
// that something is gone", the camera's own stamp kept exactly as it was.
//
// Vmake does the removing (a provider: its website on the team's flat plan,
// its developer API after a yes to its price), in the mode each stretch's
// section gets (removal_modes.ts, Sphe and JJ, Nov 18: Smart Pro on the
// intro, Smart on the first two cases, nothing after). It re-renders the whole
// frame, a little sharper everywhere, so only what it took out is pasted back:
// where its frame differs from the original by text-shaped marks (the
// difference over a threshold, specks opened away, grown over the letters'
// glow, feathered), Vmake's picture; everywhere else the original. The
// camera's own text (its clock, as camera_clock.ts reads it, the lines of the
// stamp beside it, and on a stamp bar along the top or bottom the other text
// in the clock's row: "MOTOROLA SOLUTIONS", "BWC2-101947") always keeps the
// original's pixels, whatever Vmake did there; a label laid over the bar
// ("OFFICER 11", reaching below it) is still the re-uploader's and goes.
//
// What's sent: of each footage file, only the seconds the timeline shows that
// carry their subtitles (burned_subtitles.ts) or a label of theirs that stays
// put, with a second's handle each side, in pieces of at most 300 s cut from
// the original at full quality. What comes back is kept on R2 by the file and
// its seconds (`edit/cleaned/…`, and its mode: a Smart result is named so and
// never stands in for Smart Pro; Smart Pro's, every result from before Nov 18,
// stands in for either), so the same footage, in this project or the next
// that reuses the case, is never paid for twice. Each piece becomes a
// strip (clean_strips.ts): a stacked, see-through video of the box Vmake
// changed, laid over every clip of that footage and stuck to it.
//
// It runs when the person says so, once the edit is done: the editor shows one
// line with what it'll do and its price, and one button. Never during an
// agent's turn; local encodes wait while something plays. A piece that fails
// keeps its blur (burned_subtitles.ts `cover`) and is said plainly; an
// account that can't be used (closed, signed out, out of credits, the day's
// allowance spent, keys refused) stops every send at once, is said in that
// line, kept across restarts, and is looked at again after an hour or when the
// person asks.

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import * as accounts from "./accounts.ts";
import type { App } from "./app.ts";
import * as burned from "./burned_subtitles.ts";
import { parseClock, clockRegion } from "./camera_clock.ts";
import { isOverlay } from "./clean_strips.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { fillsFrame } from "./frames_fill.ts";
import { ApiError, json } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import * as keychain from "./keychain.ts";
import { probe } from "./media.ts";
import type { Media, Probe, Project } from "./model.ts";
import { native, type Box, type ScreenText } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import { clipEnd, fps as fpsOf, freshId, reusedMedia, trackOf } from "./project.ts";
import * as seams from "./seams.ts";
import * as relay from "./relay.ts";
import * as blur from "./text_blur.ts";
import * as asks from "./removal_asks.ts";
import * as removal from "./removal_lesson.ts";
import * as modes from "./removal_modes.ts";
import { holderFor } from "./sync_core.ts";
import * as tools from "./tools.ts";
import * as vmake from "./vmake_api.ts";
import * as web from "./vmake_web.ts";
import { VmakeError, type AccountReason } from "./vmake_api.ts";

/** The longest piece sent (the website's limit; the API's is 600 s, one size for both). */
export const PIECE_SECONDS = 300;
/** Seconds sent either side of what shows their text. */
export const HANDLE = 1;
/** The shortest piece worth sending. */
const LEAST = 2;
/** A piece's leftover shorter than this beside a cleaned one is left (it's the other's handle). */
const SLIVER = 0.5;
/** The API's price: 4 credits a second, about $0.027 (Nov 17). */
const API_DOLLARS_A_SECOND = 0.027;
const API_CREDITS_A_SECOND = 4;
/** An account's refusal is looked at again after this. */
export const RECHECK_MS = 3_600_000;
/** Pieces in flight at once, unless the provider says (the website's: the relay's AT_ONCE, one a browser). */
const PARALLEL = 3;
/** The mask (at 720 lines; scaled with the picture): luma difference that counts, growth over the glow, feather. */
const THRESHOLD = 40;
const GROW_AT_720 = 6;
const FEATHER_AT_720 = 3;

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
 * camera's. Each only where it stays put: in a third of the frames read or more.
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
  const least = Math.max(1, Math.ceil(frames.length / 3));
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
 * The boxes (shares) of a file's labels as `labelSpans` finds them, each grown a little: what's blurred when Vmake can't
 * take one out. With `edges`, words that stay put count only along the top or bottom, where a re-uploader puts a label;
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
    const above = project.clips
      .filter((other) => other.id !== clip.id && index(other.track) > index(clip.track) && trackOf(project, other.track)?.hidden !== true && fillsFrame(project, other) && other.start < clipEnd(clip) && clipEnd(other) > clip.start)
      .map((other): [number, number] => [other.start, clipEnd(other)]);
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
  // Read only, so the clips alone are new (removal_modes asks this for every section of the edit).
  const clips = project.clips.flatMap((clip): Project["clips"] => {
    if (clip.type !== "video") return [clip];
    const start = Math.max(clip.start, a);
    const end = Math.min(clipEnd(clip), b);
    if (end <= start) return [];
    return [{ ...clip, start, duration: end - start, source_in: clip.source_in + ((start - clip.start) / fps) * clip.speed }];
  });
  return shownSeconds({ ...project, clips }, reused);
}

/** A cleaned piece kept: the file's seconds [from, to) it covers, by which provider, in which mode, where. */
export interface Cached {
  from: number;
  to: number;
  provider: ProviderId;
  mode: web.Mode;
  key: string;
}

/**
 * What to clean of one file: `wanted` (source seconds showing their text, on
 * the timeline) with HANDLE each side, less what `cached` covers, in pieces
 * of at most PIECE_SECONDS, each starting on a frame of `fps`; and the cached
 * pieces it uses. `pack` (paid by the file, not the second: the website's
 * plan, so many files a day) puts nearby stretches into one piece with the
 * seconds between them, as few pieces as fit (Nov 17: a compilation's 89
 * small files, three days of the plan, are about 20), never across a piece
 * already cleaned (that's reused, never sent again).
 */
export function piecesFor(wanted: [number, number][], duration: number, fps: number, cached: Cached[], pack = false, walls: [number, number][] = []): { send: [number, number][]; use: Cached[] } {
  const padded = merged(wanted.map(([a, b]): [number, number] => [Math.max(0, a - HANDLE), Math.min(duration, b + HANDLE)]).filter(([a, b]) => b > a));
  const use = cached.filter((one) => padded.some(([a, b]) => one.from < b && a < one.to));
  const left = minus(
    padded,
    use.map((one): [number, number] => [one.from, one.to]),
  ).filter(([a, b]) => b - a >= SLIVER);
  const frame = (value: number) => (fps > 0 ? Math.floor(value * fps + 1e-6) / fps : value);
  const send: [number, number][] = [];
  for (let [a, b] of left) {
    // Too short to send: longer forward, else back (into what's kept, never past the file).
    if (b - a < LEAST) {
      b = Math.min(duration, a + LEAST);
      a = Math.max(0, b - LEAST);
    }
    const parts = Math.ceil((b - a) / PIECE_SECONDS - 1e-9);
    const step = (b - a) / parts;
    for (let part = 0; part < parts; part++) {
      const from = frame(a + part * step);
      const to = part === parts - 1 ? b : frame(a + (part + 1) * step);
      send.push([Math.round(from * 1000) / 1000, Math.round(to * 1000) / 1000]);
    }
  }
  return { send: pack ? packed(send, cached, walls) : send, use };
}

/**
 * Pieces joined into as few of at most PIECE_SECONDS as fit, the seconds
 * between them sent too, never across a cached piece or a wall (seconds
 * another section's mode takes: Nov 19, an intro teaser's Smart Pro piece
 * packed over case 1's Smart seconds between them, so case 1 went in Smart
 * Pro, out of its scarcer day's files).
 */
export function packed(pieces: [number, number][], cached: Cached[], walls: [number, number][] = []): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...pieces].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    const between = last !== undefined && (cached.some((one) => one.from < a && one.to > last[1]) || walls.some(([x, y]) => x < a && y > last[1]));
    if (last !== undefined && !between && b - last[0] <= PIECE_SECONDS + 1e-6) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The strip

/**
 * Whether `cleaned` (Vmake's result) is `original`'s footage: as long (±0.25 s)
 * and, at a quarter, half and three quarters in, the same picture but for
 * small parts (their text taken out): a result from before is used only then.
 */
export async function sameFootage(original: string, cleaned: string): Promise<boolean> {
  const [a, b] = await Promise.all([probe(original).catch(() => null), probe(cleaned).catch(() => null)]);
  if (a === null || b === null || !(a.duration > 0) || Math.abs(a.duration - b.duration) > 0.25) return false;
  const grey = (file: string, at: number) =>
    tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-ss", at.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"], { background: true });
  for (const share of [0.25, 0.5, 0.75]) {
    const [x, y] = await Promise.all([grey(original, a.duration * share), grey(cleaned, a.duration * share)]);
    if (x.length !== y.length || x.length === 0) return false;
    let diff = 0;
    for (let at = 0; at < x.length; at++) diff += Math.abs(x[at]! - y[at]!);
    if (diff / x.length > 12) return false;
  }
  return true;
}

/** The mask's sizes for a picture `height` lines tall. */
function maskSizes(height: number): { grow: number; feather: number } {
  return { grow: Math.max(2, Math.round((GROW_AT_720 * height) / 720)), feather: Math.max(1, Math.round(((FEATHER_AT_720 * height) / 720) * 10) / 10) };
}

/** Boxes (shares) as pixels of a `width` × `height` picture, on even edges. */
function pixels(box: Box, width: number, height: number): [number, number, number, number] {
  const x = Math.max(0, Math.floor((box[0] * width) / 2) * 2);
  const y = Math.max(0, Math.floor((box[1] * height) / 2) * 2);
  const w = Math.min(width - x, Math.ceil(((box[2] - box[0]) * width) / 2) * 2);
  const h = Math.min(height - y, Math.ceil(((box[3] - box[1]) * height) / 2) * 2);
  return [x, y, Math.max(2, w), Math.max(2, h)];
}

/** The picture outside `box`, as boxes (what a mask allowed only inside it is kept from). */
export function outside(box: Box): Box[] {
  const [x0, y0, x1, y1] = box;
  const out: Box[] = [];
  if (y0 > 0) out.push([0, 0, 1, y0]);
  if (y1 < 1) out.push([0, y1, 1, 1]);
  if (x0 > 0) out.push([0, y0, x0, y1]);
  if (x1 < 1) out.push([x1, y0, 1, y1]);
  return out;
}

/** A box grown by `by` each way, kept on the picture. */
const grown = (box: Box, by: number): Box => [Math.max(0, box[0] - by), Math.max(0, box[1] - by), Math.min(1, box[2] + by), Math.min(1, box[3] + by)];

/**
 * FFmpeg's filter for the mask (grey, 255 = Vmake's picture) from the original
 * (input 0) and Vmake's (input 1, at the original's size): where they differ
 * by text-shaped marks that stay put over frames, grown and feathered, never in `keep` (the camera's text), always in `force`
 * (a local step's own boxes). Ends at `[m]`.
 */
export function maskFilter(width: number, height: number, keep: Box[], force: Box[] = []): string {
  const { grow, feather } = maskSizes(height);
  const boxes = (list: Box[], colour: string) =>
    list.map((box) => {
      const [x, y, w, h] = pixels(box, width, height);
      return `,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${colour}:t=fill`;
    });
  return [
    `[0:v]format=gray[a];[1:v]scale=${width}:${height},format=gray[b];`,
    // Text stays put over frames; the re-render's differences in a moving picture don't: a pixel counts where it
    // differs in most of five frames running (a line up a second or more passes from its first frame).
    `[a][b]blend=all_mode=difference,lutyuv=y='if(gt(val,${THRESHOLD}),255,0)',tmedian=radius=2,erosion`,
    ",dilation".repeat(grow),
    ...boxes(force, "white"),
    `,gblur=sigma=${feather}`,
    ...boxes(keep, "black"),
    // drawbox's black and white are video range (16, 235): the mask's ends are 0 and 255.
    `,lutyuv=y='if(lte(val,16),0,if(gte(val,235),255,val))'[m]`,
  ].join("");
}

/** The box (shares) every frame's mask touches, from `bbox`'s per-frame prints; null when nothing was taken out. */
export function boxOfPrints(printed: string, width: number, height: number, margin: number): Box | null {
  let box: [number, number, number, number] | null = null;
  const at: Record<string, number> = {};
  for (const line of printed.split("\n")) {
    const match = /lavfi\.bbox\.(x1|y1|x2|y2)=(\d+)/u.exec(line);
    if (match === null) continue;
    at[match[1]!] = Number(match[2]);
    const { x1, y1, x2, y2 } = at;
    if (match[1] === "y2" && x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      box = box === null ? [x1, y1, x2, y2] : [Math.min(box[0], x1), Math.min(box[1], y1), Math.max(box[2], x2), Math.max(box[3], y2)];
    }
  }
  if (box === null) return null;
  const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1e4) / 1e4;
  return [clamp((box[0] - margin) / width), clamp((box[1] - margin) / height), clamp((box[2] + 1 + margin) / width), clamp((box[3] + 1 + margin) / height)];
}

/** The colour matrix an untagged file's YUV is in: BT.709 from 720 lines up. */
function matrixOf(info: { height: number }): string {
  return info.height >= 720 ? "bt709" : "bt601";
}


/**
 * The strip from a piece (`original`, the file's seconds the piece covers, and
 * Vmake's `cleaned`): Vmake's picture where it took something out, see-through
 * elsewhere, stacked (picture over alpha, as effects.ts's renders), cropped to
 * the box any frame's mask touches. Null when it took nothing out.
 */
export async function makeStrip(original: string, cleaned: string, info: { width: number; height: number; fps: number }, keep: Box[], out: string, force: Box[] = []): Promise<{ box: Box } | null> {
  const { width, height } = info;
  const mask = maskFilter(width, height, keep, force);
  await playing.whenIdle();
  const printed = new TextDecoder().decode(
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", original, "-i", cleaned, "-filter_complex", `${mask};[m]bbox=min_val=8,metadata=print:file=-`, "-f", "null", "-"], { background: true }),
  );
  const { feather } = maskSizes(height);
  const box = boxOfPrints(printed, width, height, Math.ceil(3 * feather) + 2);
  if (box === null) return null;
  const [x, y, w, h] = pixels(box, width, height);
  const matrix = matrixOf(info);
  const strip = [
    `${mask};[m]crop=${w}:${h}:${x}:${y}[mc];`,
    `[1:v]scale=${width}:${height},crop=${w}:${h}:${x}:${y},scale=in_color_matrix=${matrix}:in_range=tv,format=rgba[c];`,
    `[c][mc]alphamerge,split[x][y];[x]premultiply=inplace=1,format=rgb24[p];[y]alphaextract,format=rgb24[al];`,
    `[p][al]vstack=inputs=2,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
  ].join("");
  const gop = String(Math.max(1, Math.round((info.fps || 30) / 2)));
  const partial = `${out}.partial.mp4`;
  await playing.whenIdle();
  await tools.run(
    [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", original, "-i", cleaned, "-filter_complex", strip, "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-g", gop, "-bf", "0", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", partial],
    { background: true },
  );
  fs.renameSync(partial, out);
  return { box: [x / width, y / height, (x + w) / width, (y + h) / height] as Box };
}

/** The stretch [from, to) of `input` at full quality, as a file Vmake takes (≤ `maxBytes`), no sound. */
export async function cutPiece(input: string, from: number, to: number, out: string, maxBytes = 300_000_000, quality: { crf: number; rate: number } = { crf: 14, rate: 20_000_000 }): Promise<void> {
  const seconds = to - from;
  // Under the size cap whatever the footage: the bitrate it leaves, at most the quality's.
  const rate = Math.min(quality.rate, Math.floor((maxBytes * 0.9 * 8) / Math.max(1, seconds)));
  const partial = `${out}.partial.mp4`;
  await playing.whenIdle();
  await tools.run(
    [
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...tools.urlArgs(input), "-ss", String(from), "-i", input, "-t", String(seconds),
      "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", String(quality.crf), "-maxrate", String(rate), "-bufsize", String(rate * 2), "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial,
    ],
    { background: true },
  );
  fs.renameSync(partial, out);
}

/** A few grey frames of `input` (a quarter, half and three quarters in) at its own size, for `findBar`. */
async function greyFrames(input: string, width: number, height: number, duration: number): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const share of [0.25, 0.5, 0.75]) {
    const bytes = await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", ...tools.urlArgs(input), "-ss", String(duration * share), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:${height},format=gray`, "-f", "rawvideo", "-"], { background: true });
    if (bytes.length === width * height) out.push(bytes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Providers and their accounts

export type ProviderId = "vmake-api" | "vmake-web";

/** Who removes: Vmake's API (paid by the second) or its website (the team's flat plan). */
export interface Provider {
  id: ProviderId;
  /** Paid by the file, not the second: a file of PIECE_SECONDS or less goes whole (straight from R2 when it's there). */
  wholeFiles?: boolean;
  /**
   * How a piece is encoded for it: the website's go through a paid home proxy
   * twice ($5 a GB), and Vmake's fill is all that's kept of them (the mask
   * compares like with like), so they go lighter.
   */
  pieceQuality?: { crf: number; rate: number };
  /** The price of sending `seconds` of footage in `files` pieces (`smart` of those seconds in Smart), as the line says it. */
  price(seconds: number, files: number, smart?: number): string;
  /**
   * Takes the text out of the piece at `input` into `out`. Throws VmakeError (its `scope` says whose the failure is;
   * web.Refused: vmake.ai said it won't come back). `look.sentBefore`: this name's file went in before, so it's only
   * looked for, never sent; `look.longer`: it may have (kept by a build before it was said): looked for as long
   * first; `look.sent`: called as the file goes in. `mode`: Smart Pro unless said.
   */
  remove(input: string, out: string, seconds: number, signal?: AbortSignal, whole?: { key: string }, begun?: () => void, label?: string, look?: { sentBefore: boolean; longer?: boolean; sent: () => void }, mode?: web.Mode): Promise<{ credits: number | null }>;
  /** Whether the account can be used, nothing spent. Throws VmakeError. */
  check(): Promise<void>;
  /** Pieces it takes at once (PARALLEL when it doesn't say). */
  atOnce?(): number;
  /** Finished results from before pieces had names of their own (the website's), to be used, never sent again. */
  legacy?(): Promise<web.Legacy[]>;
}

/** What the person reads when the account can't be used. */
export function accountLine(reason: AccountReason, said = ""): string {
  const why: Record<AccountReason, string> = {
    closed: "Vmake says this account is closed",
    signed_out: "the team's Vmake account is signed out",
    lapsed: "the Vmake plan has lapsed",
    out_of_credits: "the Vmake account is out of credits",
    daily_limit: "the day's Vmake allowance is used up; it carries on tomorrow",
    keys_refused: "Vmake refused this Mac's keys",
    browser_credits: "the cloud browser's account (Browser Use) is out of credits",
    browser_key: "Browser Use refused the team's key on Edit's relay",
    refused: `Vmake refused the account${said !== "" ? ` (${said.replace(/^Vmake's [a-z -]+: /u, "")})` : ""}`,
  };
  return reason === "daily_limit" ? `Taking their text out is paused: ${why[reason]}.` : `Taking their text out is off: ${why[reason]}. Their subtitles stay blurred until it's sorted.`;
}

interface AccountState {
  reason: AccountReason;
  said: string;
  at: number;
  checked: number;
}

interface Kept {
  accounts: Partial<Record<ProviderId, AccountState>>;
  /** Files sent to vmake.ai today (tests: the team's are counted on the relay). */
  day?: web.Day;
  /** Each run: what it sent and what it spent. */
  runs: { at: number; project: string; provider: ProviderId; seconds: number; pieces: number; failed: number; credits: number | null; estimate: number | null }[];
  /**
   * Pieces out at Vmake now (by `source|from|to`), so after a restart (an
   * update mid-run) a piece goes under the same name and its card is picked
   * up, never a file spent twice; gone only once its result is on the shelf.
   */
  out?: Record<string, Out>;
}

/**
 * A piece out at Vmake: the try it goes as (its name on vmake.ai), and
 * whether its file went into the page (`sent`: from then on it's only looked
 * for, never sent again under a new name unless vmake.ai says it won't come
 * back, web.Refused). A look that couldn't tell parks it (`looks` so far,
 * since when, the next at `next`); `lost`: never shown back after every look,
 * given up on and blurred (in the projects `covered`), never sent again by
 * itself.
 */
interface Out {
  tries: number;
  at: number;
  /** Missing only in what a build before Nov 18 kept: it may have gone in. */
  sent?: boolean;
  looks?: number;
  since?: number;
  next?: number;
  lost?: boolean;
  covered?: string[];
}

/**
 * How long after each look that couldn't tell the piece is looked for again
 * (5 min, then 10, 20, 40, then hourly: about 5 h in all, past the first
 * try's two); once they're all used it's given up on (blurred, said).
 */
export const looking = { afterMs: [5, 10, 20, 40, 60, 60, 60, 60].map((minutes) => minutes * 60_000) };

const keptFile = (home: string) => join(home, "text-removal.json");

function readKept(home: string): Kept {
  try {
    const kept = JSON.parse(fs.readFileSync(keptFile(home), "utf8")) as Kept;
    return { ...kept, accounts: kept.accounts ?? {}, runs: Array.isArray(kept.runs) ? kept.runs : [] };
  } catch {
    return { accounts: {}, runs: [] };
  }
}

function writeKept(home: string, kept: Kept): void {
  try {
    writeAtomic(keptFile(home), JSON.stringify({ ...kept, runs: kept.runs.slice(-100) }, null, 1));
  } catch (error) {
    diag.warn("removal", `keeping the Vmake account's state: ${diag.messageOf(error)}`);
  }
}

/** A piece out at Vmake (or the try its next go takes), or null. */
function outstanding(home: string, key: string): Out | null {
  const one = readKept(home).out?.[key];
  return one === undefined || typeof one.tries !== "number" ? null : one;
}

/**
 * The pieces of `source` in vmake.ai's hands now (sent, not given up on), by
 * their seconds and mode: a plan keeps them as they are, so a change in how
 * pieces are cut never sends their seconds again nor leaves a paid card
 * behind (Nov 19: section walls cut a 267 s Smart Pro piece that was out).
 */
function inHandsOf(home: string, source: string): { from: number; to: number; mode: web.Mode }[] {
  const out: { from: number; to: number; mode: web.Mode }[] = [];
  for (const [key, one] of Object.entries(readKept(home).out ?? {})) {
    if (!key.startsWith(`${source}|`) || one?.sent === false || one?.lost === true) continue;
    const rest = key.slice(source.length + 1).split("|");
    const [from, to] = [Number(rest[0]), Number(rest[1])];
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) out.push({ from, to, mode: rest[2] === "smart" ? "smart" : "pro" });
  }
  return out;
}

function setOutstanding(home: string, key: string, out: Omit<Out, "at"> | null): void {
  const kept = readKept(home);
  const all = { ...kept.out };
  if (out === null) {
    if (all[key] === undefined) return;
    delete all[key];
  } else all[key] = { ...out, at: Date.now() };
  writeKept(home, { ...kept, out: all });
}

/** The account's refusal standing now, if any (gone once RECHECK_MS has passed; `check` asks again). */
export function blocked(home: string, provider: ProviderId, now = Date.now()): AccountState | null {
  const state = readKept(home).accounts[provider];
  return state === undefined || now - state.checked >= RECHECK_MS ? null : state;
}

export function block(home: string, provider: ProviderId, error: VmakeError, now = Date.now()): void {
  const kept = readKept(home);
  kept.accounts[provider] = { reason: error.reason ?? "refused", said: error.message, at: kept.accounts[provider]?.at ?? now, checked: now };
  writeKept(home, kept);
  diag.warn("removal", `${provider}: the account can't be used (${error.reason}): ${error.message}`);
}

function unblock(home: string, provider: ProviderId): void {
  const kept = readKept(home);
  if (kept.accounts[provider] === undefined) return;
  delete kept.accounts[provider];
  writeKept(home, kept);
}

/** Vmake's API with this Mac's keys (kept in the Keychain as `vmake`: base64 of {"ak","sk"}). */
export function apiProvider(keys: vmake.Keys): Provider {
  return {
    id: "vmake-api",
    // Smart is half Smart Pro's credits a second.
    price: (seconds, _files, smart = 0) => `≈ $${Math.max(1, Math.round((seconds - smart / 2) * API_DOLLARS_A_SECOND))}`,
    remove: (input, out, seconds, signal, _whole, _begun, _label, _look, mode = "pro") => vmake.remove(keys, input, out, { seconds, material: mode === "smart" ? vmake.SMART : vmake.SMART_PRO, ...(signal ? { signal } : {}) }),
    check: () => vmake.check(keys),
  };
}

/** Files left today on the Vmake plan. */
function filesLeft(home: string): number {
  const day = readKept(home).day;
  return web.DAILY_FILES - (day?.date === web.today() ? day.files : 0);
}

function countFile(home: string): void {
  const kept = readKept(home);
  kept.day = kept.day?.date === web.today() ? { date: kept.day.date, files: kept.day.files + 1 } : { date: web.today(), files: 1 };
  writeKept(home, kept);
}

/** The day's files sent to vmake.ai: the team's (counted on Edit's relay), or this home's in tests. */
export interface Files {
  left(): number;
  /** Counts a file sent today: the day's count after it. */
  count(): Promise<number>;
}

const homeFiles = (home: string): Files => ({
  left: () => filesLeft(home),
  count: async () => {
    countFile(home);
    return web.DAILY_FILES - filesLeft(home);
  },
});

/**
 * vmake.ai's website on the team's plan, in a browser on the team's Browser
 * Use profile that Edit's relay lends this Mac (vmake_web.ts `teamBrowsers`).
 * Paid by the file (DAILY_FILES a day, the team's), plus Browser Use's
 * minutes and bytes on the team's account.
 */
export function websiteProvider(home: string, browsers: web.Browsers, site = web.SITE, put = web.stage, files: Files = homeFiles(home), atOnce: () => number = () => web.AT_ONCE, onQuota: (quota: web.Quota) => void = () => {}): Provider {
  const driver = new web.Driver(browsers, site, atOnce);
  // The account's day as the page last loaded it: its first read said whole (a Pro account's real numbers).
  const day: { quota: web.Quota | null; said: boolean } = { quota: null, said: false };
  const quotaSeen = (quota: web.Quota) => {
    day.quota = quota;
    onQuota(quota);
    const of = (model: string) => quota.modes[model];
    const line = `Smart Pro ${of(web.MODELS.pro)?.remain ?? "?"} of ${of(web.MODELS.pro)?.limit ?? "?"} left (up to ${of(web.MODELS.pro)?.seconds ?? "?"} s), Smart ${of(web.MODELS.smart)?.remain ?? "?"} of ${of(web.MODELS.smart)?.limit ?? "?"} (up to ${of(web.MODELS.smart)?.seconds ?? "?"} s), credits ${quota.balance ?? "?"}`;
    if (!day.said) diag.info("removal", `vmake.ai's own count of the day, first read: ${line}`);
    else diag.info("removal", `vmake.ai's count: ${line}`);
    day.said = true;
  };
  return {
    id: "vmake-web",
    atOnce,
    legacy: (() => {
      let listed: { at: number; cards: Promise<web.Legacy[]> } | null = null;
      return () => {
        if (listed === null || Date.now() - listed.at > 20 * 60_000) listed = { at: Date.now(), cards: driver.legacy().catch(() => []) };
        return listed.cards;
      };
    })(),
    wholeFiles: true,
    pieceQuality: { crf: 20, rate: 6_000_000 },
    price(seconds, count) {
      const left = files.left();
      // About 2.5 minutes of browser a minute of footage, three at once; the piece in and out (≤0.75 MB a second each way).
      const dollars = ((seconds * 2.5) / 3600) * web.DOLLARS_AN_HOUR + ((seconds * 1.5) / 1000) * web.DOLLARS_A_GB;
      const browser = dollars < 0.5 ? "under $0.50" : `≈ $${dollars.toFixed(2)}`;
      return `${count} ${count === 1 ? "file" : "files"} on your Vmake plan${count > left ? ` (${Math.max(0, left)} today, the rest tomorrow)` : ""}, ${browser} of cloud browser`;
    },
    async remove(input, out, seconds, _signal, whole, begun, label, look, mode = "pro") {
      // Staged and counted only when the file is sent: a card of it already on vmake.ai (its name from `label`), or
      // a finished result from before that's this piece's, sends nothing.
      const staged: { drop: () => Promise<void> }[] = [];
      let adopted = false;
      // In vmake.ai's hands since this call (a browser lost after it, and another tried): only looked for from then on.
      let handed = false;
      try {
        const url = await driver.run(
          async () => {
            const one = whole !== undefined ? { url: await cloud.presign(whole.key, "GET", 3 * 3600), drop: async () => {} } : await put(input, `${PREFIX}/send/${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`);
            staged.push(one);
            return one.url;
          },
          web.pieceName(seconds, label),
          {
            mode,
            ...(begun ? { begun } : {}),
            seconds,
            quota: quotaSeen,
            sentBefore: () => look?.sentBefore === true || handed,
            ...(look?.longer === true ? { lookLonger: true } : {}),
            handed: () => {
              handed = true;
              look?.sent();
            },
            // Past the free files the plan's credits pay, and Edit goes on (vmake.ai's own refusal stops it), never past
            // SANITY_FILES a day. Whether this one is past them: the page's own count (by-hand uploads in it), else Edit's.
            sending: async () => {
              if (web.DAILY_FILES - files.left() >= web.SANITY_FILES) throw new VmakeError(`Edit's own ceiling of ${web.SANITY_FILES} Vmake files a day is reached`, "account", "daily_limit");
              const today = await files.count();
              const remain = day.quota?.modes[web.MODELS[mode]]?.remain;
              return remain === 0 || (remain == null && today > web.DAILY_FILES);
            },
            adopt: async (found) => {
              await web.fetchResult(found, out);
              if (await sameFootage(input, out)) return (adopted = true);
              fs.rmSync(out, { force: true });
              return false;
            },
          },
        );
        if (!adopted) await web.fetchResult(url, out);
      } finally {
        for (const one of staged) await one.drop();
      }
      return { credits: null };
    },
    async check() {
      const session = await browsers.open();
      try {
        const page = await session.remote.tab();
        if (!(await web.signedIn(page, site))) throw new VmakeError("vmake.ai shows the team's browser signed out", "account", "signed_out");
      } finally {
        await session.stop();
      }
    },
  };
}

/** How Edit asks its relay for the team's account, and which site the browsers open (tests put stand-ins here). */
export const website = {
  ask: (method: string, route: string, body: unknown): Promise<unknown> => relay.json(method, route, body, "the team's Vmake account", 90),
  site: web.SITE,
};

/** The team's account on the relay as last asked (a minute ago at most): whether it's set up there, and the day's files. */
const team: { ready: boolean; filesToday: number; atOnce: number; at: number; quota: web.Quota | null } = { ready: false, filesToday: 0, atOnce: web.AT_ONCE, at: 0, quota: null };

/** The day's free files left as vmake.ai last said (Smart Pro's), or null not read yet. */
export const freeLeft = (): number | null => team.quota?.modes[web.MODELS.pro]?.remain ?? null;

/** Forgets what the relay said (tests). */
export function forgetTeam(): void {
  team.at = 0;
}

async function teamState(): Promise<typeof team> {
  if (Date.now() - team.at < 60_000) return team;
  try {
    const said = (await website.ask("GET", "/v1/vmake", undefined)) as { ready?: unknown; filesToday?: unknown; atOnce?: unknown };
    team.ready = said.ready === true;
    team.filesToday = typeof said.filesToday === "number" ? said.filesToday : 0;
    // The team's pieces at once, the relay's. A relay from before it said doesn't know extra browsers (it would open
    // another on the profile itself): one piece at a time there.
    team.atOnce = typeof said.atOnce === "number" && said.atOnce >= 1 ? Math.min(12, Math.round(said.atOnce)) : 1;
  } catch {
    team.ready = false;
  }
  team.at = Date.now();
  return team;
}

/** This Mac to the relay (its cloud holder): whose turn the team's browser is. */
const holderOf = (app: App) => holderFor(app.store.home, app.machine);

const teamBrowsers = (app: App) => web.teamBrowsers(holderOf(app), website.ask);

/** The website's provider when Edit's relay has the team's Vmake account (every signed-in Mac then has it), else null. */
async function websiteHere(app: App): Promise<Provider | null> {
  if (!relay.cloudEnabled() || !(await teamState()).ready) return null;
  const files: Files = {
    left: () => web.DAILY_FILES - team.filesToday,
    count: async () => {
      const said = (await website.ask("POST", "/v1/vmake/file", { holder: holderOf(app) })) as { filesToday?: unknown };
      if (typeof said.filesToday === "number") team.filesToday = said.filesToday;
      return team.filesToday;
    },
  };
  return websiteProvider(app.store.home, teamBrowsers(app), website.site, web.stage, files, () => team.atOnce, (quota) => (team.quota = quota));
}

/** The sign-in under way: its live view. */
let signing: { url: string; done: Promise<void> } | null = null;

/** Whether the person signed in here is an admin (signing the team's Vmake account in is theirs alone). */
const isAdmin = () => accounts.status().admin === true;

/**
 * Opens a browser on the team's profile for an admin to sign in to (its live
 * view's address, which the editor opens), and keeps watching it: signed in,
 * it's stopped (the sign-in saved into the profile) and the account's sign-in
 * trouble cleared here.
 */
export async function signIn(app: App): Promise<string> {
  if (!isAdmin()) throw new ApiError(403, "Only an admin signs the team's Vmake account in.");
  if (signing !== null) return signing.url;
  const session = await teamBrowsers(app).open(true);
  const page = await session.remote.tab();
  await page.call("Page.navigate", { url: `${website.site}/video-watermark-remover/upload` });
  const url = session.liveUrl ?? "";
  const done = (async () => {
    const until = Date.now() + 20 * 60_000;
    try {
      while (Date.now() < until && !session.remote.closed) {
        await Bun.sleep(5000);
        const signed = await page.evaluate<boolean>(`!![...document.querySelectorAll('[class*=avatar]')].find((el) => el.getClientRects().length > 0)`).catch(() => false);
        if (signed) {
          await Bun.sleep(5000);
          unblock(app.store.home, "vmake-web");
          diag.info("removal", "the team's Vmake account signed in");
          return;
        }
      }
    } finally {
      await session.stop();
      signing = null;
    }
  })();
  signing = { url, done };
  return url;
}

/** For tests: the provider to use in place of this Mac's. */
let standIn: Provider | null | undefined;
export function useProvider(provider: Provider | null | undefined): void {
  standIn = provider;
}

export async function providerHere(app: App): Promise<Provider | null> {
  if (standIn !== undefined) return standIn;
  const site = await websiteHere(app).catch(() => null);
  if (site !== null) return site;
  const kept = await keychain.get(app.store.home, "vmake").catch(() => null);
  if (kept === null) return null;
  try {
    const keys = JSON.parse(Buffer.from(kept, "base64").toString("utf8")) as vmake.Keys;
    return typeof keys.ak === "string" && typeof keys.sk === "string" ? apiProvider(keys) : null;
  } catch {
    return null;
  }
}

/** Keeps Vmake's API keys on this Mac, once Vmake takes them. */
export async function keepKeys(app: App, keys: vmake.Keys): Promise<void> {
  await vmake.check(keys);
  await keychain.set(app.store.home, Buffer.from(JSON.stringify({ ak: keys.ak.trim(), sk: keys.sk.trim() })).toString("base64"), "vmake");
  unblock(app.store.home, "vmake-api");
}

// ---------------------------------------------------------------------------
// Kept pieces

/** Where cleaned pieces are kept: R2 (shared by every Mac) with a copy here. */
export interface Shelf {
  list(source: string): Promise<Cached[]>;
  /** The piece as a file here. */
  bring(source: string, cached: Cached): Promise<string>;
  keep(source: string, file: string, from: number, to: number, provider: ProviderId, mode?: web.Mode): Promise<Cached>;
  /** A kept piece that wasn't clean: gone here and on R2, so it's sent again. */
  forget(source: string, cached: Cached): Promise<void>;
}

export const PREFIX = "edit/cleaned";
export const folderOf = (source: string) => createHash("sha256").update(source).digest("hex").slice(0, 32);
/** A piece's name on the shelf: its seconds, its provider, and `.smart` when it's Smart's (a name without one is Smart Pro's). */
const nameOf = (from: number, to: number, provider: ProviderId, mode: web.Mode = "pro") => `${Math.round(from * 1000)}-${Math.round(to * 1000)}.${provider}${mode === "smart" ? ".smart" : ""}.mp4`;

export function parseName(key: string): Omit<Cached, "key"> | null {
  const match = /(\d+)-(\d+)\.(vmake-api|vmake-web)(\.smart)?\.mp4$/u.exec(key);
  return match === null ? null : { from: Number(match[1]) / 1000, to: Number(match[2]) / 1000, provider: match[3] as ProviderId, mode: match[4] === undefined ? "pro" : "smart" };
}

/** Whether a kept piece serves one asked for in `mode`: Smart Pro's serves either, Smart's only Smart. */
export const serves = (cached: Pick<Cached, "mode">, mode: web.Mode): boolean => cached.mode === "pro" || mode === "smart";

/** R2 under `edit/cleaned/<file>/`, each piece also kept in `dir` (this Mac's cache); with the cloud off, `dir` alone. */
export function shelfIn(dir: string, useCloud: () => boolean = () => cloud.enabled()): Shelf {
  const local = (source: string, name: string) => join(dir, folderOf(source), name);
  return {
    async list(source) {
      const names = new Set<string>();
      try {
        for (const name of fs.readdirSync(join(dir, folderOf(source)))) if (parseName(name) !== null) names.add(name);
      } catch {
        /* Nothing here yet. */
      }
      if (useCloud()) {
        for (const object of await cloud.list(`${PREFIX}/${folderOf(source)}/`).catch(() => [])) {
          const name = object.key.slice(object.key.lastIndexOf("/") + 1);
          if (parseName(name) !== null) names.add(name);
        }
      }
      return [...names].map((name) => ({ ...parseName(name)!, key: `${PREFIX}/${folderOf(source)}/${name}` }));
    },
    async bring(source, cached) {
      const file = local(source, cached.key.slice(cached.key.lastIndexOf("/") + 1));
      if (!fs.existsSync(file)) {
        fs.mkdirSync(join(dir, folderOf(source)), { recursive: true });
        await cloud.download(cached.key, file);
      }
      return file;
    },
    async keep(source, file, from, to, provider, mode = "pro") {
      const name = nameOf(from, to, provider, mode);
      const key = `${PREFIX}/${folderOf(source)}/${name}`;
      const here = local(source, name);
      fs.mkdirSync(join(dir, folderOf(source)), { recursive: true });
      if (file !== here) fs.renameSync(file, here);
      if (useCloud()) await cloud.uploadFile(here, key).catch((error: unknown) => diag.warn("removal", `keeping ${name} in the cloud: ${diag.messageOf(error)}`));
      return { from, to, provider, mode, key };
    },
    async forget(source, cached) {
      fs.rmSync(local(source, cached.key.slice(cached.key.lastIndexOf("/") + 1)), { force: true });
      if (useCloud()) await cloud.remove([cached.key]).catch((error: unknown) => diag.warn("removal", `forgetting ${cached.key}: ${diag.messageOf(error)}`));
    },
  };
}

let shelfOverride: Shelf | null = null;
/** For tests: a shelf in place of R2's. */
export function useShelf(shelf: Shelf | null): void {
  shelfOverride = shelf;
}

const shelfOf = (app: App) => shelfOverride ?? shelfIn(join(app.store.cacheDir(), "cleaned"));

/** What identifies a file across projects: its cloud source, else its bytes' hash. */
export async function sourceOf(media: Media): Promise<string> {
  if (media.cloud?.source) return media.cloud.source;
  return `sha256:${await cloudMedia.sha256File(media.path)}`;
}

// ---------------------------------------------------------------------------
// One project's plan and run

/** What a file shows of what `lesson` takes out to Vmake (source seconds: their subtitles, their labels and text), or undefined while it isn't read yet. */
export function textOf(media: Media, camera: Box[], lesson: removal.Lesson | null): [number, number][] | undefined {
  const subtitles = burned.of(media);
  if (subtitles === undefined) return undefined;
  const reads = burned.readsOf(media);
  const labels = reads === null || lesson?.remove.text !== true ? [] : labelSpans(reads.texts, reads.seconds, media.duration ?? 0, [...camera, ...removal.keepBoxes(lesson)], removal.exampleWords(lesson));
  return merged([...(lesson?.remove.subtitles === true ? (subtitles?.spans ?? []) : []), ...labels]);
}

export const lessonOf = removal.lessonOf;

/**
 * Where on a file's picture what's pasted back may be, beyond the camera's
 * text (always kept): only their subtitles' band when subtitles alone are
 * taught, everywhere but it when only their text is; the lesson's keep boxes
 * kept too. Boxes to keep the original's pixels in.
 */
export function keptFor(lesson: removal.Lesson | null, band: burned.Band | null): Box[] {
  const keep = removal.keepBoxes(lesson);
  const kinds = removal.kinds(lesson).vmake;
  if (band === null) return keep;
  const near = grown(band as Box, 0.03);
  if (kinds.length === 1 && kinds[0] === "subtitles") return [...keep, ...outside(near)];
  if (kinds.length === 1 && kinds[0] === "text") return [...keep, near];
  return keep;
}

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

export interface FilePlan {
  media: Media;
  source: string;
  send: [number, number][];
  use: Cached[];
  /** The parts its pieces take out (what's pasted back): those in force for this file's seconds. */
  kinds: removal.Kind[];
  /** The mode its pieces are sent in (by the sections their seconds show in: removal_modes.ts); a file can have a plan in each. */
  mode: web.Mode;
}

/** A strip's mode, by its name (`place`): Smart's end " · Smart". */
export const stripMode = (strip: Pick<Media, "name">): web.Mode => (strip.name.endsWith(SMART_STRIP) ? "smart" : "pro");
const SMART_STRIP = " · Smart";

/** Each footage file's seconds by the mode they're cleaned in (removal_modes.ts). */
export const modesOf = (app: App, project: Project): modes.ByMode => modes.byMode(project, app.store.home, (from, to) => shownBetween(project, from, to, true));

/** The lesson as it applies to `project` now (its parts that run by themselves, and those asked for: removal_asks.ts). */
export const inForceOf = (app: App, project: Pick<Project, "id" | "channel">): removal.Lesson | null => asks.inForce(lessonOf(project), app.store.home, project.id);

/**
 * Whether only the agent's marks go (removal_asks.ts `marked`): a channel
 * taught to take their subtitles or text out (Sphe, Nov 18: detection
 * proposes, the agent marks the in and out points, only those are sent or
 * blurred). A channel taught nothing of theirs sends what's asked, by
 * detection, as before.
 */
export const marksOnly = (project: Pick<Project, "channel">): boolean => removal.kinds(lessonOf(project)).vmake.length > 0;

/** One file's seconds to take their text out of, and the parts that take them (`wantedOf`). */
interface Wanted {
  media: Media;
  spans: [number, number][];
  kinds: removal.Kind[];
}

/**
 * What of each footage file has their text to take out now: the agent's
 * marks within what the lesson covers there (a channel taught it), else
 * what detection finds within what was asked; and the files still being read.
 */
function wantedOf(app: App, project: Project): { wanted: Wanted[]; reading: string[] } {
  const wanted: Wanted[] = [];
  const reading: string[] = [];
  const taught = lessonOf(project);
  const lesson = asks.inForce(taught, app.store.home, project.id);
  if (lesson === null || removal.kinds(lesson).vmake.length === 0) return { wanted, reading };
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
  const marks = marking ? asks.marked(app.store.home, project.id, proposals) : new Map<string, [number, number][]>();
  // The agent's own in and out points, which never wait on detection (a file not read yet still sends what it marked there).
  const explicit = marking ? asks.marked(app.store.home, project.id) : new Map<string, [number, number][]>();
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
    for (const kind of removal.kinds(lesson).vmake) {
      if (unread) break;
      const within = asks.scope(taught, app.store.home, project.id, kind, id, shown);
      if (within.length === 0) continue;
      const spans = marking ? (marksHere.get(id) ?? []) : textOf(media, cameraFromReads(media, null), removal.only(lesson, [kind]));
      if (spans === undefined) {
        unread = true;
        break;
      }
      const mine = modes.intersect(spans, within);
      if (mine.length === 0) continue;
      found.push(...mine);
      kinds.push(kind);
    }
    if (unread) {
      reading.push(media.name);
      void burned.warm(app.media, media);
      continue;
    }
    if (marking && unreadIds.has(id)) void burned.warm(app.media, media);
    const spans = merged(found);
    if (spans.length > 0) wanted.push({ media, spans, kinds });
  }
  return { wanted, reading };
}

/**
 * The files whose marked seconds get the tracked blur (removal_modes: from
 * the third case on, or where asked), as text_blur.ts takes them.
 */
export async function blurPlan(app: App, project: Project): Promise<blur.BlurPlan[]> {
  const out: blur.BlurPlan[] = [];
  const { wanted } = wantedOf(app, project);
  if (wanted.length === 0) return out;
  const sections = modesOf(app, project);
  const lesson = inForceOf(app, project);
  for (const { media, spans, kinds } of wanted) {
    const mine = modes.intersect(spans, sections.get(media.id)?.blur ?? []);
    if (mine.length === 0) continue;
    const reads = burned.readsOf(media);
    const camera = cameraFromReads(media, null);
    const keep = removal.keepBoxes(lesson);
    const labels = reads === null || !kinds.includes("text") ? [] : labelBoxes(reads.texts, reads.seconds, [...camera, ...keep], removal.exampleWords(lesson), true);
    out.push({ media, source: await sourceOf(media), spans: mine, band: burned.of(media)?.band ?? null, labels, avoid: [...camera, ...keep], subtitles: kinds.includes("subtitles"), text: kinds.includes("text") });
  }
  return out;
}

/**
 * What detection proposes for the agent to mark (get_edit_context's
 * removal): each visible clip's stretch of the timeline where its file shows
 * their text (burned_subtitles' spans, their labels), and whether it's marked
 * already; and the marks made beyond them.
 */
export function proposed(app: App, project: Project): modes.Proposed[] {
  const fps = fpsOf(project);
  const lesson = inForceOf(app, project);
  if (lesson === null) return [];
  const all = new Map<string, [number, number][]>();
  if (asks.marksProposed(app.store.home, project.id)) for (const media of project.media) if (media.kind === "video") all.set(media.id, textOf(media, cameraFromReads(media, null), lesson) ?? []);
  const marks = asks.marked(app.store.home, project.id, all);
  const out: modes.Proposed[] = [];
  const seen = new Map<string, [number, number][]>();
  for (const clip of project.clips) {
    if (clip.type !== "video" || isOverlay(clip) || trackOf(project, clip.track)?.hidden === true || !(clip.speed > 0)) continue;
    const media = project.media.find((one) => one.id === clip.media);
    if (media === undefined || media.kind !== "video" || media.cleans != null || media.effect != null) continue;
    const spans = textOf(media, cameraFromReads(media, null), lesson) ?? [];
    const end = clip.source_in + (clip.duration / fps) * clip.speed;
    const timeline = (seconds: number) => clip.start / fps + (seconds - clip.source_in) / clip.speed;
    const mine = marks.get(media.id) ?? [];
    for (const [a, b] of modes.intersect(spans, [[clip.source_in, end]])) {
      const covered = modes.minus([[a, b]], mine).length === 0;
      out.push({ from: timeline(a), to: timeline(b), media: media.name, marked: covered });
    }
    for (const [a, b] of modes.intersect(mine, [[clip.source_in, end]])) {
      // A mark beyond what detection found (the agent saw it itself).
      if (modes.minus([[a, b]], spans).length === 0) continue;
      const key = media.id;
      if ((seen.get(key) ?? []).some(([x, y]) => x === a && y === b)) continue;
      seen.set(key, [...(seen.get(key) ?? []), [a, b]]);
      out.push({ from: timeline(a), to: timeline(b), media: media.name, marked: true });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

/** Every file of `project` to send to Vmake (what its channel's lesson takes out there: their subtitles, their text; the agent's marks of them for a channel taught it), or the files still being read. */
export async function plan(app: App, project: Project, provider: Provider | null = null): Promise<{ files: FilePlan[]; reading: string[] }> {
  const files: FilePlan[] = [];
  const { wanted: all, reading } = wantedOf(app, project);
  if (all.length === 0) return { files, reading };
  const sections = modesOf(app, project);
  for (const { media, spans: wanted, kinds } of all) {
    // Their text's seconds by the mode their sections give them: Smart Pro's, Smart's; the blur's (a third case on) are text_blur.ts's.
    const by = sections.get(media.id) ?? { pro: [], smart: [], blur: [] };
    const asked = { pro: modes.intersect(wanted, by.pro), smart: modes.intersect(wanted, by.smart) };
    // Each mode's pieces packed only within its own sections: never over the seconds another mode takes between them.
    const walls = { pro: modes.intersect(wanted, [...by.smart, ...by.blur]), smart: modes.intersect(wanted, [...by.pro, ...by.blur]) };
    if (asked.pro.length === 0 && asked.smart.length === 0) continue;
    const source = await sourceOf(media);
    // A piece given up on (twice not clean) stays blurred: never sent again in this project.
    const given = [...(textPieces.get(project.id)?.values() ?? [])].filter((one) => one.media === media.id && one.state === "failed").map((one): Cached => ({ from: one.from, to: one.to, provider: "vmake-api", mode: "pro", key: "" }));
    const cached = [...(await listed(app, source)), ...given];
    const inHands = inHandsOf(app.store.home, source);
    // Paid by the file: a short one goes whole (one file either way), in the better mode it needs; never past the agent's marks.
    const whole = provider?.wholeFiles === true && !marksOnly(project) && (media.duration ?? 0) <= PIECE_SECONDS;
    // Pieces already in the project as strips (or given up on) need nothing.
    const have = project.media.filter((one) => one.cleans?.media === media.id && (one.cleans.what ?? "text") === "text");
    // Smart Pro's pieces first: what they send isn't Smart's to send too.
    const planned: Cached[] = [];
    const taken = new Set<string>();
    for (const mode of ["pro", "smart"] as const) {
      if (asked[mode].length === 0) continue;
      // A Smart result never stands in for Smart Pro; Smart Pro's (every result from before) does for Smart.
      // A Smart result wholly inside a Smart Pro one adds nothing: the better one's laid.
      const inside = (one: Cached) => one.mode === "smart" && cached.some((other) => other.mode === "pro" && other.key !== "" && other.from <= one.from + 0.01 && other.to >= one.to - 0.05);
      // What's out at vmake.ai for these seconds in this mode goes on as it was sent.
      const out = inHands.filter((one) => one.mode === mode && modes.intersect([[one.from, one.to]], asked[mode]).length > 0 && !cached.some((done) => done.key !== "" && Math.abs(done.from - one.from) < 0.01 && Math.abs(done.to - one.to) < 0.05));
      const going = out.map((one): Cached => ({ from: one.from, to: one.to, provider: "vmake-api", mode, key: "" }));
      const fits = [...cached.filter((one) => one.key === "" || (serves(one, mode) && !inside(one))), ...planned, ...going];
      const { send: fresh, use } = piecesFor(whole ? [[HANDLE, Math.max(HANDLE, (media.duration ?? 0) - HANDLE)]] : asked[mode], media.duration ?? 0, media.fps || fpsOf(project), fits, provider?.wholeFiles === true, walls[mode]);
      const used = use.filter((one) => one.key !== "" && !taken.has(one.key) && !have.some((strip) => Math.abs(strip.cleans!.from - one.from) < 0.01 && Math.abs(strip.cleans!.to - one.to) < 0.05 && serves({ mode: stripMode(strip) }, mode)));
      for (const one of used) taken.add(one.key);
      const send = [...going.map((one): [number, number] => [one.from, one.to]), ...fresh].sort((a, b) => a[0] - b[0]);
      planned.push(...send.map(([from, to]): Cached => ({ from, to, provider: "vmake-api", mode, key: "" })));
      if (send.length > 0 || used.length > 0) files.push({ media, source, send, use: used, kinds, mode });
      if (whole) break;
    }
  }
  return { files, reading };
}

/** Listings of the shelf, a minute each (the line asks often). */
const listings = new Map<string, { at: number; cached: Promise<Cached[]> }>();
function listed(app: App, source: string): Promise<Cached[]> {
  const hit = listings.get(source);
  if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.cached;
  const cached = shelfOf(app).list(source);
  listings.set(source, { at: Date.now(), cached });
  return cached;
}

/**
 * One piece of a project's footage on its way through Vmake, and how it came
 * out: `check` laid and waiting for the agent's look (removal.ts
 * `check_removal`), `done` looked at (or nobody objected), `failed` given up
 * on after a second try (its blur laid back, said in `why`).
 */
export interface TextPiece {
  key: string;
  media: string;
  name: string;
  from: number;
  to: number;
  /**
   * held: Vmake's account can't be used now (said in the line); picked up again once it can. waiting: sent, and
   * vmake.ai hasn't shown it back yet (a look couldn't tell): looked for again by itself at `lookAt`, never sent again.
   */
  state: "queued" | "running" | "held" | "waiting" | "check" | "done" | "failed";
  /** Its try on vmake.ai (its name there): a new one only after a result wasn't clean or vmake.ai refused it. */
  tries: number;
  /** Goes it had at Vmake that went wrong or weren't clean (a second, then given up on). */
  attempts?: number;
  /** When a piece waiting on vmake.ai is looked for again. */
  lookAt?: number;
  /** What the automatic look found (their words still read), or why it failed. */
  why?: string;
  /** The strip's media id once laid. */
  strip?: string;
  /** Given up on because vmake.ai never showed it back (not because it wasn't clean). */
  lost?: boolean;
  /** The mode it's cleaned in (its section's: removal_modes.ts). */
  mode: web.Mode;
}

const textPieces = new Map<string, Map<string, TextPiece>>();
const pieceKeyOf = (media: string, from: number) => `text:${media}@${Math.round(from * 1000)}`;
/**
 * A piece's place among those out at Vmake, and its name there (with its
 * try): by file and seconds, and Smart's marked so (a Smart card is never
 * picked up for a Smart Pro piece); Smart Pro's as before Nov 18.
 */
const outKeyOf = (source: string, from: number, to: number, mode: web.Mode) => `${source}|${from}|${to}${mode === "smart" ? "|smart" : ""}`;

/** The project's pieces through Vmake (removal.ts reads them for its line, its check and the export's wait). */
export function piecesOf(id: string): TextPiece[] {
  return [...(textPieces.get(id)?.values() ?? [])].sort((a, b) => a.media.localeCompare(b.media) || a.from - b.from);
}

/** Drops `id`'s pieces waiting (queued, held, or waiting on vmake.ai) that aren't in `keep`. */
function prune(id: string, keep: Set<string>): void {
  const mine = textPieces.get(id);
  if (mine === undefined) return;
  for (const [key, one] of mine) if ((one.state === "queued" || one.state === "held" || one.state === "waiting") && !keep.has(key)) mine.delete(key);
}

function notePiece(id: string, piece: TextPiece): TextPiece {
  let mine = textPieces.get(id);
  if (mine === undefined) textPieces.set(id, (mine = new Map()));
  const was = mine.get(piece.key);
  const next = { ...piece, tries: Math.max(piece.tries, was?.tries ?? 0), attempts: Math.max(piece.attempts ?? 0, was?.attempts ?? 0) };
  mine.set(piece.key, next);
  return next;
}

interface Run {
  provider: ProviderId;
  total: number;
  done: number;
  account: AccountReason | null;
  over: boolean;
  /** The project changed while it ran: planned again when it ends (only what's new is sent). */
  again: boolean;
  stop: AbortController;
}
const runs = new Map<string, Run>();
/** Projects whose person said yes to the API's price (the website's plan needs no yes). */
const confirmed = new Set<string>();

/** What the editor shows: one line, its one button, and how far it's got. */
export interface Status {
  line: string | null;
  /** remove: say yes to the API's price; retry: the account looked at again; sign_in: Vmake's sign-in opened. */
  action: "remove" | "retry" | "sign_in" | null;
  running: { done: number; total: number } | null;
  /** Removal under way in the background (the chat's waiting row, removal_schedule.ts): what, how far, since when. */
  background?: { label: string; done: number; total: number; started_at: number; free_left?: number } | null;
}

const minutes = (seconds: number) => (seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`);

/**
 * Sends what `id`'s timeline newly shows of their text to Vmake, in the
 * background (removal.ts calls it as soon as edits rest): kept pieces laid at
 * once, the rest sent; on the API's paid route only once the person said yes
 * to its price. A run under way picks up what changed when it ends.
 */
export async function ensure(app: App, id: string): Promise<void> {
  const live = app.store.get(id);
  if (live === null) return;
  if (removal.kinds(inForceOf(app, live.project)).vmake.length === 0) {
    await blur.ensure(app, id, []);
    return;
  }
  // The tracked blur (a third case on): here and free, whatever Vmake's account or run is doing.
  await blur.ensure(app, id, await blurPlan(app, live.project));
  const running = runs.get(id);
  if (running !== undefined && !running.over) {
    running.again = true;
    return;
  }
  const provider = await providerHere(app);
  if (provider === null || blocked(app.store.home, provider.id) !== null) return;
  const { files } = await plan(app, live.project, provider);
  if (files.length === 0) {
    prune(id, new Set());
    return;
  }
  // Finished results from before on the account (the website's): kept for their seconds first, so only what's missing goes.
  if (files.some((file) => file.send.length > 0) && provider.legacy !== undefined && !harvested.has(id)) {
    harvested.add(id);
    if ((await harvest(app, live.project, provider).catch((error: unknown) => (diag.warn("removal", `${id}: results from before: ${diag.messageOf(error)}`), 0))) > 0) {
      listings.clear();
      return ensure(app, id);
    }
  }
  const paid = files.some((file) => file.send.length > 0);
  if (paid && provider.id === "vmake-api" && !confirmed.has(id)) {
    // Only what's kept already goes now; what costs waits for the person's yes.
    const free = files.filter((file) => file.use.length > 0).map((file) => ({ ...file, send: [] }));
    if (free.length > 0) start(app, id, provider, free);
    return;
  }
  start(app, id, provider, files);
}

/** Projects whose results from before were looked for in this run of the server. */
const harvested = new Set<string>();

/**
 * Finished results on the account from before pieces had names of their own
 * (Nov 17: nightly-81 gave up on pieces vmake.ai went on to finish): each
 * matched to the window the whole video's plan gives (as that build planned
 * it: every taught part, the timeline's seconds, packed), by length, and used
 * only once its picture is that window's footage; kept on the shelf for those
 * seconds like any cleaned piece, so a later plan (a stretch asked for, the
 * rest) uses it and sends only what's missing. The count kept.
 */
async function harvest(app: App, project: Project, provider: Provider): Promise<number> {
  const cards = await provider.legacy!();
  if (cards.length === 0) return 0;
  const lesson = lessonOf(project);
  const kinds = removal.kinds(lesson).vmake;
  if (lesson === null || kinds.length === 0) return 0;
  const used = new Set<string>();
  const dir = join(app.store.cacheDir(), "cleaned", "work");
  fs.mkdirSync(dir, { recursive: true });
  let kept = 0;
  for (const [id, shown] of shownSeconds(project)) {
    const media = project.media.find((one) => one.id === id)!;
    const spans = textOf(media, cameraFromReads(media, null), removal.only(lesson, kinds));
    if (spans === undefined) continue;
    const wanted = merged(spans.flatMap(([a, b]) => shown.flatMap(([x, y]): [number, number][] => (Math.min(b, y) > Math.max(a, x) ? [[Math.max(a, x), Math.min(b, y)]] : []))));
    if (wanted.length === 0) continue;
    const source = await sourceOf(media);
    const cached = await listed(app, source);
    const { send } = piecesFor(wanted, media.duration ?? 0, media.fps || fpsOf(project), cached, true);
    for (const [from, to] of send) {
      const candidates = cards.filter((one) => !used.has(one.url) && Math.abs(one.seconds - (to - from)) <= 0.25);
      if (candidates.length === 0) continue;
      const stem = join(dir, `legacy-${folderOf(source).slice(0, 8)}-${Math.round(from * 1000)}`);
      try {
        const input = await cloudMedia.originalInput(app.store.cacheDir(), media);
        await cutPiece(input, from, to, `${stem}.original.mp4`);
        // Each card as long as the window, until one is its footage.
        for (const card of candidates) {
          await web.fetchResult(card.url, `${stem}.result.mp4`);
          if (!(await sameFootage(`${stem}.original.mp4`, `${stem}.result.mp4`))) continue;
          used.add(card.url);
          await shelfOf(app).keep(source, `${stem}.result.mp4`, from, to, provider.id);
          listings.delete(source);
          kept += 1;
          diag.info("removal", `${media.name} ${Math.round(from)}–${Math.round(to)} s: ${card.name}, finished before on vmake.ai, used (nothing sent)`);
          break;
        }
      } finally {
        for (const end of [".original.mp4", ".result.mp4"]) fs.rmSync(`${stem}${end}`, { force: true });
      }
    }
  }
  return kept;
}

/** The line for project `id`: a quiet state while pieces are out, the account's trouble plainly, the API's price to say yes to. */
export async function status(app: App, id: string): Promise<Status> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  await removal.refresh();
  const lesson = inForceOf(app, live.project);
  if (removal.kinds(lesson).vmake.length === 0) return { line: null, action: null, running: null };
  const pieces = piecesOf(id);
  const out = pieces.filter((one) => one.state === "queued" || one.state === "running").length;
  if (out > 0) {
    const done = pieces.filter((one) => one.state === "check" || one.state === "done").length;
    return { line: `Removing their text · ${done} of ${done + out} pieces`, action: null, running: { done, total: done + out } };
  }
  const provider = await providerHere(app);
  if (provider === null) return { line: "Their text stays blurred: the team's Vmake account isn't set up yet.", action: null, running: null };
  const stopped = blocked(app.store.home, provider.id);
  if (stopped !== null) {
    // The team's profile signed out: an admin signs it in again (the button is theirs alone).
    if (stopped.reason === "signed_out" && provider.id === "vmake-web") return isAdmin() ? { line: accountLine(stopped.reason, stopped.said), action: "sign_in", running: null } : { line: `${accountLine(stopped.reason, stopped.said)} An admin signs it in again.`, action: null, running: null };
    return { line: accountLine(stopped.reason, stopped.said), action: "retry", running: null };
  }
  const failed = pieces.filter((one) => one.state === "failed").length;
  if (provider.id === "vmake-api" && !confirmed.has(id)) {
    const { files } = await plan(app, live.project, provider);
    const long = (file: FilePlan) => file.send.reduce((all, [a, b]) => all + b - a, 0);
    const seconds = files.reduce((sum, file) => sum + long(file), 0);
    const smart = files.filter((file) => file.mode === "smart").reduce((sum, file) => sum + long(file), 0);
    const count = files.reduce((sum, file) => sum + file.send.length, 0);
    // The split, plainly: "Smart Pro on the intro, Smart on cases 1 and 2".
    const sent: modes.ByMode = new Map();
    for (const file of files) {
      const one = sent.get(file.media.id) ?? { pro: [], smart: [], blur: [] };
      one[file.mode].push(...file.send);
      sent.set(file.media.id, one);
    }
    const split = modes.describe(live.project, modesOf(app, live.project), sent, (from, to) => shownBetween(live.project, from, to));
    if (count > 0) return { line: `Take their text out of ${minutes(seconds)} of footage${split === "" ? "" : `, ${split}`}: ${provider.price(seconds, count, smart)}`, action: "remove", running: null };
  }
  const waiting = pieces.filter((one) => one.state === "waiting").length;
  if (waiting > 0) return { line: `Waiting on vmake.ai for ${waiting === 1 ? "one piece" : `${waiting} pieces`} sent earlier; their text stays blurred there until it's back.`, action: null, running: null };
  const lost = pieces.filter((one) => one.state === "failed" && one.lost === true).length;
  if (failed > 0 && lost === failed) return { line: `vmake.ai never gave back ${lost === 1 ? "one piece" : `${lost} pieces`} sent to it; their text stays blurred there.`, action: null, running: null };
  if (failed > 0) return { line: `Vmake couldn't clean ${failed === 1 ? "one piece" : `${failed} pieces`}; their text stays blurred there.`, action: null, running: null };
  // Past the free files the plan's credits pay: said only when they run low.
  const credits = provider.id === "vmake-web" ? (team.quota?.balance ?? null) : null;
  if (credits !== null && credits < web.LOW_CREDITS) return { line: `Vmake's credits are running low: ${credits} left.`, action: null, running: null };
  return { line: null, action: null, running: null };
}

/** The person's yes (the API's price), or a retry of an account Vmake refused. */
export async function begin(app: App, id: string, retry = false): Promise<Status> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  await removal.refresh();
  const provider = await providerHere(app);
  if (provider === null) {
    // Their watermarks alone need no Vmake: the engine's work goes on (removal_schedule.ts).
    if (removal.kinds(inForceOf(app, live.project)).vmake.length > 0) throw new ApiError(409, "Vmake isn't set up on this Mac.");
    await schedule.ensure(app, id);
    return status(app, id);
  }
  if (retry && readKept(app.store.home).accounts[provider.id] !== undefined) {
    try {
      await provider.check();
      unblock(app.store.home, provider.id);
    } catch (error) {
      if (error instanceof VmakeError && error.scope === "account") block(app.store.home, provider.id, error);
      else unblock(app.store.home, provider.id);
    }
  }
  confirmed.add(id);
  listings.clear();
  await schedule.ensure(app, id);
  return status(app, id);
}

/** Both workers brought up to date (removal_schedule.ts sets it: a yes or a retry starts their watermarks' work too, not only Vmake's). */
export const schedule = { ensure: (app: App, id: string): Promise<void> => ensure(app, id) };

/** Projects whose run just ended and is planning what changed meanwhile (a run of it may follow). */
const chaining = new Set<string>();

/** The person's Stop (the chat's waiting row): nothing more is sent; a piece already at Vmake comes back and is kept, pieces cleaned stay. */
export function stop(id: string): void {
  runs.get(id)?.stop.abort();
  prune(id, new Set());
}

/** For tests: the run of `id` once it's over (and any run it started again). */
export async function settled(id: string): Promise<void> {
  while (runs.get(id)?.over === false || chaining.has(id)) await Bun.sleep(20);
}

/** For tests: nothing remembered. */
export function reset(): void {
  for (const one of lookTimers.values()) clearTimeout(one.timer);
  lookTimers.clear();
  harvested.clear();
  textPieces.clear();
  runs.clear();
  confirmed.clear();
  listings.clear();
}

/**
 * What Vmake's piece still shows of their words: each line of theirs read in
 * the original piece (a few frames, not the camera's or what the lesson keeps,
 * in the reach the lesson gives) looked for in Vmake's at the same frames.
 * Null when none still reads.
 */
/** Where the engine's learned mark sits (its model's JSON, watermark_removal.ts), in shares of the picture; null when it can't say. */
export function markBox(model: string): Box | null {
  try {
    const read = JSON.parse(model) as { width?: unknown; height?: unknown; at?: unknown; matte_width?: unknown; matte_height?: unknown };
    const [w, h, mw, mh] = [read.width, read.height, read.matte_width, read.matte_height].map(Number);
    const at = Array.isArray(read.at) ? read.at.map(Number) : [];
    if (!(w! > 0 && h! > 0 && mw! > 0 && mh! > 0) || at.length !== 2 || !at.every(Number.isFinite)) return null;
    return [at[0]! / w!, at[1]! / h!, (at[0]! + mw!) / w!, (at[1]! + mh!) / h!];
  } catch {
    return null;
  }
}

/**
 * A file's see-through watermark, as learned for its source: the automatic
 * look leaves its words alone (Nov 17, the team route's first live piece:
 * Vmake took Tulsa's subtitles and label out and left "daily dose of crime",
 * which the engine takes out, and the look read "dose" as left).
 */
async function markBoxesOf(app: App, source: string): Promise<Box[]> {
  // Imported when asked: watermark_removal.ts imports this file.
  const mark = await (await import("./watermark_removal.ts")).markOf(app, source).catch(() => null);
  const box = mark === null || "none" in mark ? null : markBox(mark.json);
  return box === null ? [] : [box];
}

export async function stillShows(original: string, cleaned: string, size: [number, number], seconds: number, keep: Box[]): Promise<string | null> {
  const at = [...new Set([0.2, 0.5, 0.8].map((share) => Math.floor(seconds * share)))].filter((second) => second >= 0 && second < seconds);
  const [before, after] = await Promise.all([native().screenTextDetect(original, size, at), native().screenTextDetect(cleaned, size, at)]);
  for (const second of at) {
    const theirs = (before[second] ?? []).filter((line) => wordy(line.t) && parseClock(line.t) === null && !keep.some((box) => overlapShare(box, line.b) > 0.5));
    for (const line of theirs) {
      const words = tokens(line.t);
      const still = (after[second] ?? []).find((other) => Math.abs(centre(other.b)[0] - centre(line.b)[0]) < 0.05 && Math.abs(centre(other.b)[1] - centre(line.b)[1]) < 0.05 && alike(words, tokens(other.t)));
      if (still !== undefined) return `"${line.t.trim()}" still reads at ${second} s`;
    }
  }
  return null;
}

/**
 * A piece that isn't clean (the automatic look, or the agent's): its strip
 * taken out of the project and its kept copy forgotten; sent once more, else
 * given up on, their blur laid back over it and said.
 */
export async function reject(app: App, id: string, key: string, why: string, last = false): Promise<string> {
  const piece = textPieces.get(id)?.get(key);
  if (piece === undefined) throw new Error(`no piece ${key}`);
  const live = app.store.get(id);
  const media = live?.project.media.find((one) => one.id === piece.media);
  if (live === null || media === undefined) throw new Error("its footage is gone");
  const source = await sourceOf(media);
  // The kept result that served it (a Smart piece's may be Smart Pro's), never one of another mode it couldn't use.
  const kept = (await shelfOf(app).list(source)).filter((one) => Math.abs(one.from - piece.from) < 0.01 && serves(one, piece.mode));
  for (const one of kept) await shelfOf(app).forget(source, one);
  listings.delete(source);
  // Done again under its next name (after a restart too), never the card whose result this was.
  const outKey = outKeyOf(source, piece.from, piece.to, piece.mode);
  const had = outstanding(app.store.home, outKey);
  if (!last && had?.sent !== true) setOutstanding(app.store.home, outKey, { tries: Math.max(had?.tries ?? 0, piece.tries + 1), sent: false });
  // Each go that went wrong or wasn't clean counts: a second, then given up on.
  const attempts = (piece.attempts ?? 0) + 1;
  const second = !last && attempts < 2;
  await app.store.update(id, "text removal", (project) => {
    project.media = project.media.filter((one) => !(one.cleans?.media === piece.media && (one.cleans.what ?? "text") === "text" && Math.abs(one.cleans.from - piece.from) < 0.01));
    if (!second) coverAgain(project, media, piece.from, piece.to);
  });
  notePiece(id, { ...piece, attempts, state: second ? "queued" : "failed", why, strip: undefined });
  if (why !== LOST) diag.warn("removal", `${id}: ${piece.name} ${Math.round(piece.from)}–${Math.round(piece.to)} s not clean (${why}): ${second ? "sent again" : "given up on, blurred"}`);
  if (second) await ensure(app, id);
  return second ? "sent to Vmake again" : "given up on: their text there is blurred";
}

/** Their blur laid back over a piece given up on: their subtitles' band and their labels, stuck to each clip of the footage there. */
function coverAgain(project: Project, media: Media, from: number, to: number): void {
  const fps = fpsOf(project);
  const shown = burned.onTimeline(project, 0, Number.MAX_SAFE_INTEGER, true).shown.filter((one) => {
    const clip = project.clips.find((own) => own.id === one.clip);
    if (clip === undefined || clip.type !== "video" || clip.media !== media.id) return false;
    const at = (frame: number) => clip.source_in + ((frame - clip.start) / fps) * clip.speed;
    return at(one.start) < to && at(one.end) > from;
  });
  if (shown.length > 0) burned.cover(project, shown, true);
  const reads = burned.readsOf(media);
  if (reads === null) return;
  for (const box of labelBoxes(reads.texts, reads.seconds, cameraFromReads(media, null), removal.exampleWords(lessonOf(project)))) {
    for (const clip of project.clips) {
      if (clip.type !== "video" || clip.media !== media.id) continue;
      burned.coverBox(project, clip, media, box, from, to);
    }
  }
}

/** Why a piece given up on because vmake.ai never showed it back is blurred. */
const LOST = "vmake.ai never gave it back, though it was looked for again for hours; it wasn't sent again";

/** Each project's next look for its pieces waiting on vmake.ai. */
const lookTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

/** Looks again at `id`'s pieces waiting on vmake.ai at `at` (the earliest asked for): they're queued and brought up to date as an edit would. */
function lookLater(app: App, id: string, at: number): void {
  const had = lookTimers.get(id);
  if (had !== undefined && had.at <= at) return;
  if (had !== undefined) clearTimeout(had.timer);
  const timer = setTimeout(() => {
    lookTimers.delete(id);
    for (const one of piecesOf(id)) if (one.state === "waiting" && (one.lookAt ?? 0) <= Date.now() + 1000) notePiece(id, { ...one, state: "queued" });
    void schedule.ensure(app, id).catch((error: unknown) => diag.warn("removal", `${id}: looking again: ${diag.messageOf(error)}`));
  }, Math.max(0, at - Date.now()));
  timer.unref?.();
  lookTimers.set(id, { at, timer });
}

function start(app: App, id: string, provider: Provider, files: FilePlan[]): void {
  if (runs.get(id)?.over === false) return;
  const jobs = files.flatMap((file) => [...file.use.map((cached) => ({ file, cached, range: [cached.from, cached.to] as [number, number] })), ...file.send.map((range) => ({ file, cached: null as Cached | null, range }))]);
  const run: Run = { provider: provider.id, total: jobs.length, done: 0, account: null, over: false, again: false, stop: new AbortController() };
  // Pieces waiting (or held by the account) the plan no longer has (a re-cut took their footage off): gone, never waited for.
  prune(id, new Set(jobs.map((job) => pieceKeyOf(job.file.media.id, job.range[0]))));
  const project = app.store.get(id)?.project;
  const lesson = project === undefined ? null : inForceOf(app, project);
  runs.set(id, run);
  for (const job of jobs) {
    const known = textPieces.get(id)?.get(pieceKeyOf(job.file.media.id, job.range[0]));
    notePiece(id, { key: pieceKeyOf(job.file.media.id, job.range[0]), media: job.file.media.id, name: job.file.media.name, from: job.range[0], to: job.range[1], state: "queued", tries: known?.tries ?? 0, mode: job.file.mode });
  }
  const sent = { seconds: 0, credits: 0, creditsSaid: false };
  const stamps = new Map<string, Promise<Box[]>>();
  /** `begun`: Vmake took the piece (the account works): what waits behind it goes. */
  const work = async (job: (typeof jobs)[number], begun: () => void = () => {}) => {
    if (run.stop.signal.aborted) return;
    const { file, range } = job;
    const [from, to] = range;
    const key = pieceKeyOf(file.media.id, from);
    let piece = notePiece(id, { ...textPieces.get(id)!.get(key)!, state: "running" });
    const label = `${file.media.name} ${Math.round(from)}–${Math.round(to)} s${file.mode === "smart" ? " (Smart)" : ""}`;
    // Its place among the pieces out at Vmake (on disk: a restart keeps it): by file, seconds and mode.
    const outKey = outKeyOf(file.source, from, to, file.mode);
    /** A look that couldn't tell (the piece is vmake.ai's): looked for again later, or, its looks used, given up on. */
    const park = async (now: Omit<Out, "at">, why: string): Promise<void> => {
      const looks = (now.looks ?? 0) + 1;
      const since = now.since ?? Date.now();
      if (looks > looking.afterMs.length) {
        setOutstanding(app.store.home, outKey, { ...now, looks, since, lost: true, covered: [id] });
        diag.warn("removal", `${id}: ${label}: vmake.ai never showed it back in ${Math.round((Date.now() - since) / 60_000)} min (${looks} looks; last: ${why}): given up on, blurred, not sent again`);
        await reject(app, id, key, LOST, true);
        piece = notePiece(id, { ...textPieces.get(id)!.get(key)!, state: "failed", why: LOST, lost: true });
        return;
      }
      const next = Date.now() + looking.afterMs[looks - 1]!;
      setOutstanding(app.store.home, outKey, { ...now, looks, since, next });
      diag.info("removal", `${id}: ${label}: waiting on vmake.ai (${why}); looked for again in ${Math.round((next - Date.now()) / 60_000)} min under the same name, nothing sent`);
      piece = notePiece(id, { ...piece, state: "waiting", lookAt: next });
      lookLater(app, id, next);
    };
    const dir = join(app.store.cacheDir(), "cleaned", "work");
    fs.mkdirSync(dir, { recursive: true });
    const stem = join(dir, `${id}-${file.media.id}-${Math.round(from * 1000)}`);
    try {
      if (job.cached !== null) {
        // Kept on the shelf: whatever was out for it is back (a stop between the keep and this let go).
        setOutstanding(app.store.home, outKey, null);
      } else {
        const was = outstanding(app.store.home, outKey);
        if (was?.lost === true) {
          // vmake.ai never showed it back after every look: blurred (once a project), never sent again by itself.
          if (!(was.covered ?? []).includes(id)) {
            await reject(app, id, key, LOST, true);
            setOutstanding(app.store.home, outKey, { ...was, covered: [...(was.covered ?? []), id] });
          }
          piece = notePiece(id, { ...textPieces.get(id)!.get(key)!, state: "failed", why: LOST, lost: true });
          return;
        }
        if (was?.sent === true && was.next !== undefined && was.next > Date.now()) {
          // Sent, and the last look couldn't tell: looked for again at its time, nothing sent.
          piece = notePiece(id, { ...piece, state: "waiting", lookAt: was.next });
          lookLater(app, id, was.next);
          return;
        }
      }
      const input = await cloudMedia.originalInput(app.store.cacheDir(), file.media);
      if (!stamps.has(file.media.id)) stamps.set(file.media.id, stampOf(app, file.media, input));
      const original = `${stem}.original.mp4`;
      await cutPiece(input, from, to, original, 300_000_000, provider.pieceQuality);
      let cached = job.cached;
      if (cached === null) {
        if (blocked(app.store.home, provider.id) !== null) {
          piece = notePiece(id, { ...piece, state: "held" });
          return;
        }
        const out = `${stem}.vmake.mp4`;
        // A whole file already on R2 goes from there (a cloud browser fetches it at a datacenter's speed).
        const fileKey = file.media.cloud?.original;
        const whole = fileKey && from <= 0.05 && to >= (file.media.duration ?? 0) - 0.05 && (file.media.cloud?.size ?? Infinity) <= 300_000_000 ? { key: fileKey } : undefined;
        // Named by its file, seconds and try: asked again (a restart, an update mid-run, a look again), its card on
        // vmake.ai is looked for under the same name, never sent twice: the try it went as is kept on disk while it's
        // out, and moves on only once vmake.ai said it won't come back (or its result wasn't clean).
        const was = outstanding(app.store.home, outKey);
        piece = notePiece(id, { ...piece, tries: was !== null ? was.tries : piece.tries + 1, lookAt: undefined });
        const going: Omit<Out, "at"> = was !== null ? { ...was, tries: piece.tries } : { tries: piece.tries, sent: false };
        setOutstanding(app.store.home, outKey, going);
        let spent: { credits: number | null };
        try {
          spent = await provider.remove(original, out, to - from, run.stop.signal, whole, begun, `${outKey}|${piece.tries}`, {
            sentBefore: was?.sent === true,
            // Kept by a build before it said whether the file went in (an update mid-piece): its card looked for as long first.
            longer: was !== null && was.sent === undefined,
            // The file is going into vmake.ai's page: from now on it's only looked for (on disk at once, before the page hears it).
            sent: () => setOutstanding(app.store.home, outKey, { ...going, sent: true, since: going.since ?? Date.now() }),
          }, file.mode);
        } catch (error) {
          const now = outstanding(app.store.home, outKey) ?? going;
          if (error instanceof web.Refused) {
            // vmake.ai said it won't come back (its card failed, the file refused, the day's limit on its card): the next try goes under a new name.
            setOutstanding(app.store.home, outKey, { tries: piece.tries + 1, sent: false });
          } else if (now.sent === true && !(error instanceof VmakeError && error.scope === "account")) {
            // In vmake.ai's hands and nothing says it's lost (its card not found in time, the page not answering, still
            // processing, the browser gone): parked under the same name and looked for again later, never sent twice.
            await park(now, diag.messageOf(error));
            return;
          } else if (now.sent !== true && !(error instanceof VmakeError && error.scope === "account")) {
            // Never went in: nothing on vmake.ai under this name.
            setOutstanding(app.store.home, outKey, { tries: piece.tries + 1, sent: false });
          }
          // The account's trouble: the same name once it can be used (its card, if any, looked for then).
          throw error;
        }
        sent.seconds += to - from;
        if (spent.credits !== null) {
          sent.credits += spent.credits;
          sent.creditsSaid = true;
        }
        cached = await shelfOf(app).keep(file.source, out, from, to, provider.id, file.mode);
        listings.delete(file.source);
        // Only now, its result kept, is it no longer out (a stop before this picks its card up again).
        setOutstanding(app.store.home, outKey, null);
      }
      const cleaned = await shelfOf(app).bring(file.source, cached);
      const info = await probe(original);
      // The camera's text, and what the lesson keeps out of reach (only the subtitles' band when that's all it takes out).
      const keep = [...(await stamps.get(file.media.id)!), ...keptFor(lesson === null ? null : removal.only(lesson, file.kinds), burned.of(file.media)?.band ?? null)];
      const out = join(app.store.cacheDir(), "cleaned", `${id}-${file.media.id}-${Math.round(cached.from * 1000)}-${Math.round(cached.to * 1000)}.${cached.provider}${cached.mode === "smart" ? ".smart" : ""}.strip.mp4`);
      const made = await makeStrip(original, cleaned, { width: info.width, height: info.height, fps: info.fps }, keep, out);
      // The automatic look: their words read again in what Vmake gave back (never their see-through watermark's: the engine's, Vmake leaves it).
      const marked = [...(await markBoxesOf(app, file.source)), ...(lesson?.examples ?? []).filter((one) => one.kind === "watermarks" && one.box !== undefined).map((one) => one.box!)];
      const still = await stillShows(original, cleaned, [info.width, info.height], info.duration, [...keep, ...marked]).catch(() => null);
      fs.rmSync(original, { force: true });
      if (made === null) {
        piece = notePiece(id, { ...piece, state: still === null ? "done" : "failed", ...(still !== null ? { why: still } : {}) });
        diag.info("removal", `${label}: nothing was taken out`);
        return;
      }
      // Its examples of this footage, as a check: what it says to take out lies in what was.
      for (const example of lesson?.examples ?? []) {
        if (example.action !== "remove" || example.box === undefined || example.from?.source !== file.source || example.from.at < from || example.from.at > to) continue;
        if (overlapShare(example.box, made.box) < 0.5) diag.warn("removal", `${label}: the lesson's example "${example.text ?? example.kind}" isn't in what was taken out (box ${made.box.join(" ")})`);
      }
      // Laid as what it is: a Smart Pro result serving a Smart piece is Smart Pro's strip.
      const strip = await place(app, id, file.media, { from: cached.from, to: Math.min(cached.to, cached.from + info.duration) }, made.box, out, cached.mode);
      piece = notePiece(id, { ...piece, state: "check", ...(strip !== null ? { strip } : {}) });
      if (still !== null) await reject(app, id, key, still);
    } catch (error) {
      if (error instanceof VmakeError && error.scope === "account") {
        run.account = error.reason;
        block(app.store.home, provider.id, error);
        run.stop.abort();
        notePiece(id, { ...piece, state: "held" });
        return;
      }
      const why = diag.messageOf(error);
      diag.warn("removal", `${id}: ${label} wasn't cleaned: ${why}`);
      // Sent once more, else given up on (blurred, said).
      await reject(app, id, key, why).catch((failed: unknown) => diag.warn("removal", `${id}: ${label}: ${diag.messageOf(failed)}`));
    } finally {
      for (const name of fs.readdirSync(dir).filter((one) => one.startsWith(`${id}-${file.media.id}-${Math.round(from * 1000)}.`))) fs.rmSync(join(dir, name), { force: true });
      run.done += 1;
    }
  };
  void (async () => {
    const started = Date.now();
    const pool = (queue: typeof jobs) =>
      Promise.all(
        Array.from({ length: Math.min(provider.atOnce?.() ?? PARALLEL, queue.length) }, async () => {
          for (let job = queue.shift(); job !== undefined; job = queue.shift()) await work(job);
        }),
      );
    // Kept pieces first (free); then one piece sent alone until Vmake has taken it (so an account that can't be used is
    // told once, never three times at once), then the rest, PARALLEL at once (Nov 17, Sphe's M4: the first piece was
    // waited on to its end, ~7 min, before any other went).
    await pool(jobs.filter((job) => job.cached !== null));
    const paid = jobs.filter((job) => job.cached === null);
    if (paid.length > 0) {
      const rest = paid.slice(1);
      const drain = async () => {
        for (let job = rest.shift(); job !== undefined; job = rest.shift()) await work(job);
      };
      let begun = () => {};
      const taken = new Promise<void>((resolve) => (begun = resolve));
      const alone = work(paid[0]!, begun);
      await Promise.race([alone, taken]);
      // The first piece's worker carries on with the rest once it's done.
      const first = alone.then(drain);
      await Promise.all([first, ...Array.from({ length: Math.min((provider.atOnce?.() ?? PARALLEL) - 1, rest.length) }, drain)]);
    }
    const kept = readKept(app.store.home);
    kept.runs.push({
      at: started,
      project: id,
      provider: provider.id,
      seconds: Math.round(sent.seconds * 100) / 100,
      pieces: paid.length,
      failed: piecesOf(id).filter((one) => one.state === "failed").length,
      credits: sent.creditsSaid ? sent.credits : null,
      estimate: provider.id === "vmake-api" ? Math.round(sent.seconds * API_CREDITS_A_SECOND) : null,
    });
    writeKept(app.store.home, kept);
    diag.info("removal", `${id}: ${jobs.length} pieces in ${Math.round((Date.now() - started) / 1000)} s (${sent.seconds.toFixed(1)} s sent${run.account !== null ? `, stopped: ${run.account}` : ""})`);
    // Stopped by the account: what never went is held (not out), until it can be used again.
    if (run.account !== null) for (const one of piecesOf(id)) if (one.state === "queued") notePiece(id, { ...one, state: "held" });
    // What changed meanwhile, and pieces sent again, go now.
    const again = run.again || piecesOf(id).some((one) => one.state === "queued");
    if (again) chaining.add(id);
    run.over = true;
    if (again) await ensure(app, id).catch((error: unknown) => diag.warn("removal", `${id}: ${diag.messageOf(error)}`)).finally(() => chaining.delete(id));
  })();
}

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

/**
 * Puts a strip in the project (clean_strips.ts lays it over the clips on the
 * save), in place of one of the same seconds, and of Smart strips wholly
 * inside a Smart Pro one (their seconds now Smart Pro's: an ask, a re-cut).
 */
async function place(app: App, id: string, footage: Media, range: { from: number; to: number }, box: Box, file: string, mode: web.Mode = "pro"): Promise<string | null> {
  const probed: Probe = await probe(file);
  await playing.whenIdle();
  let made: string | null = null;
  await app.store.update(id, "text removal", (project) => {
    if (!project.media.some((one) => one.id === footage.id)) return;
    const replaced = (one: Media) =>
      one.cleans?.media === footage.id &&
      (one.cleans.what ?? "text") === "text" &&
      ((Math.abs(one.cleans.from - range.from) < 0.01 && Math.abs(one.cleans.to - range.to) < 0.05) || (mode === "pro" && stripMode(one) === "smart" && one.cleans.from >= range.from - 0.01 && one.cleans.to <= range.to + 0.05));
    project.media = project.media.filter((one) => !replaced(one));
    const strip: Media = {
      id: freshId(project, "m"),
      name: `${footage.name} · their text out ${Math.round(range.from)}–${Math.round(range.to)} s${mode === "smart" ? SMART_STRIP : ""}`,
      path: file,
      kind: "video",
      duration: probed.duration,
      width: probed.width,
      height: Math.round(probed.height / 2),
      fps: probed.fps,
      has_audio: false,
      stacked_alpha: true,
      cleans: { media: footage.id, from: range.from, to: range.to, box: box.map((value) => Math.round(value * 1e4) / 1e4) as [number, number, number, number], what: "text" },
    };
    project.media.push(strip);
    made = strip.id;
  });
  app.media.ensure(file, probed, true);
  try {
    if (cloud.enabled()) seams.cloudMedia.backfillSoon(app, id);
  } catch (error) {
    diag.warn("cloud", `backfill ${id}: ${diag.messageOf(error)}`);
  }
  return made;
}

export function routes(router: Router<App>): void {
  router.post("/api/projects/{id}/text-removal", async (context) => {
    const body = (await readJson(context).catch(() => ({}))) as { retry?: unknown };
    return json(await begin(context.app, context.params.id ?? "", body.retry === true));
  });
  // An admin's sign-in of the team's Vmake account: the live view of a browser on the team's profile.
  router.post("/api/text-removal/sign-in", async ({ app }) => json({ open: await signIn(app) }));
  // This Mac's Vmake API keys (kept in its Keychain once Vmake takes them; never sent back).
  router.post("/api/text-removal/keys", async (context) => {
    const { app } = context;
    const body = (await readJson(context)) as { ak?: unknown; sk?: unknown };
    if (typeof body.ak !== "string" || typeof body.sk !== "string") throw new ApiError(400, "ak and sk");
    try {
      await keepKeys(app, { ak: body.ak, sk: body.sk });
    } catch (error) {
      throw new ApiError(400, error instanceof VmakeError ? accountLine(error.reason ?? "keys_refused") : diag.messageOf(error));
    }
    return json({ kept: true });
  });
}
