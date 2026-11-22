// The cache kept to what's used (Oct 18): an 8 GB Mac's disk filled
// with previews of footage no project uses any more, and a half-written
// 1.6 GB preview an interrupted run left behind.
//
// Media folders (`<cache>/<media key>/`) of media no saved project uses lose
// what's made again cheaply (previews, thumbnails, waveforms, loudness and
// censor analysis); what cost money to make (transcripts, watch answers,
// seats, faces) stays, so a project that brings the footage back pays
// nothing again. Half-written files a day old go wherever they are. Nothing
// touched in the last two days is removed.
//
// Footage projects still used kept its previews forever, though (Oct 21: a
// Mac's disk full with 36 GB of cache). Until Nov 18 the cache was kept
// under a budget (a quarter of the room, 400 MB to 50 GB) by the least
// recently used copy. Now (the local-first plan, Sphe, Nov 18: "storage
// follows the project's state, automatically, with no settings") it follows
// each project's state, from the ledger of every file here by project and
// kind (ledger.ts):
//
// - In work: open now, or anything running for it (busy.ts `workingFor`: a
//   turn, an export, a removal, an effect's render, a job), or any of its
//   files not yet in R2 (an upload pending or under way, media Edit made
//   that hasn't gone up); else, unless it's done, opened here in the last 3
//   days (or saved: an agent's turn with the editor closed). Everything of
//   it stays.
// - Idle: its derived copies go first when room is needed (export chunks,
//   pieces, excerpts, sound and scrub copies, smooth playback renders), then
//   its proxies. Whole projects, the one worked on
//   longest ago first, before any project in work is touched.
// - Done on Home, or idle 7 days: its local footage goes at each pass, room
//   needed or not, its originals only once R2 has said it holds them at their
//   size (`confirmOriginals`), never a file from someone's disk (only Edit's
//   own copies are ever taken: ledger.ts `evictable`). Opened again, it comes
//   back as any cloud footage does (footage_ready.ts: "Getting the footage
//   ready", with its progress).
// - Script mode's copies of its recordings (writer/streamed.ts, Nov 21): kept
//   so Start the edit cuts from them; for room only, after nobody's copies and
//   before any project's (first of all when work asks for room and they alone
//   make it: `makeRoom`), oldest-unused first, each once R2 has said it holds
//   it and never while it's cut from (`ledger.scriptCopies`).
//
// The disk is kept with what Edit keeps free on it (storage.ts
// `keepFreeBytes`: 15 GB); only with it under the
// cache's hard floor does a project in work give up copies, never one open in
// the last ten minutes nor one with work running. Whole proxy copies are the
// footage this Mac plays and renders from: they go only this way, never
// because R2 has them too. Pinned files (file_pins.ts), uploads not landed
// and anything written in the last hours always stay.
//
// The server's own passes (the hourly one, and room asked for with
// `makeRoomAsync`) run gently (Nov 21): each kept the server's one thread for
// 3 to 4.4 s every hour on Sphe's Linux Edit (14,000 cached files; mostly
// every script.json read and parsed twice a pass, 381 MB of JSON), and a
// MacBook Air's for 2 s in one native `mediaKey`. A pass is written once, as
// steps that touch the disk (`Steps`): `run` does them at once on the thread
// (`cleanCache`, `makeRoom`: callers that need the answer before they go on),
// `gently` off it, with a breath every few milliseconds (thread.ts). What a pass
// reads again each hour (scripts' originals, projects' media, media keys) is
// kept by each file's stamp and read again only once the file has changed.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import { playbackKey, playbackPath } from "./cloud_playback.ts";
import { Semaphore } from "./semaphore.ts";
import * as diag from "./diag.ts";
import * as thread from "./thread.ts";
import * as drive from "./drive.ts";
import { beingRead } from "./exports.ts";
import * as retention from "./export_retention.ts";
import * as later from "./later.ts";
import { exportRoots } from "./export_folder.ts";
import * as reviews from "./reviews.ts";
import { carryAnalysis, localPath, readLocalOriginals, uploadingNow, uploadsNow, writeLocalOriginals } from "./cloud_media.ts";
import { createHash } from "node:crypto";

import * as busy from "./busy.ts";
import { pinned } from "./file_pins.ts";
import * as ledgerOf from "./ledger.ts";
import type { Entry } from "./ledger.ts";
import { evicted as nativeEvicted, oldCuts } from "./native_preview.ts";
import { openedTimes } from "./opened.ts";
import { join } from "./paths.ts";
import * as folderAccess from "./folder_access.ts";
import * as research from "./research.ts";
import * as writerStore from "./writer/store.ts";
import * as localRoom from "./local_first_room.ts";
import type { Project } from "./model.ts";
import { CACHE_FLOOR_BYTES, FREE_FLOOR_BYTES, diskHooks, keepFreeBytes, ledger } from "./storage.ts";

/** A step of a pass that touches the disk, or gives the thread back (`breath`); what each answers is in `answerNow`. */
type Op =
  | { op: "breath" }
  | { op: "stat" | "lstat" | "list" | "read"; path: string }
  | { op: "rm"; path: string; recursive: boolean }
  | { op: "walk"; roots: ledgerOf.Root[] };

/** A pass, or a part of one: yields its steps, is answered each, returns `T`. */
type Steps<T> = Generator<Op, T, unknown>;

const BREATH: Op = { op: "breath" };

/** The step answered at once, on the thread (as the cleaner always did). */
function answerNow(op: Op): unknown {
  try {
    switch (op.op) {
      case "breath":
        return undefined;
      case "stat":
        return fs.statSync(op.path);
      case "lstat":
        return fs.lstatSync(op.path);
      case "list":
        return fs.readdirSync(op.path);
      case "read":
        return fs.readFileSync(op.path, "utf8");
      case "rm":
        fs.rmSync(op.path, op.recursive ? { recursive: true, force: true } : {});
        return null;
      case "walk":
        return ledgerOf.walkSync(op.roots);
    }
  } catch (error) {
    // A stat, list or read that fails answers null; a removal that fails answers its error.
    return op.op === "rm" ? (error instanceof Error ? error : new Error(String(error))) : null;
  }
}

/** The step answered off the thread (fs.promises: the disk's wait is libuv's, never the server's). */
async function answerLater(op: Op): Promise<unknown> {
  try {
    switch (op.op) {
      case "breath":
        return undefined;
      case "stat":
        return await fs.promises.stat(op.path);
      case "lstat":
        return await fs.promises.lstat(op.path);
      case "list":
        return await fs.promises.readdir(op.path);
      case "read":
        return await fs.promises.readFile(op.path, "utf8");
      case "rm":
        await fs.promises.rm(op.path, op.recursive ? { recursive: true, force: true } : {});
        return null;
      case "walk":
        return await ledgerOf.walkInOrder(op.roots);
    }
  } catch (error) {
    return op.op === "rm" ? (error instanceof Error ? error : new Error(String(error))) : null;
  }
}

/** A pass run at once: every step on the thread, start to end (the answer is wanted before the caller goes on). */
function atOnce<T>(steps: Steps<T>): T {
  let next = steps.next();
  while (next.done !== true) next = steps.next(answerNow(next.value));
  return next.value;
}

/** A pass run gently: each step off the thread, and the rest of Edit given its turn every few milliseconds. */
async function gently<T>(steps: Steps<T>): Promise<T> {
  const breathe = thread.breather();
  let next = steps.next();
  while (next.done !== true) {
    const op = next.value;
    if (op.op === "breath") {
      await breathe();
      next = steps.next(undefined);
    } else next = steps.next(await answerLater(op));
  }
  return next.value;
}

function* statOf(path: string): Steps<fs.Stats | null> {
  return (yield { op: "stat", path }) as fs.Stats | null;
}

function* lstatOf(path: string): Steps<fs.Stats | null> {
  return (yield { op: "lstat", path }) as fs.Stats | null;
}

/** A folder's names; null when it won't list. */
function* listOf(path: string): Steps<string[] | null> {
  return (yield { op: "list", path }) as string[] | null;
}

/** A folder's names; none when it won't list. */
function* namesIn(path: string): Steps<string[]> {
  return (yield* listOf(path)) ?? [];
}

function* textOf(path: string): Steps<string | null> {
  return (yield { op: "read", path }) as string | null;
}

/** Removes `path` (a folder whole with `recursive`, gone already is no fault then); its error, or null. */
function* rmOf(path: string, recursive: boolean): Steps<Error | null> {
  return (yield { op: "rm", path, recursive }) as Error | null;
}

