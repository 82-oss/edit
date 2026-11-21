// The server's export registry: a durable queue on this Mac, its
// `export` events, the files it may hand out, and the Drive upload after a
// subtitled video (or whenever asked). The local rendering, mixing, the partial
// file beside the destination and its rename are the addon's (`ExportJob`).

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { Effect } from "effect";

import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import * as failure from "./failure.ts";
import { cachePath } from "./effect_cloud.ts";
import * as filePins from "./file_pins.ts";
import * as folderAccess from "./folder_access.ts";
import * as capacity from "./export_capacity.ts";
import { diskFull, freeOn, outOfSpace, shownProgress } from "./export_prep.ts";
import * as speeds from "./export_speeds.ts";
import { runPromise } from "./effect/runtime.ts";
import * as jobs from "./jobs.ts";
import * as missingMedia from "./missing_media.ts";
import { ioMessage, nowMs, writeAtomic } from "./files.ts";
import { subtitleVideo } from "./drive.ts";
import { catchBugsAsync } from "./guard.ts";
import type { ExportOptions, Plan, Project } from "./model.ts";
import { native, withProject } from "./native/index.ts";
import { canonical, fileName, homePath, isFile, join, parent } from "./paths.ts";
import { duration } from "./project.ts";
import { fixed, jsonForSerde } from "./rust.ts";
import * as seams from "./seams.ts";
import * as storage from "./storage.ts";
import type { Store } from "./store.ts";
import { BUILD } from "./version.ts";
import * as wake from "./wake.ts";

/** How many finished exports are remembered (handed out, revealed). */
const KEEP_FINISHED = 50;

/** How an export is started beyond its options (a restart passes back what it was). */
export interface StartExtra {
  /** Upload the finished file to Drive; by default only a whole subtitled video is (`drive.wanted`). */
  drive?: boolean;
  /** The file stays on this computer and no copy of it goes to the cloud (the Share dialog's Export; by default it's archived there, and deleted here when the disk is short). */
  keepLocal?: boolean;
  /** A share's export (reviews.exportAndShare): a failure is the share's to try again, not the export's (retry_after_update.ts). */
  share?: boolean;
  /** Said beside it in the Exports panel ("Trying again after the update"). */
  note?: string;
  /** A channel's watermark over the whole export (channel_marks.ts): its picture's Drive id in the Watermarks folder. */
  watermark?: string;
  /** A share's export: its file goes over the review's latest version rather than adding one (reviews.share's `replace`), kept so a restart shares it the same way. */
  replace?: boolean;
  /**
   * One of a batch of marked stretches (ranges.ts), which follows it: kept out of jobs.json (never resumed or tried
   * again after an update as a lone export, never in place of the project's own failed export), and the export made
   * ahead of the whole edit isn't spent by it.
   */
  stretch?: boolean;
  /** A stretch's batch's row in jobs.json (ranges.ts): noted as moving as the stretch's render moves, as an export's own row is. */
  beats?: string;
}

/**
 * An export that failed, kept in jobs.json as its export job, `failed` (the
 * panel's outcomes are in memory and gone with a restart, an update's too),
 * until the project's next export: what an update tries again, once, with the
 * same settings (retry_after_update.ts).
 */
export interface ExportFailure {
  project: string;
  name: string;
  options: ExportOptions;
  output: string;
  error: string;
  at: number;
  /** The build it failed on. */
  build: string;
  drive?: boolean;
  keepLocal?: boolean;
  share?: boolean;
}

/** The exports that failed and haven't been exported since, by project. */
export function failedExports(home: string): Record<string, ExportFailure> {
  const out: Record<string, ExportFailure> = {};
  for (const job of jobs.list(home, "export")) {
    if (job.state !== "failed") continue;
    const args = job.args as { options?: ExportOptions; output?: string; name?: string; drive?: boolean; keepLocal?: boolean; share?: boolean };
    if (args.options === undefined || typeof args.output !== "string") continue;
    out[job.project] = {
      project: job.project, name: args.name ?? job.project, options: args.options, output: args.output, error: job.error ?? "failed", at: job.updated_ms, build: job.build ?? "",
      ...(args.drive === true ? { drive: true } : {}), ...(args.keepLocal === true ? { keepLocal: true } : {}), ...(args.share === true ? { share: true } : {}),
    };
  }
  return out;
}

interface Running {
  output: string;
  /** Its chunk folder's name when it isn't the project's own (a framed export's: `exportPlan`'s `chunks`). */
  chunks?: string;
  /** Its entry in the jobs a restart resumes. */
  key: string;
  cancelled: boolean;
  /** Aborts in-flight export prep (cloud sound copies, excerpts, downloads) immediately on cancel or preemption. */
  stop: AbortController;
  job: { cancel(): void } | null;
  /** The timeline kept for a restart (`snapshotFile`), removed when it ends. */
  snapshot: string | null;
  /** What it exports, as `timelineHash`. */
  timeline: string;
  /** The options it exports with, as JSON with sorted keys (and its watermark: `withWatermarkKey`). */
  options: string;
  /** The edit's picture clips, for the review's clip map: the watermark's own isn't one. */
  clips?: [string, number, number][];
  keepLocal: boolean;
  queued: boolean;
  share?: boolean;
  note?: string;
  /** What it waits for while queued (export_capacity.ts `noRoom`). */
  waiting?: string;
  cancelQueued?: () => void;
  /** Made ahead, before anyone asked (export_ahead.ts): nobody waits on it, nothing lists it, and any export asked for stops it. */
  ahead?: boolean;
  /** Settled once it has ended, however it ended. */
  ended?: Promise<void>;
  /** Made ahead: gives its place back and drops it from the registry, when it won't end (`stopAhead`). */
  letGo?: () => void;
  /** A batch's stretch (`StartExtra.stretch`). */
  stretch?: boolean;
  /** The row in jobs.json its progress notes as moving (`beatRows`): its own, or a stretch's batch's; none made ahead. */
  beats?: string;
  /** About how big its file is (`exportBytes`), and a share's review copy beside it: what the disks are asked for again as it starts. */
  bytes?: number;
  review?: number;
  /** How long the video is, and when it was asked for: its steps (export_steps.ts). */
  seconds?: number;
  started_ms?: number;
  /** The share of its video made before this run, once known (`ExportBar`). */
  made?: number;
  /** Lets go of the files it holds (`holdFiles`), once its render has ended or it never starts. */
  unpin?: () => void;
  /** Lets go of only the export it copies unchanged chunks from: the room it needs comes first. */
  letReuseGo?: () => void;
}

/** Export jobs across projects, including the recent outcomes. Local jobs
 * queue for one renderer: each renderer owns several decoder/frame buffers. */
export interface ExportActivity {
  id: string;
  name: string;
  path: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  updated_ms: number;
  error?: string;
  /** Said beside it: "Trying again after the update". */
  note?: string;
  /** Queued: what it waits for ("waiting for the encoder (this Mac has one)", export_capacity.ts). */
  waiting?: string;
  /** Running, before frames are encoding: "cutting the footage, 12 of 225". Absent once the encoder reports, so the line goes back to the percent, until it's past its frames (`MIXING`, `JOINING`). */
  phase?: string;
  /** The file is still on this Mac. Set only once the export is done, and checked again each time the queue is read: the archive deletes it after upload. */
  onDisk?: boolean;
  /** Where that file is, with home as `~` (`~/Movies/Edit/Name.mp4`). Set only while `onDisk`. */
  saved?: string;
  /** How long the video is, when it was asked for, and whether it's a share's: its steps (export_steps.ts). */
  seconds?: number;
  started_ms?: number;
  share?: boolean;
  /** Running: the share of its video made before this run (chunks kept from one cut short), counted as done (`ExportBar`). */
  made?: number;
}

/**
 * A finished export, kept per project in `<home>/exports.json` (this
 * machine's files, never shared): the project's exports list, with a
 * download (on the Mac or over Tailscale) and a delete each, survives a
 * restart. A normal edit isn't uploaded anywhere; this is how it's handed out.
 */
export interface ExportRecord {
  path: string;
  name: string;
  finished_ms: number;
  /** How long it took (seconds). */
  seconds: number;
  bytes: number | null;
  /** Frames exported, and whether that was the whole edit. */
  frames: number;
  whole: boolean;
  /** The first frame exported: an opening (0) can be shared as a preview. */
  start?: number;
  format: string;
  /**
   * Frames a second this Mac rendered it at when every frame was new (a first
   * export on this Mac, H.264, no restart), and whether it was a subtitle
   * video: this Mac's own speed for the house export.
   */
  fresh_fps?: number;
  subtitles?: boolean;
  /** The exported timeline's fingerprint (`timelineHash`): an edit since makes the project "not exported". */
  timeline?: string;
  /** R2 key of the verified cloud copy, when the local file was deleted after upload. */
  cloudKey?: string;
}

/** The R2 key an export of `project` named `name` is archived under. */
export function exportCloudKey(project: string, name: string): string {
  return `edit/exports/${project}/${name}`;
}

/** Injectable cloud IO for `archiveExportFile` (tests stand in for R2). */
export const exportCloud = {
  enabled: (): boolean => cloud.enabled(),
  // Behind whatever someone waits on (cloud.first: a share on its way to its link): nobody waits for this copy.
  // `moving` hears each part's bytes: the archive's row is noted as moving by them (an upload of hours on a home line).
  upload: (path: string, key: string, signal?: AbortSignal, moving?: () => void): Promise<void> => cloud.uploadFile(path, key, moving === undefined ? undefined : () => moving(), signal, true),
  head: (key: string): Promise<{ size: number } | null> => cloud.head(key),
};

/**
 * Uploads `output` to `key` and deletes the local file — only after R2 is
 * verified to hold an object of exactly the local size. Any failure keeps
 * the local file (it may be the only copy) and returns false.
 */
/** Exports being read (a share making its copies): how many readers each. */
const reading = new Map<string, number>();
/** Exports archived while being read: their local copy goes when the last reader is done. */
const archivedMeanwhile = new Set<string>();

/**
 * Marks an export as being read until `release` is called: its archive keeps
 * the local copy meanwhile. A share started the moment the Cop video's export
 * said done lost its file to the archive mid-way ("No such file or
 * directory", Oct 29).
 */
