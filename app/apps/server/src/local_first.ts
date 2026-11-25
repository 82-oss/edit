// Footage local while a project is in work (Sphe, Nov 22; the local-first plan's step 3). A project that takes this
// path (`chosen`, decided once at its first import and kept in the project: `Project.local_media`) has each source as
// ONE plain file on the computer working on it, which every reader reads:
//
// - The original stays here, at its key's place in the cache (`cloud_media.localPath`), noted as a local original
//   (`rememberLocalOriginal`): a YouTube download is kept rather than deleted, a Drive file is downloaded here. Its
//   upload goes behind the import (`uploadLater`), never before its answer, and it's let go only as any original is:
//   the project done or idle a week, and R2 having said it holds it at its size (cache_cleanup.ts `confirmOriginals`).
// - Its working copy, what plays, under a key family of its own (`WORKING_KEYS`): the original itself where its
//   keyframes are close enough to jump in quickly (`ownable`), else one small proxy made here from the original
//   (`WORKING`), a stretch at a time behind the import on the encoder's background tier, and put in the cloud after
//   the original. Until it's made, a stand-in at its place (the original, hard-linked) is what every reader finds,
//   so the footage plays from the import's answer; the made copy replaces it, and Edit.app's window is told to read
//   it (it holds its readers open by path, so it's handed the original's own path meanwhile: native_preview.ts).
// - Another computer, or an older build, opening the project plays it as any cloud project: it fetches the working
//   copy whole once it's up (local_previews.ts `fetchWhole`), with nothing new on the reading side.
//
// No pieced proxy, no joined/ or native2/, no per-excerpt media, no blocks for these sources: a source is one media,
// whole, and the timeline's clips point into it. Every other project keeps today's path, byte for byte.