/** A file as it is now: one with the same stamp is the same file, unchanged (an atomic write is a new inode). */
const stampOf = (stat: fs.Stats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

/**
 * What a file says, kept by its stamp: read and worked out again only once the file has changed (`fresh`), and only
 * kept when it didn't change while it was read. Each pass keeps only the files it looked at (`prune`).
 */
class ByStamp<T> {
  private known = new Map<string, { stamp: string; value: T }>();
  private looked = new Set<string>();

  /** `fresh(text)` of the file at `path`, or what it was last time it had this stamp; null when it won't read. */
  *of(path: string, fresh: (text: string) => T): Steps<{ value: T; stat: fs.Stats } | null> {
    this.looked.add(path);
    const stat = yield* statOf(path);
    if (stat === null) {
      this.known.delete(path);
      return null;
    }
    const stamp = stampOf(stat);
    const known = this.known.get(path);
    if (known !== undefined && known.stamp === stamp) return { value: known.value, stat };
    const text = yield* textOf(path);
    if (text === null) return null;
    const value = fresh(text);
    const after = yield* statOf(path);
    if (after !== null && stampOf(after) === stamp) this.known.set(path, { stamp, value });
    return { value, stat };
  }

  /** What a pass that looked at every file kept: the rest forgotten (files gone, projects deleted). */
  prune(): void {
    for (const path of this.known.keys()) if (!this.looked.has(path)) this.known.delete(path);
    this.looked.clear();
  }
}

/**
 * A project file's media list (whatever it holds: each reader checks it) and when it went to Drive, or `bad` when it
 * isn't JSON.
 */
const projectMedia = new ByStamp<{ media: unknown; driveAt: number | null; local: localRoom.Footage[] } | "bad">();
const mediaOfText = (text: string): { media: unknown; driveAt: number | null; local: localRoom.Footage[] } | "bad" => {
  try {
    const value = JSON.parse(text) as { media?: unknown; drive?: { uploaded_ms?: unknown } | null } | null;
    // A file of `null` stops a pass as one that won't parse does (reading `.media` of it threw).
    if (value === null) return "bad";
    const at = typeof value.drive === "object" && value.drive !== null ? value.drive.uploaded_ms : undefined;
    // A local-first project's sources and what its timeline uses of each (local_first_room.ts), worked out once a save.
    let local: localRoom.Footage[] = [];
    try {
      local = localRoom.footageOf(value as Project);
    } catch {
      local = [];
    }
    return { media: value.media, driveAt: typeof at === "number" ? at : null, local };
  } catch {
    return "bad";
  }
};

/** A script's original (`originalPath`), or null when it has none or won't read (writer/store.ts `originals`). */
const scriptOriginal = new ByStamp<unknown>();
const originalOfText = (text: string): unknown => {
  try {
    const value = JSON.parse(text) as { originalPath?: unknown } | null;
    return value === null || typeof value !== "object" ? null : value.originalPath;
  } catch {
    return null;
  }
};

/**
 * The files scripts here play from, as writer/store.ts `originals` reads them, each script.json read again only once
 * it's been saved since (Nov 21: all 126 of Sphe's, 381 MB, the largest 12.9 MB, were read and parsed twice a pass).
 */
function* scriptOriginals(home: string): Steps<Set<string>> {
  const data = writerStore.dataDir(home);
  const out = new Set<string>();
  for (const id of writerStore.ids(data)) {
    yield BREATH;
    const found = yield* scriptOriginal.of(join(writerStore.scriptDir(data, id), "script.json"), originalOfText);
    const original = found?.value;
    if (original) out.add(original as string);
  }
  scriptOriginal.prune();
  return out;
}

/**
 * Media keys (the native `mediaKey`: a hash of the path, the file's size and time) kept by the file's stamp: the
 * addon is asked only for a file not keyed since it last changed, and only once a stat off the thread has found it
 * (Nov 21, a MacBook Air: one `mediaKey` kept the server's thread 2 s, the file's disk waking). A path the addon keys
 * without its file (a playback address) is kept by the path alone.
 */
const keys = new Map<string, { stamp: string; key: string }>();
const keysLooked = new Set<string>();

/**
 * Whether `path` is a file here, and its media key (null when the addon can't key it, or, unless `always`, when
 * there's no file to key).
 */
function* keyOf(app: App, path: string, always: boolean): Steps<{ exists: boolean; key: string | null }> {
  keysLooked.add(path);
  const address = playbackKey(path) !== null;
  const stat = address ? null : yield* statOf(path);
  if (!address && stat === null && !always) return { exists: false, key: null };
  const stamp = address ? "address" : stat === null ? "none" : stampOf(stat);
  const known = keys.get(path);
  if (known !== undefined && known.stamp === stamp) return { exists: stat !== null, key: known.key };
  let key: string;
  try {
    key = app.native.mediaKey(path);
  } catch {
    keys.delete(path);
    return { exists: stat !== null, key: null };
  }
  const after = address ? null : yield* statOf(path);
  if ((address ? "address" : after === null ? "none" : stampOf(after)) === stamp) keys.set(path, { stamp, key });
  return { exists: stat !== null, key };
}

function pruneKeys(): void {
  for (const path of keys.keys()) if (!keysLooked.has(path)) keys.delete(path);
  keysLooked.clear();
}

/** Made again cheaply from the source. */
const REBUILT = /^(preview|thumbs|peaks|loudness|censor|light)/;
/** A write that never finished. */
const PARTIAL = /\.partial([.-]|$)|\.sb-[0-9a-f]+-/;
const DAY = 24 * 3600 * 1000;
/** Recently touched: maybe in use right now. */
const RECENT = 2 * DAY;
/** A cloud copy this new may be uploading or playing. */
const COPY_RECENT = 6 * 3600 * 1000;
/** A Drive download (its original in the cloud) not read by an export for this long goes. */
const DOWNLOADED = 3 * DAY;
/** A project worked on here this lately is in work: all of it stays. */
export const IN_WORK_MS = 3 * DAY;
/** A project not worked on here for this long is let go as a done one is: its footage too, its originals once R2 has them. */
export const LET_GO_MS = 7 * DAY;
/** With the disk under the cache's hard floor, only a project open this lately (or with work running) keeps its copies. */
const OPEN_NOW = 10 * 60 * 1000;

/** What a pass keeps the disk to: `freeBytes` free once it's done (`free` overrides the disk's free space now). */
export interface Limits {
  freeBytes: number;
  free?: number;
  /** Every file under the cache and the media, when the caller has just walked them (ledger.ts): not walked again. */
  entries?: Entry[];
  /** Originals R2 has said it holds at their size (`confirmOriginals`): only these of a done project's go. */
  confirmed?: Set<string>;
}

export interface CleanReport {
  folders: number;
  files: number;
  bytes: number;
  removed: string[];
}

/**
 * Remove the legacy previews (`preview*.mp4/m4a` in media-key folders) of
 * footage whose proxy R2 acknowledges. Originals, paid analysis, directly
 * referenced local media, and unfinished uploads are never candidates. HEAD
 * is required, not just project metadata.
 *
 * A whole proxy copy here (`cloud/proxies/…`) is never one: it's the footage
 * this Mac plays and renders from (the native player, the agent's renders:
 * local_previews.ts), kept until the cache is past its budget (`cleanCache`).
 * Until Nov 8 this removed every copy R2 also had (the Oct 29 "everything on
 * the cloud" policy): on Sphe's Mac `cache/cloud/proxies` was empty, the same
 * whole preview was fetched up to 8 times, and every frame streamed.
 */
export async function cleanCloudPreviews(
  app: App,
  dryRun: boolean,
  head: (key: string) => Promise<{ size: number } | null> = (key) => cloud.head(key),
): Promise<CleanReport> {
  const report: CleanReport = { folders: 0, files: 0, bytes: 0, removed: [] };
  const cache = app.store.cacheDir();
  const found = await gently(previewSources(app, dryRun));
  if (found === null) return report;
  const { paths, sources } = found;
  const pending = pendingUploads(app.store.home);
  if (pending === null) return report;
  const removed = new Set<string>();
  const slots = new Semaphore(3);
  const candidatesWithFiles = await gently(withPreviews(cache, sources));
  const confirmedKeys = new Map(await Promise.all(candidatesWithFiles.map(([key]) => slots.with(async () => {
    try { return [key, await head(key)] as const; } catch { return [key, null] as const; }
  }))));
  await gently((function* (): Steps<void> {
    for (const [key, aliases] of sources) {
      yield BREATH;
      const confirmed = confirmedKeys.get(key) ?? null;
      if (confirmed === null || confirmed.size <= 0) continue;
      const candidates = new Set<string>();
      for (const alias of aliases) {
        const dir = join(cache, alias);
        for (const name of yield* namesIn(dir)) if (/^preview(?:-light)?\.(?:mp4|m4a|done)$/.test(name)) candidates.add(join(dir, name));
      }
      for (const path of candidates) {
        yield BREATH;
        if (removed.has(path) || paths.has(path) || pending.has(path) || uploadingNow(path)) continue;
        const stat = yield* lstatOf(path);
        if (stat === null || !stat.isFile()) continue;
        // A concurrent job finished or removed it: not counted.
        if (!dryRun && (yield* rmOf(path, false)) !== null) continue;
        removed.add(path);
        report.files += 1;
        report.bytes += stat.size;
        if (report.removed.length < 50) report.removed.push(path);
      }
    }
  })());
  report.folders = new Set([...removed].map((path) => path.slice(0, path.lastIndexOf("/")))).size;
  return report;
}

/**
 * `cleanCloudPreviews`' reading of the projects: the paths they use directly, and each cloud proxy's media keys (its
 * aliases), older keys carried with analysis followed; null when a project won't read (then nothing is known unused).
 */
function* previewSources(app: App, dryRun: boolean): Steps<{ paths: Set<string>; sources: Map<string, Set<string>> } | null> {
  const cache = app.store.cacheDir();
  const paths = new Set<string>();
  const sources = new Map<string, Set<string>>();
  const add = (key: string, alias: string) => {
    let aliases = sources.get(key);
    if (aliases === undefined) sources.set(key, aliases = new Set());
    aliases.add(alias);
  };
  // Read the saved locations before store.get normalises them for playback.
  // An unreadable project makes the reference set incomplete: keep everything.
  const dir = join(app.store.home, "projects");
  for (const name of (yield* namesIn(dir)).filter((name) => name.endsWith(".json"))) {
    yield BREATH;
    const read = yield* projectMedia.of(join(dir, name), mediaOfText);
    if (read === null || read.value === "bad") return null;
    try {
      for (const media of (read.value.media ?? []) as { path: string; kind: string; cloud?: { proxy?: string } | null }[]) {
        yield BREATH;
        if (typeof media.path !== "string") return null;
        if (media.cloud?.proxy === undefined || !cloud.validKey(media.cloud.proxy)) {
          paths.add(media.path);
          continue;
        }
        if (media.kind === "image") continue;
        const key = media.cloud.proxy;
        const keyed = [yield* keyOf(app, media.path, true), yield* keyOf(app, localPath(cache, key), true), yield* keyOf(app, playbackPath(key, app.port), true)];
        // The addon couldn't key one: as when it threw, nothing is known unused.
        if (keyed.some((one) => one.key === null)) return null;
        for (const one of keyed) add(key, one.key as string);
        // Carry paid analysis before the old proxy's metadata (and key) goes; with no folder of the original's key
        // there's nothing to carry (cloud_media.ts `carryAnalysis` finds no analysis files and does nothing).
        if (!dryRun && (yield* statOf(join(cache, keyed[0]!.key as string))) !== null) carryAnalysis(cache, media.path, playbackPath(key, app.port));
      }
    } catch {
      return null;
    }
  }
  // Analysis carried from an original records its older media keys. Follow
  // those aliases so migrating a project doesn't strand its old previews.
  for (const aliases of sources.values()) {
    for (const alias of aliases) {
      yield BREATH;
      const text = yield* textOf(join(cache, alias, "watch", "keys.json"));
      if (text === null) continue;
      try {
        const value = JSON.parse(text) as { keys?: unknown };
        if (Array.isArray(value.keys)) for (const key of value.keys) if (typeof key === "string" && /^[0-9a-f]{16}$/.test(key)) aliases.add(key);
      } catch { /* no older analysis */ }
    }
  }
  return { paths, sources };
}

/** The proxies with a legacy preview in one of their aliases' folders. */
function* withPreviews(cache: string, sources: Map<string, Set<string>>): Steps<[string, Set<string>][]> {
  const out: [string, Set<string>][] = [];
  for (const [key, aliases] of sources) {
    for (const alias of aliases) {
      yield BREATH;
      if ((yield* namesIn(join(cache, alias))).some((name) => /^preview(?:-light)?\.(?:mp4|m4a)$/.test(name))) {
        out.push([key, aliases]);
        break;
      }
    }
  }
  return out;
}

/**
 * The files whose uploads are noted in `<home>/jobs.json` and not done yet (each the only copy until it lands: a
 * proxy made here, an original Edit downloaded) and the keys they go to; null when the file won't read (then any
 * might be one).
 */
function pendingUploads(home: string): Set<string> | null {
  const pending = new Set<string>();
  try {
    const jobs = JSON.parse(fs.readFileSync(join(home, "jobs.json"), "utf8")) as { kind: string; state?: string; args?: { local?: unknown; file?: unknown; originalKey?: unknown; proxy?: unknown } }[];
    for (const job of jobs) {
      if (job.kind !== "upload" || job.state === "done") continue;
      for (const one of [job.args?.local, job.args?.file, job.args?.originalKey, job.args?.proxy]) if (typeof one === "string") pending.add(one);
    }
  } catch {
    if (fs.existsSync(join(home, "jobs.json"))) return null;
  }
  return pending;
}

/** Bytes under `path`, each file once however many hard links it has (a proxy and its preview are one file). */
function* sizeOf(path: string, seen = new Set<string>(), known?: fs.Stats): Steps<number> {
  yield BREATH;
  const stat = known ?? (yield* statOf(path));
  if (stat === null) return 0;
  if (!stat.isDirectory()) {
    const inode = `${stat.dev}:${stat.ino}`;
    if (seen.has(inode)) return 0;
    seen.add(inode);
    return stat.size;
  }
  let total = 0;
  for (const name of yield* namesIn(path)) total += yield* sizeOf(join(path, name), seen);
  return total;
}

function* ageOf(path: string, now: number): Steps<number> {
  const stat = yield* statOf(path);
  return stat === null ? 0 : now - stat.mtimeMs;
}

/**
 * Every saved project's media paths and their media keys (`mediaKey`), read
 * from the project files (not loaded as live projects: no memory kept, no
 * media work started). Null when a project file won't read: then nothing it
 * might use is known, so everything counts as used.
 */
function* used(app: App, pending: Set<string> | null): Steps<Used | null> {
  const paths = new Set<string>();
  // Files a project uses that aren't here: their key can't be known.
  let missing = 0;
  const keys = new Set<string>();
  // Each key's latest save of a project using it.
  const saved = new Map<string, number>();
  const projects = new Map<string, UsedProject>();
  const keyProjects = new Map<string, Set<string>>();
  const pathProjects = new Map<string, Set<string>>();
  const home = app.store.home;
  const goingUp = new Set(uploadsNow().flatMap((one) => [one.file, one.originalKey, ...(one.proxy === null ? [] : [one.proxy])]));
  const notUp = (one: unknown) => typeof one === "string" && (pending === null || pending.has(one) || goingUp.has(one) || uploadingNow(one));
  const dir = join(home, "projects");
  for (const name of (yield* namesIn(dir)).filter((name) => name.endsWith(".json"))) {
    yield BREATH;
    const read = yield* projectMedia.of(join(dir, name), mediaOfText);
    if (read === null || read.value === "bad") {
      diag.warn("cache", `${name} won't read, so nothing it might use is cleaned`);
      return null;
    }
    const at = read.stat.mtimeMs;
    const media = (Array.isArray(read.value.media) ? read.value.media : []) as { path?: unknown; kind?: unknown; cloud?: { source?: unknown; original?: unknown; proxy?: unknown } | null }[];
    const id = name.slice(0, -".json".length);
    const project: UsedProject = { saved: at, tokens: new Set(), blocks: new Set(), unconfirmed: false, local: read.value.local };
    projects.set(id, project);
    for (const item of media) {
      yield BREATH;
      const cloudMedia = item.cloud;
      // Whether its file is here, and its key: looked at once for both questions below.
      const here = typeof item.path === "string" ? yield* keyOf(app, item.path, false) : null;
      if (cloudMedia !== null && typeof cloudMedia === "object") {
        for (const key of [cloudMedia.original, cloudMedia.proxy]) {
          if (typeof key !== "string") continue;
          const token = ownerToken(key);
          if (token !== null) project.tokens.add(token);
          project.blocks.add(blockFolder(key));
        }
        if (typeof cloudMedia.source === "string") {
          const token = sourceToken(cloudMedia.source);
          if (token !== null) project.tokens.add(token);
        }
        // Not in R2 yet: its upload pending or under way (the only copy may be here).
        if (typeof cloudMedia.original !== "string" || notUp(cloudMedia.original) || notUp(cloudMedia.proxy) || notUp(item.path)) project.unconfirmed = true;
      } else if (typeof item.path === "string" && item.path.startsWith(`${home}/`) && here?.exists === true) {
        // A file Edit made or keeps for it (a smoothed shot, a map, an upload) that hasn't gone up.
        project.unconfirmed = true;
      }
      if (typeof item.path !== "string" || here === null) continue;
      paths.add(item.path);
      let users = pathProjects.get(item.path);
      if (users === undefined) pathProjects.set(item.path, users = new Set());
      users.add(id);
      // A missing file keys differently (no size or time): its folder would look unused.
      if (!here.exists) {
        if (typeof item.cloud?.proxy !== "string" || !cloud.validKey(item.cloud.proxy)) missing += 1;
        continue;
      }
      // A path the addon can't key: nothing of it is touched either way.
      if (here.key === null) continue;
      const key = here.key;
      keys.add(key);
      saved.set(key, Math.max(saved.get(key) ?? 0, at));
      let keyUsers = keyProjects.get(key);
      if (keyUsers === undefined) keyProjects.set(key, keyUsers = new Set());
      keyUsers.add(id);
    }
  }
  projectMedia.prune();
  localProjects = new Set([...projects].flatMap(([id, project]) => (project.local.length > 0 ? [id] : [])));
  return { paths, keys, saved, missing, projects, keyProjects, pathProjects };
}

interface UsedProject {
  /** When its file was last written here. */
  saved: number;
  /** Its cloud footage's places in keys (`ownerToken`): `drive/<id>`, `sha256/<hex>`, `youtube/<id>`. */
  tokens: Set<string>;
  /** Its proxies' and originals' block folders (cloud_blocks.ts). */
  blocks: Set<string>;
  /** Something of it isn't in R2 yet (an upload pending or under way, a file Edit made that hasn't gone up): in work. */
  unconfirmed: boolean;
  /** Its sources whose footage is local while it's in work (local_first_room.ts): none for any other project. */
  local: localRoom.Footage[];
}

interface Used {
  paths: Set<string>;
  keys: Set<string>;
  saved: Map<string, number>;
  missing: number;
  projects: Map<string, UsedProject>;
  /** The projects using each media key. */
  keyProjects: Map<string, Set<string>>;
  /** The projects using each media path. */
  pathProjects: Map<string, Set<string>>;
}

/** Folders under `edit/` whose keys name a source's place next (`edit/<folder>/<place>…`); a sound copy's is its original's key again. */
const KEYED = ["originals/", "excerpts/", "proxies/", "sound/", "analysis/", "scrub/", "pieces/"];

/** The footage `key` (an R2 key, `edit/…`) is of, as `<kind>/<id>` (`drive/1AbC…`), or the project's for a playback render or an effect's (`playback:<project>`); null for anything else. */
export function ownerToken(key: string): string | null {
  let rest = key.startsWith("edit/") ? key.slice("edit/".length) : key;
  if (rest.startsWith("exports/playback/")) rest = rest.slice("exports/".length);
  // An effect's render (effect_cloud.ts) is its project's, as a playback render is.
  const render = /^exports\/([^/]+)\/effect-[^/]+$/.exec(rest);
  if (render !== null) return `playback:${render[1]}`;
  if (rest.startsWith("playback/")) {
    const project = rest.slice("playback/".length).split("/")[0];
    return project ? `playback:${project}` : null;
  }
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const folder of KEYED) {
      if (rest.startsWith(folder)) {
        rest = rest.slice(folder.length);
        stripped = true;
      }
    }
  }
  // A pieced proxy's layout version (proxy_pieces.ts `baseKey`).
  rest = rest.replace(/^v\d+\//, "");
  const match = /^(drive|youtube|sha256)\/([A-Za-z0-9_-]+)/.exec(rest);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** A registry source's place (`drive:<id>#<range>` → `drive/<id>`). */
function sourceToken(source: string): string | null {
  const match = /^(drive|youtube|sha256):([A-Za-z0-9_-]+)/.exec(source);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** A key's folder under `cloud/blocks` (cloud_blocks.ts names them so). */
function blockFolder(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

/** Where a project stands, for what of it is kept here (see the top). */
export type State = "work" | "idle" | "done";

export interface Standing {
  state: State;
  /** When it was last worked on here: the later of its last open in the editor and its last save. */
  last: number;
  /** Opened in the editor in the last minutes, or with work running: kept even with the disk all but full. */
  active: boolean;
}

/** Each project's state on this computer (see the top). */
function standings(app: App, inUse: Used, done: Set<string>, now: number): Map<string, Standing> {
  const opened = openedTimes(app.store.home);
  let archived: Record<string, unknown> = {};
  try {
    archived = JSON.parse(fs.readFileSync(join(app.store.home, "cloud", "archived.json"), "utf8")) as Record<string, unknown>;
  } catch {
    // None archived here.
  }
  const out = new Map<string, Standing>();
  const workingFor = busy.workingNow(app);
  for (const [id, project] of inUse.projects) {
    // Worked on: the later of its last open in the editor and its last save (an agent's turn saves it, with the editor
    // closed). By the open alone, a project opened in the morning and edited by the agent all afternoon lost its
    // footage copies by evening, and came down again when it was opened to be watched (JJ's Mac, Nov 10: 110 files).
    const last = Math.max(opened[id] ?? 0, project.saved);
    const working = workingFor(id);
    const active = working || now - (opened[id] ?? 0) < OPEN_NOW;
    // Marked done on Home (or archived) is let go once it's closed, though it was opened in the last days to look at;
    // open now, with work running or with something not up yet, it's in work whatever it's marked.
    const state: State = active || working || project.unconfirmed ? "work" : done.has(id) || archived[id] !== undefined || now - last >= LET_GO_MS ? "done" : now - last < IN_WORK_MS ? "work" : "idle";
    out.set(id, { state, last, active });
  }
  return out;
}

/** Whose each file is (`Entry.owners`), from the projects' media: its folder's project, its footage's place in keys, its block folder, its media key. */
function* attribute(entries: Entry[], cache: string, home: string, inUse: Used): Steps<void> {
  const cloudDir = `${join(cache, "cloud")}/`;
  const mediaDir = `${join(home, "media")}/`;
  const byToken = new Map<string, Set<string>>();
  const byBlock = new Map<string, Set<string>>();
  const put = (map: Map<string, Set<string>>, key: string, id: string) => {
    let ids = map.get(key);
    if (ids === undefined) map.set(key, ids = new Set());
    ids.add(id);
  };
  for (const [id, project] of inUse.projects) {
    for (const token of project.tokens) put(byToken, token, id);
    for (const folder of project.blocks) put(byBlock, folder, id);
    put(byToken, `playback:${id}`, id);
  }
  // Drive downloads by their path: what original each is (cloud_media `localOriginal`).
  const downloads = new Map<string, string>();
  for (const [key, entry] of Object.entries(readLocalOriginals(cache))) if (typeof entry.path === "string") downloads.set(entry.path, key);
  const blockTokens = new Map<string, string | null>();
  const blockToken = function* (folder: string): Steps<string | null> {
    if (!blockTokens.has(folder)) {
      let token: string | null = null;
      const text = yield* textOf(join(cloudDir, "blocks", folder, "meta.json"));
      try {
        const meta = JSON.parse(text ?? "") as { key?: unknown };
        if (typeof meta.key === "string") token = ownerToken(meta.key);
      } catch {
        // A folder from before keys were kept: known by its name alone.
      }
      blockTokens.set(folder, token);
    }
    return blockTokens.get(folder) ?? null;
  };
  for (const entry of entries) {
    yield BREATH;
    const owners = new Set<string>(entry.project === null ? [] : [entry.project]);
    const add = (ids: Set<string> | undefined) => {
      for (const id of ids ?? []) owners.add(id);
    };
    if (entry.path.startsWith(cloudDir)) {
      const relative = entry.path.slice(cloudDir.length);
      if (relative.startsWith("blocks/")) {
        const folder = relative.slice("blocks/".length).split("/")[0] ?? "";
        add(byBlock.get(folder));
        const token = yield* blockToken(folder);
        if (token !== null) add(byToken.get(token));
      } else {
        const token = ownerToken(`edit/${relative}`);
        if (token !== null) add(byToken.get(token));
      }
    } else if (entry.path.startsWith(mediaDir)) {
      add(inUse.pathProjects.get(entry.path));
      const key = downloads.get(entry.path);
      const token = key === undefined ? null : ownerToken(key);
      if (token !== null) add(byToken.get(token));
    } else {
      const folder = /^([0-9a-f]{16})\//.exec(entry.path.slice(cache.length + 1))?.[1];
      if (folder !== undefined) add(inUse.keyProjects.get(folder));
    }
    entry.owners = [...owners];
  }
}

/** A project's files of one state, as one: what's evicted together (half a project is neither playable nor freed). */
interface Group {
  /** The project ("" for files no project here uses). */
  id: string;
  state: State | "nobody's";
  last: number;
  active: boolean;
  files: Entry[];
}

interface Survey {
  inUse: Used | null;
  groups: Group[];
}

/**
 * The files the cleaner may take by project state, grouped by project: each file with the project using it that
 * was worked on last (a file two projects use goes with the later one, and only once neither is in work), and
 * never one that's pinned, on its way up, written lately, half-written, a block folder's note, a script's original,
 * or not Edit's own copy.
 */
function* survey(app: App, entries: Entry[], now: number, done: Set<string>, known?: Used | null): Steps<Survey> {
  const cache = app.store.cacheDir();
  const home = app.store.home;
  const pending = pendingUploads(home);
  const inUse = known === undefined ? yield* used(app, pending) : known;
  if (inUse === null) return { inUse, groups: [] };
  yield* attribute(entries, cache, home, inUse);
  const standing = standings(app, inUse, done, now);
  let exporting = true;
  try {
    exporting = app.exports.running();
  } catch {
    // No exports here to ask (tests): kept as if one ran.
  }
  // Files from the last few hours stay (one may be uploading or playing), and while an export runs (it mixes from
  // the sound copies) the last two days'.
  const fresh = exporting ? RECENT : COPY_RECENT;
  const scripts = yield* scriptOriginals(home);
  // Script mode's copies go by its own word alone (`cleanCache`'s step for them), never with a project's.
  const scriptCopies = `${ledgerOf.scriptsOf(home)}/`;
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    yield BREATH;
    if (!entry.evictable || ledgerOf.tierOf(entry.kind) === null || entry.path.startsWith(scriptCopies)) continue;
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (PARTIAL.test(name) || (name === "meta.json" && entry.path.includes("/cloud/blocks/"))) continue;
    if (now - entry.at < fresh || pinned(entry.path) || scripts.has(entry.path)) continue;
    if (pending === null || pending.has(entry.path) || uploadingNow(entry.path)) continue;
    let group: Group;
    if (entry.owners.length === 0) {
      group = groups.get("") ?? { id: "", state: "nobody's", last: Number.NEGATIVE_INFINITY, active: false, files: [] };
      groups.set("", group);
    } else {
      // A project deleted here (its folder's name is all that's left of it) is let go.
      const of = entry.owners.map((id) => ({ id, ...(standing.get(id) ?? { state: "done" as const, last: 0, active: false }) }));
      const state: State = of.some((one) => one.state === "work") ? "work" : of.every((one) => one.state === "done") ? "done" : "idle";
      const newest = of.reduce((a, b) => (b.last > a.last ? b : a));
      const key = `${state}\n${newest.id}`;
      group = groups.get(key) ?? { id: newest.id, state, last: newest.last, active: of.some((one) => one.active), files: [] };
      group.active ||= of.some((one) => one.active);
      groups.set(key, group);
    }
    group.files.push(entry);
  }
  return { inUse, groups: [...groups.values()] };
}

/** The projects whose footage is local, as the last look at the home found them: what `localRoom.keep` opens, and no other. */
let localProjects: ReadonlySet<string> = new Set();

/** A local-first source's files here, every local-first project using it as one (local_first_room.ts). */
interface LocalSource {
  original: string;
  /** Its working copy, or null when the original plays as it is. */
  copy: string | null;
  onTimeline: boolean;
  /** Its used stretches: the export cells and the sound copy the timeline needs. */
  stretches: string[];
}

/** What a file here is to a local-first source: its original, its working copy, or one of its used stretches. */
interface LocalFile {
  role: "original" | "copy" | "stretch";
  source: LocalSource;
}

/** The local-first sources' files here, by path (none when no project took the local path). */
function localFiles(cache: string, inUse: Used): Map<string, LocalFile> {
  const sources = new Map<string, LocalSource>();
  for (const project of inUse.projects.values()) {
    for (const footage of project.local) {
      const at = localRoom.paths(cache, footage);
      const known = sources.get(at.original);
      const stretches = [...at.cells, ...(at.sound === null ? [] : [at.sound])];
      if (known === undefined) sources.set(at.original, { original: at.original, copy: at.copy, onTimeline: footage.onTimeline, stretches });
      else {
        known.onTimeline ||= footage.onTimeline;
        known.stretches = [...new Set([...known.stretches, ...stretches])];
        known.copy ??= at.copy;
      }
    }
  }
  const out = new Map<string, LocalFile>();
  for (const source of sources.values()) {
    out.set(source.original, { role: source.copy === null ? "copy" : "original", source });
    if (source.copy !== null) out.set(source.copy, { role: "copy", source });
    for (const stretch of source.stretches) out.set(stretch, { role: "stretch", source });
  }
  return out;
}

/**
 * Local-first originals R2 has said it holds at their size (`confirmOriginals`, the hourly pass), by path, with that
 * size: room asked for between passes (`makeRoom`) may take them as the pass would. A file of another size isn't one.
 */
const heldInR2 = new Map<string, number>();

/** Free space under which the hourly pass asks R2 about local-first originals and keeps their used stretches ready to let them go. */
export const LOCAL_SOON_BYTES = 10_000_000_000;

/** R2's own key for an original here: a cache copy's (`<cache>/cloud/<key less edit/>`), or a Drive download's (cloud_media `localOriginal`). */
function originalKeyOf(cache: string, path: string, downloads: Map<string, string>): string | null {
  const cloudDir = `${join(cache, "cloud")}/`;
  if (path.startsWith(`${cloudDir}originals/`)) return `edit/${path.slice(cloudDir.length)}`;
  return downloads.get(path) ?? null;
}

/** HEADs asked of R2 in one pass at most (the rest wait for the next). */
const CONFIRM_MOST = 200;

/**
 * The originals here of projects let go (done on Home, or idle a week) and of nobody's that R2 says it holds at their
 * very size: only these go (`Limits.confirmed`). Never a file from someone's disk (they're never Edit's to take).
 */
export async function confirmOriginals(
  app: App,
  entries: Entry[],
  done: Set<string>,
  now = Date.now(),
  head: (key: string) => Promise<{ size: number } | null> = (key) => cloud.head(key),
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  const cache = app.store.cacheDir();
  const downloads = new Map<string, string>();
  for (const [key, entry] of Object.entries(readLocalOriginals(cache))) if (typeof entry.path === "string") downloads.set(entry.path, key);
  const asks: [Entry, string][] = [];
  // Nobody's originals go only for room: asked about only while the disk is short of what Edit keeps free.
  const short = diskHooks.free(cache) < keepFreeBytes(cache);
  // A local-first project's (idle or in work) only as room gets short, so their used stretches are ready by then.
  const soon = diskHooks.free(cache) < keepFreeBytes(cache) + LOCAL_SOON_BYTES;
  const surveyed = await gently(survey(app, entries, now, done));
  const local = surveyed.inUse === null ? new Map<string, LocalFile>() : localFiles(cache, surveyed.inUse);
  const asked = new Set<string>();
  for (const group of surveyed.groups) {
    const localToo = soon && (group.state === "idle" || group.state === "work");
    if (group.state !== "done" && !(group.state === "nobody's" && short) && !localToo) continue;
    for (const entry of group.files) {
      if (ledgerOf.tierOf(entry.kind) !== 2) continue;
      if (group.state !== "done" && group.state !== "nobody's" && local.get(entry.path)?.source.original !== entry.path) continue;
      const key = originalKeyOf(cache, entry.path, downloads);
      if (key !== null && cloud.validKey(key)) {
        asks.push([entry, key]);
        if (local.has(entry.path)) asked.add(entry.path);
      }
    }
  }
  const slots = new Semaphore(3);
  await Promise.all(asks.slice(0, CONFIRM_MOST).map(([entry, key]) => slots.with(async () => {
    try {
      const there = await head(key);
      if (there !== null && there.size === entry.bytes && entry.bytes > 0) {
        confirmed.add(entry.path);
        if (asked.has(entry.path)) heldInR2.set(entry.path, entry.bytes);
      } else if (asked.has(entry.path)) heldInR2.delete(entry.path);
    } catch {
      // Not known: it stays.
    }
  })));
  return confirmed;
}

/**
 * Cleans the cache as the module notes say; with `dryRun`, only says what would go. All of it on the thread, at once:
 * for callers that need the answer before they go on (tests, `makeRoom`); the server's own passes use `cleanCacheGently`.
 */
export function cleanCache(
  app: App,
  dryRun: boolean,
  now = Date.now(),
  given?: Limits,
  done: Set<string> = new Set(),
): CleanReport {
  return atOnce(cleanSteps(app, dryRun, now, given, done, false));
}

/** `cleanCache`, the same files taken in the same order, off the server's thread with a breath every few milliseconds. */
export function cleanCacheGently(
  app: App,
  dryRun: boolean,
  now = Date.now(),
  given?: Limits,
  done: Set<string> = new Set(),
): Promise<CleanReport> {
  return gently(cleanSteps(app, dryRun, now, given, done, true));
}

function* cleanSteps(app: App, dryRun: boolean, now: number, given: Limits | undefined, done: Set<string>, gentle: boolean): Steps<CleanReport> {
  // A home that isn't one (EDIT_HOME="") cleans nothing: its cache would be "/cache".
  if (app.store.home.trim() === "" || app.store.home === "/") return { folders: 0, files: 0, bytes: 0, removed: [] };
  const cache = app.store.cacheDir();
  // The cache and the media are walked once a pass (the ledger's, off the thread, when the server's pass asks), and
  // what's taken off is counted from it (Astra's audit, Nov 18: four walks a pass on the server's thread).
  const walked = given?.entries === undefined;
  const entries = given?.entries ?? ((yield { op: "walk", roots: ledgerOf.rootsOf(app.store.home, cache) }) as Entry[]);
  const limits: Limits = given ?? { freeBytes: keepFreeBytes(cache) };
  const confirmed = limits.confirmed ?? new Set<string>();
  const report: CleanReport = { folders: 0, files: 0, bytes: 0, removed: [] };
  const gone = new Set<string>();
  const seen = new Set<string>();
  const remove = function* (path: string): Steps<void> {
    yield BREATH;
    // An export reading it, or about to (its footage, an effect's render, the last export it copies its chunks from:
    // file_pins.ts): left for the next pass. A gentle pass takes a file seconds after it chose it, so an upload
    // started on it meanwhile keeps it too.
    if (pinned(path) || gone.has(path) || (gentle && uploadingNow(path))) return;
    // Gone since the ledger counted it (another pass, the export that made it): nothing to take.
    const stat = yield* statOf(path);
    if (stat === null) {
      if (!dryRun) ledger.forget(path);
      return;
    }
    const bytes = yield* sizeOf(path, seen, stat);
    if (!dryRun) {
      // Asked once more right before it goes (the size of a big folder is a walk of it, breaths and all).
      if (pinned(path)) return;
      const error = yield* rmOf(path, true);
      if (error !== null) {
        diag.warn("cache", `couldn't remove ${path}: ${diag.messageOf(error)}`);
        return;
      }
      ledger.forget(path);
      // A copy Edit.app's window reads: its page asks where to read from again (native_preview.ts).
      nativeEvicted(app, path);
    }
    gone.add(path);
    report.files += 1;
    report.bytes += bytes;
    if (report.removed.length < 50) report.removed.push(path);
  };
  const names = yield* listOf(cache);
  if (names === null) return report;
  const inUse = yield* used(app, pendingUploads(app.store.home));
  // The window's copies of a long video's pieces cut the old way (native_preview.ts `oldCuts`: every frame from the
  // video's start, up to 955 MB a minute, never read since Nov 18), whatever their age: cut again small if wanted.
  for (const path of oldCuts(cache)) {
    // A folder goes once its files have (one pinned stays, and so does its folder).
    if ((yield* namesIn(path)).length > 0) continue;
    yield* remove(path);
  }
  // Footage Edit downloaded from Drive (drive_import.ts) whose original is in
  // the cloud: the copy only speeds exports up, so it goes once unused a while.
  const known = readLocalOriginals(cache);
  let dropped = false;
  // Only Edit's own Drive downloads (<media root>/media/[<project>/]drive/<file id>/<file>),
  // never a file of the user's whose path happens to say "drive" or "uploads".
  const roots = new Set<string>([join(app.store.home, "media")]);
  for (const [key, entry] of Object.entries(known)) {
    const root = [...roots].find((one) => entry.path.startsWith(`${one}/`));
    if (root === undefined || !/^(?:[A-Za-z0-9_-]+\/)?drive\/[A-Za-z0-9_-]{10,}\/[^/]+$/.test(entry.path.slice(root.length + 1))) continue;
    // Not while its upload to the cloud is still going.
    if (uploadingNow(entry.path)) continue;
    if (inUse === null || inUse.paths.has(entry.path) || now - (entry.used_ms ?? entry.mtime_ms) < DOWNLOADED) continue;
    yield* remove(entry.path);
    if (!dryRun) {
      delete known[key];
      dropped = true;
    }
  }
  if (dropped) writeLocalOriginals(cache, known);
  // What Edit made or fetched that no project uses any more (Oct 29, the user:
  // "things shouldn't take up storage on the local devices… everything on the
  // cloud!"): smoothed shots a project moved to the cloud or made again
  // (404 of them, 2.85 GB on this Mac), YouTube videos downloaded for a script
  // (the registry has the original), and the team library's sounds (Drive has
  // them; a cloud project's sound is its cloud copy). Each comes back when
  // it's asked for again.
  if (inUse !== null) {
    // A script's original can be one of these when it couldn't be hard-linked (another disk).
    const scripts = yield* scriptOriginals(app.store.home);
    const generated = (relative: string) => /(?:^|\/)smooth\/[^/]+$/.test(relative) || /^(?:[A-Za-z0-9_-]+\/)?drive\/youtube\/[A-Za-z0-9_-]{6,}\/[^/]+$/.test(relative);
    const places: [string, (relative: string) => boolean][] = [...[...roots].map((root): [string, (relative: string) => boolean] => [root, generated]), [join(app.store.home, "library"), () => true]];
    for (const [root, wanted] of places) {
      const stack = [root];
      for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
        for (const name of yield* namesIn(at)) {
          yield BREATH;
          const path = join(at, name);
          const stat = yield* statOf(path);
          if (stat === null) continue;
          if (stat.isDirectory()) stack.push(path);
          else if (wanted(path.slice(root.length + 1)) && !inUse.paths.has(path) && !scripts.has(path) && !uploadingNow(path) && now - stat.mtimeMs >= (PARTIAL.test(name) ? DAY : RECENT)) yield* remove(path);
        }
      }
    }
  }
  // Half-written cloud copies (a sound excerpt's `.partial.mov`, a proxy's `.partial`) a stopped write left under
  // `cloud/`: eviction passes over a write that may be going, and nothing else looked there, so one from Nov 4 sat in
  // `cloud/sound` for weeks. Gone a day after it was last written, unless something uploads it. Blocks aren't looked
  // through (thousands of files; their own writes never leave a partial: cloud_blocks.ts `keep`).
  {
    const stack = [join(cache, "cloud")];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      for (const name of yield* namesIn(at)) {
        yield BREATH;
        const path = join(at, name);
        const stat = yield* lstatOf(path);
        if (stat === null) continue;
        if (stat.isDirectory()) {
          if (!(at === join(cache, "cloud") && name === "blocks")) stack.push(path);
        } else if (stat.isFile() && PARTIAL.test(name) && now - stat.mtimeMs >= DAY && !uploadingNow(path) && !pinned(path)) yield* remove(path);
      }
    }
  }
  // Chunks an export left when it stopped part-way (the engine's chunks.rs):
  // a run again soon carries on from them; after a few days they go.
  const chunksDir = join(cache, "export-chunks");
  for (const project of yield* namesIn(chunksDir)) {
    for (const entry of yield* namesIn(join(chunksDir, project))) {
      yield BREATH;
      if (!entry.endsWith(".mp4")) continue;
      const path = join(chunksDir, project, entry);
      if ((yield* ageOf(path, now)) >= DOWNLOADED) yield* remove(path);
    }
    // Its sound kept a minute at a time (smooth playback's, the engine's mix.rs render_kept), the same way.
    for (const entry of yield* namesIn(join(chunksDir, project, "sound"))) {
      const path = join(chunksDir, project, "sound", entry);
      if ((yield* ageOf(path, now)) >= DOWNLOADED) yield* remove(path);
    }
    // A share's review pieces of its chunks (reviews.ts `reviewCopyFromChunks`, 1.1-1.5 GB a project on mandalorian,
    // never taken before Nov 18): the next share's copy is made from them, so they go a few days after.
    for (const entry of yield* namesIn(join(chunksDir, project, "review"))) {
      const path = join(chunksDir, project, "review", entry);
      if ((yield* ageOf(path, now)) >= DOWNLOADED) yield* remove(path);
    }
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}$/.test(name)) continue;
    yield BREATH;
    const dir = join(cache, name);
    const entries = yield* listOf(dir);
    if (entries === null) continue;
    // With a used file missing, no folder can be known unused (its key is unknown).
    const unused = inUse !== null && inUse.missing === 0 && !inUse.keys.has(name);
    let touched = false;
    for (const entry of entries) {
      const path = join(dir, entry);
      if ((yield* ageOf(path, now)) < (PARTIAL.test(entry) ? DAY : RECENT)) continue;
      if (PARTIAL.test(entry) || (unused && REBUILT.test(entry))) {
        yield* remove(path);
        touched = true;
      }
    }
    if (touched) report.folders += 1;
  }
  // A review copy is removed once its share is published; one a share that
  // failed left (Oct 29: a 669 MB one, two days old) goes after a few days.
  const reviewsDir = join(cache, "reviews");
  for (const project of yield* namesIn(reviewsDir)) {
    for (const entry of yield* namesIn(join(reviewsDir, project))) {
      yield BREATH;
      if (!entry.endsWith(".mp4")) continue;
      const path = join(reviewsDir, project, entry);
      if ((yield* ageOf(path, now)) >= DOWNLOADED) yield* remove(path);
    }
  }
  // Research images no project links any more (research.ts's pool).
  const pooled = research.prunePool(app.store.home, dryRun);
  if (pooled > 0) {
    report.bytes += pooled;
    report.files += 1;
    if (report.removed.length < 50) report.removed.push(research.poolDir(app.store.home));
  }
  const free = () => (limits.free !== undefined ? limits.free + report.bytes : diskHooks.free(cache) + (dryRun ? report.bytes : 0));
  const short = () => limits.freeBytes - free();
  // The recordings Script mode keeps here so Start the edit cuts from them (writer/streamed.ts, Nov 21): each is a
  // whole original the cloud holds (R2 said so at its size), so they go for room before any project's copies, oldest
  // unused first, never one cut from now nor one an import is reading again. Only for room: with the disk over what's
  // to be kept free they all stay.
  const scriptCopies = () => {
    if (short() <= 0) return;
    // Counted as they go, too: a Mac's free space can lag a delete (APFS's local snapshots), and the disk's word alone
    // would give up every copy for room one of them made.
    const before = free();
    let given = 0;
    ledgerOf.scriptCopies.letGo(
      () => limits.freeBytes - Math.max(free(), before + given),
      (path, bytes) => {
        given += bytes;
        gone.add(path);
        if (!dryRun) ledger.forget(path);
        report.files += 1;
        report.bytes += bytes;
        if (report.removed.length < 50) report.removed.push(path);
      },
      dryRun,
    );
  };
  // By project state (see the top).
  if (inUse === null) scriptCopies();
  else {
    const { groups } = yield* survey(app, entries, now, done, inUse);
    const take = function* (entry: Entry): Steps<void> {
      const before = report.files;
      yield* remove(entry.path);
      // A legacy preview of local footage: the media's own note of it goes too (made again when it's opened).
      const folder = /^([0-9a-f]{16})\/preview/.exec(entry.path.slice(cache.length + 1))?.[1];
      if (folder !== undefined && report.files > before && !dryRun) app.media.forgetKey(folder);
    };
    const tierOf = (entry: Entry) => ledgerOf.tierOf(entry.kind);
    /**
     * A local-first source's files for room (local_first_room.ts), idle projects before projects in work, the one worked
     * on longest ago first: (1) originals R2 holds at their size, their working copy made and their used stretches kept
     * here; (2) working copies of sources off the timeline; (3) working copies of sources on it; (4) the used stretches.
     * A project in work gives up (3) and (4) only with the disk truly out (`out`), and never one open now or with work
     * running. A working copy is made again from its original (here or in R2) or fetched; an original goes only once R2
     * has it. Each said in the log with why.
     */
    const localOrder = function* (local: Map<string, LocalFile>, groups: Group[], out: boolean): Steps<void> {
      if (local.size === 0 || short() <= 0) return;
      const fileOf = new Map(entries.map((entry) => [entry.path, entry.file]));
      const order = (group: Group) => (group.state === "idle" ? 0 : 1);
      const candidates = groups
        .filter((group) => group.state === "idle" || group.state === "work")
        .sort((a, b) => order(a) - order(b) || a.last - b.last)
        .flatMap((group) => group.files.flatMap((entry) => {
          const file = local.get(entry.path);
          return file === undefined ? [] : [{ entry, group, ...file }];
        }));
      const here = function* (path: string): Steps<boolean> {
        return (yield* statOf(path)) !== null;
      };
      // A file with another name too (a person's own file linked in at its key's place: local_first.ts `importFile`):
      // removing this name frees nothing, and the file is theirs.
      const linked = function* (path: string): Steps<boolean> {
        return ((yield* statOf(path))?.nlink ?? 1) > 1;
      };
      // The working copy is its original under another name (not made yet): giving up either frees nothing.
      const standIn = (source: LocalSource) => source.copy !== null && fileOf.get(source.copy) !== undefined && fileOf.get(source.copy) === fileOf.get(source.original);
      const inR2 = (entry: Entry) => entry.bytes > 0 && (confirmed.has(entry.path) || heldInR2.get(entry.path) === entry.bytes);
      const kept = function* (source: LocalSource): Steps<boolean> {
        for (const stretch of source.stretches) if (!(yield* here(stretch))) return false;
        return true;
      };
      const give = function* (entry: Entry, why: string): Steps<void> {
        const before = report.bytes;
        yield* take(entry);
        if (report.bytes > before) diag.info("cache", `gave up ${entry.path} (${(entry.bytes / 1e9).toFixed(2)} GB) for room: ${why}`);
      };
      let said = false;
      const truly = function* (one: { group: Group }): Steps<boolean> {
        if (one.group.state === "idle") return true;
        if (!out || one.group.active) return false;
        if (!said) {
          said = true;
          diag.warn("cache", `The disk has ${(free() / 1e9).toFixed(1)} GB free, under the ${(CACHE_FLOOR_BYTES / 1e9).toFixed(1)} GB Edit needs to work: projects in work give up the footage on their timeline too; it comes back from the cloud as it's played`);
        }
        yield BREATH;
        return true;
      };
      // 1. Whole originals R2 holds, their working copy made and what the timeline uses of them kept here.
      for (const one of candidates) {
        if (short() <= 0) return;
        if (one.role !== "original" || standIn(one.source) || !inR2(one.entry) || (yield* linked(one.entry.path))) continue;
        if (one.source.copy === null || !(yield* here(one.source.copy))) continue;
        if (one.source.onTimeline && !(yield* kept(one.source))) continue;
        yield* give(one.entry, `R2 holds this original at its size${one.source.onTimeline ? ", and what the timeline uses of it is kept here" : ""}`);
      }
      // 2 and 3. Working copies: off the timeline, then on it. One that's its own original goes only as an original may.
      for (const onTimeline of [false, true]) {
        for (const one of candidates) {
          if (short() <= 0) return;
          if (one.role !== "copy" || one.source.onTimeline !== onTimeline || standIn(one.source)) continue;
          const own = one.source.copy === null;
          if (own && (!inR2(one.entry) || (yield* linked(one.entry.path)) || (onTimeline && !(yield* kept(one.source))))) continue;
          if (onTimeline && !(yield* truly(one))) continue;
          yield* give(one.entry, `a working copy of footage ${onTimeline ? "on" : "off"} the timeline, fetched from the cloud when it's played${own ? " (it's its original, which R2 holds at its size)" : ""}`);
        }
      }
      // 4. The used stretches, last.
      for (const one of candidates) {
        if (short() <= 0) return;
        if (one.role !== "stretch" || !(yield* truly(one))) continue;
        yield* give(one.entry, "a used stretch of footage whose original and working copy are gone here; an export fetches it again");
      }
    };
    // Let go (done on Home, or idle a week, or deleted): all of its copies at each pass, its originals once R2 has them.
    for (const group of groups.filter((one) => one.state === "done")) {
      for (const entry of group.files) if (tierOf(entry) !== 2 || confirmed.has(entry.path)) yield* take(entry);
    }
    // Short of what's to be kept free: nobody's copies, the oldest first; then Script mode's copies; then the projects
    // not in work, whole, the one worked on longest ago first, each its derived copies and then its proxies.
    if (short() > 0) {
      const nobody = groups.find((one) => one.state === "nobody's");
      for (const entry of [...(nobody?.files ?? [])].sort((a, b) => a.at - b.at)) {
        if (short() <= 0) break;
        if (tierOf(entry) !== 2 || confirmed.has(entry.path)) yield* take(entry);
      }
    }
    scriptCopies();
    // A local-first source's original, working copy and used stretches go in their own order (`localOrder`), never
    // by these tiers; every other file as it always has.
    const local = localFiles(cache, inUse);
    const wholeTier = function* (group: Group, tier: 0 | 1): Steps<void> {
      for (const entry of group.files) if (tierOf(entry) === tier && !local.has(entry.path)) yield* take(entry);
    };
    for (const group of groups.filter((one) => one.state === "idle").sort((a, b) => a.last - b.last)) {
      if (short() <= 0) break;
      yield* wholeTier(group, 0);
      if (short() <= 0) break;
      yield* wholeTier(group, 1);
    }
    yield* localOrder(local, groups, false);
    // Under the cache's hard floor with nothing else left: projects in work give their copies up too, the oldest
    // first, but never one open in the last minutes or with work running.
    if (short() > 0 && free() < CACHE_FLOOR_BYTES) {
      for (const group of groups.filter((one) => one.state === "work" && !one.active).sort((a, b) => a.last - b.last)) {
        if (short() <= 0 || free() >= CACHE_FLOOR_BYTES) break;
        yield* wholeTier(group, 0);
        if (short() <= 0 || free() >= CACHE_FLOOR_BYTES) break;
        yield* wholeTier(group, 1);
      }
      if (short() > 0 && free() < CACHE_FLOOR_BYTES) yield* localOrder(local, groups, true);
    }
  }
  // A Drive download taken: no longer noted as its original's copy here (cloud_media `localOriginal`).
  if (!dryRun && gone.size > 0) {
    const known = readLocalOriginals(cache);
    const left = Object.fromEntries(Object.entries(known).filter(([, entry]) => !gone.has(entry.path)));
    if (Object.keys(left).length < Object.keys(known).length) writeLocalOriginals(cache, left);
  }
  // What's left, for the ledger: neither a file taken nor one in a folder taken. A gentle pass given the ledger's own
  // entries leaves it as each removal kept it (`forget`): written over with the list it started from, it would lose
  // what was noted, and keep what was forgotten, in the seconds it ran.
  if (!dryRun && (walked || !gentle)) {
    const taken = (path: string) => {
      for (let at = path; at.length > cache.length; at = at.slice(0, at.lastIndexOf("/"))) if (gone.has(at)) return true;
      return gone.has(path);
    };
    const kept: Entry[] = [];
    for (const entry of entries) {
      yield BREATH;
      if (!taken(entry.path)) kept.push(entry);
    }
    ledger.replace(kept, now);
  }
  // Project history is metadata, but unbounded it fills a disk alone: past
  // HISTORY_BYTES, the oldest saves go, across every project's
  // (`projects/history/<id>/<ms>.json`), each project keeping its newest few
  // (a reset's "edit before" among them). It took whole projects' folders
  // until Nov 16, all 30 saves of one at a time, past a fixed 100 MB.
  {
    const history = join(app.store.home, "projects", "history");
    let over = (yield* sizeOf(history)) - HISTORY_BYTES;
    if (over > 0) {
      const saves: { path: string; at: number }[] = [];
      for (const id of yield* namesIn(history)) {
        const dir = join(history, id);
        const own: { path: string; at: number }[] = [];
        for (const name of (yield* namesIn(dir)).filter((name) => /^\d+\.json$/.test(name))) {
          yield BREATH;
          const path = join(dir, name);
          const stat = yield* statOf(path);
          if (stat !== null) own.push({ path, at: stat.mtimeMs });
        }
        own.sort((a, b) => b.at - a.at);
        saves.push(...own.slice(HISTORY_KEPT_EACH));
      }
      saves.sort((a, b) => a.at - b.at);
      for (const save of saves) {
        if (over <= 0) break;
        const before = report.bytes;
        yield* remove(save.path);
        over -= report.bytes - before;
      }
    }
  }
  return report;
}

