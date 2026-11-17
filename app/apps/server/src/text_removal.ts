// What a re-uploader burned into footage taken out of its picture (Sphe, Nov
// 17): their subtitles, their labels ("Actual case footage", "OFFICER 11"),
// their text, so cleanly "you really have to stare deeply in order to notice
// that something is gone", the camera's own stamp kept exactly as it was.
//
// Vmake's Smart Pro does the removing (a provider: its developer API now, its
// website on the team's flat plan once that's mapped). It re-renders the whole
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
// its seconds (`edit/cleaned/…`), so the same footage, in this project or the
// next that reuses the case, is never paid for twice. Each piece becomes a
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
import type { Box, ScreenText } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import { clipEnd, fps as fpsOf, freshId, reusedMedia, trackOf } from "./project.ts";
import * as seams from "./seams.ts";
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
/** Pieces in flight at once. */
const PARALLEL = 2;
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
 * aren't the camera's own text (`camera`).
 */
export function labelSpans(texts: Record<number, ScreenText[]>, seconds: number[], duration: number, camera: Box[]): [number, number][] {
  const read = seconds.filter((second) => Object.hasOwn(texts, second));
  type Group = { words: Set<string>; at: [number, number]; seconds: number[] };
  const groups: Group[] = [];
  for (const second of read) {
    for (const line of texts[second] ?? []) {
      if (!wordy(line.t) || parseClock(line.t) !== null || camera.some((box) => overlapShare(box, line.b) > 0.5)) continue;
      const words = tokens(line.t);
      const at = centre(line.b);
      const same = groups.find((group) => Math.abs(group.at[0] - at[0]) < 0.03 && Math.abs(group.at[1] - at[1]) < 0.03 && alike(group.words, words));
      if (same === undefined) groups.push({ words, at, seconds: [second] });
      else if (!same.seconds.includes(second)) same.seconds.push(second);
    }
  }
  const least = Math.max(3, Math.ceil(read.length / 4));
  const hits = groups.filter((group) => group.seconds.length >= least).flatMap((group) => group.seconds);
  return hits.length === 0 ? [] : runsOf(hits, read, duration);
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
 * `textOf`'s spans is worth cleaning.
 */
export function shownSeconds(project: Project): Map<string, [number, number][]> {
  const fps = fpsOf(project);
  const ours = reusedMedia(project);
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

/** A cleaned piece kept: the file's seconds [from, to) it covers, by which provider, where. */
export interface Cached {
  from: number;
  to: number;
  provider: ProviderId;
  key: string;
}

/**
 * What to clean of one file: `wanted` (source seconds showing their text, on
 * the timeline) with HANDLE each side, less what `cached` covers, in pieces
 * of at most PIECE_SECONDS, each starting on a frame of `fps`; and the cached
 * pieces it uses.
 */
export function piecesFor(wanted: [number, number][], duration: number, fps: number, cached: Cached[]): { send: [number, number][]; use: Cached[] } {
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
  return { send, use };
}

// ---------------------------------------------------------------------------
// The strip

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
 * A step run on this computer before a piece is pasted back (Sphe, Nov 17: a
 * see-through watermark Vmake leaves, "daily dose of crime", may come off by
 * inverse alpha blending): given the original piece and Vmake's, it writes
 * `out` (Vmake's with its own work on top) and the boxes (shares) where its
 * work must show whatever the difference says, or null when it has nothing
 * to do. None yet.
 */
export interface LocalStep {
  name: string;
  run(piece: { original: string; cleaned: string; media: Pick<Media, "id" | "name" | "path">; from: number; to: number }, out: string): Promise<{ boxes: Box[] } | null>;
}
export const localSteps: LocalStep[] = [];

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
export async function cutPiece(input: string, from: number, to: number, out: string, maxBytes = 300_000_000): Promise<void> {
  const seconds = to - from;
  // Under the size cap whatever the footage: the bitrate it leaves, at most 20 Mb/s.
  const rate = Math.min(20_000_000, Math.floor((maxBytes * 0.9 * 8) / Math.max(1, seconds)));
  const partial = `${out}.partial.mp4`;
  await playing.whenIdle();
  await tools.run(
    [
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...tools.urlArgs(input), "-ss", String(from), "-i", input, "-t", String(seconds),
      "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-maxrate", String(rate), "-bufsize", String(rate * 2), "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial,
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
  /** The price of sending `seconds` of footage in `files` pieces, as the line says it. */
  price(seconds: number, files: number): string;
  /** Takes the text out of the piece at `input` into `out`. Throws VmakeError (its `scope` says whose the failure is). */
  remove(input: string, out: string, seconds: number, signal?: AbortSignal, whole?: { key: string }): Promise<{ credits: number | null }>;
  /** Whether the account can be used, nothing spent. Throws VmakeError. */
  check(): Promise<void>;
}

/** What the person reads when the account can't be used. */
export function accountLine(reason: AccountReason, said = ""): string {
  const why: Record<AccountReason, string> = {
    closed: "Vmake says this account is closed",
    signed_out: "Edit's Vmake sign-in has run out",
    lapsed: "the Vmake plan has lapsed",
    out_of_credits: "the Vmake account is out of credits",
    daily_limit: "the day's Vmake allowance is used up; it carries on tomorrow",
    keys_refused: "Vmake refused this Mac's keys",
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
  /** The Browser Use profile holding this Mac's Vmake sign-in. */
  profile?: string;
  /** Files sent to vmake.ai today. */
  day?: web.Day;
  /** Each run: what it sent and what it spent. */
  runs: { at: number; project: string; provider: ProviderId; seconds: number; pieces: number; failed: number; credits: number | null; estimate: number | null }[];
}

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
    price: (seconds) => `≈ $${Math.max(1, Math.round(seconds * API_DOLLARS_A_SECOND))}`,
    remove: (input, out, seconds, signal) => vmake.remove(keys, input, out, { seconds, ...(signal ? { signal } : {}) }),
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

/**
 * vmake.ai's website on the team's plan, in a Browser Use browser signed in
 * once through its live view (vmake_web.ts). Paid by the file (DAILY_FILES a
 * day), plus Browser Use's minutes and bytes.
 */
export function websiteProvider(home: string, browsers: web.Browsers, profile: string, site = web.SITE, put = web.stage): Provider {
  const driver = new web.Driver(browsers, profile, site);
  return {
    id: "vmake-web",
    wholeFiles: true,
    price(seconds, files) {
      const left = filesLeft(home);
      // About 2.5 minutes of browser a minute of footage, three at once; the piece in and out (≈1 MB a second each way).
      const dollars = ((seconds * 2.5) / 3600 / web.TABS) * web.DOLLARS_AN_HOUR + ((seconds * 2) / 1000) * web.DOLLARS_A_GB;
      const browser = dollars < 0.5 ? "under $0.50" : `≈ $${dollars.toFixed(2)}`;
      return `${files} ${files === 1 ? "file" : "files"} on your Vmake plan${files > left ? ` (${Math.max(0, left)} today, the rest tomorrow)` : ""}, ${browser} of cloud browser`;
    },
    async remove(input, out, seconds, _signal, whole) {
      if (filesLeft(home) <= 0) throw new VmakeError("today's files on the Vmake plan are used", "account", "daily_limit");
      const staged = whole !== undefined ? { url: await cloud.presign(whole.key, "GET", 3 * 3600), drop: async () => {} } : await put(input, `${PREFIX}/send/${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`);
      try {
        countFile(home);
        const url = await driver.run(staged.url, `piece-${Math.round(seconds)}s.mp4`);
        await web.fetchResult(url, out);
      } finally {
        await staged.drop();
      }
      return { credits: null };
    },
    async check() {
      const session = await browsers.open(profile);
      try {
        const page = await session.remote.tab();
        if (!(await web.signedIn(page, site))) throw new VmakeError("vmake.ai shows Edit's browser signed out", "account", "signed_out");
      } finally {
        await session.stop();
      }
    },
  };
}

/** Where browsers come from and which site they open (tests put stand-ins here). */
export const website = { browsers: (key: string): web.Browsers => web.browserUse(key), site: web.SITE };

/** The website's provider when this Mac has a Browser Use key and a Vmake profile, else null. */
async function websiteHere(app: App): Promise<Provider | null> {
  const key = await keychain.get(app.store.home, "browser-use").catch(() => null);
  const profile = readKept(app.store.home).profile;
  if (key === null || profile === undefined) return null;
  return websiteProvider(app.store.home, website.browsers(key), profile, website.site);
}

/** The sign-in under way on this Mac: its live view. */
let signing: { url: string; done: Promise<void> } | null = null;

/**
 * Opens a browser on this Mac's Vmake profile for the person to sign in to
 * (its live view's address, which the editor opens), and keeps watching it:
 * signed in, it's stopped (the profile saved then) and the account's
 * sign-in trouble cleared. The profile is made the first time.
 */
export async function signIn(app: App): Promise<string> {
  if (signing !== null) return signing.url;
  const key = await keychain.get(app.store.home, "browser-use").catch(() => null);
  if (key === null) throw new ApiError(409, "Browser Use isn't set up on this Mac.");
  const browsers = website.browsers(key);
  const kept = readKept(app.store.home);
  if (kept.profile === undefined) {
    kept.profile = await browsers.profile(`Edit · ${app.machine}`);
    writeKept(app.store.home, kept);
  }
  const session = await browsers.open(kept.profile);
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
          diag.info("removal", "signed in to vmake.ai");
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
  keep(source: string, file: string, from: number, to: number, provider: ProviderId): Promise<Cached>;
}

const PREFIX = "edit/cleaned";
const folderOf = (source: string) => createHash("sha256").update(source).digest("hex").slice(0, 32);
const nameOf = (from: number, to: number, provider: ProviderId) => `${Math.round(from * 1000)}-${Math.round(to * 1000)}.${provider}.mp4`;

export function parseName(key: string): Omit<Cached, "key"> | null {
  const match = /(\d+)-(\d+)\.(vmake-api|vmake-web)\.mp4$/u.exec(key);
  return match === null ? null : { from: Number(match[1]) / 1000, to: Number(match[2]) / 1000, provider: match[3] as ProviderId };
}

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
    async keep(source, file, from, to, provider) {
      const name = nameOf(from, to, provider);
      const key = `${PREFIX}/${folderOf(source)}/${name}`;
      const here = local(source, name);
      fs.mkdirSync(join(dir, folderOf(source)), { recursive: true });
      if (file !== here) fs.renameSync(file, here);
      if (useCloud()) await cloud.uploadFile(here, key).catch((error: unknown) => diag.warn("removal", `keeping ${name} in the cloud: ${diag.messageOf(error)}`));
      return { from, to, provider, key };
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
async function sourceOf(media: Media): Promise<string> {
  if (media.cloud?.source) return media.cloud.source;
  return `sha256:${await cloudMedia.sha256File(media.path)}`;
}

// ---------------------------------------------------------------------------
// One project's plan and run

/** What a file shows of their text (source seconds), or undefined while it isn't read yet. */
export function textOf(media: Media, camera: Box[]): [number, number][] | undefined {
  const subtitles = burned.of(media);
  if (subtitles === undefined) return undefined;
  const reads = burned.readsOf(media);
  const labels = reads === null ? [] : labelSpans(reads.texts, reads.seconds, media.duration ?? 0, camera);
  return merged([...(subtitles?.spans ?? []), ...labels]);
}

/** The camera's own text in a file, from the words read off it (no new reads; a bar needs its frames: `stampOf`). */
function cameraFromReads(media: Media, bar: Bar | null): Box[] {
  const reads = burned.readsOf(media);
  if (reads === null) return [];
  return cameraText(reads.seconds.map((second) => reads.texts[second] ?? []), bar);
}

/** The file's stamp bar and the camera's text, found once a run (from its original's frames and the reads). */
async function stampOf(app: App, media: Media, input: string): Promise<Box[]> {
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
}

/** Every file of `project` to clean, or the files still being read. */
export async function plan(app: App, project: Project, provider: Provider | null = null): Promise<{ files: FilePlan[]; reading: string[] }> {
  const files: FilePlan[] = [];
  const reading: string[] = [];
  for (const [id, shown] of shownSeconds(project)) {
    const media = project.media.find((one) => one.id === id)!;
    const spans = textOf(media, cameraFromReads(media, null));
    if (spans === undefined) {
      reading.push(media.name);
      void burned.warm(app.media, media);
      continue;
    }
    const wanted = merged(spans.flatMap(([a, b]) => shown.flatMap(([x, y]): [number, number][] => (Math.min(b, y) > Math.max(a, x) ? [[Math.max(a, x), Math.min(b, y)]] : []))));
    if (wanted.length === 0) continue;
    const source = await sourceOf(media);
    const cached = await listed(app, source);
    // Paid by the file: a short one goes whole (one file either way).
    const whole = provider?.wholeFiles === true && (media.duration ?? 0) <= PIECE_SECONDS;
    const { send, use } = piecesFor(whole ? [[HANDLE, Math.max(HANDLE, (media.duration ?? 0) - HANDLE)]] : wanted, media.duration ?? 0, media.fps || fpsOf(project), cached);
    // Pieces already in the project as strips need nothing.
    const have = project.media.filter((one) => one.cleans?.media === media.id);
    const used = use.filter((one) => !have.some((strip) => Math.abs(strip.cleans!.from - one.from) < 0.01 && Math.abs(strip.cleans!.to - one.to) < 0.05));
    if (send.length > 0 || used.length > 0) files.push({ media, source, send, use: used });
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

interface Run {
  provider: ProviderId;
  total: number;
  done: number;
  failed: string[];
  account: AccountReason | null;
  over: boolean;
  stop: AbortController;
}
const runs = new Map<string, Run>();

/** What the editor shows: one line, its one button, and how far a run has got. */
export interface Status {
  line: string | null;
  /** remove: the run; retry: the account looked at again and the run; sign_in: Vmake's sign-in opened (its address answered as `open`). */
  action: "remove" | "retry" | "sign_in" | null;
  running: { done: number; total: number } | null;
}

const minutes = (seconds: number) => (seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`);

function agentBusy(app: App, id: string): boolean {
  try {
    return seams.agentPanel(app).turn?.(id)?.running === true;
  } catch {
    return false;
  }
}

/** The line for project `id` (and a free run started when all it needs is kept already). */
export async function status(app: App, id: string): Promise<Status> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  const run = runs.get(id);
  if (run !== undefined && !run.over) return { line: `Taking their text out: ${run.done} of ${run.total} pieces`, action: null, running: { done: run.done, total: run.total } };
  if (live.project.remove_burned !== true || agentBusy(app, id)) return { line: null, action: null, running: null };
  const provider = await providerHere(app);
  if (provider === null) {
    // A Browser Use key and no sign-in yet: the person signs in once.
    if ((await keychain.get(app.store.home, "browser-use").catch(() => null)) !== null) return { line: "Sign in to Vmake to take their text out.", action: "sign_in", running: null };
    return { line: "Their text stays blurred: Vmake isn't set up on this Mac.", action: null, running: null };
  }
  const stopped = blocked(app.store.home, provider.id);
  if (stopped !== null) return { line: accountLine(stopped.reason, stopped.said), action: stopped.reason === "signed_out" && provider.id === "vmake-web" ? "sign_in" : "retry", running: null };
  const { files } = await plan(app, live.project, provider);
  const seconds = files.reduce((sum, file) => sum + file.send.reduce((all, [a, b]) => all + b - a, 0), 0);
  const pieces = files.reduce((sum, file) => sum + file.send.length, 0);
  if (pieces === 0 && files.some((file) => file.use.length > 0)) {
    start(app, id, provider, files);
    return { line: "Taking their text out", action: null, running: { done: 0, total: files.reduce((sum, file) => sum + file.use.length, 0) } };
  }
  if (pieces === 0) return { line: null, action: null, running: null };
  const failed = run?.failed.length ?? 0;
  if (failed > 0) return { line: `Vmake couldn't clean ${failed === 1 ? "one piece" : `${failed} pieces`}; their text stays blurred there.`, action: "retry", running: null };
  return { line: `Take their text out of ${minutes(seconds)} of footage: ${provider.price(seconds, pieces)}`, action: "remove", running: null };
}

/** Starts the run for `id` (the person's button); refused during an agent's turn. */
export async function begin(app: App, id: string, retry = false): Promise<Status> {
  const live = app.store.get(id);
  if (live === null) throw new ApiError(404, "no such project");
  if (agentBusy(app, id)) throw new ApiError(409, "Once the agent's turn is done.");
  const provider = await providerHere(app);
  if (provider === null) throw new ApiError(409, "Vmake isn't set up on this Mac.");
  if (retry && readKept(app.store.home).accounts[provider.id] !== undefined) {
    try {
      await provider.check();
      unblock(app.store.home, provider.id);
    } catch (error) {
      if (error instanceof VmakeError && error.scope === "account") block(app.store.home, provider.id, error);
      else unblock(app.store.home, provider.id);
    }
  }
  if (blocked(app.store.home, provider.id) === null) {
    listings.clear();
    const { files } = await plan(app, live.project, provider);
    if (files.length > 0) start(app, id, provider, files);
  }
  return status(app, id);
}

/** For tests: the run of `id` once it's over. */
export async function settled(id: string): Promise<void> {
  while (runs.get(id)?.over === false) await Bun.sleep(20);
}

function start(app: App, id: string, provider: Provider, files: FilePlan[]): void {
  if (runs.get(id)?.over === false) return;
  const jobs = files.flatMap((file) => [...file.use.map((cached) => ({ file, cached, range: [cached.from, cached.to] as [number, number] })), ...file.send.map((range) => ({ file, cached: null as Cached | null, range }))]);
  const run: Run = { provider: provider.id, total: jobs.length, done: 0, failed: [], account: null, over: false, stop: new AbortController() };
  runs.set(id, run);
  const sent = { seconds: 0, credits: 0, creditsSaid: false };
  const stamps = new Map<string, Promise<Box[]>>();
  const work = async (job: (typeof jobs)[number]) => {
    if (run.stop.signal.aborted) return;
    const { file, range } = job;
    const [from, to] = range;
    const label = `${file.media.name} ${Math.round(from)}–${Math.round(to)} s`;
    const dir = join(app.store.cacheDir(), "cleaned", "work");
    fs.mkdirSync(dir, { recursive: true });
    const stem = join(dir, `${id}-${file.media.id}-${Math.round(from * 1000)}`);
    try {
      const input = await cloudMedia.originalInput(app.store.cacheDir(), file.media);
      if (!stamps.has(file.media.id)) stamps.set(file.media.id, stampOf(app, file.media, input));
      const original = `${stem}.original.mp4`;
      await cutPiece(input, from, to, original);
      let cleaned: string;
      let cached = job.cached;
      if (cached === null) {
        if (blocked(app.store.home, provider.id) !== null) return;
        const out = `${stem}.vmake.mp4`;
        // A whole file already on R2 goes from there (a cloud browser fetches it at a datacenter's speed).
        const key = file.media.cloud?.original;
        const whole = key && from <= 0.05 && to >= (file.media.duration ?? 0) - 0.05 && (file.media.cloud?.size ?? Infinity) <= 300_000_000 ? { key } : undefined;
        const spent = await provider.remove(original, out, to - from, run.stop.signal, whole);
        sent.seconds += to - from;
        if (spent.credits !== null) {
          sent.credits += spent.credits;
          sent.creditsSaid = true;
        }
        cached = await shelfOf(app).keep(file.source, out, from, to, provider.id);
        listings.delete(file.source);
      }
      cleaned = await shelfOf(app).bring(file.source, cached);
      const info = await probe(original);
      let force: Box[] = [];
      for (const step of localSteps) {
        const stepped = `${stem}.${step.name}.mp4`;
        const done = await step.run({ original, cleaned, media: file.media, from, to }, stepped).catch((error: unknown) => {
          diag.warn("removal", `${label}: ${step.name}: ${diag.messageOf(error)}`);
          return null;
        });
        if (done !== null) {
          cleaned = stepped;
          force = [...force, ...done.boxes];
        }
      }
      const keep = await stamps.get(file.media.id)!;
      const out = join(app.store.cacheDir(), "cleaned", `${id}-${file.media.id}-${Math.round(cached.from * 1000)}-${Math.round(cached.to * 1000)}.${cached.provider}.strip.mp4`);
      const made = await makeStrip(original, cleaned, { width: info.width, height: info.height, fps: info.fps }, keep, out, force);
      fs.rmSync(original, { force: true });
      if (made === null) {
        diag.info("removal", `${label}: Vmake took nothing out`);
        return;
      }
      await place(app, id, file.media, { from: cached.from, to: Math.min(cached.to, cached.from + info.duration) }, made.box, out);
    } catch (error) {
      if (error instanceof VmakeError && error.scope === "account") {
        run.account = error.reason;
        block(app.store.home, provider.id, error);
        run.stop.abort();
        return;
      }
      run.failed.push(label);
      diag.warn("removal", `${id}: ${label} wasn't cleaned (it stays blurred): ${diag.messageOf(error)}`);
    } finally {
      for (const name of fs.readdirSync(dir).filter((one) => one.startsWith(`${id}-${file.media.id}-${Math.round(from * 1000)}.`))) fs.rmSync(join(dir, name), { force: true });
      run.done += 1;
    }
  };
  void (async () => {
    const started = Date.now();
    const pool = (queue: typeof jobs) =>
      Promise.all(
        Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
          for (let job = queue.shift(); job !== undefined; job = queue.shift()) await work(job);
        }),
      );
    // Kept pieces first (free); then one piece sent alone, so an account that can't be used is told once, never twice at once.
    await pool(jobs.filter((job) => job.cached !== null));
    const paid = jobs.filter((job) => job.cached === null);
    if (paid.length > 0) await work(paid[0]!);
    await pool(paid.slice(1));
    const kept = readKept(app.store.home);
    kept.runs.push({
      at: started,
      project: id,
      provider: provider.id,
      seconds: Math.round(sent.seconds * 100) / 100,
      pieces: jobs.filter((job) => job.cached === null).length,
      failed: run.failed.length,
      credits: sent.creditsSaid ? sent.credits : null,
      estimate: provider.id === "vmake-api" ? Math.round(sent.seconds * API_CREDITS_A_SECOND) : null,
    });
    writeKept(app.store.home, kept);
    diag.info("removal", `${id}: ${jobs.length} pieces in ${Math.round((Date.now() - started) / 1000)} s (${sent.seconds.toFixed(1)} s sent, ${run.failed.length} failed${run.account !== null ? `, stopped: ${run.account}` : ""})`);
    run.over = true;
  })();
}

/** Puts a strip in the project (clean_strips.ts lays it over the clips on the save). */
async function place(app: App, id: string, footage: Media, range: { from: number; to: number }, box: Box, file: string): Promise<void> {
  const probed: Probe = await probe(file);
  await playing.whenIdle();
  await app.store.update(id, "text removal", (project) => {
    if (!project.media.some((one) => one.id === footage.id)) return;
    project.media = project.media.filter((one) => !(one.cleans?.media === footage.id && Math.abs(one.cleans.from - range.from) < 0.01 && Math.abs(one.cleans.to - range.to) < 0.05));
    const strip: Media = {
      id: freshId(project, "m"),
      name: `${footage.name} · their text out ${Math.round(range.from)}–${Math.round(range.to)} s`,
      path: file,
      kind: "video",
      duration: probed.duration,
      width: probed.width,
      height: Math.round(probed.height / 2),
      fps: probed.fps,
      has_audio: false,
      stacked_alpha: true,
      cleans: { media: footage.id, from: range.from, to: range.to, box: box.map((value) => Math.round(value * 1e4) / 1e4) as [number, number, number, number] },
    };
    project.media.push(strip);
  });
  app.media.ensure(file, probed, true);
  try {
    if (cloud.enabled()) seams.cloudMedia.backfillSoon(app, id);
  } catch (error) {
    diag.warn("cloud", `backfill ${id}: ${diag.messageOf(error)}`);
  }
}

export function routes(router: Router<App>): void {
  router.get("/api/projects/{id}/text-removal", ({ app, params }) => status(app, params.id ?? "").then((answer) => json(answer)));
  router.post("/api/projects/{id}/text-removal", async (context) => {
    const body = (await readJson(context).catch(() => ({}))) as { retry?: unknown };
    return json(await begin(context.app, context.params.id ?? "", body.retry === true));
  });
  // This Mac's Vmake API keys (kept in its Keychain once Vmake takes them; never sent back).
  // Vmake's sign-in in this Mac's cloud browser profile: the live view to open.
  router.post("/api/text-removal/sign-in", async ({ app }) => json({ open: await signIn(app) }));
  // This Mac's Browser Use key (kept in its Keychain once Browser Use takes it; never sent back).
  router.post("/api/text-removal/browser-use-key", async (context) => {
    const body = (await readJson(context)) as { key?: unknown };
    if (typeof body.key !== "string" || body.key.trim() === "") throw new ApiError(400, "key");
    const answer = await fetch("https://api.browser-use.com/api/v4/profiles", { headers: { "X-Browser-Use-API-Key": body.key.trim() }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (answer === null || answer.status === 401 || answer.status === 403) throw new ApiError(400, "Browser Use refused the key.");
    await keychain.set(context.app.store.home, body.key.trim(), "browser-use");
    return json({ kept: true });
  });
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