import * as fs from "node:fs";
import { createHash } from "node:crypto";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import * as encoder from "./encoder.ts";
import { NoRoom } from "./failure.ts";
import { nextFileId, writeAtomic } from "./files.ts";
import * as jobs from "./jobs.ts";
import * as keyframes from "./keyframe_index.ts";
import * as localPreviews from "./local_previews.ts";
import { keyIsThere } from "./media.ts";
import type { Media, Probe, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { isFile, join, parent } from "./paths.ts";
import { Semaphore } from "./semaphore.ts";
import * as storage from "./storage.ts";
import * as tools from "./tools.ts";
import { RELEASE } from "./version.ts";

/**
 * The working copy, in one place (a Mac measuring playback off local files may change these). Measured Nov 18 on an M1
 * (the plan's measure-originals.md): an original whose keyframes are at most about 2 s apart jumps as fast as a proxy
 * (33–54 ms) and plays as it is, up to 1080p at 30 fps; anything else (every YouTube download: keyframes 4–7 s apart,
 * up to 13.5 s) gets one proxy: 720p (smaller sources as they are), a keyframe every second, no B-frames, at most 30 fps,
 * about 1.8 Mbit/s (never more than the original spends: `workingRate`), the sound AAC 128k stereo. It's made `segment_s` of the source at a
 * time, each its own turn on the encoder, so an export or a play takes the encoder at the next stretch and a restart
 * carries on from the stretches made.
 */
export const WORKING = {
  height: 720,
  keyframe_s: 1,
  most_fps: 30,
  bitrate: 1_800_000,
  /** The least a copy's picture is given, whatever its source spends (a source this thin is rare). */
  least_bitrate: 400_000,
  audio: "128k",
  /** An original is its own working copy when its keyframes are this close at most, and its picture this big at most. */
  own_gap_s: 2,
  own_height: 1080,
  own_fps: 30.5,
  /** Above this rate an original is heavy to fetch on another computer and to decode under load: it gets a working copy. */
  own_bitrate: 16_000_000,
  segment_s: 60,
};

/** About what a working copy of `seconds` of footage takes on the disk: its picture and sound at their rates, a quarter over. */
export const workingRoom = (seconds: number): number => Math.ceil((Math.max(seconds, 0) * (WORKING.bitrate + AUDIO_BITS) * 1.25) / 8);
/** The working copy's sound, in bits a second (`WORKING.audio`). */
const AUDIO_BITS = 128_000;

/** Every working copy's key starts so: new, since blocks and whole copies are kept per key and the registry's proxies are shared by every project. */
export const WORKING_KEYS = "edit/proxies/v720/";

/**
 * Who takes the local path for a project's first import (Nov 22: new channel projects, Edit V2). Widening it later is
 * this one line; a project that already has its footage keeps the path it took.
 */
const takesLocalMedia = (project: Project): boolean => !RELEASE && project.hq === true && typeof project.channel === "string" && project.channel !== "";
// Not in a released build yet (Nov 22): none of this has run on a Mac (VideoToolbox making the copy, the window
// switching from the original to it), and nightly-98 went out the same evening. A build from source takes it; take
// `!RELEASE` out once a real import on a Mac has been seen. A project that already chose it keeps it (`chosen`).

/**
 * Whether `project` keeps its footage local while in work (`Project.local_media`), or its footage says so (a build from
 * before the field saved it without it: its working copies' keys still name the path it took).
 */
export function chosen(project: Project): boolean {
  return project.local_media === true || project.media.some((media) => isWorkingKey(media.cloud?.proxy));
}

/**
 * Decides, at a project's first import, whether its footage is local (`takesLocalMedia`), and keeps the answer in the
 * project; a project with footage from before (any cloud video) never changes path. Whether it's local.
 */
export async function settle(app: App, id: string): Promise<boolean> {
  const live = app.store.get(id);
  if (live === null) return false;
  if (chosen(live.project)) {
    if (live.project.local_media !== true) await app.store.update(id, "cloud", (project) => void (project.local_media = true));
    return true;
  }
  if (!takesLocalMedia(live.project) || live.project.media.some((media) => media.kind === "video" && media.cloud != null)) return false;
  const [after] = await app.store.update(id, "cloud", (project) => {
    if (!project.media.some((media) => media.kind === "video" && media.cloud != null)) project.local_media = true;
  });
  return chosen(after.project);
}

/** A source's working copy key (`youtube:<id>` → `edit/proxies/v720/youtube/<id>.mp4`), or null for a source it can't name. */
export function workingKey(source: string): string | null {
  const match = /^(youtube|drive|sha256):([A-Za-z0-9_-]+)$/.exec(source);
  if (match === null) return null;
  const key = `${WORKING_KEYS}${match[1]}/${match[2]}.mp4`;
  return cloud.validKey(key) ? key : null;
}

export const isWorkingKey = (key: string | null | undefined): boolean => typeof key === "string" && key.startsWith(WORKING_KEYS);

/** Whether `path` is a stand-in for `original` (the same file under another name, or a link to it): no working copy made yet. */
export function isStandIn(path: string, original: string): boolean {
  try {
    if (fs.lstatSync(path).isSymbolicLink()) return true;
    const a = fs.statSync(path);
    const b = fs.statSync(original);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** The original's file here for a working copy's media (null when it isn't here): at its key's place, else where it was noted. */
export function originalHere(cache: string, media: Pick<Media, "cloud">): string | null {
  const key = media.cloud?.original;
  if (typeof key !== "string" || !cloud.validKey(key)) return null;
  const at = cloudMedia.localPath(cache, key);
  return isFile(at) ? at : cloudMedia.localOriginal(cache, key);
}

/**
 * What Edit.app's window reads for a working-copy media while the copy isn't made: the original's own path (its
 * readers are kept by path, so the made copy, under the stand-in's name, would never be read). Null otherwise.
 */
export function windowReads(cache: string, media: Pick<Media, "cloud">): string | null {
  const key = media.cloud?.proxy;
  if (!isWorkingKey(key)) return null;
  const original = originalHere(cache, media);
  return original !== null && isStandIn(cloudMedia.localPath(cache, key!), original) ? original : null;
}

/** Puts the original at the working copy's place until the copy is made: a hard link (no bytes), else a symbolic one. */
function standIn(at: string, original: string): void {
  if (isFile(at)) return;
  fs.mkdirSync(parent(at)!, { recursive: true });
  fs.rmSync(at, { force: true });
  try {
    fs.linkSync(original, at);
  } catch {
    fs.symlinkSync(original, at);
  }
}

/** Seconds between `path`'s keyframes at most (to its end too), or null when its index can't say. */
export async function keyframeGap(path: string, duration: number): Promise<number | null> {
  const times = await keyframes.keyframeTimes(path).catch(() => null);
  if (times === null || times.length === 0) return null;
  let most = times[0]!;
  for (let n = 1; n < times.length; n++) most = Math.max(most, times[n]! - times[n - 1]!);
  return Math.max(most, duration - times[times.length - 1]!);
}

/** Whether the original at `path` plays as it is: close keyframes, at most 1080p at 30 fps, and not too heavy. */
export async function ownable(path: string, probe: Probe): Promise<boolean> {
  if (probe.kind !== "video") return true;
  const short = Math.min(probe.width, probe.height);
  if (!(short > 0) || short > WORKING.own_height || probe.fps > WORKING.own_fps) return false;
  let size = 0;
  try {
    size = fs.statSync(path).size;
  } catch {
    return false;
  }
  if (probe.duration > 0 && (size * 8) / probe.duration > WORKING.own_bitrate) return false;
  const gap = await keyframeGap(path, probe.duration);
  return gap !== null && gap <= WORKING.own_gap_s;
}

/** An original on this computer for a local-first project, as the import brought it: where it is, and what it is in the cloud. */
export interface Here {
  source: string;
  /** Its key in R2 (`edit/originals/…`). */
  key: string;
  name: string;
  path: string;
  size: number;
  /** Whether it still has to go up (the registry hasn't it, or couldn't be asked). */
  upload: boolean;
}

/**
 * The media for original `here`: noted as this computer's copy, its upload behind, and its working copy (the original
 * itself, or one made behind the import from it). Answers at once: nothing in it waits on the cloud.
 */
export async function media(home: string, cache: string, here: Here): Promise<cloudMedia.Made> {
  const probe = await native().probe(here.path);
  cloudMedia.rememberLocalOriginal(cache, here.key, here.path);
  storage.ledger.note(here.path);
  const atKey = here.path === cloudMedia.localPath(cache, here.key);
  const own = probe.kind !== "video" || (atKey && (await ownable(here.path, probe)));
  const proxy = own ? here.key : workingKey(here.source);
  if (proxy === null) throw new Error(`${here.name} has no place for its working copy`);
  if (here.upload) {
    cloudMedia.uploadLater(home, { file: here.path, source: here.source, size: here.size, duration: probe.duration, originalKey: here.key, uploadOriginal: true, proxy: null, local: null, name: here.name });
  }
  if (!own) {
    const at = cloudMedia.localPath(cache, proxy);
    standIn(at, here.path);
    if (isStandIn(at, here.path)) void makeBehind(home, cache, { source: here.source, original: here.key, input: here.path, proxy, probe });
  }
  diag.info("cloud", `${here.name}: local, ${own ? "its own working copy" : "its working copy made behind the import"}${here.upload ? ", its upload behind" : ""}`);
  return { path: cloudMedia.previewOf(cache, proxy), name: here.name, probe, cloud: { source: here.source, original: here.key, proxy, size: here.size } };
}

/**
 * A video from this computer's disk for a local-first project: known by its content, as any import (`sha256:<hex>`),
 * without asking the cloud first (Nov 22: `putHashed` waited on the registry, so with the relay down a local file's
 * import never answered). The person's file is only read: linked in at its key's place where the disk allows (so it's
 * its own working copy when its keyframes are close), else read where it is.
 */
export async function importFile(home: string, cache: string, path: string, _probe: Probe, name: string): Promise<cloudMedia.Made> {
  const hex = await cloudMedia.sha256File(path);
  const source = `sha256:${hex}`;
  const key = `edit/originals/sha256/${hex}/${cloudMedia.segment(name)}`;
  const at = cloudMedia.localPath(cache, key);
  let here = path;
  if (path !== at) {
    try {
      if (!isFile(at)) {
        fs.mkdirSync(parent(at)!, { recursive: true });
        fs.linkSync(path, at);
      }
      here = at;
    } catch {
      here = path;
    }
  }
  return media(home, cache, { source, key, name, path: here, size: fs.statSync(here).size, upload: true });
}

// ---------------------------------------------------------------------------
// Making the working copy behind the import.

interface Making {
  source: string;
  original: string;
  /** The original's file here. */
  input: string;
  proxy: string;
  probe: Probe;
}

/** One working copy made at a time (each stretch also takes its turn on the encoder). */
const makingSlot = new Semaphore(1);
const making = new Map<string, Promise<void>>();

/** Hooks for tests: the encode of one stretch and of the sound, and the join. */
export const hooks = {
  run: (command: string[], signal?: AbortSignal): Promise<unknown> => tools.run(command, { background: true, ...(signal === undefined ? {} : { signal }) }),
  /** Told when a working copy replaced its stand-in (native_preview.ts hands the window the new file). */
  landed: (_cache: string, _original: string, _key: string): void => {},
};

/** Where a working copy's stretches are made (kept across a restart, gone once it's made). */
function workDir(cache: string, proxy: string): string {
  return join(cache, "cloud", "making", createHash("sha1").update(proxy).digest("hex").slice(0, 20));
}

/** Its job's row: what's made it, so a restart carries on (`resume`). */
function jobArgs(cache: string, one: Making): Record<string, unknown> {
  return { working: one.proxy, cache, source: one.source, originalKey: one.original, file: one.input, proxy: one.proxy, probe: one.probe };
}

/** Starts (or joins) the making of `one`'s working copy, noted in the job table. */
export function makeBehind(home: string, cache: string, one: Making): Promise<void> {
  const running = making.get(one.proxy);
  if (running !== undefined) return running;
  const key = jobs.begin(home, "upload", "-", jobArgs(cache, one), `${one.source}#working`, "making it quick to scrub");
  const done: Promise<void> = makingSlot
    .with(() => diag.timeOnAsync("cloud", "cloud: working copy", one.source, () => makeNow(home, key, cache, one)))
    .then(
      () => jobs.end(home, key),
      (error: unknown) => {
        if (error instanceof jobs.Gone) {
          diag.warn("cloud", `${one.source}: ${diag.messageOf(error)}; its working copy isn't made`);
          fs.rmSync(workDir(cache, one.proxy), { recursive: true, force: true });
          jobs.end(home, key);
          return;
        }
        diag.warn("cloud", `${one.source}: its working copy: ${diag.scrub(diag.messageOf(error))}; tried again by itself`);
        jobs.wait(home, key, error);
      },
    )
    .finally(() => {
      if (making.get(one.proxy) === done) making.delete(one.proxy);
    });
  making.set(one.proxy, done);
  return done;
}

/** A row a restart cut short (cloud_media `resumeUpload`): started again while its original is here. */
export function resume(home: string, args: Record<string, unknown>): void {
  const { working, cache, source, originalKey, file, probe } = args as { working?: unknown; cache?: unknown; source?: unknown; originalKey?: unknown; file?: unknown; probe?: unknown };
  if (typeof working !== "string" || typeof cache !== "string" || typeof source !== "string" || typeof originalKey !== "string" || typeof file !== "string" || typeof probe !== "object" || probe === null) {
    throw new jobs.Gone("not a working copy");
  }
  const at = cloudMedia.localPath(cache, working);
  if (isFile(at) && !isStandIn(at, file)) {
    // Made before the restart; only its upload may be left, which has its own row.
    throw new jobs.Gone(`${working} is made`);
  }
  if (!isFile(file)) throw new jobs.Gone(`${file} is gone`);
  standIn(at, file);
  void makeBehind(home, cache, { source, original: originalKey, input: file, proxy: working, probe: probe as Probe });
}

/** The output's picture size: 720p by its short side, a smaller source as it is, even numbers. */
export function workingSize(width: number, height: number): [number, number] {
  const short = Math.min(width, height);
  const scale = short > WORKING.height ? WORKING.height / short : 1;
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return [even(width), even(height)];
}

/** Its frame rate: the source's, at most `WORKING.most_fps`. */
export const workingFps = (fps: number): number => (fps > 0 ? Math.min(fps, WORKING.most_fps) : WORKING.most_fps);

/**
 * Stretch `n`'s frames of the working copy, [first, end): by the whole file's frame count, so stretches joined are the
 * source's length to the frame (each rounded on its own, a 23.976 fps source drifted 0.44 of a frame a stretch, 2 s
 * over two hours).
 */
export function stretchFrames(probe: Pick<Probe, "duration" | "fps">, n: number): [number, number] {
  const fps = workingFps(probe.fps);
  const all = Math.max(1, Math.round(probe.duration * fps));
  const at = (k: number) => Math.min(all, Math.round(k * WORKING.segment_s * fps));
  return [at(n), n === stretchesOf(probe.duration) - 1 ? all : at(n + 1)];
}

/** FFmpeg's command for stretch `n` (`stretchFrames`) into `out`, picture only. */
export function stretchCommand(input: string, probe: Probe, n: number, out: string, bitrate: number = WORKING.bitrate): string[] {
  const fps = workingFps(probe.fps);
  const [width, height] = workingSize(probe.width, probe.height);
  const [first, end] = stretchFrames(probe, n);
  const from = first / fps;
  const frames = Math.max(1, end - first);
  const gop = String(Math.max(1, Math.round(fps * WORKING.keyframe_s)));
  const kbps = Math.round(bitrate / 1000);
  // On a Mac, VideoToolbox (its speed first, as the pieces' encode: proxy_pieces.ts); elsewhere NVENC, else libx264.
  const mac = tools.videoHardware() === "videotoolbox";
  const codec = mac ? ["-c:v", "h264_videotoolbox", "-prio_speed", "1"] : tools.h264();
  return [
    tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "4",
    ...(from > 0 ? ["-ss", from.toFixed(6)] : []),
    "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", `scale=w=${width}:h=${height}:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-fps_mode", "cfr", "-r", String(fps), "-frames:v", String(frames),
    ...codec,
    "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.25)}k`, "-bufsize", `${kbps * 2}k`,
    "-g", gop, "-bf", "0", "-force_key_frames", `expr:gte(t,n_forced*${WORKING.keyframe_s})`,
    "-f", "mp4", out,
  ];
}

/**
 * The working copy's picture rate for an original of `bytes` over `seconds`: `WORKING.bitrate` at most, and never
 * more than the original's own picture spends (Nov 25, the M1 Air's trial: a 90 MB YouTube original made a 168 MB
 * copy, its picture at 1.8 Mbit/s over a source of under 1, and sent up at 2 Mbit/s it took twice the original's
 * 6 minutes). The original's sound is taken off its rate at the copy's own (`WORKING.audio`); `WORKING.least_bitrate`
 * at least, so a copy of a source with a broken length still reads.
 */
export function workingRate(bytes: number, seconds: number): number {
  const source = seconds > 0 && bytes > 0 ? (bytes * 8) / seconds - AUDIO_BITS : WORKING.bitrate;
  return Math.round(Math.max(WORKING.least_bitrate, Math.min(WORKING.bitrate, source)));
}

/** The stretches the source is made in. */
export const stretchesOf = (duration: number): number => Math.max(1, Math.ceil(duration / WORKING.segment_s));

const minutes = (seconds: number): string => `${Math.max(0, Math.round(seconds / 60))}`;

async function makeNow(home: string, key: string, cache: string, one: Making): Promise<void> {
  const at = cloudMedia.localPath(cache, one.proxy);
  if (!isFile(one.input)) throw new jobs.Gone(`${one.input} is gone`);
  if (isFile(at) && !isStandIn(at, one.input)) return upLater(home, cache, one);
  // Made on another computer already: brought down whole rather than made again.
  if (cloud.enabled() && (await headSoon(one.proxy)) !== null) {
    const temp = `${at}.${process.pid}-${nextFileId()}.coming`;
    try {
      await cloud.download(one.proxy, temp);
      fs.renameSync(temp, at);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    replaced(cache, one);
    return;
  }
  const dir = workDir(cache, one.proxy);
  fs.mkdirSync(dir, { recursive: true });
  const total = stretchesOf(one.probe.duration);
  const length = minutes(one.probe.duration);
  const stretch = (n: number) => join(dir, `${n}.mp4`);
  // Never more than the original spends (`workingRate`): one stat, not the media-sized read.
  const rate = workingRate((await fs.promises.stat(one.input)).size, one.probe.duration);
  for (let n = 0; n < total; n++) {
    if (isFile(stretch(n))) continue;
    jobs.step(home, key, `Making it quick to scrub, ${minutes(n * WORKING.segment_s)} of ${length} min`);
    // Room for a stretch at its rate, kept to the floor footage keeps (storage.ts).
    const room = Math.ceil((WORKING.segment_s * WORKING.bitrate * 1.25) / 8);
    if (storage.spare(cache, room, storage.WORK_FLOOR_BYTES) < 0) throw new NoRoom(room, "The disk is too full to make the footage quick to scrub: make room, and Edit goes on by itself.");
    const hold = await encoder.turn("an import's working copy");
    const temp = join(dir, `${n}.part.mp4`);
    try {
      await hooks.run(stretchCommand(one.input, one.probe, n, temp, rate));
      fs.renameSync(temp, stretch(n));
    } finally {
      hold.release();
      fs.rmSync(temp, { force: true });
    }
    jobs.progressed(home, key);
  }
  jobs.step(home, key, `Making it quick to scrub, ${length} of ${length} min`);
  // The stretches joined (their pictures as they are) with the sound, made once from the whole original.
  const list = join(dir, "list.txt");
  writeAtomic(list, Array.from({ length: total }, (_, n) => `file '${stretch(n).replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  const joined = join(dir, "joined.mp4");
  const hold = await encoder.turn("an import's working copy");
  try {
    await hooks.run([
      tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "concat", "-safe", "0", "-i", list,
      ...(one.probe.has_audio ? ["-i", one.input] : []),
      "-map", "0:v:0", ...(one.probe.has_audio ? ["-map", "1:a:0?", "-c:a", "aac", "-b:a", WORKING.audio, "-ac", "2"] : []),
      "-c:v", "copy", "-movflags", "+faststart", "-f", "mp4", joined,
    ]);
  } finally {
    hold.release();
  }
  fs.renameSync(joined, at);
  fs.rmSync(dir, { recursive: true, force: true });
  replaced(cache, one);
  await upLater(home, cache, one);
}

/** How long a look in the cloud is waited on here (the relay down: nothing about playing here waits on the cloud). */
export const CLOUD_WAIT_MS = { value: 15_000 };

/** R2's word on `key`, or null when it has none or doesn't answer within `CLOUD_WAIT_MS`. */
async function headSoon(key: string): Promise<{ size: number } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([cloud.head(key).catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), CLOUD_WAIT_MS.value)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The made copy is in its place: counted, and the window told to read it. */
function replaced(cache: string, one: Making): void {
  const at = cloudMedia.localPath(cache, one.proxy);
  storage.ledger.note(at);
  diag.info("cloud", `${one.source}: its working copy is made (${Math.round(fs.statSync(at).size / 1e6)} MB)`);
  localPreviews.landed(one.proxy);
  hooks.landed(cache, one.input, one.proxy);
}

/** Its upload, behind the original's (the uploads go one at a time, in order: cloud_media `uploadLater`). */
async function upLater(home: string, cache: string, one: Making): Promise<void> {
  if (!cloud.enabled()) return;
  if ((await headSoon(one.proxy)) !== null) {
    keyIsThere(one.proxy);
    return;
  }
  const at = cloudMedia.localPath(cache, one.proxy);
  cloudMedia.uploadLater(home, { file: at, source: one.source, size: fs.statSync(at).size, duration: one.probe.duration, originalKey: one.original, uploadOriginal: false, proxy: one.proxy, local: at });
}

/** For tests: nothing being made. */
export function reset(): void {
  making.clear();
}