/** The saves of each project's history the cleaner never takes: the newest, the one before it and the one before that. */
const HISTORY_KEPT_EACH = 3;

/** How much project history may take before its oldest saves go (it was a quarter of the cache's budget until Nov 18). */
export const HISTORY_BYTES = 1_000_000_000;

/**
 * Older exports of each project that are no longer wanted (export_retention.ts):
 * with `dryRun` only logged ("would delete …"). Each file goes off the thread
 * first (an export is gigabytes; its unlink is the disk's wait), then the list
 * marks it removed (`apply` finds it gone, and only marks and says it).
 */
export async function cleanExports(app: App, dryRun: boolean, now = Date.now()): Promise<{ files: number; bytes: number; decisions: retention.Decision[] }> {
  const home = app.store.home;
  let records: Record<string, retention.Kept[]> = {};
  try {
    records = JSON.parse(await fs.promises.readFile(join(home, "exports.json"), "utf8")) as Record<string, retention.Kept[]>;
  } catch {
    return { files: 0, bytes: 0, decisions: [] };
  }
  const roots = new Set(exportRoots(home));
  const shared = reviews.read(home).shared;
  const free = diskHooks.free(app.store.cacheDir());
  // When each project went to Drive, from its file (only the reason a removal gives): until Nov 21 the store loaded
  // each project for it, a long edit's whole file parsed and kept in memory, 0.6 s of the thread for a 10 MB one.
  const driveAt = await gently((function* (): Steps<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    for (const id of Object.keys(records)) {
      yield BREATH;
      const read = id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id) ? yield* projectMedia.of(join(home, "projects", `${id}.json`), mediaOfText) : null;
      out.set(id, read === null || read.value === "bad" ? null : read.value.driveAt);
    }
    return out;
  })());
  const decisions = retention.decide(records, {
    now,
    roots: [...roots],
    reviewed: (id, path) => shared[id]?.versions.find((version) => version.path === path)?.n ?? null,
    onDrive: (id) => driveAt.get(id) ?? null,
    busy: (id, path) => busyExport(app, id, path),
    short: Number.isFinite(free) ? FREE_FLOOR_BYTES - free : 0,
  });
  if (dryRun) return { ...retention.apply(home, decisions, true), decisions };
  const removed: retention.Decision[] = [];
  for (const decision of decisions) {
    if (!decision.remove || decision.removed === undefined) continue;
    // Asked again as it goes: an export, a share or an upload may have started on it since it was decided.
    if (busyExport(app, decision.project, decision.path)) continue;
    try {
      await fs.promises.rm(decision.path, { force: true });
    } catch (error) {
      diag.warn("export", `couldn't delete ${decision.project}: v${decision.version} (${decision.name}, ${(decision.bytes / 1e9).toFixed(2)} GB): ${decision.why}: ${diag.messageOf(error)}`);
      continue;
    }
    removed.push(decision);
  }
  return { ...retention.apply(home, removed, false), decisions };
}