export function holdExport(path: string): () => void {
  reading.set(path, (reading.get(path) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (reading.get(path) ?? 1) - 1;
    if (left > 0) {
      reading.set(path, left);
      return;
    }
    reading.delete(path);
    // Archived while it was read: gone now, as it would have been then (the
    // kept copies filled the disk and card 1's export failed, Oct 29).
    if (archivedMeanwhile.delete(path)) fs.rmSync(path, { force: true });
  };
}

/** Finished exports going up to the cloud now, by their file: how each is stopped, and when it has. */
const archiving = new Map<string, { stop: AbortController; done: Promise<void> }>();

/** Whether something is reading the export at `path` now (a share making its copies, its own upload to the cloud), or its one cloud copy is still to go up (`owedNow`). */
export function beingRead(path: string): boolean {
  return reading.has(path) || archiving.has(path) || owedNow(path);
}

/**
 * A share's export goes to the cloud once, as its review's full-quality file (Nov 21: it went up twice in full, as
 * its archive and as `full.mp4`, and one was deleted only after; on JJ's 8 Mbit/s line a 5 GB export is about 85
 * minutes a copy). Its `archive` row is listed as the export ends, as any export's, so a restart at any point leaves
 * a row that sees it into the cloud; but while its share (`share:<project>`, until its export is named) or the
 * share's `full` upload of the file is still to do, even waiting on a dropped line, the row waits behind it with
 * this step. It's crossed off once the export's record names the review's copy (`heldByReview`), and goes up as an
 * archive only once the share ended with no full-quality file on its way (failed, cancelled, given up).
 */
const BEHIND_SHARE = "waiting for its share's full-quality file";

/** How often a row waiting behind its share looks that the share still carries it (`watchBehind`), and its last-resort wake in the job table. */
export const behindShare = { everyMs: 30_000, backstopMs: 60 * 60_000 };

/** Data folders whose share-made exports are watched (an ExportRegistry's, and any that archived here). */
const homes = new Set<string>();

/** The archive row of the export at `output`, by its file: a share's is keyed by it, a plain one's by its project. */
function archiveRow(home: string, id: string, output: string): jobs.Job | undefined {
  return jobs.list(home, "archive").find((job) => job.project === id && job.args.output === output);
}

/**
 * What still sends a share's export up as `full.mp4`, so its own archive waits: the share's `full` job for this file
 * (live: going, or waiting for the line), or the share itself while it hasn't ended (its export not named yet, or
 * named as this file). Null once neither is there.
 */
function carriedBy(home: string, id: string, output: string): "full" | "share" | null {
  if (jobs.list(home, "full").some((job) => jobs.live(job) && job.args.path === output)) return "full";
  const share = jobs.get(home, jobs.keyOf("share", id));
  if (share === undefined || !jobs.live(share) || share.args.export === undefined) return null;
  const named = share.args.path;
  return named === undefined || named === output ? "share" : null;
}

/** The files whose one cloud copy is still owed (a share's archive row, live), read at most once a second. */
let owed = { at: 0, paths: new Set<string>() };

/**
 * Whether the export at `path` is a share's whose one cloud copy isn't up yet: the cleaners leave it (cache_cleanup's
 * retention and the Storage page ask `beingRead`), as it's the only copy there is until `full.mp4` or its archive is up.
 */
function owedNow(path: string): boolean {
  if (homes.size === 0) return false;
  const now = Date.now();
  if (now - owed.at > 1000) {
    const paths = new Set<string>();
    for (const home of homes) {
      for (const job of jobs.list(home, "archive")) if (jobs.live(job) && job.args.share === true && typeof job.args.output === "string") paths.add(job.args.output);
    }
    owed = { at: now, paths };
  }
  return owed.paths.has(path);
}

let watching: ReturnType<typeof setTimeout> | null = null;

/**
 * Looks, every `behindShare.everyMs`, at the rows waiting behind their share in `home` (from now until Edit quits):
 * one whose share no longer carries it is woken (`wakeBehindShare`). Only the job table is read meanwhile; nothing is
 * written, and no row says running, until one has something to do.
 */
function watchBehind(home: string): void {
  homes.add(home);
  if (watching !== null) return;
  const look = () => {
    for (const one of homes) {
      if (!fs.existsSync(one)) {
        homes.delete(one);
        continue;
      }
      try {
        for (const project of new Set(jobs.list(one, "archive").filter(waitsBehind).map((job) => job.project))) wakeBehindShare(one, project);
      } catch (error) {
        diag.warn("export", `looking at exports waiting behind their share: ${diag.messageOf(error)}`);
      }
    }
  };
  const tick = () => {
    look();
    watching = setTimeout(tick, failure.scaled(behindShare.everyMs));
    watching.unref?.();
  };
  watching = setTimeout(tick, failure.scaled(behindShare.everyMs));
  watching.unref?.();
}

function waitsBehind(job: jobs.Job): boolean {
  return job.state === "waiting" && job.args.share === true && job.step === BEHIND_SHARE;
}

/**
 * The share of project `id` ended, or its full-quality file did (reviews.ts says so; the watch looks too): each of
 * its exports waiting behind it that nothing carries any more goes now, to be crossed off (its record names the
 * review's copy) or sent up as its archive. One still carried is left as it is.
 */
export function wakeBehindShare(home: string, id: string): void {
  for (const job of jobs.list(home, "archive")) {
    if (job.project !== id || !waitsBehind(job) || typeof job.args.output !== "string") continue;
    if (carriedBy(home, id, job.args.output) !== null) continue;
    jobs.settle(home, job.key, "waiting", { retry_at: nowMs(), step: "uploading" });
  }
}

/** For tests: the watch stopped and its folders forgotten. */
export function resetBehindShare(): void {
  if (watching !== null) clearTimeout(watching);
  watching = null;
  homes.clear();
  owed = { at: 0, paths: new Set() };
}

/**
 * Holds `path` for the scope it's in: let go however the work ends (done, failed, interrupted), so an archive
 * waits for the reading and never waits for ever.
 */
export const holdingExport = (path: string) => Effect.acquireRelease(Effect.sync(() => holdExport(path)), (release) => Effect.sync(release));

/** `use`, with `path` held while it runs (`holdingExport`) for the code that isn't Effect yet. */
export function withExport<T>(path: string, use: () => Promise<T>): Promise<T> {
  return runPromise(Effect.scoped(holdingExport(path).pipe(Effect.andThen(Effect.tryPromise({ try: use, catch: (error) => error as Error })))));
}

/** An export with no progress for `ms` has stalled: it's started again, `tries` times at most (looked at every `everyMs`). */
export const stall = { ms: 8 * 60_000, tries: 3, everyMs: 15_000 };

/**
 * How long the engine has, once its job is told to stop (a Cancel, a stall, a person's export wanting the place), to
 * end it before the server stops waiting for it (Nov 20). A job that ends at all ends within a second or two of a
 * cancel; one that doesn't is stuck inside the engine (a VideoToolbox session or GPU lost across a lid close, a
 * writer's cancel that never returns), and before this it held its export, the encoder's place, the share behind it
 * and every export in line for ever. On a slow home line nothing here waits on the line (the engine reads from the
 * excerpts cut before it started); after a lid close the clock starts again at the wake. Looked at every
 * `stall.everyMs`, so it's given up 60 to 75 s after the stop.
 */
export const abandon = { ms: 60_000 };

/** Engine jobs given up on in this run (`EngineWatch`): the second means the engine itself is stuck, and only a new Edit frees it. */
let abandonedJobs = 0;

/** An engine job told to stop that never ended (`abandon`): passing trouble, tried again by itself on a fresh job. */
export class EngineAbandoned extends failure.StoodStill {}

/** The engine gave up on twice in this run: only quitting Edit frees it, so nothing tries again by itself. */
export const STUCK_ENGINE = "The video encoder stopped answering. Quit Edit and open it again, then press Retry.";

/**
 * Watches an engine job to its end (an export's or smooth playback's render): no progress for `stall.ms` stops it
 * (`stalled`), and once it's been told to stop (that, or `cancelled()`), it has `abandon.ms` to end before it's left
 * to itself. A wake starts both clocks again: a closed lid is no stall (Nov 20, finding 10: `performance.now()` may
 * count the sleep on a Mac, and three lid closes failed a healthy export).
 */
export class EngineWatch {
  private moved = performance.now();
  private sentAt: number | null = null;
  stalled = false;
  constructor(
    private readonly what: string,
    private readonly cancelled: () => boolean,
  ) {}

  /** Progress heard: any change is movement. */
  move(): void {
    this.moved = performance.now();
  }

  /** The job's end ("ended"), its error, or "abandoned" when it was told to stop and didn't end in time. */
  async wait(job: { cancel(): void; wait(): Promise<unknown> }): Promise<"ended" | "abandoned"> {
    const ending = job.wait();
    let give!: () => void;
    const given = new Promise<"abandoned">((resolve) => {
      give = () => resolve("abandoned");
    });
    const look = () => {
      const now = performance.now();
      if (this.cancelled() || this.stalled) {
        this.sentAt ??= now;
        if (now - this.sentAt >= abandon.ms) give();
        return;
      }
      if (now - this.moved < stall.ms) return;
      this.stalled = true;
      this.sentAt = now;
      job.cancel();
    };
    const timer = setInterval(look, stall.everyMs);
    const offWake = wake.onWake(() => {
      const now = performance.now();
      this.moved = now;
      if (this.sentAt !== null) this.sentAt = now;
    });
    try {
      const how = await Promise.race([ending.then(() => "ended" as const), given]);
      if (how === "abandoned") {
        abandonedJobs += 1;
        diag.warn("export", `${this.what}: the engine didn't end its job within ${Math.round(abandon.ms / 1000)} s of being stopped; left to itself. It may still hold a thread and the encoder: quitting and reopening Edit (or restarting the Mac) frees them${abandonedJobs > 1 ? ` (${abandonedJobs} in this run)` : ""}`);
      }
      return how;
    } finally {
      clearInterval(timer);
      offWake();
      // An abandoned job's late end (or error) is nobody's now.
      ending.catch(() => {});
    }
  }
}

/**
 * How long an export waits for an effect's render it found missing or unreadable to be made again (`remake`), as long
 * as an export asked for waits for its effects at the start (routes.ts `READY_WAIT_MS`). It's drawn here from its code
 * (a slow home line doesn't slow it; a copy in the cloud is only a quicker way back); a lid closed meanwhile may count.
 * Past it the export waits and goes again by itself, the render carrying on meanwhile.
 */
export const REMAKE_MS = { value: 20 * 60_000 };

/** An effect's render made again for an export took past `REMAKE_MS`: passing, the export tried again by itself. */
export class RemakeTimedOut extends failure.StepTimedOut {}

/** `work`, unless `signal` stops it ("cancelled") or `ms` runs out first (`late()` is thrown); `work` itself goes on. */
async function untilDone<T>(work: Promise<T>, signal: AbortSignal, ms: number, late: () => Error): Promise<T> {
  if (signal.aborted) throw new Error("cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), ms);
    onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Whether the engine was given up on more than once in this run (`STUCK_ENGINE`). */
export function engineStuck(): boolean {
  return abandonedJobs > 1;
}

/** For tests: no engine job given up on yet. */
export function resetAbandoned(): void {
  abandonedJobs = 0;
}

/** Free space where `path` is (bytes); 0 when it can't be told. */
function freeBytes(path: string): number {
  try {
    const found = fs.statfsSync(parent(path) ?? ".");
    return Number(found.bavail) * Number(found.bsize);
  } catch {
    return 0;
  }
}

/**
 * Room enough on the disk to keep every archived export here too: the next
 * re-export copies its unchanged chunks straight out of it instead of
 * fetching it back from the cloud first (2–3 minutes for a 90-minute edit).
 */
export const KEEP_WHEN_FREE = 60e9;

/**
 * Below that, each project's newest export still stays while the disk keeps
 * this much free: at 60 GB, a Mac with a 256 GB disk (Sphe's M1, 26 GB free)
 * fetched the last export back from R2 before every re-export (Sphe, Nov 3:
 * "keep newest per project"). The older copies go first (`dropKept`).
 */
export const KEEP_NEWEST_FREE = 20e9;

export async function archiveExportFile(
  output: string,
  key: string,
  io: typeof exportCloud = exportCloud,
  room: (path: string) => number = freeBytes,
  signal?: AbortSignal,
  carriedOn = false,
  moving?: () => void,
  wanted?: () => boolean,
): Promise<boolean> {
  let size: number;
  try { size = fs.statSync(output).size; } catch { return false; }
  try {
    // Carried on after a restart and up already (the restart came after the upload, before its job ended): not sent
    // again (Sphe, Nov 10: an update goes through at any time, and nothing it cuts is uploaded twice). Only then: right
    // after an export, what's under its name is the one it writes over, whose size could happen to be the same.
    const there = carriedOn ? await io.head(key).catch(() => null) : null;
    if (there === null || there.size !== size) {
      await io.upload(output, key, signal, moving);
      const found = await io.head(key);
      if (found === null || found.size !== size) return false;
    }
  } catch { return false; }
  // Stopped for a newer export of this file: that one is written here now, and goes up itself.
  if (signal?.aborted) return false;
  return letGoHere(output, room, wanted);
}

/** An export now in the cloud: kept here while the disk has room or something still reads it, else deleted. Whether that went as it should. */
function letGoHere(output: string, room: (path: string) => number, wanted?: () => boolean): boolean {
  // Archived; while the disk keeps its room it stays here too: it's the project's newest.
  if (room(output) > KEEP_NEWEST_FREE) return true;
  // A copy being read stays until the reading's done; so does one a share's full-quality upload still has to send
  // (`wanted`: its row in the job table). After a restart that upload's own hold isn't taken yet when this carries on,
  // and on a Mac under 20 GB free the file went from under it: it then tried a file that wasn't there twenty times
  // over an hour and a half and gave up with a line in the log (the bad-day run on Sphe's MacBook Air, Nov 21).
  if (reading.has(output) || wanted?.() === true) {
    archivedMeanwhile.add(output);
    return true;
  }
  try { fs.rmSync(output, { force: true }); } catch { return false; }
  return !fs.existsSync(output);
}

/**
 * How an archive went: up (or in the cloud already), stopped for a newer
 * export of the file, or not up (offline, signed out, the relay down): that
 * one's job waits and is tried again by itself (jobs.ts `wait`, failure.ts's schedule).
 */
export type Archived = "up" | "stopped" | "not up" | "behind";

/**
 * Puts a finished export in the cloud (`archiveExportFile`) and lists it
 * there: after the export, or after a restart cut the upload short (the
 * `archive` job). A file gone meanwhile is said, never exported again here.
 * A share's export waits behind its share instead ("behind", `BEHIND_SHARE`).
 */
export async function archiveFinished(home: string, id: string, output: string, key: string, record: ExportRecord, signal?: AbortSignal): Promise<Archived> {
  watchBehind(home);
  // Its row, found by its file (a share's export has its own: `ExportRegistry.run`); none in some tests.
  const row = archiveRow(home, id, output);
  const rowKey = row?.key ?? jobs.keyOf("archive", id);
  const forShare = row?.args.share === true;
  if (forShare && fs.existsSync(output)) {
    const by = carriedBy(home, id, output);
    if (by !== null) {
      diag.info("export", `${id}: ${output} goes to the cloud once, as its review's full-quality file: its archive waits for ${by === "full" ? "that upload" : "its share"}`);
      return "behind";
    }
  }
  if (!fs.existsSync(output)) {
    // Its review's copy stands in for it (`heldByReview`): listed as that.
    const kept = record.bytes === null ? null : reviewCopyOf(home, id, output, record.bytes);
    if (kept !== null) {
      remember(home, id, { ...record, cloudKey: kept });
      return "up";
    }
    // Archived and deleted here before a restart crossed its job off: listed in the cloud, and done.
    const there = record.bytes === null ? null : await exportCloud.head(key).catch(() => null);
    if (there !== null && there.size === record.bytes) {
      remember(home, id, { ...record, cloudKey: key });
      return "up";
    }
    // Nothing to send: the job is crossed off, not tried at every start until it's given up.
    throw new jobs.Gone(`${output} is gone`);
  }
  // Its review's full-quality download is this very file already: not sent a second time.
  const size = fs.statSync(output).size;
  const wanted = () => jobs.list(home, "full").some((job) => jobs.live(job) && job.args.path === output);
  const held = reviewCopyOf(home, id, output, size);
  if (held !== null) {
    remember(home, id, { ...record, cloudKey: held });
    diag.info("export", `${id}: ${output} is in the cloud already as ${held}: not archived again`);
    // A share's export, its one copy up as `full.mp4`: kept here or not by the archive's own rule (the disk's room),
    // as it would have been had the archive sent it; only once the cloud holds that copy whole.
    if (forShare) {
      dropKept(home, output);
      const there = await exportCloud.head(held).catch(() => null);
      if (there !== null && there.size === size) letGoHere(output, freeBytes, wanted);
    }
    return "up";
  }
  // Short of room: the older copies kept while there was some go first, so this one may stay.
  dropKept(home, output);
  // Its job begun by an earlier run, or tried before and put off: carried on (what's up already isn't sent again).
  const listed = row ?? jobs.get(home, rowKey);
  const carriedOn = (listed?.started_ms ?? Infinity) < performance.timeOrigin || listed?.put_off !== undefined;
  // Its bytes going up are its row's beat (Nov 21): noted only as it began, an upload of hours read as still.
  const moving = () => jobs.beat(home, rowKey);
  if (await archiveExportFile(output, key, exportCloud, freeBytes, signal, carriedOn, moving, wanted)) {
    try {
      remember(home, id, record);
    } catch { /* the list keeps the local-only record */ }
    // Its review's copy landed while this one went up: this one goes again.
    const held = fs.existsSync(output) ? reviewCopyOf(home, id, output, fs.statSync(output).size) : null;
    if (held !== null) await heldByReview(home, id, output, held, fs.statSync(output).size);
    diag.info("export", `${id}: archived ${output} to ${key}${fs.existsSync(output) ? " (the local copy kept: being read, or the newest with room for it)" : " and deleted the local copy"}`);
    return "up";
  }
  if (signal?.aborted) {
    diag.info("export", `${id}: the upload of ${output} to the cloud stopped: a newer export of it is being made`);
    return "stopped";
  }
  diag.warn("export", `${id}: cloud archive of ${output} unverified; local copy kept`);
  return "not up";
}

/**
 * An `archive` job's upload, however it goes: up, stopped for a newer export,
 * or its file gone, it's crossed off; not up (offline, signed out, the relay
 * down: Marc's Mac, Nov 18, where three restarts left one "given up"), it's
 * put off and tried again by itself, an hour and then a day later.
 */
export async function archiveJob(home: string | null, job: string, send: () => Promise<Archived>): Promise<void> {
  let went: Archived;
  try {
    went = await send();
  } catch (error) {
    if (error instanceof jobs.Gone) {
      jobs.end(home, job);
      return;
    }
    went = "not up";
    diag.warn("export", `${job}: archiving: ${diag.messageOf(error)}`);
  }
  // Behind its share: waiting, so nothing counts it as running (the Mac may sleep, an update isn't held), until the
  // share or its full-quality file ends (`wakeBehindShare`, from reviews.ts and the watch); the table's own wake is
  // only the last resort, an hour on. A restart meanwhile leaves it waiting, and the watch of the next run looks again.
  if (went === "behind") jobs.settle(home, job, "waiting", { step: BEHIND_SHARE, retry_at: nowMs() + failure.scaled(behindShare.backstopMs) });
  else if (went === "not up") jobs.wait(home, job, "its export's cloud copy didn't go up");
  else jobs.end(home, job);
}

/**
 * `archiveFinished`, noted as going up while it does: a newer export of the
 * same file stops it (`ExportRegistry.start`) rather than writing the file
 * under it, and the cleaners leave the file alone (`beingRead`).
 */
export async function archiveGoing(home: string, id: string, output: string, key: string, record: ExportRecord): Promise<Archived> {
  const stop = new AbortController();
  const sent = archiveFinished(home, id, output, key, record, stop.signal);
  const entry = { stop, done: sent.then(() => undefined, () => undefined) };
  archiving.set(output, entry);
  try {
    return await sent;
  } finally {
    if (archiving.get(output) === entry) archiving.delete(output);
  }
}

/** Where project `id`'s export made ahead goes (export_ahead.ts), with what it was made of beside it (`.json`). */
export function aheadFile(cache: string, id: string): string {
  return join(cache, "ahead", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.mp4`);
}

/** An export of `id` asked for and made into `output`: its export made ahead (copied from, or older) is spent, and goes. */
export function aheadSpent(cache: string, id: string, output: string): void {
  const file = aheadFile(cache, id);
  if (file === output) return;
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.json`, { force: true });
}

/** The chunk folder of a project's exports (the engine's chunks::folder), or of the ones named `project` (`exportPlan`'s `chunks`). */
export function chunkFolder(cache: string, project: string): string {
  return join(cache, "export-chunks", project.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Every chunk folder of `project`'s exports: its own and each framed export's (`<id>.<w>x<h>-<fill>`, render.rs `chunk_name`). */
export function chunkFolders(cache: string, project: string): string[] {
  const own = chunkFolder(cache, project);
  const framed = new RegExp(`^${own.slice(own.lastIndexOf("/") + 1)}_\\d+x\\d+-[A-Za-z]+$`);
  let names: string[] = [];
  try {
    names = fs.readdirSync(join(cache, "export-chunks"));
  } catch {
    // None yet.
  }
  return [own, ...names.filter((name) => framed.test(name)).map((name) => join(cache, "export-chunks", name))];
}

/**
 * The last export's file, fetched back from the cloud when it was archived,
 * so a re-export copies the chunks that didn't change out of it: with the
 * file gone the engine reuses nothing (its manifest wants the file as it was
 * written), and every re-export since exports went to the cloud rendered the
 * whole video again: 30–40 minutes for a fix in the intro (Oct 29). Its
 * manifest gets the fetched copy's time. The path fetched, else null.
 */
export async function restorePrevious(cache: string, home: string, project: string, fetch: (key: string, dest: string) => Promise<void> = (key, dest) => cloud.download(key, dest), signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  const manifest = join(chunkFolder(cache, project), "manifest-v1.json");
  let text: string;
  let output: string;
  let size: number;
  try {
    text = fs.readFileSync(manifest, "utf8");
    const value = JSON.parse(text) as { output?: unknown; size?: unknown };
    if (typeof value.output !== "string" || typeof value.size !== "number") return null;
    [output, size] = [value.output, value.size];
  } catch {
    return null;
  }
  if (fs.existsSync(output)) return null;
  const key = cloudKeyFor(home, output);
  if (key === null) return null;
  try {
    fs.mkdirSync(parent(output) ?? ".", { recursive: true });
    await fetch(key, output);
  } catch (error) {
    if (!signal?.aborted) diag.warn("export", `fetching the last export back to reuse its chunks: ${diag.messageOf(error)}; it renders whole`);
    fs.rmSync(output, { force: true });
    return null;
  }
  if (!fs.existsSync(output) || fs.statSync(output).size !== size) {
    fs.rmSync(output, { force: true });
    return null;
  }
  // The time as text: nanoseconds are past what a JS number holds exactly.
  const ns = fs.statSync(output, { bigint: true }).mtimeNs.toString();
  writeAtomic(manifest, text.replace(/"modified_ns"\s*:\s*\d+/, `"modified_ns":${ns}`));
  diag.info("export", `${project}: fetched the last export back so its unchanged chunks are reused`);
  return output;
}

/** The chunks the last whole export of `project` was joined from: each one's content key, first frame in the file and length. */
export function lastChunks(cache: string, project: string): { output: string; size: number; fps: number; chunks: { key: string; at: number; frames: number }[] } | null {
  try {
    const value = JSON.parse(fs.readFileSync(join(chunkFolder(cache, project), "manifest-v1.json"), "utf8")) as Record<string, unknown>;
    if (typeof value.output !== "string" || typeof value.size !== "number" || typeof value.fps !== "number" || !Array.isArray(value.chunks)) return null;
    const chunks = (value.chunks as Record<string, unknown>[]).filter((one) => typeof one.key === "string" && typeof one.at === "number" && typeof one.frames === "number") as { key: string; at: number; frames: number }[];
    return chunks.length === value.chunks.length && chunks.length > 0 ? { output: value.output, size: value.size, fps: value.fps, chunks } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the bar
//
// What the bar says while the engine renders (Nov 21, a MacBook Air): an export killed at 29.9% was carried on by
// itself a second later, reused 6 of its 26 chunks and came out right, but its bar went back to 1%, crawled, and went
// from 77% to 100% at the end; a fresh export's join (22 s there) said 100% all the while. The engine's fraction
// counts only the chunks it has left to make (render.rs `export_chunked`: their share of the frames, and 5% for the
// sound when it's mixed again) and says nothing while it joins. What it writes says the rest, read here without the
// engine knowing: its plan and the chunks already there (`plan-v1.json`, a file per chunk made, the last export's
// manifest), the list it joins from, and its file growing as it's joined. So the chunks made before count as done
// from the start, the join and the sound's mix are said and the join has the end of the bar to itself, and the bar
// never goes back within an export.

/** The end of the bar a chunked export's join fills: its chunks copied into one file, the file's index moved to its front, its frames counted. */
export const JOIN_SHARE = 0.06;
/** The sound mix's share of the engine's fraction when it's mixed again (render.rs `sound_share`). */
const SOUND_SHARE = 0.05;
/** Of the join's end of the bar, what its copy fills (by the bytes written); its +faststart pass and frame count the rest, by the clock. */
const JOIN_COPY = 0.45;
/** A plan written this long before the engine job started is still its own (a disk that keeps times to the second). */
const PLAN_SLACK_MS = 2_000;
/** How often the bar looks at what the engine has written (tests look more often). */
export const barLooks = { everyMs: 500 };
/** Said while the engine joins its chunks into the file, and while the sound's mix goes on after the picture is done. */
export const JOINING = "joining the pieces into one file";
export const MIXING = "mixing the sound";

/** An engine job's chunks as it planned them (`plan-v1.json`, chunks.rs `write_plan`). */
interface ChunkPlan {
  extension: string;
  chunks: { key: string; frames: number }[];
  frames: number;
}

async function statOf(path: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(path);
  } catch {
    return null;
  }
}

/**
 * The plan in chunk folder `dir` and the share of its frames already made: chunk files there from before `since` (any,
 * with `since` null), and the chunks the engine copies out of the last export (`last`, while its file is the one its
 * manifest names). Null with no plan, or one older than `since` (another run's, not this engine job's).
 */
export async function madeShare(dir: string, since: number | null, last: ReturnType<typeof lastChunks>): Promise<{ plan: ChunkPlan; made: number } | null> {
  const file = join(dir, "plan-v1.json");
  const stat = await statOf(file);
  if (stat === null || (since !== null && stat.mtimeMs < since - PLAN_SLACK_MS)) return null;
  let plan: ChunkPlan;
  try {
    const value = JSON.parse(await fs.promises.readFile(file, "utf8")) as { extension?: unknown; chunks?: unknown };
    if (typeof value.extension !== "string" || !Array.isArray(value.chunks)) return null;
    const chunks = (value.chunks as Record<string, unknown>[])
      .filter((one) => typeof one.key === "string" && typeof one.start === "number" && typeof one.end === "number")
      .map((one) => ({ key: one.key as string, frames: Math.max(0, (one.end as number) - (one.start as number)) }));
    plan = { extension: value.extension, chunks, frames: chunks.reduce((sum, one) => sum + one.frames, 0) };
  } catch {
    return null;
  }
  if (plan.frames <= 0) return null;
  const old = last !== null && (await statOf(last.output))?.size === last.size ? new Map(last.chunks.map((one) => [one.key, one.frames])) : new Map<string, number>();
  const files = await Promise.all(plan.chunks.map((chunk) => statOf(join(dir, `${chunk.key}.${plan.extension}`))));
  let made = 0;
  plan.chunks.forEach((chunk, at) => {
    const own = files[at];
    if (own !== null && own !== undefined) {
      if (since === null || own.mtimeMs < since) made += chunk.frames;
    } else if (since !== null && old.get(chunk.key) === chunk.frames) made += chunk.frames;
  });
  return { plan, made: made / plan.frames };
}

/** The engine's file for `output` while it's made (render.rs `partial_path`: this server's pid, as the engine runs in it). */
export function partialOf(output: string, project: string, format: ExportOptions["format"]): string {
  const extension = { h264: "mp4", hevc: "mp4", prores: "mov", gif: "gif", wav: "wav", mp3: "mp3", png: "png" }[format] ?? "mp4";
  return `${output}.${process.pid}-${project}.partial.${extension}`;
}

/**
 * One export's bar (0–1 of its encode, `shownProgress` adds its prep): the engine's fraction with the chunks made
 * before counted as done, the join's end of the bar, and what it's on. Looked at as the engine reports and every
 * `barLooks.everyMs`; `engineBegins` for each engine job of the export (a stall's restart is another).
 */
export class ExportBar {
  /** The share of the video made before this engine job; null until its plan is read. */
  made: number | null = null;
  /** Its plan is read: the chunks and the join are known (else the engine's fraction is the whole bar, as before). */
  private plan: ChunkPlan | null = null;
  /** Looked for its plan once the engine had reported: a whole export (not in chunks) writes none. */
  private settled = false;
  private since = 0;
  /** The engine's fraction last heard. */
  private engine = 0;
  private heard = false;
  /** Its sound is mixed again: assumed when the edit has sound, seen as the mix's files appear. */
  private mixing: boolean;
  private picture = false;
  private mixDone = false;
  /** The join: when it began, the bytes it copies, those written and when they last grew, and when its copy was done. */
  private join: { at: number; expected: number; written: number; grew: number; copied: number | null } | null = null;
  private looking = false;
  /** The last export's manifest, read once an engine job's plan is (`madeShare`). */
  private lastRead: ReturnType<typeof lastChunks> = null;

  /** The engine's file while it's made (`partialOf`), set as each engine job begins. */
  private partial = "";

  constructor(
    private readonly folder: string,
    audio: boolean,
    private readonly last: () => ReturnType<typeof lastChunks>,
    private readonly now: () => number = Date.now,
  ) {
    this.mixing = audio;
  }

  /** A new engine job starts (`since`: the time just before it did), making `partial`. */
  engineBegins(since: number, partial: string): void {
    this.partial = partial;
    this.made = null;
    this.plan = null;
    this.settled = false;
    this.since = since;
    this.engine = 0;
    this.heard = false;
    this.picture = false;
    this.mixDone = false;
    this.join = null;
  }

  /** The engine's fraction (render.rs `export_chunked`'s, 0–1). */
  hear(fraction: number): void {
    this.engine = Math.min(1, Math.max(0, fraction));
    this.heard = true;
  }

  /** Whether the bar can be said: its plan read, or none to read. */
  get ready(): boolean {
    return this.plan !== null || this.settled;
  }

  /** The encode's share of the bar now, 0–1. */
  get encode(): number {
    if (this.plan === null) return this.engine;
    const made = this.made ?? 0;
    const sound = this.mixing ? SOUND_SHARE : 0;
    // The engine's fraction leaves out the picture made before: (1 − the sound's share) of its frames (render.rs `picture_share`).
    const render = this.join !== null ? 1 : Math.min(1, this.engine + (1 - sound) * made);
    return (1 - JOIN_SHARE) * render + JOIN_SHARE * this.joined();
  }

  /** What it's on, when it's past its frames: the sound's mix after the picture, or the join. */
  get phase(): string | undefined {
    if (this.join !== null) return JOINING;
    if (this.picture && this.mixing && !this.mixDone) return MIXING;
    return undefined;
  }

  /** The join's own part done, 0–1: its copy by the bytes written, then by the clock (never 1 until the engine ends). */
  private joined(): number {
    const join = this.join;
    if (join === null) return 0;
    const copy = join.expected > 0 ? Math.min(1, join.written / join.expected) : 0;
    if (join.copied === null) return JOIN_COPY * copy;
    // The +faststart pass rewrites the file and the frame count reads it: about as long again as the copy took.
    const took = Math.max(1_000, join.copied - join.at);
    const rest = 1 - Math.exp(-(this.now() - join.copied) / took);
    return Math.min(0.99, JOIN_COPY + (1 - JOIN_COPY) * rest);
  }

  /** Looks at what the engine has written: its plan, the sound's mix, the join. Never two looks at once. */
  async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      if (this.plan === null && !this.settled) {
        const heardBefore = this.heard;
        this.lastRead = this.last();
        const read = await madeShare(this.folder, this.since, this.lastRead);
        if (read !== null) {
          this.plan = read.plan;
          this.made = read.made;
        } else if (heardBefore) this.settled = true;
      }
      const plan = this.plan;
      if (plan === null) return;
      const sound = `${this.partial}.sound.m4a`;
      if (!this.mixDone) {
        const [mixed, mixing, scratch] = await Promise.all([statOf(sound), statOf(`${sound}.mixing.m4a`), statOf(`${sound}.mix.f32`)]);
        if (mixed !== null) this.mixDone = true;
        if (mixed !== null || mixing !== null || scratch !== null) this.mixing = true;
      }
      if (this.join === null) {
        if ((await statOf(`${this.partial}.chunks.txt`)) !== null) {
          // Its chunks are all made: what it copies is about their bytes, those copied from the last export, and the sound.
          const last = this.lastRead;
          const files = await Promise.all(plan.chunks.map((chunk) => statOf(join(this.folder, `${chunk.key}.${plan.extension}`))));
          const own = new Set(plan.chunks.filter((_, at) => files[at] !== null).map((chunk) => chunk.key));
          const lastFrames = last?.chunks.reduce((sum, one) => sum + one.frames, 0) ?? 0;
          const old = last === null || lastFrames <= 0 ? 0 : plan.chunks.filter((chunk) => !own.has(chunk.key)).reduce((sum, chunk) => sum + chunk.frames, 0) * (last.size / lastFrames);
          const bytes = files.reduce((sum, one) => sum + (one?.size ?? 0), 0) + old + ((await statOf(sound))?.size ?? 0);
          this.join = { at: this.now(), expected: bytes, written: 0, grew: this.now(), copied: null };
        } else if (this.mixing && !this.mixDone && !this.picture && this.engine >= (1 - SOUND_SHARE) * (1 - (this.made ?? 0)) - 0.005) {
          // Its frames may all be there: the picture is done when every chunk's file is (each renamed into place whole).
          const files = await Promise.all(plan.chunks.map((chunk) => statOf(join(this.folder, `${chunk.key}.${plan.extension}`))));
          const copied = new Set(this.lastRead?.chunks.map((one) => one.key) ?? []);
          this.picture = plan.chunks.every((chunk, at) => files[at] !== null || copied.has(chunk.key));
        }
      }
      const join_ = this.join;
      if (join_ !== null && join_.copied === null) {
        const written = (await statOf(this.partial))?.size ?? 0;
        if (written > join_.written) {
          join_.written = written;
          join_.grew = this.now();
        }
        // Copied: about all its bytes there, or the file standing still once it has some (the guess was over).
        const still = join_.written > 0 && this.now() - join_.grew >= 3 * barLooks.everyMs;
        if (join_.expected <= 0 || join_.written >= join_.expected * 0.98 || still) join_.copied = this.now();
      }
    } finally {
      this.looking = false;
    }
  }
}

/**
 * Deletes local copies of exports archived in the cloud (verified by size),
 * never `except` or one being read, as the disk `except` is on runs short
 * (four of them filled this Mac on Oct 29): with `KEEP_WHEN_FREE` or less
 * free, every one but each project's newest; with under `KEEP_NEWEST_FREE`
 * still, the newest of other projects on that disk too, the oldest first,
 * until there's room again. Bytes freed.
 */
export function dropKept(home: string, except: string, free: (path: string) => number = freeBytes): number {
  if (free(except) > KEEP_WHEN_FREE) return 0;
  const records = Object.values(readRecords(home));
  const newest = new Set(records.map((own) => own.reduce<ExportRecord | null>((best, one) => (best === null || one.finished_ms >= best.finished_ms ? one : best), null)?.path).filter((path) => path !== undefined));
  const droppable = (record: ExportRecord): number | null => {
    if (record.cloudKey === undefined || record.path === except || reading.has(record.path) || !fs.existsSync(record.path)) return null;
    const size = fs.statSync(record.path).size;
    return record.bytes !== null && size !== record.bytes ? null : size;
  };
  let freed = 0;
  for (const record of records.flat()) {
    if (newest.has(record.path)) continue;
    const size = droppable(record);
    if (size === null) continue;
    fs.rmSync(record.path, { force: true });
    freed += size;
  }
  const disk = (path: string): number => { try { return fs.statSync(path).dev; } catch { return -1; } };
  const here = disk(parent(except) ?? ".");
  const others = records.flat().filter((record) => newest.has(record.path) && disk(record.path) === here).sort((a, b) => a.finished_ms - b.finished_ms);
  for (const record of others) {
    if (free(except) >= KEEP_NEWEST_FREE) break;
    const size = droppable(record);
    if (size === null) continue;
    fs.rmSync(record.path, { force: true });
    freed += size;
  }
  if (freed > 0) diag.info("export", `freed ${(freed / 1e9).toFixed(1)} GB: exports already in the cloud, kept here while there was room`);
  return freed;
}

/** The cloud key recorded for `path`, when its local copy was archived. */
export function cloudKeyFor(home: string, path: string): string | null {
  for (const own of Object.values(readRecords(home))) {
    const hit = own.find((record) => record.path === path);
    if (hit?.cloudKey !== undefined) return hit.cloudKey;
  }
  return null;
}

/** A project's timeline as a fingerprint: the same whatever revision or machine saved it, different after any edit. */
export function timelineHash(project: Project): string {
  return createHash("sha256").update(jsonForSerde(project)).digest("hex").slice(0, 16);
}

/** The picture clips of an export's timeline ([id, start, duration] frames): a review note's moment finds its clip by them after later edits. */
export function clipMap(project: Project): [string, number, number][] {
  return project.clips.filter((clip) => clip.type === "video").map((clip): [string, number, number] => [clip.id, clip.start, clip.duration]);
}

/** Where an export's clip map is kept, by its timeline (`timelineHash`). */
export function mapFile(home: string, timeline: string): string {
  return join(home, "export-maps", `${timeline}.json`);
}

/** How many exports of the whole edit a project keeps listed (the oldest drop off the list; their files stay). */
const KEEP_LISTED = 30;
/** And of parts of it (an in/out span, a marked stretch, stretches joined), apart: a batch of 36 cut-ins pushed every whole export off the list, and its own first six. */
const KEEP_PARTS = 200;

/**
 * Holds what an export of `project` reads against everything that deletes
 * Edit's own files (file_pins.ts), from the moment it's asked for until its
 * render ends: its files here (an effect's render before it goes up, footage
 * added here), the cache's copies of its renders, and the file its unchanged
 * chunks are copied out of (the export made ahead, the last export; the
 * engine's manifest names it). Sphe's M4, Nov 17: the render the export had
 * planned was deleted 5 s in by the swap into the cache once it went up, and
 * Retry's room-making took the 7.3 GB export made ahead it would have copied
 * every chunk from. `reuse` lets go of only the latter (when there's no room
 * for both, the room comes first).
 */
export function holdFiles(cache: string, project: Project, chunks: string = project.id): { media: () => void; reuse: () => void; reusable: boolean } {
  const paths: string[] = [];
  for (const media of project.media) {
    if (!media.path.includes("://")) paths.push(media.path);
    const cloud = media.cloud;
    if (cloud !== undefined && cloud !== null && cloud.proxy === cloud.original) paths.push(cachePath(cache, cloud.original));
  }
  const ahead = aheadFile(cache, project.id);
  const last = lastChunks(cache, chunks)?.output;
  const reused = [ahead, ...(last === undefined ? [] : [last])];
  return { media: filePins.pin(paths), reuse: filePins.pin([...reused, `${ahead}.json`]), reusable: reused.some((path) => isFile(path)) };
}

/**
 * The edit an export was taken of, with each effect's render whose file has
 * gone since (swapped into the cache once it went up, an older snapshot carried
 * on after a restart) read from where the edit has that same render now: the
 * same effect at the same key, or one made again for this export (`remade`).
 * The edit itself is unchanged: only where its renders are read from.
 */
export function located(snapshot: Project, live: Project | null, remade: ReadonlySet<string> = new Set(), here: (path: string) => boolean = isFile): Project {
  if (live === null) return snapshot;
  let out: Project | null = null;
  snapshot.media.forEach((media, index) => {
    const name = media.effect;
    if (typeof name !== "string" || typeof media.effect_key !== "string") return;
    const cloud = media.cloud !== undefined && media.cloud !== null;
    if (!remade.has(name) && (cloud || here(media.path))) return;
    const now = live.media.find((one) => one.id === media.id && one.effect === name && (remade.has(name) || one.effect_key === media.effect_key));
    if (now === undefined || typeof now.effect_key !== "string") return;
    out ??= structuredClone(snapshot);
    const into = out.media[index]!;
    into.path = now.path;
    into.effect_key = now.effect_key;
    if (now.cloud !== undefined && now.cloud !== null) into.cloud = structuredClone(now.cloud);
    else delete into.cloud;
  });
  return out ?? snapshot;
}

/** The effect whose render (as the engine was handed it, `exported`) an export's error names, and whether its file is there (unreadable) or gone. */
export function effectIn(error: string, exported: Project): { name: string; key: string; path: string; unreadable: boolean } | null {
  for (const media of exported.media) {
    if (typeof media.effect !== "string" || typeof media.effect_key !== "string" || media.path === "" || !error.includes(media.path)) continue;
    return { name: media.effect, key: media.effect_key, path: media.path, unreadable: isFile(media.path) };
  }
  return null;
}

/** Effects' renders an export makes again or fetches again for itself before it gives up (each once). */
const REMAKES = 3;

/**
 * The project as an export running for it was asked for, kept while it runs
 * so an export a restart cut short carries on with that timeline, not edits
 * made since (`resumeSnapshot`).
 */
function snapshotFile(home: string, id: string): string {
  return join(home, "jobs", `export-${id}.json`);
}

/**
 * A kept timeline the last run left for an export its share carries on (the
 * share keeps its own): removed. One this run wrote (that share's export,
 * started again under the same name) is newer than this process, and stays.
 */
export function dropLeftSnapshot(home: string, id: string, args: Record<string, unknown>): void {
  const path = args.snapshot;
  if (typeof path !== "string" || path !== snapshotFile(home, id)) return;
  try {
    if (fs.statSync(path).mtimeMs < performance.timeOrigin) fs.rmSync(path, { force: true });
  } catch {
    // Gone already.
  }
}

/** The project an export a restart cut short was started with, if it was kept. */
export function resumeSnapshot(home: string, id: string, args: Record<string, unknown>): Project | null {
  const path = args.snapshot;
  // Only the file Edit keeps for it: jobs.json names nothing else to read.
  if (typeof path !== "string" || path !== snapshotFile(home, id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Project;
  } catch {
    return null;
  }
}

function recordsFile(home: string): string {
  return join(home, "exports.json");
}

function readRecords(home: string): Record<string, ExportRecord[]> {
  try {
    const value = JSON.parse(fs.readFileSync(recordsFile(home), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, ExportRecord[]>) : {};
  } catch {
    return {};
  }
}

function writeRecords(home: string, records: Record<string, ExportRecord[]>): void {
  writeAtomic(recordsFile(home), JSON.stringify(records, null, 1));
}

/** Project `id`'s exports, newest first, each saying whether its file is still there. */
export function listExports(home: string, id: string): (ExportRecord & { missing: boolean })[] {
  return [...(readRecords(home)[id] ?? [])]
    .reverse()
    .map((record) => ({ ...record, missing: !fs.existsSync(record.path) && record.cloudKey === undefined }));
}

function remember(home: string, id: string, record: ExportRecord): void {
  const records = readRecords(home);
  const own = (records[id] ?? []).filter((one) => one.path !== record.path);
  own.push(record);
  // A record from before `whole` was kept counts as whole.
  const whole = own.filter((one) => one.whole !== false);
  const parts = own.filter((one) => one.whole === false);
  const kept = new Set([...whole.slice(Math.max(whole.length - KEEP_LISTED, 0)), ...parts.slice(Math.max(parts.length - KEEP_PARTS, 0))]);
  records[id] = own.filter((one) => kept.has(one));
  writeRecords(home, records);
}

/** Lists a file made of exports (marked stretches joined, ranges.ts), so it's downloaded and shown as one. */
export function listMade(home: string, id: string, record: ExportRecord): void {
  remember(home, id, record);
}

/** Takes files off project `id`'s list (the parts of one joined), leaving the files as they are. */
export function unlist(home: string, id: string, paths: string[]): void {
  const records = readRecords(home);
  const own = records[id];
  if (own === undefined) return;
  records[id] = own.filter((one) => !paths.includes(one.path));
  writeRecords(home, records);
}

/**
 * An export's exact file is in the cloud already as a review's full-quality
 * download (`key`, `size` bytes): its own archive would be a second copy of
 * the same bytes (Sphe, Nov 11: 111 GB of exports were stored twice). The
 * archive under `edit/exports/` goes (the relay lets a project's people
 * delete its own exports) and the export points at the review's copy, which
 * it's restored from; one still to go up is never sent (`archiveFinished`).
 * A newer export written to the same path since (another size) is left as it
 * is. A delete the cloud refuses (an older relay) leaves both: nothing lost.
 */
export async function heldByReview(home: string, id: string, path: string, key: string, size: number): Promise<void> {
  const records = readRecords(home);
  const record = (records[id] ?? []).find((one) => one.path === path);
  if (record === undefined || (record.bytes !== null && record.bytes !== size)) return;
  const archive = record.cloudKey;
  if (archive === key) return;
  if (archive !== undefined && archive.startsWith(`edit/exports/${id}/`)) {
    try {
      await cloud.remove([archive]);
    } catch (error) {
      diag.warn("export", `${id}: ${archive} is the same file as the review's ${key}, and stays: ${diag.messageOf(error)}`);
      return;
    }
  }
  const now = readRecords(home);
  const fresh = (now[id] ?? []).find((one) => one.path === path);
  if (fresh === undefined) return;
  fresh.cloudKey = key;
  writeRecords(home, now);
  diag.info("export", `${id}: ${path} is kept in the cloud once, as the review's ${key}${archive !== undefined && archive !== key ? ` (${archive} removed)` : ""}`);
}

/** The review's copy an export's file already is in the cloud, when it is (`heldByReview`). */
function reviewCopyOf(home: string, id: string, path: string, size: number): string | null {
  const record = (readRecords(home)[id] ?? []).find((one) => one.path === path);
  return record?.cloudKey !== undefined && record.cloudKey.startsWith(`edit/reviews/${id}/`) && (record.bytes === null || record.bytes === size) ? record.cloudKey : null;
}

/** The fewest frames a speed sample has: a short export is mostly its fixed start and finish. */
const SPEED_FRAMES = 1800;
/** Whether nothing of `project`'s earlier exports is kept to reuse: an export now renders every frame. */
function nothingToReuse(cache: string, project: string): boolean {
  try {
    return fs.readdirSync(chunkFolder(cache, project)).length === 0;
  } catch {
    return true;
  }
}

/** Whether `path` is one of the listed exports (of any project). */
export function listed(home: string, path: string): boolean {
  return Object.values(readRecords(home)).some((own) => own.some((record) => record.path === path));
}

/**
 * Deletes one of project `id`'s listed exports: its file and its place on
 * the list. Only a listed export's file is ever deleted.
 */
export function deleteExport(home: string, id: string, path: string): void {
  const records = readRecords(home);
  const own = records[id] ?? [];
  if (!own.some((record) => record.path === path)) throw new Error("not one of this project's exports");
  try {
    fs.rmSync(path, { force: true });
  } catch (error) {
    throw new Error(`${path}: ${ioMessage(error)}`);
  }
  records[id] = own.filter((record) => record.path !== path);
  writeRecords(home, records);
  diag.info("export", `${id}: deleted the export ${path}`);
}

/** An export's options key with its watermark (a channel's picture id), so a share follows only an export with the same one. */
export function withWatermarkKey(key: string, watermark: string | undefined): string {
  return watermark === undefined ? key : `${key}|watermark:${watermark}`;
}

/** Export options as JSON with sorted keys: two asks for the same export compare equal. */
export function optionsKey(options: ExportOptions): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, one]) => [key, sorted(one)])) : value;
  return JSON.stringify(sorted(options));
}

/** What `native().exportPlan` answers. */
export type Planned = { plan: Plan; fps: number; chunks?: string | null };

/** Plans kept, by project: the revision they're of, and each by its options' text (`planExport`). */
const plans = new Map<string, { rev: number; byOptions: Map<string, Planned> }>();
/** Projects, and plans of one revision, kept at most (a plan is a few numbers). */
const PLANS_KEPT = 32;

/**
 * `native().exportPlan` of `project` as `options` ask, on the server's one thread (Nov 21: on a 2-hour edit one kept
 * it 716 ms; measured on 4,000 clips, 190 ms of a plan sent as JSON is the native side reading the project again, and
 * 2 ms is the plan). `rev` is the store's revision `project` is (`revOf`), or null when it isn't one (a clone, a kept
 * snapshot, an edit with its watermark over it): then it's sent as JSON as before. With one, it's planned by reference
 * to what native already holds of that revision, and kept by the options' text while that revision is the one
 * planned, so the same plan asked again (an export made ahead looked at after each rest, a stretch of a batch again)
 * costs nothing. A plan is of the project and the options alone (render.rs `export_plan`, `chunk_name`).
 */
export function planExport(project: Project, options: ExportOptions, rev: number | null): Planned {
  if (rev === null) return native().exportPlan({ json: jsonForSerde(project) }, options);
  let kept = plans.get(project.id);
  if (kept === undefined || kept.rev !== rev) {
    kept = { rev, byOptions: new Map() };
    plans.delete(project.id);
    plans.set(project.id, kept);
    for (const old of plans.keys()) {
      if (plans.size <= PLANS_KEPT) break;
      plans.delete(old);
    }
  }
  const text = optionsKey(options);
  const found = kept.byOptions.get(text);
  if (found !== undefined) return structuredClone(found);
  const made = withProject(project.id, rev, () => jsonForSerde(project), (input) => native().exportPlan(input, options));
  if (kept.byOptions.size >= PLANS_KEPT) kept.byOptions.delete(kept.byOptions.keys().next().value!);
  kept.byOptions.set(text, structuredClone(made));
  return made;
}

/** The revision `project` is in `store`: the very object the store holds for it (a revision's object is frozen), else null. */
export function revOf(store: Pick<Store, "get">, project: Project): number | null {
  const live = store.get(project.id);
  return live !== null && live.project === project ? live.rev : null;
}

/** For tests: no plan kept. */
export function forgetPlans(): void {
  plans.clear();
}

export class ExportRegistry implements seams.Exports {
  private jobs = new Map<string, Running>();
  /** Exports rendering on this Mac now: as many at once as it has room for (export_capacity.ts). */
  private localActive = 0;
  /** Of those, the places smooth playback's render holds (`takeTurn`): not exports, so nothing waits on them as on one. */
  private lent = 0;
  /** Of those, the places exports made ahead hold (`startAhead`): not exports either, and they give theirs up to anything that wants it. */
  private aheadActive = 0;
  /** Smooth playback's renders waiting for a place: served before the exports in line (Sphe, Nov 3: "cut the line"). */
  private ahead: (((release: () => void) => void) & { giveWay?: (() => void) | undefined })[] = [];
  private localQueue: { running: Running; start: () => void; notify: () => void }[] = [];
  /** A look again at the line when an export waits for room (memory, the CPU) rather than for one to end. */
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private recent = new Map<string, ExportActivity>();
  /** How an export was started, kept after it fails or is cancelled so it can be run again. Gone when it succeeds, or when the outcome leaves the recent list. */
  private held = new Map<string, { options: ExportOptions; output: string; extra: StartExtra }>();
  /** Files exported since the server started, newest last: the only ones it hands out or reveals. */
  private finished: string[] = [];

  /** Finished exports of this registry's going up to the cloud now. */
  private sending = 0;

  /** The data folder whose exports list this keeps (`<home>/exports.json`); none in some tests. */
  constructor(private readonly home: string | null = null) {
    // Its share-made exports waiting behind their share, from before a restart too, are looked at from the start.
    if (home !== null) watchBehind(home);
  }

  /** Whether `path` is a file this server exported, now or before a restart (and so may be downloaded or revealed). */
  exported(path: string): boolean {
    return this.finished.includes(path) || (this.home !== null && listed(this.home, path));
  }

  /** Whether an export someone asked for is under way (one made ahead isn't). */
  running(): boolean {
    return [...this.jobs.values()].some((job) => job.ahead !== true);
  }

  /** Whether a finished export is going up to the cloud (its project is free to export or share again meanwhile). */
  archiving(): boolean {
    return this.sending > 0;
  }

  /** Sends a finished export to the cloud (`archiveGoing`), counted as this Mac's work while it goes: after its export, or as the `archive` job a restart carries on. */
  async sendUp(home: string, id: string, output: string, key: string, record: ExportRecord): Promise<Archived> {
    this.sending += 1;
    try {
      return await archiveGoing(home, id, output, key, record);
    } finally {
      this.sending -= 1;
    }
  }

  /** Project `id`'s export under way: what it writes, its timeline (`timelineHash`) and options (`optionsKey`). One made ahead isn't one to follow. */
  runningFor(id: string): { output: string; timeline: string; options: string } | null {
    const running = this.jobs.get(id);
    return running === undefined || running.cancelled || running.ahead === true ? null : { output: running.output, timeline: running.timeline, options: running.options };
  }

  /** Whether an export is rendering here (smooth playback's render isn't one, nor one made ahead). */
  localRunning(): boolean {
    return this.localActive - this.lent - this.aheadActive > 0;
  }

  /** The project whose export is being made ahead, if one is. */
  aheadFor(): string | null {
    for (const [id, job] of this.jobs) if (job.ahead === true && !job.cancelled) return id;
    return null;
  }

  /** Stops exports made ahead (all, or `project`'s), for something someone wants; resolves once they've let go. */
  async stopAhead(project?: string): Promise<void> {
    const ended: Promise<void>[] = [];
    const stopped: [string, Running][] = [];
    for (const [id, job] of this.jobs) {
      if (job.ahead !== true || (project !== undefined && id !== project)) continue;
      job.cancelled = true;
      job.stop.abort();
      job.job?.cancel();
      stopped.push([id, job]);
      if (job.ended !== undefined) ended.push(job.ended);
    }
    if (ended.length === 0) return;
    // Never for ever (Nov 20): a person's Export waited here, its request unanswered, on one made ahead stuck in the
    // engine. Its render is given up on after `abandon.ms` (EngineWatch); this bound is for the rest of it (a watermark
    // being put on). Then it's dropped and its place given back, whatever it's still doing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), abandon.ms + stall.everyMs + 5_000);
    });
    const how = await Promise.race([Promise.all(ended).then(() => "ended" as const), late]);
    clearTimeout(timer);
    if (how === "ended") return;
    for (const [id, job] of stopped) {
      if (this.jobs.get(id) !== job) continue;
      diag.warn("export", `${id}: its export made ahead didn't stop within ${Math.round((abandon.ms + stall.everyMs) / 1000)} s; left to itself`);
      this.jobs.delete(id);
      job.letGo?.();
    }
  }

  /**
   * Starts making `project`'s export ahead into `output` (export_ahead.ts), when
   * nothing else wants this Mac's encoder: no export rendering or waiting, none
   * for this project, and room for it now. False when it didn't start.
   */
  startAhead(store: Store, library: seams.Library, project: Project, options: ExportOptions, output: string, watermark?: string): boolean {
    if (this.jobs.size > 0 || this.localQueue.length > 0 || this.ahead.length > 0) return false;
    if (capacity.noRoom(this.localActive) !== null) return false;
    const { plan, fps, chunks } = planExport(project, options, revOf(store, project));
    if (plan.end <= plan.start) return false;
    const folder = parent(output) ?? ".";
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      return false;
    }
    if (roomFor(exportBytes(options, plan, options.fps ?? fps), store.cacheDir(), folder) !== null) return false;
    const edit = structuredClone(project);
    let finish!: () => void;
    const reads = holdFiles(store.cacheDir(), edit, chunks ?? edit.id);
    const unpin = () => {
      reads.media();
      reads.reuse();
    };
    const running: Running = {
      output, ...(chunks ? { chunks } : {}), key: "", cancelled: false, stop: new AbortController(), job: null, snapshot: null, timeline: timelineHash(edit),
      options: withWatermarkKey(optionsKey(options), watermark), keepLocal: true, queued: false, ahead: true,
      ended: new Promise<void>((resolve) => { finish = resolve; }), unpin, ...(reads.reusable ? { letReuseGo: reads.reuse } : {}),
    };
    this.jobs.set(project.id, running);
    this.localActive++;
    this.aheadActive++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.aheadActive = Math.max(0, this.aheadActive - 1);
      this.releaseOne();
    };
    running.letGo = release;
    void (async () => {
      let marked = edit;
      if (watermark !== undefined) marked = await seams.channelMarks.addWatermark({ library }, store.cacheDir(), edit, plan, watermark);
      if (running.cancelled) return;
      await this.run(store, library, marked, structuredClone(options), plan, output, running, false, release);
    })()
      .catch((error: unknown) => {
        diag.warn("export", `${project.name}: making its export ahead: ${diag.messageOf(error)}`);
      })
      .finally(() => {
        if (this.jobs.get(project.id) === running) this.jobs.delete(project.id);
        unpin();
        release();
        finish();
      });
    return true;
  }

  /**
   * A place for smooth playback's render, as an export has: now when the Mac
   * has room (`release` given back at once), else `ready` is called with it
   * once there is, before the exports waiting in line. With three exports
   * queued, the edit open on this Mac got no smooth playback for hours; now it
   * waits only for the export rendering, and on a Max or an Ultra it renders
   * beside them. `cancel` drops a wait.
   */
  takeTurn(ready: (release: () => void) => void, giveWay?: () => void): { release: (() => void) | null; cancel: () => void } {
    if (this.ahead.length === 0 && this.localQueue.length === 0 && capacity.noRoom(this.localActive) === null) return { release: this.lend(giveWay), cancel: () => {} };
    // Someone is watching: an export made ahead gives its place up (it carries on later from its chunks).
    if (this.aheadActive > 0) void this.stopAhead();
    const turn = (release: () => void) => ready(release);
    this.ahead.push(Object.assign(turn, { giveWay }));
    this.drain();
    return { release: null, cancel: () => { this.ahead = this.ahead.filter((one) => one !== turn); } };
  }

  /** Smooth playback's places now, each with how it gives way to an export someone asked for (`takeTurn`'s `giveWay`). */
  private lentTo = new Set<{ giveWay: (() => void) | undefined; asked: boolean }>();

  /** Takes a place for smooth playback; its release gives it back (once). */
  private lend(giveWay?: () => void): () => void {
    this.localActive++;
    this.lent++;
    const place = { giveWay, asked: false };
    this.lentTo.add(place);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.lentTo.delete(place);
      this.lent = Math.max(0, this.lent - 1);
      this.releaseOne();
    };
  }

  /**
   * Progress heard of `running` notes its row as moving, and every export waiting in line here, whose wait moves with
   * it (Nov 21: an export's row was noted only between its steps, so a 2-hour edit's 30-minute render, and each export
   * queued behind it, read as still in the log and the Mac's report). `jobs.beat` writes a row at most every 30 s.
   */
  private beatRows(running: Running): void {
    if (this.home === null) return;
    try {
      if (running.beats !== undefined) jobs.beat(this.home, running.beats);
      for (const one of this.localQueue) if (one.running.beats !== undefined && !one.running.cancelled) jobs.beat(this.home, one.running.beats);
    } catch (error) {
      diag.warn("export", `noting an export as moving: ${diag.messageOf(error)}`);
    }
  }

  activity(): ExportActivity[] {
    return [...this.recent.values()].map((one) => this.withPlace(one)).sort((a, b) => b.updated_ms - a.updated_ms);
  }

  /** A finished export says whether its file is still on this Mac, and where. Checked on each read, not stored: the archive may delete it after this was marked done. */
  private withPlace(job: ExportActivity): ExportActivity {
    if (job.state !== "done" || job.path === "") return { ...job };
    if (!isFile(job.path)) return { ...job, onDisk: false };
    return { ...job, onDisk: true, saved: homePath(job.path) };
  }

  private publish(store: Store, project: Project, running: Running, state: ExportActivity["state"], progress: number, extra: Record<string, unknown> = {}): void {
    const phase = typeof extra.phase === "string" && extra.phase !== "" ? extra.phase : undefined;
    const waiting = state === "queued" && typeof running.waiting === "string" && running.waiting !== "" ? running.waiting : undefined;
    const rest = { ...extra };
    delete rest.phase;
    this.recent.set(project.id, { id: project.id, name: project.name, path: running.output, state, progress, updated_ms: nowMs(), ...(typeof extra.error === "string" ? { error: extra.error } : {}), ...(running.note === undefined ? {} : { note: running.note }), ...(waiting !== undefined ? { waiting } : {}), ...(phase !== undefined ? { phase } : {}), ...(running.seconds === undefined ? {} : { seconds: running.seconds }), ...(running.started_ms === undefined ? {} : { started_ms: running.started_ms }), ...(running.share === true ? { share: true } : {}), ...(state === "running" && running.made !== undefined ? { made: running.made } : {}) });
    // Keep every active job and only the latest completed outcomes.
    const ended = [...this.recent.values()].filter(one => one.state !== "queued" && one.state !== "running").sort((a, b) => b.updated_ms - a.updated_ms);
    for (const old of ended.slice(20)) {
      this.recent.delete(old.id);
      this.held.delete(old.id);
    }
    // `waiting` rides the event too: the share chip reads it, and a queued publish used to leave it off.
    store.emit({ type: "export", id: project.id, state, progress, path: running.output, ...rest, ...(phase !== undefined ? { phase } : {}), ...(waiting !== undefined ? { waiting } : {}) });
  }

  /** Starts what waits in line while this Mac has room for another (export_capacity.ts). */
  private drain(): void {
    this.localQueue = this.localQueue.filter((one) => !one.running.cancelled);
    while (this.ahead.length > 0 || this.localQueue.length > 0) {
      const room = capacity.noRoom(this.localActive);
      if (room !== null && this.aheadActive > 0) {
        // An export made ahead holds the place something asked for wants: it gives it up, and its release drains again.
        const why = "waiting for a background export to stop";
        for (const one of this.localQueue) {
          if (one.running.waiting === why) continue;
          one.running.waiting = why;
          one.notify();
        }
        void this.stopAhead();
        return;
      }
      if (room !== null && this.localQueue.length > 0 && this.lentTo.size > 0) {
        // Smooth playback's render holds a place an export someone asked for wants: it gives way (Nov 20: Export sat at
        // 0% for minutes behind it on a one-encoder Mac, for ever when it hung), and carries on from its chunks after.
        // Its release drains again; a render that won't stop is given up on within `abandon.ms` (EngineWatch).
        const why = "waiting for smooth playback's render to stop";
        for (const one of this.localQueue) {
          if (one.running.waiting === why) continue;
          one.running.waiting = why;
          one.notify();
        }
        for (const place of this.lentTo) {
          if (place.asked || place.giveWay === undefined) continue;
          place.asked = true;
          try {
            place.giveWay();
          } catch (error) {
            diag.warn("export", `smooth playback giving way: ${diag.messageOf(error)}`);
          }
        }
        if ([...this.lentTo].some((place) => place.giveWay !== undefined)) return;
      }
      if (room !== null) {
        // Only smooth playback's render holds the Mac: it's that they wait for.
        const why = this.lent > 0 && this.localActive === this.lent ? "waiting for smooth playback's render to finish" : room;
        // Said again as it changes (memory freed, the CPU less busy), not only when it was queued.
        for (const one of this.localQueue) {
          if (one.running.waiting === why) continue;
          one.running.waiting = why;
          one.notify();
        }
        // Waiting on room rather than on an export to end: looked at again in a while.
        if (this.localActive < capacity.mostAtOnce() && this.recheck === null) {
          this.recheck = setTimeout(() => {
            this.recheck = null;
            this.drain();
          }, 20_000);
          this.recheck.unref?.();
        }
        return;
      }
      // An export someone asked for goes before smooth playback's render: given the place first, the render would only
      // be told to give way to it at once (Nov 20). With nothing in line, the render goes before anything made ahead.
      if (this.localQueue.length === 0) {
        const turn = this.ahead.shift()!;
        turn(this.lend(turn.giveWay));
        continue;
      }
      const next = this.localQueue.shift()!;
      if (this.localActive > 0) diag.info("export", `starting another export beside ${this.localActive} running (${capacity.standing()})`);
      this.localActive++;
      next.running.queued = false;
      next.running.waiting = undefined;
      next.start();
    }
  }

  /** An export here let go of its place: the next in line may start. */
  private releaseOne(): void {
    this.localActive = Math.max(0, this.localActive - 1);
    this.drain();
  }

  cancel(project: string): boolean {
    const running = this.jobs.get(project);
    if (running === undefined) return false;
    running.cancelled = true;
    running.stop.abort();
    if (running.queued) running.cancelQueued?.();
    running.job?.cancel();
    return true;
  }

  /** How `id`'s export was started, when that export failed or was cancelled and can be run again. */
  replay(id: string): { options: ExportOptions; output: string; extra: StartExtra } | null {
    const outcome = this.recent.get(id);
    const held = this.held.get(id);
    if (held === undefined || outcome === undefined || (outcome.state !== "failed" && outcome.state !== "cancelled")) return null;
    return { options: structuredClone(held.options), output: held.output, extra: { ...held.extra } };
  }

  /**
   * Starts exporting `project` as `options` ask; returns the file it will
   * write (`output` with the format's extension), rendered on this Mac. A
   * whole subtitled video is then uploaded to the team's Drive unless
   * `drive` is false; any whole video export is when it's true.
   */
  async start(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    output: string,
    extra: StartExtra = {},
  ): Promise<string> {
    // Nothing final while footage is missing (missing_media.ts): the button's, a share's, the agent's and a retry's export wait alike.
    const missing = await missingMedia.held(store.home, project);
    if (missing !== null) throw new Error(missing);
    // This project's export made ahead stops first (it writes the same chunk folder); what it made is reused.
    await this.stopAhead(project.id);
    const { plan, fps, chunks } = planExport(project, options, revOf(store, project));
    // The edit it's handed, whoever asked: a coded effect not rendered from its code, or a map shot still its first
    // frame, would go out as its stand-in (a Retry, a retry after an update and a stretch never waited for them).
    let notReady: string | null = null;
    try {
      notReady = seams.broll.exportReady?.(store, project, plan.start, plan.end) ?? null;
    } catch (error) {
      if (!seams.isUnavailable(error)) throw error;
    }
    if (notReady !== null) throw new Error(notReady);
    // Held from here (before any room is made for it) until its render ends: nothing deletes what it reads meanwhile.
    const held = holdFiles(store.cacheDir(), project, chunks ?? project.id);
    const unpin = () => {
      held.media();
      held.reuse();
    };
    try {
      return await this.begin(store, library, project, options, output, extra, plan, fps, chunks ?? null, unpin, held.reusable ? held.reuse : null);
    } catch (error) {
      unpin();
      throw error;
    }
  }

  /** `start`'s work once what the export reads is held (`unpin` lets go of it, `letReuseGo` of the export it'd copy from, when there is one). */
  private async begin(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    output: string,
    extra: StartExtra,
    plan: Plan,
    fps: number,
    chunks: string | null,
    unpin: () => void,
    letReuseGo: (() => void) | null,
  ): Promise<string> {
    const addon = native();
    // The edit as it is, before a watermark goes over it: what this export is of (its hash and clip map).
    const edit = project;
    if (extra.watermark !== undefined) project = await seams.channelMarks.addWatermark({ library }, store.cacheDir(), project, plan, extra.watermark);
    let path = addon.withExtension(output, options.format);
    const above = parent(path);
    const folder = above === null || above === "" ? "." : above;
    // A folder on a drive or in Desktop: macOS may ask first, which the sync calls below would wait on, holding the server.
    await folderAccess.reach([folder]);
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    const name = fileName(path);
    if (name === null) throw new Error("export needs a file name");
    let real: string;
    try {
      real = fs.realpathSync(folder);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    path = join(real, name);
    if (fs.existsSync(path)) {
      const existing = canonical(path);
      if (project.media.some((media) => fs.existsSync(media.path) && canonical(media.path) === existing)) {
        throw new Error("export would overwrite source footage; choose another file");
      }
    }
    // Rendered here: refused up front when the disks can't hold it, never halfway (TODO, Oct 18: a 2h35m export
    // needed ~8 GB with 2.8 GB free).
    const size = exportBytes(options, plan, options.fps ?? fps);
    let short = roomFor(size, store.cacheDir(), folder);
    // Short of room: what Edit's own cache holds can be fetched again, so its least recently used copies go
    // first, and it's refused only if that isn't enough (JJ's Mac, Nov 10: a share refused twice for 3 GB,
    // until he cleared the disk by hand).
    // The export made ahead it copies its chunks from is kept while anything else can go; taken last, when it's that or
    // no export (Sphe's M4, Nov 17: Retry's room took it, 7.3 GB, and all 88 chunks were rendered again).
    const make = async () => {
      if (room.make === null) return;
      try {
        // As far as what Edit keeps free on the disk, from projects not in work (cache_cleanup.ts `makeRoomAsync`).
        await room.make(roomWanted(size, store.cacheDir(), folder) + storage.keepFreeBytes(store.cacheDir()));
      } catch (error) {
        diag.warn("export", `making room for ${project.name}'s export: ${diag.messageOf(error)}`);
      }
      short = roomFor(size, store.cacheDir(), folder);
    };
    if (short !== null) await make();
    if (short !== null && room.make !== null && letReuseGo !== null) {
      letReuseGo();
      await make();
    }
    if (short !== null) throw new Error(short);
    const whole = ["h264", "hevc", "prores"].includes(options.format) && plan.start === 0 && plan.end >= duration(project) && plan.end > 0;
    if (extra.drive === true && !whole) throw new Error("only a whole video export (MP4 or MOV) uploads to Drive");
    const refuse = () => {
      const already = this.jobs.get(project.id);
      if (already !== undefined) throw new Error(`this project already has an export running (into ${already.output.split("/").pop()}): wait for it (wait {for: ["export"]}) or cancel it`);
      if ([...this.jobs.values()].some(job => job.output === path)) throw new Error("another export is writing this output path");
    };
    refuse();
    // The last export of this file still going up to the cloud: this one writes the file again, so that upload stops
    // (this one goes up in its place). Looked at again after: another export may have begun while it stopped.
    const going = archiving.get(path);
    if (going !== undefined) {
      going.stop.abort();
      await going.done;
      refuse();
    }
    let snapshot: string | null = null;
    if (this.home !== null) {
      snapshot = snapshotFile(this.home, project.id);
      try {
        fs.mkdirSync(join(this.home, "jobs"), { recursive: true });
        // The edit, not the watermark over it: a restart puts that on again
        // (`watermark` below), so the export carried on is of the same edit,
        // with the same keys, and the share that asked for it follows it.
        writeAtomic(snapshot, jsonForSerde(edit));
      } catch (error) {
        throw new Error(`couldn't keep this export's timeline for a restart: ${ioMessage(error)}`);
      }
    }
    // Everything it was started with, so a restart carries it on as it was:
    // a share's export once came back without its share, and its next Share
    // exported the edit again (the audit, Nov 3).
    const args = {
      options, output: path,
      ...(extra.drive === undefined ? {} : { drive: extra.drive }), ...(snapshot === null ? {} : { snapshot }),
      ...(extra.keepLocal === true ? { keepLocal: true } : {}), ...(extra.share === true ? { share: true } : {}),
      ...(extra.note === undefined ? {} : { note: extra.note }), ...(extra.watermark === undefined ? {} : { watermark: extra.watermark }),
      ...(extra.replace === true ? { replace: true } : {}),
    };
    // A stretch's key is never written, so settling or ending it changes nothing in jobs.json.
    const key = extra.stretch === true ? jobs.keyOf("export", project.id, "stretch") : jobs.begin(this.home, "export", project.id, args);
    // Own the snapshot in memory too: a caller changing its draft or options
    // after enqueueing must never change the export that was accepted.
    project = structuredClone(project);
    options = structuredClone(options);
    const review = extra.share === true ? reviewBytes(Math.max(plan.end - plan.start, 0) / Math.max(options.fps ?? fps, 1)) : 0;
    const beats = extra.stretch === true ? extra.beats : key;
    const running: Running = { output: path, ...(chunks ? { chunks } : {}), key, ...(beats === undefined ? {} : { beats }), cancelled: false, stop: new AbortController(), job: null, snapshot, timeline: timelineHash(edit), options: withWatermarkKey(optionsKey(options), extra.watermark), clips: clipMap(edit), keepLocal: extra.keepLocal === true, queued: true, ...(extra.share === true ? { share: true } : {}), ...(extra.note === undefined ? {} : { note: extra.note }), ...(extra.stretch === true ? { stretch: true } : {}), bytes: size, review, seconds: Math.max(plan.end - plan.start, 0) / Math.max(options.fps ?? fps, 1), started_ms: nowMs(), unpin, ...(letReuseGo === null ? {} : { letReuseGo }) };
    this.jobs.set(project.id, running);
    let upload = false;
    try {
      upload = extra.drive ?? seams.drive.wanted(project, options, plan);
    } catch (error) {
      if (!seams.isUnavailable(error)) {
        this.jobs.delete(project.id);
        jobs.end(this.home, key);
        if (snapshot !== null) fs.rmSync(snapshot, { force: true });
        throw error;
      }
    }
    running.cancelQueued = () => {
      unpin();
      this.localQueue = this.localQueue.filter(one => one.running !== running);
      this.publish(store, project, running, "cancelled", 0);
      this.jobs.delete(project.id);
      jobs.end(this.home, running.key);
      if (snapshot !== null) fs.rmSync(snapshot, { force: true });
    };
    this.held.set(project.id, {
      options,
      output: path,
      extra: {
        ...(extra.drive === undefined ? {} : { drive: extra.drive }),
        ...(extra.keepLocal === true ? { keepLocal: true } : {}),
        ...(extra.share === true ? { share: true } : {}),
        ...(extra.note === undefined ? {} : { note: extra.note }),
        ...(extra.watermark === undefined ? {} : { watermark: extra.watermark }),
        ...(extra.replace === true ? { replace: true } : {}),
        ...(extra.stretch === true ? { stretch: true } : {}),
        ...(extra.beats === undefined ? {} : { beats: extra.beats }),
      },
    });
    this.localQueue.push({ running, start: () => {
      void this.run(store, library, project, options, plan, path, running, upload, () => this.releaseOne()).catch((error: unknown) => {
        // Whatever went wrong after the render, the project is free to export again.
        diag.error("export", `${project.name}: ${diag.messageOf(error)}`);
        if (this.jobs.get(project.id) === running) this.jobs.delete(project.id);
        jobs.end(this.home, running.key);
      }).finally(unpin);
    }, notify: () => {
      if (running.queued && !running.cancelled) this.publish(store, project, running, "queued", 0);
    } });
    this.drain();
    if (running.queued) this.publish(store, project, running, "queued", 0);
    return path;
  }

  private async run(
    store: Store,
    library: seams.Library,
    project: Project,
    options: ExportOptions,
    plan: import("./model.ts").Plan,
    output: string,
    running: Running,
    upload: boolean,
    releaseLocal?: () => void,
  ): Promise<void> {
    const id = project.id;
    const quiet = running.ahead === true;
    // One made ahead says nothing to the page: nobody asked for it.
    // The bar never goes back within an export (`ExportBar`): its prep said again on a stall's restart, the engine's
    // second try at its chunks, a fresh engine job carrying on.
    let best = 0;
    const emit = (state: ExportActivity["state"], progress: number, extra: Record<string, unknown> = {}) => {
      if (state === "running") progress = best = Math.max(best, progress);
      if (!quiet) this.publish(store, project, running, state, progress, extra);
    };
    // Real progress heard (the prep's line, the last export's bytes, the engine's frames) is its row's beat (`beatRows`).
    const moving = () => this.beatRows(running);
    // Cutting excerpts, copying sound, and fetching the last export fill the first slice of the bar.
    // "preparing the footage" alone does not count: a local export, and a stills fetch, stay on the 0–1 bar.
    let prepared = false;
    let prepRatio = 0;
    const tell = (phase: string, ratio: number) => {
      moving();
      prepared = true;
      prepRatio = Math.max(prepRatio, ratio);
      emit("running", shownProgress(prepRatio, null), { phase });
    };
    const onPrep = (phase: string, ratio: number) => {
      if (phase === "preparing the footage") {
        moving();
        emit("running", shownProgress(prepared ? prepRatio : null, null), { phase });
        return;
      }
      // The last export's download, when there is one, takes the rest of the prep slice.
      tell(phase, ratio * 0.85);
    };
    const chunkDir = chunkFolder(store.cacheDir(), running.chunks ?? id);
    const bar = new ExportBar(chunkDir, plan.audio === true, () => lastChunks(store.cacheDir(), running.chunks ?? id));
    // Chunks left by a run cut short (a restart, a stall) are done from its first line, prep and all: the bar never
    // reads as started over while the footage is prepared again. Looked at only where an engine has planned (a few
    // stats, off the thread); the engine's own plan says it exactly as it starts.
    if (!quiet && isFile(join(chunkDir, "plan-v1.json"))) {
      const read = await madeShare(chunkDir, null, null).catch(() => null);
      if (read !== null && read.made > 0) {
        running.made = read.made;
        best = shownProgress(null, (1 - JOIN_SHARE) * (plan.audio === true ? 1 - SOUND_SHARE : 1) * read.made);
      }
    }
    emit("running", 0, { phase: "preparing the footage" });
    const started = performance.now();
    const folder = parent(output) ?? ".";
    /** Room for it now, as it starts (it may have waited in line a long while since it was asked for), and once the excerpts it reads are cut. */
    const roomNow = async () => {
      if (quiet || running.bytes === undefined) return;
      const bytes = running.bytes;
      let short = roomShort(bytes, running.review ?? 0, store.cacheDir(), folder);
      const make = async () => {
        if (room.make === null) return;
        try {
          await room.make(roomWanted(bytes, store.cacheDir(), folder) + (running.review ?? 0) + storage.keepFreeBytes(store.cacheDir()));
        } catch (error) {
          diag.warn("export", `making room for ${project.name}'s export: ${diag.messageOf(error)}`);
        }
        short = roomShort(bytes, running.review ?? 0, store.cacheDir(), folder);
      };
      if (short > 0) await make();
      // The export it copies from goes last, as at its start.
      if (short > 0 && room.make !== null && running.letReuseGo !== undefined) {
        running.letReuseGo();
        await make();
      }
      if (short > 0) throw new Error(diskFull(short));
    };
    // A speed sample (`fresh_fps`): rendered here from the start, every frame new, never restarted.
    let fresh = !quiet && options.format === "h264" && nothingToReuse(store.cacheDir(), running.chunks ?? id);
    let result: { ok: true } | { ok: false; error: string };
    /** What it failed on: an engine job given up on waits and is tried again by itself (`EngineAbandoned`). */
    let failedWith: unknown = null;
    try {
      await catchBugsAsync("the export", async () => {
        // Fetched back to reuse its chunks; gone again after if this export writes elsewhere.
        let restored: string | null = null;
        await roomNow();
        try {
          // Effects' renders made again (or fetched again) for this export: Edit's own files, never the person's to fix.
          const remade = new Set<string>();
          let remakes = 0;
          const remake = async (effect: { name: string; key: string; path: string; unreadable: boolean }) => {
            if (remakes >= REMAKES || seams.broll.remakeEffect === undefined) throw new Error(`the ${effect.name} effect's render couldn't be read, even after Edit made it again`);
            remakes += 1;
            fresh = false;
            diag.warn("export", `${project.name}: the ${effect.name} effect's render ${effect.unreadable ? "couldn't be read" : "isn't there"} (${effect.path}); making it again and carrying on from the chunks made`);
            // Never for ever, and never past a Cancel (Nov 20: an export that met a missing render waited at its prep for
            // as long as the render took, its Cancel too). The render goes on by itself either way: the edit plays it.
            const making = seams.broll.remakeEffect(id, effect.name, effect.key, effect.unreadable);
            making.catch(() => {});
            await untilDone(making, running.stop.signal, REMAKE_MS.value, () => new RemakeTimedOut(`making the ${effect.name} effect's render again`, REMAKE_MS.value, false));
            remade.add(effect.name);
          };
          // Its first start of the engine: room asked for again and the last export fetched back, once.
          let begun = false;
          // A stalled render (a read from the cloud that never answers: card 1's
          // export sat at 28% for seven minutes, Oct 29) is stopped and started
          // again by itself; the chunks it made are kept, so it carries on.
          let attempt = 0;
          // The engine's last progress, for the line said as a stalled render starts again.
          let engineAt = 0;
          for (;;) {
            let stalled = false;
            // Its renders read from where the edit has them now, should one have moved since it was taken (file_pins.ts
            // holds them from then on; a snapshot carried on after a restart, an export waiting in line).
            // Footage the person went on without plays nothing, its time kept (missing_media.playable): never a file it can't read.
            const reading = missingMedia.playable(store.home, located(project, store.get(id)?.project ?? null, remade));
            // Cloud footage: the originals, not the proxies (read from R2 for the export), signed afresh each try.
            let exported = reading;
            let originals: seams.Originals | null = null;
            try {
              [exported, originals] = await seams.cloudMedia.forExport(reading, plan.start, plan.end, store.cacheDir(), () => running.cancelled, onPrep, running.stop.signal);
            } catch (error) {
              if (!seams.isUnavailable(error)) throw error;
            }
            // A render it shows that isn't here any more: made again (or brought back) before the engine starts, never found
            // missing minutes in.
            const shown = new Set(exported.clips.map((clip) => (clip as { media?: unknown }).media).filter((media): media is string => typeof media === "string"));
            const gone = exported.media.find((media) => shown.has(media.id) && typeof media.effect === "string" && typeof media.effect_key === "string" && !media.path.includes("://") && !isFile(media.path));
            if (gone !== undefined) {
              originals?.release();
              if (running.cancelled) throw new Error("cancelled");
              await remake({ name: gone.effect!, key: gone.effect_key!, path: gone.path, unreadable: false });
              continue;
            }
            let unread: ReturnType<typeof effectIn> = null;
            try {
              let pending: string[] = [];
              try {
                pending = seams.broll.smoothingPending(exported.id);
              } catch (error) {
                if (!seams.isUnavailable(error)) throw error;
              }
              if (pending.length > 0) {
                diag.info(
                  "export",
                  `exporting current timeline snapshot; ${pending.length} optional optical-flow renders still pending`,
                );
              }
              if (running.cancelled) throw new Error("cancelled");
              if (!begun) await roomNow();
              if (!begun) {
                begun = true;
                let fetched = -1;
                restored = this.home === null ? null : await restorePrevious(store.cacheDir(), this.home, running.chunks ?? project.id, (key, dest) => cloud.download(key, dest, (got, size) => {
                  const ratio = size > 0 ? Math.min(1, Math.max(0, got / size)) : 0;
                  const pct = Math.round(ratio * 100);
                  if (pct === fetched) return;
                  fetched = pct;
                  tell(`fetching the last export, ${pct}%`, 0.85 + 0.15 * ratio);
                }, running.stop.signal), running.stop.signal);
                if (running.cancelled) throw new Error("cancelled");
              }
              // Prep is over. The encode fills from there to 1; leaving the ratio at the footage's 0.85 would end the bar at 97%.
              if (prepared) {
                prepRatio = 1;
                emit("running", shownProgress(1, null), { phase: "starting the export" });
              } else emit("running", 0, { phase: "starting the export" });
              const watch = new EngineWatch(project.name, () => running.cancelled);
              let last = -1;
              // The bar from the engine's fraction and what it writes (`ExportBar`), said as it reports and as it's looked at.
              let engineOn = true;
              const say = () => {
                if (!engineOn || quiet || !bar.ready) return;
                if (bar.made !== null) {
                  if (bar.made > 0) running.made = bar.made;
                  else delete running.made;
                }
                const phase = bar.phase;
                try {
                  // No phase while it renders: the line goes back to the percent, and a stale "cutting the footage" doesn't stick.
                  emit("running", shownProgress(prepared ? 1 : null, bar.encode), phase === undefined ? {} : { phase });
                } catch (error) {
                  diag.warn("export", `progress: ${diag.messageOf(error)}`);
                }
              };
              const looked = () => {
                if (quiet || !engineOn) return;
                void bar.look().then(say, (error: unknown) => diag.warn("export", `looking at the export's progress: ${diag.messageOf(error)}`));
              };
              bar.engineBegins(Date.now(), partialOf(output, exported.id, options.format));
              const job = native().ExportJob.start(
                { project: { json: jsonForSerde(exported) }, options, plan, output, cacheDir: store.cacheDir(), sounds: originals?.sounds ?? {}, excerpts: originals?.excerpts ?? [], ...(quiet ? { background: true } : {}) },
                (progress) => {
                  // Any change is movement: the engine trying its chunks again reports from lower down (Nov 2:
                  // Kroger's retry rendered 11 chunks yet "nothing new for 8 minutes", and was started over).
                  if (progress !== last) {
                    last = progress;
                    engineAt = progress;
                    watch.move();
                    // Where EngineWatch knows the render moves, the job table hears it too (Nov 21): a 2-hour edit's
                    // 30-minute render was noted only as it began, and read as still for most of it.
                    moving();
                  }
                  bar.hear(progress);
                  // Its plan is looked at once it has reported (it's written before the first frame), and said from then on.
                  if (!bar.ready) looked();
                  else say();
                },
              );
              running.job = job;
              if (running.cancelled) job.cancel();
              const looks = quiet ? null : setInterval(looked, barLooks.everyMs);
              let how: "ended" | "abandoned" = "ended";
              try {
                how = await watch.wait(job);
              } catch (error) {
                if (running.cancelled) throw error;
                if (!watch.stalled) {
                  // An effect's render it couldn't read is Edit's own file: made again, and the export carries on.
                  unread = effectIn(diag.messageOf(error), exported);
                  if (unread === null) throw error;
                }
              } finally {
                stalled = watch.stalled;
                engineOn = false;
                if (looks !== null) clearInterval(looks);
              }
              if (running.cancelled) throw new Error("cancelled");
              // Stopped and never ended (Nov 20): the export ends here, from the server's side, its place given back and
              // the work behind it free to go on. A fresh engine job may well go (a stuck VideoToolbox session is the
              // old job's), so it waits and is tried again by itself; twice in a run and it's the engine: quit Edit.
              if (how === "abandoned") throw engineStuck() ? new Error(STUCK_ENGINE) : new EngineAbandoned("the video's render", stall.ms);
              if (!stalled && unread === null) break;
            } finally {
              originals?.release();
            }
            if (unread !== null) {
              await remake(unread);
              continue;
            }
            fresh = false;
            attempt += 1;
            if (attempt >= stall.tries) throw new Error(`the export stopped moving ${stall.tries} times (nothing new for ${Math.round(stall.ms / 60_000)} minutes each)`);
            diag.warn("export", `${project.name}: nothing new for ${Math.round(stall.ms / 60_000)} minutes; starting it again (the chunks made are kept)`);
            // Said, so the bar's line isn't the percent it stood still at (Nov 20).
            emit("running", shownProgress(prepared ? 1 : null, Math.max(0, engineAt)), { phase: "starting the render again" });
          }
        } finally {
          if (restored !== null && restored !== output) fs.rmSync(restored, { force: true });
        }
      });
      if (!quiet) {
        this.finished = this.finished.filter((done) => done !== output);
        this.finished.push(output);
        this.finished.splice(0, Math.max(this.finished.length - KEEP_FINISHED, 0));
      }
      result = { ok: true };
    } catch (error) {
      // The disk ran out under it: said as what to free (the room it needed less what's free now).
      const short = (running.bytes ?? 0) + (running.review ?? 0) - freeOn(store.cacheDir());
      result = { ok: false, error: outOfSpace(error) && !running.cancelled && !diag.messageOf(error).startsWith("Your disk is full") ? diskFull(short) : diag.messageOf(error) };
      failedWith = error;
    } finally {
      // Archiving/uploading a completed file doesn't occupy the renderer, nor hold what it read.
      running.unpin?.();
      releaseLocal?.();
    }
    const frames = Math.max(plan.end - plan.start, 0);
    const took = performance.now() - started;
    /** The finished file's upload to the cloud, started once the project is free again. */
    let upFromHere: (() => Promise<void>) | null = null;
    if (quiet) {
      // Made ahead: its chunks wait in the project's chunk folder (its manifest names this file) for the export someone asks for.
      if (result.ok) {
        diag.info("export", `${project.name}: made its export ahead, ${frames} frames in ${diag.human(took)}, for the next export or share to reuse`);
        try {
          writeAtomic(`${output}.json`, JSON.stringify({ timeline: running.timeline, options: running.options, made_ms: nowMs() }));
        } catch (error) {
          diag.warn("export", `${project.name}: noting its export made ahead: ${diag.messageOf(error)}`);
        }
      } else if (!running.cancelled) {
        diag.warn("export", `${project.name}: making its export ahead: ${result.error}`);
      }
      if (this.jobs.get(id) === running) this.jobs.delete(id);
      return;
    }
    // Asked for and made: one made ahead of this project's is spent (this export's manifest is the one now).
    if (result.ok && running.stretch !== true) aheadSpent(store.cacheDir(), id, output);
    if (result.ok) {
      diag.info(
        "export",
        `${project.name} exported ${frames} frames in ${diag.human(took)} (${fixed(frames / Math.max(took / 1000, 1e-3), 1)} frames/s) to ${output}`,
      );
      diag.record("export", "export", took, null);
      // This computer's pace, for the next export's time (export_speeds.ts).
      if (this.home !== null && running.stretch !== true) speeds.noteExport(this.home, frames, took / 1000);
      let bytes: number | null = null;
      try {
        bytes = fs.statSync(output).size;
      } catch {
        // Gone already.
      }
      emit("done", 1, { seconds: (performance.now() - started) / 1000, bytes, drive: upload });
      this.held.delete(id);
      try {
        remember(this.home ?? store.home, id, {
          path: output,
          name: fileName(output) ?? output,
          finished_ms: nowMs(),
          seconds: took / 1000,
          bytes,
          frames,
          whole: plan.start === 0 && plan.end >= duration(project),
          start: plan.start,
          format: options.format,
          ...(fresh && frames >= SPEED_FRAMES
            ? { fresh_fps: Math.round((frames / (took / 1000)) * 10) / 10, subtitles: subtitleVideo(project) }
            : {}),
          timeline: running.timeline,
        });
        fs.mkdirSync(join(this.home ?? store.home, "export-maps"), { recursive: true });
        writeAtomic(mapFile(this.home ?? store.home, running.timeline), JSON.stringify(running.clips ?? clipMap(project)));
      } catch (error) {
        diag.warn("export", `couldn't list ${output}: ${diag.messageOf(error)}`);
      }
      // Cloud is canonical: upload, verify by size, then delete the local
      // file. Skipped when Drive will read the file next, or on request.
      if (!upload && !running.keepLocal && exportCloud.enabled()) {
        const key = exportCloudKey(id, fileName(output) ?? "export.mp4");
        const record: ExportRecord = {
          path: output, name: fileName(output) ?? output, finished_ms: nowMs(), seconds: took / 1000, bytes,
          frames, whole: plan.start === 0 && plan.end >= duration(project), start: plan.start, format: options.format, timeline: running.timeline, cloudKey: key,
        };
        // The export is done: its file is whole and listed. The archive is a job of its own, so a restart
        // meanwhile sends the file again instead of exporting it again (Nov 3: Kroger, 77 minutes, started
        // over from nothing by a restart during its upload); handed over in one write, so no crash falls between.
        // A share's export goes up once, as its review's `full.mp4` (`BEHIND_SHARE`): its row waits behind the share,
        // and is its own (keyed by its file), so a plain export of the project ending meanwhile never crosses it off.
        const share = running.share === true;
        const archive = jobs.handOff(this.home, running.key, { kind: "archive", project: id, args: { output, key, record, ...(share ? { share: true } : {}) }, ...(share ? { part: output } : {}), step: "uploading" });
        // It goes up once the project is free again (below): while it was awaited here the project stayed
        // "exporting" for the whole upload, so a share of it waited (or, before nightly-69, was refused: JJ's Mac,
        // Nov 9, "this project already has an export running" 15 times in the 17 minutes one took), other work
        // took the encoder for busy, and background work stayed paused.
        upFromHere = () => this.archive(store.home, id, output, key, record, archive);
      }
    } else if (running.cancelled) {
      diag.info("export", `${project.name} export cancelled`);
      emit("cancelled", 0, { error: result.error });
    } else {
      diag.record("export", "export", took, `${project.name}: ${result.error}`);
      emit("failed", 0, { error: result.error });
      // The engine never ended a job it was told to stop, or an effect's render took too long to make again: it waits
      // and goes again by itself, a fresh job (jobs.ts `wait`, the export resumer), as trouble that passes.
      if (failedWith instanceof EngineAbandoned || failedWith instanceof RemakeTimedOut) jobs.wait(this.home, running.key, failedWith);
      // The line dropped while it read its footage from the cloud (failure.ts knows the words: nothing it doesn't
      // recognise waits here, an export's own refusals are plain errors): it waits and goes again by itself, at once
      // when the cloud answers again, with the chunks it made (Nov 21, bad-day cold-export-drop: three tries in 25
      // seconds of a two-minute drop, then "failed" and a Retry to press; in Sphe's log on mandalorian the same
      // "could not decode <url> failed to fill whole buffer" ended exports 26 times in two days).
      else if (failure.surely(failedWith ?? result.error) === "passing") {
        diag.warn("export", `${project.name}: the connection dropped under the export (${result.error.slice(0, 160)}); it waits and goes again by itself`);
        jobs.wait(this.home, running.key, new Error(`could not reach the footage in the cloud: the connection dropped while ${project.name} was exporting`));
      }
      // Kept, failed, for the next build to try again (retry_after_update.ts).
      else jobs.settle(this.home, running.key, "failed", { error: result.error, build: BUILD, args: { name: project.name, ...(upload ? { drive: true } : {}) } });
    }
    this.jobs.delete(id);
    if (!(result.ok === false && !running.cancelled)) jobs.end(this.home, running.key);
    // The timeline it was started with stays for an export that waits to go again (it's made from that, not from
    // edits made meanwhile, and never "as the edit is now" for want of it).
    const waits = result.ok === false && !running.cancelled && jobs.get(this.home, running.key)?.state === "waiting";
    if (running.snapshot !== null && !waits) fs.rmSync(running.snapshot, { force: true });
    if (upload && result.ok) {
      try {
        seams.drive.start(store, library, project, output);
      } catch (error) {
        diag.warn("drive", `${project.name}: ${diag.messageOf(error)}`);
      }
    }
    await upFromHere?.();
  }

  /** Sends a finished export to the cloud as its `archive` job: crossed off once it's up (or stopped, or its file gone), put off and tried again by itself when it isn't. */
  private async archive(home: string, id: string, output: string, key: string, record: ExportRecord, job: string): Promise<void> {
    await archiveJob(this.home, job, () => this.sendUp(this.home ?? home, id, output, key, record));
  }
}


