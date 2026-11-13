// Footage heard in one ear only (JJ, Nov 6, on Cops Realize: "we only have
// audio in the left ear… for this entire case, we need to do so we can hear
// the audio in both ears"): the side of a source that carries its sound,
// measured here, so an audio clip's `channel` plays that side in both ears
// (the export's mix and the preview alike). And a source split between them
// (Sphe, Nov 13, a 911 call: "part of the audio appears in one ear and part
// of the audio appears in the other ear"), a voice on each side: both sides
// mixed into both ears (`channel` "both").

import * as tools from "./tools.ts";

export type Side = "left" | "right" | "both";

/** A side this much quieter than the other (dB RMS) isn't heard: the louder one is the sound. */
const QUIETER_DB = 12;
/** Seconds of a source measured at most (from each clip's own stretch). */
const MOST_SECONDS = 600;

/** What a source's sides measured: its live side, or null when both are heard (or it's mono). */
const known = new Map<string, Side | null>();

/** The RMS level (dB) of each channel FFmpeg's astats reported, in order; -inf as -Infinity. */
export function channelLevels(stderr: string): number[] {
  const levels: number[] = [];
  let channel = false;
  for (const line of stderr.split("\n")) {
    if (/\] Channel: \d+/u.test(line)) channel = true;
    else if (/\] Overall/u.test(line)) channel = false;
    const level = /\] RMS level dB: (-?inf|-?[\d.]+)/u.exec(line);
    if (channel && level) {
      levels.push(level[1]!.endsWith("inf") ? -Infinity : Number(level[1]));
      channel = false;
    }
  }
  return levels;
}

/** The side that's heard, from the two sides' levels: null when both are (or neither). */
export function liveSideOf(levels: number[]): Side | null {
  if (levels.length < 2) return null;
  const [left, right] = [levels[0]!, levels[1]!];
  if (left === -Infinity && right === -Infinity) return null;
  if (left - right >= QUIETER_DB) return "left";
  if (right - left >= QUIETER_DB) return "right";
  return null;
}

/** Rate the sound is read at to tell its sides apart: a voice's loudness, not its detail. */
const SPLIT_RATE = 8000;
/** A moment (seconds) its sides are compared over. */
const MOMENT_S = 0.05;
/** A moment quieter than this (dBFS) on both sides is silence, not counted. */
const HEARD_DB = -45;
/** A moment heard this much louder (dB) on one side is that side's. */
const SIDED_DB = 9;
/** Each side its own at least this share of the moments heard: the sound is split between them. */
const SPLIT_SHARE = 0.1;

/**
 * Whether interleaved stereo `samples` is split between its sides: some of
 * its heard moments loud on the left alone and some on the right alone (a
 * call with the dispatcher on one side and the caller on the other).
 */
export function splitOf(samples: Float32Array, rate: number): boolean {
  const size = Math.max(1, Math.round(rate * MOMENT_S));
  const db = (power: number) => 10 * Math.log10(Math.max(power, 1e-12));
  let heard = 0, left = 0, right = 0;
  for (let at = 0; at + size * 2 <= samples.length; at += size * 2) {
    let l = 0, r = 0;
    for (let index = at; index < at + size * 2; index += 2) {
      l += samples[index]! ** 2;
      r += samples[index + 1]! ** 2;
    }
    const [ldb, rdb] = [db(l / size), db(r / size)];
    if (Math.max(ldb, rdb) < HEARD_DB) continue;
    heard++;
    if (ldb - rdb >= SIDED_DB) left++;
    else if (rdb - ldb >= SIDED_DB) right++;
  }
  return heard > 0 && left / heard >= SPLIT_SHARE && right / heard >= SPLIT_SHARE;
}

/** Interleaved stereo of `path` over `spans` at SPLIT_RATE (the first MOST_SECONDS of them). */
async function stereoOf(path: string, spans: [number, number][]): Promise<Float32Array> {
  const remote = tools.isUrl(path) ? ["-protocol_whitelist", tools.protocols(path), ...tools.urlArgs(path)] : [];
  const parts: string[] = [];
  let total = 0;
  for (const [from, seconds] of spans) {
    if (total >= MOST_SECONDS) break;
    const take = Math.min(seconds, MOST_SECONDS - total);
    parts.push(`between(t,${from.toFixed(3)},${(from + take).toFixed(3)})`);
    total += take;
  }
  const keep = parts.length > 0 ? `aselect='${parts.join("+")}',` : "";
  const until = spans.length > 0 ? Math.max(...spans.map(([from, seconds]) => from + seconds)) + 1 : MOST_SECONDS;
  const pcm = await tools.run([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", ...remote, "-t", until.toFixed(3), "-i", path, "-map", "0:a:0", "-vn", "-af", `${keep}aresample=${SPLIT_RATE}`, "-ac", "2", "-f", "f32le", "-"], { timeoutMs: 5 * 60_000 });
  return new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
}

/**
 * The side of `path` that carries its sound over `spans` (source seconds,
 * [from, seconds]; the whole file when empty), "both" when it's split
 * between them (a voice on each), or null when both sides carry it (or it's
 * mono). Measured once a source and stretch.
 */
export async function liveSide(path: string, spans: [number, number][] = []): Promise<Side | null> {
  const key = `${path}|${JSON.stringify(spans)}`;
  if (known.has(key)) return known.get(key)!;
  const remote = tools.isUrl(path) ? ["-protocol_whitelist", tools.protocols(path), ...tools.urlArgs(path)] : [];
  // The stretches the clips play, one after another, up to MOST_SECONDS.
  const parts: string[] = [];
  let total = 0;
  for (const [from, seconds] of spans) {
    if (total >= MOST_SECONDS) break;
    const take = Math.min(seconds, MOST_SECONDS - total);
    parts.push(`between(t,${from.toFixed(3)},${(from + take).toFixed(3)})`);
    total += take;
  }
  const keep = parts.length > 0 ? `aselect='${parts.join("+")}',` : "";
  // Read no further than the last stretch it hears: the whole file was decoded, and a long one streamed from the cloud
  // ran past the five minutes allowed (Nov 6, Cops Realize: five both_ears plans killed, "received signal 15").
  const until = spans.length > 0 ? Math.max(...spans.map(([from, seconds]) => from + seconds)) + 1 : null;
  const child = Bun.spawn(
    [tools.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "info", ...remote, ...(until === null ? [] : ["-t", until.toFixed(3)]), "-i", path, "-map", "0:a:0", "-vn", "-af", `${keep}astats`, "-f", "null", "-"],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 5 * 60_000);
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`couldn't measure the sound's sides: ${stderr.trim().split("\n").at(-1) ?? `ffmpeg exited ${code}`}`);
  const levels = channelLevels(stderr);
  // Heard on both sides: split between them, or the same sound on each (stereo, left as it is).
  const side = liveSideOf(levels) ?? (levels.length >= 2 && levels[0]! > -Infinity && levels[1]! > -Infinity && splitOf(await stereoOf(path, spans), SPLIT_RATE) ? "both" : null);
  known.set(key, side);
  return side;
}