/** Whether an export's file is in use: being exported, read, shared or uploaded to Drive. */
function busyExport(app: App, id: string, path: string): boolean {
  let exporting = false;
  try {
    exporting = app.exports.runningFor?.(id)?.output === path;
  } catch {
    // No exports here (tests).
  }
  return exporting || beingRead(path) || reviews.sharingNow(id) || drive.uploading(id);
}

/** The edits marked done on Home at the last pass (later.ts): room-making between passes knows them too. */
let doneLately = new Set<string>();

/**
 * Script mode's copies given up for `wanted` bytes free, when they alone make the room (Nov 21): found from their own
 * records, with no walk. With them kept down to what Edit keeps free, each recording an import brings down asks for
 * room, and a whole pass is a pass of the whole cache; the hourly pass takes nobody's copies first. What they freed,
 * and whether that was enough.
 */
function scriptCopiesFirst(app: App, wanted: number): { bytes: number; enough: boolean } {
  const cache = app.store.cacheDir();
  const before = diskHooks.free(cache);
  let quick = 0;
  ledgerOf.scriptCopies.letGo(
    () => wanted - Math.max(diskHooks.free(cache), before + quick),
    (path, bytes) => {
      quick += bytes;
      ledger.forget(path);
    },
    false,
  );
  const enough = wanted - Math.max(diskHooks.free(cache), before + quick) <= 0;
  if (enough && quick > 0) diag.info("cache", `freed ${(quick / 1e9).toFixed(2)} GB of Script mode's copies for work that needs ${(wanted / 1e9).toFixed(1)} GB free`);
  return { bytes: quick, enough };
}