/**
 * About how many bytes an export's file is, by the engine's own rate
 * (export.rs `video_bitrate`: pixels × fps × bits a pixel for the quality,
 * HEVC 60%, a target size as given; ProRes ~2.5 bits a pixel) and its sound.
 * Audio and stills are small: 0.
 */
export function exportBytes(options: ExportOptions, plan: Plan, fps: number): number {
  if (!["h264", "hevc", "prores"].includes(options.format)) return 0;
  const seconds = Math.max((plan.end - plan.start) / Math.max(fps, 1), 0);
  const pixels = plan.width * plan.height * fps;
  const bits = { high: 0.14, balanced: 0.08, small: 0.045 }[options.quality];
  const video =
    options.format === "prores" ? pixels * 2.5 : options.target_mb != null ? (options.target_mb * 8_000_000) / Math.max(seconds, 1) : pixels * bits * (options.format === "hevc" ? 0.6 : 1);
  const audio = plan.audio ? 256_000 : 0;
  return Math.ceil(((video + audio) / 8) * seconds);
}

const GB = 1e9;

/** Frees room on the cache's disk until `wanted` bytes are free, as far as the cache can give (cache_cleanup.ts `makeRoom`, set by serve.ts; none in tests). */
export const room = {
  /** Awaited (Nov 21): the cleaner's pass gives the server's thread back as it goes (cache_cleanup.ts `makeRoomAsync`); it held it for seconds. */
  make: null as ((wanted: number) => void | Promise<void>) | null,
  /** The bytes free on the disk holding a path (statfs; tests stand in for it). */
  free: (path: string): number => freeAt(path),
};

