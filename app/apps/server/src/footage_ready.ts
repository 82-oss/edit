// Getting a project's footage ready on this Mac before it opens (Sphe, Nov 17:
// opening a project whose footage is on someone else's Mac, or only in the
// cloud, must never drop you into stuttering playback without a word).
//
// The editor asks at an open (`GET /api/projects/{id}/footage/ready`). While a play
// from 0:00 wouldn't be smooth yet, the page shows "Getting the footage ready
// for this Mac" over the project and asks every second (`waiting`), and the
// project opens by itself the moment it would be; "Open now" opens it at once
// and the top bar's cloud follows the rest until it's here. Home's line says
// how far it's got while it still comes (`coming`).
//
// "Smooth" is the players' own rule (playback_ready.ts): a play holds on a
// spinner until the seconds ahead are ready (a file here, its whole copy, its
// pieces, or the blocks under that stretch of it). From the stretches not
// ready yet, in the timeline's order, and the speed footage is measured coming
// down at here, a play from the start now is smooth when every one of them can
// come before it's played (`smooth`): each read no more than `RULE.lead_s`
// ahead of the playhead, as a play reads (the page's warm, every few seconds),
// at a share of the speed, a new file's first read costing its round trip,
// and late by no more than the grace a play's start may wait. The first step,
// "The first N minutes of the edit", is the shortest start in whole minutes
// after which the rest would be (`headFor`).
//
// What comes first while the dialog is up: the blocks of those first minutes,
// in the timeline's order, as the reads ahead of a viewer (cloud_blocks.ts
// "ahead": behind only what a person waits on); then whole copies, the first
// minutes' files, the rest of the footage, then the graphics (effects'
// renders), in the fill's lane (local_previews.ts `fetchInPlayheadOrder` with
// `head`). All of it gives way to a play on this Mac and to nothing else. The
// disk's floors hold as everywhere (storage.ts): blocks to the work's floor,
// whole copies to the cache's. When the footage can't all fit it says so, and
// the start comes first.

import type { FootageComing, FootageReady, FootageStep } from "@edit/types/footage_ready";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as cloudBlocks from "./cloud_blocks.ts";
import * as cloudMedia from "./cloud_media.ts";
import * as cloudProjects from "./cloud_projects.ts";
import * as diag from "./diag.ts";
import * as exportAhead from "./export_ahead.ts";
import * as speeds from "./export_speeds.ts";
import { json } from "./http/errors.ts";
import type { Router } from "./http/router.ts";
import * as localPreviews from "./local_previews.ts";
import type { Media, Project } from "./model.ts";
import { isFile } from "./paths.ts";
import * as playbackReady from "./playback_ready.ts";
import * as playing from "./playing.ts";
import { duration as projectDuration, fps as projectFps } from "./project.ts";
import * as pieces from "./proxy_pieces.ts";
import * as storage from "./storage.ts";
import { THIS_MACHINE } from "./machine.ts";
import * as fs from "node:fs";

/**
 * The rule a play from the start is smooth by: the share of the measured speed a play's reads get (the rest is the
 * whole copies, other files' reads, the link's moods), a new file's first read (R2's first byte and its index), how
 * far ahead of the playhead a play reads (playback_ready.ts `WARM_SECONDS`, asked every few seconds), and how late a
 * stretch may be (a play's start waiting that long is no stutter: the dialog isn't shown for it either).
 */
export const RULE = { share: 0.6, latency_s: 0.5, lead_s: 15, grace_s: 2 };

/** A stretch a play from the start needs that isn't here: when it's played (seconds of the timeline), its bytes, and whether it's its file's first read. */
export interface Need {
  at_s: number;
  bytes: number;
  fresh: boolean;
}

/**
 * Whether a play from the start, begun now, gets every stretch in `needs` before it's played, at `bps`: each read in
 * the timeline's order, no sooner than `RULE.lead_s` before it plays, no later than `RULE.grace_s` after.
 */
export function smooth(needs: readonly Need[], bps: number | null): boolean {
  if (needs.length === 0) return true;
  if (bps === null || !(bps > 0)) return false;
  const rate = bps * RULE.share;
  let finish = 0;
  for (const need of [...needs].sort((a, b) => a.at_s - b.at_s)) {
    const begin = Math.max(finish, need.at_s - RULE.lead_s);
    finish = begin + need.bytes / rate + (need.fresh ? RULE.latency_s : 0);
    if (finish > need.at_s + RULE.grace_s) return false;
  }
  return true;
}

