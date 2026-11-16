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
import type { Router } from "./http/router.ts";
import type { Media, Project } from "./model.ts";
import { isFile } from "./paths.ts";
import { duration as projectDuration, fps as projectFps } from "./project.ts";
import * as pieces from "./proxy_pieces.ts";

/** Seconds of the timeline from a jump (or the playhead, as it plays) whose streamed footage is read into blocks at once. */
export const WARM_SECONDS = 20;
/** Of those, the first seconds (what a held play waits for: the page's `HOLD_AHEAD`, and a margin) are read first. */
const FIRST_SECONDS = 4;

type Spans = [number, number][];

/** The clips a play shows or sounds: video on shown tracks, sound on tracks not muted. */
function played(project: Project) {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  return project.clips.filter((clip) => {
    const track = tracks.get(clip.track);
    if (clip.type === "video") return track?.hidden !== true;
    if (clip.type === "audio") return track?.muted !== true;
    return false;
  }) as (Project["clips"][number] & { media: string; source_in: number; speed?: number })[];
}

/** Seconds of `media` that are here to play from: "all", or stretches of it (sorted). */
async function hereOf(cache: string, root: string | null, media: Media): Promise<"all" | Spans> {
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
  // Each run of blocks here, as seconds of the file (its index at the start, the rest laid out evenly): a run's ends
  // are pulled in by half a block's worth, the bytes there being only roughly where those seconds are.
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
function without(spans: Spans, gaps: Spans): Spans {
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
  const fps = projectFps(project);
  const length = projectDuration(project);
  if (length <= 0) return [];
  const media = new Map(project.media.map((one) => [one.id, one]));
  const here = new Map<string, "all" | Spans>();
  const missing: Spans = [];
  for (const clip of played(project)) {
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
      missing.push([clip.start + ((a - from) / speed) * fps, clip.start + ((b - from) / speed) * fps]);
    }
  }
  return without([[0, length]], missing).map(([a, b]) => [Math.ceil(a), Math.floor(b)] as [number, number]).filter(([a, b]) => b > a);
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
  const cache = app.store.cacheDir();
  const fps = projectFps(project);
  const media = new Map(project.media.map((one) => [one.id, one]));
  // The seconds a held play waits for (`FIRST_SECONDS`) of every file first, then the rest.
  const pass = async (from: number, until: number) => {
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
        cloudBlocks.warm(root, key, start / one.duration, end / one.duration, cloudMedia.blockUrl(key)).catch((error: unknown) => {
          diag.warn("cloud", `${id}: reading ${key} ahead of the viewer: ${diag.messageOf(error)}`);
        }),
      );
    }
    await Promise.all(reads);
  };
  await pass(at, at + FIRST_SECONDS * fps);
  await pass(at + FIRST_SECONDS * fps, at + WARM_SECONDS * fps);
}

export function routes(router: Router<App>): void {
  router
    // The timeline's stretches ready to play here (frames): the progress bar's grey, and what a play waits for.
    .get("/api/projects/{id}/playback/ready", async ({ app, params }) => {
      const live = app.store.get(params.id ?? "");
      if (live === null) return json({ ready: [] });
      return json({ ready: await readyStretches(app.store.cacheDir(), live.project) });
    })
    // The viewer is here (an open, a jump, a play): what's next comes first. Answers at once; the reads carry on.
    .post("/api/projects/{id}/playback/warm", async ({ app, params, request }) => {
      const body = (await request.json().catch(() => ({}))) as { frame?: unknown };
      const frame = typeof body.frame === "number" && Number.isFinite(body.frame) ? body.frame : 0;
      void warm(app, params.id ?? "", frame).catch((error: unknown) => diag.warn("cloud", `${params.id}: warming from ${frame}: ${diag.messageOf(error)}`));
      return json({ ok: true });
    });
}