function saidFreed(freed: number, wanted: number): void {
  if (freed > 0) diag.info("cache", `freed ${(freed / 1e9).toFixed(2)} GB for work that needs ${(wanted / 1e9).toFixed(1)} GB free`);
}

/**
 * Room for work that needs `wanted` bytes free on the cache's disk and hasn't
 * them (an import or an export about to be refused: storage.ts `admit`; a
 * whole copy or an effect's render with no room: `askForRoom`): what the
 * pass would take for it (see the top), from the ledger, with no walk of the
 * disk: nobody's copies, then projects not in work, whole and oldest first,
 * and only with the disk under its hard floor a project in work that isn't
 * open now. What was freed (bytes).
 *
 * All of it on the thread, for a caller that reads the disk's free space as
 * soon as this returns; `makeRoomAsync` makes the same room gently.
 */
export function makeRoom(app: App, wanted: number): number {
  const cache = app.store.cacheDir();
  const quick = scriptCopiesFirst(app, wanted);
  if (quick.enough) return quick.bytes;
  const entries = ledger.covers(cache) ? ledger.all() : undefined;
  const report = cleanCache(app, false, Date.now(), { freeBytes: wanted, ...(entries === undefined ? {} : { entries }) }, doneLately);
  const freed = report.bytes + quick.bytes;
  saidFreed(freed, wanted);
  return freed;
}