/**
 * The first step's seconds: the shortest start in whole minutes (at least one, at most the edit) once whose every
 * stretch is here, a play from the start is smooth (`smooth` of what's after it).
 */
export function headFor(needs: readonly Need[], bps: number | null, length_s: number): number {
  const minutes = Math.max(1, Math.ceil(length_s / 60));
  for (let n = 1; n < minutes; n++) {
    if (smooth(needs.filter((need) => need.at_s >= n * 60), bps)) return n * 60;
  }
  return length_s;
}

/** One file a play of the project reads that comes from the cloud. */
interface FileState {
  media: Media;
  key: string;
  graphic: boolean;
  /** Its bytes (exact once its first block or whole copy is here, else about). */
  size: number;
  done: number;
  here: boolean;
  /** Won't come whole for now (no room, or its fetch failed lately): it streams. */
  stuck: boolean;
}

/** About how big `media`'s file `key` is when nothing here says. */
function guessBytes(media: Media, key: string): number {
  const said = localPreviews.previewBytes(media, key);
  if (said > 0) return said;
  return (Math.max(media.duration, 0) * (pieces.bitrateFor(media.width || 1920, media.height || 1080) + 160_000)) / 8;
}

/** Seams for tests: the clock, where blocks are kept, and the bytes read from the cloud so far (the speed's measure). */
export const hooks = {
  now: () => Date.now(),
  root: () => cloudMedia.blocksRoot(),
  received: () => cloudBlocks.receivedBytes(),
  /** Bringing the first minutes first (the queue's order and their blocks): tests stand in for it. */
  prepare: (app: App, id: string, head: number, now: number): void => prepare(app, id, head, now),
};

/** The files of `project` a play reads from the cloud, with how much of each is here. */
async function filesOf(cache: string, project: Project, root: string | null): Promise<FileState[]> {
  const used = new Set(playbackReady.played(project).map((clip) => clip.media));
  const out: FileState[] = [];
  const seen = new Set<string>();
  for (const media of project.media) {
    if (!used.has(media.id) || (media.kind !== "video" && media.kind !== "audio")) continue;
    const key = cloudMedia.streamKey(media.cloud, "proxy");
    if (key === null || isFile(media.path) || seen.has(key)) continue;
    seen.add(key);
    const graphic = typeof media.effect === "string" && media.effect !== "";
    const pieced = pieces.baseOf(key) !== null;
    const local = cloudMedia.localPath(cache, key);
    if (!pieced && isFile(local)) {
      let size = 0;
      try {
        size = fs.statSync(local).size;
      } catch {
        // Gone between the two looks: counted as here, its size a guess.
        size = guessBytes(media, key);
      }
      out.push({ media, key, graphic, size, done: size, here: true, stuck: false });
      continue;
    }
    const size = (root === null ? null : cloudBlocks.sizeOf(root, key)) ?? guessBytes(media, key);
    if (pieced) {
      const has = await playbackReady.hereOf(cache, root, media);
      const seconds = has === "all" ? media.duration : has.reduce((sum, [a, b]) => sum + (b - a), 0);
      const share = media.duration > 0 ? Math.min(1, seconds / media.duration) : 0;
      const here = has === "all" || share >= 0.999;
      out.push({ media, key, graphic, size, done: here ? size : share * size, here, stuck: !here && storage.spare(cache, 150_000_000, storage.cacheFloor(cache)) < 0 });
      continue;
    }
    const done = root === null ? 0 : Math.min(size, cloudBlocks.bytesHere(root, key));
    out.push({ media, key, graphic, size, done, here: false, stuck: localPreviews.wontCome(local) });
  }
  return out;
}

/** Seconds of the timeline each need covers. */
const NEED_S = 5;

