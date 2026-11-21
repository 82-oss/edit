// The V2 timeline's pictures and waveforms (Sphe, Nov 21: "having the image
// previews, having the waveforms… like on v1 but have them work reliably this
// time"). Why V1's weren't (docs/v1-to-v2.md, "The timeline in V2"): one sheet
// of at most 120 keyframes per source, made once at import (never for some
// media), so a short clip of a long source showed a neighbour's picture; a
// see-through graphic's sheet showed its picture and its mask squashed together;
// a graphic rendered again kept its old sheet; and a sound played from the
// cloud's library never got a waveform here (32 of one project's 181 sound
// clips, all its music).
//
// Here a picture is asked for by moment: `GET …/media/{media}/frames?t=1.25,3.5&h=72`
// answers the frames of that media at those seconds of it (the page snaps them
// to a grid, so neighbouring zooms ask for the same ones), each the frame FFmpeg
// decodes at that time, from wherever the media is read on this computer: its
// preview here, its whole cloud copy here, the original, or the cloud's stream
// through this server (marked as a background read, so it never hurries a whole
// copy ahead of footage someone plays). A see-through render's picture is its top
// half, and a graphic's frames are kept by its render (`effect_key`), so a new
// render brings new pictures. Each is kept on disk under `<cache>/timeline/<key>/
// <h>/<ms>.jpg`, the key the media's content (its cloud source, else the
// engine's media key of its file), so reopening costs nothing and every project
// using the file shares them. A waveform is made when it's first asked for
// (`peaksHere`), wherever the sound is read from, and kept where import keeps one.
//
// The work is off the server's thread (FFmpeg spawned and awaited, the engine's
// peaks on its pool), a few at a time, below a play (`playing.belowCommand`,
// `keepBelow`, as the effects' Chromes are), and a read over the line waits
// while someone waits on a project's footage (`playing.linkHeld`).

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";

import type { App } from "./app.ts";
import { playbackKey, playbackPath } from "./cloud_playback.ts";
import * as diag from "./diag.ts";
import * as localPreviews from "./local_previews.ts";
import { mediaHooks, mediaKey } from "./media.ts";
import { Semaphore } from "./semaphore.ts";
import type { Media } from "./model.ts";
import { native } from "./native/index.ts";
import { join } from "./paths.ts";
import * as playing from "./playing.ts";
import * as tools from "./tools.ts";

/** Picture heights a page may ask for (px): one for each screen density, so every page shares the same files. */
export const HEIGHTS = [36, 72, 108, 144];
/** Times asked for at once: a clip's visible cells at most. */
export const MOST_TIMES = 32;

/** FFmpeg runs making frames at once: a few, so footage someone plays keeps the CPU (each is one thread a time). */
const AT_ONCE = 2;

export const hooks = {
  /** The times one FFmpeg run decodes (one input each: measured Nov 21 on mandalorian, 8 frames of a 720p H.264 in 0.23 s, 8 runs of one in 0.41 s). */
  perRun: 8,
  /** A run that takes longer than this is ended (a read stuck on the line). */
  runMs: 45_000,
  pollMs: 250,
};

const runs = new Semaphore(AT_ONCE);
const peakRuns = new Semaphore(2);
/** Frames being made, by their file: a second ask for one waits on the first. */
const making = new Map<string, Promise<boolean>>();
const peaksMaking = new Map<string, Promise<string | null>>();

/** What a media's frames are kept under: its render for a graphic, its content for the rest. */
export function frameKey(media: Media): string {
  const name =
    typeof media.effect === "string" && typeof media.effect_key === "string"
      ? `effect:${media.effect}:${media.effect_key}:${media.stacked_alpha === true ? "stacked" : "whole"}`
      : typeof media.cloud?.source === "string" && media.cloud.source !== ""
        ? `cloud:${media.cloud.source}`
        : `file:${mediaKey(media.path)}`;
  return createHash("sha256").update(name).digest("hex").slice(0, 20);
}

/** The folder a media's frames of height `h` are kept in. */
export function frameDir(cache: string, media: Media, h: number): string {
  return join(cache, "timeline", frameKey(media), String(h));
}

/** `t` (seconds) as the whole milliseconds its file is named by. */
const millis = (t: number) => Math.max(0, Math.round(t * 1000));

/** A graphic whose render isn't made yet (its clear still stands in: effects.ts `standIn`): nothing to show of it. */
export function unrendered(media: Media): boolean {
  return typeof media.effect === "string" && typeof media.effect_key !== "string";
}

/** A loopback stream of the cloud's on this server, read as background work (no whole copy hurried ahead for it). */
function streamed(app: App, path: string): string | null {
  const key = playbackKey(path);
  return key === null ? null : `${playbackPath(key, app.port)}&behind=1`;
}

async function fileHere(path: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(path)).isFile();
  } catch {
    return false;
  }
}