/** The free bytes an export of `bytes` needs on the cache's disk (`roomFor`'s sum for it). */
export function roomWanted(bytes: number, cacheDir: string, outputDir: string, device: (path: string) => number = deviceOf): number {
  return Math.max(bytes * 0.1, GB) + bytes * (device(cacheDir) === device(outputDir) ? 2 : 1);
}

/** About how big a share's review copy of `seconds` is (reviews.ts `reviewCopy`: 720p at 3 Mbit/s, the sound at 128k). */
export function reviewBytes(seconds: number): number {
  return Math.ceil(seconds * ((3_000_000 + 128_000) / 8) * 1.1);
}

/**
 * How many bytes the disks are short of for an export of `bytes` as it starts
 * (0: there's room): its chunks in `cacheDir` with a share's review copy
 * (`review`) beside them, joined into a file in `outputDir`, with a margin of
 * a tenth or a gigabyte; the excerpts it reads are on the disk already when
 * it's asked again after they're cut.
 */
export function roomShort(bytes: number, review: number, cacheDir: string, outputDir: string, free: (path: string) => number = room.free, device: (path: string) => number = deviceOf): number {
  if (bytes <= 0 && review <= 0) return 0;
  const margin = Math.max(bytes * 0.1, GB);
  const need = new Map<number, { path: string; bytes: number }>();
  for (const [path, more] of [[cacheDir, bytes + review], [outputDir, bytes]] as const) {
    const disk = device(path);
    const had = need.get(disk);
    need.set(disk, { path: had?.path ?? path, bytes: (had?.bytes ?? margin) + more });
  }
  let short = 0;
  for (const { path, bytes: wanted } of need.values()) short = Math.max(short, wanted - free(path));
  return short;
}