/** The stretches a play from the start needs that aren't here, as `smooth` reads them. */
async function needsOf(cache: string, project: Project, root: string | null, files: FileState[]): Promise<Need[]> {
  const fps = projectFps(project);
  const byKey = new Map(files.map((file) => [file.media.id, file]));
  const missing = await playbackReady.missingOf(cache, project, root);
  const started = new Set<string>();
  const needs: Need[] = [];
  for (const one of [...missing].sort((a, b) => a.frames[0] - b.frames[0])) {
    const file = byKey.get(one.media.id);
    const size = file?.size ?? guessBytes(one.media, cloudMedia.streamKey(one.media.cloud, "proxy") ?? "");
    const perSecond = one.media.duration > 0 ? size / one.media.duration : 0;
    const bytes = Math.max(0, one.seconds[1] - one.seconds[0]) * perSecond;
    // A long stretch is played, and read ahead, a little at a time: one need every `NEED_S` of the timeline.
    const length = Math.max(0, one.frames[1] - one.frames[0]) / fps;
    const count = Math.max(1, Math.ceil(length / NEED_S));
    for (let n = 0; n < count; n++) {
      const fresh = n === 0 && !started.has(one.media.id) && (file === undefined || file.done === 0);
      needs.push({ at_s: one.frames[0] / fps + n * NEED_S, bytes: bytes / count, fresh });
    }
    started.add(one.media.id);
  }
  return needs;
}

/**
 * What's measured coming down, asked for each project: the bytes read from the cloud a moment ago, to tell the speed
 * by. Read off what was downloaded, never the project's bytes here: a file landing all at once that came another way
 * (the backfill registering a graphic rendered here, a whole copy joined from its blocks) read as a burst of
 * speed, and the dialog opened the project on it (kenobi at 8 Mbit/s, Nov 17: 65 MB in 3 s, "8 MB/s", ready, then
 * not ready 15 s later); other downloads sharing the link left it a third of the real speed, its times hours off.
 */
interface Measure {
  samples: [number, number][];
  bps: number | null;
  /** When the speed was last kept in speeds.json, and the bytes then. */
  kept: [number, number] | null;
}
const measures = new Map<string, Measure>();
/**
 * How long the speed is read over: blocks land 2 MiB at a time, several together, so over 8 s a steady half a MB a
 * second read anywhere from 12 kB/s to 1.2 MB/s from one ask to the next, and "about" went from 34 min to 17 h and back
 * (kenobi at 8 Mbit/s, Nov 17).
 */
const WINDOW_MS = 30_000;

function measure(home: string, id: string, bytes: number, now: number): number | null {
  let one = measures.get(id);
  if (one === undefined) measures.set(id, (one = { samples: [], bps: null, kept: null }));
  one.samples.push([now, bytes]);
  while (one.samples.length > 2 && now - one.samples[1]![0] >= WINDOW_MS) one.samples.shift();
  const [at, was] = one.samples[0]!;
  const seconds = (now - at) / 1000;
  // Nothing coming (all here, or nothing can be kept) keeps the last.
  if (seconds >= 1.5 && bytes > was) one.bps = (bytes - was) / seconds;
  one.kept ??= [now, bytes];
  if (now - one.kept[0] >= 15_000) {
    speeds.noteDownload(home, bytes - one.kept[1], (now - one.kept[0]) / 1000);
    one.kept = [now, bytes];
  }
  return one.bps ?? speeds.read(home).download_bps ?? null;
}

/**
 * A wait the dialog shows that isn't moving (honest council, Fable's check 4, Nov 19: JJ's dialog said "about 2 min"
 * for good, all 2.0 GB here, and nothing said so): the same answer for five minutes while someone waits is logged
 * once, with what it says, so the Mac's report carries it (its recurring warnings).
 */
const stills = new Map<string, { signature: string; since: number; said: boolean }>();
export const STILL_FOR_MS = { value: 5 * 60_000 };

/** Whether it said so now (once a wait). */
export function watchStill(id: string, ready: boolean, signature: string, now: number, what: string): boolean {
  if (ready) {
    stills.delete(id);
    return false;
  }
  const known = stills.get(id);
  if (known === undefined || known.signature !== signature) {
    stills.set(id, { signature, since: now, said: false });
    return false;
  }
  if (known.said || now - known.since < STILL_FOR_MS.value) return false;
  known.said = true;
  diag.warn("footage", `${id}: the footage dialog has said the same for ${Math.round((now - known.since) / 60_000)} min while someone waits (${what}): a wait that isn't moving`);
  return true;
}

/** Each project's walk through its first minutes' blocks, while one runs. */
const walking = new Map<string, Promise<void>>();

const GB = (bytes: number) => (bytes / 1e9).toFixed(1);
/** "This Mac", at the start of a sentence. */
const HERE = `${THIS_MACHINE.charAt(0).toUpperCase()}${THIS_MACHINE.slice(1)}`;

