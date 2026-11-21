// What of a cloud project's footage is here to play from, and bringing what's
// next here first: for both players, the page's (a browser, Linux) and
// Edit.app's window, which read the same files (native_preview.ts).
//
// A first open on the M4 (Nov 16, Cops Found 3 Bodies, 275 footage files,
// 7.85 GB in R2) played the story part after a long wait with nothing said,
// and a jump to the B-roll froze 10 s, played 18 s with 199 frames passed
// over and the sound short 735 times, then stopped. Nothing said what was
// here, so nothing could wait for it. Now:
//
// - `warm` (the page asks at an open, at each jump, and every few seconds as it
//   plays): the whole copies come down in the order a person is likely to
//   watch from there (local_previews.ts `fetchInPlayheadOrder`: the next half
//   minute, the edit's start, each part's start, then on), a long video's
//   pieces from there, and the next `WARM_SECONDS` of every streamed file read
//   into blocks at once (cloud_blocks.ts `warm`), seconds where a whole copy
//   takes minutes.
// - `ready`: the stretches of the timeline whose every picture and sound is
//   here (a file here, its whole copy, its pieces, or the blocks under that
//   stretch of it). The player holds a play on a spinner until the stretch
//   ahead is ready, and the progress bar shows it in grey.

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudBlocks from "./cloud_blocks.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { json } from "./http/errors.ts";
import * as mp4 from "./mp4_index.ts";
import type { Router } from "./http/router.ts";
import type { Media, Project } from "./model.ts";
import { isFile } from "./paths.ts";
import { duration as projectDuration, fps as projectFps } from "./project.ts";
import * as playing from "./playing.ts";
import * as pieces from "./proxy_pieces.ts";
import { breather } from "./thread.ts";

/** Seconds of the timeline from a jump (or the playhead, as it plays) whose streamed footage is read into blocks at once. */
export const WARM_SECONDS = 20;
/** Of those, the first seconds (what a held play waits for: the page's `HOLD_AHEAD`, and a margin) are read first. */
const FIRST_SECONDS = 4;

type Spans = [number, number][];

/** The clips a play shows or sounds: video on shown tracks, sound on tracks not muted. */
export function played(project: Project) {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  return project.clips.filter((clip) => {
    const track = tracks.get(clip.track);
    if (clip.type === "video") return track?.hidden !== true;
    if (clip.type === "audio") return track?.muted !== true;
    return false;
  }) as (Project["clips"][number] & { media: string; source_in: number; speed?: number })[];
}

/**
 * The seconds here last worked out from an index, by key, while the same blocks of the same object are here: the page
 * asks every 0.7 s while a play is on or held, every 3 s at rest, the footage dialog every second, and the same blocks
 * give the same seconds. Looked up before the index is (Nov 21): keyed by the index itself, every ask of the longest
 * real edit read all 374 files' indexes again (cloud_blocks.ts keeps 32 MB of them, and its 6 h of footage is more),
 * each a 2 MiB block read and parsed, and scanned every sample of every file: 350 ms and 750 MB read an ask with nothing
 * new, on mandalorian. Kept for more files than any edit has.
 */
const secondsMemo = new Map<string, { signature: string; spans: Spans }>();
const SECONDS_KEPT = 4096;