/**
 * One pass at a time (Nov 21): the hourly one and room asked for take turns, so two never take from the same ledger
 * at once; asks that come while one waits its turn join it, for the most room any of them wants.
 */
let lane: Promise<unknown> = Promise.resolve();
let waiting: { wanted: number; freed: Promise<number> } | null = null;

function inLane<T>(job: () => Promise<T>): Promise<T> {
  const next = lane.then(job, job);
  lane = next.catch(() => {});
  return next;
}

/**
 * `makeRoom` off the server's thread: Script mode's copies first, at once, as `makeRoom` gives them; then, still
 * short, a gentle pass for the room, after the one running now (if any). What was freed (bytes).
 */
export async function makeRoomAsync(app: App, wanted: number): Promise<number> {
  const quick = scriptCopiesFirst(app, wanted);
  if (quick.enough) return quick.bytes;
  if (waiting !== null) {
    waiting.wanted = Math.max(waiting.wanted, wanted);
    return quick.bytes + (await waiting.freed);
  }
  const ask = { wanted, freed: Promise.resolve(0) };
  ask.freed = inLane(async () => {
    if (waiting === ask) waiting = null;
    thread.note("room asked of the cache for work");
    const cache = app.store.cacheDir();
    // Local-first originals the last pass found in R2 have their used stretches cut first, so they can go (local_first_room.ts).
    if (heldInR2.size > 0) await localRoom.keep(app, (path, bytes) => heldInR2.get(path) === bytes, doneLately, undefined, localProjects);
    const entries = ledger.covers(cache) ? ledger.all() : undefined;
    const report = await cleanCacheGently(app, false, Date.now(), { freeBytes: ask.wanted, ...(entries === undefined ? {} : { entries }) }, doneLately);
    saidFreed(report.bytes, ask.wanted);
    return report.bytes;
  });
  waiting = ask;
  return quick.bytes + (await ask.freed);
}