/** Where project `id`'s footage stands on this Mac (see the top); `waiting`: its dialog is up, so its first minutes come first. */
export async function readiness(app: App, id: string, waiting: boolean): Promise<FootageReady> {
  const live = app.store.get(id);
  const root = hooks.root();
  const now = hooks.now();
  const project = live?.project;
  const length_s = project === undefined ? 0 : projectDuration(project) / projectFps(project);
  const empty: FootageReady = { ready: true, done: true, made_on: null, head_s: 0, length_s, bytes_done: 0, bytes_total: 0, files_done: 0, files_total: 0, speed_bps: null, ready_in_s: 0, left_s: 0, steps: [], room: null, cant: null };
  if (project === undefined || root === null || !cloud.enabled() || length_s <= 0) {
    playing.releaseLink(id);
    return empty;
  }
  const cache = app.store.cacheDir();
  const files = await filesOf(cache, project, root);
  if (files.length === 0) {
    playing.releaseLink(id);
    return empty;
  }
  const bytes_total = files.reduce((sum, file) => sum + file.size, 0);
  const bytes_done = files.reduce((sum, file) => sum + file.done, 0);
  const bps = measure(app.store.home, id, hooks.received(), now);
  const needs = await needsOf(cache, project, root, files);
  // Kept once there's a speed to work it out by (before, it's the whole edit's needs).
  // Worked out again at each ask: the speed is read over half a minute, so it doesn't flicker, and a slow start that
  // made it "The whole edit" comes down once the link picks up (kenobi, Nov 17: it only grew, and stayed so).
  const head_s = headFor(needs, bps, length_s);
  const fps = projectFps(project);
  // The disk: blocks keep to the work's floor, whole copies to the cache's.
  let room: string | null = null;
  const keeping = cloudBlocks.keeping(root);
  const left = files.filter((file) => !file.here).reduce((sum, file) => sum + (file.size - file.done), 0);
  let spare = storage.spare(cache, 0, storage.cacheFloor(cache)) + storage.claimedBytes();
  // Short of room for it: projects not in work make room first (oldest first, whole: cache_cleanup.ts `makeRoom`), at
  // most every few minutes however often this is asked; what still doesn't fit plays from the cloud, said below.
  if (keeping && left > spare && storage.askForRoom(storage.freeBytes(cache) + left - spare) > 0) spare = storage.spare(cache, 0, storage.cacheFloor(cache)) + storage.claimedBytes();
  if (!keeping) room = "This Mac's disk is too full to keep the footage, so it plays from the cloud.";
  else if (left > spare) room = `Only ${GB(Math.max(0, spare) + bytes_done)} of the ${GB(bytes_total)} GB fits on this Mac. The start of the edit comes first; the rest plays from the cloud.`;

  const headNeeds = needs.filter((need) => need.at_s < head_s);
  const headBytes = headNeeds.reduce((sum, need) => sum + need.bytes, 0);
  const time = (bytes: number) => (bps === null || !(bps > 0) ? null : bytes / bps);
  // Nothing can be kept: nothing to wait for (it streams, as it would).
  const ready = !keeping || smooth(needs, bps);
  const doneOf = (some: FileState[]) => some.every((file) => file.here || file.stuck);
  const footage = files.filter((file) => !file.graphic);
  const graphics = files.filter((file) => file.graphic);
  const restLeft = (some: FileState[]) => some.filter((file) => !file.here && !file.stuck).reduce((sum, file) => sum + (file.size - file.done), 0);
  const steps: FootageStep[] = [{ kind: "start", state: headNeeds.length === 0 || !keeping ? "done" : "waiting", left_s: headNeeds.length === 0 ? 0 : time(headBytes) }];
  // A step whose files can't all come (no room, a fetch failing) is over, but not "ready": what's missing streams.
  const streams = (some: FileState[]) => some.some((file) => !file.here && file.stuck);
  const stepOf = (kind: "rest" | "graphics", some: FileState[]): FootageStep => ({ kind, state: doneOf(some) ? "done" : "waiting", left_s: time(restLeft(some)), ...(doneOf(some) && streams(some) ? { streams: true } : {}) });
  if (footage.length > 0) steps.push(stepOf("rest", footage));
  if (graphics.length > 0) steps.push(stepOf("graphics", graphics));
  const current = steps.find((step) => step.state !== "done");
  if (current !== undefined) current.state = "current";
  const done = doneOf(files);

  // Can't become smooth: what a play from the start needs here before it starts (the link too slow to stream it as it
  // plays) is more than the disk keeps (blocks, to the work's floor). Said, not waited on for ever (kenobi, Nov 17).
  const blockRoom = storage.spare(root, 0, storage.WORK_FLOOR_BYTES);
  let cant: string | null = null;
  if (!ready && keeping && bps !== null && headBytes > blockRoom) {
    const startHere = !needs.some((need) => need.at_s < 60);
    cant = startHere
      ? `${HERE} can't hold all of it and the connection is too slow to stream the rest smoothly. Open now plays the start smoothly; later parts may pause.`
      : `${HERE} can't hold all of it and the connection is too slow to stream it smoothly. Open now plays it as it comes; it may pause.`;
  }

  if (waiting && !ready) hooks.prepare(app, id, Math.round(head_s * fps), now);
  // The link is the person's while they wait on this footage (the dialog, then the top bar's cloud): background work gives way
  // (playing.ts), an export being made ahead stops; Open now (asked without `waiting`), or all of it here, lets go.
  if (waiting && !done) {
    if (!playing.linkHeld()) exportAhead.giveWay(app);
    playing.holdLink(id, HOLD_MS);
  } else playing.releaseLink(id);
  if (waiting) watchStill(id, ready, `${bytes_done} ${files.filter((file) => file.here).length} ${ready ? 0 : Math.round((time(headBytes) ?? -1) / 10)}`, now, `${files.filter((file) => file.here).length} of ${files.length} files, ${GB(bytes_done)} of ${GB(bytes_total)} GB, ${room ?? cant ?? "no room line"}`);
  return {
    ready,
    done,
    made_on: cloudProjects.madeOn(app, id),
    head_s,
    length_s,
    bytes_done,
    bytes_total,
    files_done: files.filter((file) => file.here).length,
    files_total: files.length,
    speed_bps: bps,
    ready_in_s: ready ? 0 : time(headBytes),
    left_s: done ? 0 : time(restLeft(files)),
    steps,
    room: cant === null ? room : null,
    cant,
  };
}

