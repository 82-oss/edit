// Cloud previews read from their whole copy on this Mac (Nov 6, JJ's four
// reviews on Sphe's Mac): their footage was imported on Mathias's, so every
// frame the agent looked at was read in blocks through this server's loopback
// stream from R2, behind the Mac's other cloud traffic. Pictures took 1–3
// minutes a look (a contact sheet 3 min 32 s, a render_frame 3 min 06 s, a
// plan's review frames 3 min 31 s) and ~90% of the turns' tool time; the
// compositing took under half a second. A preview is small (a 7-minute one
// ~26 MB, a whole project's ~0.5–1 GB), so the whole file is fetched once,
// into the copy Edit already serves from (`cloud_media.localPath`), and
// frames read it with the Mac's video decoder.
//
// Fetched when a turn starts on a project (and when the native preview asks),
// a few at a time; until a file is here its frames stream as before. The
// renders take the project with those paths swapped for the files here
// (`localized`), never the saved project: its paths are the cloud's, the same
// on every Mac.

import * as fs from "node:fs";

import * as cloudMedia from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { objectOf } from "./export_excerpts.ts";
import type { Media, Project } from "./model.ts";
import { isFile } from "./paths.ts";
import * as pieces from "./proxy_pieces.ts";
import { FREE_FLOOR_BYTES } from "./storage.ts";

/** Whole previews fetched at once, and how many more may start for ones read now (`hurry`). */
const AT_ONCE = 4;
const HURRIED_AT_ONCE = 2;
const waiting: { key: string; local: string }[] = [];
const fetching = new Set<string>();
/** When a fetch last failed, so it isn't asked again on every frame (again after `RETRY_MS`). */
const failed = new Map<string, number>();
const RETRY_MS = 10 * 60_000;