/** The edits marked done on Home (none when Later can't be reached: ordered by when they were worked on alone). */
async function doneOnHome(): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    for (const entry of await later.list()) if (entry.done === true && entry.key.startsWith("edit:")) done.add(entry.key.slice("edit:".length));
  } catch {
    // Later unreachable.
  }
  return done;
}

/**
 * One pass, as the server runs it: the ledger built again off the thread, the originals of projects let go asked of
 * R2, then the cache cleaned to keep what Edit keeps free (`head`: tests stand in for R2). All of it gently (see the
 * top), after any pass for room already running.
 */
export function cleanPass(app: App, now = Date.now(), head?: (key: string) => Promise<{ size: number } | null>): Promise<CleanReport> {
  return inLane(async () => {
    const cache = app.store.cacheDir();
    thread.note("the hourly cache clean (cloud previews)");
    const previews = await cleanCloudPreviews(app, false, head);
    const done = await doneOnHome();
    doneLately = done;
    ledger.useRoots(ledgerOf.rootsOf(app.store.home, cache));
    const entries = await ledger.rebuild();
    thread.note("the hourly cache clean (originals asked of R2)");
    const confirmed = await confirmOriginals(app, entries, done, now, head);
    // Room getting short: local-first originals R2 holds have their used stretches cut here, so they can go (local_first_room.ts).
    if (diskHooks.free(cache) < keepFreeBytes(cache) + LOCAL_SOON_BYTES) {
      thread.note("the hourly cache clean (local-first stretches kept)");
      await localRoom.keep(app, (path) => confirmed.has(path), done, undefined, localProjects);
    }
    // Each said as it starts (thread.ts): until Nov 21 the next two kept the server's thread 3 to 4.4 s each hour on a
    // home of 14,000 cached files; now each gives it back every few milliseconds.
    thread.note("the hourly cache clean (the cache)");
    const report = await cleanCacheGently(app, false, now, { freeBytes: keepFreeBytes(cache), entries, confirmed }, done);
    thread.note("the hourly cache clean (old exports)");
    const old = await cleanExports(app, false, now);
    pruneKeys();
    report.bytes += old.bytes + previews.bytes;
    report.files += old.files + previews.files;
    return report;
  });
}

