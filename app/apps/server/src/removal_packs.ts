// Stretches of many footage files sent to vmake.ai as one file (Sphe, Nov 19:
// a compilation's intro and first cases draw their B-roll and teasers from
// dozens of files, so two edits made ~95 pieces of a few seconds each, every
// one a whole upload/apply/process round on vmake.ai, about 15 an hour, and a
// file of the plan's 50 a day). Stretches of one mode are packed into files of
// up to the mode's length, back to back (Vmake's fill doesn't bleed across a
// hard cut: nine cuts inside a Smart result of Nov 19, the first frame after
// each as unlike the shot before in their subtitles' band as in the middle of
// the picture), sent once, and the result cut back into each stretch at its
// own size and frame rate, frame for frame, kept as that stretch's own piece
// (`edit/cleaned/…` by file and seconds, as a piece sent alone).
//
// Frames: a stretch of n frames at its rate F takes ceil(n·P/F) frames of the
// pack's rate P (the highest of its members'), frame k first at the pack's
// frame floor(k·P/F) (FFmpeg's fps filter rounding down), held until the next;
// back, its frame k is the pack's frame shown at k/F (the fps filter rounding
// up), which is that one. Sizes: each fitted in the pack's (its largest
// member's) keeping its shape, centred on black, scaled with Lanczos both ways.

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import * as playing from "./playing.ts";
import * as tools from "./tools.ts";
import type { Mode } from "./vmake_web.ts";

/** The longest file each mode takes on vmake.ai: Smart Pro 300 s, Smart 600 s. */
export const MODE_SECONDS: Record<Mode, number> = { pro: 300, smart: 600 };
/** The largest file sent (the API's cap; the website's pieces kept to it too). */
export const PACK_BYTES = 300_000_000;
/** What a stretch may grow by in a pack (its last frame's slots rounded up: a frame of 24 fps). */
const ROUNDING = 0.05;

/**
 * How long a pack of `mode` may be: the mode's limit, and no longer than the
 * byte cap holds at the provider's quality (a longer file would go at a lower
 * rate, softer than the piece alone: Smart's 600 s at the website's 6 Mbit/s
 * is 450 MB, so 360 s).
 */
export function limitOf(mode: Mode, quality?: { rate: number }): number {
  const byBytes = quality === undefined ? Infinity : Math.floor((PACK_BYTES * 0.9 * 8) / quality.rate);
  return Math.min(MODE_SECONDS[mode], byBytes);
}

/**
 * Stretches (of one mode) into packs of at most `limit` seconds: the longest
 * first, each into the first pack it fits, so as few as fit; each pack's
 * members in their `index` order. The same stretches make the same packs.
 */
export function packsOf<T extends { seconds: number; index: number }>(stretches: T[], limit: number): T[][] {
  const bins: { items: T[]; seconds: number }[] = [];
  for (const one of [...stretches].sort((a, b) => b.seconds - a.seconds || a.index - b.index)) {
    const need = one.seconds + ROUNDING;
    const bin = bins.find((open) => open.seconds + need <= limit + 1e-9);
    if (bin === undefined) bins.push({ items: [one], seconds: need });
    else {
      bin.items.push(one);
      bin.seconds += need;
    }
  }
  return bins.map((bin) => bin.items.sort((a, b) => a.index - b.index));
}

/** A pack's id: its mode and its members (their places and tries), so a pack asked for again, after a restart too, is the same file on vmake.ai. */
export function packId(mode: Mode, members: { key: string; tries: number }[]): string {
  return createHash("sha256")
    .update(JSON.stringify([mode, members.map((one) => [one.key, one.tries])]))
    .digest("hex")
    .slice(0, 16);
}

/** A frame rate as FFmpeg gives it (30000/1001). */
export interface Rate {
  num: number;
  den: number;
}

export const rateText = (rate: Rate) => `${rate.num}/${rate.den}`;
const above = (a: Rate, b: Rate) => a.num * b.den > b.num * a.den;

export function parseRate(text: string): Rate | null {
  const [num, den = "1"] = text.trim().split("/");
  const rate = { num: Number(num), den: Number(den) };
  return Number.isInteger(rate.num) && Number.isInteger(rate.den) && rate.num > 0 && rate.den > 0 ? rate : null;
}

/** A stretch as cut: its picture's size and rate, and its frames. */
export interface Cut {
  width: number;
  height: number;
  rate: Rate;
  frames: number;
}

/** Where each stretch sits in a pack: its first frame, its frames there, its own frames, and the box (pixels) it's fitted in. */
export interface Place {
  start: number;
  slots: number;
  frames: number;
  box: [number, number, number, number];
  width: number;
  height: number;
  rate: Rate;
}