/** What a media's pictures are read from here: its preview, its whole cloud copy, its original, or the cloud's stream. */
export async function pictureInput(app: App, media: Media): Promise<string | null> {
  if (unrendered(media)) return null;
  const path = media.path;
  if (media.kind === "video" && typeof media.effect !== "string") {
    const paths = app.media.paths(path);
    if ((await fileHere(paths.proxyDone)) && (await fileHere(paths.proxy))) return paths.proxy;
  }
  if (await fileHere(path)) return path;
  const local = localPreviews.pathOf(app.store.cacheDir(), media);
  if (local !== path && (await fileHere(local))) return local;
  return streamed(app, path) ?? (tools.isUrl(path) ? path : null);
}

/** Waits while someone waits on a project's footage (a read over the line would take the line from it); false when `signal` ended first. */
async function lineFree(signal: AbortSignal | undefined): Promise<boolean> {
  while (playing.linkHeld()) {
    if (signal?.aborted === true) return false;
    await new Promise((resolve) => setTimeout(resolve, hooks.pollMs));
  }
  return signal?.aborted !== true;
}

/**
 * One FFmpeg run: each of `times` of `input` decoded where it is (one input per time, each seeking exactly) into
 * its own JPEG at `outs`, written beside it first and moved into place. True when it ended well (some may be missing
 * still: a time past a file's real end gives nothing).
 */