/** Cleans now and then: a few minutes after the start, then hourly (a day of imports and exports filled the disk). */
export function startCleaning(app: App): () => void {
  // Work with no room asks the cleaner for it (storage.ts `askForRoom`, `admit`).
  diskHooks.makeRoom = (wanted) => makeRoom(app, wanted);
  diskHooks.makeRoomAsync = (wanted) => makeRoomAsync(app, wanted);
  ledger.useRoots(ledgerOf.rootsOf(app.store.home, app.store.cacheDir()));
  let running = false;
  const run = async (clean: boolean) => {
    if (running) return;
    // A cache on a drive macOS hasn't answered about yet (plugged in after the start): asked off the event loop, cleaned next time.
    const open = folderAccess.unanswered([app.store.cacheDir()]);
    if (open.length > 0) {
      void folderAccess.reachRoots(open);
      return;
    }
    running = true;
    try {
      if (!clean) {
        // The first count, soon after the start: room-making has it before the first pass, and what it reads of the
        // projects and scripts (`makeRoom` reads only what has changed since).
        await inLane(async () => {
          await ledger.rebuild();
          await gently((function* (): Steps<void> {
            yield* used(app, pendingUploads(app.store.home));
            yield* scriptOriginals(app.store.home);
          })());
        });
        diag.info("cache", `this computer holds ${ledger.summary()} of Edit's`);
        return;
      }
      const report = await cleanPass(app);
      if (report.files > 0) diag.info("cache", `freed ${(report.bytes / 1e9).toFixed(2)} GB: ${report.files} files (no project uses them, half-written, of projects let go, or of projects not in work to keep ${(keepFreeBytes(app.store.cacheDir()) / 1e9).toFixed(0)} GB free)`);
      diag.info("cache", `this computer holds ${ledger.summary()} of Edit's`);
    } catch (error) {
      diag.warn("cache", `cleaning the cache: ${diag.messageOf(error)}`);
    } finally { running = false; }
  };
  const count = setTimeout(() => void run(false), 30 * 1000);
  const first = setTimeout(() => void run(true), 10 * 60 * 1000);
  const hourly = setInterval(() => void run(true), 3600 * 1000);
  return () => {
    clearTimeout(count);
    clearTimeout(first);
    clearInterval(hourly);
  };
}
