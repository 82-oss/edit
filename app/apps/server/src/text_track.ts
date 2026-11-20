// Their text found in a stretch of footage, read by read (text_blur.ts's tracks): which words read are theirs, in
// which places, and the reads asked of the engine (`track`). Nothing of Edit's server here: the cloud's CPU machines
// run the same (app/scripts/remover-runpod/cpu.ts, Nov 20), so a track made there is the track made here.

import type { Box, ScreenText } from "./native/index.ts";
import { round } from "./rust.ts";

/** What a track reads by: their subtitles' band and labels, what's never theirs, and which of their text is taken. */
export interface TrackPlan {
  band: Box | null;
  labels: Box[];
  avoid: Box[];
  subtitles: boolean;
  text: boolean;
}

/** Reads a second; and the steps of halving between two that differ. */
export const RATE = 3;
export const HALVINGS = 2;

/** Two reads say the same words when their words share this much. */
const SAME = 0.5;
/** Reads asked of the engine at once, each chunk halved before the next (it gives way to a play between them; the frames a halving may read are held through one chunk). */
export const CHUNK = 15;
/** How far before a file's end its picture is read again when a read past its last frame fails. */
export const END_GRACE_S = 0.25;
/** A subtitle's words change as it's spoken: a line read the same for this long (seconds) is the picture's (a decal, a sign). */
export const STILL = 8;

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

export const area = (box: Box) => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
export const overlap = (a: Box, b: Box) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
export const grow = (box: Box, by: number): Box => [Math.max(0, box[0] - by), Math.max(0, box[1] - by), Math.min(1, box[2] + by), Math.min(1, box[3] + by)];
export const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];


/** Whether a line read is theirs: in their band (or low and centred, for subtitles not found yet) or on a label of theirs; never the camera's or what's kept. */
export function theirs(plan: TrackPlan, line: ScreenText): boolean {
  const box = line.b;
  if (area(box) <= 0 || !/\p{L}|\p{N}/u.test(line.t)) return false;
  if (plan.avoid.some((keep) => overlap(box, keep) > 0.3 * area(box))) return false;
  // A subtitle has words (a read of digits alone in their band is the picture's: a plate, a shirt's number).
  if (plan.subtitles && (line.t.match(/\p{L}/gu) ?? []).length >= 2) {
    if (plan.band !== null ? overlap(box, grow(plan.band, 0.03)) > 0.5 * area(box) : box[1] > 0.38 && Math.abs((box[0] + box[2]) / 2 - 0.5) < 0.25) return true;
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

/** Their lines among those read: `theirs`, words on the same row beside one of them, and multi-line subtitle rows stacked tight against one (never the camera's or what's kept). */
export function theirLines(plan: Parameters<typeof theirs>[0], lines: ScreenText[]): ScreenText[] {
  const mine = lines.filter((line) => theirs(plan, line));
  const isSubtitle = (line: ScreenText) =>
    plan.subtitles &&
    (line.t.match(/\p{L}/gu) ?? []).length >= 2 &&
    (plan.band !== null ? overlap(line.b, grow(plan.band, 0.03)) > 0.5 * area(line.b) : line.b[1] > 0.38 && Math.abs((line.b[0] + line.b[2]) / 2 - 0.5) < 0.25);
  const subtitleLines = new Set(mine.filter(isSubtitle));
  const rest = lines.filter((line) => !mine.includes(line) && area(line.b) > 0 && /\p{L}|\p{N}/u.test(line.t) && !plan.avoid.some((keep) => overlap(line.b, keep) > 0.3 * area(line.b)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const line of [...rest]) {
      const side = mine.some((one) => besides(one.b, line.b));
      const over = plan.subtitles && (line.t.match(/\p{L}/gu) ?? []).length >= 2 && [...subtitleLines].some((one) => stacked(one.b, line.b));
      if (!side && !over) continue;
      mine.push(line);
      if (over || [...subtitleLines].some((one) => besides(one.b, line.b))) subtitleLines.add(line);
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
export function partsOf(plan: Pick<TrackPlan, "labels">, mine: ScreenText[]): Part[] {
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
export async function track(plan: TrackPlan, from: number, to: number, read: (times: number[], keep: number[]) => Promise<ScreenText[][]>, idle: () => Promise<unknown> = async () => {}): Promise<Sample[]> {
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
    let lines: ScreenText[][];
    try {
      lines = await read(at, keep);
    } catch (error) {
      // A moment past the picture's last frame (a file whose sound runs a little longer: Nov 20, SMART Cops'
      // IYerNFnlSmI, its picture 0.05 s short of its 1,295.37 s, "failed to fill whole buffer" each time and its
      // whole case's blur with it): read where the picture still is, its last quarter second as that frame.
      if (!/fill whole buffer/u.test(String((error as Error)?.message ?? error))) throw error;
      const end = Math.max(from, to - END_GRACE_S);
      lines = await read(
        at.map((t) => Math.min(t, end)),
        keep.map((t) => Math.min(t, end)),
      );
    }
    return at.map((t, j) => sampleOf(plan, t, lines[j] ?? []));
  };
  const out: Sample[] = [];
  for (let i = 0; i < times.length; i += CHUNK) {
    await idle();
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