/** Seconds of `media` that are here to play from: "all", or stretches of it (sorted). */
export async function hereOf(cache: string, root: string | null, media: Media): Promise<"all" | Spans> {
  const key = cloudMedia.streamKey(media.cloud, "proxy");
  if (key === null || isFile(media.path)) return "all";
  if (isFile(cloudMedia.localPath(cache, key))) return "all";
  const base = pieces.baseOf(key);
  if (base !== null) {
    try {
      const context = cloudMedia.piecesHere(cache);
      const layout = await pieces.layoutOf(context, base);
      const out: Spans = [];
      for (let n = 0; n < layout.pieces; n++) {
        if (!pieces.pictureHere(context, base, n)) continue;
        const [first, end] = pieces.framesOf(layout, n);
        const span: [number, number] = [first / layout.fps, end / layout.fps];
        const last = out.at(-1);
        if (last !== undefined && Math.abs(last[1] - span[0]) < 1e-6) last[1] = span[1];
        else out.push(span);
      }
      return out;
    } catch {
      return [];
    }
  }
  const blocks = root === null ? null : cloudBlocks.blocksHere(root, key);
  if (blocks === null || !blocks.here.has(0) || !(media.duration > 0)) return [];
  // The same blocks of the same object (its size) and the same length as last time: the same seconds.
  const signature = `${blocks.size} ${media.duration} ${[...blocks.here].sort((a, b) => a - b).join(",")}`;
  const known = secondsMemo.get(key);
  if (known !== undefined && known.signature === signature) {
    secondsMemo.delete(key);
    secondsMemo.set(key, known);
    return known.spans;
  }
  // From its index (mp4_index.ts): the seconds whose every sample, picture and sound, lies in blocks here, a frame
  // with every frame since its keyframe. Until Nov 17 a run of blocks was taken for an even share of the file's
  // length, and a proxy's bitrate follows its picture: ready said 6.7 s and then 160 s ahead were here on kenobi while
  // the window's decoder waited on blocks that weren't.
  const index = await cloudBlocks.indexHere(root!, key);
  if (index === undefined) return [];
  if (index !== null) {
    const spans = mp4
      .secondsHere(index, (one) => blocks.here.has(one), cloudBlocks.BLOCK)
      .map(([a, b]) => [Math.max(0, a), Math.min(media.duration, b)] as [number, number])
      .filter(([a, b]) => b > a);
    secondsMemo.delete(key);
    secondsMemo.set(key, { signature, spans });
    if (secondsMemo.size > SECONDS_KEPT) secondsMemo.delete(secondsMemo.keys().next().value!);
    return spans;
  }
  // No index to read (not a faststart MP4): each run of blocks here as seconds of the file, laid out evenly, a
  // run's ends pulled in by half a block's worth, the bytes there being only roughly where those seconds are.
  const seconds = (byte: number) => (Math.min(byte, blocks.size) / blocks.size) * media.duration;
  const half = seconds(cloudBlocks.BLOCK / 2);
  const lastBlock = Math.floor((blocks.size - 1) / cloudBlocks.BLOCK);
  const out: Spans = [];
  const sorted = [...blocks.here].sort((a, b) => a - b);
  for (let at = 0; at < sorted.length; ) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    const first = sorted[at]!;
    const last = sorted[end]!;
    const from = first === 0 ? 0 : seconds(first * cloudBlocks.BLOCK) + half;
    const to = last === lastBlock ? media.duration : seconds((last + 1) * cloudBlocks.BLOCK) - half;
    if (to > from) out.push([from, to]);
    at = end + 1;
  }
  return out;
}

/** `spans` (sorted, apart) with every stretch of `gaps` taken out. */
export function without(spans: Spans, gaps: Spans): Spans {
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  const out: Spans = [];
  for (const [start, end] of spans) {
    let at = start;
    for (const [from, to] of sorted) {
      if (to <= at || from >= end) continue;
      if (from > at) out.push([at, from]);
      at = Math.max(at, to);
      if (at >= end) break;
    }
    if (at < end) out.push([at, end]);
  }
  return out;
}

/**
 * The stretches of `project`'s timeline (frames, [start, end)) whose every picture and sound is here to play
 * from on this Mac: the edit's length less each clip's stretch whose footage isn't.
 */
export async function readyStretches(cache: string, project: Project, root = cloudMedia.blocksRoot()): Promise<Spans> {
  const length = projectDuration(project);
  if (length <= 0) return [];
  const missing = (await missingOf(cache, project, root)).map((one) => one.frames);
  return without([[0, length]], missing).map(([a, b]) => [Math.ceil(a), Math.floor(b)] as [number, number]).filter(([a, b]) => b > a);
}

/** A stretch of a played clip whose footage isn't here: the media, its frames on the timeline and its seconds of the file. */
export interface Missing {
  media: Media;
  frames: [number, number];
  seconds: [number, number];
}

/** Every stretch of `project`'s timeline whose footage isn't here to play from (readyStretches' gaps), clip by clip. */
export async function missingOf(cache: string, project: Project, root = cloudMedia.blocksRoot()): Promise<Missing[]> {
  const fps = projectFps(project);
  const media = new Map(project.media.map((one) => [one.id, one]));
  const here = new Map<string, "all" | Spans>();
  const missing: Missing[] = [];
  // A turn for the rest of Edit every few ms: each file's look is a stat, a folder read and its blocks' list, and an
  // `await` on one already known gives nothing else a turn (thread.ts).
  const breathe = breather();
  for (const clip of played(project)) {
    await breathe();
    const one = media.get(clip.media);
    if (one === undefined) continue;
    let has = here.get(one.id);
    if (has === undefined) here.set(one.id, (has = await hereOf(cache, root, one)));
    if (has === "all") continue;
    const speed = clip.speed ?? 1;
    const from = clip.source_in ?? 0;
    const to = from + (clip.duration / fps) * speed;
    // What of the clip's stretch of its file isn't here, onto the timeline.
    for (const [a, b] of without([[from, to]], has)) {
      missing.push({ media: one, frames: [clip.start + ((a - from) / speed) * fps, clip.start + ((b - from) / speed) * fps], seconds: [a, b] });
    }
  }
  return missing;
}