async function run(input: string, times: number[], outs: string[], h: number, media: Media): Promise<boolean> {
  const image = media.kind === "image";
  const crop = media.stacked_alpha === true ? "crop=iw:ih/2:0:0," : "";
  const partial = outs.map((out) => `${out}.partial-${randomBytes(4).toString("hex")}.jpg`);
  const command = [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  for (const t of times) {
    command.push("-threads", "1");
    if (!image) command.push("-ss", t.toFixed(3));
    command.push("-protocol_whitelist", tools.protocols(input), ...tools.urlArgs(input), "-i", input);
  }
  const graph = times.map((_, at) => `[${at}:v]${crop}scale=-2:${h}:flags=bilinear,setsar=1[o${at}]`).join(";");
  command.push("-filter_threads", "1", "-filter_complex", graph);
  times.forEach((_, at) => command.push("-map", `[o${at}]`, "-frames:v", "1", "-q:v", "5", partial[at]!));
  // Below a play, as the effects' Chromes are: niced on Linux, a Mac's background state while one is watched.
  const child = Bun.spawn(playing.belowCommand(command), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const release = playing.keepBelow(child.pid);
  const timer = setTimeout(() => child.kill(), hooks.runMs);
  let ok = false;
  try {
    const said = await new Response(child.stderr).text();
    ok = (await child.exited) === 0;
    if (!ok) diag.warn("timeline", `frames of ${media.name}: ${tools.lastLine(said)}`);
  } finally {
    clearTimeout(timer);
    release();
  }
  await Promise.all(
    partial.map(async (from, at) => {
      try {
        if ((await fs.promises.stat(from)).size > 0) await fs.promises.rename(from, outs[at]!);
        else await fs.promises.rm(from, { force: true });
      } catch {
        // Not made: asked again by the page later.
      }
    }),
  );
  return ok;
}

/** Makes the frames at `times` that aren't kept yet, a run at a time per `hooks.perRun`; resolves once each is made or given up. */
async function make(input: string, media: Media, dir: string, h: number, times: number[], signal: AbortSignal | undefined): Promise<void> {
  const fresh: number[] = [];
  const waits: Promise<boolean>[] = [];
  for (const t of times) {
    const out = join(dir, `${millis(t)}.jpg`);
    const flying = making.get(out);
    if (flying !== undefined) waits.push(flying);
    else if (!(await fileHere(out))) fresh.push(t);
  }
  if (fresh.length > 0) await fs.promises.mkdir(dir, { recursive: true });
  for (let at = 0; at < fresh.length; at += hooks.perRun) {
    const group = fresh.slice(at, at + hooks.perRun);
    const outs = group.map((t) => join(dir, `${millis(t)}.jpg`));
    const stopped = () => signal?.aborted === true;
    const work = (async () => {
      if (tools.isUrl(input) && !(await lineFree(signal))) return false;
      // A page that scrolled away no longer wants these: not started.
      if (stopped()) return false;
      const ok = await runs.with(() => (stopped() ? Promise.resolve(false) : run(input, group, outs, h, media)));
      // A moment at a file's very end can give no frame (its stated length past its last one): half a second before it.
      const made = await Promise.all(outs.map(fileHere));
      const short = group.filter((t, at) => t > 0.25 && !made[at]);
      if (short.length > 0 && !stopped()) {
        await runs.with(() => run(input, short.map((t) => Math.max(0, t - 0.5)), short.map((t) => outs[group.indexOf(t)]!), h, media));
      }
      return ok;
    })();
    const done = work.catch((error: unknown) => {
      diag.warn("timeline", `frames of ${media.name}: ${diag.messageOf(error)}`);
      return false;
    });
    for (const out of outs) making.set(out, done);
    void done.finally(() => {
      for (const out of outs) if (making.get(out) === done) making.delete(out);
    });
    waits.push(done);
  }
  await Promise.all(waits);
}

/** Seconds of `media` within it: at or after its start, before its last frame. */
export function within(media: Media, t: number): number {
  if (media.kind === "image" || !Number.isFinite(t)) return 0;
  const last = media.duration - 1 / Math.max(1, media.fps || 30);
  return Math.max(0, Math.min(t, Math.max(0, last)));
}

/** The frames of `media` at `times` (seconds of it), each its JPEG or null when it couldn't be made now (the page asks again). */
export async function framesOf(app: App, media: Media, times: number[], h: number, signal?: AbortSignal): Promise<(Uint8Array | null)[]> {
  const input = await pictureInput(app, media);
  if (input === null) return times.map(() => null);
  const dir = frameDir(app.store.cacheDir(), media, h);
  const clamped = times.map((t) => millis(within(media, t)) / 1000);
  await make(input, media, dir, h, [...new Set(clamped)], signal);
  return Promise.all(
    clamped.map(async (t) => {
      try {
        return new Uint8Array(await fs.promises.readFile(join(dir, `${millis(t)}.jpg`)));
      } catch {
        return null;
      }
    }),
  );
}

/**
 * The frames as one body: their count (u32, little-endian), each one's length (u32; 0 for one not made), then the
 * JPEGs in order. One body, not a header: the page reads it from the media host, whose CORS shows no custom header.
 */
export function packFrames(frames: (Uint8Array | null)[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + (frame?.byteLength ?? 0), 0);
  const out = new Uint8Array(4 + frames.length * 4 + total);
  const view = new DataView(out.buffer);
  view.setUint32(0, frames.length, true);
  let at = 4 + frames.length * 4;
  frames.forEach((frame, index) => {
    view.setUint32(4 + index * 4, frame?.byteLength ?? 0, true);
    if (frame !== null) {
      out.set(frame, at);
      at += frame.byteLength;
    }
  });
  return out;
}

/** Reads `?t=` (seconds, comma-separated) and `?h=`: null when they aren't times and a height of the ladder. */
export function parseAsk(query: URLSearchParams): { times: number[]; h: number } | null {
  const h = Number(query.get("h") ?? "72");
  const times = (query.get("t") ?? "").split(",").filter((one) => one !== "").map(Number);
  if (!HEIGHTS.includes(h) || times.length === 0 || times.length > MOST_TIMES || times.some((t) => !Number.isFinite(t) || t < 0)) return null;
  return { times, h };
}

/** What a media's sound is read from for its waveform here: the file analysis reads, its whole copy here, or the cloud's stream. */
async function soundInput(app: App, media: Media): Promise<string | null> {
  const analysed = await mediaHooks.analysisInput?.(media.path).catch(() => null);
  if (typeof analysed === "string" && analysed !== media.path) return analysed;
  if (await fileHere(media.path)) return media.path;
  const local = localPreviews.pathOf(app.store.cacheDir(), media);
  if (local !== media.path && (await fileHere(local))) return local;
  return streamed(app, media.path) ?? (tools.isUrl(media.path) ? media.path : null);
}

/**
 * The waveform of `media` here, made now if it has none (the engine's `makePeaks`, kept where import keeps one, so
 * everything that reads peaks finds it): its path, or null when it has no sound or it couldn't be made now.
 */
export async function peaksHere(app: App, media: Media): Promise<string | null> {
  const out = app.media.paths(media.path).peaks;
  if (await fileHere(out)) return out;
  if (media.kind === "image" || (media.kind === "video" && !media.has_audio)) return null;
  // Being made by its import now: the page asks again in a moment, rather than the sound being read twice.
  if (app.media.busyKey(mediaKey(media.path))) return null;
  const flying = peaksMaking.get(out);
  if (flying !== undefined) return flying;
  const work = peakRuns
    .with(async () => {
      if (await fileHere(out)) return out;
      const input = await soundInput(app, media);
      if (input === null) return null;
      if (tools.isUrl(input) && !(await lineFree(undefined))) return null;
      const dir = out.slice(0, out.lastIndexOf("/"));
      await fs.promises.mkdir(dir, { recursive: true });
      const partial = `${out}.partial-${randomBytes(4).toString("hex")}`;
      try {
        await native().makePeaks(input, partial);
        await fs.promises.rename(partial, out);
        return out;
      } finally {
        await fs.promises.rm(partial, { force: true }).catch(() => {});
      }
    })
    .catch((error: unknown) => {
      diag.warn("timeline", `waveform of ${media.name}: ${diag.messageOf(error)}`);
      return null;
    })
    .finally(() => peaksMaking.delete(out));
  peaksMaking.set(out, work);
  return work;
}