/** Seams for tests. */
export const hooks = {
  fetch: (key: string, local: string): Promise<void> => cloudMedia.fetchKey(key, local),
  /** Bytes free on the disk holding `dir` (unknown: as good as endless). */
  free: (dir: string): number => {
    try {
      const stat = fs.statfsSync(dir);
      return stat.bavail * stat.bsize;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  },
};

/**
 * About how big `media`'s preview `key` is: footage that's its own proxy is
 * the original, its size known; a made proxy is at most the cloud proxy's
 * bitrate (media.rs `cloud_proxy_bitrate`) and its sound for the duration.
 */
function previewBytes(media: Media, key: string): number {
  const original = media.cloud?.size;
  const known = typeof original === "number" && original > 0 ? original : Number.POSITIVE_INFINITY;
  if (key === media.cloud?.original) return Number.isFinite(known) ? known : 0;
  const made = (Math.max(media.duration, 0) * (pieces.bitrateFor(media.width || 1920, media.height || 1080) + 160_000)) / 8;
  return Math.min(known, made);
}

/** Told each time a whole preview lands here (its key). */
const landedListeners = new Set<(key: string) => void>();

export function onLanded(listener: (key: string) => void): () => void {
  landedListeners.add(listener);
  return () => landedListeners.delete(listener);
}

function fetchNext(): void {
  while (fetching.size < AT_ONCE) {
    const next = waiting.shift();
    if (next === undefined) return;
    start(next);
  }
}

function start(next: { key: string; local: string }): void {
  if (fetching.has(next.local) || isFile(next.local)) return;
  fetching.add(next.local);
  const started = performance.now();
  void hooks
    .fetch(next.key, next.local)
    .then(() => {
      diag.info("preview", `${next.key}: whole preview here in ${diag.human(performance.now() - started)}`);
      for (const listener of landedListeners) listener(next.key);
    })
    .catch((error: unknown) => {
      failed.set(next.local, Date.now());
      diag.warn("preview", `${next.key}: whole preview not fetched: ${diag.messageOf(error)}`);
    })
    .finally(() => {
      fetching.delete(next.local);
      fetchNext();
    });
}

/** Queues `key`'s whole preview into `local`, once. */
export function fetchWhole(key: string, local: string): void {
  if (Date.now() - (failed.get(local) ?? 0) < RETRY_MS || fetching.has(local) || waiting.some((one) => one.local === local) || isFile(local)) return;
  waiting.push({ key, local });
  fetchNext();
}

/** A file the page's player is reading from R2 this moment (a jump past what's here) comes down whole at once, as a jump in the window's does (`hurry`). */
export function fetchNow(key: string, local: string): void {
  if (pieces.baseOf(key) !== null || isFile(local) || fetching.has(local) || Date.now() - (failed.get(local) ?? 0) < RETRY_MS) return;
  if (!waiting.some((one) => one.local === local)) waiting.push({ key, local });
  hurry(key);
}

/**
 * Every picture and sound file `project`'s timeline plays, whole, onto this
 * machine for the page's player, in the order the timeline plays them from
 * frame `from` (what's after the playhead first, then what's before it),
 * ahead of anything already waiting: the page player's one footage form, as
 * Edit.app's window's (native_preview.ts). Until Nov 15 the page read ahead
 * 2 MiB blocks of ten minutes of the timeline and nothing else, so every jump
 * past them waited on R2 (two reads of 0.45–1.1 s from mandalorian, the
 * file's index and the stretch asked) and none landed in a tenth of a second.
 * A pieced proxy is no file (its pieces come instead: `fillPieces`). Asked
 * again from another frame (a jump), the files from there move to the front.
 */
export function fetchInPlayheadOrder(cache: string, project: Project, from: number): number {
  const after: string[] = [];
  const before: string[] = [];
  for (const clip of [...project.clips].sort((a, b) => a.start - b.start)) {
    if (clip.type !== "video" && clip.type !== "audio") continue;
    (clip.start + clip.duration > from ? after : before).push(clip.media);
  }
  const byId = new Map(project.media.map((media) => [media.id, media]));
  const wanted: { key: string; local: string }[] = [];
  const seen = new Set<string>();
  // Never below the cache's floor of free space (storage.ts): a file that would take the disk under it streams on.
  // Until Nov 15 a read-ahead of at most ~600 MB; whole copies of every file need the check.
  let room = hooks.free(cache) - FREE_FLOOR_BYTES;
  let skipped = 0;
  for (const id of [...after, ...before]) {
    const media = byId.get(id);
    const key = media === undefined ? null : cloudMedia.streamKey(media.cloud, "proxy");
    if (media === undefined || key === null || pieces.baseOf(key) !== null || isFile(media.path) || seen.has(key)) continue;
    seen.add(key);
    const local = cloudMedia.localPath(cache, key);
    if (isFile(local) || fetching.has(local) || Date.now() - (failed.get(local) ?? 0) < RETRY_MS) continue;
    const bytes = previewBytes(media, key);
    if (bytes > room) {
      skipped++;
      continue;
    }
    room -= bytes;
    wanted.push({ key, local });
  }
  if (skipped > 0) diag.info("preview", `${project.id}: ${skipped} files of its footage stream on, the disk too full to keep them whole`);
  const first = new Set(wanted.map((one) => one.local));
  const rest = waiting.filter((one) => !first.has(one.local));
  waiting.length = 0;
  waiting.push(...wanted, ...rest);
  fetchNext();
  return wanted.length;
}

/**
 * `key`'s preview is being read now through the stream (a jump in Edit.app's
 * window to footage not here yet): its whole copy, if it's waiting, is fetched
 * next, beside the ones under way. In playhead order a jump elsewhere waited
 * behind the whole queue, each frame streamed meanwhile (0.7–7 s a jump for
 * the first 50 s of a cold Cops Realize, Nov 15).
 */
export function hurry(key: string): void {
  const at = waiting.findIndex((one) => one.key === key);
  if (at < 0) return;
  const [one] = waiting.splice(at, 1);
  if (fetching.size < AT_ONCE + HURRIED_AT_ONCE) start(one!);
  else waiting.unshift(one!);
}

/**
 * A cloud media's preview key, when its whole file can be kept here: a made
 * proxy, or footage that's its own proxy (256 MB at most); not a pieced
 * proxy, which is no file (proxy_pieces.ts).
 */
function previewKey(media: Media): string | null {
  if (media.kind !== "video") return null;
  const key = cloudMedia.streamKey(media.cloud, "proxy");
  return key !== null && pieces.baseOf(key) === null ? key : null;
}

/** Queues every cloud preview `project` reads that isn't here yet. */
export function fetchAll(cache: string, project: Project): void {
  for (const media of project.media) {
    const key = previewKey(media);
    if (key !== null && !isFile(media.path)) fetchWhole(key, cloudMedia.localPath(cache, key));
  }
}

/**
 * `project` with each cloud preview it streams read from its whole file here
 * instead, or null when none is here (the rest are fetched behind it). Only a
 * path that streams that very preview is swapped, so what's drawn is the same.
 */
export function localized(cache: string, project: Project): Project | null {
  let out: Project | null = null;
  project.media.forEach((media, index) => {
    const key = previewKey(media);
    if (key === null || isFile(media.path) || objectOf(media.path) !== `cloud:${key}`) return;
    const local = cloudMedia.localPath(cache, key);
    if (!isFile(local)) {
      fetchWhole(key, local);
      return;
    }
    out ??= { ...project, media: [...project.media] };
    out.media[index] = { ...media, path: local };
  });
  return out;
}

/** The file a media's frames and sound are read from: its whole preview here, else its path. */
export function pathOf(cache: string, media: Media): string {
  const key = previewKey(media);
  if (key === null || isFile(media.path) || objectOf(media.path) !== `cloud:${key}`) return media.path;
  const local = cloudMedia.localPath(cache, key);
  return isFile(local) ? local : media.path;
}

/** For tests. */
export function reset(): void {
  waiting.length = 0;
  fetching.clear();
  failed.clear();
}