/**
 * The viewer is at `frame` (an open, a jump, a play under way): the footage from there comes first (see the top).
 * Resolves once the blocks asked for are read; the whole copies and pieces carry on behind.
 */
export async function warm(app: App, id: string, frame: number): Promise<void> {
  const live = app.store.get(id);
  const root = cloudMedia.blocksRoot();
  if (live === null || root === null || !cloud.enabled()) return;
  const project = live.project;
  const at = Math.max(0, Math.floor(frame));
  await cloudMedia.prefetchProject(app, id, at);
  // At the disk's floor nothing read ahead would be kept: the page plays from the stream (`keeping`).
  if (!cloudBlocks.keeping(root)) return;
  const cache = app.store.cacheDir();
  const fps = projectFps(project);
  const media = new Map(project.media.map((one) => [one.id, one]));
  // The seconds a held play waits for (`FIRST_SECONDS`) of every file first, then the rest.
  const pass = async (from: number, until: number, priority: "asked" | "ahead") => {
    const reads: Promise<unknown>[] = [];
    const asked = new Set<string>();
    for (const clip of played(project)) {
      if (clip.start >= until || clip.start + clip.duration <= from) continue;
      const one = media.get(clip.media);
      const key = one === undefined ? null : cloudMedia.streamKey(one.cloud, "proxy");
      if (one === undefined || key === null || pieces.baseOf(key) !== null || isFile(one.path) || isFile(cloudMedia.localPath(cache, key)) || !(one.duration > 0)) continue;
      const speed = clip.speed ?? 1;
      const start = (clip.source_in ?? 0) + ((Math.max(from, clip.start) - clip.start) / fps) * speed;
      const end = (clip.source_in ?? 0) + ((Math.min(until, clip.start + clip.duration) - clip.start) / fps) * speed;
      const stretch = `${key} ${Math.floor(start)}`;
      if (asked.has(stretch)) continue;
      asked.add(stretch);
      reads.push(
        cloudBlocks.warm(root, key, start, end, one.duration, cloudMedia.blockUrl(key), priority).catch((error: unknown) => {
          diag.warn("cloud", `${id}: reading ${key} ahead of the viewer: ${diag.messageOf(error)}`);
        }),
      );
    }
    await Promise.all(reads);
  };
  // A held play waits on the first seconds: read as a person's reads are (first, and from R2's own URL too where
  // the edge is slow); the rest behind.
  await pass(at, at + FIRST_SECONDS * fps, "asked");
  await pass(at + FIRST_SECONDS * fps, at + WARM_SECONDS * fps, "ahead");
}

/**
 * Whether blocks and whole copies are kept on this disk now: false at its floor (storage.ts), where none is, so a
 * play waiting for its next seconds to be here would wait for nothing (kenobi, Nov 17: with the disk full every play
 * waited its 30 s). Without playback configured, nothing is read into blocks: kept as before.
 */
export function keeping(root = cloudMedia.blocksRoot()): boolean {
  return root === null || cloudBlocks.keeping(root);
}

export function routes(router: Router<App>): void {
  router
    // The timeline's stretches ready to play here (frames): the progress bar's grey, and what a play waits for; and
    // whether anything read is kept here (`keeping`: false at the disk's floor, where the page plays from the stream).
    .get("/api/projects/{id}/playback/ready", async ({ app, params }) => {
      const live = app.store.get(params.id ?? "");
      if (live === null) return json({ ready: [], keeping: true });
      return json({ ready: await readyStretches(app.store.cacheDir(), live.project), keeping: keeping() });
    })
    // The viewer is here (an open, a jump, a play): what's next comes first. Answers at once; the reads carry on.
    // `playing` (true while a play runs, false at its pause) is what background work gives way to (playing.ts);
    // `holding` (with it) is a play held on its spinner for its footage, which the footage's own fills don't give way to.
    .post("/api/projects/{id}/playback/warm", async ({ app, params, request }) => {
      const body = (await request.json().catch(() => ({}))) as { frame?: unknown; playing?: unknown; holding?: unknown };
      const frame = typeof body.frame === "number" && Number.isFinite(body.frame) ? body.frame : 0;
      if (typeof body.playing === "boolean") playing.note(params.id ?? "", body.playing, body.holding === true);
      void warm(app, params.id ?? "", frame).catch((error: unknown) => diag.warn("cloud", `${params.id}: warming from ${frame}: ${diag.messageOf(error)}`));
      return json({ ok: true });
    });
}