/**
 * Why the disks can't hold an export of `bytes`, or null: its chunks go in
 * `cacheDir`, then are joined into a file in `outputDir` (both on one disk:
 * twice the room), with a margin of a tenth or a gigabyte.
 */
export function roomFor(bytes: number, cacheDir: string, outputDir: string, free: (path: string) => number = room.free, device: (path: string) => number = deviceOf): string | null {
  if (bytes <= 0) return null;
  const margin = Math.max(bytes * 0.1, GB);
  const need = new Map<number, { path: string; bytes: number }>();
  for (const path of [cacheDir, outputDir]) {
    const disk = device(path);
    const had = need.get(disk);
    need.set(disk, { path: had?.path ?? path, bytes: (had?.bytes ?? margin) + bytes });
  }
  for (const { path, bytes: wanted } of need.values()) {
    const has = free(path);
    if (has < wanted) {
      // In one line with the numbers, before anything is written (storage.ts `roomLine`); an export folder on another disk is named.
      const what = path === cacheDir || device(path) === device(cacheDir) ? "This export" : `This export (into ${path})`;
      return storage.roomLine(what, wanted, has, "export it again, or export a shorter span, a smaller size or a lower quality");
    }
  }
  return null;
}

function freeAt(path: string): number {
  try {
    const stats = fs.statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function deviceOf(path: string): number {
  try {
    return fs.statSync(path).dev;
  } catch {
    return -1;
  }
}