export interface Layout {
  width: number;
  height: number;
  rate: Rate;
  places: Place[];
  /** Its length, as sent. */
  seconds: number;
}

/** The pack's frames a stretch of `frames` at `rate` takes at `pack`'s rate: ceil(frames·P/F). */
export function slotsFor(frames: number, rate: Rate, pack: Rate): number {
  const top = frames * pack.num * rate.den;
  const bottom = pack.den * rate.num;
  return Math.max(1, Math.ceil(top / bottom - 1e-9));
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** The pack the cuts make, in their order: its size its largest member's, its rate the highest. */
export function layout(cuts: Cut[]): Layout {
  if (cuts.length === 0) throw new Error("a pack needs a stretch");
  const biggest = cuts.reduce((best, one) => (one.width * one.height > best.width * best.height ? one : best));
  const [width, height] = [even(biggest.width), even(biggest.height)];
  const rate = cuts.reduce((best, one) => (above(one.rate, best) ? one.rate : best), cuts[0]!.rate);
  let start = 0;
  const places = cuts.map((cut): Place => {
    const scale = Math.min(width / cut.width, height / cut.height);
    const [w, h] = [Math.min(width, even(cut.width * scale)), Math.min(height, even(cut.height * scale))];
    const box: Place["box"] = [Math.floor((width - w) / 4) * 2, Math.floor((height - h) / 4) * 2, w, h];
    const slots = slotsFor(cut.frames, cut.rate, rate);
    const place = { start, slots, frames: cut.frames, box, width: cut.width, height: cut.height, rate: cut.rate };
    start += slots;
    return place;
  });
  return { width, height, rate, places, seconds: Math.round(((start * rate.den) / rate.num) * 1000) / 1000 };
}

const SCALE = "flags=lanczos+accurate_rnd+full_chroma_int";

/** A cut's frames timed frame by frame at its rate (k at k/F), as the original, its pack frames and its piece back all are. */
export const timed = (rate: Rate) => `settb=${rate.den}/${rate.num},setpts=N`;

/** The size, rate and frames of a cut (a local file of ours). */
export async function cutOf(file: string): Promise<Cut> {
  const said = new TextDecoder().decode(
    await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,r_frame_rate,nb_read_packets", "-of", "json", file], { background: true }),
  );
  const stream = (JSON.parse(said) as { streams?: { width?: number; height?: number; r_frame_rate?: string; nb_read_packets?: string }[] }).streams?.[0];
  const rate = parseRate(stream?.r_frame_rate ?? "");
  const frames = Number(stream?.nb_read_packets);
  if (stream === undefined || rate === null || !(frames > 0) || !(Number(stream.width) > 0) || !(Number(stream.height) > 0)) throw new Error(`can't read the cut ${file}`);
  return { width: Number(stream.width), height: Number(stream.height), rate, frames };
}

/** The source's frame rate (its r_frame_rate), to time a stretch's frames by before it's cut. */
export async function rateOf(input: string): Promise<Rate> {
  const said = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", ...tools.urlArgs(input), "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", input], { background: true }));
  const rate = parseRate(said.split("\n")[0] ?? "");
  if (rate === null) throw new Error(`no frame rate in ${input}`);
  return rate;
}

/** The encoder's settings for a pack: the provider's quality, its rate kept under the byte cap for the pack's length. */
function encoder(layout: Layout, quality: { crf: number; rate: number }): string[] {
  const rate = Math.min(quality.rate, Math.floor((PACK_BYTES * 0.9 * 8) / Math.max(1, layout.seconds)));
  const gop = String(Math.max(1, Math.round(layout.rate.num / layout.rate.den / 2)));
  return ["-c:v", "libx264", "-preset", "medium", "-crf", String(quality.crf), "-maxrate", String(rate), "-bufsize", String(rate * 2), "-g", gop, "-pix_fmt", "yuv420p"];
}

/** A stretch to pack: where it's read from (the source at full quality), from when, for how long. */
export interface Source {
  input: string;
  from: number;
  seconds: number;
  /** The source's rate (`rateOf`), as its original was timed. */
  rate: Rate;
}

/**
 * The pack's file: each stretch read from its source (the original's frames,
 * one encode only, as a piece sent alone), its frames laid at the pack's rate
 * and fitted in its size, encoded with one encoder's settings and joined
 * without another encode. Checked: as many frames as laid.
 */
export async function build(sources: Source[], plan: Layout, out: string, quality: { crf: number; rate: number }): Promise<void> {
  const parts: string[] = [];
  try {
    for (const [index, source] of sources.entries()) {
      const place = plan.places[index]!;
      const [x, y, w, h] = place.box;
      const part = `${out}.part-${index}.mp4`;
      parts.push(part);
      const filter = [
        `trim=end_frame=${place.frames}`,
        timed(source.rate),
        // Its last frame held on past its end: the fps filter drops a stream's last frame at its end.
        `tpad=stop_mode=clone:stop=8`,
        `fps=fps=${rateText(plan.rate)}:round=down`,
        `trim=end_frame=${place.slots}`,
        `scale=${w}:${h}:${SCALE}`,
        `pad=${plan.width}:${plan.height}:${x}:${y}:black`,
        "setsar=1",
        "format=yuv420p",
      ].join(",");
      await playing.whenIdle();
      await tools.run(
        [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...tools.urlArgs(source.input), "-ss", String(source.from), "-t", String(source.seconds + 1), "-i", source.input, "-map", "0:v:0", "-an", "-vf", filter, "-fps_mode", "passthrough", ...encoder(plan, quality), part],
        { background: true },
      );
    }
    const list = `${out}.list.txt`;
    fs.writeFileSync(list, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n"));
    const partial = `${out}.partial.mp4`;
    await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", partial], { background: true });
    const made = await cutOf(partial);
    const laid = plan.places.reduce((sum, one) => sum + one.slots, 0);
    if (made.frames !== laid) throw new Error(`the pack came out ${made.frames} frames, not ${laid}`);
    fs.renameSync(partial, out);
  } finally {
    for (const part of parts) fs.rmSync(part, { force: true });
    fs.rmSync(`${out}.list.txt`, { force: true });
    fs.rmSync(`${out}.partial.mp4`, { force: true });
  }
}

/** When Vmake's result starts and how long it runs: it's the pack's only when as long (±0.25 s, as `sameFootage`). */
export async function fits(result: string, plan: Layout): Promise<number> {
  const said = new TextDecoder().decode(await tools.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=start_time,duration:format=duration", "-of", "json", result], { background: true }));
  const read = JSON.parse(said) as { streams?: { start_time?: string; duration?: string }[]; format?: { duration?: string } };
  const start = Number(read.streams?.[0]?.start_time ?? 0) || 0;
  const duration = Number(read.streams?.[0]?.duration ?? read.format?.duration);
  if (!(Math.abs(duration - plan.seconds) <= 0.25)) throw new Error(`vmake.ai's result runs ${Number.isFinite(duration) ? duration.toFixed(2) : "?"} s, not the pack's ${plan.seconds.toFixed(2)} s`);
  return start;
}

/**
 * Stretch `index` out of Vmake's result for the pack (`start`: its first
 * frame's time, `fits`): read at the pack's rate (Vmake's own rate, if it
 * changed it, brought back by time), its frames taken back at its own rate
 * frame for frame, out of its box at its own size, at a quality that adds
 * nothing to see.
 */
export async function unpack(result: string, plan: Layout, index: number, out: string, start = 0): Promise<void> {
  const place = plan.places[index]!;
  const [x, y, w, h] = place.box;
  const frame = plan.rate.den / plan.rate.num;
  // Read from a little before (a seek lands on a keyframe), the result's own times kept so its frames sit on the pack's grid.
  const from = place.start * frame;
  const seek = Math.max(0, start + from - 2);
  const filter = [
    `setpts=PTS-${start.toFixed(6)}/TB`,
    `fps=fps=${rateText(plan.rate)}`,
    // By the pack's frame numbers (the fps filter's times are them): a trim by seconds rounds its end down a frame.
    `trim=start_pts=${place.start}:end_pts=${place.start + place.slots}`,
    timed(plan.rate),
    `tpad=stop_mode=clone:stop=8`,
    `fps=fps=${rateText(place.rate)}:round=up`,
    `trim=end_frame=${place.frames}`,
    `crop=${w}:${h}:${x}:${y}`,
    `scale=${place.width}:${place.height}:${SCALE}`,
    "setsar=1",
    timed(place.rate),
    "format=yuv420p",
  ].join(",");
  const partial = `${out}.partial.mp4`;
  await playing.whenIdle();
  await tools.run(
    [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-ss", seek.toFixed(6), "-copyts", "-i", result, "-map", "0:v:0", "-an", "-vf", filter, "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial],
    { background: true },
  );
  const made = await cutOf(partial);
  if (made.frames !== place.frames) {
    fs.rmSync(partial, { force: true });
    throw new Error(`a stretch came back ${made.frames} frames, not ${place.frames}`);
  }
  fs.renameSync(partial, out);
}