/**
 * How far project `id`'s footage has got coming down to this Mac, for Home's line while it does (Sphe, Nov 18: "when I
 * go back to the project's overview, I should be able to see that the progress is still continuing there"); null when
 * none of it is coming (all here, or what's left can't come for now). Only looks, as Home asks it of every project:
 * no link held, nothing queued or brought first, no speed sample taken (the editor's asks measure it).
 */
export async function coming(app: App, id: string): Promise<FootageComing | null> {
  const root = hooks.root();
  if (root === null || !cloud.enabled()) return null;
  const project = app.store.get(id)?.project;
  if (project === undefined) return null;
  const cache = app.store.cacheDir();
  // Coming means in the queue: a whole copy fetched or waiting its turn, or a long video's pieces filling. A cloud
  // project never opened here isn't (it comes when it opens), and the queue is looked at before any file is.
  const queued =
    cloudMedia.filling(id) ||
    project.media.some((media) => {
      const key = cloudMedia.streamKey(media.cloud, "proxy");
      return key !== null && pieces.baseOf(key) === null && !isFile(media.path) && localPreviews.coming(cloudMedia.localPath(cache, key));
    });
  if (!queued) return null;
  const files = await filesOf(cache, project, root);
  const left = files.filter((file) => !file.here && !file.stuck);
  if (left.length === 0) return null;
  const bps = measures.get(id)?.bps ?? speeds.read(app.store.home).download_bps ?? null;
  const rest = left.reduce((sum, file) => sum + (file.size - file.done), 0);
  return {
    files_done: files.filter((file) => file.here).length,
    files_total: files.length,
    bytes_done: files.reduce((sum, file) => sum + file.done, 0),
    bytes_total: files.reduce((sum, file) => sum + file.size, 0),
    left_s: bps !== null && bps > 0 ? rest / bps : null,
  };
}

/** How long a page's ask holds the link for the person (the top bar's cloud asks every 3 s, the dialog every second). */
const HOLD_MS = 8_000;

/** How long a dialog's ask keeps the first minutes first (it asks every second). */
const PREPARING_MS = 5_000;
/** Seconds of a file each block read of the first minutes covers, and how many go at once. */
const CHUNK_S = 20;
const AT_ONCE = 4;

/**
 * Project `id`'s first `head` frames first: whole copies queued in that order (the first minutes' files, the rest,
 * the graphics), and its first minutes' stretches read into blocks ahead of everything but what a person waits on.
 */
function prepare(app: App, id: string, head: number, now: number): void {
  const was = cloudMedia.preparing.get(id);
  cloudMedia.preparing.set(id, { head, until: now + PREPARING_MS });
  // The queue's order, once at the start and when the first minutes grow.
  if (was === undefined || was.until <= now || was.head !== head) {
    void cloudMedia.prefetchProject(app, id, 0).catch((error: unknown) => diag.warn("cloud", `${id}: queuing its footage to get it ready: ${diag.messageOf(error)}`));
  }
  if (walking.has(id)) return;
  const walk = walkHead(app, id)
    .catch((error: unknown) => diag.warn("cloud", `${id}: reading its first minutes ahead: ${diag.messageOf(error)}`))
    .finally(() => walking.delete(id));
  walking.set(id, walk);
}

/** Reads the first minutes' stretches not here yet into blocks, in the timeline's order, while its dialog is up. */
async function walkHead(app: App, id: string): Promise<void> {
  const root = hooks.root();
  if (root === null) return;
  const started = hooks.now();
  let failures = 0;
  for (;;) {
    const getting = cloudMedia.preparing.get(id);
    const live = app.store.get(id);
    if (getting === undefined || getting.until <= hooks.now() || live === null || !cloudBlocks.keeping(root)) return;
    const project = live.project;
    const fps = projectFps(project);
    const cache = app.store.cacheDir();
    const missing = (await playbackReady.missingOf(cache, project, root))
      .filter((one) => one.frames[0] < getting.head)
      .sort((a, b) => a.frames[0] - b.frames[0]);
    // Each stretch in pieces of a file's seconds, the earliest on the timeline first; a long video's pieces come by their own fill.
    const chunks: { media: Media; key: string; from: number; to: number }[] = [];
    for (const one of missing) {
      const key = cloudMedia.streamKey(one.media.cloud, "proxy");
      if (key === null || pieces.baseOf(key) !== null) continue;
      // Only as far into the file as the first minutes reach.
      const [f0, f1] = one.frames;
      const [s0, s1] = one.seconds;
      const end = f1 <= getting.head || f1 <= f0 ? s1 : s0 + ((getting.head - f0) / (f1 - f0)) * (s1 - s0);
      for (let from = one.seconds[0]; from < end && chunks.length < AT_ONCE; from += CHUNK_S) chunks.push({ media: one.media, key, from, to: Math.min(end, from + CHUNK_S) });
      if (chunks.length >= AT_ONCE) break;
    }
    if (chunks.length === 0) {
      diag.info("cloud", `${id}: its first ${Math.round(getting.head / fps)} s are here to play, in ${diag.human(hooks.now() - started)}`);
      return;
    }
    const read = await Promise.all(
      chunks.map((chunk) =>
        cloudBlocks.warm(root, chunk.key, chunk.from, chunk.to, chunk.media.duration, cloudMedia.blockUrl(chunk.key), "ahead").catch((error: unknown) => {
          diag.warn("cloud", `${id}: reading ${chunk.key} ahead to get it ready: ${diag.messageOf(error)}`);
          return -1;
        }),
      ),
    );
    // Nothing read and something failed: once more after a moment, then left to the play's own reads.
    if (read.every((count) => count <= 0) && read.some((count) => count < 0)) {
      if (++failures >= 5) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } else if (read.every((count) => count === 0)) {
      // Every block asked for was here and the stretch still isn't ready (no index to read it by): leave it to the play.
      return;
    } else failures = 0;
  }
}

/** For tests. */
export function reset(): void {
  measures.clear();
  walking.clear();
  cloudMedia.preparing.clear();
}

export function routes(router: Router<App>): void {
  // Where the project's footage stands here: whether it plays smoothly from the start, and its coming (see the top).
  // `waiting=1` while its dialog is up: its first minutes come first.
  router.get("/api/projects/{id}/footage/ready", async ({ app, params, query }) => {
    const id = params.id ?? "";
    return json(await readiness(app, id, query.get("waiting") === "1"));
  });
}
